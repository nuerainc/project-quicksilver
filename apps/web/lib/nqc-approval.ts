import { createHash, timingSafeEqual } from 'node:crypto'
import type { SanityClient } from '@sanity/client'
import { AccessController, type Permission } from '@quicksilver/kernel'
import { StaticTokenIdentityProvider, principalsFromJson } from '@quicksilver/kernel/identity/tokens'

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
  | { ok: false; reason: string; status: 401 | 403 | 503 }

let principalRegistry: { source: string; provider: StaticTokenIdentityProvider } | undefined
const accessController = new AccessController({
  audit: (decision) => {
    if (!decision.allowed) console.warn('[nqc-access] denied', JSON.stringify({ principal: decision.principalId, permission: decision.permission, tenant: decision.tenantId, reasons: decision.reasons }))
  },
})

function principalProvider(): StaticTokenIdentityProvider | null {
  const source = process.env.QUICKSILVER_PRINCIPALS
  if (!source?.trim()) return null
  if (principalRegistry?.source !== source) {
    principalRegistry = { source, provider: new StaticTokenIdentityProvider(principalsFromJson(source)) }
  }
  return principalRegistry.provider
}

export type RequesterResult = { ok: true; requestedBy: string } | { ok: false; reason: string; status: 401 | 503 }

/**
 * Identify who is submitting an objective, for separation of duties.
 *
 * With per-person principals configured, a bearer token identifies the
 * requester; an invalid token is refused rather than silently downgraded.
 * Without a token the request is recorded as coming from the console.
 */
export function identifyRequester(request: Request): RequesterResult {
  const header = request.headers.get('authorization')
  if (!header) return { ok: true, requestedBy: 'console:anonymous' }
  let provider: StaticTokenIdentityProvider | null
  try {
    provider = principalProvider()
  } catch {
    return { ok: false, status: 503, reason: 'Principals are misconfigured.' }
  }
  if (!provider) return { ok: true, requestedBy: 'console:anonymous' }
  const principal = provider.authenticateHeader(header)
  if (!principal) return { ok: false, status: 401, reason: 'The supplied credential is not valid.' }
  return { ok: true, requestedBy: principal.id }
}

/** The configured sole operator for single-human organizations, or null. */
export function soleOperatorId(): string | null {
  return process.env.QUICKSILVER_SOLE_OPERATOR_ID?.trim() || null
}

/**
 * Verify a server-to-server supervisor credential; never trust a body-supplied actor id.
 *
 * When `QUICKSILVER_PRINCIPALS` is set, the bearer token is matched against
 * hashed per-person tokens and the principal must hold `permission` for
 * `QUICKSILVER_TENANT_ID` under NQC RBAC. The principal id must be the Sanity
 * entity id of that human supervisor. Otherwise the interim single
 * `NQC_SUPERVISOR_TOKEN` credential is used.
 */
export function verifySupervisorCredential(request: Request, permission: Permission = 'decision:approve'): SupervisorCredentialResult {
  let provider: StaticTokenIdentityProvider | null
  try {
    provider = principalProvider()
  } catch {
    return { ok: false, status: 503, reason: 'Supervisor principals are misconfigured.' }
  }
  if (provider) {
    const principal = provider.authenticateHeader(request.headers.get('authorization'))
    if (!principal) return { ok: false, status: 401, reason: 'A valid supervisor credential is required.' }
    const tenantId = process.env.QUICKSILVER_TENANT_ID?.trim() || 'default'
    const decision = accessController.authorize(principal, permission, { tenantId, kind: 'decision' })
    if (!decision.allowed || principal.kind !== 'human') {
      return { ok: false, status: 403, reason: 'This credential is not permitted to perform this supervisor action.' }
    }
    return { ok: true, supervisorId: principal.id }
  }

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

