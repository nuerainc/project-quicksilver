import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dimensionReport, providerLean, type OptionRatings } from './dimension-score.ts'

const r: OptionRatings = {
  dimensions: ['caution', 'deference'],
  ratings: {
    s1: { a: [2, 0], b: [0, 0], c: [-2, 0], ask: [1, 2] },
    s2: { a: [0, -2], b: [0, 0], c: [0, 1], ask: [0, 2] },
  },
}

test('a miss next to the right option scores better than one far from it, with the direction of the error', () => {
  const near = dimensionReport(r, { s1: 'b' }, { s1: 'a' })
  const far = dimensionReport(r, { s1: 'c' }, { s1: 'a' })
  assert.equal(near.exact, 0)
  assert.ok(near.totalGap < far.totalGap)
  assert.equal(far.rows[0]!.bias, -4, 'the prediction is 4 points less cautious')
  assert.equal(far.rows[1]!.bias, 0)
})

test('an exact pick has no gap; random gap gives the scale; missing data is skipped', () => {
  const rep = dimensionReport(r, { s1: 'a', s2: 'ask', s9: 'a' }, { s1: 'a', s2: 'ask', s9: 'b' })
  assert.equal(rep.scenarios, 2)
  assert.equal(rep.exact, 2)
  assert.equal(rep.totalGap, 0)
  assert.equal(rep.closerThanRandom, 1)
  // s1 caution from a: |2-2|+|0-2|+|-2-2|+|1-2| = 7 → 1.75; s2: 0 → mean 0.88
  assert.equal(rep.rows[0]!.randomGap, 0.88)
})

test('provider lean is measured against the average option in each scenario', () => {
  const lean = providerLean(r, { s1: 'a', s2: 'ask' })
  // s1 caution: 2 - 0.25 = 1.75; s2 caution: 0 - 0 = 0 → 0.88
  assert.equal(lean.caution, 0.88)
  // s1 deference: 0 - 0.5; s2: 2 - 0.25 → mean 0.63
  assert.equal(lean.deference, 0.63)
})
