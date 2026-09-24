import { createHash, timingSafeEqual } from 'node:crypto'
import type { SanityClient } from '@sanity/client'

export interface PolicyRevision {
  id: string
  revision: string
}

/** Stable hash over the exact policy document revisions used for a decision. */
export function policySnapshotVersion(policies: PolicyRevision[]): string {
  const snapshot = [...policies]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, revision }) => [id, revision])
  return `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`
}

export async function currentPolicySnapshotVersion(
  client: SanityClient,
  policyIds: string[],
): Promise<string | null> {
  const ids = [...new Set(policyIds)].sort()
  const policies = await client.fetch<Array<{ _id: string; _rev: string }>>(
    '*[_type == "policy" && _id in $ids]{ _id, _rev }',
    { ids },
  )
  if (policies.length !== ids.length || policies.some((policy) => !policy._rev)) return null
  return policySnapshotVersion(policies.map((policy) => ({ id: policy._id, revision: policy._rev })))
}

export interface DecisionActionBinding {
  decisionId: string
  selectedAction: string
  policySnapshotVersion: string
  riskLevel: number
  requiredApproval: boolean
}

/** Binds approval to the specific stored action, its risk, and policy version. */
export function decisionActionFingerprint(binding: DecisionActionBinding): string {
  const canonical = JSON.stringify({
    decisionId: binding.decisionId,
    selectedAction: binding.selectedAction,
    policySnapshotVersion: binding.policySnapshotVersion,
    riskLevel: binding.riskLevel,
    requiredApproval: binding.requiredApproval,
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export type SupervisorCredentialResult =
  | { ok: true; supervisorId: string }
  | { ok: false; reason: string; status: 401 | 503 }

/** Verify a server-to-server supervisor credential; never trust a body-supplied actor id. */
export function verifySupervisorCredential(request: Request): SupervisorCredentialResult {
  const expected = process.env.NQC_SUPERVISOR_TOKEN
  const supervisorId = process.env.NQC_SUPERVISOR_ID
  if (!expected || expected.length < 32 || !supervisorId) {
    return { ok: false, status: 503, reason: 'Supervisor approval is not configured.' }
  }

  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  if (!match) return { ok: false, status: 401, reason: 'A valid supervisor credential is required.' }

  const supplied = Buffer.from(match[1]!, 'utf8')
  const configured = Buffer.from(expected, 'utf8')
  if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) {
    return { ok: false, status: 401, reason: 'A valid supervisor credential is required.' }
  }
  return { ok: true, supervisorId }
}

