/**
 * Nuera Quicksilver identity and role-based access control (v1).
 *
 * Pure, deterministic, dependency-free: safe to import anywhere. Credential
 * verification lives in `./tokens.ts` (server-only). Rules:
 *
 * - Deny by default. A permission is granted only by a role the principal holds.
 * - Tenants are hard boundaries. A principal can never act on another tenant's
 *   resource; there is no cross-tenant super-role.
 * - Agents never hold authority. Agent principals cannot be given permissions
 *   that approve, redrive, administer, or read secrets, mirroring the agent
 *   manifest rule that agents propose and the NQC Kernel authorizes.
 * - Separation of duties. Whoever proposed or requested an action cannot
 *   approve it.
 * - Every decision, allow or deny, can be sent to an audit sink.
 */

export const PERMISSIONS = [
  'workflow:read',
  'workflow:write',
  'workflow:publish',
  'run:read',
  'run:enqueue',
  'run:cancel',
  'run:redrive',
  'decision:read',
  'decision:propose',
  'decision:approve',
  'decision:execute',
  'decision:rollback',
  'memory:approve',
  'routing:approve',
  'secret:use',
  'secret:read',
  'secret:write',
  'audit:read',
  'tenant:admin',
  'intent:provide',
  'intent:rules',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Permissions that exercise authority over actions, policy, secrets, or people. */
export const AUTHORITY_PERMISSIONS: readonly Permission[] = Object.freeze([
  'workflow:publish',
  'run:redrive',
  'decision:approve',
  'decision:execute',
  'decision:rollback',
  'memory:approve',
  'routing:approve',
  'secret:read',
  'secret:write',
  'tenant:admin',
  'intent:provide',
  'intent:rules',
])

/** Permissions that require the actor to be someone other than the proposer/requester. */
export const SEPARATION_OF_DUTIES: readonly Permission[] = Object.freeze([
  'decision:approve',
  'memory:approve',
  'routing:approve',
  'workflow:publish',
])

export type PrincipalKind = 'human' | 'service' | 'agent'

export interface Principal {
  /** Stable identifier, e.g. `user:ana@acme.com`, `svc:erp-webhook`, `agent:nuera-quicksilver:query`. */
  id: string
  kind: PrincipalKind
  tenantId: string
  roles: readonly string[]
  displayName?: string
  disabled?: boolean
}

export interface RoleDefinition {
  id: string
  description: string
  permissions: readonly Permission[]
  /** Built-in roles are global; custom roles belong to exactly one tenant. */
  tenantId?: string
}

export interface AccessResource {
  tenantId: string
  /** Principal that proposed, requested, or authored the resource, for separation of duties. */
  requestedBy?: string
  /** Free-form identifier for the audit trail (run id, decision id, secret name). */
  id?: string
  kind?: string
}

export interface AccessDecision {
  allowed: boolean
  permission: Permission
  principalId: string
  principalKind: PrincipalKind | 'unknown'
  tenantId: string
  resourceId?: string
  resourceKind?: string
  /** Roles that granted the permission (empty when denied). */
  grantedBy: string[]
  reasons: string[]
  at: number
}

export class AccessDeniedError extends Error {
  readonly decision: AccessDecision
  constructor(decision: AccessDecision) {
    super(`Access denied: ${decision.reasons.join(' ')}`)
    this.name = 'AccessDeniedError'
    this.decision = decision
  }
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+-]{0,199}$/
const TENANT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/
const PERMISSION_SET = new Set<string>(PERMISSIONS)

/** Built-in roles. Custom tenant roles may compose any valid permissions. */
export const BUILT_IN_ROLES: readonly RoleDefinition[] = Object.freeze([
  role('viewer', 'Read workflows, runs, and decisions.', ['workflow:read', 'run:read', 'decision:read']),
  role('operator', 'Start and cancel runs of published workflows.', ['workflow:read', 'run:read', 'run:enqueue', 'run:cancel', 'decision:read']),
  role('developer', 'Author workflows and run them; cannot publish or approve.', ['workflow:read', 'workflow:write', 'run:read', 'run:enqueue', 'run:cancel', 'decision:read', 'decision:propose', 'secret:use']),
  role('supervisor', 'Human authority for approvals, execution, rollback, redrive, and governed memory/routing changes.', ['workflow:read', 'workflow:publish', 'run:read', 'run:cancel', 'run:redrive', 'decision:read', 'decision:approve', 'decision:execute', 'decision:rollback', 'memory:approve', 'routing:approve', 'audit:read']),
  role('auditor', 'Read-only access including the audit trail.', ['workflow:read', 'run:read', 'decision:read', 'audit:read']),
  role('tenant-admin', 'Manage roles, principals, and secrets for one tenant.', ['workflow:read', 'run:read', 'decision:read', 'audit:read', 'secret:read', 'secret:write', 'secret:use', 'tenant:admin']),
  role('trigger', 'Service identity for webhooks and schedules: may only enqueue runs.', ['run:enqueue']),
  role('intent-provider', 'Aura intent provider: states goals, weights, horizons, autonomy and customer commitments. The only source of intent.', ['decision:read', 'audit:read', 'intent:provide']),
  role('intent-admin', 'Sets how several intent providers decide (the decision rule). No input into intent itself.', ['decision:read', 'audit:read', 'intent:rules']),
  role('agent-worker', 'Nuera Quicksilver Agent identity: read context and propose, never authorize.', ['workflow:read', 'run:read', 'decision:read', 'decision:propose', 'secret:use']),
])

function role(id: string, description: string, permissions: Permission[]): RoleDefinition {
  return Object.freeze({ id, description, permissions: Object.freeze([...permissions]) })
}

export function validatePrincipal(principal: Principal): string[] {
  if (!principal || typeof principal !== 'object') return ['Principal must be an object.']
  const errors: string[] = []
  if (typeof principal.id !== 'string' || !ID_PATTERN.test(principal.id)) errors.push('Principal id is invalid.')
  if (!['human', 'service', 'agent'].includes(principal.kind)) errors.push('Principal kind must be human, service, or agent.')
  if (typeof principal.tenantId !== 'string' || !TENANT_PATTERN.test(principal.tenantId)) errors.push('Principal tenantId is invalid.')
  if (!Array.isArray(principal.roles) || principal.roles.some((r) => typeof r !== 'string' || !ROLE_PATTERN.test(r))) errors.push('Principal roles must be role identifiers.')
  return errors
}

export interface AccessControllerOptions {
  /** Tenant-scoped custom roles, in addition to the built-ins. */
  customRoles?: readonly RoleDefinition[]
  /** Receives every decision. Errors thrown by the sink never change the decision. */
  audit?: (decision: AccessDecision) => void
  now?: () => number
}

/** Deny-by-default RBAC evaluator with tenant isolation and separation of duties. */
export class AccessController {
  private readonly roles = new Map<string, RoleDefinition>()
  private readonly audit?: (decision: AccessDecision) => void
  private readonly now: () => number

  constructor(options: AccessControllerOptions = {}) {
    for (const builtIn of BUILT_IN_ROLES) this.roles.set(roleKey(builtIn.id), builtIn)
    for (const custom of options.customRoles ?? []) this.defineRole(custom)
    this.audit = options.audit
    this.now = options.now ?? Date.now
  }

  /** Add a tenant-scoped custom role. Built-in role ids cannot be redefined. */
  defineRole(definition: RoleDefinition): Readonly<RoleDefinition> {
    const errors: string[] = []
    if (!definition || typeof definition !== 'object') throw new Error('Role definition must be an object.')
    if (typeof definition.id !== 'string' || !ROLE_PATTERN.test(definition.id)) errors.push('Role id is invalid.')
    if (typeof definition.tenantId !== 'string' || !TENANT_PATTERN.test(definition.tenantId)) errors.push('Custom roles must belong to one tenant.')
    if (!Array.isArray(definition.permissions) || definition.permissions.length === 0) errors.push('Role needs at least one permission.')
    else if (definition.permissions.some((p) => !PERMISSION_SET.has(p))) errors.push('Role contains an unknown permission.')
    if (BUILT_IN_ROLES.some((r) => r.id === definition.id)) errors.push(`"${definition.id}" is a built-in role and cannot be redefined.`)
    const key = roleKey(definition.id, definition.tenantId)
    if (this.roles.has(key)) errors.push(`Role "${definition.id}" already exists for this tenant.`)
    if (errors.length) throw new Error(`Invalid role "${definition?.id ?? 'unknown'}": ${errors.join(' ')}`)
    const frozen = Object.freeze({ ...definition, permissions: Object.freeze([...new Set(definition.permissions)]) })
    this.roles.set(key, frozen)
    return frozen
  }

  /** Effective permissions for a principal, with the roles that grant each. */
  effectivePermissions(principal: Principal): Map<Permission, string[]> {
    const granted = new Map<Permission, string[]>()
    if (validatePrincipal(principal).length || principal.disabled) return granted
    for (const roleId of principal.roles) {
      const definition = this.roles.get(roleKey(roleId, principal.tenantId)) ?? this.roles.get(roleKey(roleId))
      if (!definition) continue
      for (const permission of definition.permissions) {
        if (principal.kind === 'agent' && AUTHORITY_PERMISSIONS.includes(permission)) continue
        granted.set(permission, [...(granted.get(permission) ?? []), roleId])
      }
    }
    return granted
  }

  authorize(principal: Principal | undefined, permission: Permission, resource: AccessResource): AccessDecision {
    const reasons: string[] = []
    let grantedBy: string[] = []
    if (!PERMISSION_SET.has(permission)) reasons.push(`Unknown permission "${String(permission)}".`)
    if (!resource || typeof resource.tenantId !== 'string' || !TENANT_PATTERN.test(resource.tenantId)) reasons.push('Resource tenant is missing or invalid.')
    if (!principal) reasons.push('No authenticated principal.')
    else {
      const principalErrors = validatePrincipal(principal)
      if (principalErrors.length) reasons.push(...principalErrors)
      else {
        if (principal.disabled) reasons.push(`Principal "${principal.id}" is disabled.`)
        if (resource && principal.tenantId !== resource.tenantId) reasons.push('Principal and resource belong to different tenants.')
        if (principal.kind === 'agent' && AUTHORITY_PERMISSIONS.includes(permission)) reasons.push('Agents cannot hold authority permissions; a human supervisor must act.')
        if (SEPARATION_OF_DUTIES.includes(permission) && resource?.requestedBy && resource.requestedBy === principal.id) {
          reasons.push('Separation of duties: the requester cannot approve their own request.')
        }
        grantedBy = this.effectivePermissions(principal).get(permission) ?? []
        if (grantedBy.length === 0 && reasons.length === 0) reasons.push(`No role grants "${permission}" to "${principal.id}".`)
      }
    }

    const allowed = reasons.length === 0
    const decision: AccessDecision = {
      allowed,
      permission,
      principalId: principal?.id ?? 'anonymous',
      principalKind: principal?.kind ?? 'unknown',
      tenantId: resource?.tenantId ?? 'unknown',
      ...(resource?.id ? { resourceId: resource.id } : {}),
      ...(resource?.kind ? { resourceKind: resource.kind } : {}),
      grantedBy: allowed ? grantedBy : [],
      reasons,
      at: this.now(),
    }
    try {
      this.audit?.(decision)
    } catch {
      // Audit sinks must not change access decisions.
    }
    return decision
  }

  /** Throw `AccessDeniedError` unless allowed. */
  assert(principal: Principal | undefined, permission: Permission, resource: AccessResource): AccessDecision {
    const decision = this.authorize(principal, permission, resource)
    if (!decision.allowed) throw new AccessDeniedError(decision)
    return decision
  }
}

export function isPrincipal(value: unknown): value is Principal {
  return !!value && typeof value === 'object' && validatePrincipal(value as Principal).length === 0
}

function roleKey(id: string, tenantId?: string): string {
  return tenantId ? `${tenantId}\u0000${id}` : `*\u0000${id}`
}
