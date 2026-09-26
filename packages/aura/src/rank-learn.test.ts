/** Learned question order. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createIntent, learnFromDismissal, newRanker, openQuestions, orderQuestions, trainRanker } from './index.ts'

const now = new Date('2026-09-26T12:00:00Z')

test('untrained, the order is the fixed scorer’s; trained on rankings, it follows the provider', async () => {
  const { graph } = await createIntent('Our car wash wants more repeat customers; figure out our slow days.', { requestedBy: 'e', now })
  const ids = openQuestions(graph).map((q) => q.variableId)
  assert.deepEqual(orderQuestions(null, graph, ids), ids)
  const last = ids[ids.length - 1]!
  const trained = trainRanker([{ graph, candidates: ids, top: [last, ...ids.slice(0, 2)] }], { epochs: 30 })
  assert.equal(openQuestions(graph, trained)[0]!.variableId, last)
})

test('dismissing a question pushes it down for later intents of the same kind', async () => {
  const a = (await createIntent('Start a side business sharpening knives and garden tools; I keep my day job.', { requestedBy: 'e', now })).graph
  const first = openQuestions(a)[0]!.variableId
  let r = newRanker()
  for (let i = 0; i < 5; i++) r = learnFromDismissal(r, a, first, openQuestions(a).map((q) => q.variableId))
  const b = (await createIntent('Help me start a mobile welding repair service from scratch.', { requestedBy: 'e', now })).graph
  const order = openQuestions(b, r).map((q) => q.variableId)
  if (order.includes(first)) assert.notEqual(order[0], first)
})

test('training is deterministic', async () => {
  const { graph } = await createIntent('I own a boutique; bring it into Quicksilver and tell me what to fix first.', { requestedBy: 'e', now })
  const ids = openQuestions(graph).map((q) => q.variableId)
  const ex = [{ graph, candidates: ids, top: ids.slice().reverse().slice(0, 3) }]
  assert.deepEqual(trainRanker(ex).weights, trainRanker(ex).weights)
})
