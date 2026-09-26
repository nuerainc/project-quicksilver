/** Decision journal. Run with `npm run aura:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ShadowLog } from '@quicksilver/kernel/playbooks/shadow'

import {
  DecisionConflictError,
  decisionOptionFeatures,
  decisionsAsExamples,
  EXAMPLES_PREAMBLE,
  FileDecisionStore,
  MemoryDecisionStore,
  prequentialOnDecisions,
  recordDecision,
  validateDecision,
  verdictsAsDecisions,
  type Decision,
} from './index.ts'

const founder = { id: 'entity-founder', kind: 'human' as const }
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12))

test('validation: 2 to 5 options, a chosen option by id or number, limits enforced', () => {
  const ok = validateDecision({ situation: ' Supplier raised prices 8%. ', options: ['Pay it', 'Find another supplier', 'Negotiate a smaller rise'], chosen: 3, note: 'They value us.', category: 'Pricing' })
  assert.ok(ok.ok)
  if (!ok.ok) return
  assert.equal(ok.value.situation, 'Supplier raised prices 8%.')
  assert.deepEqual(ok.value.options.map((o) => o.id), ['a', 'b', 'c'])
  assert.equal(ok.value.chosen, 'c')
  assert.equal(ok.value.category, 'pricing')
  assert.equal(ok.value.source, 'journal')
  assert.equal((validateDecision({ situation: 'x', options: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }], chosen: 'no' }) as { ok: true; value: { chosen: string } }).value.chosen, 'no')
  assert.equal(validateDecision({ situation: 'x', options: ['only one'], chosen: 1 }).ok, false)
  assert.equal(validateDecision({ situation: 'x', options: ['1', '2', '3', '4', '5', '6'], chosen: 1 }).ok, false)
  assert.equal(validateDecision({ situation: 'x', options: ['a', 'b'], chosen: 3 }).ok, false)
  assert.equal(validateDecision({ situation: 'x'.repeat(1001), options: ['a', 'b'], chosen: 1 }).ok, false)
  assert.equal(validateDecision({ situation: 'x', options: ['a', ''], chosen: 1 }).ok, false)
  assert.equal(validateDecision({ situation: 'x', options: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }], chosen: 'a' }).ok, false)
  assert.equal(validateDecision({ situation: 'x', options: ['a', 'b'], chosen: 1, source: 'model' }).ok, false)
})

test('only a human logs a decision', () => {
  const input = { situation: 'Hire a part-timer?', options: ['Hire now', 'Wait a month'], chosen: 2 }
  const agent = recordDecision({ id: 'agent-x', kind: 'agent' }, input, { id: 'd1' })
  assert.equal(agent.ok, false)
  if (!agent.ok) assert.equal(agent.status, 403)
  const human = recordDecision(founder, input, { id: 'd1', now: at(1) })
  assert.ok(human.ok)
  if (human.ok) assert.deepEqual({ by: human.decision.by, at: human.decision.at, chosen: human.decision.chosen }, { by: 'entity-founder', at: at(1).toISOString(), chosen: 'b' })
})

const decision = (id: string, day: number, chosen: string, texts = ['Accept the order', 'Decline the order', 'Take a smaller pilot order']): Decision => ({
  id, at: at(day).toISOString(), by: 'entity-founder', situation: `Situation ${id}`, options: texts.map((text, i) => ({ id: 'abc'[i]!, text })), chosen, source: 'journal',
})

test('stores are append-only; the file store survives reloads and refuses duplicate ids', async () => {
  const mem = new MemoryDecisionStore()
  await mem.append(decision('d1', 1, 'a'))
  await assert.rejects(mem.append(decision('d1', 2, 'b')), DecisionConflictError)
  assert.equal((await mem.list()).length, 1)

  const dir = await mkdtemp(join(tmpdir(), 'qs-decisions-'))
  try {
    const path = join(dir, 'intent', 'decisions.jsonl')
    const store = new FileDecisionStore(path)
    assert.deepEqual(await store.list(), [])
    await Promise.all([store.append(decision('d1', 1, 'a')), store.append(decision('d2', 2, 'c')), store.append(decision('d3', 3, 'b'))])
    await assert.rejects(store.append(decision('d2', 4, 'a')), DecisionConflictError)
    const again = new FileDecisionStore(path)
    assert.deepEqual((await again.list()).map((d) => d.id).sort(), ['d1', 'd2', 'd3'])
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 3, 'one JSON line per decision')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

const shadowLog: ShadowLog = {
  recommendations: [
    { id: 'rec-1', department: 'finance', description: 'Send overdue reminders.', proposedAt: at(1).toISOString(), kernel: { recommendation: 'execute-autonomously', riskLevel: 1 }, executed: false, verdict: { value: 'accepted', by: 'entity-founder', at: at(2).toISOString() } },
    { id: 'rec-2', department: 'sales', description: 'Cut prices 20%.', proposedAt: at(1).toISOString(), kernel: { recommendation: 'request-approval', riskLevel: 3 }, executed: false, verdict: { value: 'rejected', by: 'entity-founder', at: at(3).toISOString(), note: 'Margins are thin.' } },
    { id: 'rec-3', department: 'sales', description: 'Email past customers.', proposedAt: at(1).toISOString(), kernel: { recommendation: 'request-approval', riskLevel: 2 }, executed: false, verdict: { value: 'modified', by: 'entity-founder', at: at(4).toISOString() } },
    { id: 'rec-4', department: 'operations', description: 'Not judged yet.', proposedAt: at(1).toISOString(), kernel: { recommendation: 'request-approval', riskLevel: 2 }, executed: false },
  ],
}

test('judged shadow verdicts become accept / modify / reject decisions; unjudged ones are left out', () => {
  const ds = verdictsAsDecisions(shadowLog, { intentId: 'intent-1' })
  assert.deepEqual(ds.map((d) => [d.id, d.chosen, d.source, d.category]), [
    ['shadow:intent-1:rec-1', 'accept', 'shadow', 'finance'],
    ['shadow:intent-1:rec-2', 'reject', 'shadow', 'sales'],
    ['shadow:intent-1:rec-3', 'modify', 'shadow', 'sales'],
  ])
  assert.equal(ds[1]!.note, 'Margins are thin.')
  assert.match(ds[1]!.situation, /Cut prices 20%\..*request-approval, risk 3/)
  assert.deepEqual(ds[0]!.options.map((o) => o.id), ['accept', 'modify', 'reject'])
  for (const d of ds) assert.ok(validateDecision({ ...d }).ok, 'derived decisions are valid decisions')
})

test('examples text uses the choice-eval examples style, oldest first', () => {
  const text = decisionsAsExamples([
    { ...decision('d2', 5, 'c'), note: 'Test them first.', category: 'sales' },
    decision('d1', 1, 'b'),
  ])
  const lines = text.split('\n')
  assert.equal(lines[0], EXAMPLES_PREAMBLE)
  assert.equal(lines[1], '')
  assert.equal(lines[2], '- Situation: Situation d1')
  assert.equal(lines[3], '  Options: a) Accept the order | b) Decline the order | c) Take a smaller pilot order')
  assert.equal(lines[4], '  They chose: b')
  assert.equal(lines[5], '- Area: sales. Situation: Situation d2')
  assert.equal(lines[7], '  They chose: c. Their note: "Test them first."')
  assert.equal(decisionsAsExamples([]).split('\n').length, 2)
})

test('baseline features ignore position; the prequential score is predict-then-learn with fair ties', () => {
  assert.deepEqual(decisionOptionFeatures('Decline the order'), { decline: 1 })
  assert.deepEqual(decisionOptionFeatures('Take a smaller pilot order'), { compromise: 1 })
  assert.deepEqual(decisionOptionFeatures('Accept the order'), {})

  const empty = prequentialOnDecisions([])
  assert.equal(empty.decisions, 0)
  assert.equal(empty.accuracy, null)

  // A provider who always takes the middle path: the first decision is a three-way tie
  // except for feature-less options, then the learner catches on.
  const ds = Array.from({ length: 10 }, (_, i) => decision(`d${i}`, i + 1, 'c'))
  const r = prequentialOnDecisions(ds)
  assert.equal(r.decisions, 10)
  assert.equal(r.chance, 0.333)
  assert.ok(r.ties >= 1, 'the first prediction is a tie, credited 1/3')
  assert.ok(r.accuracy! > 0.8)
  assert.equal(r.laterAccuracy, 1)
  assert.ok(r.weights.compromise! > 0)
  assert.match(r.label, /^Baseline only/)
  assert.deepEqual(Object.keys(r.bySource), ['journal'])

  // Options with identical features are always a tie: never credited by order.
  const same = prequentialOnDecisions(Array.from({ length: 4 }, (_, i) => decision(`s${i}`, i + 1, 'a', ['Option one', 'Option two'])))
  assert.equal(same.accuracy, 0.5)

  // Mixed sources are reported separately.
  const mixed = prequentialOnDecisions([...ds.slice(0, 3), ...verdictsAsDecisions(shadowLog)])
  assert.deepEqual(Object.keys(mixed.bySource).sort(), ['journal', 'shadow'])
})
