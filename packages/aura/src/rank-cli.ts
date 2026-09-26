/**
 * Learned question order: honest evaluation and training.
 *
 *   npm run aura:rank -- cv                         cross-validated accuracy on the founder's rankings
 *   npm run aura:rank -- train [--out data/aura/ranker.json]
 *
 * Accuracy is top-3 agreement (the share of the founder's top three that the
 * order also puts in its top three), always on objectives the learner was not
 * trained on: leave-one-out, and trained on one set / tested on the other.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIntent } from './intent.ts'
import { orderQuestions, trainRanker, type RankerState } from './rank-learn.ts'
import type { IntentGraph } from './types.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const read = (f: string) => JSON.parse(readFileSync(join(evalDir, f), 'utf8'))
const cands = read('impact-ranking-candidates.json').sets as Record<string, Record<string, { text: string; candidates: string[] }>>
const human: Record<string, Record<string, string[]>> = { v1: read('impact-rankings.json').rankings, v3: read('impact-rankings-v3.json').rankings }

type Ex = { id: string; set: string; graph: IntentGraph; candidates: string[]; top: string[] }
const examples: Ex[] = []
for (const set of ['v1', 'v3']) for (const [id, o] of Object.entries(cands[set]!)) {
  const top = human[set]![id]
  if (!top || o.candidates.length <= 3) continue
  const { graph } = await createIntent(o.text, { requestedBy: 'eval', now: new Date('2026-09-26T12:00:00Z') })
  examples.push({ id, set, graph, candidates: o.candidates, top })
}
const agree = (order: string[], top: string[]) => top.filter((t) => order.slice(0, 3).includes(t)).length / 3
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const chance = (xs: Ex[]) => mean(xs.map((e) => 3 / e.candidates.length))
const score = (s: RankerState | null, xs: Ex[]) => mean(xs.map((e) => agree(orderQuestions(s, e.graph, e.candidates), e.top)))

const cmd = process.argv[2]
if (cmd === 'cv') {
  const row = (label: string, xs: Ex[], learned: number) => console.log(`${label.padEnd(34)} n=${String(xs.length).padStart(2)}  learned ${pct(learned).padStart(6)}  fixed scorer ${pct(score(null, xs)).padStart(6)}  chance ${pct(chance(xs)).padStart(6)}`)
  const loo = (xs: Ex[]) => mean(xs.map((e) => agree(orderQuestions(trainRanker(examples.filter((x) => x !== e)), e.graph, e.candidates), e.top)))
  row('Leave-one-out, all', examples, loo(examples))
  for (const m of ['genesis', 'onboard']) row(`Leave-one-out, ${m}`, examples.filter((e) => e.graph.mode === m), mean(examples.filter((e) => e.graph.mode === m).map((e) => agree(orderQuestions(trainRanker(examples.filter((x) => x !== e)), e.graph, e.candidates), e.top))))
  for (const [tr, te] of [['v1', 'v3'], ['v3', 'v1']] as const) {
    const s = trainRanker(examples.filter((e) => e.set === tr))
    const test = examples.filter((e) => e.set === te)
    row(`Train ${tr} → test ${te}`, test, score(s, test))
    for (const m of ['genesis', 'onboard']) { const t = test.filter((e) => e.graph.mode === m); row(`  ${m}`, t, score(s, t)) }
  }
  console.log('Note: the fixed scorer (v4) was itself fitted to set v3, so its v3 numbers are not a fair comparison.')
} else if (cmd === 'train') {
  const i = process.argv.indexOf('--out')
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), i > 0 ? process.argv[i + 1]! : 'data/aura/ranker.json')
  const s = trainRanker(examples)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ ...s, trainedOn: examples.length, provenance: 'AGENT_INFERRED', note: 'Aura’s learned question order for this provider. Changes only the order questions are asked in.' }, null, 1))
  console.log(`Trained on ${examples.length} ranked objectives (${s.pairs} comparisons). Wrote ${out}.`)
} else console.log('Usage: cv | train [--out <file>]')
