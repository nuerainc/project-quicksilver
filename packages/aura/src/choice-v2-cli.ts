/**
 * Score the frozen choice predictor v2 on the fresh v2 scenarios:
 *
 *   npm run aura:choices:v2 -- <scenario-answers-v2.json> <model-picks.json> [--detail]
 *
 * answers: { "answers": { "cs2-01": { "choice": "b" }, ... } }   (the provider's, blind)
 * picks:   { "picks":   { "cs2-01": "a", ... } }                 (from `npm run aura:choices:model -- --set v2 --picks-out <file>`)
 *
 * Offline: no model is called here. Relative paths resolve from the directory
 * npm was run in. Both files hold one person's data: keep them out of the repo.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prequentialV2, V2_TARGET, type V2ScoredDecision, type V2Spec } from './predict-v2.ts'

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [answersPath, picksPath] = positional
if (!answersPath || !picksPath) {
  console.log('Usage: npm run aura:choices:v2 -- <scenario-answers-v2.json> <model-picks.json> [--detail]')
  process.exit(1)
}
const base = process.env.INIT_CWD ?? process.cwd()
const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const read = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T

const specText = readFileSync(join(evalDir, 'choice-predictor-v2.json'), 'utf8')
const spec = JSON.parse(specText) as V2Spec
const scenarios = read<{ scenarios: Array<{ id: string; category: string; options: Record<string, string> }> }>(join(evalDir, 'choice-scenarios-v2.json')).scenarios
const answers = read<{ answers: Record<string, { choice?: string | null } | undefined> }>(resolve(base, answersPath)).answers ?? {}
const picks = read<{ picks: Record<string, string | null | undefined> }>(resolve(base, picksPath)).picks ?? {}

const decisions: V2ScoredDecision[] = []
const unanswered: string[] = []
const noPick: string[] = []
for (const s of scenarios) {
  const ids = Object.keys(s.options)
  const chosen = answers[s.id]?.choice
  if (!chosen) { unanswered.push(s.id); continue }
  if (!ids.includes(chosen)) throw new Error(`${s.id}: answer "${chosen}" is not one of ${ids.join(', ')}.`)
  const pick = picks[s.id] ?? null
  if (pick !== null && !ids.includes(pick)) throw new Error(`${s.id}: model pick "${pick}" is not one of ${ids.join(', ')}.`)
  if (pick === null) noPick.push(s.id)
  decisions.push({ id: s.id, category: s.category, options: ids, annotation: spec.annotations[s.id], modelPick: pick, chosen })
}

const r = prequentialV2(decisions)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const complete = unanswered.length === 0
console.log(`Choice predictor v${spec.version} (frozen ${spec.frozenAt}) · spec sha256 ${createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)}…`)
console.log(`Answered ${decisions.length}/${scenarios.length}${complete ? '' : ` — INCOMPLETE: no claim until all ${scenarios.length} are answered (missing ${unanswered.join(', ')})`}`)
if (noPick.length) console.log(`No model pick for ${noPick.length} (${noPick.join(', ')}): the model feature is 0 there, and the model alone counts them as misses`)
console.log(`Prequential agreement: ${r.correct}/${r.decisions} = ${pct(r.accuracy)} · chance ${pct(r.chance)} · ${r.timesChance.toFixed(2)}× chance`)
console.log(`Target ≥ ${pct(V2_TARGET.accuracy)} and ≥ ${V2_TARGET.timesChance}× chance: ${complete && r.meetsTarget ? 'MET' : complete ? 'not met' : 'not claimed (incomplete)'}`)
console.log(`Model pick alone (reference): ${r.modelAlone.correct}/${r.decisions} = ${pct(r.modelAlone.accuracy)} · second half of the run: ${pct(r.laterAccuracy)} · mean probability of the actual choice ${r.meanProbabilityOfActual.toFixed(3)}`)
console.log('By category:')
for (const [cat, c] of Object.entries(r.byCategory)) console.log(`  ${cat.padEnd(20)} ${c.correct}/${c.decisions}  ${pct(c.accuracy)}`)
const weights = Object.entries(r.final.weights).filter(([, w]) => Math.abs(w) >= 0.05).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
console.log(`Learned weights (Aura's inference, not provider intent): ${weights.map(([k, w]) => `${k} ${w.toFixed(2)}`).join(', ') || 'none'}`)
if (process.argv.includes('--detail')) for (const row of r.rows) console.log(`  ${row.id}: predicted ${row.predicted} (${row.probability.toFixed(2)}), model ${picks[row.id] ?? '-'}, actual ${row.actual}${row.correct ? '' : '  ✗'}`)
