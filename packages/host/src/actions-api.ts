import { ACTION_ID, ACTION_STATUSES, type ActionService, type ActionStatus } from './actions.ts'

/**
 * P-095: approved-action routes.
 *
 *   GET  /api/actions                           decision:read: enabled tools, limits and the policy snapshot
 *   GET  /api/actions/proposals[?status=]       decision:read
 *   GET  /api/actions/proposals/:id             decision:read
 *   POST /api/actions/proposals                 a provider or proposer: { toolId, input, reason, evidence[] }. Records only.
 *   POST /api/actions/proposals/:id/approve     a human other than the proposer: { note? }. Runs the action at once.
 *   POST /api/actions/proposals/:id/reject      a human: { note? }
 *   POST /api/actions/proposals/:id/resolve     a human: { outcome: "executed"|"failed", note }, for an action whose outcome is unknown
 *
 * The approver is the authenticated principal. A body that names one is refused.
 */

type Response = { status: number; body: unknown }

export interface ActionRouteContext {
  method: string
  parts: string[]
  principal: { id: string; kind: string }
  actions: ActionService
  needRead(): Response | undefined
  needPropose(): Response | undefined
  humanOnly(what: string): Response | undefined
  bodyOf(): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }>
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>
}

const NAMES_AN_ACTOR = ['approvedBy', 'approver', 'decidedBy', 'supervisorId', 'by', 'proposedBy']

export async function handleActionsRoute(ctx: ActionRouteContext): Promise<Response | undefined> {
  const { method, parts, principal, actions } = ctx
  if (parts[1] !== 'actions') return undefined

  if (parts.length === 2 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const all = await actions.list()
    const counts = Object.fromEntries(ACTION_STATUSES.map((s) => [s, all.filter((p) => p.status === s).length]))
    return { status: 200, body: { ...actions.summary(), counts } }
  }

  if (parts[2] !== 'proposals') return undefined

  if (parts.length === 3 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    return { status: 200, body: { proposals: await actions.list() } }
  }

  if (parts.length === 3 && method === 'POST') {
    const denied = ctx.needPropose()
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const bad = NAMES_AN_ACTOR.find((k) => k in body.value)
    if (bad) return { status: 400, body: { error: `The request cannot name "${bad}"; the proposer is the authenticated principal.` } }
    return ctx.withLock('actions', async () => {
      const r = await actions.propose({ id: principal.id, kind: principal.kind }, body.value)
      return r.ok ? { status: 201, body: { proposal: r.proposal, executed: false, note: 'Recorded only. Nothing was run; a person has to approve it.' } } : { status: r.status, body: { error: r.error } }
    })
  }

  if (parts.length < 4) return undefined
  const id = parts[3]!
  if (!ACTION_ID.test(id)) return { status: 404, body: { error: 'Unknown action proposal.' } }

  if (parts.length === 4 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const p = await actions.get(id)
    return p ? { status: 200, body: { proposal: p } } : { status: 404, body: { error: `No action proposal "${id}".` } }
  }

  if (parts.length === 5 && method === 'POST' && ['approve', 'reject', 'resolve'].includes(parts[4]!)) {
    const verb = parts[4]!
    const denied = ctx.humanOnly(verb === 'approve' ? 'approves an action' : verb === 'reject' ? 'rejects an action' : 'settles an action')
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const bad = NAMES_AN_ACTOR.find((k) => k in body.value)
    if (bad) return { status: 400, body: { error: `The request cannot name "${bad}"; the decision is made by the authenticated principal.` } }
    return ctx.withLock('actions', async () => {
      const r = verb === 'approve' ? await actions.approve(id, principal, body.value.note)
        : verb === 'reject' ? await actions.reject(id, principal, body.value.note)
          : await actions.resolve(id, principal, body.value)
      if (!r.ok) return { status: r.status, body: { error: r.error } }
      return { status: 200, body: { proposal: r.proposal, executed: r.proposal.status === 'executed', dryRun: r.proposal.result?.dryRun === true } }
    })
  }
  return undefined
}

export type { ActionStatus }
