/**
 * Evaluate the model-based objective parser on Aura's labeled set, on Azure.
 *
 *   npm run aura:eval:model                 all objectives, Azure deployments
 *   npm run aura:eval:model -- --misses     also list every wrong field
 *   npm run aura:eval:model -- --limit 10   first 10 objectives only
 *   npm run aura:eval:model -- --holdout    the held-out set (use this for the 90% claim)
 *
 * Reads the repo's .env. Forces QUICKSILVER_MODEL_MODE=azure unless it is
 * already set, so the run uses your Azure OpenAI deployments.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
for (let dir = here, i = 0; i < 6; i++, dir = dirname(dir)) {
  const candidate = join(dir, '.env')
  if (!existsSync(candidate)) continue
  for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2')
  }
}
process.env.QUICKSILVER_MODEL_MODE ||= 'azure'

const { evaluateParser, parseObjectiveBaseline } = await import('@quicksilver/aura')
const { parseObjectiveWithModel } = await import('./intent-parser.ts')
const { combineParses } = await import('@quicksilver/aura')
const { resolveId } = await import('./models.ts')

const setName = process.argv.includes('--holdout') ? 'objectives-holdout.json' : 'objectives.json'
const setPath = join(here, '..', '..', 'aura', 'eval', setName)
let set = (JSON.parse(readFileSync(setPath, 'utf8')) as { objectives: Parameters<typeof evaluateParser>[1] }).objectives
const limitArg = process.argv.indexOf('--limit')
if (limitArg > 0) set = set.slice(0, Number(process.argv[limitArg + 1]) || set.length)

const role = (process.env.QUICKSILVER_INTENT_ROLE || 'planner') as 'planner'
console.log(`Model: ${resolveId(role, 'azure')} (role ${role}, mode ${process.env.QUICKSILVER_MODEL_MODE}) · ${setName} · ${set.length} objectives`)

const started = Date.now()
const baseline = await evaluateParser(parseObjectiveBaseline, set)
// One model call per objective; the combined parser reuses it.
const modelParses = new Map<string, Awaited<ReturnType<typeof parseObjectiveWithModel>>>()
const modelParser = async (text: string) => {
  const p = await parseObjectiveWithModel(text)
  modelParses.set(text, p)
  return p
}
const model = await evaluateParser(modelParser, set)
const combined = await evaluateParser((text) => {
  const m = modelParses.get(text)
  if (!m) throw new Error('model parse failed for this objective')
  return combineParses(parseObjectiveBaseline(text), m)
}, set)
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

console.log(`Baseline parser: ${baseline.exactMatches}/${baseline.objectives} (${pct(baseline.parsingAccuracy)})`)
console.log(`Model parser:    ${model.exactMatches}/${model.objectives} (${pct(model.parsingAccuracy)})`)
console.log(`Combined parser: ${combined.exactMatches}/${combined.objectives} (${pct(combined.parsingAccuracy)}) — charter target 90%: ${combined.meetsCharterTarget ? 'MET' : 'not met'}`)
console.log('Combined field accuracy:', combined.fieldAccuracy)
if (model.errors.length) console.log(`Model errors (${model.errors.length}):`, model.errors.slice(0, 5))
if (process.argv.includes('--misses')) {
  console.log('Model misses:')
  for (const m of model.misses) console.log(`  ${m.id} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`)
  console.log('Combined misses:')
  for (const m of combined.misses) console.log(`  ${m.id} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`)
}
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
