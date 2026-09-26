import { learn, newLearner, predictOption, prequential, type ChoiceOption, type Features, type LearnerState, type PrequentialResult } from './learn.ts'
import type { OptionLoadings } from './predict.ts'

/**
 * Choice predictor v2 (frozen 2026-09-26, eval/choice-predictor-v2.json).
 *
 * A pure, offline combiner: the blind model's pick is the starting point, and
 * the learner (learn.ts) adjusts it from the provider's own choices. The
 * model's pick is one feature alongside compromise, practical, ask, a
 * per-category ask term and the options' dimension loads.
 *
 * Nothing here calls a model. The caller supplies `modelPick` (produced
 * separately and blind, by `npm run aura:choices:model -- --set v2`).
 *
 * The constants below are the frozen spec's values; a test checks they match
 * the spec file, and the spec's hash is pinned, so changing any of them is a
 * new version, never a silent edit.
 */

export const CHOICE_PREDICTOR_V2 = 'aura-choice-predictor-v2'

/** Prior: the model's pick gets 1.5, every other weight 0 (see the spec's `whyPrior`). */
export const V2_PRIOR: Readonly<Record<string, number>> = Object.freeze({ model: 1.5 })
export const V2_LEARNING_RATE = 0.5
export const V2_PRIOR_STRENGTH = 0.1
/** Option order; exact ties go to the earliest. */
export const V2_OPTION_ORDER: readonly string[] = Object.freeze(['a', 'b', 'c', 'ask'])
export const V2_TARGET = Object.freeze({ accuracy: 0.7, timesChance: 2 })

export interface V2OptionAnnotation {
  /** Profile dimensions the option expresses, with pole and weight. */
  loads?: OptionLoadings
  /** The option takes a partial position between the others. */
  compromise?: boolean
}

/** Annotations for one scenario's action options ("ask" is never annotated). */
export type V2ScenarioAnnotation = Record<string, V2OptionAnnotation>

export interface V2Spec {
  version: number
  frozenAt: string
  method: {
    prior: Record<string, number>
    priorDefault: number
    learningRate: number
    priorStrength: number
    optionOrder: string[]
    scoring: { target: { accuracy: number; timesChance: number } }
    [k: string]: unknown
  }
  annotations: Record<string, V2ScenarioAnnotation>
}

export interface V2Decision {
  id: string
  category: string
  /** Option ids offered, e.g. ["a", "b", "c", "ask"]. */
  options: string[]
  annotation?: V2ScenarioAnnotation
  /** The blind model's pick, or null when there is none (model error). */
  modelPick: string | null
}

export interface V2ScoredDecision extends V2Decision {
  /** The provider's actual choice. */
  chosen: string
}

function ordered(ids: string[]): string[] {
  const known = V2_OPTION_ORDER.filter((id) => ids.includes(id))
  return [...known, ...ids.filter((id) => !V2_OPTION_ORDER.includes(id))]
}

/** Feature vectors for one decision, in the frozen option order. */
export function v2Features(d: V2Decision): ChoiceOption[] {
  if (new Set(d.options).size !== d.options.length) throw new Error(`${d.id}: duplicate option ids.`)
  if (d.modelPick !== null && !d.options.includes(d.modelPick)) throw new Error(`${d.id}: model pick "${d.modelPick}" is not among the options.`)
  return ordered(d.options).map((id) => {
    const f: Features = {}
    if (id === 'ask') {
      f.ask = 1
      f[`cat.${d.category}.ask`] = 1
    } else {
      const ann = d.annotation?.[id] ?? {}
      for (const [dim, [pole, w]] of Object.entries(ann.loads ?? {})) {
        if (dim === 'autonomy') continue
        f[`dim.${dim}`] = (pole === 'right' ? 1 : -1) * w
      }
      if (ann.compromise) f.compromise = 1
      else if (!Object.keys(f).length) f.practical = 1
    }
    if (d.modelPick === id) f.model = 1
    return { id, features: f }
  })
}

export function newV2Learner(): LearnerState {
  return newLearner({ ...V2_PRIOR }, { learningRate: V2_LEARNING_RATE, priorStrength: V2_PRIOR_STRENGTH })
}

export function predictV2(state: LearnerState, d: V2Decision): { choice: string; probability: number; probabilities: Record<string, number> } {
  return predictOption(state, v2Features(d))
}

export function learnV2(state: LearnerState, d: V2Decision, chosen: string): LearnerState {
  return learn(state, v2Features(d), chosen)
}

export interface V2CategoryResult {
  decisions: number
  correct: number
  accuracy: number
}

export interface V2Result extends PrequentialResult {
  predictor: typeof CHOICE_PREDICTOR_V2
  /** Mean of 1 / number of options. */
  chance: number
  timesChance: number
  /** The model's pick alone, for reference (a missing pick counts as a miss). */
  modelAlone: { correct: number; accuracy: number }
  byCategory: Record<string, V2CategoryResult>
  meetsTarget: boolean
}

/**
 * Predict each decision before learning from it, in the given order (the
 * frozen order is scenario order). Every scored prediction is made without
 * its own answer or any later one.
 */
export function prequentialV2(decisions: V2ScoredDecision[], start: LearnerState = newV2Learner()): V2Result {
  for (const d of decisions) if (!d.options.includes(d.chosen)) throw new Error(`${d.id}: chosen option "${d.chosen}" is not among the options.`)
  const r = prequential(start, decisions.map((d) => ({ id: d.id, options: v2Features(d), chosen: d.chosen })))
  const n = decisions.length
  const chance = n ? decisions.reduce((s, d) => s + 1 / d.options.length, 0) / n : 0
  const byCategory: Record<string, V2CategoryResult> = {}
  decisions.forEach((d, i) => {
    const c = (byCategory[d.category] ??= { decisions: 0, correct: 0, accuracy: 0 })
    c.decisions++
    if (r.rows[i]!.correct) c.correct++
  })
  for (const c of Object.values(byCategory)) c.accuracy = c.correct / c.decisions
  const modelCorrect = decisions.filter((d) => d.modelPick !== null && d.modelPick === d.chosen).length
  return {
    ...r,
    predictor: CHOICE_PREDICTOR_V2,
    chance,
    timesChance: chance ? r.accuracy / chance : 0,
    modelAlone: { correct: modelCorrect, accuracy: n ? modelCorrect / n : 0 },
    byCategory,
    meetsTarget: n > 0 && r.accuracy >= V2_TARGET.accuracy && r.accuracy >= V2_TARGET.timesChance * chance,
  }
}
