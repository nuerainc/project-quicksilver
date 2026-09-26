import type { ShadowLog, ShadowRecommendation, Verdict } from '@quicksilver/kernel/playbooks/shadow'

import { learn, newLearner, probabilities, type ChoiceOption, type LearnerState } from './learn.ts'

/**
 * Learning from shadow-mode verdicts (M4 pilot).
 *
 * Each recommendation is a choice between doing it ("accept") and not doing
 * it ("decline", the status quo, which has no features). Before the owner
 * judges it, Aura records its prediction; the verdict then trains the
 * learner. Pilot agreement is therefore predict-then-learn, like the
 * prequential test on the scenarios.
 *
 *   accepted → the owner chose "accept"
 *   rejected → the owner chose "decline"
 *   modified → "accept", learned at half the step (right direction, not as proposed)
 *
 * The learner's weights are Aura's inference about the provider. They live in
 * their own record, never in the intent ledger, and grant nothing: hand-over
 * stays the provider's own ledger entry.
 */

export const VERDICT_MODEL = 'aura-verdict-learner-v0'

/** Features for a recommendation: its department, the kernel's risk, and any extra features it carries. */
export function recommendationFeatures(rec: Pick<ShadowRecommendation, 'department' | 'kernel' | 'features'>): Record<string, number> {
  return {
    [`dept.${rec.department}`]: 1,
    risk: rec.kernel.riskLevel / 5,
    escalated: rec.kernel.recommendation === 'execute-autonomously' ? 0 : 1,
    ...(rec.features ?? {}),
  }
}

function options(rec: Pick<ShadowRecommendation, 'department' | 'kernel' | 'features'>): ChoiceOption[] {
  return [{ id: 'accept', features: recommendationFeatures(rec) }, { id: 'decline', features: {} }]
}

export function newVerdictLearner(prior: Record<string, number> = {}): LearnerState {
  return newLearner(prior, { learningRate: 0.5, priorStrength: 0.1 })
}

/** Probability the owner accepts (or modifies) the recommendation. */
export function predictAccept(state: LearnerState, rec: Pick<ShadowRecommendation, 'department' | 'kernel' | 'features'>): ShadowRecommendation['prediction'] & {} {
  const p = probabilities(state, options(rec)).accept!
  return { accept: Math.round(p * 1000) / 1000, observations: state.observations, model: VERDICT_MODEL }
}

export function learnFromVerdict(state: LearnerState, rec: Pick<ShadowRecommendation, 'department' | 'kernel' | 'features'>, verdict: Verdict): LearnerState {
  if (verdict === 'modified') {
    const next = learn({ ...state, learningRate: state.learningRate / 2 }, options(rec), 'accept')
    return { ...next, learningRate: state.learningRate }
  }
  return learn(state, options(rec), verdict === 'accepted' ? 'accept' : 'decline')
}

export interface PredictionAgreement {
  /** Judged recommendations that carried a prediction made before the verdict. */
  scored: number
  agreed: number
  rate: number | null
  /** Mean probability given to what the owner actually did. */
  meanProbabilityOfActual: number | null
}

/** How often Aura's recorded prediction matched the owner's verdict (accept ≥ 0.5 counts as predicting accept). */
export function predictionAgreement(log: ShadowLog): PredictionAgreement {
  const scored = log.recommendations.filter((r) => r.verdict && r.prediction)
  let agreed = 0
  let pActual = 0
  for (const r of scored) {
    const accepted = r.verdict!.value !== 'rejected'
    if ((r.prediction!.accept >= 0.5) === accepted) agreed++
    pActual += accepted ? r.prediction!.accept : 1 - r.prediction!.accept
  }
  return {
    scored: scored.length,
    agreed,
    rate: scored.length ? Math.round((agreed / scored.length) * 1000) / 1000 : null,
    meanProbabilityOfActual: scored.length ? Math.round((pActual / scored.length) * 1000) / 1000 : null,
  }
}
