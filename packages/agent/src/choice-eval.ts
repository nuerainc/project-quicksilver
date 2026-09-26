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
 *
 * Using everything at once (added 2026-09-26, exploratory until frozen as predictor v3):
 *
 *   npm run aura:choices:model -- --set v2 --founder [--principles data/aura/principles.json] [--votes 3] --detail
 *
 * --founder reads the founder's committed files: the other set's answers and
 * profile v2 as examples, profile v1 readings, his confirmed principles
 * (eval/founder/principles.json), and this set's answers to score. The
 * principles were drafted from both sets' answers, so any result on set 1 or
 * set 2 that uses them is supporting evidence only.
 * --profile-v2 <answers.json> adds any provider's profile-v2 answers as examples.
 * It runs these variants side by side:
 *   none                — baseline
 *   examples            — as before (other set + extra examples text)
 *   all                 — principles + profile + every example, in one prompt
 *   all+goals           — and each option checked against each stated goal separately
 *   all+rolling         — and this set's earlier answers, each added only after
 *                         it was predicted (predict-then-learn)
 *   all+goals+rolling   — both
 * --variants a,b,c picks which run. --votes N asks N times and takes the
 * majority (ties go to the earliest pick), which cuts run-to-run noise.
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
const { scoreProfile, parsePrincipleExport, acceptedPrinciples, profileV2AsExamples } = await import('@quicksilver/aura')
const { buildChoicePrompt, buildEarlierText, buildExamplesText, buildPrinciplesText, buildProfileText, systemForArm } = await import('./choice-prompts.ts')
type ChoiceArm = import('./choice-prompts.ts').ChoiceArm
type ChoiceScenario = import('./choice-prompts.ts').ChoiceScenario
const { assertAgentDispatch } = await import('./governance.ts')
const { modelForRole, resolveId } = await import('./models.ts')

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
let profilePath = arg('--profile'), choicesPath = arg('--choices')
const picksOut = arg('--picks-out')
// --examples <answers.json> [--examples-set v1|v2]: the provider's own earlier decisions, shown to the
// model as worked examples (in-context learning). Never the answers of the set being predicted.
let examplesPath = arg('--examples')
// --examples-text <file>: extra worked examples as plain text, e.g. `npm run -s onboard -- decisions --export examples`
// (logged real decisions and shadow verdicts) or the answered situational profile v2. Joins the examples arms.
const examplesTextPath = arg('--examples-text')

// --principles <export.json>: the provider's confirmed decision principles (confirmed + edited only).
let principlesPath = arg('--principles')
const set = arg('--set') ?? 'v1'
if (set !== 'v1' && set !== 'v2') { console.log('--set must be v1 or v2'); process.exit(1) }
const founder = process.argv.includes('--founder')
const founderDir = join(here, '..', '..', 'aura', 'eval', 'founder')
const other = set === 'v2' ? 'v1' : 'v2'
if (founder) {
  profilePath ??= join(founderDir, 'profile-answers-v1.json')
  choicesPath ??= join(founderDir, `scenario-answers-${set}.json`)
  examplesPath ??= join(founderDir, `scenario-answers-${other}.json`)
  if (!principlesPath && existsSync(join(founderDir, 'principles.json'))) principlesPath = join(founderDir, 'principles.json')
}
const profileV2Path = arg('--profile-v2') ?? (founder ? join(founderDir, 'profile-answers-v2.json') : undefined)
const votes = Math.max(1, Number(arg('--votes') ?? 1) || 1)
const hasExamples = Boolean(examplesPath || examplesTextPath || profileV2Path)
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
  const extra = [
    examplesTextPath ? readFileSync(resolve(base, examplesTextPath), 'utf8').trim() : '',
    profileV2Path ? profileV2AsExamples(read(join(evalDir, 'intent-profile-v2.json')), read(profileV2Path).answers) : '',
  ].filter(Boolean).join('\n\n')
  if (!examplesPath) return extra
  const exScenarios = read(join(evalDir, examplesSet === 'v2' ? 'choice-scenarios-v2.json' : 'choice-scenarios.json')).scenarios as typeof scenarios
  return [buildExamplesText(exScenarios, read(examplesPath).answers), extra].filter(Boolean).join('\n\n')
})()
const profileText = profile ? buildProfileText(profile.dimensions) : ''
const principlesText = principles ? buildPrinciplesText(principles) : ''

// Variants: an arm plus the optional goals and rolling methods (see the header).
interface Variant { name: string; arm: Arm; goals: boolean; rolling: boolean }
const ALL_VARIANTS = ['all', 'all+goals', 'all+rolling', 'all+goals+rolling']
const hasContext = hasExamples || Boolean(profile) || Boolean(principles)
const variantArg = arg('--variants')
const variantNames = variantArg
  ? variantArg.split(',').map((v) => v.trim()).filter(Boolean)
  : founder
    ? [...ALL_VARIANTS, ...(principles ? ['rules+examples'] : []), 'examples', 'none']
    : arms
const variants: Variant[] = variantNames.map((name) => {
  const [arm, ...mods] = name.split('+goals').join('|goals').split('+rolling').join('|rolling').split('|')
  const v = { name, arm: arm as Arm, goals: mods.includes('goals'), rolling: mods.includes('rolling') }
  if (!(['profile', 'none', 'examples', 'rules', 'rules+examples', 'all'] as string[]).includes(v.arm)) { console.log(`Unknown variant "${name}".`); process.exit(1) }
  if (v.arm === 'all' && !hasContext) { console.log('Variant "all" needs --founder, --examples, --examples-text, --profile, --profile-v2 or --principles.'); process.exit(1) }
  if (v.arm !== 'all' && v.arm !== 'none' && !arms.includes(v.arm)) { console.log(`Variant "${name}" needs its inputs (arms available: ${arms.join(', ')}).`); process.exit(1) }
  return v
})
const rolling = variants.some((v) => v.rolling)
if (rolling && !choicesPath) { console.log('Rolling variants need --choices (or --founder): each answer joins the prompt after its scenario is predicted.'); process.exit(1) }

const picksArm = arg('--picks-arm') ?? 'none'
if (picksOut && !variants.some((v) => v.name === picksArm)) { console.log(`--picks-arm "${picksArm}" did not run (variants: ${variants.map((v) => v.name).join(', ')}).`); process.exit(1) }
if (picksOut && rolling && variants.find((v) => v.name === picksArm)?.rolling) { console.log('--picks-arm cannot be a rolling variant: rolling picks depend on answers.'); process.exit(1) }

const role = (process.env.QUICKSILVER_INTENT_ROLE || 'planner') as 'planner'
console.log(`Model: ${resolveId(role, 'azure')} · set ${set} · ${scenarios.length} scenarios · variants: ${variants.map((v) => v.name).join(', ')}${votes > 1 ? ` · ${votes} votes each` : ''}`)

const readAnswers = (): Record<string, { choice?: string; confidence?: string; note?: string }> => read(choicesPath!).answers
// Rolling variants read the answers up front, but a scenario's answer is used only after it was predicted.
const rollingAnswers = rolling ? readAnswers() : {}

async function predictOnce(s: ChoiceScenario, v: Variant, earlierText: string): Promise<string | null> {
  assertAgentDispatch('nuera-quicksilver:intent', 'reasoning', 'low')
  const ids = Object.keys(s.options) as [string, ...string[]]
  const schema = v.goals
    ? z.object({
      goals: z.array(z.string()),
      check: z.array(z.object({ option: z.enum(ids), keeps: z.array(z.string()), givesUp: z.array(z.string()) })),
      choice: z.enum(ids),
      reason: z.string(),
    })
    : z.object({ choice: z.enum(ids), reason: z.string() })
  const prompt = buildChoicePrompt(v.arm, s, { profileText, examplesText, principlesText, earlierText })
  try {
    const result = await generateText({ model: modelForRole(role), system: systemForArm(v.arm, { goals: v.goals }), prompt, experimental_output: Output.object({ schema }), maxRetries: 2 } as Parameters<typeof generateText>[0])
    return ((result as unknown as { experimental_output?: { choice: string } }).experimental_output?.choice) ?? null
  } catch {
    return null
  }
}

async function predict(s: ChoiceScenario, v: Variant, earlierText: string): Promise<string | null> {
  const picks: string[] = []
  for (let i = 0; i < votes; i++) { const p = await predictOnce(s, v, earlierText); if (p) picks.push(p) }
  if (!picks.length) return null
  const counts = new Map<string, number>()
  for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || picks.indexOf(a[0]) - picks.indexOf(b[0]))[0]![0]
}

const predictions: Record<string, Record<string, string | null>> = Object.fromEntries(variants.map((v) => [v.name, {}]))
for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i]!
  // Only scenarios before this one, i.e. already predicted, may be shown.
  const earlierText = rolling ? buildEarlierText(scenarios.slice(0, i), rollingAnswers) : ''
  for (const v of variants) predictions[v.name]![s.id] = await predict(s, v, v.rolling ? earlierText : '')
}

// Blind picks, written before any answers are read (non-rolling variants only).
if (picksOut) {
  const out = resolve(base, picksOut)
  mkdirSync(dirname(out), { recursive: true })
  const picks = Object.fromEntries(scenarios.map((s) => [s.id, predictions[picksArm]![s.id] ?? null]))
  writeFileSync(out, JSON.stringify({ set, arm: picksArm, model: resolveId(role, 'azure'), createdAt: new Date().toISOString(), picks }, null, 1) + '\n')
  const errors = Object.values(picks).filter((p) => p === null).length
  console.log(`Wrote ${scenarios.length} blind picks (arm "${picksArm}") to ${out}${errors ? `; ${errors} model errors recorded as null` : ''}`)
}
if (!choicesPath) process.exit(0)

// Only now read the provider's answers, to score.
const actual = Object.fromEntries(Object.entries(readAnswers()).filter(([, v]) => v?.choice).map(([k, v]) => [k, v.choice!]))
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
for (const v of variants) {
  const scored = scenarios.filter((s) => actual[s.id])
  const right = scored.filter((s) => predictions[v.name]![s.id] === actual[s.id]).length
  const failed = scored.filter((s) => predictions[v.name]![s.id] === null).length
  console.log(`Arm "${v.name}": ${right}/${scored.length} = ${pct(right / scored.length)}${failed ? ` (${failed} model errors counted as misses)` : ''} — chance 25%`)
  if (process.argv.includes('--detail')) for (const s of scored) if (predictions[v.name]![s.id] !== actual[s.id]) console.log(`  ${s.id} (${s.category}): predicted ${predictions[v.name]![s.id] ?? 'error'}, actual ${actual[s.id]}`)
}
if (founder || variants.some((v) => v.arm === 'all')) console.log('Exploratory: these methods were built after the founder\'s set 1 and set 2 answers were seen; a criterion test needs a frozen method and a fresh set or shadow verdicts.')
