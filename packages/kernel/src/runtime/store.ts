import type { WorkflowGraph } from '../workflows/graph.ts'
import type { WorkflowExecutionResult } from '../workflows/runtime.ts'

/**
 * Durable workflow-run contract (v1).
 *
 * A run record is the single source of truth for one queued execution of a
 * versioned workflow graph. Every state change goes through a store
 * compare-and-set on `revision`, and every transition appends an event, so the
 * run history is an audit trail rather than a mutable status field.
 */

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'dead-lettered'

export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = Object.freeze(['completed', 'blocked', 'cancelled', 'dead-lettered'])

export type WorkflowTriggerKind = 'manual' | 'api' | 'webhook' | 'schedule' | 'event'

export interface WorkflowRunTrigger {
  kind: WorkflowTriggerKind
  /** Caller-supplied identifier such as a webhook id or schedule name. Never a secret. */
  source?: string
}

export interface WorkflowRunLease {
  workerId: string
  expiresAt: number
}

export interface WorkflowRunRecord {
  contractVersion: 1
  runId: string
  /** Monotonic revision used for optimistic concurrency. */
  revision: number
  tenantId: string
  workflowId: string
  workflowVersion: number
  /** SHA-256 of the canonical graph snapshot, so an audit can prove what ran. */
  graphDigest: string
  /** Frozen snapshot of the graph at enqueue time; later edits never change a queued run. */
  graph: WorkflowGraph
  input: unknown
  trigger: WorkflowRunTrigger
  /** 0–9, higher runs first. */
  priority: number
  status: WorkflowRunStatus
  /** Number of execution attempts started so far. */
  attempt: number
  maxAttempts: number
  /** Epoch ms before which the run must not be claimed (retry backoff / delayed start). */
  availableAt: number
  createdAt: number
  updatedAt: number
  idempotencyKey?: string
  /** Verified principal that enqueued the run, when an access controller is configured. */
  requestedBy?: string
  lease?: WorkflowRunLease
  cancelRequest?: { actor: string; reason: string; at: number }
  result?: WorkflowExecutionResult
  lastError?: string
  deadLetter?: { reason: string; at: number }
}

export type WorkflowRunEventType =
  | 'queued'
  | 'claimed'
  | 'heartbeat'
  | 'completed'
  | 'blocked'
  | 'retry-scheduled'
  | 'dead-lettered'
  | 'cancel-requested'
  | 'cancelled'
  | 'lease-expired'
  | 'redriven'
  | 'access-denied'

export interface WorkflowRunEvent {
  runId: string
  /** 1-based sequence within the run. */
  seq: number
  at: number
  type: WorkflowRunEventType
  actor?: string
  detail?: string
}

export interface WorkflowRunFilter {
  status?: WorkflowRunStatus | readonly WorkflowRunStatus[]
  tenantId?: string
  workflowId?: string
}

/**
 * Persistence port. Implementations must return copies (never live references)
 * and must reject a `compareAndSet` whose `expectedRevision` is stale.
 */
export interface WorkflowRunStore {
  insert(record: WorkflowRunRecord): Promise<void>
  get(runId: string): Promise<WorkflowRunRecord | undefined>
  findByIdempotencyKey(tenantId: string, key: string): Promise<WorkflowRunRecord | undefined>
  /** Replace the record iff the stored revision equals `expectedRevision`. */
  compareAndSet(next: WorkflowRunRecord, expectedRevision: number): Promise<boolean>
  list(filter?: WorkflowRunFilter): Promise<WorkflowRunRecord[]>
  appendEvent(event: Omit<WorkflowRunEvent, 'seq'>): Promise<WorkflowRunEvent>
  events(runId: string): Promise<WorkflowRunEvent[]>
}

/** Reference in-process store. Suitable for tests and single-process development. */
export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  protected readonly runs = new Map<string, WorkflowRunRecord>()
  protected readonly eventLog = new Map<string, WorkflowRunEvent[]>()
  protected readonly idempotency = new Map<string, string>()

  async insert(record: WorkflowRunRecord): Promise<void> {
    this.applyInsert(record)
  }

  async get(runId: string): Promise<WorkflowRunRecord | undefined> {
    const record = this.runs.get(runId)
    return record ? structuredClone(record) : undefined
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<WorkflowRunRecord | undefined> {
    const runId = this.idempotency.get(idempotencyIndex(tenantId, key))
    return runId ? this.get(runId) : undefined
  }

  async compareAndSet(next: WorkflowRunRecord, expectedRevision: number): Promise<boolean> {
    return this.applyCompareAndSet(next, expectedRevision)
  }

  async list(filter: WorkflowRunFilter = {}): Promise<WorkflowRunRecord[]> {
    const statuses = filter.status === undefined ? undefined : new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    return [...this.runs.values()]
      .filter((run) => (!statuses || statuses.has(run.status))
        && (filter.tenantId === undefined || run.tenantId === filter.tenantId)
        && (filter.workflowId === undefined || run.workflowId === filter.workflowId))
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))
      .map((run) => structuredClone(run))
  }

  async appendEvent(event: Omit<WorkflowRunEvent, 'seq'>): Promise<WorkflowRunEvent> {
    return this.applyEvent(event)
  }

  async events(runId: string): Promise<WorkflowRunEvent[]> {
    return structuredClone(this.eventLog.get(runId) ?? [])
  }

  // Synchronous primitives shared with journaled subclasses.

  protected applyInsert(record: WorkflowRunRecord): void {
    if (this.runs.has(record.runId)) throw new Error(`Workflow run "${record.runId}" already exists.`)
    if (record.idempotencyKey) {
      const index = idempotencyIndex(record.tenantId, record.idempotencyKey)
      if (this.idempotency.has(index)) throw new Error('A run with this idempotency key already exists for the tenant.')
      this.idempotency.set(index, record.runId)
    }
    this.runs.set(record.runId, structuredClone(record))
  }

  protected applyCompareAndSet(next: WorkflowRunRecord, expectedRevision: number): boolean {
    const current = this.runs.get(next.runId)
    if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false
    if (next.tenantId !== current.tenantId || next.idempotencyKey !== current.idempotencyKey || next.graphDigest !== current.graphDigest) {
      throw new Error('Run identity fields (tenant, idempotency key, graph digest) are immutable.')
    }
    this.runs.set(next.runId, structuredClone(next))
    return true
  }

  protected applyEvent(event: Omit<WorkflowRunEvent, 'seq'> | WorkflowRunEvent): WorkflowRunEvent {
    if (!this.runs.has(event.runId)) throw new Error(`Cannot record an event for unknown run "${event.runId}".`)
    const log = this.eventLog.get(event.runId) ?? []
    const stored: WorkflowRunEvent = { ...structuredClone(event), seq: log.length + 1 }
    log.push(stored)
    this.eventLog.set(event.runId, log)
    return structuredClone(stored)
  }
}

function idempotencyIndex(tenantId: string, key: string): string {
  return `${tenantId}\u0000${key}`
}
