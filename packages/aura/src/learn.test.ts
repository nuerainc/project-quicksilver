/** Learning choice predictor tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { learn, newLearner, predictOption, prequential, probabilities, scenarioFeatures, type ChoiceOption, type LearnerState, type PredictorSpec } from './index.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const spec = JSON.parse(readFileSync(join(evalDir, 'choice-predictor-v1.json'), 'utf8')) as PredictorSpec

const bold: ChoiceOption = { id: 'a', features: { 'dim.risk': 1 } }
const safe: ChoiceOption = { id: 'b', features: { 'dim.risk': -1 } }
const middle: ChoiceOption = { id: 'c', features: { 'dim.risk': 0.5, compromise: 1 } }

test('probabilities sum to 1 and follow the weights', () => {
  const p = probabilities(newLearner({ 'dim.risk': 1 }), [bold, safe])
  assert.ok(Math.abs(p.a! + p.b! - 1) < 1e-9)
  assert.ok(p.a! > p.b!)
})

test('ties go to the earliest option', () => {
  assert.equal(predictOption(newLearner({}), [safe, bold]).choice, 'b')
})

test('learning moves the model toward what the provider actually chose', () => {
  let s = newLearner({ 'dim.risk': 1 })
  assert.equal(predictOption(s, [bold, safe]).choice, 'a')
  for (let i = 0; i < 5; i++) s = learn(s, [bold, safe], 'b')
  assert.equal(predictOption(s, [bold, safe]).choice, 'b')
  assert.equal(s.observations, 5)
})

test('a provider who picks the middle option teaches the compromise feature', () => {
  let s = newLearner({ 'dim.risk': 1 })
  for (let i = 0; i < 6; i++) s = learn(s, [bold, safe, middle], 'c')
  assert.ok((s.weights.compromise ?? 0) > 0.5)
  assert.equal(predictOption(s, [bold, safe, middle]).choice, 'c')
})

test('learn is pure and rejects a choice that was not offered', () => {
  const s = newLearner({ 'dim.risk': 1 })
  learn(s, [bold, safe], 'b')
  assert.deepEqual(s.weights, { 'dim.risk': 1 })
  assert.throws(() => learn(s, [bold, safe], 'z'), /not among the options/)
})

test('the prior pulls weights back when there is no evidence either way', () => {
  // Choosing between two identical options carries no information; only the prior pull acts.
  const same1: ChoiceOption = { id: 'x', features: { 'dim.risk': 0 } }
  const same2: ChoiceOption = { id: 'y', features: { 'dim.risk': 0 } }
  let s: LearnerState = { ...newLearner({ 'dim.risk': 1 }), weights: { 'dim.risk': 3 } }
  s = learn(s, [same1, same2], 'x')
  assert.ok(s.weights['dim.risk']! < 3 && s.weights['dim.risk']! > 1)
})

test('prequential scores each decision before learning from it', () => {
  const decisions = [
    { id: 'd1', options: [bold, safe], chosen: 'b' },
    { id: 'd2', options: [bold, safe], chosen: 'b' },
    { id: 'd3', options: [bold, safe], chosen: 'b' },
  ]
  const r = prequential(newLearner({ 'dim.risk': 1 }), decisions)
  // The first prediction was made from the prior alone, so it must be wrong here.
  assert.equal(r.rows[0]!.predicted, 'a')
  assert.equal(r.rows[0]!.correct, false)
  assert.equal(r.decisions, 3)
  assert.equal(r.final.observations, 3)
  assert.ok(r.meanProbabilityOfActual > 0 && r.meanProbabilityOfActual < 1)
})

test('scenario features: ask, compromise and practical options', () => {
  const s = Object.entries(spec.annotations).find(([, a]) => a.covered && Object.values(a.options ?? {}).some((o) => Object.values(o as Record<string, [string, number]>).some(([, w]) => w < 1)))
  assert.ok(s, 'the spec has at least one partial-weight option')
  const [id, ann] = s!
  const ids = [...Object.keys(ann.options ?? {}), 'ask']
  const opts = scenarioFeatures(spec, id, ids)
  assert.deepEqual(opts.find((o) => o.id === 'ask')!.features, { ask: 1 })
  assert.ok(opts.some((o) => o.features.compromise === 1))
  const uncovered = scenarioFeatures(spec, 'no-such-scenario', ['a'])
  assert.deepEqual(uncovered[0]!.features, { practical: 1 })
})
