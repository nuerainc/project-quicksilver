/**
 * Choice learning, cross-validated on the founder's committed answers:
 *   npm run aura:choices:cv
 * A feature learner (annotations: profile-dimension loads, compromise, ask by
 * category) is scored only on decisions it did not train on: leave-one-out
 * over both sets, and trained on one set / tested on the other. No model.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { learn, newLearner, predictOption } from './learn.ts'
import { v2Features, type V2ScenarioAnnotation } from './predict-v2.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const j = (f: string) => JSON.parse(readFileSync(join(evalDir, f), 'utf8'))
type Sc = { id: string; category: string; options: Record<string, string> }
const ann1 = j('choice-predictor-v1.json').annotations as Record<string, { covered?: boolean; options?: Record<string, Record<string, [string, number]>> }>
const ann2 = j('choice-predictor-v2.json').annotations as Record<string, V2ScenarioAnnotation>
const conv1 = (id: string): V2ScenarioAnnotation => {
  const a = ann1[id]
  if (!a?.covered) return {}
  const out: V2ScenarioAnnotation = {}
  for (const [o, loads] of Object.entries(a.options ?? {})) out[o] = { loads: loads as never, compromise: Object.values(loads).some((x) => x[1] < 1) }
  return out
}
const build = (sc: Sc[], answers: Record<string, { choice?: string }>, ann: (id: string) => V2ScenarioAnnotation) =>
  sc.filter((s) => answers[s.id]?.choice).map((s) => ({ id: s.id, set: s.id.startsWith('cs2') ? 2 : 1, category: s.category, options: Object.keys(s.options), annotation: ann(s.id), modelPick: null, chosen: answers[s.id]!.choice! }))
const all = [
  ...build(j('choice-scenarios.json').scenarios, j('founder/scenario-answers-v1.json').answers, conv1),
  ...build(j('choice-scenarios-v2.json').scenarios, j('founder/scenario-answers-v2.json').answers, (id) => ann2[id] ?? {}),
]
const train = (ds: typeof all) => { let s = newLearner({}, { learningRate: 0.3, priorStrength: 0.02 }); for (let e = 0; e < 8; e++) for (const d of ds) s = learn(s, v2Features(d), d.chosen); return s }
const hit = (s: ReturnType<typeof train>, d: (typeof all)[number]) => predictOption(s, v2Features(d)).choice === d.chosen
const pct = (a: number, b: number) => `${a}/${b} = ${((100 * a) / b).toFixed(1)}%`
const loo = all.filter((d) => hit(train(all.filter((x) => x !== d)), d)).length
const s1 = all.filter((d) => d.set === 1), s2 = all.filter((d) => d.set === 2)
console.log(`Feature learner, leave-one-out over ${all.length}: ${pct(loo, all.length)} (chance about 25%)`)
console.log(`Trained on set 1, tested on set 2: ${pct(s2.filter((d) => hit(train(s1), d)).length, s2.length)}`)
console.log(`Trained on set 2, tested on set 1: ${pct(s1.filter((d) => hit(train(s2), d)).length, s1.length)}`)
