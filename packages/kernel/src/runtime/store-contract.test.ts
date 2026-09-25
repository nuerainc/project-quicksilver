/**
 * One behavioural contract, run against every WorkflowRunStore backend:
 * in-memory, the JSONL file journal, and PostgreSQL (via PGlite, an embedded
 * WASM Postgres, when `@electric-sql/pglite` is installed). Run with:
 *   node --experimental-strip-types --no-warnings --test packages/kernel/src/runtime/store-contract.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WorkflowGraph } from '../index.ts'
import { InMemoryWorkflowRunStore, WorkflowRunQueue, WorkflowRunWorker, type WorkflowRunStore } from './index.ts'
import { FileWorkflowRunStore } from './file-store.ts'
import { PostgresWorkflowRunStore, workflowRunSchemaSql, type SqlClient } from './postgres-store.ts'

const graph: WorkflowGraph = {
  schemaVersion: 1, id: 'wf-contract', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'agent-1', kind: 'agent', label: 'Agent', config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'agent-1' }, { id: 'e2', from: 'agent-1', to: 'done' }],
}

type Backend = { name: string; open(): Promise<WorkflowRunStore> }

async function pglite(): Promise<{ create(): Promise<SqlClient> } | undefined> {
  try {
    const mod = await import('@electric-sql/pglite') as { PGlite: { create(): Promise<SqlClient> } }
    return { create: () => mod.PGlite.create() }
  } catch {
    return undefined
  }
}

const embedded = await pglite()
const backends: Backend[] = [
  { name: 'memory', open: async () => new InMemoryWorkflowRunStore() },
  { name: 'file', open: async () => FileWorkflowRunStore.open(join(await mkdtemp(join(tmpdir(), 'qs-contract-')), 'runs.jsonl'), { fsync: false }) },
  ...(embedded ? [{
    name: 'postgres',
    open: async () => {
      const store = new PostgresWorkflowRunStore(await embedded.create())
      await store.migrate()
      await store.migrate() // idempotent
      return store
    },
  }] : []),
]

if (!embedded) test('Postgres contract', { skip: 'install @electric-sql/pglite to run the Postgres store contract' }, () => {})

for (const backend of backends) {
  function queueOn(store: WorkflowRunStore, opts: Partial<ConstructorParameters<typeof WorkflowRunQueue>[0]> = {}) {
    let clock = 1_000
    let ids = 0
    return new WorkflowRunQueue({ store, now: () => clock++, newRunId: () => `${backend.name}-run-${++ids}`, retryBaseDelayMs: 1, ...opts })
  }

  test(`[${backend.name}] records round-trip as copies, filters work, and events are sequenced`, async () => {
    const store = await backend.open()
    const queue = queueOn(store)
    await queue.enqueue({ graph, input: { n: 1, nested: { list: [1, 'two', null] } }, tenantId: 'acme', idempotencyKey: 'k1', priority: 7 })
    await queue.enqueue({ graph, input: { n: 2 }, tenantId: 'globex' })
    const run = (await store.get(`${backend.name}-run-1`))!
    assert.deepEqual(run.input, { n: 1, nested: { list: [1, 'two', null] } })
    assert.equal(run.priority, 7)
    ;(run.input as { n: number }).n = 99
    assert.equal(((await store.get(run.runId))!.input as { n: number }).n, 1)
    assert.equal((await store.findByIdempotencyKey('acme', 'k1'))?.runId, run.runId)
    assert.equal(await store.findByIdempotencyKey('globex', 'k1'), undefined)
    assert.deepEqual((await store.list({ tenantId: 'globex' })).map((r) => r.tenantId), ['globex'])
    assert.equal((await store.list({ status: ['queued', 'running'] })).length, 2)
    assert.equal((await store.list({ status: 'completed' })).length, 0)
    assert.equal((await store.list({ workflowId: 'wf-contract' })).length, 2)
    await store.appendEvent({ runId: run.runId, at: 5, type: 'heartbeat', actor: 'w' })
    const events = await store.events(run.runId)
    assert.deepEqual(events.map((e) => e.seq), [1, 2])
    assert.deepEqual(events[1], { runId: run.runId, seq: 2, at: 5, type: 'heartbeat', actor: 'w' })
    await assert.rejects(store.appendEvent({ runId: 'ghost', at: 1, type: 'queued' }), /unknown run/)
    assert.equal(await store.get('ghost'), undefined)
  })

  test(`[${backend.name}] duplicates are refused and compare-and-set is revision-guarded`, async () => {
    const store = await backend.open()
    const queue = queueOn(store)
    const admitted = await queue.enqueue({ graph, input: 1, tenantId: 'acme', idempotencyKey: 'dup' })
    assert.ok(admitted.accepted)
    const run = admitted.run
    await assert.rejects(store.insert(run), /already exists/)
    await assert.rejects(store.insert({ ...run, runId: 'other' }), /idempotency key/)
    assert.equal(await store.compareAndSet({ ...run, revision: 3 }, 2), false, 'stale expected revision')
    assert.equal(await store.compareAndSet({ ...run, revision: 5 }, 1), false, 'must advance by exactly one')
    await assert.rejects(store.compareAndSet({ ...run, revision: 2, tenantId: 'globex' }, 1), /immutable/)
    assert.equal(await store.compareAndSet({ ...run, revision: 2, status: 'running' }, 1), true)
    assert.equal((await store.get(run.runId))?.status, 'running')
    assert.equal(await store.compareAndSet({ ...run, revision: 2, status: 'cancelled' }, 1), false, 'second writer loses')
  })

  test(`[${backend.name}] concurrent claims hand each run to exactly one worker`, async () => {
    const store = await backend.open()
    const queue = queueOn(store)
    for (let i = 0; i < 5; i += 1) await queue.enqueue({ graph, input: i, tenantId: 't', maxAttempts: 1 })
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => queue.claim(`w${i}`)))
    const claimed = claims.filter(Boolean).map((r) => r!.runId)
    assert.equal(claimed.length, new Set(claimed).size, 'no run claimed twice')
    assert.ok(claimed.length <= 4, 'per-tenant running limit (4) holds under contention')
  })

  test(`[${backend.name}] separate queue instances (other processes) still respect the per-tenant limit`, async () => {
    const store = await backend.open()
    const producer = queueOn(store)
    for (let i = 0; i < 6; i += 1) await producer.enqueue({ graph, input: i, tenantId: 't' })
    const hosts = Array.from({ length: 4 }, () => queueOn(store, { maxRunningPerTenant: 2 }))
    await Promise.all(hosts.flatMap((host, h) => [host.claim(`h${h}a`), host.claim(`h${h}b`)]))
    const running = await store.list({ status: 'running' })
    assert.ok(running.length <= 2, `expected at most 2 running, got ${running.length}`)
    assert.ok(running.length >= 1)
    const queued = await store.list({ status: 'queued' })
    assert.equal(running.length + queued.length, 6, 'yielded claims return to the queue')
    assert.ok(queued.every((r) => r.attempt === 0 && !r.lease), 'a yielded claim does not consume an attempt')
  })

  test(`[${backend.name}] idempotent enqueue races resolve to one run`, async () => {
    const store = await backend.open()
    const queue = queueOn(store)
    const results = await Promise.all(Array.from({ length: 6 }, () => queue.enqueue({ graph, input: { e: 1 }, tenantId: 't', idempotencyKey: 'evt-9' })))
    const ids = new Set(results.map((r) => r.accepted && r.run.runId))
    assert.equal(ids.size, 1)
    assert.equal((await store.list()).length, 1)
  })

  test(`[${backend.name}] a worker completes queued runs end to end`, async () => {
    const store = await backend.open()
    const queue = queueOn(store)
    await queue.enqueue({ graph, input: 'a', tenantId: 't' })
    await queue.enqueue({ graph, input: 'b', tenantId: 't' })
    const worker = new WorkflowRunWorker({
      queue, workerId: 'w1', concurrency: 2,
      resolveHandlers: () => ({
        async runAgent(_node, ctx) { return { echoed: ctx.input } },
        async runTool() { throw new Error('no tools') },
        async evaluate() { return { safetyDecision: 'ALLOW' } },
      }),
    })
    const finished = await worker.drain()
    assert.deepEqual(finished.map((r) => r.status), ['completed', 'completed'])
    const stored = await store.list({ status: 'completed' })
    assert.deepEqual(stored.map((r) => (r.result!.outputs.done as { echoed: string }).echoed).sort(), ['a', 'b'])
    assert.deepEqual((await store.events(stored[0]!.runId)).map((e) => e.type), ['queued', 'claimed', 'completed'])
  })
}

test('Postgres schema: prefixes are validated and applied', () => {
  assert.match(workflowRunSchemaSql('tenant_a_'), /CREATE TABLE IF NOT EXISTS tenant_a_workflow_runs/)
  assert.throws(() => workflowRunSchemaSql('x; DROP TABLE users; --'), /prefix/)
  assert.throws(() => new PostgresWorkflowRunStore({ query: async () => ({ rows: [] }) }, { prefix: 'Bad-Prefix' }), /prefix/)
})
