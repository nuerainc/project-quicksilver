import {
  DecisionConflictError,
  newDecisionId,
  prequentialOnDecisions,
  recordDecision,
  verdictsAsDecisions,
  type Decision,
  type DecisionStore,
  type IntentGraphStore,
} from '@quicksilver/aura'
import type { AccessController, Principal } from '@quicksilver/kernel/identity'

import type { ShadowStore } from './shadow-api.ts'

/**
 * Aura decision journal on the host.
 *
 *   POST /api/decisions   { situation, options: [text | {id?, text}] (2–5), chosen, note?, category? }   intent:provide, humans only
 *   GET  /api/decisions   ?limit=n (default 50)                                                         decision:read
 *
 * The GET returns journal entries plus judged shadow recommendations (as
 * accept / modify / reject decisions, derived on read), newest first, and the
 * prequential baseline over all of them. The baseline is labeled as such: a
 * keyword-feature learner, not Aura's model. Nothing here acts or grants.
 */

export interface DecisionApiDeps {
  store: DecisionStore
  /** When present, judged shadow recommendations are listed and scored as decisions too. */
  shadow?: { store: ShadowStore; graphs: IntentGraphStore }
  now?: () => number
}

export interface DecisionApiContext {
  method: string
  parts: string[]
  query?: URLSearchParams
  principal: Principal
  tenantId: string
  access: AccessController
  readBody: () => Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }>
}

type Response = { status: number; body: unknown }

/** Journal entries and shadow verdicts, as decisions, oldest first. */
export async function allDecisions(deps: Pick<DecisionApiDeps, 'store' | 'shadow'>): Promise<Decision[]> {
  const journal = await deps.store.list()
  const shadow: Decision[] = []
  if (deps.shadow) {
    for (const g of await deps.shadow.graphs.list().catch(() => [])) {
      const { log } = await deps.shadow.store.load(g.id).catch(() => ({ log: { recommendations: [] } }))
      shadow.push(...verdictsAsDecisions(log, { intentId: g.id }))
    }
  }
  return [...journal, ...shadow].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

export async function handleDecisionRoute(ctx: DecisionApiContext, deps: DecisionApiDeps): Promise<Response | undefined> {
  const { method, parts, principal, access, tenantId } = ctx
  if (parts[1] !== 'decisions' || parts.length !== 2) return undefined
  const allow = (permission: 'intent:provide' | 'decision:read'): Response | undefined => {
    const d = access.authorize(principal, permission, { tenantId, kind: 'intent' })
    return d.allowed ? undefined : { status: 403, body: { error: d.reasons.join(' ') } }
  }

  if (method === 'POST') {
    const denied = allow('intent:provide')
    if (denied) return denied
    const body = await ctx.readBody()
    if (!body.ok) return { status: body.status, body: { error: body.error } }
    const input = (body.value ?? {}) as Record<string, unknown>
    const now = new Date(deps.now?.() ?? Date.now())
    const actor = { id: principal.id, kind: principal.kind === 'human' ? 'human' as const : principal.kind === 'agent' ? 'agent' as const : 'service' as const }
    // Logged through the journal only; shadow and scenario decisions come from their own records.
    const r = recordDecision(actor, { situation: input.situation, options: input.options, chosen: input.chosen, note: input.note, category: input.category, source: 'journal' }, { id: newDecisionId(now), now })
    if (!r.ok) return { status: r.status, body: { error: r.reason } }
    try {
      await deps.store.append(r.decision)
    } catch (error) {
      if (error instanceof DecisionConflictError) return { status: 409, body: { error: error.message } }
      throw error
    }
    return { status: 201, body: { decision: r.decision } }
  }

  if (method === 'GET') {
    const denied = allow('decision:read')
    if (denied) return denied
    const limit = Math.min(500, Math.max(1, Number(ctx.query?.get('limit') ?? 50) || 50))
    const all = await allDecisions(deps)
    const counts = { journal: 0, shadow: 0, scenario: 0 }
    for (const d of all) counts[d.source]++
    return { status: 200, body: { decisions: all.slice().reverse().slice(0, limit), total: all.length, counts, baseline: prequentialOnDecisions(all) } }
  }

  return { status: 405, body: { error: 'Use GET or POST.' } }
}
