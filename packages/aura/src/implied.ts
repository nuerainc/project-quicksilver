/**
 * Implied intent: values an objective clearly implies without stating them.
 *
 * "We run a feed store" settles the business type; "we sell hay to local
 * ranchers" settles how the business makes money. Asking about these wastes
 * the provider's time (the first ranking test showed Aura doing exactly that).
 *
 * Implied values are recorded as AGENT_INFERRED, never HUMAN_SPECIFIED:
 *   - each carries the exact quote that implies it and the reason,
 *   - confidence is 0.8, high enough not to be asked about by default, but
 *     below 1, so the provider can correct it and any evidence can revise it.
 * Only literal patterns are used; nothing is guessed from outside knowledge.
 */

export type ImpliedSlot = 'business_type' | 'revenue_model' | 'success_metric' | 'data_sources' | 'cadence' | 'scope'

export interface ImpliedValue {
  slot: ImpliedSlot
  value: string
  quote: string
  reason: string
}

export const IMPLIED_CONFIDENCE = 0.8

/** Nouns that name a kind of business ("we run a car wash", "our roastery"). v4 widened the list (2026-09-26). */
const BUSINESS_NOUNS = [
  'store', 'shop', 'company', 'business', 'farm', 'restaurant', 'truck', 'studio', 'practice', 'agency', 'firm', 'clinic',
  'salon', 'bakery', 'cafe', 'café', 'ranch', 'garage', 'service', 'boutique', 'gym', 'diner', 'motel', 'hotel', 'campground',
  'bookstore', 'roastery', 'daycare', 'car wash', 'yard', 'crew', 'dealership', 'brewery', 'winery', 'dairy', 'nursery',
  'greenhouse', 'kennel', 'pharmacy', 'print shop', 'machine shop', 'body shop', 'co-op', 'cooperative', 'market', 'orchard',
].map((n) => n.replace(/ /g, '\\s+')).join('|')

const GENERIC = /^(?:business|company|firm|team|thing|one|group)$/i
const STOP = /\s+(?:that|which|who|with|for|in|on|to|where|so|but|because)\b.*$/i

function clean(s: string): string {
  return s.replace(STOP, '').replace(/^(?:small|little|local|tiny)\s+/i, '').replace(/[\s,.;:!?]+$/, '').trim()
}

export function inferImplied(objective: string): ImpliedValue[] {
  const text = objective.normalize('NFKC')
  const out: ImpliedValue[] = []
  const add = (v: ImpliedValue) => {
    if (!out.some((o) => o.slot === v.slot) && v.value.length >= 3) out.push(v)
  }

  // "we sell hay and alfalfa to local ranchers", "my shop sells used farm equipment"
  const sell = /\b(?:we|i|(?:my|our) (?:\w+ ){0,2}(?:shop|store|farm|company|business|studio))\s+sells?\s+([^.,;!?]+?)(?:\s+to\s+([^.,;!?]+))?(?=[.,;!?]|$)/i.exec(text)
    ?? /\bbusiness\s+(?:selling|that sells)\s+([^.,;!?]+?)(?:\s+to\s+([^.,;!?]+))?(?=[.,;!?]|$)/i.exec(text)
  if (sell) {
    const what = clean(sell[1]!)
    const to = sell[2] ? clean(sell[2]) : ''
    const seller = /\b(?:my|our) ((?:\w+ ){0,2}(?:shop|store|farm|studio))\b/i.exec(sell[0])?.[1]
    add({ slot: 'business_type', value: seller ? `${seller} selling ${what}` : `Sells ${what}`, quote: sell[0].trim(), reason: 'the objective says what the business sells' })
    add({ slot: 'revenue_model', value: `Sales of ${what}${to ? ` to ${to}` : ''}`, quote: sell[0].trim(), reason: 'the business earns by selling these goods' })
  }

  // "we run a feed store", "I own a coffee shop", "I run a small landscaping company", "I operate a food truck"
  const runs = new RegExp(String.raw`\b(?:we|i)\s+(?:run|own|operate|manage|have)\s+(?:a|an)\s+((?:[a-z][\w'-]*\s+){0,4}?(?:${BUSINESS_NOUNS}))\b`, 'i').exec(text)
  if (runs) {
    const kind = clean(runs[1]!)
    if (!GENERIC.test(kind)) add({ slot: 'business_type', value: kind, quote: runs[0].trim(), reason: 'the objective names the kind of business' })
  }

  // "our restaurant", "my farm's records", "my practice", "our agency"
  const owned = new RegExp(String.raw`\b(?:my|our)\s+((?:(?!(?:family|own|small|little)\b)[a-z][\w'-]*\s+){0,2}?(?:${BUSINESS_NOUNS}))(?:'s)?\b`, 'i').exec(text)
  if (owned) {
    // "my existing business" names no kind of business: drop non-descriptive words and skip generic nouns.
    const kind = owned[1]!.toLowerCase().replace(/\b(?:existing|current|new|whole|entire)\s+/g, '').trim()
    if (!GENERIC.test(kind)) add({ slot: 'business_type', value: kind, quote: owned[0].trim(), reason: 'the objective names the kind of business' })
  }

  // What "worked" means, when the objective says it in words rather than numbers.
  const metrics: Array<[RegExp, string]> = [
    [/\b(?:where|why) (?:we|i|it) (?:lose|loses|are losing|is losing) money\b|\bloses? money\b/i, 'Profitability: find and stop losses'],
    [/\bmargins?\b/i, 'Margins'],
    [/\bcash[- ]flow\b/i, 'Cash flow'],
    [/\bcut (?:our |my )?costs\b|\breduce (?:our |my )?costs\b/i, 'Lower costs'],
    [/\bwhich (?:\w+ ){0,2}(?:items?|products?|services?) to (?:drop|cut|keep)\b/i, 'Profit by item'],
  ]
  for (const [pattern, value] of metrics) {
    const m = pattern.exec(text)
    if (m) { add({ slot: 'success_metric', value, quote: m[0].trim(), reason: 'the objective says what a good outcome looks like' }); break }
  }

  // "connect our books and inventory", "connect my farm's records"
  const conn = /\bconnect\s+(?:my|our)\s+([^.;!?]+?)(?=\s+and\s+(?:tell|help|show|find|let|give)\b|[.;!?]|$)/i.exec(text)
  if (conn) add({ slot: 'data_sources', value: conn[1]!.trim(), quote: conn[0].trim(), reason: 'the objective names the records to connect' })

  // Recurring work: how often, and what it covers.
  const cadence = /\b(every (?:day|morning|evening|week|month|monday|friday)|each (?:day|week|month)|daily|weekly|monthly|day[- ]to[- ]day)\b/i.exec(text)
  if (cadence) {
    const c = cadence[1]!.toLowerCase()
    const value = /day|daily|morning|evening/.test(c) ? 'Daily' : /week|monday|friday/.test(c) ? 'Weekly' : 'Monthly'
    add({ slot: 'cadence', value, quote: cadence[0].trim(), reason: 'the objective says how often' })
  }
  const scope = /\b(?:report on|track|watch|handle|run|automate|keep running|send me (?:a |an )?(?:\w+ )?(?:report|summary|brief) on)\s+(?:the |our |my )?([^.,;:!?]+?)(?=\s+(?:and (?:ask|flag|warn|add)|on your own|within|hands[- ]off|but)\b|[.,;:!?]|$)/i.exec(text)
  if (scope) add({ slot: 'scope', value: scope[1]!.trim(), quote: scope[0].trim(), reason: 'the objective names the work to cover' })

  return out
}
