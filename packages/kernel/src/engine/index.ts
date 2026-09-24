import type { RiskLevel } from '../types.ts'
export { generateReasoningStressChallenge, scoreReasoningStressAnswer, runReasoningStressSuite } from './stress.ts'
export type { ReasoningChallengeCategory, ReasoningStressChallenge, ReasoningStressCaseResult, ReasoningStressReport } from './stress.ts'

export type EvaluationRisk = 'low' | 'med' | 'high'
export type ImpactLevel = 'low' | 'moderate' | 'high' | 'critical'
export type EvaluationTaskType = 'reasoning' | 'code' | 'bulk' | 'planning' | 'routing' | 'tool' | 'memory' | 'hydraulic' | 'evaluation' | 'other'

export interface EvaluatorToolCall {
  name: string
  succeeded: boolean
  error?: string
}

export interface EvaluationInput {
  /** Agent response text. Do not pass private chain-of-thought. */
  agentOutput: string
  context?: string[]
  taskType?: EvaluationTaskType
  modelId?: string
  toolCalls?: EvaluatorToolCall[]
  impactLevel?: ImpactLevel
  /** Identifiers the agent cites, and identifiers actually present in context. */
  citedReferences?: string[]
  availableReferences?: string[]
  uncertainty?: RiskLevel
  /** Number of dependent steps in a plan, when known. */
  stepCount?: number
}

export interface EvaluationResult {
  reasoningScore: number
  hallucinationRisk: EvaluationRisk
  brittleness: EvaluationRisk
  failureExemplars: string[]
  failedToolCount: number
  diagnosticReport: string[]
  correctionSuggestions: string[]
  evaluatedAt: string
  taskType: EvaluationTaskType
  modelId: string | null
}

/**
 * Deterministic, domain-neutral checks. This is a signal generator, not a
 * semantic truth detector: it scores observable support, tool failures, and
 * plan fragility without asking a second model to judge the answer.
 */
export function evaluateAgentOutput(input: EvaluationInput): EvaluationResult {
  const output = input.agentOutput.trim()
  const tools = input.toolCalls ?? []
  const cited = new Set(input.citedReferences ?? [])
  const available = new Set(input.availableReferences ?? [])
  const missingReferences = [...cited].filter((id) => !available.has(id))
  const failedTools = tools.filter((call) => !call.succeeded)
  const contextCount = input.context?.filter((item) => item.trim().length > 0).length ?? 0
  const impact = input.impactLevel ?? 'low'
  const steps = input.stepCount ?? 1
  const diagnostics: string[] = []
  const corrections: string[] = []
  const exemplars: string[] = []
  let score = 100

  if (!output) {
    score -= 60
    diagnostics.push('Agent output is empty.')
    corrections.push('Return a concrete result or an explicit reason the task could not be completed.')
    exemplars.push('Empty agent output.')
  }
  if (missingReferences.length > 0) {
    score -= Math.min(40, 20 + missingReferences.length * 5)
    diagnostics.push(`Output cites ${missingReferences.length} reference(s) absent from supplied context.`)
    corrections.push('Remove unsupported references or retrieve and include their source material.')
    exemplars.push(`Unresolved references: ${missingReferences.join(', ')}`)
  }
  if (contextCount === 0 && (input.citedReferences?.length ?? 0) === 0) {
    score -= 15
    diagnostics.push('No source context or cited references were supplied for evaluation.')
    corrections.push('Ground the result in retrieved evidence and include source identifiers.')
    exemplars.push('Answer produced without supplied evidence context.')
  }
  if (failedTools.length > 0) {
    score -= Math.min(30, failedTools.length * 10)
    diagnostics.push(`${failedTools.length} tool call(s) failed.`)
    corrections.push('Resolve failed tool calls and reassess any conclusions that depended on them.')
    exemplars.push(...failedTools.map((call) => `Tool ${call.name} failed${call.error ? `: ${call.error}` : '.'}`))
  }
  if ((input.uncertainty ?? 0) >= 4) {
    score -= 10
    diagnostics.push('The proposed work has high declared uncertainty.')
    corrections.push('Break uncertain steps into verifiable checks before execution.')
  }
  if (steps >= 5) {
    score -= 10
    diagnostics.push(`Plan has ${steps} dependent steps and may be brittle.`)
    corrections.push('Add checkpoints and validate intermediate results before continuing.')
  }
  if (impact === 'critical' && (contextCount === 0 || missingReferences.length > 0)) {
    score -= 15
    diagnostics.push('Critical-impact work has incomplete evidence grounding.')
    corrections.push('Require an independent evidence review before any execution.')
  }
  if (diagnostics.length === 0) diagnostics.push('No deterministic grounding or tool-use defects detected.')

  score = Math.max(0, Math.min(100, score))
  const hallucinationRisk: EvaluationRisk = missingReferences.length > 0 || !output
    ? 'high'
    : contextCount === 0 || failedTools.length > 0 || (input.uncertainty ?? 0) >= 4
      ? 'med'
      : 'low'
  const brittleness: EvaluationRisk = steps >= 8 || failedTools.length >= 2 || score < 45
    ? 'high'
    : steps >= 5 || failedTools.length > 0 || (input.uncertainty ?? 0) >= 4
      ? 'med'
      : 'low'

  return {
    reasoningScore: score,
    hallucinationRisk,
    brittleness,
    failureExemplars: exemplars,
    failedToolCount: failedTools.length,
    diagnosticReport: diagnostics,
    correctionSuggestions: corrections,
    evaluatedAt: new Date().toISOString(),
    taskType: input.taskType ?? 'other',
    modelId: input.modelId ?? null,
  }
}

export interface ToolDescriptor {
  name: string
  /** JSON Schema or other serializable parameter contract. */
  parameters?: unknown
  requiresApproval?: boolean
  /** Tool names that must have completed earlier in the current plan. */
  dependsOn?: string[]
}

export interface ToolRequest {
  name: string
  arguments: unknown
  sequence?: number
  approvalId?: string
}

export interface ToolValidationResult {
  allowed: boolean
  requiresApproval: boolean
  reasons: string[]
}

/** Validates tool identity and sequence before dispatch; unknown tools fail closed. */
export function validateToolRequest(
  request: ToolRequest,
  availableTools: ToolDescriptor[],
  expectedSequence?: number,
  completedTools: string[] = [],
  verifySupervisorApproval?: (approvalId: string, tool: ToolDescriptor) => boolean,
): ToolValidationResult {
  const tool = availableTools.find((candidate) => candidate.name === request.name)
  const reasons: string[] = []
  if (!tool) reasons.push(`Tool "${request.name}" is not registered.`)
  if (expectedSequence !== undefined && request.sequence !== expectedSequence) {
    reasons.push(`Tool sequence mismatch: expected ${expectedSequence}, received ${request.sequence ?? 'none'}.`)
  }
  if (request.arguments === undefined) reasons.push('Tool arguments are missing.')
  if (tool) {
    if (tool.requiresApproval && (!request.approvalId || !verifySupervisorApproval?.(request.approvalId, tool))) {
      reasons.push(`Tool "${request.name}" requires supervisor approval before dispatch.`)
    }
    for (const dependency of tool.dependsOn ?? []) {
      if (!completedTools.includes(dependency)) reasons.push(`Tool "${request.name}" requires "${dependency}" to complete first.`)
    }
    reasons.push(...validateJsonValue(request.arguments, tool.parameters, '$'))
  }
  return {
    allowed: reasons.length === 0,
    requiresApproval: Boolean(tool?.requiresApproval),
    reasons,
  }
}

function validateJsonValue(value: unknown, schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || value === undefined) return []
  const spec = schema as Record<string, unknown>
  const errors: string[] = []
  if (spec.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object.`]
    const object = value as Record<string, unknown>
    const required = Array.isArray(spec.required) ? spec.required.filter((x): x is string => typeof x === 'string') : []
    for (const key of required) if (!(key in object)) errors.push(`${path}.${key} is required.`)
    const properties = spec.properties && typeof spec.properties === 'object'
      ? spec.properties as Record<string, unknown>
      : {}
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) errors.push(...validateJsonValue(object[key], child, `${path}.${key}`))
    }
    if (spec.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in properties)) errors.push(`${path}.${key} is not an allowed parameter.`)
    }
  } else if (spec.type === 'string' && typeof value !== 'string') errors.push(`${path} must be a string.`)
  else if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${path} must be a number.`)
  else if (spec.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) errors.push(`${path} must be an integer.`)
  else if (spec.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be a boolean.`)
  else if (spec.type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path} must be an array.`)
    else if (spec.items) value.forEach((item, index) => errors.push(...validateJsonValue(item, spec.items, `${path}[${index}]`)))
  }
  if (Array.isArray(spec.enum) && !spec.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push(`${path} must match an allowed value.`)
  }
  if (typeof value === 'string' && typeof spec.minLength === 'number' && value.length < spec.minLength) errors.push(`${path} is shorter than allowed.`)
  if (typeof value === 'string' && typeof spec.maxLength === 'number' && value.length > spec.maxLength) errors.push(`${path} is longer than allowed.`)
  if (typeof value === 'number' && typeof spec.minimum === 'number' && value < spec.minimum) errors.push(`${path} is below the minimum.`)
  if (typeof value === 'number' && typeof spec.maximum === 'number' && value > spec.maximum) errors.push(`${path} is above the maximum.`)
  return errors
}
