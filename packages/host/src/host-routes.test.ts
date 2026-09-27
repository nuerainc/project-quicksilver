/**
 * Threat model A-9 and A-5: every host route, taken from the route table
 * itself (routes.ts, the table dispatch() matches first), refuses a request
 * without credentials (401) and a principal without the route's permission
 * (403), except a pinned, reviewed list of public routes. A new route added
 * to the table is covered here without editing this file. Also: the per-
 * principal write and model limits and the per-endpoint webhook limit (429
 * with Retry-After). Run with `npm run host:test`. Every token is generated
 * by the test and thrown away.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import { departmentAutonomy } from '@quicksilver/kernel/playbooks/operate'
import { generateWebhookSecret, signWebhook } from '@quicksilver/kernel/triggers'
import type { WorkflowGraph } from '@quicksilver/kernel/workflows/graph'

import { parseHostConfig } from './config.ts'
import type { DecisionApiDeps } from './decisions-api.ts'
import type { GenesisApiDeps } from './genesis-api.ts'
import { QuicksilverHost } from './host.ts'
import type { IntentApiDeps } from './intent-api.ts'
import { Logger } from './log.ts'
import { HOST_ROUTES, matchHostRoute } from './routes.ts'
import { MemoryShadowStore, type ShadowApiDeps } from './shadow-api.ts'
import { MemoryTaskClientPersistence, TaskClientRegistry } from './task-clients.ts'
import { MemoryTaskStore } from './tasks.ts'
import { generateMasterKey } from './vault.ts'

const TENANT = 'nuera'

/**
 * The reviewed public routes and why each needs no bearer token. Changing
 * this list is a security review: the test fails until the table and this
 * list agree.
 */
const REVIEWED_PUBLIC_ROUTES: Record<string, string> = {
  'GET /healthz': 'liveness probe, no data',
  'GET /readyz': 'readiness probe, no data',
  'GET /': 'static console page with no data; it sends the viewer\'s own token to /api',
  'GET /console': 'the same static console page',
  'POST /webhooks/:id': 'authenticated by the per-endpoint HMAC signature instead of a bearer token',
}
/** Routes any valid principal may call; they grant nothing. */
const REVIEWED_ANY_PRINCIPAL_ROUTES: Record<string, string> = {
  'GET /api/whoami': 'reports who the token belongs to',
}

const graph: WorkflowGraph = {
  schemaVersion: 1, id: 'daily-brief', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'ask', kind: 'agent', label: 'Ask', config: { agentId: 'query', evaluationRequired: true, impact: 'low' } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'ask' }, { id: 'e2', from: 'ask', to: 'done' }],
}

function who(id: string, kind: 'human' | 'service' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`

interface StartOptions {
  http?: Record<string, unknown>
  webhookRateLimit?: { burst: number; perMinute: number }
}

/** A host with every optional part configured, so every route in the table is reachable. */
async function start(options: StartOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qs-routes-'))
  // No roles: a valid principal that holds no permission at all.
  const nobody = who('entity-nobody', 'human', [])
  // Every built-in role: holds every permission the table can ask for.
  const everyone = who('entity-everyone', 'human', ['supervisor', 'intent-provider', 'intent-admin', 'tenant-admin', 'developer', 'operator', 'auditor'])
  const webhookSecret = generateWebhookSecret()
  const clients = new TaskClientRegistry({ persistence: new MemoryTaskClientPersistence(), tenantId: TENANT })
  const env = { QUICKSILVER_VAULT_KEY: generateMasterKey(), HOOK_SECRET: webhookSecret }
  // The intent, shadow, genesis and decision handlers never run for a 401 or a
  // 403 (the table's check comes first), so presence is all these need.
  const host = new QuicksilverHost(parseHostConfig({
    tenantId: TENANT,
    http: { host: '127.0.0.1', port: 0, ...(options.http ?? {}) },
    worker: { id: 'routes-test', concurrency: 1, pollIntervalMs: 50 },
    vault: { path: join(dir, 'vault.json') },
    workflows: { 'daily-brief': graph },
    services: [{ id: 'svc:hook', roles: ['trigger'] }],
    webhooks: [{ id: 'erp-orders', workflow: 'daily-brief', secret: 'env:HOOK_SECRET', principal: 'svc:hook', ...(options.webhookRateLimit ? { rateLimit: options.webhookRateLimit } : {}) }],
  }), {
    principals: [nobody.config, everyone.config],
    env,
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    intent: {} as IntentApiDeps,
    shadow: { store: new MemoryShadowStore() } as unknown as ShadowApiDeps,
    genesis: {} as GenesisApiDeps,
    decisions: {} as DecisionApiDeps,
    tasks: {
      store: new MemoryTaskStore(),
      clients,
      catalog: { defaultCapabilityId: 'task.triage', capabilities: [{ id: 'task.triage', name: 'Triage', description: 'A person reads it.', department: 'operations', baseRiskLevel: 4 }] },
      autonomy: async (department: string) => departmentAutonomy(undefined, undefined, department),
    },
  })
  const { port } = await host.start()
  const base = `http://127.0.0.1:${port}`
  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(method !== 'GET' ? { body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) } : {}),
    })
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: res.status, headers: res.headers, body: json, text }
  }
  return {
    host, base, call, webhookSecret,
    tokens: { nobody: nobody.token, everyone: everyone.token },
    close: async () => { await host.stop({ abort: true }); await rm(dir, { recursive: true, force: true }) },
  }
}

/** A concrete path for a route pattern (`:id` becomes `test-id`). */
const concrete = (path: string) => path.replace(/:([a-zA-Z]+)/g, 'test-$1')

test('route table (A-9): the public and any-principal routes are exactly the reviewed lists, each with a reason', () => {
  const pub = HOST_ROUTES.filter((r) => r.access.kind === 'public')
  assert.deepEqual(pub.map(key).sort(), Object.keys(REVIEWED_PUBLIC_ROUTES).sort(), 'a new public route needs a security review: add it to REVIEWED_PUBLIC_ROUTES with its reason')
  for (const r of pub) assert.ok(r.access.kind === 'public' && r.access.reason.length > 20, `${key(r)} says why it is public`)
  const any = HOST_ROUTES.filter((r) => r.access.kind === 'principal')
  assert.deepEqual(any.map(key).sort(), Object.keys(REVIEWED_ANY_PRINCIPAL_ROUTES).sort())
  for (const r of HOST_ROUTES) {
    if (r.access.kind === 'permission') assert.ok(r.access.anyOf.length > 0, `${key(r)} names a permission`)
    if (r.path.startsWith('/api/')) assert.notEqual(r.access.kind, 'public', `${key(r)}: nothing under /api is public`)
  }
  const keys = HOST_ROUTES.map(key)
  assert.equal(new Set(keys).size, keys.length, 'no route is listed twice')
  // Every route that changes state has a rate limit (A-5).
  for (const r of HOST_ROUTES) if (r.method !== 'GET') assert.ok(r.rateLimit, `${key(r)} is rate-limited`)
})

test('route table (A-9): every route refuses a request without credentials (401) and a principal without its permission (403)', async () => {
  const h = await start()
  try {
    let checked = 0
    for (const route of HOST_ROUTES) {
      const path = concrete(route.path)
      const label = key(route)
      assert.equal(matchHostRoute(route.method, path).route, route, `${label} matches itself`)
      const bare = await h.call(route.method, path)
      if (route.access.kind === 'public') {
        if (route.path.startsWith('/webhooks/')) {
          // HMAC, not a bearer token: an unsigned delivery is refused, token or not.
          const signed = await h.call('POST', '/webhooks/erp-orders')
          assert.equal(signed.status, 401, `${label}: an unsigned delivery is refused`)
          assert.equal((await h.call('POST', '/webhooks/erp-orders', h.tokens.everyone)).status, 401, `${label}: a bearer token does not stand in for the signature`)
        } else {
          assert.ok(bare.status === 200 || (route.path === '/readyz' && bare.status === 503), `${label} is public: ${bare.status}`)
          if (route.path === '/' || route.path === '/console') assert.match(bare.text, /<html/i, `${label} is the static page`)
        }
        checked++
        continue
      }
      assert.equal(bare.status, 401, `${label} without credentials`)
      const forged = await h.call(route.method, path, 'qs_not-a-real-token-but-long-enough-to-try-000000')
      assert.equal(forged.status, 401, `${label} with an unknown token`)
      const nobody = await h.call(route.method, path, h.tokens.nobody)
      if (route.access.kind === 'principal') {
        assert.equal(nobody.status, 200, `${label} needs only a valid principal`)
      } else {
        assert.equal(nobody.status, 403, `${label} with a principal lacking ${route.access.anyOf.join(' / ')}: got ${nobody.status} ${nobody.text}`)
        // The floor is not stricter than the route: a principal holding the
        // permission gets past the table's check (the handler may still refuse
        // for its own reasons, such as a missing record).
        const holder = await h.call(route.method, path, h.tokens.everyone)
        assert.notEqual(holder.status, 401, label)
        assert.ok(!(holder.status === 403 && /This route needs/.test(holder.body?.error ?? '')), `${label}: the table let the permission holder through (${holder.status} ${holder.text})`)
      }
      checked++
    }
    assert.equal(checked, HOST_ROUTES.length, 'every route in the table was exercised')

    // Paths that are not in the table do not exist, whoever asks.
    assert.equal((await h.call('GET', '/api/not-a-route')).status, 401, 'unauthenticated callers learn nothing about which paths exist')
    assert.equal((await h.call('GET', '/api/not-a-route', h.tokens.everyone)).status, 404)
    assert.equal((await h.call('GET', '/api/genesis/money', h.tokens.everyone)).status, 405, 'a known path under another method')
  } finally { await h.close() }
})

test('route table (A-9): /metrics needs audit:read unless metricsPublic is set', async () => {
  const h = await start({ http: { metricsPublic: true } })
  try {
    assert.equal((await h.call('GET', '/metrics')).status, 200)
  } finally { await h.close() }
})

test('rate limits (A-5): write routes are limited per principal with 429 and Retry-After; reads are not', async () => {
  const h = await start({ http: { rateLimits: { write: { burst: 2, perMinute: 1 }, model: { burst: 1, perMinute: 1 } } } })
  try {
    // POST /api/runs/:id/cancel is a write route: the handler 404s the unknown run, but each call spends a token.
    assert.equal((await h.call('POST', '/api/runs/run-x/cancel', h.tokens.everyone)).status, 404)
    assert.equal((await h.call('POST', '/api/runs/run-x/cancel', h.tokens.everyone)).status, 404)
    const third = await h.call('POST', '/api/runs/run-x/cancel', h.tokens.everyone)
    assert.equal(third.status, 429)
    assert.equal(third.body.code, 'rate-limited')
    assert.ok(Number(third.headers.get('retry-after')) >= 1, 'Retry-After in whole seconds')
    assert.equal(third.body.retryAfterSeconds, Number(third.headers.get('retry-after')))
    for (let i = 0; i < 5; i++) assert.equal((await h.call('GET', '/api/runs', h.tokens.everyone)).status, 200, 'reads are not limited')
    // A refused caller spends nothing: the 403 comes before the bucket.
    for (let i = 0; i < 3; i++) assert.equal((await h.call('POST', '/api/runs/run-x/cancel', h.tokens.nobody)).status, 403)

    // Model routes have their own, smaller bucket.
    const first = await h.call('POST', '/api/runs', h.tokens.everyone, { workflow: 'daily-brief', input: 'hello' })
    assert.equal(first.status, 202)
    const second = await h.call('POST', '/api/runs', h.tokens.everyone, { workflow: 'daily-brief', input: 'again' })
    assert.equal(second.status, 429)
    assert.ok(Number(second.headers.get('retry-after')) >= 1)
  } finally { await h.close() }
})

test('rate limits (A-5): webhook deliveries are limited per endpoint, before the signature is checked', async () => {
  const h = await start({ webhookRateLimit: { burst: 1, perMinute: 1 } })
  try {
    const body = JSON.stringify({ order: 1 })
    const ts = Math.floor(Date.now() / 1000)
    const signature = signWebhook(h.webhookSecret, ts, body)
    const ok = await h.call('POST', '/webhooks/erp-orders', undefined, body, { 'x-quicksilver-signature': signature, 'x-quicksilver-timestamp': String(ts) })
    assert.ok(ok.status === 202 || ok.status === 200, `the first delivery is accepted: ${ok.status} ${ok.text}`)
    const flood = await h.call('POST', '/webhooks/erp-orders', undefined, '{}')
    assert.equal(flood.status, 429)
    assert.ok(Number(flood.headers.get('retry-after')) >= 1)
  } finally { await h.close() }
})
