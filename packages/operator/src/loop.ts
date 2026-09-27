/**
 * The agent loop: the model proposes tool calls, the gate decides each one,
 * approved calls run in the sandbox, results go back to the model, until the
 * model calls `finish` or a budget runs out.
 *
 * Completion is decided by the runtime, not the model. When the model calls
 * `finish`, the loop runs the run's verification commands itself (for
 * example the project's tests). If they fail, the failure goes back to the
 * model and the run continues; a run whose checks never pass ends
 * `unverified` or `failed`, never `done`. Evidence the model cites must name
 * tool calls that actually ran and succeeded in this run.
 *
 * The model sits behind `ModelDriver`, so the loop is tested with a scripted
 * driver and runs in production with the AI SDK driver (ai-driver.ts).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

import type { AuditSink } from './audit.ts'
import { denyAll, newApprovalId, type Approver, type Gate } from './gate.ts'
import { formatRun } from './tools/exec.ts'
import type { CheckpointStore, Sandbox, ToolContext } from './types.ts'

export type LoopMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ModelToolCall[] }
  | { role: 'tool'; callId: string; tool: string; output: string }

export interface ModelToolCall { id: string; name: string; input: unknown }

export interface ToolSpec { name: string; description: string; input: z.ZodType<unknown> }

export interface ModelDriver {
  step(request: { system: string; messages: LoopMessage[]; tools: ToolSpec[]; signal?: AbortSignal }): Promise<{ text: string; calls: ModelToolCall[]; usage?: { inputTokens?: number; outputTokens?: number } }>
}

export const FINISH_INPUT = z.object({
  summary: z.string().min(1),
  /** Ids of this run's tool calls that show the work is done. */
  evidence: z.array(z.object({ callId: z.string(), claim: z.string() })).default([]),
  /** The model's own view; the runtime decides the final status. */
  outcome: z.enum(['done', 'blocked', 'gave-up']).default('done'),
})

export type RunStatus =
  /** Finished and every verification command passed. */
  | 'verified'
  /** Finished with no verification configured; evidence checked only. */
  | 'done-unverified'
  /** The model finished but the checks kept failing, or cited evidence that does not exist. */
  | 'failed'
  /** The model said it was blocked or gave up. */
  | 'blocked'
  /** A budget ran out or the run was cancelled. */
  | 'stopped'

export interface RunOptions {
  runId?: string
  goal: string
  /** Extra instructions (persona, rules, project context). */
  instructions?: string
  /** Commands the runtime runs after `finish`; all must exit 0 for `verified`. */
  verify?: string[]
  maxSteps?: number
  maxToolCalls?: number
  /** Verification attempts before the run fails. Default 3. */
  maxVerifyAttempts?: number
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => void
}

export type RunEvent =
  | { type: 'model'; text: string; calls: ModelToolCall[] }
  | { type: 'gate'; tool: string; verdict: string; summary: string; reasons?: string[] }
  | { type: 'tool'; tool: string; ok: boolean; output: string }
  | { type: 'verify'; command: string; ok: boolean; output: string }
  | { type: 'end'; status: RunStatus; summary: string }

export interface RunResult {
  runId: string
  status: RunStatus
  summary: string
  steps: number
  toolCalls: number
  /** Why the runtime chose this status (failed checks, bad evidence, budget). */
  notes: string[]
  usage: { inputTokens: number; outputTokens: number }
}

export interface OperatorDeps {
  gate: Gate
  sandbox: Sandbox
  checkpoints: CheckpointStore
  audit: AuditSink
  workspace: string
  model: ModelDriver
  /** Decides calls that need a person. Default: deny (unattended). */
  approver?: Approver
}

const SYSTEM = `You are Quicksilver Operator, an agent that does real work in a sandboxed workspace.
Rules:
- Work step by step with the tools. Read before you edit. Prefer small, checkable changes.
- Some calls wait for a person or are refused by policy; when refused, find another way or explain why you cannot.
- When the work is complete, call finish with a short summary and evidence: the ids of tool calls that show it works (for example a test run).
- Never claim something works unless a tool result in this run shows it. The runtime checks your evidence and runs its own verification.
- If you are blocked, call finish with outcome "blocked" and say what you need.`

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

export async function runOperator(deps: OperatorDeps, options: RunOptions): Promise<RunResult> {
  const runId = options.runId ?? newRunId()
  const approver = deps.approver ?? denyAll
  const maxSteps = options.maxSteps ?? 40
  const maxToolCalls = options.maxToolCalls ?? 120
  const maxVerify = options.maxVerifyAttempts ?? 3
  const emit = (e: RunEvent) => options.onEvent?.(e)
  const now = () => new Date().toISOString()
  const ctx: ToolContext = { workspace: deps.workspace, sandbox: deps.sandbox, checkpoints: deps.checkpoints, runId, signal: options.signal }

  const tools: ToolSpec[] = [
    ...deps.gate.list().map((t) => ({ name: t.name, description: t.description, input: t.input as z.ZodType<unknown> })),
    { name: 'finish', description: 'End the run: a summary, evidence (ids of tool calls in this run that show the work is done) and your outcome.', input: FINISH_INPUT as unknown as z.ZodType<unknown> },
  ]
  const system = [SYSTEM, `Sandbox: ${deps.sandbox.describe()}.`, options.verify?.length ? `After you finish, the runtime runs: ${options.verify.join(' && ')}. They must pass.` : '', options.instructions ?? ''].filter(Boolean).join('\n\n')
  const messages: LoopMessage[] = [{ role: 'user', text: options.goal }]
  /** Calls that ran and succeeded, by id. */
  const succeeded = new Set<string>()
  const usage = { inputTokens: 0, outputTokens: 0 }
  const notes: string[] = []
  let steps = 0
  let toolCalls = 0
  let verifyAttempts = 0

  await deps.audit.append({ runId, kind: 'run-start', at: now(), data: { goal: options.goal, verify: options.verify ?? [], sandbox: deps.sandbox.describe() } })

  const end = async (status: RunStatus, summary: string): Promise<RunResult> => {
    await deps.audit.append({ runId, kind: 'run-end', at: now(), data: { status, summary, steps, toolCalls, notes } })
    emit({ type: 'end', status, summary })
    return { runId, status, summary, steps, toolCalls, notes, usage }
  }

  while (steps < maxSteps) {
    if (options.signal?.aborted) return end('stopped', 'The run was cancelled.')
    steps++
    const reply = await deps.model.step({ system, messages, tools, signal: options.signal })
    usage.inputTokens += reply.usage?.inputTokens ?? 0
    usage.outputTokens += reply.usage?.outputTokens ?? 0
    emit({ type: 'model', text: reply.text, calls: reply.calls })
    messages.push({ role: 'assistant', text: reply.text, calls: reply.calls })

    if (!reply.calls.length) {
      messages.push({ role: 'user', text: 'Continue with the tools, or call finish if the work is complete or you are blocked.' })
      continue
    }

    for (const call of reply.calls) {
      if (call.name === 'finish') {
        const f = FINISH_INPUT.safeParse(call.input)
        if (!f.success) { messages.push({ role: 'tool', callId: call.id, tool: 'finish', output: `Invalid finish: ${f.error.issues.map((i) => i.message).join('; ')}` }); continue }
        const { summary, evidence, outcome } = f.data
        if (outcome !== 'done') {
          await deps.audit.append({ runId, kind: 'completion', at: now(), data: { outcome, summary } })
          return end('blocked', summary)
        }
        // Evidence must name calls that ran and succeeded in this run.
        const bad = evidence.filter((e) => !succeeded.has(e.callId))
        if (bad.length) {
          const note = `Evidence names calls that did not run or did not succeed: ${bad.map((b) => b.callId).join(', ')}.`
          notes.push(note)
          messages.push({ role: 'tool', callId: call.id, tool: 'finish', output: `${note} Cite only successful calls from this run, or do the work that shows it.` })
          continue
        }
        if (!options.verify?.length) {
          await deps.audit.append({ runId, kind: 'completion', at: now(), data: { status: 'done-unverified', summary, evidence } })
          return end('done-unverified', summary)
        }
        verifyAttempts++
        const failures: string[] = []
        for (const command of options.verify) {
          const r = formatRun(await deps.sandbox.run(command, { timeoutMs: 600_000, signal: options.signal }))
          emit({ type: 'verify', command, ok: r.ok, output: r.output })
          if (!r.ok) failures.push(`$ ${command}\n${r.output}`)
        }
        await deps.audit.append({ runId, kind: 'completion', at: now(), data: { attempt: verifyAttempts, passed: failures.length === 0, summary, evidence } })
        if (!failures.length) return end('verified', summary)
        notes.push(`Verification failed (attempt ${verifyAttempts} of ${maxVerify}).`)
        if (verifyAttempts >= maxVerify) return end('failed', `${summary}\n\nThe runtime's checks did not pass after ${verifyAttempts} attempts.`)
        messages.push({ role: 'tool', callId: call.id, tool: 'finish', output: `Not done: the runtime's checks failed.\n${failures.join('\n\n')}\nFix the cause, then call finish again.` })
        continue
      }

      if (toolCalls >= maxToolCalls) return end('stopped', `Stopped: the run used its ${maxToolCalls} tool calls.`)
      toolCalls++
      const d = await deps.gate.decide(runId, call.name, call.input)
      emit({ type: 'gate', tool: call.name, verdict: d.verdict, summary: d.summary, ...('reasons' in d ? { reasons: d.reasons } : {}) })
      if (d.verdict === 'refuse') {
        messages.push({ role: 'tool', callId: call.id, tool: call.name, output: `Refused by policy: ${d.reasons.join(' ')}` })
        continue
      }
      if (d.verdict === 'ask') {
        const request = { id: newApprovalId(), runId, tool: call.name, summary: d.summary, callHash: d.callHash, reasons: d.reasons, at: now() }
        const answer = await approver(request)
        const bound = answer.callHash === d.callHash
        await deps.audit.append({ runId, kind: 'approval', at: now(), data: { approvalId: request.id, tool: call.name, callHash: d.callHash, approved: answer.approved && bound, by: answer.by, note: answer.note ?? null, ...(bound ? {} : { mismatch: true }) } })
        if (!answer.approved || !bound) {
          messages.push({ role: 'tool', callId: call.id, tool: call.name, output: `Not approved${answer.note ? `: ${answer.note}` : '.'} Find another way or finish with outcome "blocked".` })
          continue
        }
      }
      const tool = deps.gate.tool(call.name)!
      let result
      try {
        result = await tool.run(d.input, ctx)
      } catch (e) {
        result = { ok: false, output: `The tool failed: ${(e as Error).message}` }
      }
      if (result.ok) succeeded.add(call.id)
      await deps.audit.append({ runId, kind: 'tool-result', at: now(), data: { callId: call.id, tool: call.name, ok: result.ok, facts: result.facts ?? {}, output: result.output.slice(0, 2000) } })
      emit({ type: 'tool', tool: call.name, ok: result.ok, output: result.output })
      messages.push({ role: 'tool', callId: call.id, tool: call.name, output: result.output })
    }
  }
  return end('stopped', `Stopped: the run used its ${maxSteps} model steps.`)
}
