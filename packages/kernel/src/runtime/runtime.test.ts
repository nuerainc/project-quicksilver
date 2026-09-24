/**
 * Durable run layer: store, queue, worker, and file journal. Run with:
 *   node --experimental-strip-types --no-warnings --test packages/kernel/src/runtime/runtime.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WorkflowGraph, WorkflowNode, WorkflowRuntimeHandlers, WorkflowExecutionResult } from '../index.ts'
import { InMemoryWorkflowRunStore, WorkflowRunQueue, WorkflowRunWorker, graphDigest, canonicalJson } from './index.ts'
import { FileWorkflowRunStore } from './file-store.ts'

// ── fixtures ──────────────────────────────────────────────────────────────

function agentGraph(id = 'wf-agent'): WorkflowGraph {
  return {
    schemaVersion: 1, id, version: 3, entryNodeId: 'start',
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start' },
      { id: 'agent-1', kind: 'agent', label: 'Agent', config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true } },
      { id: 'done', kind: 'output', label: 'Done' },
    ],
    edges: [{ id: 'e1', from: 'start', to: 'agent-1' }, { id: 'e2', from: 'agent-1', to: 'done' }],
  }
}

function toolGraph(): WorkflowGraph {
  return {
    schemaVersion: 1, id: 'wf-tool', version: 1, entryNodeId: 'start',
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start' },
      { id: 'tool-1', kind: 'tool', label: 'Tool', config: { toolId: 'sanity.query' } },
      { id: 'done', kind: 'output', label: 'Done' },
    ],
    edges: [{ id: 'e1', from: 'start', to: 'tool-1' }, { id: 'e2', from: 'tool-1', to: 'done' }],
  }
}

function handlers(overrides: Partial<WorkflowRuntimeHandlers> = {}): WorkflowRuntimeHandlers {
  return {
    async runAgent(node: WorkflowNode) { return { value: node.id } },
    async runTool(node: WorkflowNode) { return { tool: node.id } },
    async evaluate() { return { safetyDecision: 'ALLOW' } },
    async validateTool() { return { allowed: true, reasons: [] } },
    async approve() { return { approved: true } },
    ...overrides,
  }
}

function setup(options: Partial<ConstructorParameters<typeof WorkflowRunQueue>[0]> = {}) {
  let clock = 1_000_000
  let ids = 0
  const store = new InMemoryWorkflowRunStore()
  const queue = new WorkflowRunQueue({ store, now: () => clock, newRunId: () => `run-${++ids}`, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, ...options })
  return { store, queue, advance: (ms: number) => { clock += ms }, now: () => clock }
}

const failed = (error = 'boom', extra: Partial<WorkflowExecutionResult> = {}): WorkflowExecutionResult => ({ status: 'failed', outputs: {}, steps: [{ nodeId: 'agent-1', status: 'failed', detail: error }], error, ...extra })

// ── admission ─────────────────────────────────────────────────────────────

test('Queue: enqueue validates, snapshots, freezes, and digests the graph', async () => {
  const { queue } = setup()
  const graph = agentGraph()
  const result = await queue.enqueue({ graph, input: { q: 'status' }, tenantId: 'acme', trigger: { kind: 'webhook', source: 'hook-7' } })
  assert.equal(result.accepted, true)
  if (!result.accepted) return
  assert.equal(result.run.status, 'queued')
  assert.equal(result.run.workflowVersion, 3)
  assert.equal(result.run.graphDigest, graphDigest(graph))
  assert.match(result.run.graphDigest, /^sha256:[0-9a-f]{64}$/)
  graph.nodes[1]!.label = 'edited after enqueue'
  assert.equal((await queue.get('run-1'))!.graph.nodes[1]!.label, 'Agent', 'later edits never change a queued run')
  const events = await queue.store.events('run-1')
  assert.deepEqual(events.map((e) => [e.seq, e.type, e.detail]), [[1, 'queued', 'trigger=webhook:hook-7']])
})

test('Queue: invalid graphs and malformed requests are rejected at admission', async () => {
  const { queue } = setup()
  const bad = await queue.enqueue({ graph: { ...agentGraph(), entryNodeId: 'x' }, input: null, tenantId: 'acme' })
  assert.equal(bad.accepted, false)
  assert.equal(!bad.accepted && bad.code, 'invalid-graph')
  const malformed = await queue.enqueue({ graph: agentGraph(), input: undefined, tenantId: 'bad tenant', priority: 12, maxAttempts: 0, idempotencyKey: ' ', trigger: { kind: 'ftp' as 'api' } })
  assert.equal(!malformed.accepted && malformed.code, 'invalid-request')
  assert.equal(!malformed.accepted && malformed.reasons.length, 6)
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  assert.equal((await queue.enqueue({ graph: agentGraph(), input: cyclic, tenantId: 'acme' })).accepted, false)
  const big = await setup({ maxInputBytes: 10 }).queue.enqueue({ graph: agentGraph(), input: 'x'.repeat(20), tenantId: 'acme' })
  assert.equal(big.accepted, false)
})

test('Queue: idempotency keys deduplicate per tenant and refuse conflicting reuse', async () => {
  const { queue } = setup()
  const a = await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 'acme', idempotencyKey: 'evt-1' })
  const b = await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 'acme', idempotencyKey: 'evt-1' })
  assert.ok(a.accepted && b.accepted)
  assert.equal(b.accepted && b.deduplicated, true)
  assert.equal(a.accepted && b.accepted && a.run.runId === b.run.runId, true)
  const otherTenant = await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 'globex', idempotencyKey: 'evt-1' })
  assert.equal(otherTenant.accepted && otherTenant.deduplicated, false)
  const conflict = await queue.enqueue({ graph: agentGraph(), input: 2, tenantId: 'acme', idempotencyKey: 'evt-1' })
  assert.equal(conflict.accepted, false)
})

test('Queue: global and per-tenant backpressure reject new work instead of growing unbounded', async () => {
  const { queue } = setup({ maxQueued: 3, maxQueuedPerTenant: 2 })
  assert.ok((await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 'a' })).accepted)
  assert.ok((await queue.enqueue({ graph: agentGraph(), input: 2, tenantId: 'a' })).accepted)
  const tenantFull = await queue.enqueue({ graph: agentGraph(), input: 3, tenantId: 'a' })
  assert.equal(!tenantFull.accepted && tenantFull.code, 'backpressure')
  assert.ok((await queue.enqueue({ graph: agentGraph(), input: 4, tenantId: 'b' })).accepted)
  const globalFull = await queue.enqueue({ graph: agentGraph(), input: 5, tenantId: 'c' })
  assert.equal(!globalFull.accepted && globalFull.code, 'backpressure')
})

// ── claiming ──────────────────────────────────────────────────────────────

test('Queue: claims by priority, then availability, then age; delayed runs wait', async () => {
  const { queue, advance } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 'low', tenantId: 't', priority: 1 })
  advance(1)
  await queue.enqueue({ graph: agentGraph(), input: 'high', tenantId: 't', priority: 9 })
  advance(1)
  await queue.enqueue({ graph: agentGraph(), input: 'later', tenantId: 't', priority: 9, delayMs: 500 })
  assert.equal((await queue.claim('w1'))?.input, 'high')
  assert.equal((await queue.claim('w1'))?.input, 'low')
  assert.equal(await queue.claim('w1'), undefined, 'delayed run is not yet available')
  advance(500)
  const later = await queue.claim('w1')
  assert.equal(later?.input, 'later')
  assert.equal(later?.attempt, 1)
  assert.equal(later?.lease?.workerId, 'w1')
})

test('Queue: per-tenant running limit keeps one tenant from starving others', async () => {
  const { queue } = setup({ maxRunningPerTenant: 1 })
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 'noisy', priority: 9 })
  await queue.enqueue({ graph: agentGraph(), input: 2, tenantId: 'noisy', priority: 9 })
  await queue.enqueue({ graph: agentGraph(), input: 3, tenantId: 'quiet', priority: 0 })
  assert.equal((await queue.claim('w'))?.tenantId, 'noisy')
  assert.equal((await queue.claim('w'))?.tenantId, 'quiet')
  assert.equal(await queue.claim('w'), undefined)
})

test('Queue: two workers can never claim the same run', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  const [a, b] = await Promise.all([queue.claim('w1'), queue.claim('w2')])
  assert.equal([a, b].filter(Boolean).length, 1)
})

// ── outcomes ──────────────────────────────────────────────────────────────

test('Queue: only the lease holder can record an outcome', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  await queue.claim('w1')
  await assert.rejects(queue.complete('run-1', 'w2', { status: 'completed', outputs: {}, steps: [] }), /does not hold the lease/)
  const done = await queue.complete('run-1', 'w1', { status: 'completed', outputs: { done: 1 }, steps: [] })
  assert.equal(done.status, 'completed')
  assert.equal(done.lease, undefined)
  await assert.rejects(queue.complete('run-1', 'w1', { status: 'completed', outputs: {}, steps: [] }))
})

test('Queue: blocked is a governance outcome and is never retried', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't', maxAttempts: 5 })
  await queue.claim('w')
  const run = await queue.complete('run-1', 'w', { status: 'blocked', outputs: {}, steps: [], error: 'Supervisor approval was not granted.' })
  assert.equal(run.status, 'blocked')
  assert.equal(run.lastError, 'Supervisor approval was not granted.')
})

test('Queue: failures retry with exponential backoff, then dead-letter when attempts run out', async () => {
  const { queue, advance } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't', maxAttempts: 3 })
  await queue.claim('w')
  let run = await queue.complete('run-1', 'w', failed())
  assert.equal(run.status, 'queued')
  assert.equal(run.availableAt - 1_000_000, 100)
  assert.equal(await queue.claim('w'), undefined, 'backoff delays the retry')
  advance(100)
  await queue.claim('w')
  run = await queue.complete('run-1', 'w', failed())
  assert.equal(run.availableAt - (1_000_100), 200)
  advance(200)
  await queue.claim('w')
  run = await queue.complete('run-1', 'w', failed('still down'))
  assert.equal(run.status, 'dead-lettered')
  assert.match(run.deadLetter!.reason, /Exhausted 3 attempt/)
  const types = (await queue.store.events('run-1')).map((e) => e.type)
  assert.deepEqual(types, ['queued', 'claimed', 'retry-scheduled', 'claimed', 'retry-scheduled', 'claimed', 'dead-lettered'])
})

test('Queue: provider retry hints (e.g. 429 Retry-After) stretch the backoff', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  await queue.claim('w')
  const run = await queue.complete('run-1', 'w', failed('rate limited', { steps: [{ nodeId: 'agent-1', status: 'failed', retryAfterMs: 30_000 }] }))
  assert.equal(run.availableAt - 1_000_000, 30_000)
})

test('Queue: a failed run whose tool step was dispatched is dead-lettered, never retried', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: toolGraph(), input: 1, tenantId: 't', maxAttempts: 5 })
  await queue.claim('w')
  const run = await queue.complete('run-1', 'w', { status: 'failed', outputs: {}, steps: [{ nodeId: 'start', status: 'completed' }, { nodeId: 'tool-1', status: 'failed', detail: 'socket hang up' }], error: 'socket hang up' })
  assert.equal(run.status, 'dead-lettered')
  assert.match(run.deadLetter!.reason, /tool-1/)
})

test('Queue: a tool graph that failed before any tool dispatch may still retry', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: toolGraph(), input: 1, tenantId: 't' })
  await queue.claim('w')
  const run = await queue.complete('run-1', 'w', { status: 'failed', outputs: {}, steps: [], error: 'Run setup failed: no credentials' })
  assert.equal(run.status, 'queued')
})

// ── cancellation, leases, redrive ─────────────────────────────────────────

test('Queue: cancelling a queued run is immediate; a running run is flagged for its worker', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  await queue.enqueue({ graph: agentGraph(), input: 2, tenantId: 't' })
  assert.equal((await queue.cancel('run-1', 'ops@acme', 'duplicate'))?.status, 'cancelled')
  const running = await queue.claim('w')
  assert.equal(running?.runId, 'run-2')
  const flagged = await queue.cancel('run-2', 'ops@acme')
  assert.equal(flagged?.status, 'running')
  assert.ok(flagged?.cancelRequest)
  assert.equal((await queue.complete('run-2', 'w', failed())).status, 'cancelled', 'a flagged run is never retried')
  await assert.rejects(queue.cancel('run-2', ' '), /named actor/)
})

test('Queue: expired leases requeue agent-only runs but dead-letter runs with tool steps', async () => {
  const { queue, advance } = setup({ leaseMs: 1_000 })
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  await queue.enqueue({ graph: toolGraph(), input: 2, tenantId: 't' })
  await queue.claim('w1')
  await queue.claim('w1')
  advance(500)
  assert.ok(await queue.heartbeat('run-1', 'w1'))
  assert.equal(await queue.heartbeat('run-1', 'w2'), undefined)
  advance(700)
  const recovered = await queue.recoverExpiredLeases()
  assert.deepEqual(recovered.map((r) => [r.runId, r.status]), [['run-2', 'dead-lettered']], 'run-1 was heartbeated')
  advance(1_000)
  const second = await queue.recoverExpiredLeases()
  assert.deepEqual(second.map((r) => [r.runId, r.status]), [['run-1', 'queued']])
})

test('Queue: redrive needs a dead letter, an actor, and a reason, and resets the attempt budget', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't', maxAttempts: 1 })
  await queue.claim('w')
  await queue.complete('run-1', 'w', failed())
  assert.equal((await queue.deadLetters('t')).length, 1)
  await assert.rejects(queue.redrive('run-1', 'ops', ' '), /reason/)
  const redriven = await queue.redrive('run-1', 'ops@acme', 'provider restored')
  assert.equal(redriven.status, 'queued')
  assert.equal(redriven.attempt, 0)
  assert.equal(redriven.deadLetter, undefined)
  await assert.rejects(queue.redrive('run-1', 'ops', 'again'), /Only dead-lettered/)
  const last = (await queue.store.events('run-1')).at(-1)
  assert.deepEqual([last?.type, last?.actor, last?.detail], ['redriven', 'ops@acme', 'provider restored'])
})

test('Queue: stats summarise runs by status and tenant', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 'a' })
  await queue.enqueue({ graph: agentGraph(), input: 2, tenantId: 'b' })
  await queue.claim('w')
  const stats = await queue.stats()
  assert.equal(stats.byStatus.queued, 1)
  assert.equal(stats.byStatus.running, 1)
  assert.deepEqual(stats.byTenant.a, { running: 1 })
})

test('Store: records are copies and stale compare-and-set is refused', async () => {
  const store = new InMemoryWorkflowRunStore()
  const { queue } = setup({ store } as never)
  await queue.enqueue({ graph: agentGraph(), input: { n: 1 }, tenantId: 't' })
  const copy = (await store.get('run-1'))!
  ;(copy.input as { n: number }).n = 99
  assert.deepEqual((await store.get('run-1'))!.input, { n: 1 })
  assert.equal(await store.compareAndSet({ ...copy, revision: 3 }, 2), false)
  await assert.rejects(store.compareAndSet({ ...copy, revision: 2, tenantId: 'other' }, 1), /immutable/)
  await assert.rejects(store.appendEvent({ runId: 'ghost', at: 1, type: 'queued' }), /unknown run/)
})

test('canonicalJson: key order does not change the digest', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}')
})

// ── worker ────────────────────────────────────────────────────────────────

test('Worker: drain executes queued runs through the governed runner', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: agentGraph(), input: 'a', tenantId: 't' })
  await queue.enqueue({ graph: agentGraph(), input: 'b', tenantId: 't' })
  const finished: string[] = []
  const worker = new WorkflowRunWorker({ queue, workerId: 'w1', resolveHandlers: () => handlers(), concurrency: 2, onRunFinished: (run) => finished.push(run.runId) })
  const runs = await worker.drain()
  assert.equal(runs.length, 2)
  assert.ok(runs.every((run) => run.status === 'completed'))
  assert.deepEqual((await queue.get('run-1'))!.result!.outputs.done, { value: 'agent-1' })
  assert.deepEqual(finished.sort(), ['run-1', 'run-2'])
})

test('Worker: a handler-resolution failure fails the attempt without running any step', async () => {
  const { queue } = setup()
  await queue.enqueue({ graph: toolGraph(), input: 1, tenantId: 't', maxAttempts: 1 })
  const worker = new WorkflowRunWorker({ queue, workerId: 'w', resolveHandlers: () => { throw new Error('tenant credentials missing') } })
  const run = await worker.runOnce()
  assert.equal(run?.status, 'dead-lettered')
  assert.match(run!.lastError!, /tenant credentials missing/)
})

test('Worker: cancellation requested mid-run aborts the handler signal and ends cancelled', async () => {
  const { queue } = setup({ leaseMs: 60 })
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  let sawAbort = false
  const worker = new WorkflowRunWorker({
    queue, workerId: 'w', heartbeatMs: 10,
    resolveHandlers: () => handlers({
      runAgent: (_node, ctx) => new Promise((resolve) => {
        ctx.signal?.addEventListener('abort', () => { sawAbort = true })
        setTimeout(() => resolve('late'), 400)
      }),
    }),
  })
  const pending = worker.runOnce()
  await new Promise((r) => setTimeout(r, 20))
  await queue.cancel('run-1', 'ops@acme', 'operator stop')
  const run = await pending
  assert.equal(run?.status, 'cancelled')
  assert.equal(sawAbort, true)
  assert.equal(run?.result?.status, 'cancelled')
  assert.match(run!.lastError!, /operator stop/)
})

test('Worker: start/stop polls in the background and shuts down gracefully', async () => {
  const { queue } = setup()
  const worker = new WorkflowRunWorker({ queue, workerId: 'w', resolveHandlers: () => handlers(), pollIntervalMs: 5 })
  worker.start()
  await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  for (let i = 0; i < 50 && (await queue.get('run-1'))?.status !== 'completed'; i += 1) await new Promise((r) => setTimeout(r, 5))
  await worker.stop()
  assert.equal((await queue.get('run-1'))?.status, 'completed')
})

// ── file journal ──────────────────────────────────────────────────────────

test('FileStore: runs and events survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-runs-'))
  const path = join(dir, 'runs.jsonl')
  let clock = 5
  const store = await FileWorkflowRunStore.open(path, { fsync: false })
  const queue = new WorkflowRunQueue({ store, now: () => clock, newRunId: () => 'run-a' })
  await queue.enqueue({ graph: agentGraph(), input: { q: 1 }, tenantId: 't', idempotencyKey: 'k1' })
  await queue.claim('w')
  await queue.complete('run-a', 'w', { status: 'completed', outputs: { done: 1 }, steps: [] })

  const reopened = await FileWorkflowRunStore.open(path, { fsync: false })
  const run = await reopened.get('run-a')
  assert.equal(run?.status, 'completed')
  assert.equal(run?.revision, 3)
  assert.deepEqual((await reopened.events('run-a')).map((e) => e.type), ['queued', 'claimed', 'completed'])
  assert.equal((await reopened.findByIdempotencyKey('t', 'k1'))?.runId, 'run-a')
  clock += 1
  const again = new WorkflowRunQueue({ store: reopened, now: () => clock })
  const dedup = await again.enqueue({ graph: agentGraph(), input: { q: 1 }, tenantId: 't', idempotencyKey: 'k1' })
  assert.equal(dedup.accepted && dedup.deduplicated, true)
})

test('FileStore: a torn final line is dropped; mid-file corruption refuses to open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-runs-'))
  const path = join(dir, 'runs.jsonl')
  const store = await FileWorkflowRunStore.open(path, { fsync: false })
  await new WorkflowRunQueue({ store, newRunId: () => 'run-a' }).enqueue({ graph: agentGraph(), input: 1, tenantId: 't' })
  await appendFile(path, '{"v":1,"op":"upd')
  const recovered = await FileWorkflowRunStore.open(path, { fsync: false })
  assert.equal(recovered.recoveredFromTornWrite, true)
  assert.equal((await recovered.get('run-a'))?.status, 'queued')
  assert.ok((await readFile(path, 'utf8')).endsWith('\n'), 'journal was rewritten without the torn line')

  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  await writeFile(path, `${lines[0]}\nnot json\n${lines.slice(1).join('\n')}\n`)
  await assert.rejects(FileWorkflowRunStore.open(path, { fsync: false }), /corrupt at line 2/)
})

test('FileStore: compaction preserves state and a rejected write never reaches the journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-runs-'))
  const path = join(dir, 'runs.jsonl')
  const store = await FileWorkflowRunStore.open(path, { fsync: false })
  const queue = new WorkflowRunQueue({ store, newRunId: () => `run-${Math.random().toString(36).slice(2)}` })
  const first = await queue.enqueue({ graph: agentGraph(), input: 1, tenantId: 't', idempotencyKey: 'same' })
  assert.ok(first.accepted)
  const run = first.accepted ? first.run : undefined
  await assert.rejects(store.insert({ ...run!, runId: 'dupe' }), /idempotency key/)
  await assert.rejects(store.compareAndSet({ ...run!, revision: 2, tenantId: 'x' }, 1), /immutable/)
  await queue.claim('w')
  await store.compact()
  const reopened = await FileWorkflowRunStore.open(path, { fsync: false })
  assert.equal((await reopened.get(run!.runId))?.status, 'running')
  assert.equal((await reopened.get('dupe')), undefined)
  assert.equal((await reopened.events(run!.runId)).length, 2)
})
