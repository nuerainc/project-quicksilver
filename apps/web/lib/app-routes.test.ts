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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, relative, sep } from 'node:path'

import { digestToken } from '../../../packages/kernel/src/identity/tokens.ts'
import { setAuthorizationAuditAppender } from './authorization-audit-store.ts'

// This route contract suite clears Sanity credentials and verifies auth before
// data access. Isolate its durable audit boundary; append semantics are covered
// by authorization-audit-store.test.ts.
setAuthorizationAuditAppender(async () => 'test-authorization-audit-record')

// Lets Node import Next.js route modules: the "@/" alias and extensionless imports.
register('./route-test-loader.mjs', import.meta.url)

const API_DIR = fileURLToPath(new URL('../app/api/', import.meta.url))
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

test('OpenAPI contract (P-118): paths and methods match exported API route handlers', () => {
  const contractPath = fileURLToPath(new URL('../../../docs/api/openapi.json', import.meta.url))
  const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as { openapi: string; info: { version: string }; paths: Record<string, Record<string, unknown>> }
  assert.equal(contract.openapi, '3.1.0')
  assert.match(contract.info.version, /^0\./, 'pre-1.0 contract version must not claim 1.0 stability')

  const declared = Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  ).sort()
  const implemented = findRouteFiles(API_DIR).flatMap((file) => {
    const rel = relative(API_DIR, file).split(sep).slice(0, -1).join('/')
    const path = `/api/${rel}`.replace(/\[([^\]]+)\]/g, '{$1}')
    const source = readFileSync(file, 'utf8')
    const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)]
      .map((match) => match[1] ?? match[2])
    return methods.map((method) => `${method} ${path}`)
  }).sort()
  assert.deepEqual(declared, implemented, 'update docs/api/openapi.json when a route method is added, removed, or moved')

  const operationIds = new Set<string>()
  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const [method, rawOperation] of Object.entries(methods)) {
      const operation = rawOperation as { operationId?: string; responses?: Record<string, unknown>; requestBody?: unknown }
      assert.ok(operation.operationId, `${method.toUpperCase()} ${path} has an operationId`)
      assert.ok(!operationIds.has(operation.operationId!), `duplicate operationId ${operation.operationId}`)
      operationIds.add(operation.operationId!)
      assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `${operation.operationId} declares responses`)
      if (method.toLowerCase() === 'post' || method.toLowerCase() === 'put' || method.toLowerCase() === 'patch') {
        assert.ok(operation.requestBody, `${operation.operationId} declares its request body`)
      }
    }
  }

  // Catch broken local schema/response/parameter links before the contract is
  // consumed by SDK generation or API tooling.
  const resolvePointer = (pointer: string): unknown => {
    assert.ok(pointer.startsWith('#/'), `only local OpenAPI references are expected: ${pointer}`)
    return pointer.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<unknown>((node, key) => {
      assert.ok(node !== null && typeof node === 'object' && key in node, `unresolved OpenAPI reference: ${pointer}`)
      return (node as Record<string, unknown>)[key]
    }, contract)
  }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const object = node as Record<string, unknown>
    if (typeof object.$ref === 'string') resolvePointer(object.$ref)
    Object.values(object).forEach(visit)
  }
  visit(contract)

  const validate = contract.paths['/api/workflows/validate']?.post as { requestBody?: { $ref?: string }; responses?: Record<string, { $ref?: string }> } | undefined
  const simulate = contract.paths['/api/workflows/simulate']?.post as { requestBody?: { $ref?: string }; responses?: Record<string, { $ref?: string }> } | undefined
  const run = contract.paths['/api/workflows/run']?.post as { requestBody?: { $ref?: string }; responses?: Record<string, { $ref?: string }> } | undefined
  assert.equal(validate?.requestBody?.$ref, '#/components/requestBodies/WorkflowGraphRequest')
  assert.equal(validate?.responses?.['2XX']?.$ref, '#/components/responses/WorkflowValidationResponse')
  assert.equal(simulate?.requestBody?.$ref, '#/components/requestBodies/WorkflowGraphRequest')
  assert.equal(simulate?.responses?.['2XX']?.$ref, '#/components/responses/WorkflowSimulationResponse')
  assert.equal(run?.requestBody?.$ref, '#/components/requestBodies/WorkflowRunRequest')
  assert.equal(run?.responses?.['2XX']?.$ref, '#/components/responses/WorkflowRunResponse')
  const businessAgent = contract.paths['/api/agents/run']?.post as { requestBody?: { $ref?: string }; responses?: Record<string, { $ref?: string }> } | undefined
  assert.equal(businessAgent?.requestBody?.$ref, '#/components/requestBodies/BusinessAgentRequest')
  assert.equal(businessAgent?.responses?.['2XX']?.$ref, '#/components/responses/BusinessAgentResponse')

  const agentBindings: Array<[string, string, string | undefined, string, string?]> = [
    ['/api/agents/catalog', 'get', undefined, 'AgentCatalogResponse'],
    ['/api/agents/definitions', 'get', undefined, 'AgentDefinitionsResponse'],
    ['/api/agents/drafts', 'post', 'CreateAgentDraft', 'AgentDefinitionResponse', '201'],
    ['/api/agents/drafts/submit', 'post', 'AgentVersionAction', 'AgentDefinitionResponse'],
    ['/api/agents/review', 'post', 'ReviewAgentDefinition', 'AgentDefinitionResponse'],
    ['/api/agents/publish', 'post', 'AgentVersionAction', 'AgentDefinitionResponse'],
    ['/api/agents/rollback', 'post', 'RollbackAgentDefinition', 'AgentDefinitionResponse', '201'],
  ]
  for (const [path, method, body, response, status = '2XX'] of agentBindings) {
    const operation = contract.paths[path]?.[method] as { requestBody?: { $ref?: string }; responses?: Record<string, { $ref?: string }> } | undefined
    assert.equal(operation?.responses?.[status]?.$ref, `#/components/responses/${response}`, `${method.toUpperCase()} ${path} binds its observed response schema`)
    if (body) assert.equal(operation?.requestBody?.$ref, `#/components/requestBodies/${body}`, `${method.toUpperCase()} ${path} binds its validated request schema`)
  }
})

/** Routes a valid principal with no permission may call, and why (a reviewed list). */
const REVIEWED_ANY_PRINCIPAL: Record<string, string> = {
  'GET /api/whoami': 'reports who the token belongs to; grants nothing',
}

/** Public OIDC protocol endpoints; the callback is protected by one-use state, PKCE and a same-browser binding cookie. */
const OIDC_PROTOCOL_ROUTES: Readonly<Record<string, number>> = Object.freeze({
  'GET /api/auth/oidc/start': 303,
  'GET /api/auth/oidc/callback': 303,
  'GET /api/auth/session': 401,
  'POST /api/auth/logout': 303,
})

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
  for (const expected of ['POST /api/plan', 'POST /api/query', 'POST /api/agents/run', 'POST /api/workflows/run', 'POST /api/workflows/simulate', 'POST /api/workflows/validate', 'POST /api/decisions/[id]/action', 'GET /api/whoami']) {
    assert.ok(routes.some((r) => r.key === expected), `${expected} was enumerated`)
  }
  for (const expected of ['GET /api/agents/catalog', 'GET /api/agents/definitions', 'POST /api/agents/drafts', 'POST /api/agents/drafts/submit', 'POST /api/agents/review', 'POST /api/agents/publish', 'POST /api/agents/rollback']) {
    assert.ok(routes.some((r) => r.key === expected), `${expected} was enumerated`)
  }
  for (const route of routes) {
    const none = await call(route)
    const expectedWithoutCredential = OIDC_PROTOCOL_ROUTES[route.key]
    assert.equal(none.status, expectedWithoutCredential ?? 401, `${route.key} without Authorization: ${none.status} ${await none.clone().text()}`)
    assert.equal((await call(route, 'Bearer not-a-known-token-000000000000000000')).status, expectedWithoutCredential ?? 401, `${route.key} with an unknown token`)
    const nobody = await call(route, `Bearer ${TOKENS.nobody}`)
    if (route.key in OIDC_PROTOCOL_ROUTES) {
      assert.equal(nobody.status, OIDC_PROTOCOL_ROUTES[route.key], `${route.key} uses only its OIDC protocol protections`)
    } else if (route.key in REVIEWED_ANY_PRINCIPAL) {
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
    assert.ok(r.status === 401 || r.status === 503 || OIDC_PROTOCOL_ROUTES[route.key] === r.status, `${route.key} unconfigured: ${r.status}`)
  }
  const shared = 'shared-supervisor-token-'.padEnd(48, 'q')
  setEnv({ NQC_SUPERVISOR_TOKEN: shared, NQC_SUPERVISOR_ID: 'entity-sole' })
  for (const route of routes) assert.equal((await call(route)).status, OIDC_PROTOCOL_ROUTES[route.key] ?? 401, `${route.key} without the shared token`)
})

test('web route permissions (A-3): plan/query/workflows and agent lifecycle use reviewed least-privilege grants', async () => {
  const { checkWebRoute, WEB_ROUTE_ACCESS } = await import('./route-guard.ts')
  const env = { ...principalEnv }
  assert.deepEqual(WEB_ROUTE_ACCESS.plan.permissions, ['decision:propose'])
  assert.deepEqual(WEB_ROUTE_ACCESS.query.permissions, ['decision:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/run'].permissions, ['decision:read'])
  assert.equal(WEB_ROUTE_ACCESS['agents/run'].rateLimit, 'model')
  assert.deepEqual(WEB_ROUTE_ACCESS['dashboard/overview'].permissions, ['decision:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['dashboard/finance'].permissions, ['finance:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['monitoring/traces'].permissions, ['audit:read'])
  assert.equal(checkWebRoute('dashboard/finance', `Bearer ${TOKENS.viewer}`, env).ok, false, 'ordinary viewers cannot read ledger totals')
  assert.equal(checkWebRoute('dashboard/finance', `Bearer ${TOKENS.supervisor}`, env).ok, true, 'supervisors can read ledger totals')
  assert.deepEqual(WEB_ROUTE_ACCESS['workflows/validate'].permissions, ['workflow:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['workflows/simulate'].permissions, ['workflow:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['workflows/run'].permissions, ['run:enqueue'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/catalog'].permissions, ['agent:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/definitions'].permissions, ['agent:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/drafts'].permissions, ['agent:write'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/drafts/submit'].permissions, ['agent:write'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/review'].permissions, ['agent:review'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/publish'].permissions, ['agent:publish'])
  assert.deepEqual(WEB_ROUTE_ACCESS['agents/rollback'].permissions, ['agent:write'])
  assert.equal(checkWebRoute('agents/catalog', `Bearer ${TOKENS.viewer}`, env).ok, true)
  assert.equal(checkWebRoute('agents/drafts', `Bearer ${TOKENS.proposer}`, env).ok, true)
  assert.equal(checkWebRoute('agents/review', `Bearer ${TOKENS.proposer}`, env).ok, false, 'developers cannot review agent definitions')
  assert.equal(checkWebRoute('agents/review', `Bearer ${TOKENS.supervisor}`, env).ok, true)
  assert.equal(checkWebRoute('agents/publish', `Bearer ${TOKENS.supervisor}`, env).ok, true)
  // The principal authenticated from the header is the requester; nothing else is consulted.
  const plan = checkWebRoute('plan', `Bearer ${TOKENS.proposer}`, env)
  assert.deepEqual(plan, { ok: true, principalId: 'entity-pat' })
  const viewerPlan = checkWebRoute('plan', `Bearer ${TOKENS.viewer}`, env)
  assert.equal(!viewerPlan.ok && viewerPlan.status, 403, 'a viewer cannot plan')
  assert.deepEqual(!viewerPlan.ok && viewerPlan.body.needs, ['decision:propose'])
  assert.deepEqual(checkWebRoute('query', `Bearer ${TOKENS.viewer}`, env), { ok: true, principalId: 'entity-vic' })
  assert.deepEqual(checkWebRoute('agents/run', `Bearer ${TOKENS.viewer}`, env), { ok: true, principalId: 'entity-vic' })
  assert.deepEqual(checkWebRoute('workflows/validate', `Bearer ${TOKENS.viewer}`, env), { ok: true, principalId: 'entity-vic' })
  assert.equal(checkWebRoute('workflows/run', `Bearer ${TOKENS.viewer}`, env).ok, false, 'a viewer cannot start a live run')
  assert.deepEqual(checkWebRoute('workflows/run', `Bearer ${TOKENS.proposer}`, env), { ok: true, principalId: 'entity-pat' })
  // The interim shared token (the founder) may plan and ask, but not start live runs.
  const shared = 'shared-supervisor-token-'.padEnd(48, 'q')
  const sharedEnv = { NQC_SUPERVISOR_TOKEN: shared, NQC_SUPERVISOR_ID: 'entity-sole' }
  assert.deepEqual(checkWebRoute('plan', `Bearer ${shared}`, sharedEnv), { ok: true, principalId: 'entity-sole' })
  assert.equal(checkWebRoute('workflows/run', `Bearer ${shared}`, sharedEnv).ok, false)
})

test('agent catalog routes validate bodies before any Sanity access', async () => {
  setEnv(principalEnv)
  const routes = await loadHandlers()
  const supervisor = `Bearer ${TOKENS.supervisor}`
  for (const key of ['POST /api/agents/drafts', 'POST /api/agents/drafts/submit', 'POST /api/agents/review', 'POST /api/agents/publish', 'POST /api/agents/rollback']) {
    const route = routes.find((item) => item.key === key)!
    assert.equal((await call(route, supervisor, '{}')).status, 400, key)
  }
  const definitions = routes.find((item) => item.key === 'GET /api/agents/definitions')!
  const response = await definitions.handler(new Request(`http://localhost:3000${definitions.path}`, { headers: { authorization: supervisor } }), { params: Promise.resolve({}) })
  assert.equal(response.status, 400)
  const draft = routes.find((item) => item.key === 'POST /api/agents/drafts')!
  assert.equal((await call(draft, supervisor, JSON.stringify({ displayName: 'Compliance', description: 'A definition that is structurally invalid.', manifest: { id: 'wrong', version: 1, authority: 'admin', tasks: [], maximumImpact: 'critical', requiresEvaluation: false } }))).status, 400)
})

test('business-agent route validates dispatch before model/provider access and fails closed when unconfigured', async () => {
  const { resetWebRateLimits } = await import('./route-guard.ts')
  resetWebRateLimits()
  setEnv(principalEnv)
  const routes = await loadHandlers()
  const route = routes.find((item) => item.key === 'POST /api/agents/run')!
  for (const body of ['{}', JSON.stringify({ agentKey: 'system', objective: 'Do work.' }), JSON.stringify({ agentKey: 'sales', objective: 'x' })]) {
    assert.equal((await call(route, `Bearer ${TOKENS.viewer}`, body)).status, 400)
  }
  const response = await call(route, `Bearer ${TOKENS.viewer}`, JSON.stringify({ agentKey: 'sales', objective: 'Review this pipeline.' }))
  assert.equal(response.status, 503, 'valid dispatch fails closed when no model is configured')
  assert.match((await response.json()).error, /Business-agent request failed/)
  resetWebRateLimits()
})

test('decision approval route refuses a missing or malformed review fingerprint before Sanity access', async () => {
  setEnv(principalEnv)
  const routes = await loadHandlers()
  const action = routes.find((item) => item.key === 'POST /api/decisions/[id]/action')!
  const supervisor = `Bearer ${TOKENS.supervisor}`
  for (const body of [
    { action: 'approve' },
    { action: 'approve', expectedActionFingerprint: 'sha256:stale' },
  ]) {
    const response = await call(action, supervisor, JSON.stringify(body))
    assert.equal(response.status, 400, JSON.stringify(body))
  }
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
  resetWebRateLimits()
  const plan = routes.find((r) => r.key === 'POST /api/plan')!
  const specialist = routes.find((r) => r.key === 'POST /api/agents/run')!
  const body = JSON.stringify({ objective: 'Reduce downtime.' })
  const first = await call(plan, `Bearer ${TOKENS.proposer}`, body)
  assert.notEqual(first.status, 429, 'the first plan passes the limit (then stops: no model is configured here)')
  const second = await call(plan, `Bearer ${TOKENS.proposer}`, body)
  assert.equal(second.status, 429)
  assert.ok(Number(second.headers.get('retry-after')) >= 1)
  assert.notEqual((await call(specialist, `Bearer ${TOKENS.viewer}`, JSON.stringify({ agentKey: 'research', objective: 'Review market context.' }))).status, 429)
  assert.equal((await call(specialist, `Bearer ${TOKENS.viewer}`, JSON.stringify({ agentKey: 'research', objective: 'Review market context.' }))).status, 429)
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
