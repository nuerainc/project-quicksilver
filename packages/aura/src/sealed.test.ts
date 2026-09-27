import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FilePendingStore, predictionScoreboard, resolvePending, tallyVotes, validatePending, type PendingDecision, type SealedPrediction } from './sealed.ts'

const pred = (pick: string, wouldAct: boolean): SealedPrediction => ({ pick, votes: [pick], confidence: wouldAct ? 1 : 0.67, wouldAct, threshold: 1, method: 'test', at: '2026-09-27T00:00:00Z' })

test('votes: majority wins, ties go to the earliest vote, and disagreement means ask', () => {
  assert.deepEqual(tallyVotes(['b', 'b', 'b'], 1), { pick: 'b', votes: ['b', 'b', 'b'], confidence: 1, wouldAct: true })
  const split = tallyVotes(['a', 'b', 'b'], 1)!
  assert.equal(split.pick, 'b')
  assert.equal(split.wouldAct, false)
  assert.equal(tallyVotes(['c', 'a'], 0.5)!.pick, 'c')
  assert.equal(tallyVotes(['a', null, null], 0.5)!.wouldAct, false, 'failed votes count against confidence')
  assert.equal(tallyVotes([null], 1), null)
})

test('a pending decision resolves into a journal decision only with a valid choice and a reason', () => {
  const v = validatePending({ situation: 'Supplier raised prices 8%.', options: ['Accept', 'Negotiate', 'Switch supplier'], category: 'Purchasing' })
  assert.ok(v.ok)
  const p: PendingDecision = { id: 'pend-1', at: '2026-09-27T00:00:00Z', by: 'founder', ...(v.ok ? v.value : ({} as never)), prediction: pred('b', true) }
  assert.equal(p.category, 'purchasing')
  assert.equal(resolvePending(p, { chosen: 9, note: 'x' }, { id: 'dec-1', by: 'founder' }).ok, false)
  const noReason = resolvePending(p, { chosen: 2 }, { id: 'dec-1', by: 'founder' })
  assert.ok(!noReason.ok && /reason/.test(noReason.error))
  const r = resolvePending(p, { chosen: 'b', note: 'They are our best supplier; ask for a smaller rise.' }, { id: 'dec-1', by: 'founder' })
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.decision.chosen, 'b')
    assert.equal(r.decision.prediction.pick, 'b')
    assert.equal(r.decision.predictedId, 'pend-1')
    assert.equal(r.decision.source, 'journal')
  }
})

test('the scoreboard separates where Aura would act from where it would ask', () => {
  const base = { at: '', by: 'f', situation: 's', options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], source: 'journal' as const }
  const s = predictionScoreboard([
    { ...base, id: '1', chosen: 'a', prediction: pred('a', true) },
    { ...base, id: '2', chosen: 'b', prediction: pred('a', true) },
    { ...base, id: '3', chosen: 'b', prediction: pred('a', false) },
    { ...base, id: '4', chosen: 'a', prediction: pred('a', false) },
    { ...base, id: '5', chosen: 'a' },
  ])
  assert.deepEqual(s, { predicted: 4, agreed: 2, acted: 2, actedAgreed: 1, asked: 2, askedWouldMiss: 1 })
})

test('the pending store adds, finds and closes sealed decisions', async () => {
  const store = new FilePendingStore(join(await mkdtemp(join(tmpdir(), 'sealed-')), 'pending.json'))
  const p: PendingDecision = { id: 'pend-2', at: 'now', by: 'f', situation: 's', options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], prediction: pred('a', true) }
  await store.add(p)
  await assert.rejects(store.add(p))
  assert.equal((await store.get('pend-2'))?.prediction.pick, 'a')
  await store.close('pend-2')
  assert.deepEqual(await store.list(), [])
})
