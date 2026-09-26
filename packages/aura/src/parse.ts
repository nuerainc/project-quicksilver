import type { AutonomyDepth, OperatingMode } from './types.ts'

/**
 * Rule-based baseline objective parser.
 *
 * It reads only what the human literally wrote and reports every value with
 * the exact span it came from. It never guesses a number. It is the baseline
 * the model-based parser must beat on the labeled evaluation set, and the
 * fallback when no model is configured.
 */

export interface Span {
  text: string
  index: number
}

export interface ParsedObjective {
  mode: { value: OperatingMode; cue: Span } | null
  budget: { value: number; span: Span } | null
  revenueTarget: { value: number; span: Span } | null
  timeframeDays: { value: number; span: Span } | null
  weeklyHours: { value: number; span: Span } | null
  autonomy: { value: AutonomyDepth; cue: Span } | null
  constraints: Array<{ id: string; label: string; span: Span }>
}

/** A structured parser; the model-based parser implements the same shape. */
export type ObjectiveParser = (objective: string) => ParsedObjective | Promise<ParsedObjective>

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|m|million)?\b|\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|m|million)?\s*(?:dollars|usd|bucks)\b/gi
const BUDGET_CUE = /\b(budget|spend|spending|invest|investing|investment|with|start(?:ing)? with|have|capital|seed|put in|up to|under|at most|no more than|max(?:imum)?)\b/i
const REVENUE_CUE = /\b(make|earn|earning|revenue|sales|profit|income|generate|bring in|reach|hit|mrr|per month|a month|monthly)\b/i

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, thirty: 30, sixty: 60, ninety: 90 }
const UNIT_DAYS: Record<string, number> = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, quarter: 90, quarters: 90, year: 365, years: 365 }
const TIMEFRAME = /\b(?:in|within|over|for|by the end of|next|the next|inside of?)\s+(?:the\s+)?(?:next\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirty|sixty|ninety)\s*[- ]?\s*(days?|weeks?|months?|quarters?|years?)\b|\b(\d+)[- ](day|week|month|year)\b/i
const HOURS = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:a|per|each|\/)\s*week\b/i

const MODE_CUES: Array<{ mode: OperatingMode; pattern: RegExp }> = [
  { mode: 'genesis', pattern: /\b(start(?:ing)? (?:a|an|my own|a new) (?:\w+ ){0,2}(?:business|company|shop|store|brand|venture|side hustle)|from scratch|side hustle|make (?:some |extra )?money|launch (?:a|an) (?:\w+ ){0,2}(?:business|product|store|shop|service)|new (?:business|venture)|build (?:a|an) (?:\w+ ){0,2}business|turn \$?\d+\S* into)\b/i },
  { mode: 'onboard', pattern: /\b(my (?:\w+ ){0,2}(?:business|company|shop|store|farm|practice|agency|restaurant|studio|firm)|our (?:\w+ ){0,2}(?:business|company|shop|store|farm|team|practice|agency|restaurant|studio|firm)|we (?:sell|run|own|operate|make|offer|have)|i (?:own|run|operate) (?:a|an|my)|existing business|connect (?:my|our)|onboard)\b/i },
  { mode: 'operate', pattern: /\b(keep (?:running|doing|the)|every (?:day|week|month|morning)|each (?:day|week|month)|ongoing|day[- ]to[- ]day|weekly|daily|monthly report|run (?:the|our|my) (?:\w+ ){0,2}(?:operations|books|payroll|inventory|reports?)|automate (?:the|our|my))\b/i },
]

const AUTONOMY_CUES: Array<{ value: AutonomyDepth; pattern: RegExp }> = [
  { value: 'advise', pattern: /\b(just (?:advise|tell me|suggest)|only (?:advise|suggest|recommend)|advice only|don'?t (?:do|change|act on) anything|read[- ]only)\b/i },
  { value: 'act-with-approval', pattern: /\b(ask me (?:first|before)|with my approval|i (?:want to|will) approve|check with me|run it by me|approve (?:each|every|all))\b/i },
  { value: 'act-within-limits', pattern: /\b(on (?:its|your) own|without asking|autonomously|fully automat\w*|hands[- ]off)\b/i },
]

const CONSTRAINT_CUES: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'no_paid_ads', label: 'No paid advertising', pattern: /\b(?:no|without|avoid(?:ing)?|don'?t (?:use|run|want)) (?:any )?(?:paid )?(?:ads|advertising|ad spend)\b/i },
  { id: 'no_debt', label: 'No debt or loans', pattern: /\b(?:no|without|avoid(?:ing)?|not taking (?:on )?) (?:any )?(?:debt|loans?|credit)\b/i },
  { id: 'no_employees', label: 'No employees', pattern: /\b(?:no|without) (?:employees|staff|hiring|hires)\b|\bsolo\b|\bjust me\b/i },
  { id: 'digital_only', label: 'Digital products and services only', pattern: /\b(?:digital[- ]only|only digital|no physical (?:products|inventory|goods)|no inventory|online only|only online)\b/i },
  { id: 'no_customer_contact', label: 'No outbound messages to customers without approval', pattern: /\b(?:don'?t|do not|never) (?:email|message|contact|text) (?:my |our )?customers\b/i },
  { id: 'keep_day_job', label: 'Must fit around a full-time job', pattern: /\b(?:day job|full[- ]time job|while (?:i )?work(?:ing)?|nights and weekends|evenings and weekends|on the side)\b/i },
]

/** The constraint catalog both parsers map to (ids and labels only). */
export const CONSTRAINT_TYPES: ReadonlyArray<{ id: string; label: string }> = CONSTRAINT_CUES.map(({ id, label }) => ({ id, label }))

export function parseObjectiveBaseline(objective: string): ParsedObjective {
  const text = objective.normalize('NFKC')
  return {
    mode: firstCue(text, MODE_CUES),
    ...money(text),
    timeframeDays: timeframe(text),
    weeklyHours: hours(text),
    autonomy: firstCue(text, AUTONOMY_CUES),
    constraints: CONSTRAINT_CUES.flatMap((c) => {
      const m = c.pattern.exec(text)
      return m ? [{ id: c.id, label: c.label, span: { text: m[0], index: m.index } }] : []
    }),
  }
}

function firstCue<T>(text: string, cues: Array<{ pattern: RegExp } & ({ mode: T } | { value: T })>): { value: T; cue: Span } | null {
  for (const c of cues) {
    const m = c.pattern.exec(text)
    if (m) return { value: ('mode' in c ? c.mode : c.value) as T, cue: { text: m[0], index: m.index } }
  }
  return null
}

function money(text: string): Pick<ParsedObjective, 'budget' | 'revenueTarget'> {
  let budget: ParsedObjective['budget'] = null
  let revenueTarget: ParsedObjective['revenueTarget'] = null
  for (const m of text.matchAll(MONEY)) {
    const raw = (m[1] ?? m[3] ?? '').replace(/,/g, '')
    const scale = (m[2] ?? m[4] ?? '').toLowerCase()
    const value = Number(raw) * (scale === 'k' || scale === 'thousand' ? 1_000 : scale === 'm' || scale === 'million' ? 1_000_000 : 1)
    if (!Number.isFinite(value) || value <= 0) continue
    const before = text.slice(Math.max(0, m.index! - 40), m.index!)
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 25)
    const span = { text: m[0].trim(), index: m.index! }
    const revenueContext = REVENUE_CUE.test(before.split(/[.;,]/).at(-1) ?? '') || /^\s*(?:a|per|\/)\s*(?:month|mo|week|year)|^\s*(?:in )?(?:revenue|sales|profit|income)/i.test(after)
    const budgetContext = BUDGET_CUE.test(before.split(/[.;]/).at(-1) ?? '') || /^\s*(?:budget|to (?:spend|invest|start|work with))/i.test(after)
    if (revenueContext && !revenueTarget && !/^\s*(?:budget|to spend)/i.test(after)) revenueTarget = { value, span }
    else if (budgetContext && !budget) budget = { value, span }
    else if (!budget && !revenueContext) budget = { value, span }
  }
  return { budget, revenueTarget }
}

function timeframe(text: string): ParsedObjective['timeframeDays'] {
  const m = TIMEFRAME.exec(text)
  if (!m) return null
  const countText = (m[1] ?? m[3] ?? '').toLowerCase()
  const unit = (m[2] ?? m[4] ?? '').toLowerCase()
  const count = /^\d+$/.test(countText) ? Number(countText) : NUMBER_WORDS[countText]
  const days = UNIT_DAYS[unit] ?? UNIT_DAYS[`${unit}s`]
  if (!count || !days) return null
  return { value: count * days, span: { text: m[0], index: m.index } }
}

function hours(text: string): ParsedObjective['weeklyHours'] {
  const m = HOURS.exec(text)
  return m ? { value: Number(m[1]), span: { text: m[0], index: m.index } } : null
}
