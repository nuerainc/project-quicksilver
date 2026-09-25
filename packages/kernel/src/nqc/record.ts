import type { NqcEvaluationResponse } from './index.ts'

/**
 * Durable evaluation records.
 *
 * Every governed agent result is evaluated by the Quicksilver Engine. Plan
 * decisions already store their evaluation on the decision document; this
 * builds the audit record for other governed calls (query runs, live workflow
 * steps) so their evaluations persist too. Pure and deterministic: the caller
 * supplies the id and timestamp and chooses the store.
 *
 * No private chain-of-thought is stored: only the subject (the question or
 * input, truncated), the scores, risks, issues and corrections, and the safety
 * decision.
 */

export type EvaluationSource = 'query' | 'workflow-run'

export interface EvaluationRecordInput {
  id: string
  now: string
  source: EvaluationSource
  agentId: string
  taskType: string
  modelId?: string | null
  /** The question or workflow input that produced the output. */
  subject: string
  requestedBy: string
  evaluation: NqcEvaluationResponse
  runId?: string | null
  nodeId?: string | null
}

export const MAX_EVALUATION_SUBJECT_CHARS = 2_000

export interface EvaluationRecord {
  _id: string
  _type: 'evaluationRecord'
  source: EvaluationSource
  agentId: string
  taskType: string
  modelId: string | null
  subject: string
  requestedBy: string
  runId: string | null
  nodeId: string | null
  reasoningScore: number
  hallucinationRisk: string
  brittleness: string
  safetyDecision: string
  issues: string[]
  corrections: string[]
  createdAt: string
}

export function buildEvaluationRecord(input: EvaluationRecordInput): EvaluationRecord {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.id)) throw new Error('Evaluation record id must be a plain document id.')
  const subject = input.subject.length > MAX_EVALUATION_SUBJECT_CHARS
    ? `${input.subject.slice(0, MAX_EVALUATION_SUBJECT_CHARS)}…`
    : input.subject
  return {
    _id: input.id,
    _type: 'evaluationRecord',
    source: input.source,
    agentId: input.agentId,
    taskType: input.taskType,
    modelId: input.modelId ?? null,
    subject,
    requestedBy: input.requestedBy,
    runId: input.runId ?? null,
    nodeId: input.nodeId ?? null,
    reasoningScore: input.evaluation.reasoningScore,
    hallucinationRisk: input.evaluation.hallucinationRisk,
    brittleness: input.evaluation.brittleness,
    safetyDecision: input.evaluation.safetyDecision,
    issues: [...input.evaluation.issues],
    corrections: [...input.evaluation.corrections],
    createdAt: input.now,
  }
}
