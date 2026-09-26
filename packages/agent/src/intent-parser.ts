/**
 * Model-based objective parser for the Aura intent layer.
 *
 * Same output shape as the rule-based baseline (`ParsedObjective`), with one
 * extra safeguard: every value must come with a quote, and the quote must
 * appear in the objective text. A value whose quote isn't in the text is
 * dropped, so the model can't invent a budget or a deadline. The kernel's
 * agent registry must approve `nuera-quicksilver:intent` for the dispatch.
 *
 * Model role: QUICKSILVER_INTENT_ROLE (planner | reviewer | router | executor),
 * default "planner", using the same deployments and keys as the other agents.
 */
import { generateText, Output } from 'ai'
import { z } from 'zod'

import { AUTONOMY_DEPTHS, CONSTRAINT_TYPES, OPERATING_MODES, type ParsedObjective, type Span } from '@quicksilver/aura'

import { assertAgentDispatch } from './governance.ts'
import { modelForRole, type QuicksilverModelRole } from './models.ts'

const constraintIds = CONSTRAINT_TYPES.map((c) => c.id) as [string, ...string[]]

const quoted = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, quote: z.string().describe('The exact words from the objective this came from.') }).nullable()

// Strict structured output: every key required; "not stated" is null.
export const IntentParseSchema = z.object({
  mode: z.object({ value: z.enum(OPERATING_MODES), quote: z.string() }).nullable()
    .describe('genesis = start something new or make money from scratch; onboard = a business that already exists; operate = recurring or ongoing work. null if the text does not say.'),
  budget: quoted(z.number()).describe('Money the person will spend or invest, in USD. Not revenue goals, not thresholds to watch.'),
  revenueTarget: quoted(z.number()).describe('The money goal stated (revenue, sales, profit or savings), in USD. If a current figure and a goal both appear, the goal.'),
  timeframeDays: quoted(z.number()).describe('Duration in days (week = 7, month = 30, quarter = 90, year = 360 when stated as "12 months", else 365).'),
  weeklyHours: quoted(z.number()).describe('Hours per week the person can give.'),
  autonomy: z.object({ value: z.enum(AUTONOMY_DEPTHS), quote: z.string() }).nullable()
    .describe('advise = advice or read-only; act-with-approval = ask before acting; act-within-limits = act on its own. null if not stated.'),
  constraints: z.array(z.object({ id: z.enum(constraintIds), quote: z.string() }))
    .describe(`Only these ids: ${CONSTRAINT_TYPES.map((c) => `${c.id} (${c.label})`).join('; ')}. "side hustle", "on the side", nights and weekends imply keep_day_job.`),
})

export type IntentParse = z.infer<typeof IntentParseSchema>

const SYSTEM = `You extract structured fields from a business objective for Nuera Quicksilver.
Rules:
- Record only what the text states. Never guess a number, a date or a mode.
- Every value needs a quote copied exactly from the objective.
- "$2k" is 2000; "$10k" is 10000.
- A threshold to watch ("warn me under $2,000") is neither a budget nor a revenue target.
- If the text does not state a field, return null (or an empty list for constraints).`

/** Find `quote` in `text` (case-insensitive); null when it isn't there. */
function locate(text: string, quote: string | undefined): Span | null {
  if (!quote?.trim()) return null
  const index = text.toLowerCase().indexOf(quote.trim().toLowerCase())
  return index < 0 ? null : { text: text.slice(index, index + quote.trim().length), index }
}

/** Convert the model's answer into a `ParsedObjective`, dropping anything not grounded in the text. */
export function toParsedObjective(objective: string, raw: IntentParse): ParsedObjective & { dropped: string[] } {
  const dropped: string[] = []
  const grounded = <V>(field: string, item: { value: V; quote: string } | null) => {
    if (!item) return null
    const span = locate(objective, item.quote)
    if (!span) {
      dropped.push(field)
      return null
    }
    return { value: item.value, span }
  }
  const mode = grounded('mode', raw.mode)
  const autonomy = grounded('autonomy', raw.autonomy)
  return {
    mode: mode ? { value: mode.value, cue: mode.span } : null,
    budget: grounded('budget', raw.budget),
    revenueTarget: grounded('revenueTarget', raw.revenueTarget),
    timeframeDays: grounded('timeframeDays', raw.timeframeDays),
    weeklyHours: grounded('weeklyHours', raw.weeklyHours),
    autonomy: autonomy ? { value: autonomy.value, cue: autonomy.span } : null,
    constraints: [...new Map(raw.constraints.flatMap((c) => {
      const span = locate(objective, c.quote)
      if (!span) {
        dropped.push(`constraint:${c.id}`)
        return []
      }
      const label = CONSTRAINT_TYPES.find((t) => t.id === c.id)?.label ?? c.id
      return [[c.id, { id: c.id, label, span }] as const]
    })).values()],
    dropped,
  }
}

export async function parseObjectiveWithModel(objective: string, options: { role?: QuicksilverModelRole; signal?: AbortSignal } = {}): Promise<ParsedObjective> {
  assertAgentDispatch('nuera-quicksilver:intent', 'reasoning', 'low')
  const role = options.role ?? ((process.env.QUICKSILVER_INTENT_ROLE as QuicksilverModelRole | undefined) || 'planner')
  const result = await generateText({
    model: modelForRole(role),
    system: SYSTEM,
    prompt: `Objective:\n"""${objective.slice(0, 2_000)}"""`,
    experimental_output: Output.object({ schema: IntentParseSchema }),
    maxRetries: 2,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  } as Parameters<typeof generateText>[0])
  const raw = (result as unknown as { experimental_output?: IntentParse }).experimental_output
  if (!raw) throw new Error('Model did not return structured output.')
  const { dropped: _dropped, ...parsed } = toParsedObjective(objective, raw)
  return parsed
}
