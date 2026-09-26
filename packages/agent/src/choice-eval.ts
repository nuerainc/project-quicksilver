/**
 * Blind model test of choice prediction, on Azure:
 *
 *   npm run aura:choices:model -- --profile <profile-answers.json> --choices <scenario-answers.json> [--detail]
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
import { existsSync, readFileSync } from 'node:fs'
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
const profilePath = arg('--profile'), choicesPath = arg('--choices')
if (!profilePath || !choicesPath) { console.log('Usage: --profile <profile-answers.json> --choices <scenario-answers.json> [--detail]'); process.exit(1) }
const base = process.env.INIT_CWD ?? process.cwd()
const read = (p: string) => JSON.parse(readFileSync(resolve(base, p), 'utf8'))
const evalDir = join(here, '..', '..', 'aura', 'eval')
const instrument = read(join(evalDir, 'intent-profile-v1.json'))
const scenarios = read(join(evalDir, 'choice-scenarios.json')).scenarios as Array<{ id: string; category: string; providers?: string; said: string; situation: string; decision: string; options: Record<string, string> }>
const profile = scoreProfile(instrument, read(profilePath).answers)

const SYSTEM = `You predict what an intent provider (a person, group or organization that an automated company acts for) would choose.
Read what the provider said, the situation and the options. Pick the ONE option this provider would most want, given what they said and clearly meant.
Pick "ask" only if acting without asking would likely go against what they want.
Answer with the option id and one short reason.`

const profileText = [
  'The provider took a short intent profile. Each reading runs from one pole to the other, with a confidence out of 10 (low confidence means their answers were split or depended on context):',
  ...profile.dimensions.map((d) => `- ${d.left} vs ${d.right}: ${d.lean} (confidence ${d.confidence}/10)`),
  'They listed no red lines beyond the law.',
].join('\n')

const role = (process.env.QUICKSILVER_INTENT_ROLE || 'planner') as 'planner'
console.log(`Model: ${resolveId(role, 'azure')} · ${scenarios.length} scenarios · two arms (profile, none)`)

async function predict(s: (typeof scenarios)[number], withProfile: boolean): Promise<string | null> {
  assertAgentDispatch('nuera-quicksilver:intent', 'reasoning', 'low')
  const ids = Object.keys(s.options) as [string, ...string[]]
  const schema = z.object({ choice: z.enum(ids), reason: z.string() })
  const prompt = [
    withProfile ? profileText : 'Nothing else is known about the provider.',
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

const predictions: Record<'profile' | 'none', Record<string, string | null>> = { profile: {}, none: {} }
for (const s of scenarios) {
  predictions.profile[s.id] = await predict(s, true)
  predictions.none[s.id] = await predict(s, false)
}

// Only now read the provider's answers, to score.
const actual = Object.fromEntries(Object.entries(read(choicesPath).answers as Record<string, { choice?: string }>).filter(([, v]) => v?.choice).map(([k, v]) => [k, v.choice!]))
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
for (const arm of ['profile', 'none'] as const) {
  const scored = scenarios.filter((s) => actual[s.id])
  const right = scored.filter((s) => predictions[arm][s.id] === actual[s.id]).length
  const failed = scored.filter((s) => predictions[arm][s.id] === null).length
  console.log(`Arm "${arm}": ${right}/${scored.length} = ${pct(right / scored.length)}${failed ? ` (${failed} model errors counted as misses)` : ''} — chance 25%`)
  if (process.argv.includes('--detail')) for (const s of scored) if (predictions[arm][s.id] !== actual[s.id]) console.log(`  ${s.id} (${s.category}): predicted ${predictions[arm][s.id] ?? 'error'}, actual ${actual[s.id]}`)
}
