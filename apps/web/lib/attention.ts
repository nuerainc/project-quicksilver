/**
 * "What needs me": the list of things that need the signed-in person, worked out from records
 * and from what that person may do. Pure and model-free, so it is instant, costs nothing and
 * cannot be paraphrased wrongly.
 *
 * Rules the tests pin:
 *  - Only what the person can act on counts toward the badge; the rest is listed quietly.
 *  - An approval is never offered to the person who requested it (separation of duties).
 *  - A one-click approve is offered only when the card shows everything the click covers
 *    (the action, the risk, the one-line why, the policy version) and the risk is not above the
 *    review ceiling. Anything else offers "Review", which opens the decision.
 *  - A decision whose policy changed since it was planned is never offered for approval.
 *  - A source that could not be checked is reported, never silently counted as zero.
 */

export type AttentionSeverity = 'critical' | 'warning' | 'info'
export type AttentionKind = 'approval' | 'stale-approval' | 'rollback' | 'execute' | 'refused' | 'failed-decision' | 'waiting-on-others' | 'workflow-failure' | 'agent-review' | 'trace-alert'

export interface AttentionAction {
  id: 'approve' | 'reject' | 'execute' | 'review'
  label: string
  tone: 'primary' | 'danger' | 'neutral'
  /** A page to open. */
  link?: string
  /** An app route to call as the signed-in person. Every call path is one the console may send credentials to. */
  call?: { method: 'POST'; path: string; body: Record<string, unknown>; confirm: boolean }
}

export interface AttentionItem {
  id: string
  kind: AttentionKind
  severity: AttentionSeverity
  title: string
  reason: string
  since: string | null
  /** True when the person can do something about it now. Only these count toward the badge. */
  actionable: boolean
  link: string
  actions: AttentionAction[]
  /** What an approve click covers, shown on the card. */
  covers?: { action: string | null; riskLevel: number | null; why: string | null; policyVersion: string | null }
  /** For a refused plan: the smallest change that would change the answer. */
  nearMiss?: string | null
}

export interface SourceStatus { id: 'decisions' | 'workflows' | 'agents' | 'traces'; status: 'ok' | 'unavailable' | 'skipped'; reason?: string }

export interface DecisionInput {
  id: string
  title: string
  action: string | null
  status: string
  riskLevel: number | null
  requiredApproval: boolean
  requestedBy: string | null
  /** The agent that proposed it, and the entity that would carry it out. Neither may approve it. */
  proposedBy?: string | null
  actorId?: string | null
  createdAt: string | null
  policySnapshotVersion: string | null
  /** The decision's policy has changed since it was planned. */
  stale: boolean
  /** The stored explanation, when there is one. */
  why: null | {
    headline: string
    risk: { band: string; finalRisk: number }
    whatWouldChangeIt: Array<{ change: string; improves: boolean; simulated: boolean; outcome?: { recommendation: string; riskLevel: number } }>
  }
}

export interface AttentionInput {
  me: string
  permissions: readonly string[]
  now: number
  decisions: DecisionInput[]
  /** Fingerprints the approve route will accept, by decision id. Computed by the caller from the stored decision. */
  fingerprints: Readonly<Record<string, string>>
  workflowRuns: Array<{ workflowId: string; status: string; completedAt: number }>
  agentReviewQueue: Array<{ agentId: string; displayName: string; version: number; authoredBy: string; createdAt: number }>
  traceAlerts: Array<{ id: string; severity: 'warning' | 'critical'; summary: string }>
}

const DAY = 86_400_000
const RECENT_REFUSAL_MS = 7 * DAY
const RECENT_RUN_MS = DAY
const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 }

const decisionLink = (id: string) => `/decisions?id=${encodeURIComponent(id)}`
const review = (link: string): AttentionAction => ({ id: 'review', label: 'Review', tone: 'neutral', link })
const decisionRoute = (id: string, route: 'action' | 'execute') => `/api/decisions/${encodeURIComponent(id)}/${route}`

export function buildAttention(input: AttentionInput): AttentionItem[] {
  const can = (permission: string) => input.permissions.includes(permission)
  const items: AttentionItem[] = []

  for (const d of input.decisions) {
    const link = decisionLink(d.id)
    const mine = d.requestedBy === input.me
    const covers = { action: d.action, riskLevel: d.riskLevel, why: d.why?.headline ?? null, policyVersion: d.policySnapshotVersion }
    const severity: AttentionSeverity = (d.riskLevel ?? 0) >= 4 ? 'critical' : 'warning'

    if (d.status === 'awaiting-approval' || d.status === 'proposed' || d.status === 'rollback-proposed') {
      const rollback = d.status === 'rollback-proposed'
      if (!can('decision:approve')) continue
      // The approve route refuses anyone who requested, proposed or would carry out the action,
      // so none of them is offered an approve button.
      const involved = mine ? 'You asked for this' : d.proposedBy === input.me ? 'You proposed this' : d.actorId === input.me ? 'You would carry this out' : null
      if (involved) {
        items.push({ id: `decision:${d.id}:waiting`, kind: 'waiting-on-others', severity: 'info', title: d.title, reason: `${involved}, so someone else has to approve it.`, since: d.createdAt, actionable: false, link, actions: [review(link)] })
        continue
      }
      const reject: AttentionAction = { id: 'reject', label: 'Reject', tone: 'danger', call: { method: 'POST', path: decisionRoute(d.id, 'action'), body: { action: 'reject' }, confirm: true } }
      if (d.stale) {
        items.push({ id: `decision:${d.id}:stale`, kind: 'stale-approval', severity: 'warning', title: d.title, reason: 'A policy changed since this was planned, so it cannot be approved as it is. Ask for a fresh plan.', since: d.createdAt, actionable: true, link, actions: [reject, review(link)], covers })
        continue
      }
      const fingerprint = input.fingerprints[d.id]
      const oneClick = !rollback && !!fingerprint && !!d.why && !!d.policySnapshotVersion && d.why.risk.band !== 'above-review-ceiling' && d.riskLevel !== null
      const approve: AttentionAction | null = oneClick
        ? { id: 'approve', label: 'Approve', tone: 'primary', call: { method: 'POST', path: decisionRoute(d.id, 'action'), body: { action: 'approve', expectedActionFingerprint: fingerprint }, confirm: false } }
        : null
      const reason = rollback ? 'A rollback was proposed and needs a person to approve it.'
        : !d.why ? 'Open it to read the action, the risk and the policy checks before approving.'
        : d.why.risk.band === 'above-review-ceiling' ? 'The risk is above the review ceiling, so read it in full before approving.'
        : d.why.headline
      items.push({ id: `decision:${d.id}:approval`, kind: rollback ? 'rollback' : 'approval', severity, title: d.title, reason, since: d.createdAt, actionable: true, link, actions: [...(approve ? [approve] : []), reject, ...(approve ? [] : [review(link)])], covers })
      continue
    }

    if (d.status === 'approved' && can('decision:execute')) {
      items.push({
        id: `decision:${d.id}:execute`, kind: 'execute', severity: 'info', title: d.title,
        reason: 'Approved and ready to run. In this build execution is a simulation: it records a result and changes nothing outside the console.',
        since: d.createdAt, actionable: true, link, covers,
        actions: [{ id: 'execute', label: 'Execute (simulated)', tone: 'primary', call: { method: 'POST', path: decisionRoute(d.id, 'execute'), body: {}, confirm: true } }, review(link)],
      })
      continue
    }

    if (d.status === 'rejected' && mine && d.createdAt && input.now - Date.parse(d.createdAt) <= RECENT_REFUSAL_MS) {
      const best = d.why?.whatWouldChangeIt.find((c) => c.improves)
      const nearMiss = best ? `${best.change}${best.simulated && best.outcome ? ` The kernel then says ${best.outcome.recommendation} at risk ${best.outcome.riskLevel}.` : ''}` : null
      items.push({ id: `decision:${d.id}:refused`, kind: 'refused', severity: 'info', title: d.title, reason: d.why?.headline ?? 'Your plan was refused.', since: d.createdAt, actionable: false, link, actions: [review(link)], nearMiss })
      continue
    }

    if (d.status === 'failed' && (mine || can('decision:execute'))) {
      items.push({ id: `decision:${d.id}:failed`, kind: 'failed-decision', severity: 'warning', title: d.title, reason: 'Execution failed.', since: d.createdAt, actionable: true, link, actions: [review(link)] })
    }
  }

  if (can('workflow:read')) {
    const failed = new Map<string, number>()
    for (const run of input.workflowRuns) {
      if (run.status === 'failed' && input.now - run.completedAt <= RECENT_RUN_MS) failed.set(run.workflowId, (failed.get(run.workflowId) ?? 0) + 1)
    }
    for (const [workflowId, count] of failed) {
      items.push({ id: `workflow:${workflowId}:failed`, kind: 'workflow-failure', severity: 'warning', title: workflowId, reason: `${count === 1 ? 'A run' : `${count} runs`} failed in the last 24 hours.`, since: null, actionable: true, link: '/monitoring', actions: [review('/monitoring')] })
    }
  }

  if (can('agent:review')) {
    for (const entry of input.agentReviewQueue) {
      if (entry.authoredBy === input.me) continue
      items.push({ id: `agent:${entry.agentId}:${entry.version}:review`, kind: 'agent-review', severity: 'warning', title: entry.displayName, reason: `Version ${entry.version} is waiting for an independent review.`, since: new Date(entry.createdAt).toISOString(), actionable: true, link: '/agents', actions: [review('/agents')] })
    }
  }

  if (can('audit:read')) {
    for (const alert of input.traceAlerts) {
      items.push({ id: `trace:${alert.id}`, kind: 'trace-alert', severity: alert.severity === 'critical' ? 'critical' : 'warning', title: alert.summary, reason: 'Raised from recent model, tool and run traces.', since: null, actionable: true, link: '/monitoring/traces', actions: [review('/monitoring/traces')] })
    }
  }

  return items.sort((a, b) =>
    Number(b.actionable) - Number(a.actionable)
    || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (a.since ?? '9999').localeCompare(b.since ?? '9999'))
}

/** The numbers the header badge shows. `complete` is false when any source could not be checked. */
export function attentionCounts(items: readonly AttentionItem[], sources: readonly SourceStatus[]): { actionable: number; other: number; complete: boolean } {
  const actionable = items.filter((item) => item.actionable).length
  return { actionable, other: items.length - actionable, complete: sources.every((source) => source.status !== 'unavailable') }
}
