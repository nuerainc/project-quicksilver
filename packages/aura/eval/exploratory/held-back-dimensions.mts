import { readFileSync } from 'node:fs'
import { answerValue, profileConfidence, scoreProfile } from '../../src/index.ts'
// Reads the eval files and two local answer files (kept out of the repo): data/aura/*.json
const B = process.env.AURA_DIR ?? '../../../../'
const j = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const inst = j(B + 'packages/aura/eval/intent-profile-v1.json')
const spec = j(B + 'packages/aura/eval/choice-predictor-v1.json')
const scen = j(B + 'packages/aura/eval/choice-scenarios.json').scenarios
const pAns = j(B + 'data/aura/profile-answers.json').answers
const actual: Record<string, string> = Object.fromEntries(Object.entries(j(B + 'data/aura/scenario-answers.json').answers).map(([k, v]: any) => [k, v.choice]))
const byId = Object.fromEntries(inst.items.map((i: any) => [i.id, i]))

// 1. Secondary readings of held-back dimensions from EXISTING profile items: item -> [dim, pole of option a].
const SECONDARY: Record<string, Array<[string, 'left' | 'right']>> = {
  h3: [['quality', 'left']], h5: [['quality', 'right']], p1: [['quality', 'left']], p2: [['quality', 'right']],
  r5: [['growth', 'left']], 'm-r': [['growth', 'right']], h2: [['growth', 'right']],
  r4: [['scale', 'right'], ['focus', 'left']], p4: [['scale', 'right']],
  r2: [['focus', 'left']], r1: [['focus', 'right']],
  e3: [['stakeholders', 'left']], p3: [['stakeholders', 'left'], ['giving', 'left']],
}
const NAMES: Record<string, [string, string]> = { quality: ['Speed', 'Quality'], growth: ['Stability', 'Growth'], scale: ['Independence', 'Scale'], focus: ['Focus', 'Spread out'], stakeholders: ['Owners only', 'Everyone it touches'], giving: ['Keep', 'Give back'], openness: ['Openness', 'Discretion'] }
const vals: Record<string, number[]> = {}
for (const [item, loads] of Object.entries(SECONDARY)) {
  const a = pAns[item]; if (!a) continue
  const mag = a.strength === 2 ? 1 : 0.5
  for (const [dim, poleA] of loads) {
    const pole = a.choice === 'a' ? poleA : poleA === 'left' ? 'right' : 'left'
    ;(vals[dim] ??= []).push((pole === 'right' ? 1 : -1) * mag)
  }
}
const profile = scoreProfile(inst, pAns)
const sig = new Map<string, number>(profile.dimensions.map((d) => [d.dimension, d.score * d.confidence / 10]))
console.log('Secondary readings from existing profile answers:')
for (const [dim, v] of Object.entries(vals)) {
  const score = v.reduce((x, y) => x + y, 0) / v.length
  const pos = v.filter((x) => x > 0).length, agree = Math.max(pos, v.length - pos) / v.length
  const conf = Math.min(profileConfidence(agree, v.length, 5, null), 6) // few items: capped at 6/10
  sig.set(dim, score * conf / 10)
  const [l, r] = NAMES[dim]!
  console.log(`  ${dim.padEnd(13)} ${Math.abs(score) < 0.2 ? 'Balanced' : score > 0 ? r : l} (score ${score.toFixed(2)}, ${v.length} items, confidence ${conf}/10)`)
}

// 2. Held-back dimensions tagged on scenario options (by what each option means).
const EXTRA: Record<string, Record<string, Record<string, [string, number]>>> = {
  'cs-01': { b: { stakeholders: ['left', 1] } },
  'cs-02': { a: { quality: ['right', 1] }, b: { quality: ['left', 1] }, c: { quality: ['right', 1] } },
  'cs-04': { a: { stakeholders: ['right', 1] } },
  'cs-05': { b: { quality: ['right', 1] }, c: { quality: ['left', 1] } },
  'cs-06': { a: { quality: ['right', 1] }, b: { quality: ['left', 1] } },
  'cs-07': { a: { scale: ['left', 1] }, b: { scale: ['right', 1] } },
  'cs-08': { b: { openness: ['left', 1] } },
  'cs-09': { c: { growth: ['right', 1], focus: ['right', 1] } },
  'cs-12': { a: { openness: ['left', 1], stakeholders: ['right', 1] } },
  'cs-14': { a: { quality: ['right', 1] } },
  'cs-16': { a: { quality: ['left', 1] }, b: { quality: ['right', 1] }, c: { quality: ['left', 0.5] } },
  'cs-21': { b: { growth: ['right', 1] }, c: { focus: ['right', 1] } },
  'cs-22': { a: { growth: ['left', 1] }, b: { growth: ['right', 1] } },
  'cs-23': { a: { openness: ['left', 1] }, b: { openness: ['right', 1] }, c: { openness: ['right', 0.5] } },
  'cs-24': { b: { giving: ['right', 1] }, c: { giving: ['right', 0.5] } },
  'cs-25': { a: { quality: ['left', 1] }, c: { quality: ['right', 1] } },
  'cs-26': { a: { quality: ['left', 1] }, b: { quality: ['right', 1] }, c: { quality: ['left', 0.5] } },
  'cs-28': { a: { quality: ['left', 1] }, b: { quality: ['right', 1] } },
  'cs-30': { a: { quality: ['left', 1] }, c: { quality: ['right', 1] } },
  'cs-32': { a: { openness: ['right', 1] }, b: { openness: ['left', 1] } },
  'cs-33': { a: { growth: ['right', 1], scale: ['right', 1] }, b: { growth: ['left', 1] }, c: { growth: ['right', 0.5] } },
  'cs-34': { b: { stakeholders: ['right', 1] }, c: { stakeholders: ['right', 0.5] } },
  'cs-37': { b: { stakeholders: ['right', 1] } },
  'cs-38': { a: { growth: ['left', 1] }, b: { growth: ['right', 1] }, c: { growth: ['right', 0.5] } },
}
function loads(s: any, o: string): Record<string, [string, number]> {
  if (o === 'ask') return { autonomy: ['right', 1] }
  const base = spec.annotations[s.id].covered ? { ...(spec.annotations[s.id].options[o] ?? {}) } : {}
  return { ...base, ...(EXTRA[s.id]?.[o] ?? {}), autonomy: base.autonomy ?? ['left', 1] }
}
const ORDER = ['a', 'b', 'c', 'ask']
const hasDims = (s: any) => ['a', 'b', 'c'].some((o) => Object.keys(loads(s, o)).some((d) => d !== 'autonomy'))
function predict(s: any, S: Map<string, number>, rule: 'sum' | 'least'): string | null {
  if (!hasDims(s)) return null
  const opts = ORDER.filter((o) => o in s.options)
  const per = Object.fromEntries(opts.map((o) => [o, Object.fromEntries(Object.entries(loads(s, o)).map(([d, [p, w]]) => [d, w * (p === 'right' ? 1 : -1) * (S.get(d) ?? 0)]))]))
  const dims = [...new Set(opts.flatMap((o) => Object.keys(per[o])))]
  const val = (o: string) => rule === 'sum' ? Object.values(per[o]).reduce((a: number, b: any) => a + b, 0) : Math.min(...dims.map((d) => per[o][d] ?? 0)) + 1e-3 * Object.values(per[o]).reduce((a: number, b: any) => a + b, 0)
  let best: string | null = null, bv = -Infinity
  for (const o of opts) { const v = val(o); if (v > bv + 1e-9) { bv = v; best = o } }
  return best
}
const score = (f: (s: any) => string | null) => { let r = 0, c = 0; for (const s of scen) { const p = f(s); if (p) c++; if (p === actual[s.id]) r++ } return `${r}/38 (${(100 * r / 38).toFixed(1)}%), ${c} covered` }
console.log('\nA. 12 dimensions, all readings from the PROFILE (no scenario answers used to set them):')
console.log('   linear sum      ', score((s) => predict(s, sig, 'sum')))
console.log('   least sacrifice ', score((s) => predict(s, sig, 'least')))

// 3. Leave-one-out: learn leanings from the other 37 scenario answers, predict the one left out.
function learned(exclude: string): Map<string, number> {
  const acc: Record<string, number[]> = {}
  for (const s of scen) {
    if (s.id === exclude || actual[s.id] === 'ask') continue
    const opts = ['a', 'b', 'c']
    const dims = new Set(opts.flatMap((o) => Object.keys(loads(s, o)).filter((d) => d !== 'autonomy')))
    for (const d of dims) {
      const v = (o: string) => { const l = loads(s, o)[d]; return l ? (l[0] === 'right' ? 1 : -1) * l[1] : 0 }
      const mean = opts.reduce((x, o) => x + v(o), 0) / 3
      const r = v(actual[s.id]!) - mean
      if (Math.abs(r) > 1e-9) (acc[d] ??= []).push(r)
    }
  }
  return new Map(Object.entries(acc).map(([d, v]) => [d, v.reduce((x, y) => x + y, 0) / v.length]))
}
console.log('\nB. Leave-one-out: leanings learned from the other 37 answers (upper bound for this approach):')
console.log('   linear sum      ', score((s) => predict(s, learned(s.id), 'sum')))
console.log('   least sacrifice ', score((s) => predict(s, learned(s.id), 'least')))
const all = learned('none')
console.log('\nLeanings your scenario choices reveal (all 38):')
for (const [d, v] of [...all.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
  const [l, r] = NAMES[d] ?? ({ horizon: ['Short term', 'Long term'], risk: ['Safe', 'Bold'], reputation: ['Reputation', 'Revenue'], customer: ['Customer interest', 'Company interest'], relationships: ['Relationships', 'Efficiency'] } as any)[d] ?? [d, d]
  console.log(`  ${d.padEnd(13)} ${Math.abs(v) < 0.1 ? 'balanced' : v > 0 ? r : l} (${v.toFixed(2)})`)
}
