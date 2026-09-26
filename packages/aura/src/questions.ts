import { scoreImpact } from './impact.ts'
import { orderQuestions, type RankerState } from './rank-learn.ts'
import type { IntentGraph, QuestionFeedback } from './types.ts'

/**
 * Question quality in real use (charter revision 2).
 *
 * The charter's impact criterion used to be an offline ranking exercise. It
 * is now measured as questions are asked: when the provider answers one of
 * Aura's open questions, or marks it "not worth asking", Aura records the
 * question's position in its impact order at that moment. Question quality
 * is the share of Aura's first three questions (rank 1–3) that the provider
 * answered rather than dismissed. Target: at least 80%.
 *
 * Only a human provider's actions count; the record is append-only.
 */

export const QUESTION_QUALITY_TARGET = 0.8

type Actor = { id: string; kind: 'human' | 'agent' | 'service' }

export function recordQuestionFeedback(
  graph: IntentGraph,
  actor: Actor,
  variableId: string,
  outcome: QuestionFeedback['outcome'],
  now: Date = new Date(),
  ranker?: RankerState | null,
): { ok: true; graph: IntentGraph; feedback: QuestionFeedback } | { ok: false; reason: string } {
  if (actor.kind !== 'human') return { ok: false, reason: 'Only the provider (a human) answers or dismisses Aura’s questions.' }
  const open = openQuestions(graph, ranker)
  const i = open.findIndex((q) => q.variableId === variableId)
  if (i < 0) return { ok: false, reason: `"${variableId}" is not an open question on this intent (answered, dismissed, or never asked).` }
  const feedback: QuestionFeedback = { variableId, outcome, rank: i + 1, openQuestions: open.length, at: now.toISOString(), by: actor.id }
  return { ok: true, graph: { ...graph, questionFeedback: [...(graph.questionFeedback ?? []), feedback] }, feedback }
}

/**
 * Open questions in the order Aura will ask them. Questions the provider
 * dismissed are no longer asked. With a trained ranker (this provider's
 * learned order) the order is theirs; without one, the fixed scorer's.
 */
export function openQuestions(graph: IntentGraph, ranker?: RankerState | null) {
  const dismissed = new Set((graph.questionFeedback ?? []).filter((f) => f.outcome === 'not-worth-asking').map((f) => f.variableId))
  const items = scoreImpact(graph).filter((q) => !dismissed.has(q.variableId))
  if (!ranker || !ranker.pairs) return items
  const order = orderQuestions(ranker, graph, items.map((i) => i.variableId))
  return order.map((id) => items.find((i) => i.variableId === id)!)
}

export interface QuestionQuality {
  /** Feedback on questions Aura ranked in its top three. */
  scored: number
  answered: number
  dismissed: number
  rate: number | null
  meetsTarget: boolean | null
}

export function questionQuality(graphs: IntentGraph[]): QuestionQuality {
  const top = graphs.flatMap((g) => g.questionFeedback ?? []).filter((f) => f.rank <= 3)
  const answered = top.filter((f) => f.outcome === 'answered').length
  const rate = top.length ? Math.round((answered / top.length) * 1000) / 1000 : null
  return { scored: top.length, answered, dismissed: top.length - answered, rate, meetsTarget: rate === null ? null : rate >= QUESTION_QUALITY_TARGET }
}
