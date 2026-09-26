/** Intent profile v2 (situational) tests. Synthetic answers only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  profileV2AsExamples,
  profileV2ChoiceKind,
  profileV2ItemDimensions,
  profileV2OptionIds,
  profileV2OptionLoad,
  scoreProfileV2,
  type ProfileV2Answer,
  type ProfileV2Instrument,
  type ProfileV2Item,
  type ProfileV2OptionId,
} from './index.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const read = (f: string) => JSON.parse(readFileSync(join(evalDir, f), 'utf8'))
const instrument = read('intent-profile-v2.json') as ProfileV2Instrument
const dimIds = instrument.dimensions.map((d) => d.id)
const byId = new Map(instrument.items.map((i) => [i.id, i]))

type Kind = 'left' | 'right' | 'middle' | 'ask'
/** The option of an item whose kind on its primary dimension is `kind`. */
function optionOfKind(item: ProfileV2Item, kind: Kind): ProfileV2OptionId {
  const id = profileV2OptionIds(item).find((o) => profileV2ChoiceKind(item, o) === kind || (kind === 'ask' && item.options[o]!.ask))
  assert.ok(id, `${item.id} has a ${kind} option`)
  return id
}

/** Every item answered toward one pole of its primary dimension. */
function answerByPrimary(lean: Record<string, 'left' | 'right'>, confidence = 'sure'): Record<string, ProfileV2Answer> {
  const out: Record<string, ProfileV2Answer> = {}
  for (const i of instrument.items) out[i.id] = { choice: optionOfKind(i, lean[i.primary]!), confidence }
  return out
}

const LEAN = { horizon: 'right', risk: 'left', reputation: 'left', customer: 'left', autonomy: 'left', relationships: 'left' } as const

// ── instrument validity ──────────────────────────────────────────────────────

test('instrument v2: 24 items, 20 dilemmas plus 4 mirrors, order covers every item once', () => {
  assert.equal(instrument.version, 2)
  assert.equal(instrument.items.length, 24)
  assert.equal(instrument.items.filter((i) => i.mirrors).length, 4)
  assert.deepEqual([...instrument.order].sort(), instrument.items.map((i) => i.id).sort())
  assert.equal(new Set(instrument.items.map((i) => i.id)).size, 24)
  assert.ok((instrument.estimatedMinutes ?? 99) <= 10)
  assert.deepEqual(dimIds, ['horizon', 'risk', 'reputation', 'customer', 'autonomy', 'relationships'])
})

test('every item has three options: two opposite poles on its primary dimension and one compromise; ask is optional', () => {
  for (const i of instrument.items) {
    assert.ok(dimIds.includes(i.primary), i.id)
    for (const k of ['a', 'b', 'c'] as const) assert.ok(i.options[k]?.text, `${i.id}.${k}`)
    assert.deepEqual(Object.keys(i.options).filter((k) => !['a', 'b', 'c', 'ask'].includes(k)), [], i.id)
    const three = (['a', 'b', 'c'] as const).map((k) => profileV2ChoiceKind(i, k))
    assert.equal(three.filter((k) => k === 'middle').length, 1, `${i.id} has one compromise`)
    assert.deepEqual(three.filter((k) => k !== 'middle').sort(), ['left', 'right'], `${i.id} poles`)
    if (i.options.ask) {
      assert.equal(i.options.ask.ask, true, i.id)
      assert.equal(i.options.ask.compromise, false, i.id)
    }
    for (const id of profileV2OptionIds(i)) {
      const o = i.options[id]!
      assert.equal(typeof o.compromise, 'boolean')
      assert.equal(typeof o.ask, 'boolean')
      if (o.ask) assert.ok(profileV2OptionLoad(i, id, 'autonomy') > 0, `${i.id}.${id}: ask loads "ask me first"`)
      for (const t of o.tags) {
        assert.ok(dimIds.includes(t.dimension), `${i.id}.${id} tag ${t.dimension}`)
        assert.ok(t.pole === 'left' || t.pole === 'right')
        assert.ok(t.weight > 0 && t.weight <= 1)
      }
    }
  }
})

test('letters carry no pattern: the middle and each pole sit on every letter, and always picking "a" reads weak', () => {
  for (const kind of ['left', 'right', 'middle'] as const) {
    for (const k of ['a', 'b', 'c'] as const) {
      const n = instrument.items.filter((i) => profileV2ChoiceKind(i, k) === kind).length
      assert.ok(n >= 5 && n <= 11, `${kind} on ${k}: ${n}`)
    }
  }
  const answers: Record<string, ProfileV2Answer> = {}
  for (const i of instrument.items) answers[i.id] = { choice: 'a', confidence: 'sure' }
  const r = scoreProfileV2(instrument, answers)
  assert.ok(r.behaviors.consistency.rate! < 1)
  for (const d of r.dimensions) assert.ok(d.confidence <= 5, `${d.dimension} ${d.confidence}`)
})

test('coverage: each dimension is the primary of at least 3 items and touched by at least 4; several items touch two', () => {
  for (const d of dimIds) {
    assert.ok(instrument.items.filter((i) => i.primary === d && !i.mirrors).length >= 3, `${d} primary`)
    assert.ok(instrument.items.filter((i) => profileV2ItemDimensions(i, dimIds).includes(d)).length >= 4, `${d} touched`)
  }
  assert.ok(instrument.items.filter((i) => profileV2ItemDimensions(i, dimIds).length >= 2).length >= 8)
  const count = (f: (i: ProfileV2Item) => boolean) => instrument.items.filter(f).length
  const any = (i: ProfileV2Item, k: 'requirementsFirst' | 'protectsAtCost' | 'ask') => profileV2OptionIds(i).some((id) => i.options[id]![k])
  assert.ok(count((i) => any(i, 'ask')) >= 6, 'ask offered')
  assert.ok(count((i) => any(i, 'requirementsFirst')) >= 3, 'requirements-first offered')
  assert.ok(count((i) => any(i, 'protectsAtCost')) >= 5, 'protect-at-cost offered')
  assert.deepEqual([...new Set(instrument.items.map((i) => i.domain))].sort(), ['farm', 'online', 'retail', 'services', 'trades'])
})

test('mirrors restate their item in other words, rearrange the letters, and come at least 10 items later', () => {
  const pos = new Map(instrument.order.map((id, n) => [id, n]))
  for (const m of instrument.items.filter((i) => i.mirrors)) {
    const o = byId.get(m.mirrors!)!
    assert.ok(o && !o.mirrors, m.id)
    assert.equal(m.primary, o.primary)
    assert.notEqual(m.situation, o.situation)
    assert.ok(pos.get(m.id)! - pos.get(o.id)! >= 10, `${m.id} spacing`)
    const kinds = (i: ProfileV2Item) => (['a', 'b', 'c'] as const).map((k) => profileV2ChoiceKind(i, k)).join()
    assert.notEqual(kinds(m), kinds(o), `${m.id} rearranges the options`)
  }
})

test('items are short and written fresh, not copied from the choice scenarios', () => {
  const grams = (s: string) => {
    const w = s.toLowerCase().replace(/[^a-z0-9$% ]/g, ' ').split(/\s+/).filter(Boolean)
    return new Set(w.slice(0, -5).map((_, n) => w.slice(n, n + 6).join(' ')))
  }
  const scenarioGrams = new Set<string>()
  for (const f of ['choice-scenarios.json', 'choice-scenarios-v2.json']) for (const s of read(f).scenarios) for (const g of grams(`${s.situation} ${Object.values(s.options).join(' ')}`)) scenarioGrams.add(g)
  for (const i of instrument.items) {
    const sentences = i.situation.split(/(?<=[.?!])\s+/).length
    assert.ok(sentences >= 2 && sentences <= 3, `${i.id}: ${sentences} sentences`)
    const text = `${i.situation} ${profileV2OptionIds(i).map((id) => i.options[id]!.text).join(' ')}`
    for (const g of grams(text)) assert.ok(!scenarioGrams.has(g), `${i.id} repeats "${g}"`)
  }
})

// ── scoring ──────────────────────────────────────────────────────────────────

test('consistent answers give clear, high-confidence readings, including secondary loads', () => {
  const r = scoreProfileV2(instrument, answerByPrimary(LEAN))
  assert.equal(r.complete, true)
  assert.deepEqual(r.missing, [])
  const d = (id: string) => r.dimensions.find((x) => x.dimension === id)!
  assert.equal(d('horizon').score, 1)
  assert.equal(d('horizon').lean, 'Long term (clear)')
  assert.equal(d('horizon').confidence, 10)
  assert.ok(d('horizon').items > instrument.items.filter((i) => i.primary === 'horizon').length, 'secondary loads count')
  assert.equal(d('risk').lean, 'Safe (clear)')
  assert.equal(d('customer').lean, 'Customer interest (clear)')
  assert.equal(d('customer').confidence, 10)
  // Autonomy: the three extra-ask items read "decide yourself" at half weight when the provider acts.
  assert.equal(d('autonomy').score, round((4 * -1 + 3 * -0.5) / 7))
  assert.equal(d('autonomy').lean, 'Decide yourself (clear)')
  assert.deepEqual(r.behaviors.consistency, { rate: 1, chosen: 4, of: 4 })
  assert.equal(r.behaviors.compromise.rate, 0)
  assert.equal(r.behaviors.ask.rate, 0)
})

test('confidence of the answer weights the score (sure 1, leaning 0.5, coin flip 0.25)', () => {
  const tiny: ProfileV2Instrument = {
    version: 2,
    dimensions: [{ id: 'horizon', left: 'Short term', right: 'Long term' }],
    order: ['x1', 'x2', 'x3'],
    items: ['x1', 'x2', 'x3'].map((id) => ({
      id, domain: 'farm', primary: 'horizon', situation: `Situation ${id}. More.`, decision: 'What now?',
      options: {
        a: { text: 'Now', tags: [{ dimension: 'horizon', pole: 'left', weight: 1 }], compromise: false, ask: false },
        b: { text: 'Later', tags: [{ dimension: 'horizon', pole: 'right', weight: 1 }], compromise: false, ask: false },
        c: { text: 'Some of each', tags: [], compromise: true, ask: false },
      },
    })),
  }
  const r1 = scoreProfileV2(tiny, { x1: { choice: 'b', confidence: 'sure' }, x2: { choice: 'a', confidence: 'leaning' }, x3: { choice: 'a', confidence: 'coin' } })
  const h = r1.dimensions[0]!
  assert.equal(h.score, round((1 - 0.5 - 0.25) / 1.75))
  assert.equal(h.agreement, round(2 / 3))
  assert.equal(h.lean, 'Balanced', 'a weighted 0.14 is under the 0.2 threshold')
  // One-sidedness 1/3 → 10 × (0.25 + 0.75/3) = 5, all items answered, no mirror on this dimension.
  assert.equal(h.confidence, 5)
  const r2 = scoreProfileV2(tiny, { x1: { choice: 'b', confidence: 'coin' }, x2: { choice: 'b', confidence: 'coin' }, x3: { choice: 'c', confidence: 'sure' } })
  assert.equal(r2.dimensions[0]!.score, round(0.5 / 1.5))
  assert.equal(r2.dimensions[0]!.agreement, round(2 / 3), 'the middle answer counts against agreement')
  assert.equal(r2.dimensions[0]!.sided, 2)
  assert.deepEqual(r2.behaviors.compromise, { rate: round(1 / 3), chosen: 1, of: 3 })
})

test('always choosing the middle reads Balanced with low confidence, a compromise rate of 1, and consistent mirrors', () => {
  const answers: Record<string, ProfileV2Answer> = {}
  for (const i of instrument.items) answers[i.id] = { choice: optionOfKind(i, 'middle'), confidence: 'sure' }
  const r = scoreProfileV2(instrument, answers)
  for (const d of r.dimensions) {
    // One middle option carries a light secondary tag, so a score may sit just off 0.
    assert.ok(Math.abs(d.score) < 0.2, d.dimension)
    assert.equal(d.lean, 'Balanced')
    assert.ok(d.sided <= 1)
    assert.ok(d.confidence <= 3, d.dimension)
  }
  assert.deepEqual(r.behaviors.compromise, { rate: 1, chosen: 24, of: 24 })
  assert.equal(r.behaviors.consistency.rate, 1)
})

test('a mirrored pair that disagrees caps that dimension at 3 and lowers consistency', () => {
  const answers = answerByPrimary(LEAN)
  const m = byId.get('p2-m2')!
  answers[m.id] = { choice: optionOfKind(m, 'right'), confidence: 'sure' }
  const r = scoreProfileV2(instrument, answers)
  const c = r.dimensions.find((d) => d.dimension === m.primary)!
  assert.equal(c.consistent, false)
  assert.ok(c.confidence <= 3)
  assert.deepEqual(r.behaviors.consistency, { rate: 0.75, chosen: 3, of: 4 })
  // A pole against the middle also counts as a disagreement.
  answers[m.id] = { choice: optionOfKind(m, 'middle'), confidence: 'sure' }
  assert.equal(scoreProfileV2(instrument, answers).behaviors.consistency.rate, 0.75)
})

test('ask, requirements-first and protect-at-cost rates count only items that offered the option', () => {
  const answers = answerByPrimary(LEAN)
  const asks = instrument.items.filter((i) => profileV2OptionIds(i).some((id) => i.options[id]!.ask))
  for (const i of asks) answers[i.id] = { choice: optionOfKind(i, 'ask'), confidence: 'sure' }
  const r = scoreProfileV2(instrument, answers)
  assert.deepEqual(r.behaviors.ask, { rate: 1, chosen: asks.length, of: asks.length })
  assert.equal(r.dimensions.find((d) => d.dimension === 'autonomy')!.lean, 'Ask me first (clear)')

  const reqItems = instrument.items.filter((i) => profileV2OptionIds(i).some((id) => i.options[id]!.requirementsFirst))
  const protItems = instrument.items.filter((i) => profileV2OptionIds(i).some((id) => i.options[id]!.protectsAtCost))
  const a2: Record<string, ProfileV2Answer> = {}
  for (const i of reqItems) a2[i.id] = { choice: profileV2OptionIds(i).find((id) => i.options[id]!.requirementsFirst)!, confidence: 'leaning' }
  const firstProt = protItems.find((i) => !a2[i.id])!
  a2[firstProt.id] = { choice: profileV2OptionIds(firstProt).find((id) => i2(firstProt, id))!, confidence: 'sure' }
  const r2 = scoreProfileV2(instrument, a2)
  assert.deepEqual(r2.behaviors.requirementsFirst, { rate: 1, chosen: reqItems.length, of: reqItems.length })
  assert.equal(r2.behaviors.protectsAtCost.chosen, 1)
  assert.equal(r2.behaviors.protectsAtCost.of, protItems.filter((i) => a2[i.id]).length)
  assert.equal(r2.complete, false)

  function i2(i: ProfileV2Item, id: ProfileV2OptionId) { return !!i.options[id]!.protectsAtCost }
})

test('partial and invalid answers: invalid ones are ignored and reported missing; empty rates are null', () => {
  const noAsk = instrument.items.find((i) => !i.options.ask)!
  const r = scoreProfileV2(instrument, {
    [noAsk.id]: { choice: 'ask', confidence: 'sure' },
    'p2-01': { choice: 'b' },
    'p2-02': { choice: 'z', confidence: 'sure' },
  })
  assert.equal(r.missing.length, 24)
  assert.equal(r.behaviors.compromise.rate, null)
  assert.equal(r.behaviors.consistency.rate, null)
  for (const d of r.dimensions) {
    assert.equal(d.lean, 'Not answered')
    assert.equal(d.confidence, 0)
  }
  const r2 = scoreProfileV2(instrument, { 'p2-01': { choice: 'b', confidence: 'sure' } })
  assert.equal(r2.missing.length, 23)
  assert.ok(r2.dimensions.find((d) => d.dimension === 'horizon')!.confidence <= 3)
})

// ── worked examples ──────────────────────────────────────────────────────────

test('profileV2AsExamples renders answered items as worked examples, in instrument order, without tags', () => {
  const answers: Record<string, ProfileV2Answer> = {
    'p2-01': { choice: 'c', confidence: 'leaning', note: '  small is fine if it is priced honestly  ' },
    'p2-05': { choice: 'a', confidence: 'sure' },
    'p2-m1': { choice: 'a', confidence: 'coin' },
    'p2-10': { choice: 'ask', confidence: 'sure', note: 'x'.repeat(400) },
    'p2-02': { choice: 'b' },
  }
  const text = profileV2AsExamples(instrument, answers)
  const lines = text.split('\n')
  assert.match(lines[0]!, /decisions this same provider made/)
  const p01 = byId.get('p2-01')!
  assert.ok(text.includes(`- Situation: ${p01.situation} Decision: ${p01.decision}`))
  assert.ok(text.includes(`  Options: a) ${p01.options.a.text} | b) ${p01.options.b.text} | c) ${p01.options.c.text}`))
  assert.ok(text.includes('  They chose: c (leaning). Their note: "small is fine if it is priced honestly"'))
  assert.ok(text.includes(`ask) ${byId.get('p2-10')!.options.ask!.text}`))
  assert.ok(text.includes(`They chose: ask (sure). Their note: "${'x'.repeat(300)}"`))
  assert.ok(!text.includes('x'.repeat(301)))
  assert.ok(!text.includes(byId.get('p2-02')!.situation), 'an answer without confidence is skipped')
  assert.equal(lines.filter((l) => l.startsWith('- Situation:')).length, 4)
  assert.ok(!/pole|weight|compromise|requirementsFirst|protectsAtCost/.test(text), 'designer tags never shown')
  // Instrument order: p2-05 comes first in the order, so it is the first example.
  assert.ok(text.indexOf(byId.get('p2-05')!.situation) < text.indexOf(p01.situation))
  assert.ok(text.indexOf(p01.situation) < text.indexOf(byId.get('p2-m1')!.situation))
  const skip = profileV2AsExamples(instrument, answers, { skipMirrors: true, maxNote: 10 })
  assert.ok(!skip.includes(byId.get('p2-m1')!.situation))
  assert.ok(skip.includes(`"${'x'.repeat(10)}"`))
  assert.equal(profileV2AsExamples(instrument, {}), '')
})

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}
