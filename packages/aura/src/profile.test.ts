/** Intent profile scoring tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scoreProfile, type ProfileAnswer, type ProfileInstrument } from './index.ts'

const instrument = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'intent-profile-v1.json'), 'utf8')) as ProfileInstrument

/** Answer every item toward one pole per dimension. */
function answerAll(lean: Record<string, 'left' | 'right'>, strength: 1 | 2 = 2): Record<string, ProfileAnswer> {
  const out: Record<string, ProfileAnswer> = {}
  for (const i of instrument.items) out[i.id] = { choice: i.a.pole === lean[i.dimension] ? 'a' : 'b', strength }
  return out
}

test('instrument v1: six dimensions, five items each plus one mirror, every item has one option per pole', () => {
  assert.equal(instrument.dimensions.length, 6)
  for (const d of instrument.dimensions) {
    const items = instrument.items.filter((i) => i.dimension === d.id)
    assert.equal(items.filter((i) => !i.mirrors).length, 5, d.id)
    assert.equal(items.filter((i) => i.mirrors).length, 1, d.id)
  }
  for (const i of instrument.items) assert.deepEqual([i.a.pole, i.b.pole].sort(), ['left', 'right'], i.id)
  assert.deepEqual([...instrument.order].sort(), instrument.items.map((i) => i.id).sort())
  const pos = new Map(instrument.order.map((id, n) => [id, n]))
  for (const m of instrument.items.filter((i) => i.mirrors)) assert.ok(pos.get(m.id)! - pos.get(m.mirrors!)! >= 12, `${m.id} is spaced from ${m.mirrors}`)
  // Poles are split between options a and b, so always picking "a" gives no clear profile.
  const aRight = instrument.items.filter((i) => i.a.pole === 'right').length
  assert.ok(aRight > 10 && aRight < 26)
})

test('consistent answers give clear, high-confidence readings', () => {
  const r = scoreProfile(instrument, answerAll({ horizon: 'right', risk: 'left', reputation: 'left', customer: 'left', autonomy: 'right', relationships: 'left' }))
  assert.equal(r.complete, true)
  assert.equal(r.consistency, 1)
  const h = r.dimensions.find((d) => d.dimension === 'horizon')!
  assert.equal(h.score, 1)
  assert.equal(h.lean, 'Long term (clear)')
  assert.equal(h.confidence, 'high')
  assert.equal(r.dimensions.find((d) => d.dimension === 'risk')!.lean, 'Safe (clear)')
})

test('a mirrored pair that disagrees lowers confidence instead of producing a firm number', () => {
  const answers = answerAll({ horizon: 'right', risk: 'left', reputation: 'left', customer: 'left', autonomy: 'right', relationships: 'left' }, 1)
  const m = instrument.items.find((i) => i.id === 'm-h')!
  answers['m-h'] = { choice: m.a.pole === 'left' ? 'a' : 'b', strength: 1 }
  const r = scoreProfile(instrument, answers)
  const h = r.dimensions.find((d) => d.dimension === 'horizon')!
  assert.equal(h.consistent, false)
  assert.equal(h.confidence, 'low')
  assert.ok(r.consistency! < 1)
})

test('always picking the first option does not produce a strong profile', () => {
  const answers: Record<string, ProfileAnswer> = {}
  for (const i of instrument.items) answers[i.id] = { choice: 'a', strength: 2 }
  const r = scoreProfile(instrument, answers)
  assert.ok(r.consistency! < 1, 'mirrors swap the option order, so a pattern shows up as inconsistency')
  assert.ok(r.dimensions.some((d) => d.confidence === 'low'))
})

test('partial answers are scored and the rest reported missing', () => {
  const r = scoreProfile(instrument, { h1: { choice: 'a', strength: 1 } })
  assert.equal(r.complete, false)
  assert.equal(r.missing.length, instrument.items.length - 1)
  assert.equal(r.dimensions.find((d) => d.dimension === 'horizon')!.confidence, 'low')
})
