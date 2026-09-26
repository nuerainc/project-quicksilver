/**
 * Blind model test of choice prediction, on Azure:
 *
 *   npm run aura:choices:model -- --profile <profile-answers.json> --choices <scenario-answers.json> [--detail]
 *
 * Fresh set v2 (choice predictor v2): generate blind model picks, no answers read:
 *
 *   npm run aura:choices:model -- --set v2 --picks-out data/aura/v2-picks.json
 *
 * Learning from the provider's own earlier choices (in-context examples, 2026-09-26):
 *
 *   npm run aura:choices:model -- --set v2 --examples data/aura/scenario-answers.json --choices data/aura/scenario-answers-v2.json --detail
 *   npm run aura:choices:model -- --set v1 --examples data/aura/scenario-answers-v2.json --choices data/aura/scenario-answers.json --detail
 *
 * The "examples" arm shows the model the provider's decisions on the OTHER
 * scenario set (situation, options, their choice and note), then predicts
 * this set. It never sees this set's answers. The "none" arm runs alongside
 * as the same-run baseline. --picks-arm examples writes that arm's picks.
 *
 * With --set v2 only the "none" arm runs (the arm frozen in
 * aura/eval/choice-predictor-v2.json), unless --profile is given; the picks
 * written are always from the "none" arm. --choices is optional there and, if
 * given, is read only after every prediction is made. Without --set the
 * behavior is the original set-v1 test.
 *
 * The model is shown the scenarios and, in one arm, the provider's scored
 * intent profile. It is never shown the provider's scenario answers; those
 * are read only afterwards, to score the predictions. The prompts below were
 * written on 2026-09-26 and contain no patterns learned from those answers.
 *
 * Two arms:
 *   profile  — the six profile readings with their confidence (0–10)
 *   none     — no profile: what a general model would choose
 * Both answer files hold one person's answers: keep them out of the repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

const { generateText, Output } = await import('ai')
const { z } = await import('zod')
const { scoreProfile } = await import('@quicksilver/aura')
const { assertAgentDispatch } = await import('./governance.ts')
const { modelForRole, resolveId } = await import('./models.ts')

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const profilePath = arg('--profile'), choicesPath = arg('--choices'), picksOut = arg('--picks-out')
// --examples <answers.json> [--examples-set v1|v2]: the provider's own earlier decisions, shown to the
// model as worked examples (in-context learning). Never the answers of the set being predicted.
const examplesPath = arg('--examples')
const set = arg('--set') ?? 'v1'
if (set !== 'v1' && set !== 'v2') { console.log('--set must be v1 or v2'); process.exit(1) }
if (set === 'v1' ? !(profilePath || examplesPath) || !choicesPath : !picksOut && !choicesPath) {
  console.log('Usage: --profile <profile-answers.json> --choices <scenario-answers.json> [--detail] [--picks-out <file>]\n   or: --set v2 --picks-out <file> [--profile <profile-answers.json>] [--choices <scenario-answers-v2.json>] [--detail]')
  process.exit(1)
}
const base = process.env.INIT_CWD ?? process.cwd()
const read = (p: string) => JSON.parse(readFileSync(resolve(base, p), 'utf8'))
const evalDir = join(here, '..', '..', 'aura', 'eval')
const instrument = read(join(evalDir, 'intent-profile-v1.json'))
const scenarios = read(join(evalDir, set === 'v2' ? 'choice-scenarios-v2.json' : 'choice-scenarios.json')).scenarios as Array<{ id: string; category: string; providers?: string; said: string; situation: string; decision: string; options: Record<string, string> }>
const profile = profilePath ? scoreProfile(instrument, read(profilePath).answers) : null
type Arm = 'profile' | 'none' | 'examples'
const arms: Arm[] = [...(examplesPath ? ['examples' as const] : []), ...(profile ? ['profile' as const] : []), 'none']
const examplesSet = arg('--examples-set') ?? (set === 'v2' ? 'v1' : 'v2')
if (examplesPath && examplesSet === set) { console.log('--examples must come from the other scenario set, never the one being predicted.'); process.exit(1) }
const examplesText = (() => {
  if (!examplesPath) return ''
  const exScenarios = read(join(evalDir, examplesSet === 'v2' ? 'choice-scenarios-v2.json' : 'choice-scenarios.json')).scenarios as typeof scenarios
  const ans = read(examplesPath).answers as Record<string, { choice?: string; confidence?: string; note?: string }>
  const lines = ['Here are earlier decisions this same provider made, with the option they chose and, when they gave one, their own note. Learn how they decide: what they protect, when they take a middle path, when they want to be asked, and when they would rather you just act.', '']
  for (const e of exScenarios) {
    const a = ans[e.id]
    if (!a?.choice) continue
    lines.push(`- ${e.providers ? `Providers: ${e.providers}. ` : ''}Said: ${e.said} Situation: ${e.situation} Decision: ${e.decision}`)
    lines.push(`  Options: ${Object.entries(e.options).map(([k, v]) => `${k}) ${v}`).join(' | ')}`)
    lines.push(`  They chose: ${a.choice}${a.confidence ? ` (${a.confidence})` : ''}${a.note?.trim() ? `. Their note: "${a.note.trim().slice(0, 300)}"` : ''}`)
  }
  return lines.join('\n')
})()

const SYSTEM = `You predict what an intent provider (a person, group or organization that an automated company acts for) would choose.
Read what the provider said, the situation and the options. Pick the ONE option this provider would most want, given what they said and clearly meant.
Pick "ask" only if acting without asking would likely go against what they want.
Answer with the option id and one short reason.`

const profileText = [
  'The provider took a short intent profile. Each reading runs from one pole to the other, with a confidence out of 10 (low confidence means their answers were split or depended on context):',
  ...(profile?.dimensions ?? []).map((d) => `- ${d.left} vs ${d.right}: ${d.lean} (confidence ${d.confidence}/10)`),
  'They listed no red lines beyond the law.',
].join('\n')

const role = (process.env.QUICKSILVER_INTENT_ROLE || 'planner') as 'planner'
console.log(`Model: ${resolveId(role, 'azure')} · set ${set} · ${scenarios.length} scenarios · arms: ${arms.join(', ')}`)

async function predict(s: (typeof scenarios)[number], arm: Arm): Promise<string | null> {
  assertAgentDispatch('nuera-quicksilver:intent', 'reasoning', 'low')
  const ids = Object.keys(s.options) as [string, ...string[]]
  const schema = z.object({ choice: z.enum(ids), reason: z.string() })
  const prompt = [
    arm === 'profile' ? profileText : arm === 'examples' ? examplesText : 'Nothing else is known about the provider.',
    '',
    s.providers ? `Intent providers: ${s.providers}` : '',
    `What the provider said: ${s.said}`,
    `Situation: ${s.situation}`,
    `Decision: ${s.decision}`,
    'Options:',
    ...ids.map((id) => `- ${id}: ${s.options[id]}`),
  ].filter((l) => l !== '').join('\n')
  try {
    const result = await generateText({ model: modelForRole(role), system: SYSTEM, prompt, experimental_output: Output.object({ schema }), maxRetries: 2 } as Parameters<typeof generateText>[0])
    return ((result as unknown as { experimental_output?: { choice: string } }).experimental_output?.choice) ?? null
  } catch {
    return null
  }
}

const predictions: Record<Arm, Record<string, string | null>> = { profile: {}, none: {}, examples: {} }
for (const s of scenarios) for (const arm of arms) predictions[arm][s.id] = await predict(s, arm)
const picksArm: Arm = (arg('--picks-arm') as Arm | undefined) ?? 'none'

// Blind picks from the "none" arm, written before any answers are read.
if (picksOut) {
  const out = resolve(base, picksOut)
  mkdirSync(dirname(out), { recursive: true })
  const picks = Object.fromEntries(scenarios.map((s) => [s.id, predictions[picksArm][s.id] ?? null]))
  writeFileSync(out, JSON.stringify({ set, arm: picksArm, model: resolveId(role, 'azure'), createdAt: new Date().toISOString(), picks }, null, 1) + '\n')
  const errors = Object.values(picks).filter((p) => p === null).length
  console.log(`Wrote ${scenarios.length} blind picks (arm "${picksArm}") to ${out}${errors ? `; ${errors} model errors recorded as null` : ''}`)
}
if (!choicesPath) process.exit(0)

// Only now read the provider's answers, to score.
const actual = Object.fromEntries(Object.entries(read(choicesPath).answers as Record<string, { choice?: string }>).filter(([, v]) => v?.choice).map(([k, v]) => [k, v.choice!]))
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
for (const arm of arms) {
  const scored = scenarios.filter((s) => actual[s.id])
  const right = scored.filter((s) => predictions[arm][s.id] === actual[s.id]).length
  const failed = scored.filter((s) => predictions[arm][s.id] === null).length
  console.log(`Arm "${arm}": ${right}/${scored.length} = ${pct(right / scored.length)}${failed ? ` (${failed} model errors counted as misses)` : ''} — chance 25%`)
  if (process.argv.includes('--detail')) for (const s of scored) if (predictions[arm][s.id] !== actual[s.id]) console.log(`  ${s.id} (${s.category}): predicted ${predictions[arm][s.id] ?? 'error'}, actual ${actual[s.id]}`)
}
