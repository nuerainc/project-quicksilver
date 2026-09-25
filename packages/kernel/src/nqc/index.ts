import { authorize, type AuthorizeArgs, type AuthorizeResult } from '../approval.ts'
import { evaluateAgentOutput, type EvaluationInput, type EvaluationResult } from '../engine/index.ts'
import { governMemoryWrite, type MemoryGovernanceDecision, type GovernedMemoryEntry } from './memory.ts'
import { selectRoute, type RoutingDecision, type RoutingRequest } from './routing.ts'

export type SafetyDecision = 'ALLOW' | 'BLOCK' | 'ESCALATE'

export interface NqcEvaluationRequest extends EvaluationInput {
  agentId: string
  routing?: RoutingRequest
}

export interface MemoryUpdateProposal {
  status: 'ready-for-review' | 'blocked'
  governance: MemoryGovernanceDecision
}

export interface NqcEvaluationResponse {
  agentId: string
  reasoningScore: number
  hallucinationRisk: EvaluationResult['hallucinationRisk']
  brittleness: EvaluationResult['brittleness']
  issues: string[]
  corrections: string[]
  safetyDecision: SafetyDecision
  routingUpdate: RoutingDecision | null
  /** Governed proposals only; this response does not persist memory. */
  memoryUpdates: MemoryUpdateProposal[]
  evaluation: EvaluationResult
}

export interface NqcDecision {
  /** Original deterministic authorization result, tightened only by NQC signals. */
  decision: AuthorizeResult
  evaluation: EvaluationResult
  escalationReasons: string[]
  safetyDecision: SafetyDecision
}

/** Stable v1 evaluation contract for NQC Kernel callers. */
export function evaluateNqcRequest(input: NqcEvaluationRequest): NqcEvaluationResponse {
  const evaluation = evaluateAgentOutput(input)
  const memoryUpdates = evaluation.failureExemplars.map((content, index) => {
    const entry: GovernedMemoryEntry = {
      id: `${input.agentId}:${evaluation.evaluatedAt}:${index}`,
      kind: 'failure-exemplar',
      domain: input.taskType ?? 'other',
      content,
      source: `quicksilver-engine/${input.modelId ?? 'unknown-model'}`,
      confidence: 0.8,
      retentionDays: 365,
    }
    const governance = governMemoryWrite(entry)
    return { status: governance.allowed ? 'ready-for-review' as const : 'blocked' as const, governance }
  })
  const safetyDecision: SafetyDecision = input.impactLevel === 'high'
    || input.impactLevel === 'critical'
    || evaluation.hallucinationRisk === 'high'
    || evaluation.brittleness === 'high'
    || evaluation.failedToolCount > 0
    || evaluation.reasoningScore < 60
    ? 'ESCALATE'
    : 'ALLOW'

  return {
    agentId: input.agentId,
    reasoningScore: evaluation.reasoningScore,
    hallucinationRisk: evaluation.hallucinationRisk,
    brittleness: evaluation.brittleness,
    issues: evaluation.diagnosticReport,
    corrections: evaluation.correctionSuggestions,
    safetyDecision,
    routingUpdate: input.routing ? selectRoute(input.routing) : null,
    memoryUpdates,
    evaluation,
  }
}

/**
 * NQC control point. Evaluation can tighten an allow into human review, but
 * can never override a capability, policy, or evidence rejection from the
 * deterministic Quicksilver kernel.
 */
export function evaluateAndAuthorize(
  args: AuthorizeArgs,
  evaluationInput: EvaluationInput,
): NqcDecision {
  const base = authorize(args)
  const evaluation = evaluateAgentOutput(evaluationInput)
  const escalationReasons: string[] = []

  if (evaluation.hallucinationRisk === 'high') {
    escalationReasons.push('Evaluator reports high hallucination risk.')
  }
  if (evaluation.brittleness === 'high') {
    escalationReasons.push('Evaluator reports high plan brittleness.')
  }
  if (evaluation.reasoningScore < 60) {
    escalationReasons.push(`Evaluator score ${evaluation.reasoningScore}/100 is below the autonomous threshold.`)
  }
  if (evaluation.failedToolCount > 0) {
    escalationReasons.push(`${evaluation.failedToolCount} tool call(s) failed and require review.`)
  }
  if (evaluationInput.impactLevel === 'high' || evaluationInput.impactLevel === 'critical') {
    escalationReasons.push(`${evaluationInput.impactLevel[0]?.toUpperCase()}${evaluationInput.impactLevel.slice(1)}-impact work requires human review.`)
  }

  if (!base.authorized || escalationReasons.length === 0) {
    return {
      decision: base,
      evaluation,
      escalationReasons,
      safetyDecision: base.authorized ? 'ALLOW' : 'BLOCK',
    }
  }

  return {
    decision: {
      ...base,
      recommendation: 'request-approval',
      requiresApproval: true,
      concerns: [...base.concerns, ...escalationReasons],
    },
    evaluation,
    escalationReasons,
    safetyDecision: 'ESCALATE',
  }
}

/**
 * Apply an escalation from an upstream governed step (for example, the planner
 * run that produced this action) to a per-action NQC decision.
 *
 * Tightens only: an upstream ESCALATE turns an autonomous ALLOW into human
 * review; it never loosens a BLOCK, a rejection, or an existing escalation.
 */
export function applyUpstreamEscalation(
  result: NqcDecision,
  upstream: { safetyDecision: SafetyDecision; issues: string[] },
  label: string,
): NqcDecision {
  if (upstream.safetyDecision === 'ALLOW') return result
  if (result.safetyDecision === 'BLOCK' || !result.decision.authorized) return result
  const reason = `${label} was escalated by the Quicksilver Engine${upstream.issues.length ? `: ${upstream.issues.join(' ')}` : '.'}`
  return {
    ...result,
    decision: {
      ...result.decision,
      recommendation: 'request-approval',
      requiresApproval: true,
      concerns: [...result.decision.concerns, reason],
    },
    escalationReasons: [...result.escalationReasons, reason],
    safetyDecision: 'ESCALATE',
  }
}
