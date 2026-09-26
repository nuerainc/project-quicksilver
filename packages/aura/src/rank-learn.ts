import { scoreImpact } from './impact.ts'
import type { IntentGraph } from './types.ts'

/**
 * Learned question order (per provider).
 *
 * The fixed impact scorer orders open questions the same way for everyone.
 * This learner orders them the way one provider does, learned from:
 *   - their rankings ("these three first, in this order"), and
 *   - real use: an answered question beats one they marked not worth asking.
 *
 * Model: pairwise logistic regression. Each open question gets features
 * (its slot, its slot within the mode, and its slot given what the objective
 * already states); the learned score orders the questions. With no training
 * it falls back to the fixed scorer's order. Learned weights are Aura's
 * inference about the provider: kept in their own record, never provider
 * intent, and they change nothing but the order questions are asked in.
 */

export interface RankerState {
  version: 1
  weights: Record<string, number>
  pairs: number
  /** Weight of the fixed scorer's score, so an untrained slot keeps a sensible place. */
  baseWeight: number
}

export function newRanker(): RankerState {
  return { version: 1, weights: {}, pairs: 0, baseWeight: 1 }
}

const STATED: Array<[string, string]> = [['budget', 'budget'], ['timeframe', 'time'], ['weekly_hours', 'hours'], ['success_metric', 'goal']]

/** Features for asking about `slot` on this intent. */
export function questionFeatures(graph: Pick<IntentGraph, 'mode' | 'variables'>, slot: string): Record<string, number> {
  const f: Record<string, number> = { [`s.${slot}`]: 1, [`m.${graph.mode ?? 'unknown'}.${slot}`]: 1 }
  for (const [id, tag] of STATED) {
    const v = graph.variables.find((x) => x.id === id)
    if (v && v.value !== undefined && v.provenance === 'HUMAN_SPECIFIED') f[`${tag}Stated.${slot}`] = 1
  }
  return f
}

function dot(w: Record<string, number>, f: Record<string, number>): number {
  let s = 0
  for (const [k, v] of Object.entries(f)) s += (w[k] ?? 0) * v
  return s
}

/** One gradient step on "the provider prefers `better` over `worse`". Pure. */
export function learnPair(state: RankerState, graph: Pick<IntentGraph, 'mode' | 'variables'>, better: string, worse: string, options: { learningRate?: number; l2?: number } = {}): RankerState {
  const lr = options.learningRate ?? 0.2
  const l2 = options.l2 ?? 0.05
  const fb = questionFeatures(graph, better), fw = questionFeatures(graph, worse)
  const g = 1 - 1 / (1 + Math.exp(-(dot(state.weights, fb) - dot(state.weights, fw))))
  const w = { ...state.weights }
  for (const k of new Set([...Object.keys(fb), ...Object.keys(fw)])) w[k] = (w[k] ?? 0) + lr * (g * ((fb[k] ?? 0) - (fw[k] ?? 0)) - l2 * (w[k] ?? 0))
  return { ...state, weights: w, pairs: state.pairs + 1 }
}

/** Pairs implied by a ranking: 1st > 2nd > 3rd > every unranked candidate. */
export function rankingPairs(candidates: string[], top: string[]): Array<[string, string]> {
  const rank = (c: string) => { const i = top.indexOf(c); return i < 0 ? top.length : i }
  const out: Array<[string, string]> = []
  for (const a of candidates) for (const b of candidates) if (rank(a) < rank(b)) out.push([a, b])
  return out
}

/** Train on rankings (several passes, deterministic order). */
export function trainRanker(examples: Array<{ graph: Pick<IntentGraph, 'mode' | 'variables'>; candidates: string[]; top: string[] }>, options: { epochs?: number; learningRate?: number; l2?: number } = {}, start: RankerState = newRanker()): RankerState {
  let s = start
  for (let e = 0; e < (options.epochs ?? 60); e++) for (const ex of examples) for (const [a, b] of rankingPairs(ex.candidates, ex.top)) s = learnPair(s, ex.graph, a, b, options)
  return s
}

/** Order candidate slots for this provider: learned score plus the fixed scorer's score as a tiebreak and prior. */
export function orderQuestions(state: RankerState | null | undefined, graph: IntentGraph, candidates: string[]): string[] {
  const base = new Map(scoreImpact(graph).map((i) => [i.variableId, i.score]))
  const score = (c: string) => (state ? dot(state.weights, questionFeatures(graph, c)) : 0) + (state?.baseWeight ?? 1) * (base.get(c) ?? 0)
  return [...candidates].sort((a, b) => score(b) - score(a) || candidates.indexOf(a) - candidates.indexOf(b))
}

/** Real use: the provider dismissed `dismissed`, so every other open question is preferred to it. */
export function learnFromDismissal(state: RankerState, graph: IntentGraph, dismissed: string, open: string[]): RankerState {
  let s = state
  for (const o of open) if (o !== dismissed) s = learnPair(s, graph, o, dismissed)
  return s
}

/** Real use: the provider answered `answered` while these were also open and unanswered. */
export function learnFromAnswer(state: RankerState, graph: IntentGraph, answered: string, open: string[]): RankerState {
  let s = state
  for (const o of open) if (o !== answered) s = learnPair(s, graph, answered, o, { learningRate: 0.05 })
  return s
}
