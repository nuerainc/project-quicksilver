/**
 * GET /api/inbox — what needs the signed-in person.
 *
 * Computed from records and from what the person may do; no model is involved. Decisions are read
 * from the data store. Workflows, agents and traces are read through those routes' own handlers
 * with the person's credentials, so each applies its own permission: a source the person may not
 * read is reported as skipped, and one that could not be loaded as unavailable, so a list that is
 * short because something failed never looks like a list that is short because nothing is wrong.
 *
 * Response: { observedAt, items[], sources[], counts: { actionable, other, complete } }
 */

import { NextResponse } from 'next/server'
import { appFetchFor } from '@/lib/app-read-routes'
import { attentionCounts, buildAttention, type DecisionInput, type SourceStatus } from '@/lib/attention'
import { currentPolicySnapshotVersion, decisionActionFingerprint } from '@/lib/nqc-approval'
import { guardWebRoute } from '@/lib/route-guard'
import { getSanityClient } from '@/lib/sanity-client'

export const dynamic = 'force-dynamic'

const DECISIONS_QUERY = `*[_type == "decision" && status in ["awaiting-approval", "proposed", "rollback-proposed", "approved", "rejected", "failed"]]
  | order(coalesce(createdAt, _createdAt) desc)[0...60]{
  _id, question, selectedAction, status, riskLevel, requiredApproval, requestedBy, proposedBy, createdAt, policySnapshotVersion,
  "actorId": candidateActions[0].actor._ref,
  "policyIds": policyChecks[].policy._ref,
  "why": why{ headline, risk{ band, finalRisk }, whatWouldChangeIt[]{ change, improves, simulated, outcome{ recommendation, riskLevel } } }
}`

interface Row {
  _id: string; question?: string | null; selectedAction?: string | null; status?: string | null; riskLevel?: number | null
  requiredApproval?: boolean | null; requestedBy?: string | null; proposedBy?: string | null; actorId?: string | null
  createdAt?: string | null; policySnapshotVersion?: string | null; policyIds?: string[] | null; why?: DecisionInput['why']
}

const unavailable = (id: SourceStatus['id'], reason: string): SourceStatus => ({ id, status: 'unavailable', reason })
const skipped = (id: SourceStatus['id'], reason: string): SourceStatus => ({ id, status: 'skipped', reason })

export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'inbox')
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status, headers: caller.headers })

  const fetchApp = appFetchFor(request)
  const who = await fetchApp('/api/whoami')
  const identity = who.body as { principalId?: string; permissions?: string[] } | null
  if (who.status !== 200 || typeof identity?.principalId !== 'string' || !Array.isArray(identity.permissions)) {
    return NextResponse.json({ error: 'Could not check what you are allowed to do.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
  const me = identity.principalId
  const permissions = identity.permissions
  const can = (permission: string) => permissions.includes(permission)

  const sources: SourceStatus[] = []
  let decisions: DecisionInput[] = []
  const fingerprints: Record<string, string> = {}
  let workflowRuns: Array<{ workflowId: string; status: string; completedAt: number }> = []
  let agentReviewQueue: Array<{ agentId: string; displayName: string; version: number; authoredBy: string; createdAt: number }> = []
  let traceAlerts: Array<{ id: string; severity: 'warning' | 'critical'; summary: string }> = []

  await Promise.all([
    (async () => {
      if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) return void sources.push(unavailable('decisions', 'The data store is not configured.'))
      try {
        const client = getSanityClient('read')
        const rows = (await client.fetch<Row[]>(DECISIONS_QUERY)) ?? []
        // Staleness mirrors the approve route: the live policy revisions against the ones recorded at planning.
        const liveByKey = new Map<string, string | null>()
        for (const row of rows) {
          if (row.status !== 'awaiting-approval' && row.status !== 'proposed') continue
          const ids = [...new Set(row.policyIds ?? [])].sort()
          const key = ids.join('|')
          if (!liveByKey.has(key)) liveByKey.set(key, await currentPolicySnapshotVersion(client, ids))
        }
        decisions = rows.map((row): DecisionInput => {
          const status = row.status ?? 'proposed'
          const ids = [...new Set(row.policyIds ?? [])].sort()
          const pending = status === 'awaiting-approval' || status === 'proposed'
          const stale = pending && (!row.policySnapshotVersion || liveByKey.get(ids.join('|')) !== row.policySnapshotVersion)
          if (row.selectedAction && row.policySnapshotVersion) {
            fingerprints[row._id] = decisionActionFingerprint({
              decisionId: row._id, selectedAction: row.selectedAction, policySnapshotVersion: row.policySnapshotVersion,
              riskLevel: row.riskLevel ?? 0, requiredApproval: row.requiredApproval ?? false,
            })
          }
          return {
            id: row._id, title: row.question?.trim() || row.selectedAction?.trim() || 'Untitled decision', action: row.selectedAction ?? null,
            status, riskLevel: row.riskLevel ?? null, requiredApproval: row.requiredApproval === true, requestedBy: row.requestedBy ?? null,
            proposedBy: row.proposedBy ?? null, actorId: row.actorId ?? null, createdAt: row.createdAt ?? null,
            policySnapshotVersion: row.policySnapshotVersion ?? null, stale, why: row.why ?? null,
          }
        })
        sources.push({ id: 'decisions', status: 'ok' })
      } catch (error) {
        console.error('[inbox] decisions failed', error instanceof Error ? error.name : 'UnknownError')
        sources.push(unavailable('decisions', 'Could not load decisions.'))
      }
    })(),
    (async () => {
      if (!can('workflow:read')) return void sources.push(skipped('workflows', 'Needs workflow:read.'))
      const result = await fetchApp('/api/monitoring/workflows')
      if (result.status !== 200) return void sources.push(unavailable('workflows', 'Could not load workflow activity.'))
      workflowRuns = ((result.body as { executions?: Array<{ workflowId: string; status: string; completedAt: number }> }).executions ?? [])
        .map(({ workflowId, status, completedAt }) => ({ workflowId, status, completedAt }))
      sources.push({ id: 'workflows', status: 'ok' })
    })(),
    (async () => {
      if (!can('agent:review')) return void sources.push(skipped('agents', 'Needs agent:review.'))
      const result = await fetchApp('/api/agents/catalog')
      if (result.status !== 200) return void sources.push(unavailable('agents', 'Could not load the agent catalog.'))
      agentReviewQueue = ((result.body as { reviewQueue?: Array<{ agentId: string; displayName: string; version: number; authoredBy: string; createdAt: number }> }).reviewQueue ?? [])
        .map(({ agentId, displayName, version, authoredBy, createdAt }) => ({ agentId, displayName, version, authoredBy, createdAt }))
      sources.push({ id: 'agents', status: 'ok' })
    })(),
    (async () => {
      if (!can('audit:read')) return void sources.push(skipped('traces', 'Needs audit:read.'))
      const result = await fetchApp('/api/monitoring/traces')
      if (result.status !== 200) return void sources.push(unavailable('traces', 'Could not load traces.'))
      traceAlerts = ((result.body as { alerts?: Array<{ id: string; severity: 'warning' | 'critical'; summary: string }> }).alerts ?? [])
        .map(({ id, severity, summary }) => ({ id, severity, summary }))
      sources.push({ id: 'traces', status: 'ok' })
    })(),
  ])

  const order = ['decisions', 'workflows', 'agents', 'traces']
  sources.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const items = buildAttention({ me, permissions, now: Date.now(), decisions, fingerprints, workflowRuns, agentReviewQueue, traceAlerts })
  return NextResponse.json({ observedAt: new Date().toISOString(), items, sources, counts: attentionCounts(items, sources) }, { headers: { 'cache-control': 'no-store' } })
}
