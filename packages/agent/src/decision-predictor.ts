/**
 * Aura's prediction on one of the provider's own real decisions, made before
 * they decide (sealed; see @quicksilver/aura sealed.ts).
 *
 * Method: the v3 method (everything the provider has given, then each option
 * checked against each stated goal), with two changes for real use:
 *   - the prompt says plainly that this is the provider's OWN decision in
 *     their own business (set 3 showed that questions about other owners
 *     measure something else);
 *   - the provider's journal decisions are shown last, as the most relevant
 *     examples. Set 3 answers are left out: they were mostly answered for
 *     other owners (founder, 2026-09-27).
 * Several votes are taken; when they disagree (below the threshold) Aura
 * would ask instead of act.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateText, Output } from 'ai'
import { z } from 'zod'
import { acceptedPrinciples, decisionsAsExamples, parsePrincipleExport, profileV2AsExamples, scoreProfile, tallyVotes, type Decision, type DecisionOption, type SealedPrediction } from '@quicksilver/aura'

import { buildExamplesText, buildPrinciplesText, buildProfileText, CHOICE_GOALS_METHOD, CHOICE_SYSTEM_ALL, type ChoiceScenario } from './choice-prompts.ts'
import { assertAgentDispatch } from './governance.ts'
import { modelForRole, resolveId } from './models.ts'

const here = dirname(fileURLToPath(import.meta.url))
const evalDir = join(here, '..', '..', 'aura', 'eval')

/** Load the repository's .env into process.env (values already set win). Never prints values. */
export function loadRepoEnv(): void {
  for (let dir = here, i = 0; i < 6; i++, dir = dirname(dir)) {
    const candidate = join(dir, '.env')
    if (!existsSync(candidate)) continue
    for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2')
    }
    return
  }
}

export const OWN_DECISION_NOTE = 'This is a real decision in the provider\'s OWN business, described by the provider. Predict what they themselves will choose, as the owner.'

export const JOURNAL_PREAMBLE = 'Most relevant of all: real decisions from the provider\'s own business, most recent last. Weigh these above everything else when a situation resembles one of them.'

export interface PredictorContext { principlesText: string; profileText: string; examplesText: string; journalText: string }

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** Build everything the provider has given, from the founder's committed files, their principles and their journal. */
export function founderContext(opts: { principlesPath?: string; journal?: Decision[] } = {}): PredictorContext {
  const founder = join(evalDir, 'founder')
  const principlesFile = opts.principlesPath && existsSync(opts.principlesPath) ? opts.principlesPath : join(founder, 'principles.json')
  const principles = existsSync(principlesFile) ? acceptedPrinciples(parsePrincipleExport(readJson(principlesFile))) : []
  const profile = scoreProfile(readJson(join(evalDir, 'intent-profile-v1.json')), readJson(join(founder, 'profile-answers-v1.json')).answers)
  const sets = (['v1', 'v2'] as const).map((v) => buildExamplesText(readJson(join(evalDir, v === 'v1' ? 'choice-scenarios.json' : 'choice-scenarios-v2.json')).scenarios as ChoiceScenario[], readJson(join(founder, `scenario-answers-${v}.json`)).answers))
  const examplesText = [sets[0], sets[1]!.split('\n').slice(2).join('\n'), profileV2AsExamples(readJson(join(evalDir, 'intent-profile-v2.json')), readJson(join(founder, 'profile-answers-v2.json')).answers)].filter(Boolean).join('\n\n')
  const journal = (opts.journal ?? []).filter((d) => d.source === 'journal' || d.source === 'shadow')
  const journalText = journal.length ? `${JOURNAL_PREAMBLE}\n${decisionsAsExamples(journal).split('\n').slice(2).join('\n')}` : ''
  return { principlesText: principles.length ? buildPrinciplesText(principles) : '', profileText: buildProfileText(profile.dimensions), examplesText, journalText }
}

/** The system prompt and user prompt for one own decision. Pure. */
export function ownDecisionPrompt(ctx: PredictorContext, d: { situation: string; options: DecisionOption[]; category?: string }): { system: string; prompt: string } {
  return {
    system: `${CHOICE_SYSTEM_ALL}\n${CHOICE_GOALS_METHOD}\n${OWN_DECISION_NOTE}`,
    prompt: [ctx.principlesText, ctx.profileText, ctx.examplesText, ctx.journalText].filter((t) => t.trim()).join('\n\n') + '\n\n' + [
      OWN_DECISION_NOTE,
      d.category ? `Area: ${d.category}` : '',
      `Situation: ${d.situation}`,
      'Options:',
      ...d.options.map((o) => `- ${o.id}: ${o.text}`),
    ].filter(Boolean).join('\n'),
  }
}

export const PREDICTOR_METHOD = 'v3-goals+own-decision+journal'

/** Predict the provider's choice with `votes` independent calls; Aura would act only at `threshold` confidence. */
export async function predictOwnDecision(ctx: PredictorContext, d: { situation: string; options: DecisionOption[]; category?: string }, opts: { votes?: number; threshold?: number; now?: Date } = {}): Promise<SealedPrediction | null> {
  const votes = opts.votes ?? 3, threshold = opts.threshold ?? 1
  const role = (process.env.QUICKSILVER_INTENT_ROLE || 'planner') as 'planner'
  const ids = d.options.map((o) => o.id) as [string, ...string[]]
  const schema = z.object({
    goals: z.array(z.string()),
    check: z.array(z.object({ option: z.enum(ids), keeps: z.array(z.string()), givesUp: z.array(z.string()) })),
    choice: z.enum(ids),
    reason: z.string(),
  })
  const { system, prompt } = ownDecisionPrompt(ctx, d)
  const one = async (): Promise<{ choice: string; reason: string } | null> => {
    assertAgentDispatch('nuera-quicksilver:intent', 'reasoning', 'low')
    try {
      const r = await generateText({ model: modelForRole(role), system, prompt, experimental_output: Output.object({ schema }), maxRetries: 5 } as Parameters<typeof generateText>[0])
      return (r as unknown as { experimental_output?: { choice: string; reason: string } }).experimental_output ?? null
    } catch { return null }
  }
  const results = await Promise.all(Array.from({ length: votes }, one))
  const t = tallyVotes(results.map((r) => r?.choice ?? null), threshold)
  if (!t) return null
  return { ...t, threshold, reason: results.find((r) => r?.choice === t.pick)?.reason, method: `${PREDICTOR_METHOD}/${resolveId(role, 'azure')}`, at: (opts.now ?? new Date()).toISOString() }
}
