/**
 * Which buttons a decision shows, for the person looking at it, and for each one that is not
 * available, why. Pure, so the rules are pinned by tests and the page only draws the result.
 *
 * A button the person cannot use is shown disabled with its reason, never hidden and never left to
 * fail with a 403 after the click. Nothing here grants anything: each route still checks.
 */

export type DecisionActionId = 'approve' | 'reject' | 'request-evidence' | 'execute' | 'observe' | 'rollback' | 'resume'

export interface DecisionActionView {
  id: string
  status: string | null
  safetyDecision?: string | null
  /** From the detail route: what an approval covers, and whether policy moved since planning. */
  approvalFingerprint: string | null
  policyChanged: boolean
  requestedBy: string | null
  proposedBy: string | null
  actorId: string | null
  /** The stored explanation's risk band, when there is one. */
  riskBand: string | null
  kind?: string | null
}

export interface DecisionActionOption {
  id: DecisionActionId
  label: string
  tone: 'primary' | 'danger' | 'neutral'
  enabled: boolean
  /** Why it is disabled; present exactly when `enabled` is false. */
  reason?: string
  /** Ask for a written reason first (the sole operator approving their own request, or a note on a request for evidence). */
  needsNote?: 'required' | 'optional'
  /** Ask "are you sure" first. */
  confirm: boolean
  call: { method: 'POST'; path: string; body: Record<string, unknown> }
}

const PENDING = new Set(['awaiting-approval', 'proposed', 'rollback-proposed'])

const route = (id: string, name: 'action' | 'execute' | 'observe' | 'resume' | 'rollback') => `/api/decisions/${encodeURIComponent(id)}/${name}`

export function decisionActionOptions(view: DecisionActionView, me: string, permissions: readonly string[], soleOperator = false): DecisionActionOption[] {
  const can = (permission: string) => permissions.includes(permission)
  const options: DecisionActionOption[] = []
  const status = view.status ?? ''
  const need = (permission: string) => (can(permission) ? undefined : `Needs ${permission}.`)

  if (PENDING.has(status)) {
    const involved = view.requestedBy === me ? 'You requested this' : view.proposedBy === me ? 'You proposed this' : view.actorId === me ? 'You would carry this out' : null
    const rollback = status === 'rollback-proposed'
    let approveReason = need('decision:approve')
    let note: DecisionActionOption['needsNote']
    if (!approveReason && view.safetyDecision === 'BLOCK') approveReason = 'The kernel blocked this decision, so it cannot be approved.'
    if (!approveReason && !rollback && view.policyChanged) approveReason = 'A policy changed since this was planned. Ask for a fresh plan.'
    if (!approveReason && !rollback && !view.approvalFingerprint) approveReason = 'This decision has no recorded action to approve.'
    if (!approveReason && involved) {
      if (soleOperator) note = 'required'
      else approveReason = `${involved}, so someone else has to approve it.`
    }
    const reviewedInFull = view.riskBand === 'above-review-ceiling'
    options.push({
      id: 'approve', label: note ? 'Approve with a written reason' : 'Approve', tone: 'primary', enabled: !approveReason, ...(approveReason ? { reason: approveReason } : {}),
      ...(note ? { needsNote: note } : {}), confirm: reviewedInFull,
      call: { method: 'POST', path: route(view.id, 'action'), body: { action: 'approve', ...(view.approvalFingerprint ? { expectedActionFingerprint: view.approvalFingerprint } : {}) } },
    })
    const rejectReason = need('decision:approve')
    options.push({ id: 'reject', label: 'Reject', tone: 'danger', enabled: !rejectReason, ...(rejectReason ? { reason: rejectReason } : {}), needsNote: 'optional', confirm: true, call: { method: 'POST', path: route(view.id, 'action'), body: { action: 'reject' } } })
    options.push({ id: 'request-evidence', label: 'Ask for more evidence', tone: 'neutral', enabled: !rejectReason, ...(rejectReason ? { reason: rejectReason } : {}), needsNote: 'optional', confirm: false, call: { method: 'POST', path: route(view.id, 'action'), body: { action: 'request-evidence' } } })
    if (status === 'proposed') {
      const reason = need('decision:read')
      options.push({ id: 'resume', label: 'Check the process again', tone: 'neutral', enabled: !reason, ...(reason ? { reason } : {}), confirm: false, call: { method: 'POST', path: route(view.id, 'resume'), body: {} } })
    }
  }

  if (status === 'approved') {
    const reason = need('decision:execute')
    options.push({ id: 'execute', label: 'Execute (simulated)', tone: 'primary', enabled: !reason, ...(reason ? { reason } : {}), confirm: true, call: { method: 'POST', path: route(view.id, 'execute'), body: {} } })
  }

  if (status === 'executed') {
    const observeReason = need('decision:read')
    options.push({ id: 'observe', label: 'Observe the metric', tone: 'neutral', enabled: !observeReason, ...(observeReason ? { reason: observeReason } : {}), confirm: false, call: { method: 'POST', path: route(view.id, 'observe'), body: {} } })
    if (view.kind !== 'rollback') {
      const reason = need('decision:rollback')
      options.push({ id: 'rollback', label: 'Propose a rollback', tone: 'danger', enabled: !reason, ...(reason ? { reason } : {}), confirm: true, call: { method: 'POST', path: route(view.id, 'rollback'), body: {} } })
    }
  }

  return options
}
