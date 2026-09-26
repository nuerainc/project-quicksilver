/**
 * Compare Aura's impact ranking with the founder's blind rankings:
 *   npm run aura:agreement              summary
 *   npm run aura:agreement -- --detail  every objective that disagrees
 *   npm run aura:agreement -- --set v3 [--detail]   the fresh test against the frozen v3 predictions
 * Rankings live in eval/impact-rankings.json. They were collected against one
 * scorer version; a different scorer version is refused so the measure is not
 * tuned against the answers.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { topThreeAgreement, type HumanRankingSet, type RankedItem } from './agreement.ts'
import type { LabeledObjective } from './evaluate.ts'
import { IMPACT_SCORER_VERSION } from './impact.ts'
import { createIntent } from './intent.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

// --set v3: the fresh test. Aura's rankings were frozen in eval/impact-predictions-v3.json
// before the founder ranked; the founder's rankings are eval/impact-rankings-v3.json.
if (process.argv.includes('--set') && process.argv[process.argv.indexOf('--set') + 1] === 'v3') {
  const frozen = JSON.parse(readFileSync(join(evalDir, 'impact-predictions-v3.json'), 'utf8')) as { scorerVersion: number; rankings: Record<string, RankedItem[]> }
  const humanPath = join(evalDir, 'impact-rankings-v3.json')
  if (!existsSync(humanPath)) { console.log('No v3 rankings yet (eval/impact-rankings-v3.json).'); process.exit(1) }
  const h = JSON.parse(readFileSync(humanPath, 'utf8')) as HumanRankingSet
  if (h.scorerVersion !== frozen.scorerVersion) { console.log(`Rankings are for scorer v${h.scorerVersion}; the frozen predictions are v${frozen.scorerVersion}.`); process.exit(1) }
  const r = topThreeAgreement(frozen.rankings, h.rankings)
  console.log(`Fresh test, scorer v${frozen.scorerVersion} (frozen 2026-09-26), ranked by ${h.rankedBy}: ${pct(r.meanAgreement)} over ${r.objectives} objectives — charter target 80%: ${r.meetsCharterTarget ? 'MET' : 'not met'}`)
  console.log(`Chance baseline: ${pct(r.chanceBaseline)} · identical top three: ${r.exactTopThree}/${r.objectives}`)
  if (r.missing.length) console.log(`Missing or incomplete rankings (${r.missing.length}): ${r.missing.join(', ')}`)
  if (process.argv.includes('--detail')) for (const o of r.perObjective.filter((o) => o.agreement < 1)) console.log(`  ${o.id} (${o.candidates}) ${pct(o.agreement)}: Aura ${o.aura.join(' > ')} | founder ${o.human.join(' > ')}`)
  process.exit(0)
}

const rankingsPath = join(evalDir, 'impact-rankings.json')
if (!existsSync(rankingsPath)) { console.log('No human rankings yet (eval/impact-rankings.json).'); process.exit(1) }
const human = JSON.parse(readFileSync(rankingsPath, 'utf8')) as HumanRankingSet
if (human.scorerVersion !== IMPACT_SCORER_VERSION) {
  console.log(`Rankings were collected against scorer v${human.scorerVersion}; this is v${IMPACT_SCORER_VERSION}. Collect new rankings before comparing.`)
  process.exit(1)
}
const set = (JSON.parse(readFileSync(join(evalDir, 'objectives.json'), 'utf8')) as { objectives: LabeledObjective[] }).objectives
const aura: Record<string, RankedItem[]> = {}
for (const o of set) aura[o.id] = (await createIntent(o.text, { requestedBy: 'eval', now: new Date('2026-09-26T12:00:00Z') })).impact

const r = topThreeAgreement(aura, human.rankings)
console.log(`Top-3 agreement (scorer v${IMPACT_SCORER_VERSION}, ranked by ${human.rankedBy}): ${pct(r.meanAgreement)} over ${r.objectives} objectives — charter target 80%: ${r.meetsCharterTarget ? 'MET' : 'not met'}`)
console.log(`Chance baseline: ${pct(r.chanceBaseline)} · identical top three: ${r.exactTopThree}/${r.objectives}`)
if (r.missing.length) console.log(`Missing or incomplete rankings (${r.missing.length}): ${r.missing.join(', ')}`)
if (process.argv.includes('--detail')) for (const o of r.perObjective.filter((o) => o.agreement < 1)) console.log(`  ${o.id} (${o.candidates}) ${pct(o.agreement)}: Aura ${o.aura.join(' > ')} | human ${o.human.join(' > ')}`)
