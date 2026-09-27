/**
 * Graded, per-dimension scoring of choice predictions:
 *
 *   npm run aura:dims -- <picks.json> [<picks.json> ...]
 *
 * Each picks file ({ picks: { scenarioId: option } }) is scored against the
 * founder's answers (eval/founder/scenario-answers-v1..v3.json) on the rated
 * dimensions in eval/option-ratings.json. With no files, scores the committed
 * picks: v3 frozen on set 3, all+goals and the plain model on sets 1 and 2.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dimensionReport, providerLean, type OptionRatings } from './dimension-score.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const founder = join(evalDir, 'founder')
const ratings = JSON.parse(readFileSync(join(evalDir, 'option-ratings.json'), 'utf8')) as OptionRatings
const actual: Record<string, string> = {}
for (const v of ['v1', 'v2', 'v3']) {
  const f = join(founder, `scenario-answers-${v}.json`)
  if (!existsSync(f)) continue
  for (const [id, a] of Object.entries(JSON.parse(readFileSync(f, 'utf8')).answers as Record<string, { choice?: string }>)) if (a?.choice) actual[id] = a.choice
}
const base = process.env.INIT_CWD ?? process.cwd()
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const targets = files.length ? files.map((f) => resolve(base, f)) : ['v3-picks.json', 'picks-sets12-all+goals.json', 'picks-sets12-none.json'].map((f) => join(founder, f))

const sign = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2)
for (const file of targets) {
  const picks = JSON.parse(readFileSync(file, 'utf8')).picks as Record<string, string | null>
  const scoped = Object.fromEntries(Object.entries(actual).filter(([id]) => id in picks))
  const r = dimensionReport(ratings, picks, scoped)
  console.log(`\n${file.split(/[\\/]/).pop()}: exact ${r.exact}/${r.scenarios}; ${Math.round(r.closerThanRandom * 100)}% closer than a random pick (gap ${r.totalGap} vs ${r.totalRandomGap})`)
  console.log('  dimension       bias (Aura − you)   gap    random gap')
  for (const row of r.rows) console.log(`  ${row.dimension.padEnd(15)} ${sign(row.bias).padStart(6)}             ${row.gap.toFixed(2)}   ${row.randomGap.toFixed(2)}`)
}
console.log('\nYour lean vs the average option (+ = higher):')
for (const [label, prefix] of [['sets 1+2', /^cs-|^cs2-/], ['set 3', /^cs3-/]] as const) {
  const lean = providerLean(ratings, Object.fromEntries(Object.entries(actual).filter(([id]) => prefix.test(id))))
  console.log(`  ${label.padEnd(9)} ${Object.entries(lean).map(([d, v]) => `${d} ${sign(v)}`).join(', ')}`)
}
