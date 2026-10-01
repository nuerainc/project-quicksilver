import type { BusinessAgentOutput } from '@quicksilver/agent'
import type { NqcEvaluationResponse } from '@quicksilver/kernel'

/** Do not display a blocked model result; escalation remains visibly provisional. */
type DisplayEvaluation = Pick<NqcEvaluationResponse, 'reasoningScore' | 'hallucinationRisk' | 'brittleness' | 'issues' | 'corrections' | 'safetyDecision'>

export function presentBusinessAgentResult(output: BusinessAgentOutput, evaluation: DisplayEvaluation) {
  const blocked = evaluation.safetyDecision === 'BLOCK'
  return {
    summary: blocked ? 'The NQC Kernel blocked this specialist result from display.' : output.summary,
    recommendations: blocked ? [] : output.recommendations,
    unknowns: blocked ? [] : output.unknowns,
    questions: blocked ? [] : output.questions,
    externalEffects: blocked ? [] : output.externalEffects,
    nqc: {
      reasoningScore: evaluation.reasoningScore,
      hallucinationRisk: evaluation.hallucinationRisk,
      brittleness: evaluation.brittleness,
      issues: evaluation.issues,
      corrections: evaluation.corrections,
      safetyDecision: evaluation.safetyDecision,
    },
    actionPolicy: 'proposal-only' as const,
  }
}
