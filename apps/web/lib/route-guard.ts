/**
 * Who may call each web API route, and how often (threat model A-3, A-5).
 *
 * Every route under app/api requires a valid principal (a per-person
 * principal token, or the interim shared supervisor token) before it reads a
 * body, calls a model or touches Sanity. `app-routes.test.ts` imports every
 * route module and checks the 401 and 403 cases, so a route that forgets this
 * fails the suite.
 *
 * Rate limits are per principal token buckets (the kernel's shared
 * `TokenBucketLimiter`):
 * - `model`: routes that call a model provider (plan, query, live workflow
 *   runs). `QUICKSILVER_WEB_RATE_LIMIT_MODEL`, default `5/10` (burst 5, then
 *   10 a minute).
 * - `write`: routes that write to Sanity without a model (the decision
 *   routes). `QUICKSILVER_WEB_RATE_LIMIT_WRITE`, default `30/60`.
 *
 * The buckets live in this process's memory. On Vercel each serverless
 * instance has its own, so the limit is per instance, not global, and resets
 * on a cold start; it bounds one caller's burst, not total spend. There is no
 * shared datastore for this on purpose (see hosted-runtime.md).
 */
import type { Permission } from '@quicksilver/kernel'
import { TokenBucketLimiter, parseRateLimitSetting, type RateLimitConfig } from '@quicksilver/kernel/rate-limit'
import { checkPrincipalCaller, checkRouteCaller, type CredentialEnv } from './nqc-approval.ts'
import { appendAuthorizationDecision, type AuthorizationAuditRecord } from './authorization-audit-store.ts'
import { readBrowserSession } from './oidc-browser-auth.ts'

export type WebRateLimitClass = 'write' | 'model'

export const DEFAULT_WEB_RATE_LIMITS: Readonly<Record<WebRateLimitClass, RateLimitConfig>> = Object.freeze({
  model: Object.freeze({ burst: 5, perMinute: 10 }),
  write: Object.freeze({ burst: 30, perMinute: 60 }),
})

const RATE_LIMIT_ENV: Readonly<Record<WebRateLimitClass, string>> = Object.freeze({
  model: 'QUICKSILVER_WEB_RATE_LIMIT_MODEL',
  write: 'QUICKSILVER_WEB_RATE_LIMIT_WRITE',
})

/** The routes (other than the decision routes, which have their own checks) and what each needs. */
export type WebRoute =
  | 'plan' | 'query' | 'agents/run' | 'dashboard/overview' | 'dashboard/finance'
  | 'entities'
  | 'monitoring/workflows' | 'monitoring/traces'
  | 'agents/catalog' | 'agents/definitions' | 'agents/drafts' | 'agents/drafts/submit' | 'agents/review' | 'agents/publish' | 'agents/rollback'
  | 'workflows/validate' | 'workflows/simulate' | 'workflows/run' | 'workflows/diff'
  | 'workflows/publications' | 'workflows/executions' | 'workflows/drafts' | 'workflows/drafts/submit'
  | 'workflows/review' | 'workflows/publish' | 'workflows/rollback'

export const WEB_ROUTE_ACCESS: Readonly<Record<WebRoute, { permissions: readonly Permission[]; rateLimit?: WebRateLimitClass }>> = Object.freeze({
  // Planning calls the planner and reviewer models and writes decision documents.
  plan: { permissions: Object.freeze<Permission[]>(['decision:propose']), rateLimit: 'model' },
  // A question to the query agent (a model) that writes an evaluation record.
  query: { permissions: Object.freeze<Permission[]>(['decision:read']), rateLimit: 'model' },
  // Business agents are proposal-only workers with the same read boundary as Ask mode.
  'agents/run': { permissions: Object.freeze<Permission[]>(['decision:read']), rateLimit: 'model' },
  // The entity directory uses the same company-read boundary as Ask mode.
  entities: { permissions: Object.freeze<Permission[]>(['decision:read']) },
  'dashboard/overview': { permissions: Object.freeze<Permission[]>(['decision:read']) },
  'dashboard/finance': { permissions: Object.freeze<Permission[]>(['finance:read']) },
  'monitoring/workflows': { permissions: Object.freeze<Permission[]>(['workflow:read']) },
  'monitoring/traces': { permissions: Object.freeze<Permission[]>(['audit:read']) },
  // Agent definitions are governed declarative contracts, not executable plugins.
  'agents/catalog': { permissions: Object.freeze<Permission[]>(['agent:read']) },
  'agents/definitions': { permissions: Object.freeze<Permission[]>(['agent:read']) },
  'agents/drafts': { permissions: Object.freeze<Permission[]>(['agent:write']), rateLimit: 'write' },
  'agents/drafts/submit': { permissions: Object.freeze<Permission[]>(['agent:write']), rateLimit: 'write' },
  'agents/review': { permissions: Object.freeze<Permission[]>(['agent:review']), rateLimit: 'write' },
  'agents/publish': { permissions: Object.freeze<Permission[]>(['agent:publish']), rateLimit: 'write' },
  'agents/rollback': { permissions: Object.freeze<Permission[]>(['agent:write']), rateLimit: 'write' },
  // Stateless checks of a graph the caller sends: no model, no write.
  'workflows/validate': { permissions: Object.freeze<Permission[]>(['workflow:read']) },
  'workflows/simulate': { permissions: Object.freeze<Permission[]>(['workflow:read']) },
  // A live run calls the query agent: the same permission the host checks for POST /api/runs.
  'workflows/run': { permissions: Object.freeze<Permission[]>(['run:enqueue']), rateLimit: 'model' },
  // Version listing is read-only; lifecycle writes use separate routes so
  // authorization is decided before request bodies are inspected (A-3).
  'workflows/publications': { permissions: Object.freeze<Permission[]>(['workflow:read']) },
  'workflows/diff': { permissions: Object.freeze<Permission[]>(['workflow:read']) },
  'workflows/executions': { permissions: Object.freeze<Permission[]>(['workflow:read']) },
  'workflows/drafts': { permissions: Object.freeze<Permission[]>(['workflow:write']), rateLimit: 'write' },
  'workflows/drafts/submit': { permissions: Object.freeze<Permission[]>(['workflow:write']), rateLimit: 'write' },
  'workflows/review': { permissions: Object.freeze<Permission[]>(['workflow:publish']), rateLimit: 'write' },
  'workflows/publish': { permissions: Object.freeze<Permission[]>(['workflow:publish']), rateLimit: 'write' },
  'workflows/rollback': { permissions: Object.freeze<Permission[]>(['workflow:publish']), rateLimit: 'write' },
})

/** A refusal ready to return: status, JSON body and headers (Retry-After on 429). */
export interface GuardRefusal {
  ok: false
  status: 401 | 403 | 429 | 503
  body: { error: string; code: string; retryAfterSeconds?: number; needs?: readonly Permission[] }
  headers?: Record<string, string>
}

export type GuardResult = { ok: true; principalId: string; principalKind?: 'human' | 'service' | 'agent' } | GuardRefusal

const limiters = new Map<string, TokenBucketLimiter>()
const warned = new Set<string>()

/** The limit for a class from the environment (a malformed value falls back to the default, with one warning). */
export function webRateLimitConfig(cls: WebRateLimitClass, env: CredentialEnv): RateLimitConfig {
  const name = RATE_LIMIT_ENV[cls]
  const parsed = parseRateLimitSetting(env[name], DEFAULT_WEB_RATE_LIMITS[cls])
  if (parsed) return parsed
  if (!warned.has(name)) {
    warned.add(name)
    console.warn(`[rate-limit] ${name} must look like "burst/perMinute" (for example 5/10); using the default.`)
  }
  return { ...DEFAULT_WEB_RATE_LIMITS[cls] }
}

/**
 * Take one token for `principalId` in `cls`; null when allowed, else a 429
 * with Retry-After. `now` is for tests.
 */
export function takeWebRateLimit(cls: WebRateLimitClass, principalId: string, env: CredentialEnv = process.env, now: () => number = Date.now): GuardRefusal | null {
  const config = webRateLimitConfig(cls, env)
  const key = `${cls}:${config.burst}/${config.perMinute}`
  let limiter = limiters.get(key)
  if (!limiter) {
    limiter = new TokenBucketLimiter(config, now)
    limiters.set(key, limiter)
  }
  const r = limiter.take(principalId)
  if (r.ok) return null
  return {
    ok: false,
    status: 429,
    body: { error: `Too many requests; retry in ${r.retryAfterSeconds} s.`, code: 'rate-limited', retryAfterSeconds: r.retryAfterSeconds },
    headers: { 'retry-after': String(r.retryAfterSeconds) },
  }
}

/** Forget every bucket (tests only). */
export function resetWebRateLimits(): void {
  limiters.clear()
}

/**
 * Authenticate, authorize and rate-limit a call to `route`. Pure over its
 * inputs apart from the in-memory buckets.
 */
export function checkWebRoute(route: WebRoute, authorization: string | null, env: CredentialEnv = process.env): GuardResult {
  const access = WEB_ROUTE_ACCESS[route]
  const caller = checkRouteCaller(access.permissions, authorization, env)
  if (!caller.ok) {
    const code = caller.status === 401 ? 'unauthenticated' : caller.status === 403 ? 'forbidden' : 'unavailable'
    return { ok: false, status: caller.status, body: { error: caller.reason, code, ...(caller.status === 403 ? { needs: access.permissions } : {}) } }
  }
  if (access.rateLimit) {
    const limited = takeWebRateLimit(access.rateLimit, caller.principalId, env)
    if (limited) return limited
  }
  return { ok: true, principalId: caller.principalId }
}

/** `checkWebRoute` for a request, with `process.env`. */
/**
 * Request-level guard. The RBAC result is not used until its audit record has
 * been durably created. If the audit store is unavailable, fail closed.
 */
export async function persistWebRouteDecision(
  route: WebRoute,
  result: GuardResult,
  env: CredentialEnv,
  append: typeof appendAuthorizationDecision = appendAuthorizationDecision,
): Promise<GuardResult> {
  const access = WEB_ROUTE_ACCESS[route]
  const record: AuthorizationAuditRecord = {
    tenantId: env.QUICKSILVER_TENANT_ID?.trim() || 'default',
    route,
    permissions: access.permissions,
    ...(result.ok ? { actorId: result.principalId } : {}),
    outcome: result.ok ? 'allow' : 'deny',
    httpStatus: result.ok ? 200 : result.status,
    at: new Date().toISOString(),
    decisionCode: result.ok ? 'authorized' : result.body.code,
  }
  try {
    await append(record)
  } catch (error) {
    console.error('[authorization-audit] durable append failed', error instanceof Error ? error.name : 'UnknownError')
    return { ok: false, status: 503, body: { error: 'Authorization audit storage is unavailable.', code: 'authorization-audit-unavailable' } }
  }
  return result
}

export async function guardWebRoute(request: Request, route: WebRoute): Promise<GuardResult> {
  const env = process.env
  const access = WEB_ROUTE_ACCESS[route]
  const authorizationHeader = request.headers.get('authorization')
  let caller = authorizationHeader !== null ? checkRouteCaller(access.permissions, authorizationHeader, env) : null
  if (!caller) {
    try {
      const browserPrincipal = await readBrowserSession(request, env)
      caller = browserPrincipal
        ? checkPrincipalCaller(access.permissions, {
          id: browserPrincipal.id,
          kind: browserPrincipal.kind,
          tenantId: browserPrincipal.tenantId,
          roles: browserPrincipal.roles,
          ...(browserPrincipal.displayName ? { displayName: browserPrincipal.displayName } : {}),
        }, env)
        : checkRouteCaller(access.permissions, null, env)
    } catch (error) {
      console.error('[oidc] session lookup failed', error instanceof Error ? error.name : 'UnknownError')
      caller = { ok: false, status: 503, reason: 'Browser session storage is unavailable.' }
    }
  }
  const authorization: GuardResult = caller.ok
    ? { ok: true, principalId: caller.principalId, principalKind: caller.kind }
    : { ok: false, status: caller.status, body: { error: caller.reason, code: caller.status === 401 ? 'unauthenticated' : caller.status === 403 ? 'forbidden' : 'unavailable', ...(caller.status === 403 ? { needs: access.permissions } : {}) } }
  const persisted = await persistWebRouteDecision(route, authorization, env)
  if (!caller.ok) return persisted
  if (!persisted.ok) return persisted
  if (access.rateLimit) {
    const limited = takeWebRateLimit(access.rateLimit, caller.principalId, env)
    if (limited) return limited
  }
  return { ...persisted, principalKind: caller.kind }
}
