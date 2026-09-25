import { createHash, randomUUID } from 'node:crypto'

import { validateWorkflowGraph, type WorkflowGraph } from '../workflows/graph.ts'
import { AccessDeniedError, isPrincipal, type AccessController, type Permission, type Principal } from '../identity/rbac.ts'
import type { WorkflowExecutionResult } from '../workflows/runtime.ts'
import {
  TERMINAL_RUN_STATUSES,
  type WorkflowRunEventType,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowRunStore,
  type WorkflowRunTrigger,
} from './store.ts'

export interface WorkflowRunQueueOptions {
  store: WorkflowRunStore
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number
  newRunId?: () => string
  /** Backpressure: reject new runs once this many are queued (default 1,000). */
  maxQueued?: number
  /** Per-tenant backpressure (default 100). */
  maxQueuedPerTenant?: number
  /** Per-tenant concurrent running runs (default 4). */
  maxRunningPerTenant?: number
  /** Default attempts per run when a request does not specify one (1–10, default 3). */
  defaultMaxAttempts?: number
  /** Exponential backoff base and cap (defaults 1 s and 60 s). */
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  /** Worker lease length (default 5 minutes). A worker must heartbeat before it expires. */
  leaseMs?: number
  /** Maximum serialized input size in bytes (default 256 KiB). */
  maxInputBytes?: number
  /**
   * When set, every enqueue, cancel, and redrive must carry an authenticated
   * `Principal` authorized for the run's tenant. Bare actor strings are refused.
   */
  access?: AccessController
}

export interface EnqueueWorkflowRunRequest {
  graph: WorkflowGraph
  input: unknown
  tenantId: string
  trigger?: WorkflowRunTrigger
  priority?: number
  idempotencyKey?: string
  maxAttempts?: number
  /** Delay the first attempt (e.g. a scheduled run). */
  delayMs?: number
  /** Authenticated caller. Required when the queue has an access controller. */
  principal?: Principal
}

export type EnqueueResult =
  | { accepted: true; deduplicated: boolean; run: WorkflowRunRecord }
  | { accepted: false; code: 'invalid-request' | 'invalid-graph' | 'backpressure' | 'forbidden'; reasons: string[] }

export interface WorkflowQueueStats {
  byStatus: Record<WorkflowRunStatus, number>
  byTenant: Record<string, Partial<Record<WorkflowRunStatus, number>>>
}

const TENANT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/
const TRIGGERS = new Set(['manual', 'api', 'webhook', 'schedule', 'event'])

/**
 * Durable, governed workflow run queue.
 *
 * Safety rules enforced here, not by callers:
 * - graphs are validated at admission and frozen into the run record;
 * - `blocked` is a governance outcome and is never retried;
 * - a run is retried only if no tool step was dispatched — tool calls are
 *   never repeated automatically, so those failures go to the dead-letter queue;
 * - a lost worker lease on a graph with tool steps is dead-lettered for review
 *   because the tool may already have run;
 * - redriving a dead letter requires a named actor and is recorded.
 */
export class WorkflowRunQueue {
  readonly store: WorkflowRunStore
  readonly access?: AccessController
  private claimChain: Promise<void> = Promise.resolve()
  readonly leaseMs: number
  private readonly now: () => number
  private readonly newRunId: () => string
  private readonly maxQueued: number
  private readonly maxQueuedPerTenant: number
  private readonly maxRunningPerTenant: number
  private readonly defaultMaxAttempts: number
  private readonly retryBaseDelayMs: number
  private readonly retryMaxDelayMs: number
  private readonly maxInputBytes: number

  constructor(options: WorkflowRunQueueOptions) {
    this.store = options.store
    this.access = options.access
    this.now = options.now ?? Date.now
    this.newRunId = options.newRunId ?? (() => `run_${randomUUID()}`)
    this.maxQueued = positiveInt(options.maxQueued, 1_000, 'maxQueued')
    this.maxQueuedPerTenant = positiveInt(options.maxQueuedPerTenant, 100, 'maxQueuedPerTenant')
    this.maxRunningPerTenant = positiveInt(options.maxRunningPerTenant, 4, 'maxRunningPerTenant')
    this.defaultMaxAttempts = boundedAttempts(options.defaultMaxAttempts ?? 3)
    this.retryBaseDelayMs = positiveInt(options.retryBaseDelayMs, 1_000, 'retryBaseDelayMs')
    this.retryMaxDelayMs = positiveInt(options.retryMaxDelayMs, 60_000, 'retryMaxDelayMs')
    this.leaseMs = positiveInt(options.leaseMs, 300_000, 'leaseMs')
    this.maxInputBytes = positiveInt(options.maxInputBytes, 262_144, 'maxInputBytes')
  }

  async enqueue(request: EnqueueWorkflowRunRequest): Promise<EnqueueResult> {
    const reasons = this.validateRequest(request)
    if (reasons.length) return { accepted: false, code: 'invalid-request', reasons }
    if (request.principal !== undefined && !isPrincipal(request.principal)) {
      return { accepted: false, code: 'invalid-request', reasons: ['principal is malformed.'] }
    }
    if (this.access) {
      const decision = this.access.authorize(request.principal, 'run:enqueue', { tenantId: request.tenantId, kind: 'workflow-run', id: request.graph.id })
      if (!decision.allowed) return { accepted: false, code: 'forbidden', reasons: decision.reasons }
    }

    if (request.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(request.tenantId, request.idempotencyKey)
      if (existing) {
        const digest = graphDigest(request.graph)
        if (existing.graphDigest !== digest || canonicalJson(existing.input) !== canonicalJson(request.input)) {
          return { accepted: false, code: 'invalid-request', reasons: ['Idempotency key was already used for a different workflow graph or input.'] }
        }
        return { accepted: true, deduplicated: true, run: existing }
      }
    }

    const validation = validateWorkflowGraph(request.graph)
    if (!validation.valid) return { accepted: false, code: 'invalid-graph', reasons: validation.errors }

    const queued = await this.store.list({ status: 'queued' })
    if (queued.length >= this.maxQueued) {
      return { accepted: false, code: 'backpressure', reasons: [`Queue is full (${this.maxQueued} queued runs). Retry later.`] }
    }
    if (queued.filter((run) => run.tenantId === request.tenantId).length >= this.maxQueuedPerTenant) {
      return { accepted: false, code: 'backpressure', reasons: [`Tenant queue is full (${this.maxQueuedPerTenant} queued runs). Retry later.`] }
    }

    const now = this.now()
    const graph = deepFreeze(structuredClone(request.graph))
    const run: WorkflowRunRecord = {
      contractVersion: 1,
      runId: this.newRunId(),
      revision: 1,
      tenantId: request.tenantId,
      workflowId: graph.id,
      workflowVersion: graph.version,
      graphDigest: graphDigest(graph),
      graph,
      input: structuredClone(request.input),
      trigger: request.trigger ?? { kind: 'manual' },
      priority: request.priority ?? 5,
      status: 'queued',
      attempt: 0,
      maxAttempts: request.maxAttempts ?? this.defaultMaxAttempts,
      availableAt: now + (request.delayMs ?? 0),
      createdAt: now,
      updatedAt: now,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.principal ? { requestedBy: request.principal.id } : {}),
    }
    try {
      await this.store.insert(run)
    } catch (error) {
      // Lost an idempotency race: return the winner instead of a duplicate run.
      if (request.idempotencyKey) {
        const winner = await this.store.findByIdempotencyKey(request.tenantId, request.idempotencyKey)
        if (winner) return { accepted: true, deduplicated: true, run: winner }
      }
      throw error
    }
    await this.event(run.runId, 'queued', { ...(run.requestedBy ? { actor: run.requestedBy } : {}), detail: `trigger=${run.trigger.kind}${run.trigger.source ? `:${run.trigger.source}` : ''}` })
    return { accepted: true, deduplicated: false, run }
  }

  /**
   * Claim the next eligible run for a worker: highest priority, then earliest
   * availability, then oldest. Tenants at their running limit are skipped.
   */
  async claim(workerId: string): Promise<WorkflowRunRecord | undefined> {
    assertWorkerId(workerId)
    // Serialize claims from this queue instance so its per-tenant limit is exact;
    // claims from other processes are reconciled after the compare-and-set below.
    const previous = this.claimChain
    let release!: () => void
    this.claimChain = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.claimUnlocked(workerId)
    } finally {
      release()
    }
  }

  private async claimUnlocked(workerId: string): Promise<WorkflowRunRecord | undefined> {
    const now = this.now()
    const running = await this.store.list({ status: 'running' })
    const runningByTenant = countBy(running, (run) => run.tenantId)
    const candidates = (await this.store.list({ status: 'queued' }))
      .filter((run) => run.availableAt <= now && !run.cancelRequest)
      .sort((a, b) => b.priority - a.priority || a.availableAt - b.availableAt || a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))

    const fullTenants = new Set<string>()
    for (const candidate of candidates) {
      if (fullTenants.has(candidate.tenantId) || (runningByTenant.get(candidate.tenantId) ?? 0) >= this.maxRunningPerTenant) continue
      const next: WorkflowRunRecord = {
        ...candidate,
        revision: candidate.revision + 1,
        status: 'running',
        attempt: candidate.attempt + 1,
        lease: { workerId, expiresAt: now + this.leaseMs, claimedAt: now },
        updatedAt: now,
      }
      if (!(await this.store.compareAndSet(next, candidate.revision))) continue
      // Another process may have claimed for the same tenant concurrently. Keep the
      // earliest claims within the limit and hand this one back if it is over.
      const tenantRunning = (await this.store.list({ status: 'running', tenantId: candidate.tenantId }))
        .sort((a, b) => (a.lease?.claimedAt ?? a.updatedAt) - (b.lease?.claimedAt ?? b.updatedAt) || a.runId.localeCompare(b.runId))
      if (tenantRunning.findIndex((run) => run.runId === next.runId) >= this.maxRunningPerTenant) {
        const yielded: WorkflowRunRecord = { ...next, revision: next.revision + 1, status: 'queued', attempt: candidate.attempt, updatedAt: now }
        delete yielded.lease
        await this.store.compareAndSet(yielded, next.revision)
        fullTenants.add(candidate.tenantId)
        continue
      }
      await this.event(next.runId, 'claimed', { actor: workerId, detail: `attempt ${next.attempt}/${next.maxAttempts}` })
      return next
    }
    return undefined
  }

  /** Extend a lease. Returns the fresh record, or undefined if the worker no longer owns the run. */
  async heartbeat(runId: string, workerId: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.store.get(runId)
    if (!run || run.status !== 'running' || run.lease?.workerId !== workerId) return undefined
    const now = this.now()
    const next = { ...run, revision: run.revision + 1, lease: { ...run.lease, workerId, expiresAt: now + this.leaseMs }, updatedAt: now }
    return (await this.store.compareAndSet(next, run.revision)) ? next : undefined
  }

  /** Record the outcome of an attempt and decide retry / dead-letter. */
  async complete(runId: string, workerId: string, result: WorkflowExecutionResult): Promise<WorkflowRunRecord> {
    const run = await this.store.get(runId)
    if (!run) throw new Error(`Unknown workflow run "${runId}".`)
    if (run.status !== 'running' || run.lease?.workerId !== workerId) {
      throw new Error(`Worker "${workerId}" does not hold the lease for run "${runId}".`)
    }
    const now = this.now()
    const base = { ...run, revision: run.revision + 1, updatedAt: now, result: structuredClone(result) }
    delete base.lease
    let next: WorkflowRunRecord
    let event: WorkflowRunEventType
    let detail: string | undefined

    if (result.status === 'completed') {
      next = { ...base, status: 'completed' }
      delete next.lastError
      event = 'completed'
    } else if (result.status === 'blocked') {
      next = { ...base, status: 'blocked', lastError: result.error ?? 'Workflow was blocked by governance.' }
      event = 'blocked'
      detail = next.lastError
    } else if (result.status === 'cancelled' || run.cancelRequest) {
      next = { ...base, status: 'cancelled', lastError: result.error ?? run.cancelRequest?.reason ?? 'Cancelled.' }
      event = 'cancelled'
      detail = next.lastError
    } else {
      const error = result.error ?? 'Workflow step failed.'
      const dispatchedTools = dispatchedToolSteps(run.graph, result)
      if (dispatchedTools.length > 0) {
        next = { ...base, status: 'dead-lettered', lastError: error, deadLetter: { at: now, reason: `Not retried: tool step(s) ${dispatchedTools.join(', ')} were dispatched and tools are never repeated automatically.` } }
        event = 'dead-lettered'
        detail = next.deadLetter!.reason
      } else if (run.attempt >= run.maxAttempts) {
        next = { ...base, status: 'dead-lettered', lastError: error, deadLetter: { at: now, reason: `Exhausted ${run.maxAttempts} attempt(s): ${error}` } }
        event = 'dead-lettered'
        detail = next.deadLetter!.reason
      } else {
        const delay = Math.max(this.backoff(run.attempt), retryAfter(result))
        next = { ...base, status: 'queued', lastError: error, availableAt: now + delay }
        event = 'retry-scheduled'
        detail = `attempt ${run.attempt} failed; retry in ${delay} ms: ${error}`
      }
    }

    if (!(await this.store.compareAndSet(next, run.revision))) {
      throw new Error(`Run "${runId}" changed while its outcome was being recorded; outcome not applied.`)
    }
    await this.event(runId, event, { actor: workerId, ...(detail ? { detail } : {}) })
    return next
  }

  /**
   * Request cancellation. A queued run is cancelled immediately; a running run
   * is flagged and its worker aborts at the next heartbeat.
   */
  async cancel(runId: string, actorOrPrincipal: string | Principal, reason = 'Cancelled by request.'): Promise<WorkflowRunRecord | undefined> {
    const actor = this.actorId(actorOrPrincipal)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await this.store.get(runId)
      if (!run) return run
      if (attempt === 0) await this.authorizeRunAction(run, actorOrPrincipal, 'run:cancel')
      if (TERMINAL_RUN_STATUSES.includes(run.status)) return run
      const now = this.now()
      const cancelRequest = { actor, reason, at: now }
      const next: WorkflowRunRecord = run.status === 'queued'
        ? { ...run, revision: run.revision + 1, status: 'cancelled', cancelRequest, lastError: reason, updatedAt: now }
        : { ...run, revision: run.revision + 1, cancelRequest, updatedAt: now }
      if (await this.store.compareAndSet(next, run.revision)) {
        await this.event(runId, next.status === 'cancelled' ? 'cancelled' : 'cancel-requested', { actor, detail: reason })
        return next
      }
    }
    throw new Error(`Could not cancel run "${runId}" due to concurrent updates.`)
  }

  /** Requeue or dead-letter runs whose worker stopped heartbeating. */
  async recoverExpiredLeases(): Promise<WorkflowRunRecord[]> {
    const now = this.now()
    const recovered: WorkflowRunRecord[] = []
    for (const run of await this.store.list({ status: 'running' })) {
      if (!run.lease || run.lease.expiresAt > now) continue
      const base = { ...run, revision: run.revision + 1, updatedAt: now, lastError: `Worker "${run.lease.workerId}" lease expired.` }
      delete base.lease
      const toolNodes = run.graph.nodes.filter((node) => node.kind === 'tool').map((node) => node.id)
      let next: WorkflowRunRecord
      if (run.cancelRequest) next = { ...base, status: 'cancelled' }
      else if (toolNodes.length > 0) next = { ...base, status: 'dead-lettered', deadLetter: { at: now, reason: `Worker lost its lease; tool step(s) ${toolNodes.join(', ')} may have run. Manual review required.` } }
      else if (run.attempt >= run.maxAttempts) next = { ...base, status: 'dead-lettered', deadLetter: { at: now, reason: `Worker lost its lease on the final attempt (${run.attempt}/${run.maxAttempts}).` } }
      else next = { ...base, status: 'queued', availableAt: now + this.backoff(run.attempt) }
      if (await this.store.compareAndSet(next, run.revision)) {
        await this.event(run.runId, 'lease-expired', { detail: base.lastError })
        if (next.status === 'dead-lettered') await this.event(run.runId, 'dead-lettered', { detail: next.deadLetter!.reason })
        if (next.status === 'cancelled') await this.event(run.runId, 'cancelled', { detail: run.cancelRequest!.reason })
        if (next.status === 'queued') await this.event(run.runId, 'retry-scheduled', { detail: `requeued after lease expiry; available at ${next.availableAt}` })
        recovered.push(next)
      }
    }
    return recovered
  }

  /** Manually return a dead-lettered run to the queue with a fresh attempt budget. */
  async redrive(runId: string, actorOrPrincipal: string | Principal, reason: string): Promise<WorkflowRunRecord> {
    const actor = this.actorId(actorOrPrincipal)
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('A redrive reason is required for the audit trail.')
    const run = await this.store.get(runId)
    if (!run) throw new Error(`Unknown workflow run "${runId}".`)
    await this.authorizeRunAction(run, actorOrPrincipal, 'run:redrive')
    if (run.status !== 'dead-lettered') throw new Error(`Only dead-lettered runs can be redriven (run is ${run.status}).`)
    const now = this.now()
    const next: WorkflowRunRecord = { ...run, revision: run.revision + 1, status: 'queued', attempt: 0, availableAt: now, updatedAt: now }
    delete next.deadLetter
    delete next.result
    if (!(await this.store.compareAndSet(next, run.revision))) throw new Error(`Run "${runId}" changed during redrive; try again.`)
    await this.event(runId, 'redriven', { actor, detail: reason })
    return next
  }

  async get(runId: string): Promise<WorkflowRunRecord | undefined> {
    return this.store.get(runId)
  }

  async deadLetters(tenantId?: string): Promise<WorkflowRunRecord[]> {
    return this.store.list({ status: 'dead-lettered', ...(tenantId ? { tenantId } : {}) })
  }

  async stats(): Promise<WorkflowQueueStats> {
    const byStatus = Object.fromEntries(['queued', 'running', 'completed', 'blocked', 'cancelled', 'dead-lettered'].map((s) => [s, 0])) as Record<WorkflowRunStatus, number>
    const byTenant: WorkflowQueueStats['byTenant'] = {}
    for (const run of await this.store.list()) {
      byStatus[run.status] += 1
      const tenant = (byTenant[run.tenantId] ??= {})
      tenant[run.status] = (tenant[run.status] ?? 0) + 1
    }
    return { byStatus, byTenant }
  }

  /** Deterministic exponential backoff for the given completed attempt number (1-based). */
  backoff(attempt: number): number {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1))
  }

  /** Resolve the audit actor; with access control on, only a real principal is accepted. */
  private actorId(actorOrPrincipal: string | Principal): string {
    if (typeof actorOrPrincipal === 'string') {
      if (this.access) throw new Error('This queue requires an authenticated principal, not an actor name.')
      assertActor(actorOrPrincipal)
      return actorOrPrincipal
    }
    if (!isPrincipal(actorOrPrincipal)) throw new Error('A valid principal is required.')
    return actorOrPrincipal.id
  }

  private async authorizeRunAction(run: WorkflowRunRecord, actorOrPrincipal: string | Principal, permission: Permission): Promise<void> {
    if (!this.access) return
    const principal = typeof actorOrPrincipal === 'string' ? undefined : actorOrPrincipal
    const decision = this.access.authorize(principal, permission, { tenantId: run.tenantId, id: run.runId, kind: 'workflow-run', ...(run.requestedBy ? { requestedBy: run.requestedBy } : {}) })
    if (!decision.allowed) {
      await this.event(run.runId, 'access-denied', { actor: decision.principalId, detail: `${permission}: ${decision.reasons.join(' ')}` })
      throw new AccessDeniedError(decision)
    }
  }

  private async event(runId: string, type: WorkflowRunEventType, extra: { actor?: string; detail?: string } = {}) {
    return this.store.appendEvent({ runId, at: this.now(), type, ...extra })
  }

  private validateRequest(request: EnqueueWorkflowRunRequest): string[] {
    const reasons: string[] = []
    if (!request || typeof request !== 'object') return ['Enqueue request must be an object.']
    if (typeof request.tenantId !== 'string' || !TENANT_PATTERN.test(request.tenantId)) reasons.push('tenantId is required and must be a stable identifier.')
    if (request.priority !== undefined && (!Number.isInteger(request.priority) || request.priority < 0 || request.priority > 9)) reasons.push('priority must be an integer from 0 to 9.')
    if (request.maxAttempts !== undefined && (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 10)) reasons.push('maxAttempts must be an integer from 1 to 10.')
    if (request.delayMs !== undefined && (!Number.isInteger(request.delayMs) || request.delayMs < 0 || request.delayMs > 31_536_000_000)) reasons.push('delayMs must be a non-negative integer no greater than one year.')
    if (request.idempotencyKey !== undefined && (typeof request.idempotencyKey !== 'string' || !KEY_PATTERN.test(request.idempotencyKey))) reasons.push('idempotencyKey must be 1–200 printable ASCII characters.')
    if (request.trigger !== undefined) {
      if (!TRIGGERS.has(request.trigger?.kind)) reasons.push('trigger.kind must be manual, api, webhook, schedule, or event.')
      if (request.trigger?.source !== undefined && (typeof request.trigger.source !== 'string' || request.trigger.source.length > 200)) reasons.push('trigger.source must be a string of at most 200 characters.')
    }
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(request.input)
    } catch {
      reasons.push('input must be JSON-serializable.')
    }
    if (request.input === undefined) reasons.push('input is required (use null for none).')
    else if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > this.maxInputBytes) reasons.push(`input exceeds ${this.maxInputBytes} bytes.`)
    if (!request.graph || typeof request.graph !== 'object') reasons.push('graph is required.')
    return reasons
  }
}

/** Tool nodes that reached dispatch (or may have) during an attempt. */
export function dispatchedToolSteps(graph: WorkflowGraph, result: WorkflowExecutionResult): string[] {
  const tools = new Set(graph.nodes.filter((node) => node.kind === 'tool').map((node) => node.id))
  return result.steps.filter((step) => tools.has(step.nodeId) && (step.status === 'completed' || step.status === 'failed')).map((step) => step.nodeId)
}

/** SHA-256 over canonical (key-sorted) JSON of the graph. */
export function graphDigest(graph: WorkflowGraph): string {
  return `sha256:${createHash('sha256').update(canonicalJson(graph)).digest('hex')}`
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }) ?? 'null'
}

function retryAfter(result: WorkflowExecutionResult): number {
  return Math.max(0, ...result.steps.map((step) => step.retryAfterMs ?? 0))
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  return value
}

function boundedAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error('defaultMaxAttempts must be an integer from 1 to 10.')
  return value
}

function assertWorkerId(workerId: string) {
  if (typeof workerId !== 'string' || !TENANT_PATTERN.test(workerId)) throw new Error('workerId must be a stable identifier.')
}

function assertActor(actor: string) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) throw new Error('A named actor is required for the audit trail.')
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}
