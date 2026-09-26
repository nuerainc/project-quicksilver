import { randomUUID } from 'node:crypto'

import type { AccessController, Principal } from '@quicksilver/kernel/identity'
import {
  applyBeliefUpdate,
  createIntent,
  loadLedger,
  LedgerConflictError,
  LedgerIntegrityError,
  provenanceReport,
  recordChange,
  replay,
  scoreImpact,
  validateIntentGraph,
  verifyLedger,
  AUTONOMY_DEPTHS,
  OPERATING_MODES,
  type IntentChange,
  type IntentGraph,
  type IntentGraphStore,
  type LedgerStore,
  type ObjectiveParser,
} from '@quicksilver/aura'

/**
 * Aura intent entry point on the host (M3).
 *
 *   POST /api/intents                       { objective, mode?, autonomyDepth? }   intent:provide
 *   GET  /api/intents                                                               decision:read
 *   GET  /api/intents/:id                                                           decision:read
 *   POST /api/intents/:id/answers           { variableId, answer }                intent:provide
 *   GET  /api/intent-ledger/:company                                                decision:read
 *   POST /api/intent-ledger/:company        { change, reason? }   intent:provide or intent:rules (checked by Aura)
 *
 * Aura has no authority: these routes record what providers want and what is
 * still unknown. Nothing here proposes or executes an action.
 */

export interface IntentApiDeps {
  graphs: IntentGraphStore
  ledger: LedgerStore
  /** Defaults to the rule-based baseline parser. */
  parser?: ObjectiveParser
  now?: () => number
}

export interface IntentApiContext {
  method: string
  parts: string[]
  principal: Principal
  tenantId: string
  access: AccessController
  readBody: () => Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }>
}

type Response = { status: number; body: unknown }

function summary(graph: IntentGraph) {
  const impact = scoreImpact(graph)
  return {
    id: graph.id,
    objective: graph.objective,
    mode: graph.mode,
    autonomyDepth: graph.autonomyDepth,
    requestedBy: graph.requestedBy,
    createdAt: graph.createdAt,
    questions: impact.slice(0, 3).map((i) => ({ variableId: i.variableId, label: i.label, question: i.question, score: i.score, explanation: i.explanation })),
    report: provenanceReport(graph),
    issues: validateIntentGraph(graph),
  }
}

export async function handleIntentRoute(ctx: IntentApiContext, deps: IntentApiDeps): Promise<Response | undefined> {
  const { method, parts, principal, access, tenantId } = ctx
  const allow = (permission: 'intent:provide' | 'decision:read'): Response | undefined => {
    const d = access.authorize(principal, permission, { tenantId, kind: 'intent' })
    return d.allowed ? undefined : { status: 403, body: { error: d.reasons.join(' ') } }
  }
  const now = () => new Date(deps.now?.() ?? Date.now())

  if (parts[1] === 'intents') {
    if (parts.length === 2 && method === 'POST') {
      const denied = allow('intent:provide')
      if (denied) return denied
      const body = await ctx.readBody()
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const { objective, mode, autonomyDepth } = (body.value ?? {}) as Record<string, unknown>
      if (typeof objective !== 'string' || !objective.trim() || objective.length > 2_000) return { status: 422, body: { error: 'objective must be 1 to 2,000 characters.' } }
      if (mode !== undefined && !OPERATING_MODES.includes(mode as never)) return { status: 422, body: { error: `mode must be one of ${OPERATING_MODES.join(', ')}.` } }
      if (autonomyDepth !== undefined && !AUTONOMY_DEPTHS.includes(autonomyDepth as never)) return { status: 422, body: { error: `autonomyDepth must be one of ${AUTONOMY_DEPTHS.join(', ')}.` } }
      const result = await createIntent(objective, {
        requestedBy: principal.id,
        id: `intent-${randomUUID()}`,
        now: now(),
        ...(deps.parser ? { parser: deps.parser } : {}),
        ...(mode ? { mode: mode as IntentGraph['mode'] & string } : {}),
        ...(autonomyDepth ? { autonomyDepth: autonomyDepth as IntentGraph['autonomyDepth'] } : {}),
      } as Parameters<typeof createIntent>[1])
      await deps.graphs.put(result.graph)
      return { status: 201, body: { intent: summary(result.graph) } }
    }
    if (parts.length === 2 && method === 'GET') {
      const denied = allow('decision:read')
      if (denied) return denied
      const graphs = (await deps.graphs.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return { status: 200, body: { intents: graphs.map((g) => ({ id: g.id, objective: g.objective, mode: g.mode, requestedBy: g.requestedBy, createdAt: g.createdAt })) } }
    }
    if (parts.length === 3 && method === 'GET') {
      const denied = allow('decision:read')
      if (denied) return denied
      const graph = await deps.graphs.get(parts[2]!).catch(() => undefined)
      return graph ? { status: 200, body: { intent: summary(graph), graph } } : { status: 404, body: { error: 'No such intent.' } }
    }
    if (parts.length === 4 && parts[3] === 'answers' && method === 'POST') {
      const denied = allow('intent:provide')
      if (denied) return denied
      const graph = await deps.graphs.get(parts[2]!).catch(() => undefined)
      if (!graph) return { status: 404, body: { error: 'No such intent.' } }
      const body = await ctx.readBody()
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const { variableId, answer } = (body.value ?? {}) as Record<string, unknown>
      if (typeof variableId !== 'string' || typeof answer !== 'string' || !answer.trim() || answer.length > 1_000) return { status: 422, body: { error: 'variableId and a 1 to 1,000 character answer are required.' } }
      const numeric = /^\s*\$?\s*-?\d[\d,]*(\.\d+)?\s*$/.test(answer) ? Number(answer.replace(/[$,\s]/g, '')) : undefined
      const result = applyBeliefUpdate(graph, { id: principal.id, kind: 'human' }, {
        variableId,
        value: numeric ?? answer.trim(),
        provenance: 'HUMAN_SPECIFIED',
        confidence: 1,
        sources: [{ type: 'human', ref: principal.id, quote: answer.trim() }],
      }, now())
      if (!result.accepted) return { status: 422, body: { error: 'The answer was not accepted.', reasons: result.reasons } }
      await deps.graphs.put(result.graph)
      return { status: 200, body: { intent: summary(result.graph), change: result.change } }
    }
    return { status: 404, body: { error: 'Not found.' } }
  }

  if (parts[1] === 'intent-ledger' && parts.length === 3) {
    const company = parts[2]!
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(company)) return { status: 422, body: { error: 'Company ids use letters, digits, "-" and "_".' } }
    if (method === 'GET') {
      const denied = allow('decision:read')
      if (denied) return denied
      try {
        const ledger = await loadLedger(deps.ledger, company)
        if (!ledger.entries.length) return { status: 404, body: { error: 'No ledger for this company.' } }
        return { status: 200, body: { company, verified: verifyLedger(ledger), state: replay(ledger), entries: ledger.entries } }
      } catch (error) {
        if (error instanceof LedgerIntegrityError) return { status: 409, body: { error: error.message } }
        if ((error as Error).message?.startsWith('Invalid company id')) return { status: 422, body: { error: (error as Error).message } }
        throw error
      }
    }
    if (method === 'POST') {
      const body = await ctx.readBody()
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const { change, reason } = (body.value ?? {}) as { change?: IntentChange; reason?: unknown }
      if (!change || typeof change !== 'object' || typeof change.type !== 'string') return { status: 422, body: { error: 'change is required.' } }
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) return { status: 422, body: { error: 'reason must be a string of at most 500 characters.' } }
      try {
        const result = await recordChange(deps.ledger, company, principal, change, { access, now: now(), ...(reason ? { reason } : {}) })
        if (!result.ok) return { status: 403, body: { error: 'The change was refused.', reasons: result.reasons } }
        return { status: 201, body: { entry: result.entry, state: replay(result.ledger) } }
      } catch (error) {
        if (error instanceof LedgerConflictError) return { status: 409, body: { error: error.message } }
        if (error instanceof LedgerIntegrityError) return { status: 409, body: { error: error.message } }
        if ((error as Error).message?.startsWith('Invalid company id')) return { status: 422, body: { error: (error as Error).message } }
        throw error
      }
    }
  }
  return undefined
}
