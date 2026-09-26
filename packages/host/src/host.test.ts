/**
 * End-to-end tests for the single-tenant host: HTTP API, auth, worker,
 * webhooks, vault-backed secrets and metrics. Run with `npm run host:test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateNqcRequest, type NqcEvaluationResponse } from '@quicksilver/kernel'
import { AccessController } from '@quicksilver/kernel/identity'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import { TERMINAL_RUN_STATUSES } from '@quicksilver/kernel/runtime'
import { generateWebhookSecret, signWebhook } from '@quicksilver/kernel/triggers'
import type { WorkflowGraph } from '@quicksilver/kernel/workflows/graph'

import { parseHostConfig } from './config.ts'
import type { AgentRunner, EvaluationEntry } from './handlers.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'
import { SecretsVault, generateMasterKey } from './vault.ts'

const TENANT = 'nuera'
/**
 * The schedule fires 12 hours from now. A fixed hour (it was 07:00 UTC) put the
 * scheduler's one-hour catch-up window inside the test run for an hour each
 * day, adding an unexpected run.
 */
const SCHEDULE_HOUR = (new Date().getUTCHours() + 12) % 24

const briefGraph: WorkflowGraph = {
  schemaVersion: 1, id: 'daily-brief', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'ask', kind: 'agent', label: 'Ask', config: { agentId: 'query', evaluationRequired: true, impact: 'low' } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'ask' }, { id: 'e2', from: 'ask', to: 'done' }],
}

const toolGraph: WorkflowGraph = {
  schemaVersion: 1, id: 'send-email', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'send', kind: 'tool', label: 'Send', config: { toolId: 'email.send', sideEffect: true, supervisorApprovalRequired: true, impact: 'moderate', evaluationRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'send' }, { id: 'e2', from: 'send', to: 'done' }],
}

function person(id: string, roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind: 'human', tenantId: TENANT, roles, tokenDigest } }
}

const grounded = 'The supplier onboarding policy requires two quotes. Evidence ev-1 confirms two quotes were received.'
const stubRunner: AgentRunner = async ({ input }) => {
  const evaluation: NqcEvaluationResponse = evaluateNqcRequest({
    agentId: 'nuera-quicksilver:query',
    taskType: 'reasoning',
    modelId: 'stub-model',
    agentOutput: JSON.stringify({ answer: grounded }),
    context: [grounded],
    impactLevel: 'low',
  })
  return { output: { answer: grounded, asked: input.slice(0, 40) }, modelId: 'stub-model', evaluation }
}

interface Harness {
  host: QuicksilverHost
  base: string
  tokens: Record<'viewer' | 'operator' | 'supervisor' | 'auditor' | 'admin', string>
  evaluations: EvaluationEntry[]
  logs: string[]
  webhookSecret: string
  dir: string
  close(): Promise<void>
}

async function startHost(overrides: Record<string, unknown> = {}, extra: { agentRunner?: AgentRunner | null; prepare?: (dir: string, env: Record<string, string>) => Promise<void> } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'qs-host-'))
  const viewer = person('entity-viewer', ['viewer'])
  const operator = person('entity-operator', ['operator'])
  const supervisor = person('entity-supervisor', ['supervisor'])
  const auditor = person('entity-auditor', ['auditor'])
  const admin = person('entity-admin', ['tenant-admin'])
  const webhookSecret = generateWebhookSecret()
  const env = { QUICKSILVER_VAULT_KEY: generateMasterKey(), ERP_WEBHOOK_SECRET: webhookSecret }
  await extra.prepare?.(dir, env)
  const config = parseHostConfig({
    tenantId: TENANT,
    http: { host: '127.0.0.1', port: 0 },
    vault: { path: join(dir, 'vault.json') },
    worker: { id: 'host-test', concurrency: 2, pollIntervalMs: 50 },
    queue: { defaultMaxAttempts: 1 },
    workflows: { 'daily-brief': briefGraph, 'send-email': toolGraph },
    services: [{ id: 'svc:scheduler', roles: ['trigger'] }, { id: 'svc:erp-webhook', roles: ['trigger'] }],
    schedules: [{ id: 'morning', workflow: 'daily-brief', cron: `0 ${SCHEDULE_HOUR} * * *`, principal: 'svc:scheduler', input: { topic: 'overnight' } }],
    webhooks: [{ id: 'erp-orders', workflow: 'daily-brief', secret: 'env:ERP_WEBHOOK_SECRET', principal: 'svc:erp-webhook' }],
    ...overrides,
  })
  const evaluations: EvaluationEntry[] = []
  const logs: string[] = []
  const host = new QuicksilverHost(config, {
    principals: [viewer.config, operator.config, supervisor.config, auditor.config, admin.config],
    env,
    logger: new Logger({ level: 'debug', sink: { write: (line) => logs.push(line) } }),
    ...(extra.agentRunner === null ? {} : { agentRunner: extra.agentRunner ?? stubRunner }),
    evaluationSink: async (entries) => {
      evaluations.push(...entries)
      return { persisted: true, ids: entries.map((e) => `evaluation-${e.nodeId}`) }
    },
  })
  const { port } = await host.start()
  return {
    host,
    base: `http://127.0.0.1:${port}`,
    tokens: { viewer: viewer.token, operator: operator.token, supervisor: supervisor.token, auditor: auditor.token, admin: admin.token },
    evaluations,
    logs,
    webhookSecret,
    dir,
    close: async () => {
      await host.stop({ abort: true })
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function api(h: Harness, path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  return fetch(`${h.base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

async function waitForRun(h: Harness, runId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = await h.host.queue.get(runId)
    if (run && TERMINAL_RUN_STATUSES.includes(run.status)) return run
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not finish (status ${run?.status}).`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

function signed(secret: string, body: string, delivery: string) {
  const ts = Math.floor(Date.now() / 1000)
  return {
    'content-type': 'application/json',
    'x-quicksilver-timestamp': String(ts),
    'x-quicksilver-signature': signWebhook(secret, ts, body),
    'x-quicksilver-delivery': delivery,
  }
}

test('health and readiness need no token; the management API does', async () => {
  const h = await startHost()
  try {
    assert.equal((await api(h, '/healthz')).status, 200)
    assert.deepEqual(await (await api(h, '/readyz')).json(), { status: 'ready' })
    assert.equal((await api(h, '/api/runs')).status, 401)
    assert.equal((await api(h, '/api/runs', { token: 'qs_not_a_real_token_but_long_enough_to_check' })).status, 401)
    const me = await (await api(h, '/api/whoami', { token: h.tokens.viewer })).json()
    assert.deepEqual(me, { id: 'entity-viewer', kind: 'human', tenantId: TENANT, roles: ['viewer'] })
    assert.equal((await api(h, '/api/nope', { token: h.tokens.viewer })).status, 404)
  } finally {
    await h.close()
  }
})

test('an operator starts a configured workflow; the worker runs it under NQC evaluation and records it', async () => {
  const h = await startHost()
  try {
    const denied = await api(h, '/api/runs', { method: 'POST', token: h.tokens.viewer, body: { workflow: 'daily-brief', input: 'What changed overnight?' } })
    assert.equal(denied.status, 403)
    const unknown = await api(h, '/api/runs', { method: 'POST', token: h.tokens.operator, body: { workflow: 'not-configured', input: 'x' } })
    assert.equal(unknown.status, 422)

    const res = await api(h, '/api/runs', { method: 'POST', token: h.tokens.operator, body: { workflow: 'daily-brief', input: 'What changed overnight?', idempotencyKey: 'brief-1' } })
    assert.equal(res.status, 202)
    const { runId } = await res.json() as { runId: string }
    const again = await api(h, '/api/runs', { method: 'POST', token: h.tokens.operator, body: { workflow: 'daily-brief', input: 'What changed overnight?', idempotencyKey: 'brief-1' } })
    assert.equal(again.status, 200)
    assert.equal((await again.json() as { runId: string }).runId, runId)

    const run = await waitForRun(h, runId)
    assert.equal(run.status, 'completed')
    assert.equal(run.requestedBy, 'entity-operator')
    assert.equal(h.evaluations.length, 1)
    assert.equal(h.evaluations[0]!.runId, runId)
    assert.equal(h.evaluations[0]!.requestedBy, 'entity-operator')

    const detail = await (await api(h, `/api/runs/${runId}`, { token: h.tokens.viewer })).json() as { run: { status: string }; events: Array<{ type: string }> }
    assert.equal(detail.run.status, 'completed')
    assert.ok(detail.events.some((e) => e.type === 'queued'))
    const list = await (await api(h, '/api/runs?status=completed', { token: h.tokens.viewer })).json() as { runs: unknown[] }
    assert.equal(list.runs.length, 1)
    assert.equal((await api(h, '/api/runs?status=bogus', { token: h.tokens.viewer })).status, 400)
  } finally {
    await h.close()
  }
})

test('tool steps are blocked on the host and never dispatched', async () => {
  const h = await startHost()
  try {
    const res = await api(h, '/api/runs', { method: 'POST', token: h.tokens.operator, body: { workflow: 'send-email', input: { to: 'x@example.com' } } })
    assert.equal(res.status, 202)
    const run = await waitForRun(h, (await res.json() as { runId: string }).runId)
    assert.equal(run.status, 'blocked')
    assert.ok(h.logs.some((l) => l.includes('"tool step blocked"')))
  } finally {
    await h.close()
  }
})

test('agent steps fail closed when no model provider is configured', async () => {
  const h = await startHost({}, { agentRunner: null })
  try {
    const res = await api(h, '/api/runs', { method: 'POST', token: h.tokens.operator, body: { workflow: 'daily-brief', input: 'hello there' } })
    const run = await waitForRun(h, (await res.json() as { runId: string }).runId)
    assert.notEqual(run.status, 'completed')
    assert.equal(h.evaluations.length, 0)
  } finally {
    await h.close()
  }
})

test('signed webhooks start runs; bad signatures are refused and counted', async () => {
  const h = await startHost()
  try {
    const body = JSON.stringify({ order: 1182 })
    const ok = await fetch(`${h.base}/webhooks/erp-orders`, { method: 'POST', headers: signed(h.webhookSecret, body, 'evt-1'), body })
    assert.equal(ok.status, 202)
    const { runId } = await ok.json() as { runId: string }
    assert.equal((await waitForRun(h, runId)).status, 'completed')

    const bad = await fetch(`${h.base}/webhooks/erp-orders`, { method: 'POST', headers: signed(generateWebhookSecret(), body, 'evt-2'), body })
    assert.equal(bad.status, 401)
    assert.equal((await fetch(`${h.base}/webhooks/erp-orders`)).status, 405)
    assert.equal((await fetch(`${h.base}/webhooks/unknown`, { method: 'POST', headers: signed(h.webhookSecret, body, 'evt-3'), body })).status, 404)

    const metrics = await (await api(h, '/metrics', { token: h.tokens.auditor })).text()
    assert.match(metrics, /quicksilver_webhook_deliveries_total\{endpoint="erp-orders",status="202"\} 1/)
    assert.match(metrics, /quicksilver_webhook_deliveries_total\{endpoint="erp-orders",status="401"\} 1/)
    assert.match(metrics, /quicksilver_runs_finished_total\{status="completed",workflow="daily-brief"\} 1/)
    assert.match(metrics, /quicksilver_queue_runs\{status="completed"\} 1/)
    assert.match(metrics, /quicksilver_up 1/)
    // The webhook secret never reaches the logs.
    assert.ok(!h.logs.join('\n').includes(h.webhookSecret))
  } finally {
    await h.close()
  }
})

test('metrics need audit:read unless configured public', async () => {
  const h = await startHost()
  try {
    assert.equal((await api(h, '/metrics')).status, 401)
    assert.equal((await api(h, '/metrics', { token: h.tokens.viewer })).status, 403)
    assert.equal((await api(h, '/metrics', { token: h.tokens.auditor })).status, 200)
  } finally {
    await h.close()
  }
  const open = await startHost({ http: { host: '127.0.0.1', port: 0, metricsPublic: true } })
  try {
    assert.equal((await api(open, '/metrics')).status, 200)
  } finally {
    await open.close()
  }
})

test('a webhook whose vault secret is missing stops startup (fail closed)', async () => {
  const h = await startHost({
    webhooks: [{ id: 'erp-orders', workflow: 'daily-brief', secret: 'vault:erp-webhook', principal: 'svc:erp-webhook' }],
  }).catch((error: Error) => error)
  assert.ok(h instanceof Error)
  assert.match((h as Error).message, /does not exist/)
})

test('vault-backed webhook secrets rotate through the API without a restart', async () => {
  const first = generateWebhookSecret()
  const h = await startHost({
    webhooks: [{ id: 'erp-orders', workflow: 'daily-brief', secret: 'vault:erp-webhook', principal: 'svc:erp-webhook' }],
  }, {
    prepare: async (dir, env) => {
      const vault = new SecretsVault({ path: join(dir, 'vault.json'), masterKey: env.QUICKSILVER_VAULT_KEY!, tenantId: TENANT, access: new AccessController() })
      await vault.open()
      await vault.put({ id: 'cli:test', kind: 'human', tenantId: TENANT, roles: ['tenant-admin'] }, 'erp-webhook', first)
    },
  })
  try {
    const body = '{"n":1}'
    const send = (secret: string, id: string) => fetch(`${h.base}/webhooks/erp-orders`, { method: 'POST', headers: signed(secret, body, id), body })
    assert.equal((await send(first, 'a')).status, 202)
    const second = generateWebhookSecret()
    const put = await (await api(h, '/api/secrets/erp-webhook', { method: 'PUT', token: h.tokens.admin, body: { value: second } })).json() as { reloadedWebhooks: string[] }
    assert.deepEqual(put.reloadedWebhooks, ['erp-orders'])
    assert.equal((await send(second, 'b')).status, 202)
    assert.equal((await send(first, 'c')).status, 202, 'the previous secret stays valid during the grace period')
    const logText = h.logs.join('\n')
    assert.ok(!logText.includes(first) && !logText.includes(second))
  } finally {
    await h.close()
  }
})

test('secrets: admins write, values are never returned, rotation keeps the old secret during grace', async () => {
  const h = await startHost()
  try {
    const first = generateWebhookSecret()
    assert.equal((await api(h, '/api/secrets/erp-webhook', { method: 'PUT', token: h.tokens.operator, body: { value: first } })).status, 403)
    const put = await api(h, '/api/secrets/erp-webhook', { method: 'PUT', token: h.tokens.admin, body: { value: first, description: 'ERP webhook' } })
    assert.equal(put.status, 200)
    const meta = await put.json() as { secret: { activeVersion: number } }
    assert.equal(meta.secret.activeVersion, 1)
    assert.ok(!JSON.stringify(meta).includes(first))

    const second = generateWebhookSecret()
    const rotated = await (await api(h, '/api/secrets/erp-webhook', { method: 'PUT', token: h.tokens.admin, body: { value: second } })).json() as { secret: { activeVersion: number; versions: Array<{ expiresAt?: string }> } }
    assert.equal(rotated.secret.activeVersion, 2)
    assert.ok(rotated.secret.versions.find((v) => v.expiresAt))

    const listing = await (await api(h, '/api/secrets', { token: h.tokens.admin })).text()
    assert.ok(!listing.includes(first) && !listing.includes(second))
    const onDisk = await readFile(join(h.dir, 'vault.json'), 'utf8')
    assert.ok(!onDisk.includes(first) && !onDisk.includes(second))

    assert.equal((await api(h, '/api/admin/reload-secrets', { method: 'POST', token: h.tokens.viewer, body: {} })).status, 403)
    assert.equal((await api(h, '/api/admin/reload-secrets', { method: 'POST', token: h.tokens.admin, body: {} })).status, 200)
  } finally {
    await h.close()
  }
})

test('supervisors cancel and redrive; operators cannot redrive', async () => {
  const h = await startHost({}, {
    agentRunner: async () => { throw new Error('provider unavailable') },
  })
  try {
    const res = await api(h, '/api/runs', { method: 'POST', token: h.tokens.operator, body: { workflow: 'daily-brief', input: 'hello there' } })
    const { runId } = await res.json() as { runId: string }
    const run = await waitForRun(h, runId)
    assert.equal(run.status, 'dead-lettered')
    const dead = await (await api(h, '/api/dead-letters', { token: h.tokens.viewer })).json() as { runs: unknown[] }
    assert.equal(dead.runs.length, 1)
    assert.equal((await api(h, `/api/runs/${runId}/redrive`, { method: 'POST', token: h.tokens.operator, body: { reason: 'provider is back online' } })).status, 403)
    assert.equal((await api(h, `/api/runs/${runId}/redrive`, { method: 'POST', token: h.tokens.supervisor, body: { reason: 'short' } })).status, 400)
    const redriven = await api(h, `/api/runs/${runId}/redrive`, { method: 'POST', token: h.tokens.supervisor, body: { reason: 'provider is back online' } })
    assert.equal(redriven.status, 200)
    assert.equal((await api(h, '/api/runs/unknown-run/cancel', { method: 'POST', token: h.tokens.supervisor, body: {} })).status, 404)
  } finally {
    await h.close()
  }
})

test('the host serves exactly one tenant', () => {
  const config = parseHostConfig({ tenantId: TENANT })
  const other = person('entity-x', ['viewer'])
  assert.throws(() => new QuicksilverHost(config, { principals: [{ ...other.config, tenantId: 'acme' }] }), /another tenant/)
})

test('schedules and webhooks are listed without secrets', async () => {
  const h = await startHost()
  try {
    const schedules = await (await api(h, '/api/schedules', { token: h.tokens.viewer })).json() as { schedules: Array<{ id: string; nextRunAt: string }> }
    assert.equal(schedules.schedules[0]!.id, 'morning')
    assert.match(schedules.schedules[0]!.nextRunAt, new RegExp(`T${String(SCHEDULE_HOUR).padStart(2, '0')}:00:00`))
    const hooks = await (await api(h, '/api/webhooks', { token: h.tokens.viewer })).text()
    assert.ok(hooks.includes('erp-orders') && !hooks.includes(h.webhookSecret))
    const workflows = await (await api(h, '/api/workflows', { token: h.tokens.viewer })).json() as { workflows: unknown[] }
    assert.equal(workflows.workflows.length, 2)
  } finally {
    await h.close()
  }
})
