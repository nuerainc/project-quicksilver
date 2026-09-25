/**
 * Cron parsing/scheduling and signed webhook triggers. Run with:
 *   node --experimental-strip-types --no-warnings --test packages/kernel/src/triggers/triggers.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AccessController, type Principal, type WorkflowGraph } from '../index.ts'
import { InMemoryWorkflowRunStore, WorkflowRunQueue } from '../runtime/index.ts'
import {
  CronScheduler,
  InMemoryReplayCache,
  WebhookTrigger,
  generateWebhookSecret,
  nextCronTime,
  parseCron,
  previousCronTime,
  signWebhook,
  validateCron,
} from './index.ts'

const graph: WorkflowGraph = {
  schemaVersion: 1, id: 'wf-intake', version: 2, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'agent-1', kind: 'agent', label: 'Agent', config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'agent-1' }, { id: 'e2', from: 'agent-1', to: 'done' }],
}
const hookPrincipal: Principal = { id: 'svc:erp-webhook', kind: 'service', tenantId: 'acme', roles: ['trigger'] }
const cronPrincipal: Principal = { id: 'svc:scheduler', kind: 'service', tenantId: 'acme', roles: ['trigger'] }
const iso = (s: string) => Date.parse(s)
const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

// ── cron parsing ──────────────────────────────────────────────────────────

test('Cron: fields, lists, ranges, steps, and macros parse', () => {
  const c = parseCron('*/15 9-17 * * 1-5')
  assert.deepEqual([...c.minutes], [0, 15, 30, 45])
  assert.deepEqual([...c.hours].length, 9)
  assert.deepEqual([...c.daysOfWeek].sort(), [1, 2, 3, 4, 5])
  assert.deepEqual([...parseCron('0 0 * * 7').daysOfWeek], [0], '7 is Sunday')
  assert.deepEqual([...parseCron('5,10-12,50/5 * * * *').minutes], [5, 10, 11, 12, 50, 55])
  assert.equal(parseCron('@daily').minutes.has(0), true)
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '* * * * 8']) {
    assert.notEqual(validateCron(bad), null, bad)
  }
})

test('Cron: next/previous times are computed in UTC', () => {
  const from = iso('2026-09-24T10:07:30Z') // Thursday
  assert.equal(at(nextCronTime('*/15 * * * *', from)), '2026-09-24T10:15:00.000Z')
  assert.equal(at(nextCronTime('0 9 * * 1-5', from)), '2026-09-25T09:00:00.000Z')
  assert.equal(at(nextCronTime('0 0 1 * *', from)), '2026-10-01T00:00:00.000Z')
  assert.equal(at(nextCronTime('@weekly', from)), '2026-09-27T00:00:00.000Z')
  assert.equal(at(nextCronTime('30 23 31 12 *', from)), '2026-12-31T23:30:00.000Z')
  assert.equal(at(nextCronTime('0 0 29 2 *', from)), '2028-02-29T00:00:00.000Z', 'leap day')
  assert.equal(at(nextCronTime('0 10 * * *', iso('2026-09-24T10:00:00Z'))), '2026-09-25T10:00:00.000Z', 'strictly after')
  assert.equal(at(previousCronTime('*/15 * * * *', from)), '2026-09-24T10:00:00.000Z')
  assert.equal(at(previousCronTime('0 10 * * *', iso('2026-09-24T10:00:00Z'))), '2026-09-24T10:00:00.000Z', 'inclusive')
  assert.equal(nextCronTime('0 0 31 2 *', from), null, 'impossible date')
})

test('Cron: day-of-month and day-of-week use OR semantics when both are restricted', () => {
  // The 1st of the month OR any Monday.
  assert.equal(at(nextCronTime('0 0 1 * 1', iso('2026-09-24T00:00:00Z'))), '2026-09-28T00:00:00.000Z')
  assert.equal(at(nextCronTime('0 0 1 * 1', iso('2026-09-28T00:00:00Z'))), '2026-10-01T00:00:00.000Z')
})

// ── scheduler ─────────────────────────────────────────────────────────────

function scheduler(now: { t: number }, access = true) {
  const queue = new WorkflowRunQueue({ store: new InMemoryWorkflowRunStore(), now: () => now.t, ...(access ? { access: new AccessController() } : {}) })
  const cron = new CronScheduler({ queue, now: () => now.t, catchUpWindowMs: 3_600_000 })
  return { queue, cron }
}

test('Scheduler: enqueues each due slot once, with slot time in the input', async () => {
  const now = { t: iso('2026-09-24T10:00:20Z') }
  const { queue, cron } = scheduler(now)
  cron.add({ id: 'hourly-report', tenantId: 'acme', cron: '0 * * * *', graph, input: { report: 'ops' }, principal: cronPrincipal })
  const first = await cron.tick()
  assert.equal(first.length, 1)
  assert.equal(first[0]!.result.accepted, true)
  assert.equal((await cron.tick()).length, 0, 'same slot is not re-enqueued')
  now.t = iso('2026-09-24T10:30:00Z')
  assert.equal((await cron.tick()).length, 0)
  now.t = iso('2026-09-24T11:00:05Z')
  await cron.tick()
  const runs = await queue.store.list()
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => (r.input as { scheduledFor: string }).scheduledFor), ['2026-09-24T10:00:00.000Z', '2026-09-24T11:00:00.000Z'])
  assert.deepEqual(runs[0]!.input, { report: 'ops', scheduledFor: '2026-09-24T10:00:00.000Z' })
  assert.equal(runs[0]!.trigger.kind, 'schedule')
  assert.equal(runs[0]!.requestedBy, cronPrincipal.id)
})

test('Scheduler: replicas and restarts never duplicate a slot (idempotency key per slot)', async () => {
  const now = { t: iso('2026-09-24T10:00:20Z') }
  const { queue } = scheduler(now)
  const a = new CronScheduler({ queue, now: () => now.t })
  const b = new CronScheduler({ queue, now: () => now.t })
  for (const s of [a, b]) s.add({ id: 'sync', tenantId: 'acme', cron: '* * * * *', graph, principal: cronPrincipal })
  const [ra, rb] = await Promise.all([a.tick(), b.tick()])
  assert.equal((await queue.store.list()).length, 1)
  const outcomes = [ra[0]!.result, rb[0]!.result].map((r) => r.accepted && r.deduplicated)
  assert.deepEqual(outcomes.sort(), [false, true])
})

test('Scheduler: after an outage only the latest missed slot runs, and only inside the catch-up window', async () => {
  const now = { t: iso('2026-09-24T10:00:00Z') }
  const { queue, cron } = scheduler(now)
  cron.add({ id: 'every-5', tenantId: 'acme', cron: '*/5 * * * *', graph, principal: cronPrincipal })
  now.t = iso('2026-09-24T10:47:00Z')
  await cron.tick()
  const runs = await queue.store.list()
  assert.equal(runs.length, 1, 'no stampede of missed slots')
  assert.equal((runs[0]!.input as { scheduledFor: string }).scheduledFor, '2026-09-24T10:45:00.000Z')

  const daily = scheduler({ t: iso('2026-09-24T13:00:00Z') })
  daily.cron.add({ id: 'nightly', tenantId: 'acme', cron: '0 2 * * *', graph, principal: cronPrincipal })
  assert.equal((await daily.cron.tick()).length, 0, '02:00 slot is 11h old, outside the 1h window')
})

test('Scheduler: RBAC applies — a schedule without an enqueue-capable principal is refused', async () => {
  const now = { t: iso('2026-09-24T10:00:10Z') }
  const { cron } = scheduler(now)
  cron.add({ id: 'no-principal', tenantId: 'acme', cron: '* * * * *', graph })
  cron.add({ id: 'wrong-tenant', tenantId: 'acme', cron: '* * * * *', graph, principal: { ...cronPrincipal, tenantId: 'globex' } })
  const results = await cron.tick()
  assert.deepEqual(results.map((r) => !r.result.accepted && r.result.code), ['forbidden', 'forbidden'])
})

test('Scheduler: disabled schedules are skipped; ids and expressions are validated', async () => {
  const now = { t: iso('2026-09-24T10:00:10Z') }
  const { cron } = scheduler(now, false)
  cron.add({ id: 'off', tenantId: 'acme', cron: '* * * * *', graph, enabled: false })
  assert.equal((await cron.tick()).length, 0)
  assert.throws(() => cron.add({ id: 'off', tenantId: 'acme', cron: '* * * * *', graph }), /already exists/)
  assert.throws(() => cron.add({ id: 'bad', tenantId: 'acme', cron: '61 * * * *', graph }), /out of range/)
  assert.throws(() => cron.add({ id: 'bad id', tenantId: 'acme', cron: '* * * * *', graph }), /invalid/)
  assert.equal(cron.list()[0]!.nextRunAt, iso('2026-09-24T10:01:00Z'))
})

// ── webhooks ──────────────────────────────────────────────────────────────

const secret = 'whsec_test_secret_that_is_long_enough_123456'

function webhooks(nowMs = iso('2026-09-24T10:00:00Z'), extra: Partial<ConstructorParameters<typeof WebhookTrigger>[0]> = {}) {
  const now = { t: nowMs }
  const queue = new WorkflowRunQueue({ store: new InMemoryWorkflowRunStore(), now: () => now.t, access: new AccessController() })
  const trigger = new WebhookTrigger({ queue, now: () => now.t, endpoints: [{ id: 'erp-orders', tenantId: 'acme', graph, secrets: [secret], principal: hookPrincipal }], ...extra })
  return { queue, trigger, now }
}

function signedHeaders(body: string, nowMs: number, opts: { secret?: string; delivery?: string; ts?: number; contentType?: string } = {}) {
  const ts = opts.ts ?? Math.floor(nowMs / 1000)
  const headers = new Headers({
    'content-type': opts.contentType ?? 'application/json',
    'x-quicksilver-timestamp': String(ts),
    'x-quicksilver-signature': signWebhook(opts.secret ?? secret, ts, body),
  })
  if (opts.delivery) headers.set('x-quicksilver-delivery', opts.delivery)
  return headers
}

test('Webhook: a correctly signed delivery enqueues one run as the endpoint principal', async () => {
  const { queue, trigger, now } = webhooks()
  const body = JSON.stringify({ order: 1182, status: 'late' })
  const outcome = await trigger.receive('erp-orders', signedHeaders(body, now.t, { delivery: 'evt_1' }), body)
  assert.equal(outcome.status, 202)
  const run = (await queue.store.list())[0]!
  assert.deepEqual(run.input, { event: { order: 1182, status: 'late' }, deliveryId: 'evt_1' })
  assert.deepEqual(run.trigger, { kind: 'webhook', source: 'erp-orders' })
  assert.equal(run.requestedBy, hookPrincipal.id)
  assert.equal(run.idempotencyKey, 'webhook:erp-orders:evt_1')
})

test('Webhook: a sender retry of the same delivery returns the same run', async () => {
  const { queue, trigger, now } = webhooks()
  const body = '{"order":7}'
  const first = await trigger.receive('erp-orders', signedHeaders(body, now.t, { delivery: 'evt_7' }), body)
  now.t += 30_000
  const retry = await trigger.receive('erp-orders', signedHeaders(body, now.t, { delivery: 'evt_7' }), body)
  const replay = await trigger.receive('erp-orders', signedHeaders(body, now.t, { delivery: 'evt_7' }), body)
  assert.equal(first.status, 202)
  assert.equal(retry.status, 200)
  assert.equal(replay.status, 200)
  assert.equal((await queue.store.list()).length, 1)
})

test('Webhook: bad signatures, wrong secrets, stale or future timestamps are rejected with one generic error', async () => {
  const { queue, trigger, now } = webhooks()
  const body = '{"a":1}'
  const cases = [
    signedHeaders(body, now.t, { secret: 'whsec_some_other_secret_value_that_is_long' }),
    signedHeaders(body, now.t, { ts: Math.floor(now.t / 1000) - 301 }),
    signedHeaders(body, now.t, { ts: Math.floor(now.t / 1000) + 301 }),
    new Headers({ 'content-type': 'application/json' }),
  ]
  for (const headers of cases) {
    const outcome = await trigger.receive('erp-orders', headers, body)
    assert.equal(outcome.status, 401)
    assert.equal(!outcome.body.accepted && outcome.body.error, 'Missing or invalid signature.')
  }
  const tampered = await trigger.receive('erp-orders', signedHeaders(body, now.t), '{"a":2}')
  assert.equal(tampered.status, 401)
  assert.equal((await queue.store.list()).length, 0)
})

test('Webhook: a replayed signature without a delivery id is refused', async () => {
  const { queue, trigger, now } = webhooks()
  const body = '{"a":1}'
  const headers = signedHeaders(body, now.t)
  assert.equal((await trigger.receive('erp-orders', headers, body)).status, 202)
  assert.equal((await trigger.receive('erp-orders', headers, body)).status, 409)
  assert.equal((await queue.store.list()).length, 1)
})

test('Webhook: secret rotation accepts old and new secrets', async () => {
  const next = generateWebhookSecret()
  const { trigger, now } = webhooks(undefined, { endpoints: [{ id: 'rotating', tenantId: 'acme', graph, secrets: [next, secret], principal: hookPrincipal }] })
  const body = '{"x":1}'
  assert.equal((await trigger.receive('rotating', signedHeaders(body, now.t, { secret, delivery: 'a' }), body)).status, 202)
  assert.equal((await trigger.receive('rotating', signedHeaders(body, now.t, { secret: next, delivery: 'b' }), body)).status, 202)
})

test('Webhook: unknown/disabled endpoints, content type, size, and JSON are checked', async () => {
  const { trigger, now } = webhooks(undefined, {
    endpoints: [
      { id: 'erp-orders', tenantId: 'acme', graph, secrets: [secret], principal: hookPrincipal, maxBodyBytes: 20 },
      { id: 'paused', tenantId: 'acme', graph, secrets: [secret], principal: hookPrincipal, enabled: false },
    ],
  })
  const body = '{"a":1}'
  assert.equal((await trigger.receive('nope', signedHeaders(body, now.t), body)).status, 404)
  assert.equal((await trigger.receive('paused', signedHeaders(body, now.t), body)).status, 404)
  assert.equal((await trigger.receive('erp-orders', signedHeaders(body, now.t, { contentType: 'text/plain' }), body)).status, 415)
  const big = JSON.stringify({ text: 'x'.repeat(50) })
  assert.equal((await trigger.receive('erp-orders', signedHeaders(big, now.t), big)).status, 413)
  assert.equal((await trigger.receive('erp-orders', signedHeaders('{bad', now.t), '{bad')).status, 400)
})

test('Webhook: RBAC and backpressure surface as 403 and 429', async () => {
  const noRole = webhooks(undefined, { endpoints: [{ id: 'e', tenantId: 'acme', graph, secrets: [secret], principal: { ...hookPrincipal, roles: ['viewer'] } }] })
  const body = '{"a":1}'
  assert.equal((await noRole.trigger.receive('e', signedHeaders(body, noRole.now.t), body)).status, 403)

  const now = { t: iso('2026-09-24T10:00:00Z') }
  const queue = new WorkflowRunQueue({ store: new InMemoryWorkflowRunStore(), now: () => now.t, maxQueuedPerTenant: 1 })
  const busy = new WebhookTrigger({ queue, now: () => now.t, endpoints: [{ id: 'e', tenantId: 'acme', graph, secrets: [secret] }] })
  assert.equal((await busy.receive('e', signedHeaders('{"n":1}', now.t, { delivery: '1' }), '{"n":1}')).status, 202)
  assert.equal((await busy.receive('e', signedHeaders('{"n":2}', now.t, { delivery: '2' }), '{"n":2}')).status, 429)
})

test('Webhook: endpoint configuration is validated', () => {
  const queue = new WorkflowRunQueue({ store: new InMemoryWorkflowRunStore() })
  assert.throws(() => new WebhookTrigger({ queue, endpoints: [{ id: 'e', tenantId: 'acme', graph, secrets: ['short'] }] }), /32\+ characters/)
  assert.throws(() => new WebhookTrigger({ queue, endpoints: [{ id: 'bad id', tenantId: 'acme', graph, secrets: [secret] }] }), /invalid/)
  assert.throws(() => new WebhookTrigger({ queue, endpoints: [{ id: 'e', tenantId: 'acme', graph, secrets: [secret] }, { id: 'e', tenantId: 'acme', graph, secrets: [secret] }] }), /already exists/)
  assert.ok(generateWebhookSecret().length >= 32)
})

test('Webhook: the Fetch handler reads the endpoint from the URL and returns JSON responses', async () => {
  const { trigger, now } = webhooks()
  const body = '{"hello":"world"}'
  const response = await trigger.handle(new Request('https://qs.example/api/triggers/webhooks/erp-orders', { method: 'POST', headers: signedHeaders(body, now.t, { delivery: 'h1' }), body }))
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(((await response.json()) as { accepted: boolean }).accepted, true)
  assert.equal((await trigger.handle(new Request('https://qs.example/x/erp-orders'))).status, 405)
})

test('ReplayCache: entries expire and the cache stays bounded', () => {
  const now = { t: 0 }
  const cache = new InMemoryReplayCache({ maxEntries: 2, now: () => now.t })
  assert.equal(cache.remember('a', 100), true)
  assert.equal(cache.remember('a', 100), false)
  now.t = 150
  assert.equal(cache.remember('a', 300), true, 'expired entries may be reused')
  cache.remember('b', 300)
  cache.remember('c', 300)
  assert.equal(cache.remember('c', 300), false)
})

test('Webhook: setSecrets rotates secrets in place and list() never exposes them', async () => {
  const { trigger, now } = webhooks()
  const next = generateWebhookSecret()
  assert.throws(() => trigger.setSecrets('erp-orders', ['short']), /32\+ characters/)
  assert.throws(() => trigger.setSecrets('missing', [next]), /does not exist/)
  trigger.setSecrets('erp-orders', [next, secret])
  const body = '{"rotated":true}'
  assert.equal((await trigger.receive('erp-orders', signedHeaders(body, now.t, { secret: next, delivery: 'r1' }), body)).status, 202)
  assert.equal((await trigger.receive('erp-orders', signedHeaders(body, now.t, { delivery: 'r2' }), body)).status, 202)
  trigger.setSecrets('erp-orders', [next])
  assert.equal((await trigger.receive('erp-orders', signedHeaders(body, now.t, { delivery: 'r3' }), body)).status, 401)
  const listed = trigger.list()
  assert.deepEqual(listed, [{ id: 'erp-orders', tenantId: 'acme', workflowId: 'wf-intake', enabled: true, secretCount: 1 }])
  assert.ok(!JSON.stringify(listed).includes(next))
})
