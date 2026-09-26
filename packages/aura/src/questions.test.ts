/** Question quality in real use (charter revision 2). */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createIntent, openQuestions, questionQuality, recordQuestionFeedback } from './index.ts'

const now = new Date('2026-09-26T12:00:00Z')
const founder = { id: 'entity-founder', kind: 'human' as const }

test('feedback records the rank at that moment; dismissed questions leave the queue; only humans count', async () => {
  const { graph } = await createIntent('Start a side business sharpening knives and garden tools; I keep my day job.', { requestedBy: 'entity-founder', now })
  const before = openQuestions(graph)
  assert.ok(before.length > 3)
  assert.equal(recordQuestionFeedback(graph, { id: 'agent', kind: 'agent' }, before[0]!.variableId, 'not-worth-asking', now).ok, false)
  const d = recordQuestionFeedback(graph, founder, before[1]!.variableId, 'not-worth-asking', now)
  assert.ok(d.ok)
  if (!d.ok) return
  assert.equal(d.feedback.rank, 2)
  assert.ok(!openQuestions(d.graph).some((q) => q.variableId === before[1]!.variableId))
  assert.equal(recordQuestionFeedback(d.graph, founder, before[1]!.variableId, 'answered', now).ok, false, 'no longer an open question')
  const a = recordQuestionFeedback(d.graph, founder, before[0]!.variableId, 'answered', now)
  assert.ok(a.ok)
  if (!a.ok) return
  const q = questionQuality([a.graph])
  assert.deepEqual({ scored: q.scored, answered: q.answered, rate: q.rate, meets: q.meetsTarget }, { scored: 2, answered: 1, rate: 0.5, meets: false })
  assert.equal(questionQuality([graph]).rate, null)
})
