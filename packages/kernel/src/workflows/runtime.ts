import { validateWorkflowGraph, type WorkflowGraph, type WorkflowNode } from './graph.ts'
import { evaluateWorkflowConditionExpression } from './condition.ts'

export type WorkflowSafetyDecision = 'ALLOW' | 'BLOCK' | 'ESCALATE' | 'SKIPPED'

export interface WorkflowEvaluation {
  safetyDecision: WorkflowSafetyDecision
  issues?: string[]
  simulated?: boolean
  reasoningScore?: number
  hallucinationRisk?: string
  brittleness?: string
}

export interface WorkflowRuntimeContext {
  input: unknown
  outputs: Readonly<Record<string, unknown>>
  evaluations: Readonly<Record<string, WorkflowEvaluation>>
  /** Handlers should pass this signal through to cancellable provider/tool APIs. */
  signal?: AbortSignal
}

export interface WorkflowRuntimeHandlers {
  runAgent(node: WorkflowNode, context: WorkflowRuntimeContext): Promise<unknown>
  runTool(node: WorkflowNode, context: WorkflowRuntimeContext): Promise<unknown>
  validateTool?(node: WorkflowNode, context: WorkflowRuntimeContext): Promise<{ allowed: boolean; reasons: string[] }>
  evaluate?(node: WorkflowNode, candidate: unknown, context: WorkflowRuntimeContext, phase: 'before-execution' | 'result'): Promise<WorkflowEvaluation>
  approve?(node: WorkflowNode, output: unknown, context: WorkflowRuntimeContext): Promise<{ approved: boolean; reason?: string }>
  evaluateCondition?(node: WorkflowNode, expression: string, context: WorkflowRuntimeContext): Promise<boolean>
}

export interface WorkflowStepRecord {
  nodeId: string
  status: 'completed' | 'skipped' | 'blocked' | 'failed' | 'cancelled'
  safetyDecision?: WorkflowSafetyDecision
  detail?: string
  /** Set when a handler threw an error carrying a provider retry hint (e.g. HTTP 429 Retry-After). */
  retryAfterMs?: number
}

export interface WorkflowExecutionResult {
  status: 'completed' | 'blocked' | 'failed' | 'cancelled'
  outputs: Record<string, unknown>
  steps: WorkflowStepRecord[]
  error?: string
}

export interface WorkflowExecutionOptions {
  /** Maximum simultaneous independent, low/moderate-impact agent nodes (1–16). Defaults to 1. */
  maxConcurrentAgents?: number
  /**
   * Run-level cancellation. Checked before every step and linked into each
   * handler's signal; a cancelled run stops at the next step boundary.
   */
  signal?: AbortSignal
}

/**
 * Execute an already-authorized workflow graph in-process.
 * The caller supplies all external agent/tool/evaluation/approval handlers;
 * this module never opens network connections or persists workflow state.
 */
export async function executeWorkflowGraph(
  graph: WorkflowGraph,
  input: unknown,
  handlers: WorkflowRuntimeHandlers,
  options: WorkflowExecutionOptions = {},
): Promise<WorkflowExecutionResult> {
  const validation = validateWorkflowGraph(graph)
  if (!validation.valid) {
    return { status: 'blocked', outputs: {}, steps: [], error: `Workflow graph is invalid: ${validation.errors.join(' ')}` }
  }

  const maxConcurrentAgents = options.maxConcurrentAgents ?? 1
  if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1 || maxConcurrentAgents > 16) {
    return { status: 'blocked', outputs: {}, steps: [], error: 'maxConcurrentAgents must be an integer from 1 to 16.' }
  }

  const runSignal = options.signal
  const outputs: Record<string, unknown> = {}
  const steps: WorkflowStepRecord[] = []
  const cancelled = (): WorkflowExecutionResult => ({
    status: 'cancelled', outputs, steps, error: abortReason(runSignal) ?? 'Workflow run was cancelled.',
  })
  const evaluations: Record<string, WorkflowEvaluation> = {}
  const activated = new Set<string>([graph.entryNodeId])
  const processed = new Set<string>()
  const pending = new Set(validation.topologicalOrder)
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const incomingEdges = new Map<string, typeof graph.edges>()
  for (const edge of graph.edges) incomingEdges.set(edge.to, [...(incomingEdges.get(edge.to) ?? []), edge])

  while (pending.size > 0) {
    if (runSignal?.aborted) return cancelled()
    const ready = validation.topologicalOrder.filter((id) => pending.has(id)
      && (incomingEdges.get(id) ?? []).every((edge) => processed.has(edge.from)))
    if (ready.length === 0) {
      return { status: 'blocked', outputs, steps, error: 'Workflow scheduler could not find a dependency-ready step.' }
    }

    const first = graphNodes.get(ready[0]!)
    const parallelBatch: WorkflowNode[] = []
    if (maxConcurrentAgents > 1 && first && activated.has(first.id) && isParallelAgent(first)) {
      for (const id of ready) {
        // Never batch a step whose branch was not selected; the sequential
        // path below records it as skipped on a later iteration.
        if (!activated.has(id)) continue
        const candidate = graphNodes.get(id)
        if (!candidate || !isParallelAgent(candidate) || parallelBatch.length >= maxConcurrentAgents) break
        parallelBatch.push(candidate)
      }
    }

    if (parallelBatch.length > 1) {
      const snapshot = runtimeContext(input, outputs, evaluations)
      const outcomes = await Promise.all(parallelBatch.map((node) => executeNode(node, snapshot, input, outputs, incomingEdges, handlers, runSignal)))
      let terminal: Extract<WorkflowNodeOutcome, { success: false }> | undefined
      for (let index = 0; index < parallelBatch.length; index += 1) {
        const node = parallelBatch[index]!
        const outcome = outcomes[index]!
        pending.delete(node.id)
        processed.add(node.id)
        if ('output' in outcome) outputs[node.id] = outcome.output
        if (outcome.evaluation) evaluations[node.id] = outcome.evaluation
        steps.push(outcome.step)
        if (!outcome.success && !terminal) terminal = outcome
        if (outcome.success) activateNext(node, outcome.output, graph.edges, activated)
      }
      if (terminal) return { status: terminal.terminalStatus, outputs, steps, error: terminal.step.detail }
      continue
    }

    const nodeId = ready[0]!
    const node = graphNodes.get(nodeId)
    if (!node) {
      pending.delete(nodeId)
      processed.add(nodeId)
      continue
    }
    pending.delete(nodeId)
    processed.add(nodeId)
    if (!activated.has(nodeId)) {
      steps.push({ nodeId, status: 'skipped', detail: 'No active workflow path reaches this step.' })
      continue
    }
    const outcome = await executeNode(node, runtimeContext(input, outputs, evaluations), input, outputs, incomingEdges, handlers, runSignal)
    if ('output' in outcome) outputs[nodeId] = outcome.output
    if (outcome.evaluation) evaluations[nodeId] = outcome.evaluation
    steps.push(outcome.step)
    if (!outcome.success) return { status: outcome.terminalStatus, outputs, steps, error: outcome.step.detail }
    activateNext(node, outcome.output, graph.edges, activated)
  }

  return { status: 'completed', outputs, steps }
}

type WorkflowNodeOutcome = {
  success: true
  step: WorkflowStepRecord & { status: 'completed' }
  output: unknown
  evaluation?: WorkflowEvaluation
} | {
  success: false
  step: WorkflowStepRecord & { status: 'blocked' | 'failed' | 'cancelled' }
  evaluation?: WorkflowEvaluation
  terminalStatus: 'blocked' | 'failed' | 'cancelled'
}

function isParallelAgent(node: WorkflowNode): boolean {
  return node.kind === 'agent'
    && node.config?.impact !== 'high'
    && node.config?.impact !== 'critical'
    && node.config?.supervisorApprovalRequired !== true
}

function runtimeContext(input: unknown, outputs: Record<string, unknown>, evaluations: Record<string, WorkflowEvaluation>): WorkflowRuntimeContext {
  return { input, outputs: { ...outputs }, evaluations: { ...evaluations } }
}

function activateNext(node: WorkflowNode, output: unknown, edges: WorkflowGraph['edges'], activated: Set<string>): void {
  if (node.kind === 'condition') {
    const selectedBranch = output ? 'true' : 'false'
    for (const edge of edges) if (edge.from === node.id && edge.branch === selectedBranch) activated.add(edge.to)
  } else {
    for (const edge of edges) if (edge.from === node.id && edge.branch === undefined) activated.add(edge.to)
  }
}

async function executeNode(
  node: WorkflowNode,
  context: WorkflowRuntimeContext,
  input: unknown,
  outputs: Record<string, unknown>,
  incomingEdges: Map<string, WorkflowGraph['edges']>,
  handlers: WorkflowRuntimeHandlers,
  runSignal?: AbortSignal,
): Promise<WorkflowNodeOutcome> {
  const timeoutMs = node.config?.timeoutMs
  const withTimeout = <T>(ms: number | undefined, operation: (signal: AbortSignal) => Promise<T>) => withDeadline(ms, runSignal, operation)
  let evaluationForNode: WorkflowEvaluation | undefined
  const blocked = (detail: string, safetyDecision?: WorkflowSafetyDecision): WorkflowNodeOutcome => ({
    success: false,
    step: { nodeId: node.id, status: 'blocked', ...(safetyDecision ? { safetyDecision } : {}), detail },
    ...(evaluationForNode ? { evaluation: evaluationForNode } : {}),
    terminalStatus: 'blocked',
  })
  const failed = (detail: string, retryAfterMs?: number): WorkflowNodeOutcome => ({
    success: false,
    step: { nodeId: node.id, status: 'failed', detail, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    ...(evaluationForNode ? { evaluation: evaluationForNode } : {}),
    terminalStatus: 'failed',
  })

  try {
    const sideEffectTool = node.kind === 'tool' && node.config?.sideEffect === true
    const highImpact = node.config?.impact === 'high' || node.config?.impact === 'critical'
    const protectedTool = node.kind === 'tool' && (sideEffectTool || highImpact || node.config?.supervisorApprovalRequired === true)
    let toolSafetyDecision: WorkflowSafetyDecision | undefined
    if (node.kind === 'tool') {
      if (!handlers.validateTool) return blocked('NQC tool validation is not configured; the tool was not dispatched.')
      const validation = await withTimeout(timeoutMs, (signal) => handlers.validateTool!(node, { ...context, signal }))
      if (validation?.allowed !== true) return blocked(validation?.reasons?.join(' ') || 'NQC tool validation did not allow this call.')
    }
    if (protectedTool) {
      if ((sideEffectTool || highImpact) && node.config?.evaluationRequired !== true) return blocked('Evaluation is required before this protected step.')
      if ((sideEffectTool || highImpact) && node.config?.supervisorApprovalRequired !== true) return blocked('Supervisor approval is required before this protected step.')
      if (node.config?.evaluationRequired || sideEffectTool || highImpact) {
        if (!handlers.evaluate) return blocked('Evaluation handler is required before tool execution.')
        const evaluation = await withTimeout(timeoutMs, (signal) => handlers.evaluate!(node, { proposedInput: input, priorOutputs: context.outputs }, { ...context, signal }, 'before-execution'))
        if (!isSafetyDecision(evaluation?.safetyDecision, evaluation?.simulated)) return blocked('Evaluator returned an invalid safety decision; tool execution was stopped.')
        if (evaluation.simulated) return blocked('A simulated evaluator cannot authorize a tool call.')
        evaluationForNode = evaluation
        toolSafetyDecision = evaluation.safetyDecision
        if (toolSafetyDecision === 'BLOCK') return blocked(evaluation.issues?.join(' ') || 'The evaluator blocked this tool request.', toolSafetyDecision)
      }
      if (node.config?.supervisorApprovalRequired || sideEffectTool || highImpact || toolSafetyDecision === 'ESCALATE') {
        if (!handlers.approve) return blocked('Supervisor approval is not configured; tool execution was stopped safely.', toolSafetyDecision)
        const approval = await withTimeout(timeoutMs, (signal) => handlers.approve!(node, { proposedInput: input, priorOutputs: context.outputs }, { ...context, signal }))
        if (approval?.approved !== true) return blocked(approval?.reason || 'Supervisor approval was not granted; tool execution was stopped safely.', toolSafetyDecision)
      }
    }

    let output: unknown
    if (node.kind === 'trigger') output = input
    else if (node.kind === 'agent') output = await runAgentWithRetry(node, context, handlers.runAgent, timeoutMs, withTimeout)
    else if (node.kind === 'tool') output = await withTimeout(timeoutMs, (signal) => handlers.runTool(node, { ...context, signal }))
    else if (node.kind === 'condition') {
      const expression = node.config?.conditionExpression
      if (!expression?.trim()) return blocked('Condition expression is missing; the workflow stopped safely.')
      output = handlers.evaluateCondition
        ? await withTimeout(timeoutMs, (signal) => handlers.evaluateCondition!(node, expression, { ...context, signal }))
        : evaluateWorkflowConditionExpression(expression, context)
      if (typeof output !== 'boolean') return failed('Condition handler must return true or false.')
    } else {
      const priorResults = (incomingEdges.get(node.id) ?? []).map((edge) => outputs[edge.from]).filter((value) => value !== undefined)
      output = priorResults.length === 1 ? priorResults[0] : priorResults
    }

    const protectedAction = highImpact
    let safetyDecision: WorkflowSafetyDecision | undefined = toolSafetyDecision
    let displaySafetyDecision = toolSafetyDecision
    if (!protectedTool && node.config?.evaluationRequired) {
      if (!handlers.evaluate) return blocked('Evaluation handler is required; the workflow stopped safely.')
      const evaluation = await withTimeout(timeoutMs, (signal) => handlers.evaluate!(node, output, { ...context, signal }, 'result'))
      if (!isSafetyDecision(evaluation?.safetyDecision, evaluation?.simulated)) return blocked('Evaluator returned an invalid safety decision; the workflow stopped safely.')
      evaluationForNode = evaluation
      if (evaluation.simulated) {
        if (protectedAction) return blocked('A simulated evaluator cannot authorize a high-impact action.')
        displaySafetyDecision = 'SKIPPED'
        safetyDecision = undefined
      } else {
        safetyDecision = evaluation.safetyDecision
        displaySafetyDecision = evaluation.safetyDecision
      }
      if (safetyDecision === 'BLOCK') return blocked(evaluation.issues?.join(' ') || 'The evaluator blocked this step.', safetyDecision)
    }

    const approvalRequired = !protectedTool && (node.config?.supervisorApprovalRequired === true || protectedAction || safetyDecision === 'ESCALATE')
    if (approvalRequired) {
      if (!handlers.approve) return blocked('Supervisor approval is not configured; the workflow stopped safely.', safetyDecision)
      const approval = await withTimeout(timeoutMs, (signal) => handlers.approve!(node, output, { ...context, signal }))
      if (approval?.approved !== true) return blocked(approval?.reason || 'Supervisor approval was not granted.', safetyDecision)
    }

    return {
      success: true,
      output,
      step: { nodeId: node.id, status: 'completed', ...(displaySafetyDecision ? { safetyDecision: displaySafetyDecision } : {}) },
      ...(evaluationForNode ? { evaluation: evaluationForNode } : {}),
    }
  } catch (cause) {
    if (runSignal?.aborted) {
      return {
        success: false,
        step: { nodeId: node.id, status: 'cancelled', detail: abortReason(runSignal) ?? 'Workflow run was cancelled.' },
        ...(evaluationForNode ? { evaluation: evaluationForNode } : {}),
        terminalStatus: 'cancelled',
      }
    }
    return failed((cause as Error)?.message || 'Workflow step failed.', retryHint(cause))
  }
}

async function runAgentWithRetry(
  node: WorkflowNode,
  context: WorkflowRuntimeContext,
  runAgent: WorkflowRuntimeHandlers['runAgent'],
  timeoutMs: number | undefined,
  withTimeout: <T>(ms: number | undefined, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<unknown> {
  const attempts = node.config?.maxAttempts ?? 1
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTimeout(timeoutMs, (signal) => runAgent(node, { ...context, signal }))
    } catch (error) {
      lastError = error
      if (error instanceof RunCancelledError) break
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** (attempt - 1), 1_000)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Agent step failed after its configured attempts.')
}

class RunCancelledError extends Error {}

/** Per-handler deadline linked to the run-level cancellation signal. */
async function withDeadline<T>(timeoutMs: number | undefined, runSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  if (runSignal?.aborted) throw new RunCancelledError(abortReason(runSignal) ?? 'Workflow run was cancelled.')
  if (timeoutMs === undefined && !runSignal) return operation(controller.signal)

  let timer: ReturnType<typeof setTimeout> | undefined
  let onRunAbort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        const error = new Error(`Workflow handler exceeded its ${timeoutMs} ms timeout.`)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    }
    if (runSignal) {
      onRunAbort = () => {
        const error = new RunCancelledError(abortReason(runSignal) ?? 'Workflow run was cancelled.')
        controller.abort(error)
        reject(error)
      }
      runSignal.addEventListener('abort', onRunAbort, { once: true })
    }
  })
  try {
    return await Promise.race([operation(controller.signal), stop])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onRunAbort) runSignal?.removeEventListener('abort', onRunAbort)
  }
}

function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted) return undefined
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name !== 'AbortError') return reason.message
  if (typeof reason === 'string' && reason.trim()) return reason
  return undefined
}

/** Read a provider retry hint (e.g. from an HTTP 429) without trusting the error's shape. */
function retryHint(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object') return undefined
  const value = (cause as { retryAfterMs?: unknown }).retryAfterMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 3_600_000) : undefined
}

function isSafetyDecision(value: unknown, simulated: boolean | undefined): value is WorkflowSafetyDecision {
  return value === 'ALLOW' || value === 'BLOCK' || value === 'ESCALATE' || value === 'SKIPPED' && simulated === true
}
