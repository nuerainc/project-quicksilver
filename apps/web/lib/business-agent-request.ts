import type { BusinessAgentKey } from '@quicksilver/agent'

// Keep this request boundary intentionally static: importing the full agent
// runtime here would initialize model/provider modules before validation.
export type BusinessAgentChoice = BusinessAgentKey | 'auto'
const BUSINESS_AGENT_KEYS: readonly BusinessAgentChoice[] = Object.freeze([
  'auto', 'research', 'offer', 'content', 'outreach', 'sales', 'fulfillment', 'finance',
])

export interface BusinessAgentRequestBody {
  agentKey: BusinessAgentChoice
  objective: string
  context?: string[]
}

/** Validate the bounded input contract before any model or Sanity context work. */
export function parseBusinessAgentRequest(value: unknown): BusinessAgentRequestBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => !['agentKey', 'objective', 'context'].includes(key))) return null
  if (typeof body.agentKey !== 'string' || !BUSINESS_AGENT_KEYS.includes(body.agentKey as BusinessAgentChoice)) return null
  if (typeof body.objective !== 'string' || body.objective.trim().length < 3 || body.objective.length > 2_000) return null
  if (body.context !== undefined && (!Array.isArray(body.context) || body.context.length > 20 || body.context.some((item) => typeof item !== 'string' || item.length > 4_000))) return null
  return {
    agentKey: body.agentKey as BusinessAgentChoice,
    objective: body.objective.trim(),
    ...(body.context ? { context: body.context as string[] } : {}),
  }
}

const SPECIALIST_TERMS: ReadonlyArray<{ key: BusinessAgentKey; label: string; terms: readonly string[] }> = [
  { key: 'finance', label: 'finance wording', terms: ['cash', 'cost', 'budget', 'margin', 'revenue', 'expense', 'financial', 'runway', 'forecast'] },
  { key: 'fulfillment', label: 'delivery or operations wording', terms: ['fulfillment', 'fulfilment', 'delivery', 'shipment', 'shipping', 'order', 'inventory', 'service operations'] },
  { key: 'sales', label: 'sales wording', terms: ['sales', 'pipeline', 'prospect', 'lead', 'close rate', 'conversion', 'deal'] },
  { key: 'outreach', label: 'outreach wording', terms: ['outreach', 'campaign', 'email', 'audience', 'contact customers', 'reach customers'] },
  { key: 'content', label: 'content wording', terms: ['content', 'draft', 'blog', 'article', 'newsletter', 'social post', 'write a post'] },
  { key: 'offer', label: 'offer-design wording', terms: ['offer', 'pricing', 'value proposition', 'positioning', 'package', 'packaging'] },
  { key: 'research', label: 'research wording', terms: ['research', 'competitor', 'competition', 'market', 'evidence', 'industry', 'landscape'] },
]

/** Simple, explainable intent routing for Work mode; this never authorizes effects. */
export function selectBusinessAgent(objective: string): { key: BusinessAgentKey; mode: 'keyword' | 'fallback'; reason: string } {
  const normalized = objective.toLocaleLowerCase('en-US')
  const matches = SPECIALIST_TERMS.flatMap(({ key, label, terms }) => {
    const positions = terms.map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const plural = term.endsWith('s') ? '' : 's?'
      const match = new RegExp(`(^|[^a-z0-9])${escaped}${plural}($|[^a-z0-9])`).exec(normalized)
      return match ? match.index + match[1].length : -1
    }).filter((position) => position >= 0)
    return positions.length ? [{ key, label, position: Math.min(...positions) }] : []
  }).sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
  if (matches.length) return { key: matches[0].key, mode: 'keyword', reason: `Matched ${matches[0].label}.` }
  return { key: 'research', mode: 'fallback', reason: 'No specialist phrase matched; routed to Research as the read-only default.' }
}
