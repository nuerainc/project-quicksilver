import type { Permission } from '@quicksilver/kernel/identity'

/**
 * The host's route table: every HTTP route the host serves, with who may call
 * it and which rate limit applies (threat model A-5, A-9, T-03, T-05).
 *
 * `dispatch()` in host.ts matches every request against this table first. A
 * path under `/api` that is not in the table is a 404 before any handler
 * runs, so a handler cannot serve a route the table does not list; the route
 * that matches then gets its permission checked and its rate limit applied
 * centrally, before the handler (which keeps its own finer checks: humans
 * only, the submitter, separation of duties). `host-routes.test.ts` walks
 * this table, so a new route is covered by the 401/403 test automatically.
 *
 * Access:
 * - `public`: no credential. Each one carries the reason it is public, and
 *   the test pins the list, so adding one is a reviewed change.
 * - `principal`: any valid bearer token; nothing is granted by it.
 * - `permission`: the caller must hold at least one of `anyOf` in the host's
 *   tenant. That is a floor: the handler may require more.
 *
 * Rate limits (per principal, token bucket, in memory; `http.rateLimits` in
 * the host config):
 * - `write`: routes that change state.
 * - `model`: routes that call a model provider (or enqueue a run that does).
 * - `webhook`: per endpoint id, before the signature is checked.
 * - `tasks`: task submission keeps its own per-client bucket (`tasks.rateLimit`).
 */

export type HostRouteFeature = 'intent' | 'shadow' | 'genesis' | 'decisions' | 'tasks' | 'vault'
export type HostRateLimitClass = 'write' | 'model' | 'webhook' | 'tasks'

export type HostRouteAccess =
  | { kind: 'public'; reason: string }
  | { kind: 'principal'; reason: string }
  | { kind: 'permission'; anyOf: readonly Permission[]; /** `metricsPublic` turns this route public (private networks only). */ publicWhen?: 'metricsPublic' }

export interface HostRoute {
  method: 'GET' | 'POST' | 'PUT'
  /** Path pattern; `:name` matches one non-empty segment. */
  path: string
  access: HostRouteAccess
  /** The route exists only when this part of the host is configured (else 404). */
  feature?: HostRouteFeature
  rateLimit?: HostRateLimitClass
}

const anyOf = (...permissions: Permission[]): HostRouteAccess => ({ kind: 'permission', anyOf: Object.freeze(permissions) })
const TASK_READERS = anyOf('task:read', 'task:read-own', 'task:submit')

export const HOST_ROUTES: readonly HostRoute[] = Object.freeze<HostRoute[]>([
  // ── Public (reviewed): each says why it needs no credential ──
  { method: 'GET', path: '/healthz', access: { kind: 'public', reason: 'Liveness probe for the platform; returns {status:"ok"} and nothing else.' } },
  { method: 'GET', path: '/readyz', access: { kind: 'public', reason: 'Readiness probe for the platform; returns ready or not ready and nothing else.' } },
  { method: 'GET', path: '/', feature: 'intent', access: { kind: 'public', reason: 'The console page: static HTML with no data. It must load before sign-in; every call it makes sends the viewer\'s own token to /api.' } },
  { method: 'GET', path: '/console', feature: 'intent', access: { kind: 'public', reason: 'The same static console page as "/".' } },
  { method: 'POST', path: '/webhooks/:id', rateLimit: 'webhook', access: { kind: 'public', reason: 'Signed webhooks: authenticated by the per-endpoint HMAC signature (and replay cache), not a bearer token; rate-limited per endpoint.' } },
  { method: 'GET', path: '/metrics', access: { kind: 'permission', anyOf: Object.freeze<Permission[]>(['audit:read']), publicWhen: 'metricsPublic' } },

  // ── Any principal ──
  { method: 'GET', path: '/api/whoami', access: { kind: 'principal', reason: 'Reports who the token belongs to (id, kind, tenant, roles); grants nothing.' } },

  // ── Tasks (M7 part 4) ──
  { method: 'POST', path: '/api/tasks', feature: 'tasks', rateLimit: 'tasks', access: anyOf('task:submit') },
  { method: 'GET', path: '/api/tasks', feature: 'tasks', access: TASK_READERS },
  { method: 'GET', path: '/api/tasks/capabilities', feature: 'tasks', access: TASK_READERS },
  { method: 'GET', path: '/api/tasks/:id', feature: 'tasks', access: TASK_READERS },
  { method: 'POST', path: '/api/tasks/:id/cancel', feature: 'tasks', rateLimit: 'write', access: anyOf('task:read', 'task:read-own', 'task:submit', 'task:approve') },
  { method: 'POST', path: '/api/tasks/:id/approve', feature: 'tasks', rateLimit: 'write', access: anyOf('task:approve') },
  { method: 'POST', path: '/api/tasks/:id/deny', feature: 'tasks', rateLimit: 'write', access: anyOf('task:approve') },

  // ── Aura intents and the intent ledger ──
  // POST /api/intents calls the model parser when one is configured.
  { method: 'POST', path: '/api/intents', feature: 'intent', rateLimit: 'model', access: anyOf('intent:provide') },
  { method: 'GET', path: '/api/intents', feature: 'intent', access: anyOf('decision:read') },
  { method: 'GET', path: '/api/intents/:id', feature: 'intent', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/intents/:id/answers', feature: 'intent', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/intents/:id/dismiss', feature: 'intent', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'GET', path: '/api/intent-ledger/:company', feature: 'intent', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/intent-ledger/:company', feature: 'intent', rateLimit: 'write', access: anyOf('intent:provide', 'intent:rules') },

  // ── Shadow mode (M4) ──
  { method: 'GET', path: '/api/shadow/:intentId', feature: 'shadow', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/shadow/:intentId/recommendations', feature: 'shadow', rateLimit: 'write', access: anyOf('intent:provide', 'decision:propose') },
  { method: 'POST', path: '/api/shadow/:intentId/generate', feature: 'shadow', rateLimit: 'model', access: anyOf('intent:provide', 'decision:propose') },
  { method: 'POST', path: '/api/shadow/:intentId/recommendations/:recId/verdict', feature: 'shadow', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/shadow/:intentId/recommendations/:recId/outcome', feature: 'shadow', rateLimit: 'write', access: anyOf('intent:provide') },

  // ── Aura decision journal ──
  { method: 'GET', path: '/api/decisions', feature: 'decisions', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/decisions', feature: 'decisions', rateLimit: 'write', access: anyOf('intent:provide') },

  // ── Genesis (M5) ──
  { method: 'GET', path: '/api/genesis', feature: 'genesis', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/genesis/experiments', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide', 'decision:propose') },
  { method: 'POST', path: '/api/genesis/money', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/genesis/reviews', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/genesis/reviews/waes', feature: 'genesis', rateLimit: 'model', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/genesis/experiments/:id/start', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/genesis/experiments/:id/measurements', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide', 'decision:propose') },
  // Evaluate can apply a kill or close (stopping never needs more than decision:read, by design); it still writes.
  { method: 'POST', path: '/api/genesis/experiments/:id/evaluate', feature: 'genesis', rateLimit: 'write', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/genesis/experiments/:id/decide', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide') },
  // P-027: payments a verified Stripe webhook reported; confirm/reject are humans-only in the handler, like /money.
  { method: 'GET', path: '/api/genesis/pending-payments', feature: 'genesis', access: anyOf('decision:read') },
  { method: 'POST', path: '/api/genesis/pending-payments/:id/confirm', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide') },
  { method: 'POST', path: '/api/genesis/pending-payments/:id/reject', feature: 'genesis', rateLimit: 'write', access: anyOf('intent:provide') },

  // ── Runs ──
  { method: 'GET', path: '/api/runs', access: anyOf('run:read') },
  // A run executes agent steps, which call the model provider.
  { method: 'POST', path: '/api/runs', rateLimit: 'model', access: anyOf('run:enqueue') },
  { method: 'GET', path: '/api/runs/:id', access: anyOf('run:read') },
  { method: 'POST', path: '/api/runs/:id/cancel', rateLimit: 'write', access: anyOf('run:cancel') },
  { method: 'POST', path: '/api/runs/:id/redrive', rateLimit: 'model', access: anyOf('run:redrive') },
  { method: 'GET', path: '/api/dead-letters', access: anyOf('run:read') },
  { method: 'GET', path: '/api/stats', access: anyOf('run:read') },
  { method: 'GET', path: '/api/schedules', access: anyOf('run:read') },
  { method: 'GET', path: '/api/webhooks', access: anyOf('run:read') },
  { method: 'GET', path: '/api/workflows', access: anyOf('workflow:read') },
  { method: 'GET', path: '/api/workflows/:id', access: anyOf('workflow:read') },
  { method: 'POST', path: '/api/workflows/drafts', rateLimit: 'write', access: anyOf('workflow:write') },
  { method: 'POST', path: '/api/workflows/:id/submit-review', rateLimit: 'write', access: anyOf('workflow:write') },
  { method: 'POST', path: '/api/workflows/:id/review', rateLimit: 'write', access: anyOf('workflow:publish') },
  { method: 'POST', path: '/api/workflows/:id/publish', rateLimit: 'write', access: anyOf('workflow:publish') },
  { method: 'POST', path: '/api/workflows/:id/rollback', rateLimit: 'write', access: anyOf('workflow:publish') },

  // ── Secrets and administration ──
  { method: 'GET', path: '/api/secrets', feature: 'vault', access: anyOf('secret:read', 'secret:use') },
  { method: 'PUT', path: '/api/secrets/:name', feature: 'vault', rateLimit: 'write', access: anyOf('secret:write') },
  { method: 'POST', path: '/api/admin/reload-secrets', rateLimit: 'write', access: anyOf('tenant:admin') },
])

export interface HostRouteMatch {
  route: HostRoute
  params: Record<string, string>
}

function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split('/').filter(Boolean)
  const got = path.split('/').filter(Boolean)
  if (want.length !== got.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!
    if (w.startsWith(':')) params[w.slice(1)] = got[i]!
    else if (w !== got[i]) return undefined
  }
  return params
}

/**
 * The route for `method` and `path` (trailing slashes ignored). Literal
 * segments win over parameters (`/api/tasks/capabilities` before
 * `/api/tasks/:id`). `methodMismatch` is set when the path exists under
 * another method.
 */
export function matchHostRoute(method: string, path: string): HostRouteMatch | { route?: undefined; methodMismatch: boolean } {
  const clean = path.replace(/\/+$/, '') || '/'
  let mismatch = false
  const candidates = HOST_ROUTES
    .map((route) => ({ route, params: matchPath(route.path, clean) }))
    .filter((c): c is { route: HostRoute; params: Record<string, string> } => c.params !== undefined)
    .sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length)
  for (const c of candidates) {
    if (c.route.method === method) return c
    mismatch = true
  }
  return { methodMismatch: mismatch }
}

/** A bounded metrics label: the route pattern, or `other`. */
export function hostRouteLabel(method: string, path: string): string {
  const m = matchHostRoute(method, path)
  return m.route ? `${method} ${m.route.path}` : `${method} other`
}
