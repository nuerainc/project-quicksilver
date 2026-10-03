import { createHash, timingSafeEqual } from 'node:crypto'
import type { SanityClient } from '@sanity/client'
import { AccessController, PERMISSIONS, type Permission, type PrincipalKind } from '@quicksilver/kernel'
import { validatePrincipal, type Principal } from '@quicksilver/kernel/identity'
import { StaticTokenIdentityProvider, digestToken, principalsFromJson } from '@quicksilver/kernel/identity/tokens'
import { DEMO_PRINCIPALS, demoModeOn, demoModeProblems } from './demo-mode.ts'
import { appendAuthorizationDecision } from './authorization-audit-store.ts'
import { readBrowserSession } from './oidc-browser-auth.ts'

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

/**
 * The environment the credential checks read. The pure checks
 * (`checkSupervisorCredential`, `checkDecisionRouteCaller`) take it as an
 * argument so they can be tested without touching `process.env`; the
 * request-level wrappers pass `process.env`.
 */
export interface CredentialEnv {
  readonly [name: string]: string | undefined
  QUICKSILVER_PRINCIPALS?: string
  QUICKSILVER_TENANT_ID?: string
  NQC_SUPERVISOR_TOKEN?: string
  NQC_SUPERVISOR_ID?: string
}

let principalRegistry: { source: string; provider: StaticTokenIdentityProvider } | undefined
const accessController = new AccessController({
  audit: (decision) => {
    if (!decision.allowed) console.warn('[nqc-access] denied', JSON.stringify({ principal: decision.principalId, permission: decision.permission, tenant: decision.tenantId, reasons: decision.reasons }))
  },
})

// A silent controller for probing permissions: probing several would otherwise
// log a "denied" line for each one the principal lacks.
const quietAccessController = new AccessController()

let demoRegistry: { tenantId: string; provider: StaticTokenIdentityProvider } | undefined

/**
 * The two public demo principals (lib/demo-mode.ts) for the tenant. Only
 * reached after `demoModeProblems` found nothing wrong.
 */
function demoProvider(env: CredentialEnv): StaticTokenIdentityProvider {
  const tenantId = tenantOf(env)
  if (demoRegistry?.tenantId !== tenantId) {
    demoRegistry = {
      tenantId,
      provider: new StaticTokenIdentityProvider(DEMO_PRINCIPALS.map((p) => ({
        id: p.id,
        kind: 'human' as const,
        tenantId,
        roles: [...p.roles],
        displayName: `${p.displayName} (${p.title})`,
        tokenDigest: digestToken(p.token),
      }))),
    }
  }
  return demoRegistry.provider
}

/**
 * Per-person principals (cached per source string), or null when unset.
 * Throws when misconfigured. In demo mode, the public demo principals instead,
 * and only when the demo guard passes (it throws otherwise, so every route
 * answers 503: demo mode fails closed).
 */
function principalProvider(env: CredentialEnv = process.env): StaticTokenIdentityProvider | null {
  if (demoModeOn(env)) {
    const problems = demoModeProblems(env)
    if (problems.length) throw new Error(problems.join(' '))
    return demoProvider(env)
  }
  const source = env.QUICKSILVER_PRINCIPALS
  if (!source?.trim()) return null
  if (principalRegistry?.source !== source) {
    principalRegistry = { source, provider: new StaticTokenIdentityProvider(principalsFromJson(source)) }
  }
  return principalRegistry.provider
}

function tenantOf(env: CredentialEnv): string {
  return env.QUICKSILVER_TENANT_ID?.trim() || 'default'
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
export async function verifySupervisorCredential(request: Request, permission: Permission = 'decision:approve'): Promise<SupervisorCredentialResult> {
  let result: SupervisorCredentialResult
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    result = checkSupervisorCredential(authorization, permission, process.env)
  } else {
    try {
      const session = await readBrowserSession(request, process.env)
      if (!session) result = checkSupervisorCredential(null, permission, process.env)
      else {
        const caller = checkPrincipalCaller([permission], { id: session.id, kind: session.kind, tenantId: session.tenantId, roles: session.roles, ...(session.displayName ? { displayName: session.displayName } : {}) }, process.env)
        if (!caller.ok) result = { ok: false, status: caller.status, reason: caller.reason }
        else if (caller.kind !== 'human') result = { ok: false, status: 403, reason: 'A human principal is required for supervisor actions.' }
        else result = { ok: true, supervisorId: caller.principalId }
      }
    } catch (error) {
      console.error('[oidc] session lookup failed', error instanceof Error ? error.name : 'UnknownError')
      result = { ok: false, status: 503, reason: 'Browser session storage is unavailable.' }
    }
  }
  try {
    await appendAuthorizationDecision({ tenantId: tenantOf(process.env), route: 'decision/supervisor', permissions: [permission], ...(result.ok ? { actorId: result.supervisorId } : {}), outcome: result.ok ? 'allow' : 'deny', httpStatus: result.ok ? 200 : result.status, at: new Date().toISOString(), decisionCode: result.ok ? 'authorized' : `http-${result.status}` })
  } catch (error) {
    console.error('[authorization-audit] durable append failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false, status: 503, reason: 'Authorization audit storage is unavailable.' }
  }
  return result
}

/** The pure core of `verifySupervisorCredential`: the Authorization header value and the environment in, a verdict out. */
export function checkSupervisorCredential(authorization: string | null, permission: Permission, env: CredentialEnv): SupervisorCredentialResult {
  let provider: StaticTokenIdentityProvider | null
  try {
    provider = principalProvider(env)
  } catch {
    return { ok: false, status: 503, reason: 'Supervisor principals are misconfigured.' }
  }
  if (provider) {
    const principal = provider.authenticateHeader(authorization)
    if (!principal) return { ok: false, status: 401, reason: 'A valid supervisor credential is required.' }
    const decision = accessController.authorize(principal, permission, { tenantId: tenantOf(env), kind: 'decision' })
    if (!decision.allowed || principal.kind !== 'human') {
      return { ok: false, status: 403, reason: 'This credential is not permitted to perform this supervisor action.' }
    }
    return { ok: true, supervisorId: principal.id }
  }
  return checkSharedSupervisorToken(authorization, env)
}

/** The interim single `NQC_SUPERVISOR_TOKEN` credential (used only while `QUICKSILVER_PRINCIPALS` is unset). */
function checkSharedSupervisorToken(authorization: string | null, env: CredentialEnv): SupervisorCredentialResult {
  const expected = env.NQC_SUPERVISOR_TOKEN
  const supervisorId = env.NQC_SUPERVISOR_ID
  if (!expected || expected.length < 32 || !supervisorId) {
    return { ok: false, status: 503, reason: 'Supervisor approval is not configured.' }
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '')
  if (!match) return { ok: false, status: 401, reason: 'A valid supervisor credential is required.' }

  const supplied = Buffer.from(match[1]!, 'utf8')
  const configured = Buffer.from(expected, 'utf8')
  if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) {
    return { ok: false, status: 401, reason: 'A valid supervisor credential is required.' }
  }
  return { ok: true, supervisorId }
}

export type DecisionRoute = 'execute' | 'observe' | 'resume'

/**
 * What each decision route requires of its caller (any one listed permission
 * suffices). `execute` also requires a human principal: it goes through
 * `checkSupervisorCredential`, exactly like approve and rollback.
 */
export const DECISION_ROUTE_PERMISSIONS: Readonly<Record<DecisionRoute, readonly Permission[]>> = Object.freeze({
  execute: Object.freeze<Permission[]>(['decision:execute']),
  observe: Object.freeze<Permission[]>(['decision:read', 'decision:propose']),
  resume: Object.freeze<Permission[]>(['decision:read', 'decision:propose']),
})

export type DecisionRouteAuthResult =
  | { ok: true; principalId: string }
  | { ok: false; reason: string; status: 401 | 403 | 503 }

/**
 * Authenticate and authorize the caller of a decision route before the route
 * reads or writes anything (threat model F-2). Request-level wrapper over
 * `checkDecisionRouteCaller` with `process.env`.
 */
export async function authorizeDecisionRoute(request: Request, route: DecisionRoute): Promise<DecisionRouteAuthResult> {
  let result: DecisionRouteAuthResult
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    result = checkDecisionRouteCaller(route, authorization, process.env)
  } else {
    try {
      const session = await readBrowserSession(request, process.env)
      if (!session) result = checkDecisionRouteCaller(route, null, process.env)
      else {
        const caller = checkPrincipalCaller(DECISION_ROUTE_PERMISSIONS[route], { id: session.id, kind: session.kind, tenantId: session.tenantId, roles: session.roles, ...(session.displayName ? { displayName: session.displayName } : {}) }, process.env)
        if (!caller.ok) result = { ok: false, status: caller.status, reason: caller.reason }
        else if (route === 'execute' && caller.kind !== 'human') result = { ok: false, status: 403, reason: 'A human principal is required to execute decisions.' }
        else result = { ok: true, principalId: caller.principalId }
      }
    } catch (error) {
      console.error('[oidc] session lookup failed', error instanceof Error ? error.name : 'UnknownError')
      result = { ok: false, status: 503, reason: 'Browser session storage is unavailable.' }
    }
  }
  const permissions = DECISION_ROUTE_PERMISSIONS[route]
  try {
    await appendAuthorizationDecision({ tenantId: tenantOf(process.env), route: `decision/${route}`, permissions, ...(result.ok ? { actorId: result.principalId } : {}), outcome: result.ok ? 'allow' : 'deny', httpStatus: result.ok ? 200 : result.status, at: new Date().toISOString(), decisionCode: result.ok ? 'authorized' : `http-${result.status}` })
  } catch (error) {
    console.error('[authorization-audit] durable append failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false, status: 503, reason: 'Authorization audit storage is unavailable.' }
  }
  return result
}

export function approvalFingerprintWasReviewed(expected: string | undefined, current: string | null): boolean {
  return current !== null && expected !== undefined && expected === current
}

export interface DecisionApprovalRecord {
  id?: string
  requestId?: string
  actionFingerprint?: string
  policySnapshotVersion?: string
  supervisorId?: string
  grantedAt?: string
}

/** True only when the stored approval still binds this exact decision snapshot. */
export function approvalMatchesDecision(input: {
  decisionId: string
  selectedAction: string
  policySnapshotVersion: string | null | undefined
  riskLevel: number | null | undefined
  requiredApproval: boolean | null | undefined
  approvedById: string | null | undefined
  approval: DecisionApprovalRecord | null | undefined
}): boolean {
  const { approval } = input
  if (!input.policySnapshotVersion || !approval?.id || !approval.supervisorId || !approval.grantedAt) return false
  return approval.requestId === input.decisionId
    && approval.actionFingerprint === decisionActionFingerprint({
      decisionId: input.decisionId,
      selectedAction: input.selectedAction,
      policySnapshotVersion: input.policySnapshotVersion,
      riskLevel: input.riskLevel ?? 0,
      requiredApproval: input.requiredApproval ?? false,
    })
    && approval.policySnapshotVersion === input.policySnapshotVersion
    && input.approvedById === approval.supervisorId
}

export type DecisionExecutionGate =
  | { allowed: true; approvalRequired: boolean; actionFingerprint: string }
  | { allowed: false; reason: 'kernel-blocked' | 'policy-changed' | 'approval-required' }

/** The pure gate used immediately before decision execution side effects. */
export function evaluateDecisionExecutionGate(input: {
  decisionId: string
  selectedAction: string
  riskLevel: number | null | undefined
  requiredApproval: boolean | null | undefined
  safetyDecision: string | null | undefined
  policySnapshotVersion: string | null | undefined
  livePolicySnapshotVersion: string | null | undefined
  approvedById: string | null | undefined
  approval: DecisionApprovalRecord | null | undefined
}): DecisionExecutionGate {
  if (input.safetyDecision === 'BLOCK') return { allowed: false, reason: 'kernel-blocked' }
  if (!input.policySnapshotVersion || input.livePolicySnapshotVersion !== input.policySnapshotVersion) {
    return { allowed: false, reason: 'policy-changed' }
  }
  const approvalRequired = input.requiredApproval === true
    || input.safetyDecision === 'ESCALATE'
    || (input.riskLevel ?? 0) >= 4
  const actionFingerprint = decisionActionFingerprint({
    decisionId: input.decisionId,
    selectedAction: input.selectedAction,
    policySnapshotVersion: input.policySnapshotVersion,
    riskLevel: input.riskLevel ?? 0,
    requiredApproval: input.requiredApproval ?? false,
  })
  if (approvalRequired && !approvalMatchesDecision({
    decisionId: input.decisionId,
    selectedAction: input.selectedAction,
    policySnapshotVersion: input.policySnapshotVersion,
    riskLevel: input.riskLevel,
    requiredApproval: input.requiredApproval,
    approvedById: input.approvedById,
    approval: input.approval,
  })) return { allowed: false, reason: 'approval-required' }
  return { allowed: true, approvalRequired, actionFingerprint }
}

/**
 * The pure decision-route check: route, Authorization header value and
 * environment in, a verdict out.
 *
 * - `execute`: the supervisor credential check with `decision:execute` (a
 *   human principal), the same check approve and rollback use.
 * - `observe`, `resume`: any valid principal holding `decision:read` or
 *   `decision:propose` in `QUICKSILVER_TENANT_ID`.
 *
 * Without `QUICKSILVER_PRINCIPALS`, the interim shared supervisor token is the
 * only accepted credential (a supervisor holds all three permissions).
 */
export function checkDecisionRouteCaller(route: DecisionRoute, authorization: string | null, env: CredentialEnv): DecisionRouteAuthResult {
  const permissions = Object.hasOwn(DECISION_ROUTE_PERMISSIONS, route) ? DECISION_ROUTE_PERMISSIONS[route] : undefined
  if (!permissions) return { ok: false, status: 403, reason: 'Unknown decision route.' }
  if (route === 'execute') {
    const supervisor = checkSupervisorCredential(authorization, 'decision:execute', env)
    return supervisor.ok ? { ok: true, principalId: supervisor.supervisorId } : supervisor
  }

  let provider: StaticTokenIdentityProvider | null
  try {
    provider = principalProvider(env)
  } catch {
    return { ok: false, status: 503, reason: 'Principals are misconfigured.' }
  }
  const caller = checkRouteCaller(permissions, authorization, env)
  return caller.ok ? { ok: true, principalId: caller.principalId } : caller
}

export type RouteCallerResult =
  | { ok: true; principalId: string; kind: PrincipalKind }
  | { ok: false; reason: string; status: 401 | 403 | 503 }

/**
 * The shared credential check for the web app's API routes (threat model A-3):
 * a valid principal holding at least one of `permissions` in
 * `QUICKSILVER_TENANT_ID`. Pure: Authorization header value and environment
 * in, a verdict out.
 *
 * - With `QUICKSILVER_PRINCIPALS` set, the bearer token must match a
 *   per-person principal (401 otherwise) that holds one of the permissions
 *   (403 otherwise).
 * - Without it, the interim shared `NQC_SUPERVISOR_TOKEN` is the only
 *   accepted credential, and it holds `SHARED_SUPERVISOR_PERMISSIONS`.
 * - With neither configured, 503: nothing is anonymous any more.
 */
export function checkRouteCaller(permissions: readonly Permission[], authorization: string | null, env: CredentialEnv): RouteCallerResult {
  if (permissions.length === 0) return { ok: false, status: 403, reason: 'This route names no permission.' }
  let provider: StaticTokenIdentityProvider | null
  try {
    provider = principalProvider(env)
  } catch {
    return { ok: false, status: 503, reason: 'Principals are misconfigured.' }
  }
  if (!provider) {
    const shared = checkSharedSupervisorToken(authorization, env)
    if (!shared.ok) return shared
    if (!permissions.some((permission) => SHARED_SUPERVISOR_PERMISSIONS.includes(permission))) {
      return { ok: false, status: 403, reason: 'The shared supervisor token is not permitted to perform this action.' }
    }
    return { ok: true, principalId: shared.supervisorId, kind: 'human' }
  }
  const principal = provider.authenticateHeader(authorization)
  if (!principal) return { ok: false, status: 401, reason: 'A valid credential is required.' }
  const tenantId = tenantOf(env)
  const allowed = permissions.some((permission) => quietAccessController.authorize(principal, permission, { tenantId, kind: 'decision' }).allowed)
  if (!allowed) {
    // Log one denial (the first permission) rather than one per permission probed.
    accessController.authorize(principal, permissions[0]!, { tenantId, kind: 'decision' })
    return { ok: false, status: 403, reason: 'This credential is not permitted to perform this action.' }
  }
  return { ok: true, principalId: principal.id, kind: principal.kind }
}

/** Apply the same tenant and permission checks to a server-verified human principal. */
export function checkPrincipalCaller(permissions: readonly Permission[], principal: Principal, env: CredentialEnv): RouteCallerResult {
  if (!permissions.length) return { ok: false, status: 403, reason: 'This route names no permission.' }
  if (validatePrincipal(principal).length) return { ok: false, status: 503, reason: 'Authenticated principal data is invalid.' }
  if (principal.tenantId !== tenantOf(env)) return { ok: false, status: 403, reason: 'This principal belongs to another tenant.' }
  if (permissions.some((permission) => quietAccessController.authorize(principal, permission, { tenantId: tenantOf(env), kind: 'decision' }).allowed)) {
    return { ok: true, principalId: principal.id, kind: principal.kind }
  }
  accessController.authorize(principal, permissions[0]!, { tenantId: tenantOf(env), kind: 'decision' })
  return { ok: false, status: 403, reason: 'This credential is not permitted to perform this action.' }
}

/**
 * What the interim shared `NQC_SUPERVISOR_TOKEN` can do in the web app: the
 * decision routes (approve, execute, rollback, observe, resume), and, as the
 * one founder it stands for, planning (`decision:propose`), asking
 * (`decision:read`) and the workflow builder's validate and simulate
 * (`workflow:read`). Live workflow runs (`run:enqueue`) need a per-person
 * principal. Retire the shared token with SSO (threat model B-1).
 */
export const SHARED_SUPERVISOR_PERMISSIONS: readonly Permission[] = Object.freeze<Permission[]>([
  'decision:read',
  'decision:propose',
  'decision:approve',
  'decision:execute',
  'decision:rollback',
  'workflow:read',
  'finance:read',
])

/** Who a credential belongs to, as `GET /api/whoami` reports it. Never carries a token or digest. */
export interface WhoamiBody {
  principalId: string
  kind: PrincipalKind
  tenantId: string
  displayName?: string
  /** Permissions this principal holds in `QUICKSILVER_TENANT_ID` (empty for another tenant). */
  permissions: Permission[]
  /** Which credential scheme matched: a per-person principal, or the interim shared supervisor token. */
  credential: 'principal' | 'shared-supervisor'
}

export type WhoamiResult =
  | { ok: true; status: 200; body: WhoamiBody }
  | { ok: false; status: 401 | 503; body: { error: string } }


/**
 * The pure core of `GET /api/whoami`: validate the Authorization header with
 * the same helpers the decision routes use and report who it belongs to. It
 * grants nothing; each route still runs its own check.
 */
/** The same answer for a principal that is already authenticated, such as a signed-in browser session. */
export function checkWhoamiPrincipal(principal: Principal, env: CredentialEnv): WhoamiResult {
  if (validatePrincipal(principal).length) return { ok: false, status: 503, body: { error: 'Authenticated principal data is invalid.' } }
  const tenantId = tenantOf(env)
  const permissions = PERMISSIONS.filter((permission) => quietAccessController.authorize(principal, permission, { tenantId, kind: 'decision' }).allowed)
  return {
    ok: true,
    status: 200,
    body: {
      principalId: principal.id,
      kind: principal.kind,
      tenantId: principal.tenantId,
      ...(principal.displayName ? { displayName: principal.displayName } : {}),
      permissions,
      credential: 'principal',
    },
  }
}

export function checkWhoami(authorization: string | null, env: CredentialEnv): WhoamiResult {
  let provider: StaticTokenIdentityProvider | null
  try {
    provider = principalProvider(env)
  } catch {
    return { ok: false, status: 503, body: { error: 'Principals are misconfigured.' } }
  }
  const tenantId = tenantOf(env)
  if (provider) {
    const principal = provider.authenticateHeader(authorization)
    if (!principal) return { ok: false, status: 401, body: { error: 'A valid credential is required.' } }
    return checkWhoamiPrincipal(principal, env)
  }
  const shared = checkSharedSupervisorToken(authorization, env)
  if (!shared.ok) return { ok: false, status: shared.status === 503 ? 503 : 401, body: { error: shared.reason } }
  return {
    ok: true,
    status: 200,
    body: { principalId: shared.supervisorId, kind: 'human', tenantId, permissions: [...SHARED_SUPERVISOR_PERMISSIONS], credential: 'shared-supervisor' },
  }
}
