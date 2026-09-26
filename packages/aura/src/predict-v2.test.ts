/** Choice predictor v2 tests (the frozen combiner). Synthetic data only: no answers, no model calls. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  learnV2,
  newV2Learner,
  predictV2,
  prequentialV2,
  v2Features,
  V2_LEARNING_RATE,
  V2_OPTION_ORDER,
  V2_PRIOR,
  V2_PRIOR_STRENGTH,
  V2_TARGET,
  type V2Decision,
  type V2ScoredDecision,
  type V2Spec,
} from './index.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const spec = JSON.parse(readFileSync(join(evalDir, 'choice-predictor-v2.json'), 'utf8')) as V2Spec
const set = JSON.parse(readFileSync(join(evalDir, 'choice-scenarios-v2.json'), 'utf8')) as { categories: Record<string, string>; scenarios: Array<{ id: string; category: string; options: Record<string, string> }> }
const oldSet = JSON.parse(readFileSync(join(evalDir, 'choice-scenarios.json'), 'utf8')) as { scenarios: Array<{ situation: string }> }

const decision = (id: string, modelPick: string | null, category = 'tradeoff'): V2Decision => ({ id, category, options: ['a', 'b', 'c', 'ask'], annotation: spec.annotations[id] ?? synthetic, modelPick })
// A synthetic decision: a and b are extremes, c is the compromise.
const synthetic = { a: { loads: { risk: ['right', 1] } }, b: { loads: { risk: ['left', 1] } }, c: { compromise: true, loads: { risk: ['right', 0.5] } } } as V2Decision['annotation']

test('the frozen v2 spec is unchanged (edit means a new version, not a silent change)', () => {
  // Hashes the parsed JSON, so formatting and line endings don't matter.
  assert.equal(createHash('sha256').update(JSON.stringify(spec)).digest('hex'), FROZEN_V2_SHA256)
  assert.equal(spec.version, 2)
  assert.equal(spec.frozenAt, '2026-09-26')
})

test('the code uses exactly the frozen spec values', () => {
  assert.deepEqual({ ...V2_PRIOR }, spec.method.prior)
  assert.equal(spec.method.priorDefault, 0)
  assert.equal(V2_LEARNING_RATE, spec.method.learningRate)
  assert.equal(V2_PRIOR_STRENGTH, spec.method.priorStrength)
  assert.deepEqual([...V2_OPTION_ORDER], spec.method.optionOrder)
  assert.deepEqual({ ...V2_TARGET }, spec.method.scoring.target)
  const s = newV2Learner()
  assert.deepEqual(s.weights, { model: 1.5 })
})

test('every v2 scenario has an annotation and valid option ids; the set covers all 9 categories, 3–4 each', () => {
  assert.equal(set.scenarios.length, 30)
  const counts: Record<string, number> = {}
  set.scenarios.forEach((s, i) => {
    assert.equal(s.id, `cs2-${String(i + 1).padStart(2, '0')}`)
    assert.ok(s.category in set.categories, `${s.id}: unknown category ${s.category}`)
    counts[s.category] = (counts[s.category] ?? 0) + 1
    const ids = Object.keys(s.options)
    for (const id of ids) assert.ok(V2_OPTION_ORDER.includes(id), `${s.id}: option id ${id}`)
    const ann = spec.annotations[s.id]
    assert.ok(ann, `${s.id} has no annotation`)
    assert.deepEqual(Object.keys(ann!).sort(), ids.filter((id) => id !== 'ask').sort(), `${s.id}: annotation ids must match the action options`)
    for (const o of Object.values(ann!)) for (const [dim, [pole, w]] of Object.entries(o.loads ?? {})) {
      assert.ok(['horizon', 'risk', 'reputation', 'customer', 'relationships'].includes(dim), `${s.id}: dimension ${dim}`)
      assert.ok((pole === 'left' || pole === 'right') && w > 0 && w <= 1, `${s.id}: load ${dim}`)
    }
  })
  assert.deepEqual(Object.keys(counts).sort(), Object.keys(set.categories).sort())
  for (const [c, n] of Object.entries(counts)) assert.ok(n >= 3 && n <= 4, `${c}: ${n}`)
  assert.equal(Object.keys(spec.annotations).length, 30)
  // Fresh: no situation is reused from set v1.
  const old = new Set(oldSet.scenarios.map((s) => s.situation))
  for (const s of set.scenarios as Array<{ situation?: string }>) assert.ok(!old.has(s.situation!))
})

test('features: model, ask, per-category ask, compromise, practical and dimension loads', () => {
  const f = Object.fromEntries(v2Features({ id: 'x', category: 'autonomy', options: ['ask', 'c', 'a', 'b'], annotation: { a: {}, b: { loads: { risk: ['left', 1] } }, c: { compromise: true } }, modelPick: 'ask' }).map((o) => [o.id, o.features]))
  assert.deepEqual(f.a, { practical: 1 })
  assert.deepEqual(f.b, { 'dim.risk': -1 })
  assert.deepEqual(f.c, { compromise: 1 })
  assert.deepEqual(f.ask, { ask: 1, 'cat.autonomy.ask': 1, model: 1 })
  // Frozen option order regardless of input order.
  assert.deepEqual(v2Features({ id: 'x', category: 'autonomy', options: ['ask', 'c', 'a', 'b'], modelPick: null }).map((o) => o.id), ['a', 'b', 'c', 'ask'])
  assert.throws(() => v2Features({ id: 'x', category: 'autonomy', options: ['a', 'b'], modelPick: 'c' }), /not among the options/)
})

test('with no evidence, the model pick wins on every v2 scenario, whichever option it is', () => {
  const s = newV2Learner()
  for (const sc of set.scenarios) for (const pick of Object.keys(sc.options)) {
    const d: V2Decision = { id: sc.id, category: sc.category, options: Object.keys(sc.options), annotation: spec.annotations[sc.id], modelPick: pick }
    const p = predictV2(s, d)
    assert.equal(p.choice, pick, `${sc.id} pick ${pick}`)
    assert.ok(Math.abs(p.probability - Math.exp(1.5) / (Math.exp(1.5) + 3)) < 1e-9)
  }
  // No pick and no evidence: all options tie, so the earliest (a) wins.
  assert.equal(predictV2(s, decision('cs2-01', null)).choice, 'a')
})

test('a provider who consistently overrides the model toward the compromise is learned', () => {
  const picks = ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']
  const decisions: V2ScoredDecision[] = picks.map((pick, i) => ({ ...decision(`d${i}`, pick), chosen: 'c' }))
  const r = prequentialV2(decisions)
  assert.equal(r.rows[0]!.predicted, 'a', 'the first prediction follows the model')
  assert.equal(r.rows[0]!.correct, false)
  // After a few overrides the learner predicts the compromise despite the model.
  assert.ok(r.rows.slice(4).every((row) => row.predicted === 'c'), JSON.stringify(r.rows.map((x) => x.predicted)))
  assert.ok(r.final.weights.compromise! > 0.5)
  assert.ok(r.final.weights.model! < 1.5)
  assert.equal(r.modelAlone.correct, 0)
  assert.ok(r.accuracy > r.modelAlone.accuracy)
})

test('a provider who never chooses "ask" in one category lowers that category’s ask term only', () => {
  let s = newV2Learner()
  for (let i = 0; i < 5; i++) s = learnV2(s, decision(`d${i}`, 'ask', 'autonomy'), 'a')
  assert.ok(s.weights['cat.autonomy.ask']! < 0)
  assert.equal(s.weights['cat.ambiguity.ask'] ?? 0, 0)
})

test('prequential never uses an answer before predicting it', () => {
  const answers = ['b', 'c', 'c', 'ask', 'a', 'c', 'b', 'c']
  const decisions: V2ScoredDecision[] = answers.map((chosen, i) => ({ ...decision(`d${i}`, i % 2 ? 'a' : 'b', i % 3 ? 'tradeoff' : 'autonomy'), chosen }))
  const r = prequentialV2(decisions)
  // Replay by hand: each prediction must equal the one made from earlier answers only.
  let s = newV2Learner()
  decisions.forEach((d, i) => {
    assert.equal(r.rows[i]!.predicted, predictV2(s, d).choice, `row ${i}`)
    s = learnV2(s, d, d.chosen)
  })
  // Changing an answer never changes the prediction for that decision or any earlier one.
  for (let k = 0; k < decisions.length; k++) {
    const flipped = decisions.map((d, i) => (i === k ? { ...d, chosen: d.chosen === 'a' ? 'ask' : 'a' } : d))
    const r2 = prequentialV2(flipped)
    for (let i = 0; i <= k; i++) assert.equal(r2.rows[i]!.predicted, r.rows[i]!.predicted, `flip ${k}, row ${i}`)
  }
  assert.equal(r.final.observations, decisions.length)
})

test('scoring: chance, target and per-category breakdown', () => {
  const decisions: V2ScoredDecision[] = ['a', 'b', 'c', 'a'].map((pick, i) => ({ ...decision(`d${i}`, pick, i < 2 ? 'drift' : 'spirit'), chosen: pick }))
  const r = prequentialV2(decisions)
  assert.equal(r.correct, 4)
  assert.equal(r.chance, 0.25)
  assert.equal(r.timesChance, 4)
  assert.equal(r.meetsTarget, true)
  assert.deepEqual(r.byCategory, { drift: { decisions: 2, correct: 2, accuracy: 1 }, spirit: { decisions: 2, correct: 2, accuracy: 1 } })
  assert.equal(prequentialV2([]).meetsTarget, false)
  assert.throws(() => prequentialV2([{ ...decision('d', 'a'), chosen: 'z' }]), /not among the options/)
})

const FROZEN_V2_SHA256 = '6558f5f238f9462cc19e1ad6d0da5bb44b465e3339c8b4ea51a6da3057b956a6'
