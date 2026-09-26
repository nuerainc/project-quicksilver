/**
 * Compare Aura's impact ranking with the founder's blind rankings:
 *   npm run aura:agreement              summary
 *   npm run aura:agreement -- --detail  every objective that disagrees
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
const pct = (n: number) => `${(n * 100).toFixed(1)}%`
console.log(`Top-3 agreement (scorer v${IMPACT_SCORER_VERSION}, ranked by ${human.rankedBy}): ${pct(r.meanAgreement)} over ${r.objectives} objectives — charter target 80%: ${r.meetsCharterTarget ? 'MET' : 'not met'}`)
console.log(`Chance baseline: ${pct(r.chanceBaseline)} · identical top three: ${r.exactTopThree}/${r.objectives}`)
if (r.missing.length) console.log(`Missing or incomplete rankings (${r.missing.length}): ${r.missing.join(', ')}`)
if (process.argv.includes('--detail')) for (const o of r.perObjective.filter((o) => o.agreement < 1)) console.log(`  ${o.id} (${o.candidates}) ${pct(o.agreement)}: Aura ${o.aura.join(' > ')} | human ${o.human.join(' > ')}`)
