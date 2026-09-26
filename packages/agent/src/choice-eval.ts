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
 * Stated decision principles (frozen 2026-09-26 before any run):
 *
 *   npm run aura:choices:model -- --set v2 --principles data/aura/principles.json --choices data/aura/scenario-answers-v2.json --detail
 *   npm run aura:choices:model -- --set v2 --principles data/aura/principles.json --examples data/aura/scenario-answers.json --choices data/aura/scenario-answers-v2.json --detail
 *
 * --principles takes the principles page's export ({ principles: [{ id, text,
 * status, appliesTo?, examples? }] }) and uses the confirmed and edited ones
 * only. It adds the arm "rules" (principles only) and, with --examples, the arm
 * "rules+examples". Their system prompt says the principles are the provider's
 * own and take priority over general common sense, and that the examples show
 * how the provider applied them. A principle's `examples` ids are never shown
 * to the model, and principles distilled from the set being predicted make
 * that set's result supporting evidence only.
 *
 * Arms:
 *   profile         — the six profile readings with their confidence (0–10)
 *   none            — no profile: what a general model would choose
 *   examples        — the provider's decisions on the other set
 *   rules           — the provider's stated principles
 *   rules+examples  — both
 * All prompts live in choice-prompts.ts; the none, profile and examples prompts
 * are byte-identical to those frozen earlier (pinned by choice-prompts.test.ts).
 * The founder's answer files are in the repo (packages/aura/eval/founder/, his decision 2026-09-26).
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
const { scoreProfile, parsePrincipleExport, acceptedPrinciples } = await import('@quicksilver/aura')
const { buildChoicePrompt, buildExamplesText, buildPrinciplesText, buildProfileText, systemForArm } = await import('./choice-prompts.ts')
type ChoiceArm = import('./choice-prompts.ts').ChoiceArm
type ChoiceScenario = import('./choice-prompts.ts').ChoiceScenario
const { assertAgentDispatch } = await import('./governance.ts')
const { modelForRole, resolveId } = await import('./models.ts')

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const profilePath = arg('--profile'), choicesPath = arg('--choices'), picksOut = arg('--picks-out')
// --examples <answers.json> [--examples-set v1|v2]: the provider's own earlier decisions, shown to the
// model as worked examples (in-context learning). Never the answers of the set being predicted.
const examplesPath = arg('--examples')
// --examples-text <file>: extra worked examples as plain text, e.g. `npm run -s onboard -- decisions --export examples`
// (logged real decisions and shadow verdicts) or the answered situational profile v2. Joins the examples arms.
const examplesTextPath = arg('--examples-text')
const hasExamples = Boolean(examplesPath || examplesTextPath)
// --principles <export.json>: the provider's confirmed decision principles (confirmed + edited only).
const principlesPath = arg('--principles')
const set = arg('--set') ?? 'v1'
if (set !== 'v1' && set !== 'v2') { console.log('--set must be v1 or v2'); process.exit(1) }
if (set === 'v1' ? !(profilePath || hasExamples || principlesPath) || !choicesPath : !picksOut && !choicesPath) {
  console.log('Usage: --profile <profile-answers.json> --choices <scenario-answers.json> [--detail] [--picks-out <file>]\n   or: --set v2 --picks-out <file> [--profile <profile-answers.json>] [--choices <scenario-answers-v2.json>] [--detail]\n   add: [--examples <other-set-answers.json>] [--principles <principles-export.json>] [--picks-arm <arm>]')
  process.exit(1)
}
const base = process.env.INIT_CWD ?? process.cwd()
const read = (p: string) => JSON.parse(readFileSync(resolve(base, p), 'utf8'))
const evalDir = join(here, '..', '..', 'aura', 'eval')
const instrument = read(join(evalDir, 'intent-profile-v1.json'))
const scenarios = read(join(evalDir, set === 'v2' ? 'choice-scenarios-v2.json' : 'choice-scenarios.json')).scenarios as ChoiceScenario[]
const profile = profilePath ? scoreProfile(instrument, read(profilePath).answers) : null
const principles = principlesPath ? acceptedPrinciples(parsePrincipleExport(read(principlesPath))) : null
if (principles && !principles.length) { console.log('--principles has no confirmed or edited principles.'); process.exit(1) }
type Arm = ChoiceArm
const arms: Arm[] = [
  ...(principles && hasExamples ? ['rules+examples' as const] : []),
  ...(principles ? ['rules' as const] : []),
  ...(hasExamples ? ['examples' as const] : []),
  ...(profile ? ['profile' as const] : []),
  'none',
]
const examplesSet = arg('--examples-set') ?? (set === 'v2' ? 'v1' : 'v2')
if (examplesPath && examplesSet === set) { console.log('--examples must come from the other scenario set, never the one being predicted.'); process.exit(1) }
const examplesText = (() => {
  const extra = examplesTextPath ? readFileSync(resolve(base, examplesTextPath), 'utf8').trim() : ''
  if (!examplesPath) return extra
  const exScenarios = read(join(evalDir, examplesSet === 'v2' ? 'choice-scenarios-v2.json' : 'choice-scenarios.json')).scenarios as typeof scenarios
  return [buildExamplesText(exScenarios, read(examplesPath).answers), extra].filter(Boolean).join('\n\n')
})()
const profileText = buildProfileText(profile?.dimensions ?? [])
const principlesText = principles ? buildPrinciplesText(principles) : ''

const picksArm: Arm = (arg('--picks-arm') as Arm | undefined) ?? 'none'
if (!arms.includes(picksArm)) { console.log(`--picks-arm "${picksArm}" did not run (arms: ${arms.join(', ')}).`); process.exit(1) }

const role = (process.env.QUICKSILVER_INTENT_ROLE || 'planner') as 'planner'
console.log(`Model: ${resolveId(role, 'azure')} · set ${set} · ${scenarios.length} scenarios · arms: ${arms.join(', ')}`)

async function predict(s: (typeof scenarios)[number], arm: Arm): Promise<string | null> {
  assertAgentDispatch('nuera-quicksilver:intent', 'reasoning', 'low')
  const ids = Object.keys(s.options) as [string, ...string[]]
  const schema = z.object({ choice: z.enum(ids), reason: z.string() })
  const prompt = buildChoicePrompt(arm, s, { profileText, examplesText, principlesText })
  try {
    const result = await generateText({ model: modelForRole(role), system: systemForArm(arm), prompt, experimental_output: Output.object({ schema }), maxRetries: 2 } as Parameters<typeof generateText>[0])
    return ((result as unknown as { experimental_output?: { choice: string } }).experimental_output?.choice) ?? null
  } catch {
    return null
  }
}

const predictions: Record<Arm, Record<string, string | null>> = { profile: {}, none: {}, examples: {}, rules: {}, 'rules+examples': {} }
for (const s of scenarios) for (const arm of arms) predictions[arm][s.id] = await predict(s, arm)

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
