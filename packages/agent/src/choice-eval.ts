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
 *   all+cases           — decide by the 3 closest earlier decisions, never a fixed order of goals
 *   all+cases+goals     — closest cases, then each option against each goal
 * --set v3 --founder uses both earlier sets' answers as examples. --concurrency N (default 6)
 * sets how many model calls run at once; progress and time left print as it goes.
 * --variants a,b,c picks which run. --votes N asks N times and takes the
 * majority (ties go to the earliest pick), which cuts run-to-run noise.
 */
import { createHash } from 'node:crypto'
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
// --frozen v3: run a frozen predictor exactly as recorded in aura/eval/choice-predictor-<v>.json.
// Its set, inputs, variant and votes come from the file, and the prompts must hash to what was frozen.
const frozenName = arg('--frozen')
const frozen = frozenName
  ? JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'aura', 'eval', `choice-predictor-${frozenName}.json`), 'utf8')) as {
    version: number; set: string; variant: string; votes: number; founder: boolean; hashes: Record<string, string>
  }
  : null
if (frozen) {
  for (const f of ['--set', '--variants', '--votes', '--examples', '--examples-text', '--principles', '--profile', '--profile-v2']) if (process.argv.includes(f)) { console.log(`--frozen sets ${f} itself; leave it out.`); process.exit(1) }
  process.argv.push('--set', frozen.set, '--variants', frozen.variant, '--votes', String(frozen.votes))
  if (frozen.founder && !process.argv.includes('--founder')) process.argv.push('--founder')
}
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
if (set !== 'v1' && set !== 'v2' && set !== 'v3') { console.log('--set must be v1, v2 or v3'); process.exit(1) }
const scenarioFile = (v: string) => v === 'v3' ? 'choice-scenarios-v3.json' : v === 'v2' ? 'choice-scenarios-v2.json' : 'choice-scenarios.json'
const founder = process.argv.includes('--founder')
const founderDir = join(here, '..', '..', 'aura', 'eval', 'founder')
const other = set === 'v2' ? 'v1' : 'v2'
// Set v3: the founder's answers to BOTH earlier sets are examples.
const founderBoth = founder && set === 'v3'
if (founder) {
  profilePath ??= join(founderDir, 'profile-answers-v1.json')
  if (!choicesPath && existsSync(join(founderDir, `scenario-answers-${set}.json`))) choicesPath = join(founderDir, `scenario-answers-${set}.json`)
  if (!founderBoth) examplesPath ??= join(founderDir, `scenario-answers-${other}.json`)
  if (!principlesPath && existsSync(join(founderDir, 'principles.json'))) principlesPath = join(founderDir, 'principles.json')
}
const profileV2Path = arg('--profile-v2') ?? (founder ? join(founderDir, 'profile-answers-v2.json') : undefined)
const votes = Math.max(1, Number(arg('--votes') ?? 1) || 1)
const hasExamples = Boolean(examplesPath || examplesTextPath || profileV2Path || founderBoth)
if (set === 'v1' ? !(profilePath || hasExamples || principlesPath) || !choicesPath : !picksOut && !choicesPath && !process.argv.includes('--hashes')) {
  console.log('Usage: --profile <profile-answers.json> --choices <scenario-answers.json> [--detail] [--picks-out <file>]\n   or: --set v2 --picks-out <file> [--profile <profile-answers.json>] [--choices <scenario-answers-v2.json>] [--detail]\n   add: [--examples <other-set-answers.json>] [--principles <principles-export.json>] [--picks-arm <arm>]')
  process.exit(1)
}
const base = process.env.INIT_CWD ?? process.cwd()
const read = (p: string) => JSON.parse(readFileSync(resolve(base, p), 'utf8'))
const evalDir = join(here, '..', '..', 'aura', 'eval')
const instrument = read(join(evalDir, 'intent-profile-v1.json'))
const scenarios = read(join(evalDir, scenarioFile(set))).scenarios as ChoiceScenario[]
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
const examplesSet = arg('--examples-set') ?? (set === 'v1' ? 'v2' : 'v1')
if (examplesPath && examplesSet === set) { console.log('--examples must come from the other scenario set, never the one being predicted.'); process.exit(1) }
const examplesText = (() => {
  const extra = [
    examplesTextPath ? readFileSync(resolve(base, examplesTextPath), 'utf8').trim() : '',
    profileV2Path ? profileV2AsExamples(read(join(evalDir, 'intent-profile-v2.json')), read(profileV2Path).answers) : '',
  ].filter(Boolean).join('\n\n')
  if (founderBoth) {
    const both = (['v1', 'v2'] as const).map((v) => buildExamplesText(read(join(evalDir, scenarioFile(v))).scenarios, read(join(founderDir, `scenario-answers-${v}.json`)).answers))
    // One header, both sets' decisions under it.
    const [first, second] = both
    return [first, second!.split('\n').slice(2).join('\n'), extra].filter(Boolean).join('\n\n')
  }
  if (!examplesPath) return extra
  const exScenarios = read(join(evalDir, scenarioFile(examplesSet))).scenarios as typeof scenarios
  return [buildExamplesText(exScenarios, read(examplesPath).answers), extra].filter(Boolean).join('\n\n')
})()
const profileText = profile ? buildProfileText(profile.dimensions) : ''
const principlesText = principles ? buildPrinciplesText(principles) : ''

// What a frozen predictor pins: the scenarios, the system prompts and every piece of provider context.
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
// The variant whose system prompt is pinned: the frozen one, or --hash-variant (default all+goals).
const hashVariant = frozen?.variant ?? arg('--hash-variant') ?? 'all+goals'
const promptHashes = (): Record<string, string> => ({
  scenarios: sha(JSON.stringify(scenarios)),
  system: sha(systemForArm('all', { goals: hashVariant.includes('+goals'), cases: hashVariant.includes('+cases') })),
  principles: sha(principlesText),
  profile: sha(profileText),
  examples: sha(examplesText),
})
// --hashes: print them and stop (no model calls). Used to freeze a predictor.
if (process.argv.includes('--hashes')) { console.log(JSON.stringify(promptHashes(), null, 1)); process.exit(0) }
if (frozen) {
  const now = promptHashes()
  const changed = Object.keys(frozen.hashes).filter((k) => frozen.hashes[k] !== now[k])
  if (changed.length) { console.log(`Frozen predictor v${frozen.version} no longer matches: ${changed.join(', ')} changed since it was frozen. Refusing to run.`); process.exit(1) }
  console.log(`Frozen predictor v${frozen.version}: prompts and inputs match what was frozen.`)
}

// Variants: an arm plus the optional goals and rolling methods (see the header).
interface Variant { name: string; arm: Arm; goals: boolean; rolling: boolean; cases: boolean }
const ALL_VARIANTS = ['all', 'all+goals', 'all+cases', 'all+cases+goals', 'all+rolling', 'all+goals+rolling']
const hasContext = hasExamples || Boolean(profile) || Boolean(principles)
const variantArg = arg('--variants')
const variantNames = variantArg
  ? variantArg.split(',').map((v) => v.trim()).filter(Boolean)
  : founder
    ? [...ALL_VARIANTS, ...(principles ? ['rules+examples'] : []), 'examples', 'none']
    : arms
const variants: Variant[] = variantNames.map((name) => {
  const [arm, ...mods] = name.split('+goals').join('|goals').split('+rolling').join('|rolling').split('+cases').join('|cases').split('|')
  const v = { name, arm: arm as Arm, goals: mods.includes('goals'), rolling: mods.includes('rolling'), cases: mods.includes('cases') }
  if (!(['profile', 'none', 'examples', 'rules', 'rules+examples', 'all'] as string[]).includes(v.arm)) { console.log(`Unknown variant "${name}".`); process.exit(1) }
  if (v.arm === 'all' && !hasContext) { console.log('Variant "all" needs --founder, --examples, --examples-text, --profile, --profile-v2 or --principles.'); process.exit(1) }
  if (v.arm !== 'all' && v.arm !== 'none' && !arms.includes(v.arm)) { console.log(`Variant "${name}" needs its inputs (arms available: ${arms.join(', ')}).`); process.exit(1) }
  return v
})
const rolling = variants.some((v) => v.rolling)
if (rolling && !choicesPath) { console.log('Rolling variants need --choices (or --founder): each answer joins the prompt after its scenario is predicted.'); process.exit(1) }

const picksArm = arg('--picks-arm') ?? (frozen ? frozen.variant : 'none')
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
  const similar = z.array(z.object({ earlier: z.string(), theyChose: z.string(), howAlike: z.string() }))
  const schema = v.cases && v.goals
    ? z.object({
      similar,
      goals: z.array(z.string()),
      check: z.array(z.object({ option: z.enum(ids), keeps: z.array(z.string()), givesUp: z.array(z.string()) })),
      choice: z.enum(ids),
      reason: z.string(),
    })
    : v.cases
    ? z.object({ similar, choice: z.enum(ids), reason: z.string() })
    : v.goals
    ? z.object({
      goals: z.array(z.string()),
      check: z.array(z.object({ option: z.enum(ids), keeps: z.array(z.string()), givesUp: z.array(z.string()) })),
      choice: z.enum(ids),
      reason: z.string(),
    })
    : z.object({ choice: z.enum(ids), reason: z.string() })
  const prompt = buildChoicePrompt(v.arm, s, { profileText, examplesText, principlesText, earlierText })
  try {
    const result = await generateText({ model: modelForRole(role), system: systemForArm(v.arm, { goals: v.goals, cases: v.cases }), prompt, experimental_output: Output.object({ schema }), maxRetries: 5 } as Parameters<typeof generateText>[0])
    return ((result as unknown as { experimental_output?: { choice: string } }).experimental_output?.choice) ?? null
  } catch {
    return null
  }
}

/** Majority of the votes; ties go to the earliest vote. */
function majority(picks: Array<string | null>): string | null {
  const ok = picks.filter((p): p is string => p !== null)
  if (!ok.length) return null
  const counts = new Map<string, number>()
  for (const p of ok) counts.set(p, (counts.get(p) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || ok.indexOf(a[0]) - ok.indexOf(b[0]))[0]![0]
}

// --concurrency N (default 6): model calls in flight at once. Every call is independent: a rolling
// prompt for scenario i holds only the answers to scenarios before i, fixed in advance, never
// another prediction, so running calls side by side changes nothing but the time taken.
const concurrency = Math.max(1, Number(arg('--concurrency') ?? 6) || 6)
interface Task { s: ChoiceScenario; v: Variant; earlierText: string; vote: number }
const picksIn = arg('--picks-in')
if (picksIn && picksOut) { console.log('--picks-in scores saved picks; it cannot also write --picks-out.'); process.exit(1) }
const tasks: Task[] = []
for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i]!
  // Only scenarios before this one, i.e. already predicted in series order, may be shown.
  const earlierText = rolling ? buildEarlierText(scenarios.slice(0, i), rollingAnswers) : ''
  for (const v of variants) for (let vote = 0; vote < votes; vote++) tasks.push({ s, v, earlierText: v.rolling ? earlierText : '', vote })
}
const raw = new Map<string, Array<string | null>>()
let next = 0, done = 0, lastShown = 0
const started = Date.now()
async function worker(): Promise<void> {
  while (next < tasks.length) {
    const t = tasks[next++]!
    const pick = await predictOnce(t.s, t.v, t.earlierText)
    const key = `${t.v.name}\u0000${t.s.id}`
    const list = raw.get(key) ?? Array(votes).fill(null)
    list[t.vote] = pick
    raw.set(key, list)
    done++
    const pctDone = Math.floor((done / tasks.length) * 10)
    if (pctDone > lastShown) {
      lastShown = pctDone
      const secs = (Date.now() - started) / 1000
      const left = Math.round((secs / done) * (tasks.length - done) / 60)
      process.stderr.write(`  ${done}/${tasks.length} calls${done < tasks.length ? `, about ${left} min left` : ''}\n`)
    }
  }
}
if (!picksIn) process.stderr.write(`${tasks.length} model calls, ${concurrency} at a time\n`)
if (!picksIn) await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))

const predictions: Record<string, Record<string, string | null>> = Object.fromEntries(variants.map((v) => [v.name, {}]))
if (picksIn) {
  // Score picks recorded earlier (before the answers existed); no model calls.
  const saved = read(picksIn) as { arm: string; set: string; picks: Record<string, string | null>; createdAt: string }
  if (saved.set !== set) { console.log(`--picks-in is for set ${saved.set}, not ${set}.`); process.exit(1) }
  console.log(`Scoring picks recorded ${saved.createdAt} (arm "${saved.arm}").`)
  for (const v of variants) predictions[v.name] = { ...saved.picks }
} else for (const v of variants) for (const s of scenarios) predictions[v.name]![s.id] = majority(raw.get(`${v.name}\u0000${s.id}`) ?? [])

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
