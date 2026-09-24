# Durable workflow runs (runtime foundation)

`@quicksilver/kernel/runtime` adds a durable run record, a governed queue, and a
worker on top of the in-process graph runner. It is the first slice of the
hosted runtime (spec §4.2). It runs in a single Node process today. Before it
can run as a shared hosted service, it still needs a multi-host database
adapter, authentication, and tenant-scoped secrets.

It is server-only: the entry point uses `node:crypto`, and the journaled store
(`@quicksilver/kernel/runtime/file-store`) uses `node:fs`. Neither is
re-exported from the kernel root, so browser bundles never include them.

## Pieces

| Module | Role |
|---|---|
| `store.ts` | `WorkflowRunRecord` v1 contract, append-only `WorkflowRunEvent` log, `WorkflowRunStore` port, `InMemoryWorkflowRunStore` |
| `file-store.ts` | `FileWorkflowRunStore`: fsync'd JSONL journal replayed on open; drops a torn final line, refuses mid-file corruption, supports atomic compaction |
| `queue.ts` | `WorkflowRunQueue`: admission, idempotency, backpressure, priority claiming, leases, retries, dead letters, cancellation, redrive, stats |
| `worker.ts` | `WorkflowRunWorker`: claims runs, resolves handlers per run (tenant scope), heartbeats, propagates cancellation, graceful `start()`/`stop()` |

## Run lifecycle

```
enqueue ──► queued ──claim──► running ──► completed
              ▲                 │ ├────► blocked        (governance: never retried)
              │                 │ ├────► cancelled
              └─retry-scheduled─┤ └────► dead-lettered ──redrive(actor, reason)──► queued
                (backoff)       └─lease expired──► queued | dead-lettered
```

Every transition is a compare-and-set on `revision` plus an appended event
(`queued`, `claimed`, `retry-scheduled`, `dead-lettered`, `cancel-requested`,
`cancelled`, `lease-expired`, `redriven`, …). The event log is the run's
audit trail.

## Safety rules the queue enforces

- **Admission:** the graph is validated with `validateWorkflowGraph`,
  deep-cloned, frozen, and stored with a `sha256:` digest of canonical JSON.
  Editing the workflow later does not change a queued run. Input must be
  JSON-serializable and ≤ 256 KiB by default.
- **Idempotency:** `(tenantId, idempotencyKey)` returns the existing run.
  Reusing a key with a different graph or input is rejected.
- **Backpressure:** global (`maxQueued`, default 1,000) and per-tenant
  (`maxQueuedPerTenant`, default 100) limits reject new work with
  `code: 'backpressure'`, so the queue doesn't grow without bound.
- **Fairness:** runs are claimed by priority (0–9), then availability, then
  age. `maxRunningPerTenant` (default 4) stops a single tenant from taking
  every worker.
- **`blocked` is final.** A governance stop (evaluator BLOCK, denied approval,
  missing validator) is never retried.
- **Tools are never repeated automatically.** A failed attempt in which any
  tool step reached dispatch (`completed` or `failed`) goes to the
  dead-letter queue instead of being retried. This matches the runner's rule
  that tool calls are never auto-retried.
- **Lost workers:** when a lease expires, an agent-only run is requeued. A
  run whose graph contains tool steps is dead-lettered for manual review,
  because a tool may already have run.
- **Retry timing:** exponential backoff (`retryBaseDelayMs`·2ⁿ, capped by
  `retryMaxDelayMs`). A provider retry hint (`retryAfterMs` on a thrown
  error, for example from HTTP 429) extends the delay.
- **Cancellation:** a queued run is cancelled immediately. A running run is
  flagged. Its worker sees the flag at the next heartbeat and aborts the
  run-level `AbortSignal`. The graph runner stops at the next step boundary
  and aborts the in-flight handler's signal. A cancelled attempt is never
  retried.
- **Redrive:** only dead-lettered runs can be redriven, and the call needs a
  named actor and a reason. Both are recorded in the event log. The attempt
  budget resets.

## Minimal use

```ts
import { WorkflowRunQueue, WorkflowRunWorker } from '@quicksilver/kernel/runtime'
import { FileWorkflowRunStore } from '@quicksilver/kernel/runtime/file-store'

const store = await FileWorkflowRunStore.open('.data/workflow-runs.jsonl')
const queue = new WorkflowRunQueue({ store, maxRunningPerTenant: 2 })

const admitted = await queue.enqueue({
  graph, input: { question: 'Which policies govern Line 3?' },
  tenantId: 'acme', trigger: { kind: 'webhook', source: 'erp-hook' },
  idempotencyKey: 'erp-evt-8812', priority: 7,
})

const worker = new WorkflowRunWorker({
  queue, workerId: 'worker-1', concurrency: 2,
  resolveHandlers: (run) => handlersForTenant(run.tenantId),
})
worker.start()
// …
await worker.stop()            // graceful; stop({ abort: true }) cancels in-flight runs
```

## Runner changes that support this

`executeWorkflowGraph` now accepts `options.signal`. It checks the signal
before every step and links it to each handler's signal together with the
per-handler timeout. A cancelled run returns `status: 'cancelled'`.
Cancellation stops agent retries. Failed steps carry `retryAfterMs` when the
thrown error provides one. The live read-only route passes `request.signal`,
so a client that disconnects stops its model calls. Both SDKs accept the new
`cancelled` status.

The regression suite also found and fixed a bug: with
`maxConcurrentAgents > 1`, an agent on an **unselected** condition branch could
be batched and run alongside the selected branch. The batch now includes only
activated steps. `workflows.test.ts` covers this.

## Not yet built

- A transactional multi-host store (Postgres or similar) behind the same
  `WorkflowRunStore` port. The file journal assumes a single writer process.
- Trigger adapters (webhook receiver, cron scheduler, event bus) that call
  `enqueue`. The `trigger` field and `delayMs` are the hooks for them.
- Authentication and RBAC on enqueue, cancel, and redrive. The actor strings
  are recorded, but nothing verifies them yet.
- Metrics and dashboards over `stats()` and the event log. Retention and
  compaction policy.
- Isolated execution (containers, resource limits) for untrusted tools.
