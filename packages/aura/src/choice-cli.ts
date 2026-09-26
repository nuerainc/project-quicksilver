/**
 * Score Aura's choice predictions against a provider's blind scenario answers:
 *   npm run aura:choices -- --profile profile-answers.json --choices scenario-answers.json [--detail]
 * Both files are the JSON the pages' "Copy answers" buttons produce (or the
 * same shape exported from their stores). They hold one person's answers, so
 * keep them out of the repository.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { choiceAgreement, type ChoiceScenarioLite, type PredictorSpec } from './predict.ts'
import { scoreProfile, type ProfileAnswer, type ProfileInstrument } from './profile.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const profilePath = arg('--profile'), choicesPath = arg('--choices')
if (!profilePath || !choicesPath) { console.log('Usage: --profile <answers.json> --choices <answers.json> [--detail]'); process.exit(1) }
const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const read = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T
const instrument = read<ProfileInstrument>(join(evalDir, 'intent-profile-v1.json'))
const spec = read<PredictorSpec>(join(evalDir, 'choice-predictor-v1.json'))
const scenarios = read<{ scenarios: ChoiceScenarioLite[] }>(join(evalDir, 'choice-scenarios.json')).scenarios
const profileAnswers = read<{ answers: Record<string, ProfileAnswer> }>(profilePath).answers
const choiceAnswers = read<{ answers: Record<string, { choice?: string | null }> }>(choicesPath).answers
const actual = Object.fromEntries(Object.entries(choiceAnswers).filter(([, v]) => v?.choice).map(([k, v]) => [k, v.choice as string]))

const profile = scoreProfile(instrument, profileAnswers)
const r = choiceAgreement(profile, spec, scenarios, actual)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
console.log(`Choice agreement (predictor v${spec.version}): ${r.correct}/${r.scenarios} = ${pct(r.agreement)} — charter target 70% and ≥ 2× chance: ${r.meetsCharterTarget ? 'MET' : 'not met'}`)
console.log(`Chance: ${pct(r.chance)} · covered ${r.covered}/${r.scenarios}, ${pct(r.coveredAgreement)} correct where covered`)
console.log(`"Ask first": founder chose it ${r.askScenarios}×, Aura matched ${r.askCorrect}; unneeded asks ${r.unneededAsks}`)
if (process.argv.includes('--detail')) for (const row of r.rows.filter((x) => !x.correct)) console.log(`  ${row.id} (${row.category}): predicted ${row.predicted ?? 'abstain'}, actual ${row.actual}`)
