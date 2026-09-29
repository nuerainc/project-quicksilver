/**
 * Threat model A-3, A-5 and A-9 for the web app. Run by the root `seed:test`.
 *
 * - Every API route module under app/api (found on disk, so a new route is
 *   covered without editing this file) is imported and each exported handler
 *   is called with no Authorization (401), with an unknown token (401) and
 *   with a valid principal that holds no permission (403). The only route a
 *   permissionless principal may call is the reviewed `GET /api/whoami`.
 * - Per-principal rate limits: 429 with Retry-After on model and write routes.
 * - The cross-site check in middleware.ts: JSON only, same origin only.
 *
 * Handlers are called directly; nothing here reaches Sanity or a model (the
 * credential check comes first, and the model and Sanity settings are cleared).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, relative, sep } from 'node:path'

import { digestToken } from '../../../packages/kernel/src/identity/tokens.ts'

// Lets Node import Next.js route modules: the "@/" alias and extensionless imports.
register('./route-test-loader.mjs', import.meta.url)

const API_DIR = fileURLToPath(new URL('../app/api/', import.meta.url))
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Routes a valid principal with no permission may call, and why (a reviewed list). */
const REVIEWED_ANY_PRINCIPAL: Record<string, string> = {
  'GET /api/whoami': 'reports who the token belongs to; grants nothing',
}

const token = (name: string) => `${name}-${'r'.repeat(40)}`
const TOKENS = { nobody: token('nobody'), proposer: token('proposer'), supervisor: token('supervisor'), viewer: token('viewer') }
const PRINCIPALS = JSON.stringify([
  { id: 'entity-nobody', kind: 'human', tenantId: 'acme', roles: [], tokenDigest: digestToken(TOKENS.nobody) },
  { id: 'entity-pat', kind: 'human', tenantId: 'acme', roles: ['developer'], tokenDigest: digestToken(TOKENS.proposer) },
  { id: 'entity-ana', kind: 'human', tenantId: 'acme', roles: ['supervisor', 'developer'], tokenDigest: digestToken(TOKENS.supervisor) },
  { id: 'entity-vic', kind: 'human', tenantId: 'acme', roles: ['viewer'], tokenDigest: digestToken(TOKENS.viewer) },
])

const CLEARED = [
  'NQC_SUPERVISOR_TOKEN', 'NQC_SUPERVISOR_ID', 'QUICKSILVER_SOLE_OPERATOR_ID',
  'NEXT_PUBLIC_SANITY_PROJECT_ID', 'SANITY_AUTH_TOKEN', 'SANITY_READ_TOKEN', 'SANITY_WRITE_TOKEN',
  'AZURE_API_KEY', 'AZURE_RESOURCE_NAME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'QUICKSILVER_MODEL_MODE',
  'SANITY_CONTEXT_MCP_URL', 'SANITY_CONTEXT_TOKEN', 'QUICKSILVER_WORKFLOW_LIVE_RUNS',
  'QUICKSILVER_WEB_RATE_LIMIT_MODEL', 'QUICKSILVER_WEB_RATE_LIMIT_WRITE', 'QUICKSILVER_WEB_ALLOWED_ORIGINS',
]
function setEnv(values: Record<string, string | undefined>) {
  for (const name of [...CLEARED, 'QUICKSILVER_PRINCIPALS', 'QUICKSILVER_TENANT_ID']) delete process.env[name]
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v
}
const principalEnv = { QUICKSILVER_PRINCIPALS: PRINCIPALS, QUICKSILVER_TENANT_ID: 'acme' }

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
interface RouteHandler { key: string; path: string; method: string; handler: Handler }

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return findRouteFiles(full)
    return name === 'route.ts' || name === 'route.tsx' ? [full] : []
  })
}

async function loadHandlers(): Promise<RouteHandler[]> {
  const out: RouteHandler[] = []
  for (const file of findRouteFiles(API_DIR).sort()) {
    const rel = relative(API_DIR, file).split(sep).slice(0, -1).join('/')
    const path = `/api/${rel}`.replace(/\[([^\]]+)\]/g, 'test-$1')
    // Dynamic import takes a URL: on Windows a bare absolute path has a `c:`
    // scheme, which the ESM loader rejects.
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    for (const method of HTTP_METHODS) {
      if (typeof mod[method] === 'function') out.push({ key: `${method} /api/${rel}`, path, method, handler: mod[method] as Handler })
    }
  }
  return out
}

function call(route: RouteHandler, authorization?: string, body = '{}'): Promise<Response> {
  const req = new Request(`http://localhost:3000${route.path}`, {
    method: route.method,
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    ...(route.method === 'GET' ? {} : { body }),
  })
  return route.handler(req, { params: Promise.resolve({ id: 'test-id' }) })
}

test('web API routes (A-3, A-9): every handler refuses no credential (401), an unknown token (401) and a principal without its permission (403)', async () => {
  setEnv(principalEnv)
  const routes = await loadHandlers()
  assert.ok(routes.length >= 11, `found the route modules (${routes.map((r) => r.key).join(', ')})`)
  for (const expected of ['POST /api/plan', 'POST /api/query', 'POST /api/workflows/run', 'POST /api/workflows/simulate', 'POST /api/workflows/validate', 'POST /api/decisions/[id]/action', 'GET /api/whoami']) {
    assert.ok(routes.some((r) => r.key === expected), `${expected} was enumerated`)
  }
  for (const route of routes) {
    const none = await call(route)
    assert.equal(none.status, 401, `${route.key} without Authorization: ${none.status} ${await none.clone().text()}`)
    assert.equal((await call(route, 'Bearer not-a-known-token-000000000000000000')).status, 401, `${route.key} with an unknown token`)
    const nobody = await call(route, `Bearer ${TOKENS.nobody}`)
    if (route.key in REVIEWED_ANY_PRINCIPAL) {
      assert.equal(nobody.status, 200, `${route.key} needs only a valid principal`)
    } else {
      assert.equal(nobody.status, 403, `${route.key} with a principal holding no permission: ${nobody.status} ${await nobody.clone().text()}`)
    }
  }
  // Every reviewed exception still exists (a stale entry is a failed review).
  for (const key of Object.keys(REVIEWED_ANY_PRINCIPAL)) assert.ok(routes.some((r) => r.key === key), key)
})

test('web API routes (A-3): with no principals and no shared token nothing is anonymous; the shared token still needs to be sent', async () => {
  setEnv({})
  const routes = await loadHandlers()
  for (const route of routes) {
    const r = await call(route)
    assert.ok(r.status === 401 || r.status === 503, `${route.key} unconfigured: ${r.status}`)
  }
  const shared = 'shared-supervisor-token-'.padEnd(48, 'q')
  setEnv({ NQC_SUPERVISOR_TOKEN: shared, NQC_SUPERVISOR_ID: 'entity-sole' })
  for (const route of routes) assert.equal((await call(route)).status, 401, `${route.key} without the shared token`)
})

test('web route permissions (A-3): plan needs decision:propose, query decision:read, workflows workflow:read or run:enqueue', async () => {
  const { checkWebRoute, WEB_ROUTE_ACCESS } = await import('./route-guard.ts')
  const env = { ...principalEnv }
  assert.deepEqual(WEB_ROUTE_ACCESS.plan.permissions, ['decision:propose'])
  assert.deepEqual(WEB_ROUTE_ACCESS.query.permissions, ['decision:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['workflows/validate'].permissions, ['workflow:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['workflows/simulate'].permissions, ['workflow:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['workflows/run'].permissions, ['run:enqueue'])
  // The principal authenticated from the header is the requester; nothing else is consulted.
  const plan = checkWebRoute('plan', `Bearer ${TOKENS.proposer}`, env)
  assert.deepEqual(plan, { ok: true, principalId: 'entity-pat' })
  const viewerPlan = checkWebRoute('plan', `Bearer ${TOKENS.viewer}`, env)
  assert.equal(!viewerPlan.ok && viewerPlan.status, 403, 'a viewer cannot plan')
  assert.deepEqual(!viewerPlan.ok && viewerPlan.body.needs, ['decision:propose'])
  assert.deepEqual(checkWebRoute('query', `Bearer ${TOKENS.viewer}`, env), { ok: true, principalId: 'entity-vic' })
  assert.deepEqual(checkWebRoute('workflows/validate', `Bearer ${TOKENS.viewer}`, env), { ok: true, principalId: 'entity-vic' })
  assert.equal(checkWebRoute('workflows/run', `Bearer ${TOKENS.viewer}`, env).ok, false, 'a viewer cannot start a live run')
  assert.deepEqual(checkWebRoute('workflows/run', `Bearer ${TOKENS.proposer}`, env), { ok: true, principalId: 'entity-pat' })
  // The interim shared token (the founder) may plan and ask, but not start live runs.
  const shared = 'shared-supervisor-token-'.padEnd(48, 'q')
  const sharedEnv = { NQC_SUPERVISOR_TOKEN: shared, NQC_SUPERVISOR_ID: 'entity-sole' }
  assert.deepEqual(checkWebRoute('plan', `Bearer ${shared}`, sharedEnv), { ok: true, principalId: 'entity-sole' })
  assert.equal(checkWebRoute('workflows/run', `Bearer ${shared}`, sharedEnv).ok, false)
})

test('web rate limits (A-5): model and write routes return 429 with Retry-After per principal; the default and bad settings', async () => {
  const { checkWebRoute, resetWebRateLimits, takeWebRateLimit, webRateLimitConfig, DEFAULT_WEB_RATE_LIMITS } = await import('./route-guard.ts')
  resetWebRateLimits()
  assert.deepEqual(webRateLimitConfig('model', {}), DEFAULT_WEB_RATE_LIMITS.model)
  assert.deepEqual(webRateLimitConfig('write', {}), DEFAULT_WEB_RATE_LIMITS.write)
  assert.deepEqual(webRateLimitConfig('model', { QUICKSILVER_WEB_RATE_LIMIT_MODEL: 'nonsense' }), DEFAULT_WEB_RATE_LIMITS.model, 'a malformed setting falls back to the default')
  const env = { ...principalEnv, QUICKSILVER_WEB_RATE_LIMIT_MODEL: '2/1' }
  assert.equal(checkWebRoute('plan', `Bearer ${TOKENS.proposer}`, env).ok, true)
  assert.equal(checkWebRoute('plan', `Bearer ${TOKENS.proposer}`, env).ok, true)
  const third = checkWebRoute('plan', `Bearer ${TOKENS.proposer}`, env)
  assert.equal(!third.ok && third.status, 429)
  assert.ok(!third.ok && Number(third.headers?.['retry-after']) >= 1)
  assert.equal(checkWebRoute('plan', `Bearer ${TOKENS.supervisor}`, env).ok, true, 'buckets are per principal')
  // A refused caller never reaches the bucket.
  for (let i = 0; i < 3; i++) assert.equal((checkWebRoute('plan', `Bearer ${TOKENS.viewer}`, env) as { status: number }).status, 403)
  // Validate and simulate call no model and write nothing: not limited.
  for (let i = 0; i < 5; i++) assert.equal(checkWebRoute('workflows/validate', `Bearer ${TOKENS.viewer}`, env).ok, true)
  let t = 0
  resetWebRateLimits()
  const writeEnv = { QUICKSILVER_WEB_RATE_LIMIT_WRITE: '1/6' }
  assert.equal(takeWebRateLimit('write', 'entity-ana', writeEnv, () => t), null)
  const limited = takeWebRateLimit('write', 'entity-ana', writeEnv, () => t)
  assert.equal(limited?.status, 429)
  assert.equal(limited?.headers?.['retry-after'], '10')
  resetWebRateLimits()
})

test('web rate limits (A-5): the route handlers apply them (plan: model; decision action: write)', async () => {
  setEnv({ ...principalEnv, QUICKSILVER_WEB_RATE_LIMIT_MODEL: '1/1', QUICKSILVER_WEB_RATE_LIMIT_WRITE: '1/1' })
  const { resetWebRateLimits } = await import('./route-guard.ts')
  resetWebRateLimits()
  const routes = await loadHandlers()
  const plan = routes.find((r) => r.key === 'POST /api/plan')!
  const body = JSON.stringify({ objective: 'Reduce downtime.' })
  const first = await call(plan, `Bearer ${TOKENS.proposer}`, body)
  assert.notEqual(first.status, 429, 'the first plan passes the limit (then stops: no model is configured here)')
  const second = await call(plan, `Bearer ${TOKENS.proposer}`, body)
  assert.equal(second.status, 429)
  assert.ok(Number(second.headers.get('retry-after')) >= 1)
  const action = routes.find((r) => r.key === 'POST /api/decisions/[id]/action')!
  const approve = JSON.stringify({ action: 'reject' })
  assert.notEqual((await call(action, `Bearer ${TOKENS.supervisor}`, approve)).status, 429)
  const again = await call(action, `Bearer ${TOKENS.supervisor}`, approve)
  assert.equal(again.status, 429)
  assert.ok(Number(again.headers.get('retry-after')) >= 1)
  resetWebRateLimits()
  setEnv({})
})

test('cross-site check (A-3, T-30): state-changing API requests must be JSON and same-origin', async () => {
  const { checkApiRequest } = await import('./request-guard.ts')
  const req = (method: string, path: string, headers: Record<string, string>) => ({ method, url: `https://app.example${path}`, headers: new Headers(headers) })
  const json = { 'content-type': 'application/json' }
  assert.deepEqual(checkApiRequest(req('POST', '/api/plan', json)), { ok: true }, 'a non-browser client with JSON')
  assert.deepEqual(checkApiRequest(req('POST', '/api/plan', { 'content-type': 'application/json; charset=utf-8', origin: 'https://app.example', 'sec-fetch-site': 'same-origin' })), { ok: true })
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '', 'application/jsonp', 'text/json']) {
    const r = checkApiRequest(req('POST', '/api/plan', ct ? { 'content-type': ct } : {}))
    assert.equal(!r.ok && r.status, 415, `content-type ${JSON.stringify(ct)}`)
  }
  for (const headers of [
    { ...json, origin: 'https://evil.example' },
    { ...json, origin: 'null' },
    { ...json, origin: 'http://app.example' },
    { ...json, 'sec-fetch-site': 'cross-site' },
    { ...json, 'sec-fetch-site': 'same-site' },
    { ...json, 'sec-fetch-site': 'none' },
    { ...json, origin: 'https://app.example', 'sec-fetch-site': 'cross-site' },
  ]) {
    const r = checkApiRequest(req('POST', '/api/decisions/d/action', headers))
    assert.equal(!r.ok && r.status, 403, JSON.stringify(headers))
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((checkApiRequest(req(method, '/api/plan', { 'content-type': 'text/plain' })) as { status: number }).status, 415, method)
  // Reads and non-API pages are not checked here.
  assert.deepEqual(checkApiRequest(req('GET', '/api/whoami', { origin: 'https://evil.example' })), { ok: true })
  assert.deepEqual(checkApiRequest(req('POST', '/somewhere', { 'content-type': 'text/plain' })), { ok: true })
  // A proxy's public origin can be allowed explicitly.
  assert.deepEqual(checkApiRequest(req('POST', '/api/plan', { ...json, origin: 'https://quicksilver.example' }), { QUICKSILVER_WEB_ALLOWED_ORIGINS: 'https://quicksilver.example, not a url' }), { ok: true })
})

test('cross-site check (A-3): middleware refuses before any route handler, with the security headers', async () => {
  const { NextRequest } = await import('next/server.js')
  const { middleware } = await import('../middleware.ts')
  const refused = middleware(new NextRequest('http://localhost:3000/api/plan', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body: '{}' }))
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).code, 'cross-site')
  assert.ok(refused.headers.get('content-security-policy'))
  assert.equal(refused.headers.get('x-frame-options'), 'DENY')
  const plainText = middleware(new NextRequest('http://localhost:3000/api/plan', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
  assert.equal(plainText.status, 415)
  const ok = middleware(new NextRequest('http://localhost:3000/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }, body: '{}' }))
  assert.equal(ok.status, 200, 'passed on to the route (NextResponse.next)')
  const page = middleware(new NextRequest('http://localhost:3000/', { method: 'GET' }))
  assert.equal(page.status, 200)
})
