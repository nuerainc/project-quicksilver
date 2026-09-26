import type { ProfileResult } from './profile.ts'
import type { PredictorSpec } from './predict.ts'

/**
 * Learning choice predictor (v2 direction): it starts from the provider's
 * profile and learns from every choice they make — scenario answers now,
 * shadow-mode verdicts in the pilot.
 *
 * Model: a multinomial logit over the options of one decision. Each option
 * is a feature vector; its utility is w · features; the prediction is the
 * option with the highest utility, with a probability for each option.
 * After the provider's actual choice is known, the weights take one
 * gradient step on the log-likelihood, pulled back toward the prior (the
 * profile) so a single answer never swings the model.
 *
 * Honest measurement: `prequential` predicts each decision BEFORE learning
 * from it, in order, so every scored prediction was made without its answer.
 *
 * Governance: learned weights are Aura's inference about the provider, never
 * provider-stated intent. They are kept in their own record, shown to the
 * provider with their evidence, and never overwrite weights in the intent
 * ledger.
 */

export type Features = Record<string, number>

export interface ChoiceOption {
  id: string
  features: Features
}

export interface LearnerState {
  weights: Record<string, number>
  prior: Record<string, number>
  observations: number
  learningRate: number
  /** Strength of the pull back toward the prior (L2). */
  priorStrength: number
}

export function newLearner(prior: Record<string, number>, options: { learningRate?: number; priorStrength?: number } = {}): LearnerState {
  return { weights: { ...prior }, prior: { ...prior }, observations: 0, learningRate: options.learningRate ?? 0.5, priorStrength: options.priorStrength ?? 0.1 }
}

function utility(w: Record<string, number>, f: Features): number {
  let u = 0
  for (const [k, v] of Object.entries(f)) u += (w[k] ?? 0) * v
  return u
}

export function probabilities(state: LearnerState, options: ChoiceOption[]): Record<string, number> {
  const us = options.map((o) => utility(state.weights, o.features))
  const max = Math.max(...us)
  const exps = us.map((u) => Math.exp(u - max))
  const z = exps.reduce((a, b) => a + b, 0)
  return Object.fromEntries(options.map((o, i) => [o.id, exps[i]! / z]))
}

/** The most likely option; ties go to the earliest option. */
export function predictOption(state: LearnerState, options: ChoiceOption[]): { choice: string; probability: number; probabilities: Record<string, number> } {
  const p = probabilities(state, options)
  let best = options[0]!.id
  for (const o of options) if (p[o.id]! > p[best]! + 1e-12) best = o.id
  return { choice: best, probability: p[best]!, probabilities: p }
}

/** Learn from one observed choice. Pure: returns a new state. */
export function learn(state: LearnerState, options: ChoiceOption[], chosen: string): LearnerState {
  if (!options.some((o) => o.id === chosen)) throw new Error(`Chosen option "${chosen}" is not among the options.`)
  const p = probabilities(state, options)
  const keys = new Set([...Object.keys(state.weights), ...options.flatMap((o) => Object.keys(o.features))])
  const w: Record<string, number> = {}
  for (const k of keys) {
    const observed = options.find((o) => o.id === chosen)!.features[k] ?? 0
    const expected = options.reduce((s, o) => s + p[o.id]! * (o.features[k] ?? 0), 0)
    const pull = state.priorStrength * ((state.weights[k] ?? 0) - (state.prior[k] ?? 0))
    w[k] = (state.weights[k] ?? 0) + state.learningRate * (observed - expected - pull)
  }
  return { ...state, weights: w, observations: state.observations + 1 }
}

export interface PrequentialResult {
  decisions: number
  correct: number
  accuracy: number
  /** Accuracy over the second half only: how well it does once it has learned. */
  laterAccuracy: number
  /** Mean probability given to the option actually chosen (calibration signal). */
  meanProbabilityOfActual: number
  rows: Array<{ id: string; predicted: string; actual: string; probability: number; correct: boolean }>
  final: LearnerState
}

/** Predict each decision before learning from it, in the given order. */
export function prequential(start: LearnerState, decisions: Array<{ id: string; options: ChoiceOption[]; chosen: string }>): PrequentialResult {
  let state = start
  const rows: PrequentialResult['rows'] = []
  let pActual = 0
  for (const d of decisions) {
    const pred = predictOption(state, d.options)
    rows.push({ id: d.id, predicted: pred.choice, actual: d.chosen, probability: pred.probability, correct: pred.choice === d.chosen })
    pActual += pred.probabilities[d.chosen] ?? 0
    state = learn(state, d.options, d.chosen)
  }
  const n = rows.length
  const half = rows.slice(Math.floor(n / 2))
  return {
    decisions: n,
    correct: rows.filter((r) => r.correct).length,
    accuracy: n ? rows.filter((r) => r.correct).length / n : 0,
    laterAccuracy: half.length ? half.filter((r) => r.correct).length / half.length : 0,
    meanProbabilityOfActual: n ? pActual / n : 0,
    rows,
    final: state,
  }
}

// ---------------------------------------------------------------------------
// Features for the choice scenarios

/**
 * Feature vector for a scenario option, from the predictor spec's dimension
 * tags plus general decision features:
 *   dim.<name>     signed load (+ toward the dimension's right pole)
 *   ask            1 for the "ask first" option
 *   compromise     1 when the option takes a partial position (weight < 1) on a dimension
 *   practical      1 when the option expresses no trade-off dimension at all
 */
export function scenarioFeatures(spec: PredictorSpec, scenarioId: string, optionIds: string[], extra: Record<string, Record<string, Record<string, [string, number]>>> = {}): ChoiceOption[] {
  const ann = spec.annotations[scenarioId]
  return optionIds.map((id) => {
    if (id === 'ask') return { id, features: { ask: 1 } }
    const loads: Record<string, [string, number]> = { ...(ann?.covered ? (ann.options?.[id] ?? {}) as Record<string, [string, number]> : {}), ...(extra[scenarioId]?.[id] ?? {}) }
    const f: Features = {}
    let partial = false
    for (const [dim, [pole, w]] of Object.entries(loads)) {
      if (dim === 'autonomy') continue
      f[`dim.${dim}`] = (pole === 'right' ? 1 : -1) * w
      if (w < 1) partial = true
    }
    if (partial) f.compromise = 1
    if (!Object.keys(f).length) f.practical = 1
    return { id, features: f }
  })
}

/** Prior weights from a scored profile: each dimension's score × confidence/10; nothing else is assumed. */
export function priorFromProfile(profile: ProfileResult, extra: Record<string, number> = {}): Record<string, number> {
  const prior: Record<string, number> = {}
  for (const d of profile.dimensions) if (d.dimension !== 'autonomy') prior[`dim.${d.dimension}`] = d.score * (d.confidence / 10)
  const autonomy = profile.dimensions.find((d) => d.dimension === 'autonomy')
  if (autonomy) prior.ask = autonomy.score * (autonomy.confidence / 10)
  return { ...prior, ...extra }
}
