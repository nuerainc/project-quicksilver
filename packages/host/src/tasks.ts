/**
 * The governed task interface (M7 part 4): ONE intake path for every task.
 *
 * Other tools hand tasks to Quicksilver through several channels: the HTTP
 * API, the MCP server (Claude and other MCP clients), signed webhooks and the
 * CLI. Every channel calls `TaskService.submit()`, and nothing else creates a
 * task. The channel only says who is asking (its principal); it never grants
 * anything, and the task's text is untrusted data that is recorded and shown,
 * never obeyed.
 *
 * submit() in order:
 *   1. authenticated principal with `task:submit` (RBAC), else nothing is stored
 *   2. the per-principal rate limit (token bucket)
 *   3. field and size validation
 *   4. idempotency: the same principal + idempotencyKey returns the existing task
 *   5. the task is stored as `received`
 *   6. boundaries (task-boundaries.ts): AMP patent material, frozen projects → `refused`
 *   7. a ProposedAction built from the capability catalog (risk inputs come from
 *      the catalog, never from the text) and the normal kernel authorize():
 *      capability graph, policies, risk, separation of duties
 *        reject             → `refused` with the kernel's reasons
 *        request-approval   → `awaiting-approval` (a human decides; the submitter never counts)
 *        execute-autonomously → `queued`
 *   8. execution only when the department's effective autonomy (operate's
 *      departmentAutonomy) is `act-within-limits` AND the kernel said
 *      execute-autonomously, or after a human approves a request-approval
 *      task while the department's effective autonomy (re-read at approval)
 *      is `act-with-approval` or higher. An approval is bound to hashes of the
 *      stored request and decision; if either changed, the task does not run. Then the capability's configured host workflow is
 *      enqueued on the existing durable run queue; with no workflow it is queued
 *      for a human. Otherwise the task stays a recommendation, logged to the
 *      department's shadow log so it feeds Aura and the hand-over evidence.
 *
 * The store is append-only: a task's identity and request never change, its
 * audit trail only grows, and every state change appends an audit entry.
 */
import { TokenBucketLimiter, type RateLimitConfig } from '@quicksilver/kernel/rate-limit'
import { createHash, randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { authorize, scopeIncludes, type AuthorizeArgs, type AuthorizeResult, type CapabilityRef, type PolicyRef, type ProposedAction, type RiskLevel } from '@quicksilver/kernel'
import { checkSeparationOfDuties, type AccessController, type Permission, type Principal } from '@quicksilver/kernel/identity'
import type { DepartmentAutonomy } from '@quicksilver/kernel/playbooks/operate'
import { recommend } from '@quicksilver/kernel/playbooks/shadow'
import { newVerdictLearner, predictAccept } from '@quicksilver/aura'

import { checkTaskBoundaries, DEFAULT_TASK_BOUNDARIES, type BoundaryCheck, type TaskBoundaryConfig } from './task-boundaries.ts'
import { readJson, writeJsonAtomic } from './operate-store.ts'
import { withShadowLock, type ShadowStore } from './shadow-api.ts'

// ── Types ─────────────────────────────────────────────────────────────────

export const TASK_SOURCES = ['api', 'mcp', 'webhook', 'cli'] as const
export type TaskSource = (typeof TASK_SOURCES)[number]
export const TASK_STATUSES = ['received', 'refused', 'awaiting-approval', 'queued', 'running', 'done', 'failed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
const TERMINAL: readonly TaskStatus[] = ['refused', 'done', 'failed', 'cancelled']

export interface TaskAuditEntry {
  seq: number
  at: string
  /** Principal id, or `quicksilver` for the intake itself. */
  by: string
  event: string
  from?: TaskStatus
  to: TaskStatus
  note?: string
}

export interface TaskDecision {
  /** What the intake did: refused, sent to a human, ran it, or logged it as a recommendation. */
  route: 'refused' | 'approval' | 'execute' | 'recommend'
  reasons: string[]
  boundary: BoundaryCheck
  /** The action the kernel judged. Null when a boundary refused first. */
  action: ProposedAction | null
  /** The kernel's decision record (authorize()). Null when a boundary refused first. */
  kernel: AuthorizeResult | null
  /** The department's autonomy when the kernel allowed the task. */
  autonomy: DepartmentAutonomy | null
}

export interface TaskExecution {
  mode: 'workflow' | 'human' | 'recommendation'
  note: string
  workflow?: string
  runId?: string
}

/** A human's decision on an awaiting-approval task. An approval is bound to the exact request and decision it approved. */
export interface TaskApproval {
  decision: 'approved' | 'denied'
  by: string
  at: string
  reason?: string
  soleOperatorOverride: boolean
  /** sha256 of the stored request (id, source, submitter, time, objective, capability, department, inputs, key) when approved. */
  requestHash?: string
  /** sha256 of the kernel decision record when approved. */
  decisionHash?: string
  /** The department's effective autonomy, re-read when approved. */
  autonomy?: DepartmentAutonomy
}

export interface Task {
  id: string
  /** Tenant partition key; immutable for the task's lifetime. */
  tenantId: string
  source: TaskSource
  /** Principal id of whoever submitted it. */
  submittedBy: string
  submittedAt: string
  objective: string
  capabilityId?: string
  department?: string
  inputs?: Record<string, unknown>
  idempotencyKey?: string
  status: TaskStatus
  decision: TaskDecision | null
  execution?: TaskExecution
  approval?: TaskApproval
  shadow?: { intentId: string; recommendationId: string }
  result?: unknown
  audit: TaskAuditEntry[]
  /** Optimistic concurrency: bumped on every write. */
  revision: number
}

/** A capability a client may request. Its risk inputs are fixed here, never taken from the request. */
export interface TaskCapability {
  id: string
  name: string
  /** Plain description shown to clients. */
  description: string
  department: string
  baseRiskLevel: RiskLevel
  policyScopes?: string[]
  inherits?: string[]
  requires?: string[]
  conflictsWith?: string[]
  riskMultiplier?: number
  /** Defaults: not reversible, impact 2, uncertainty 2 (conservative). */
  reversible?: boolean
  operationalImpact?: RiskLevel
  uncertainty?: RiskLevel
  financialExposure?: number
  customerFacing?: boolean
  /** A configured host workflow that carries the task out (read-only on the host at this version). */
  workflow?: string
}

export interface TaskCatalog {
  /** Used when a task names no capability: a request for a human to triage. */
  defaultCapabilityId: string
  /** Confidence given to the request itself as the action's only evidence (default 0.6). */
  requestConfidence?: number
  capabilities: TaskCapability[]
  policies?: PolicyRef[]
}

export interface TaskRunBackend {
  enqueue(request: { workflow: string; input: unknown; idempotencyKey: string }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>
  get(runId: string): Promise<{ status: string; result?: unknown; lastError?: string } | undefined>
  cancel(runId: string, reason: string): Promise<{ status: string } | undefined>
}

export interface TaskStore {
  get(id: string, tenantId?: string): Promise<Task | undefined>
  list(tenantId?: string): Promise<Task[]>
  /** Write a task. `expectedRevision` null = create. Throws TaskConflictError on a lost race or a non-append change. */
  put(task: Task, expectedRevision: number | null): Promise<void>
}

export interface SubmitTaskInput {
  source: TaskSource
  principal: Principal | undefined
  objective: unknown
  capabilityId?: unknown
  department?: unknown
  inputs?: unknown
  idempotencyKey?: unknown
}

export class TaskError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSeconds?: number
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'TaskError'
    this.status = status
    this.code = code
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds
  }
}

export class TaskConflictError extends TaskError {
  constructor(message: string) { super(409, 'conflict', message); this.name = 'TaskConflictError' }
}

// ── Limits and validation ─────────────────────────────────────────────────

export const TASK_LIMITS = Object.freeze({ objectiveChars: 2_000, inputsBytes: 8_192, inputsDepth: 6, idempotencyKeyChars: 300 })
const TASK_ID = /^task-[0-9a-f]{20}$/
const TASK_TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const CAPABILITY_ID = /^[a-zA-Z][a-zA-Z0-9._:-]{0,127}$/
const DEPARTMENT = /^[a-z][a-z0-9-]{0,39}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,300}$/

function depth(value: unknown, d = 0): number {
  if (!value || typeof value !== 'object') return d
  let max = d + 1
  for (const v of Object.values(value)) max = Math.max(max, depth(v, d + 1))
  return max
}

interface ValidTask { objective: string; capabilityId?: string; department?: string; inputs?: Record<string, unknown>; idempotencyKey?: string }

export function validateTaskFields(input: Pick<SubmitTaskInput, 'objective' | 'capabilityId' | 'department' | 'inputs' | 'idempotencyKey'>): { ok: true; value: ValidTask } | { ok: false; error: string } {
  const { objective, capabilityId, department, inputs, idempotencyKey } = input
  if (typeof objective !== 'string' || !objective.trim()) return { ok: false, error: 'objective is required: plain text describing the task.' }
  const text = objective.trim()
  if (text.length > TASK_LIMITS.objectiveChars) return { ok: false, error: `objective must be at most ${TASK_LIMITS.objectiveChars} characters.` }
  // Control characters other than newline and tab are refused (they only hide text from a reader).
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(text)) return { ok: false, error: 'objective contains control or bidirectional-override characters.' }
  if (capabilityId !== undefined && capabilityId !== null && (typeof capabilityId !== 'string' || !CAPABILITY_ID.test(capabilityId))) return { ok: false, error: 'capabilityId must be a capability id (letters, digits, . _ : -), up to 128 characters. See describe_capabilities.' }
  if (department !== undefined && department !== null && (typeof department !== 'string' || !DEPARTMENT.test(department))) return { ok: false, error: 'department must be lowercase letters, digits and "-", up to 40 characters.' }
  if (idempotencyKey !== undefined && idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey))) return { ok: false, error: 'idempotencyKey must be 1 to 300 printable characters without spaces.' }
  if (inputs !== undefined && inputs !== null) {
    if (typeof inputs !== 'object' || Array.isArray(inputs)) return { ok: false, error: 'inputs must be a small JSON object.' }
    let size: number
    try { size = Buffer.byteLength(JSON.stringify(inputs), 'utf8') } catch { return { ok: false, error: 'inputs must be plain JSON.' } }
    if (size > TASK_LIMITS.inputsBytes) return { ok: false, error: `inputs must be at most ${TASK_LIMITS.inputsBytes} bytes of JSON.` }
    if (depth(inputs) > TASK_LIMITS.inputsDepth) return { ok: false, error: `inputs may nest at most ${TASK_LIMITS.inputsDepth} levels.` }
  }
  return {
    ok: true,
    value: {
      objective: text,
      ...(typeof capabilityId === 'string' ? { capabilityId } : {}),
      ...(typeof department === 'string' ? { department } : {}),
      ...(inputs && typeof inputs === 'object' ? { inputs: JSON.parse(JSON.stringify(inputs)) as Record<string, unknown> } : {}),
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    },
  }
}

export function validateCatalog(catalog: TaskCatalog): string[] {
  const errors: string[] = []
  if (!catalog || !Array.isArray(catalog.capabilities)) return ['The task catalog needs a capabilities list.']
  const ids = new Set<string>()
  for (const c of catalog.capabilities) {
    if (typeof c?.id !== 'string' || !CAPABILITY_ID.test(c.id)) { errors.push(`Capability id "${String(c?.id)}" is invalid.`); continue }
    if (ids.has(c.id)) errors.push(`Capability "${c.id}" is listed twice.`)
    ids.add(c.id)
    if (typeof c.name !== 'string' || !c.name) errors.push(`Capability "${c.id}" needs a name.`)
    if (typeof c.description !== 'string' || !c.description) errors.push(`Capability "${c.id}" needs a plain description.`)
    if (typeof c.department !== 'string' || !DEPARTMENT.test(c.department)) errors.push(`Capability "${c.id}" needs a department (lowercase letters, digits, -).`)
    if (!Number.isInteger(c.baseRiskLevel) || c.baseRiskLevel < 0 || c.baseRiskLevel > 5) errors.push(`Capability "${c.id}": baseRiskLevel must be 0–5.`)
    for (const k of ['operationalImpact', 'uncertainty'] as const) if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k]! < 0 || c[k]! > 5)) errors.push(`Capability "${c.id}": ${k} must be 0–5.`)
  }
  if (typeof catalog.defaultCapabilityId !== 'string' || !ids.has(catalog.defaultCapabilityId)) errors.push('defaultCapabilityId must name a capability in the catalog.')
  if (catalog.requestConfidence !== undefined && (typeof catalog.requestConfidence !== 'number' || catalog.requestConfidence < 0 || catalog.requestConfidence > 1)) errors.push('requestConfidence must be 0–1.')
  return errors
}

/** Capability ids and plain descriptions a client may request. No secrets and no policy internals beyond names. */
export function describeCapabilities(catalog: TaskCatalog) {
  return catalog.capabilities.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    department: c.department,
    ...(c.id === catalog.defaultCapabilityId ? { default: true } : {}),
    policies: (catalog.policies ?? []).filter((p) => (c.policyScopes ?? []).some((s) => scopeIncludes(p.scope, s))).map((p) => p.name),
  }))
}

// ── Rate limit ────────────────────────────────────────────────────────────

// The token bucket is shared with the rest of the host and the web app
// (threat model A-5): it lives, pure, in the kernel.
export { TokenBucketLimiter, type RateLimitConfig } from '@quicksilver/kernel/rate-limit'

export const DEFAULT_TASK_RATE_LIMIT: RateLimitConfig = Object.freeze({ burst: 10, perMinute: 30 })

// ── Stores ────────────────────────────────────────────────────────────────

const IMMUTABLE: ReadonlyArray<keyof Task> = ['id', 'tenantId', 'source', 'submittedBy', 'submittedAt', 'objective', 'capabilityId', 'department', 'inputs', 'idempotencyKey']

/** The append-only rule shared by both stores. */
function checkAppendOnly(before: Task | undefined, next: Task, expectedRevision: number | null): void {
  if (!before) {
    if (expectedRevision !== null) throw new TaskConflictError(`Task ${next.id} does not exist.`)
    return
  }
  if (expectedRevision === null) throw new TaskConflictError(`Task ${next.id} already exists.`)
  if (before.revision !== expectedRevision) throw new TaskConflictError(`Task ${next.id} changed since it was read; reload and retry.`)
  if (next.revision !== before.revision + 1) throw new TaskConflictError('A task write must bump its revision by one.')
  for (const k of IMMUTABLE) if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) throw new TaskConflictError(`A task's ${k} never changes.`)
  if (next.audit.length < before.audit.length || before.audit.some((e, i) => JSON.stringify(e) !== JSON.stringify(next.audit[i]))) throw new TaskConflictError('The audit trail may only be appended to.')
  if (TERMINAL.includes(before.status) && next.status !== before.status) throw new TaskConflictError(`Task ${next.id} is ${before.status}; its status no longer changes.`)
}

// One write at a time per task id within a process.
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(key, next.catch(() => undefined))
  return next
}

/** One file per task: <dir>/<taskId>.json, written atomically (temp file + rename), mode 0600. */
export class FileTaskStore implements TaskStore {
  readonly dir: string
  constructor(dir: string) { this.dir = dir }
  private path(id: string) {
    if (!TASK_ID.test(id)) throw new TaskError(404, 'not-found', 'No such task.')
    return join(this.dir, `${id}.json`)
  }
  async get(id: string, tenantId?: string) {
    if (!TASK_ID.test(id)) return undefined
    const task = await readJson<Task | undefined>(this.path(id), undefined)
    return task && (tenantId === undefined || task.tenantId === tenantId) ? task : undefined
  }
  async list(tenantId?: string) {
    let names: string[] = []
    try { names = (await readdir(this.dir)).filter((n) => /^task-[0-9a-f]{20}\.json$/.test(n)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const tasks: Task[] = []
    for (const n of names) { const t = await readJson<Task | undefined>(join(this.dir, n), undefined); if (t && (tenantId === undefined || t.tenantId === tenantId)) tasks.push(t) }
    return tasks
  }
  async put(task: Task, expectedRevision: number | null) {
    if (!TASK_TENANT_ID.test(task.tenantId)) throw new TaskError(400, 'invalid', 'A stable tenantId is required to store a task.')
    await withLock(`${this.dir}\u0000${task.id}`, async () => {
      checkAppendOnly(await this.get(task.id), task, expectedRevision)
      await writeJsonAtomic(this.path(task.id), task)
    })
  }
}

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>()
  async get(id: string, tenantId?: string) { const t = this.tasks.get(id); return t && (tenantId === undefined || t.tenantId === tenantId) ? structuredClone(t) : undefined }
  async list(tenantId?: string) { return [...this.tasks.values()].filter((t) => tenantId === undefined || t.tenantId === tenantId).map((t) => structuredClone(t)) }
  async put(task: Task, expectedRevision: number | null) {
    if (!TASK_TENANT_ID.test(task.tenantId)) throw new TaskError(400, 'invalid', 'A stable tenantId is required to store a task.')
    checkAppendOnly(this.tasks.get(task.id), task, expectedRevision)
    this.tasks.set(task.id, structuredClone(task))
  }
}

// ── The service ───────────────────────────────────────────────────────────

export interface TaskServiceDeps {
  tenantId: string
  access: AccessController
  store: TaskStore
  catalog: TaskCatalog
  boundaries?: TaskBoundaryConfig
  /** The department's effective autonomy (operate's departmentAutonomy over the intent ledger and shadow logs). */
  autonomy: (department: string) => Promise<DepartmentAutonomy>
  /** Where recommendation-only tasks are logged (the Onboard shadow log of this intent id). */
  shadow?: { store: ShadowStore; intentId: string }
  /** The existing durable run queue. Absent (e.g. the CLI) → executable tasks are queued for a human. */
  runs?: TaskRunBackend
  rateLimit?: RateLimitConfig
  /** Configured sole operator (QUICKSILVER_SOLE_OPERATOR_ID) for the separation-of-duties override. */
  soleOperatorId?: string | null
  thresholds?: AuthorizeArgs['thresholds']
  now?: () => number
}

export interface TaskView {
  [key: string]: unknown
}

export class TaskService {
  readonly deps: TaskServiceDeps
  private readonly limiter: TokenBucketLimiter
  private readonly boundaries: TaskBoundaryConfig
  private readonly now: () => number

  constructor(deps: TaskServiceDeps) {
    const errors = validateCatalog(deps.catalog)
    if (errors.length) throw new Error(`Invalid task catalog: ${errors.join(' ')}`)
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.limiter = new TokenBucketLimiter(deps.rateLimit ?? DEFAULT_TASK_RATE_LIMIT, this.now)
    this.boundaries = deps.boundaries ?? DEFAULT_TASK_BOUNDARIES
  }

  private can(principal: Principal | undefined, permission: Permission, id?: string) {
    return this.deps.access.authorize(principal, permission, { tenantId: this.deps.tenantId, kind: 'task', ...(id ? { id } : {}) })
  }

  private requirePrincipal(principal: Principal | undefined): Principal {
    if (!principal) throw new TaskError(401, 'unauthenticated', 'A valid bearer token is required.')
    return principal
  }

  /** Whether this principal may read every task (the founder, supervisors, auditors) or only its own. */
  readScope(principal: Principal): 'all' | 'own' | 'none' {
    if (this.can(principal, 'task:read').allowed) return 'all'
    if (this.can(principal, 'task:read-own').allowed || this.can(principal, 'task:submit').allowed) return 'own'
    return 'none'
  }

  capabilities(principal: Principal | undefined) {
    const p = this.requirePrincipal(principal)
    if (this.readScope(p) === 'none') throw new TaskError(403, 'forbidden', `No role grants "task:submit" or "task:read" to "${p.id}".`)
    return describeCapabilities(this.deps.catalog)
  }

  // ── Submit: the one intake path ──

  async submit(input: SubmitTaskInput): Promise<{ task: Task; deduplicated: boolean }> {
    const principal = this.requirePrincipal(input.principal)
    if (!TASK_SOURCES.includes(input.source)) throw new TaskError(400, 'invalid', 'Unknown task source.')
    const allowed = this.can(principal, 'task:submit')
    if (!allowed.allowed) throw new TaskError(403, 'forbidden', allowed.reasons.join(' '))
    const limit = this.limiter.take(principal.id)
    if (!limit.ok) throw new TaskError(429, 'rate-limited', `Too many tasks from ${principal.id}; retry in ${limit.retryAfterSeconds} s.`, limit.retryAfterSeconds)
    const v = validateTaskFields(input)
    if (!v.ok) throw new TaskError(422, 'invalid', v.error)
    const fields = v.value

    const work = async () => {
      if (fields.idempotencyKey) {
        const existing = (await this.deps.store.list(this.deps.tenantId)).find((t) => t.tenantId === this.deps.tenantId && t.submittedBy === principal.id && t.idempotencyKey === fields.idempotencyKey)
        if (existing) {
          const same = canonical({ o: existing.objective, c: existing.capabilityId, d: existing.department, i: existing.inputs }) === canonical({ o: fields.objective, c: fields.capabilityId, d: fields.department, i: fields.inputs })
          if (!same) throw new TaskError(409, 'idempotency-conflict', 'This idempotencyKey was already used for a different task.')
          return { task: await this.refresh(existing), deduplicated: true }
        }
      }
      return { task: await this.intake(principal, input.source, fields), deduplicated: false }
    }
    return fields.idempotencyKey ? withLock(`idem\u0000${this.deps.tenantId}\u0000${principal.id}\u0000${fields.idempotencyKey}`, work) : work()
  }

  private async intake(principal: Principal, source: TaskSource, fields: ValidTask): Promise<Task> {
    const at = new Date(this.now()).toISOString()
    let task: Task = {
      id: `task-${randomBytes(10).toString('hex')}`,
      tenantId: this.deps.tenantId,
      source,
      submittedBy: principal.id,
      submittedAt: at,
      ...fields,
      status: 'received',
      decision: null,
      audit: [{ seq: 1, at, by: principal.id, event: 'received', to: 'received', note: `Submitted through ${source}.` }],
      revision: 1,
    }
    await this.deps.store.put(task, null)

    // Boundaries first: they refuse before the kernel sees anything.
    const boundary = checkTaskBoundaries(fields, this.boundaries)
    if (!boundary.passed) {
      return this.save(task, {
        status: 'refused',
        decision: { route: 'refused', reasons: boundary.reasons, boundary, action: null, kernel: null, autonomy: null },
      }, 'quicksilver', 'refused', `Boundary: ${boundary.rules.join(', ')}.`)
    }

    const catalog = this.deps.catalog
    const capabilityId = fields.capabilityId ?? catalog.defaultCapabilityId
    const capability = catalog.capabilities.find((c) => c.id === capabilityId)
    const department = capability?.department ?? fields.department ?? catalog.capabilities.find((c) => c.id === catalog.defaultCapabilityId)!.department
    if (capability && fields.department && fields.department !== capability.department) {
      const reason = `Capability "${capability.id}" belongs to the ${capability.department} department, not ${fields.department}.`
      return this.save(task, { status: 'refused', decision: { route: 'refused', reasons: [reason], boundary, action: null, kernel: null, autonomy: null } }, 'quicksilver', 'refused', reason)
    }

    // The action the kernel judges. Risk inputs come from the catalog, never from the request text.
    const actorId = `quicksilver:${department}`
    const evidenceId = `task-request:${task.id}`
    const action: ProposedAction = {
      description: `Task ${task.id} via ${source} from ${principal.id}: ${fields.objective}`.slice(0, 2_400),
      actorId,
      capabilityId,
      applicablePolicyIds: [],
      evidenceIds: [evidenceId],
      reversible: capability?.reversible ?? false,
      operationalImpact: capability?.operationalImpact ?? 2,
      uncertainty: capability?.uncertainty ?? 2,
      ...(typeof capability?.financialExposure === 'number' ? { financialExposure: capability.financialExposure } : {}),
      ...(capability?.customerFacing ? { customerFacing: true } : {}),
    }
    const capabilities: CapabilityRef[] = catalog.capabilities.map((c) => ({
      id: c.id,
      name: c.name,
      baseRiskLevel: c.baseRiskLevel,
      authorizedEntityIds: [`quicksilver:${c.department}`],
      policyScopes: c.policyScopes ?? [c.department],
      ...(c.inherits ? { inherits: c.inherits } : {}),
      ...(c.requires ? { requires: c.requires } : {}),
      ...(c.conflictsWith ? { conflictsWith: c.conflictsWith } : {}),
      ...(c.riskMultiplier !== undefined ? { riskMultiplier: c.riskMultiplier } : {}),
    }))
    const kernel = authorize({
      action,
      actor: { id: actorId, name: `Quicksilver ${department}`, entityType: 'agent', capabilityIds: catalog.capabilities.filter((c) => c.department === department).map((c) => c.id) },
      capabilities,
      policies: catalog.policies ?? [],
      evidence: [{ id: evidenceId, title: `The request from ${principal.id} (${source})`, confidence: catalog.requestConfidence ?? 0.6 }],
      // No WAES review exists at intake, so a customer-facing capability is blocked by the WAES gate.
      facts: { 'task.source': source, 'task.submitterKind': principal.kind, 'action.customerFacing': capability?.customerFacing === true },
      ...(this.deps.thresholds ? { thresholds: this.deps.thresholds } : {}),
    })

    if (kernel.recommendation === 'reject') {
      const reasons = kernel.blockingReasons.length ? kernel.blockingReasons : ['The kernel refused this task.']
      return this.save(task, { status: 'refused', decision: { route: 'refused', reasons, boundary, action, kernel, autonomy: null } }, 'quicksilver', 'refused', 'The kernel refused it.')
    }

    if (kernel.recommendation === 'request-approval') {
      task = await this.save(task, {
        status: 'awaiting-approval',
        decision: { route: 'approval', reasons: kernel.concerns.length ? kernel.concerns : [`Risk ${kernel.riskLevel} needs a human.`], boundary, action, kernel, autonomy: null },
        execution: { mode: 'recommendation', note: 'Waiting for a human to approve or deny it in the Quicksilver console or CLI. Nothing runs before then.' },
      }, 'quicksilver', 'awaiting-approval', 'The kernel asks for a human decision.')
      return this.logRecommendation(task, department, kernel)
    }

    // The kernel would let it run. It only runs if the department acts within limits.
    const autonomy = await this.deps.autonomy(department)
    const decision: TaskDecision = { route: 'recommend', reasons: [], boundary, action, kernel, autonomy }
    if (autonomy.effective !== 'act-within-limits') {
      decision.reasons = [`The ${department} department's effective autonomy is ${autonomy.effective}, so Quicksilver only recommends: nothing runs.`, ...autonomy.reasons]
      task = await this.save(task, {
        status: 'queued',
        decision,
        execution: { mode: 'recommendation', note: `Logged as a recommendation to the ${department} shadow log. It runs only once the department acts within limits.` },
      }, 'quicksilver', 'queued', 'Allowed by the kernel; recommendation only.')
      return this.logRecommendation(task, department, kernel)
    }

    decision.route = 'execute'
    decision.reasons = [`The kernel allows it without approval and ${department} acts within limits.`]
    task = await this.save(task, { status: 'queued', decision }, 'quicksilver', 'queued', 'Allowed by the kernel; the department acts within limits.')
    return this.execute(task, capability)
  }

  private async execute(task: Task, capability: TaskCapability | undefined, approval?: TaskApproval): Promise<Task> {
    if (!capability?.workflow) {
      return this.patch(task, { execution: { mode: 'human', note: 'No executor is configured for this capability: it is queued for a human to carry out.' } }, 'quicksilver', 'queued-for-human')
    }
    if (!this.deps.runs) {
      return this.patch(task, { execution: { mode: 'human', workflow: capability.workflow, note: 'No run queue is available where this task was submitted (only the running host has one): it is queued for a human.' } }, 'quicksilver', 'queued-for-human')
    }
    const enq = await this.deps.runs.enqueue({
      workflow: capability.workflow,
      idempotencyKey: `task:${task.id}`,
      input: {
        question: task.objective,
        task: { id: task.id, capabilityId: capability.id, inputs: task.inputs ?? null },
        // An approved task's run carries who approved it, when, and the hashes it was bound to.
        ...(approval ? { approval: { by: approval.by, at: approval.at, soleOperatorOverride: approval.soleOperatorOverride, ...(approval.soleOperatorOverride && approval.reason ? { justification: approval.reason } : {}), requestHash: approval.requestHash, decisionHash: approval.decisionHash } } : {}),
      },
    })
    if (!enq.ok) {
      return this.patch(task, { execution: { mode: 'human', workflow: capability.workflow, note: `The run could not be enqueued (${enq.reason}): it is queued for a human.` } }, 'quicksilver', 'queued-for-human')
    }
    return this.patch(task, { execution: { mode: 'workflow', workflow: capability.workflow, runId: enq.runId, note: `Running as workflow "${capability.workflow}" on the durable run queue.` } }, 'quicksilver', 'run-enqueued', `Run ${enq.runId}.`)
  }

  /** Log a non-running task to the department's shadow log, so it feeds Aura and the hand-over evidence. */
  private async logRecommendation(task: Task, department: string, kernel: AuthorizeResult): Promise<Task> {
    const shadow = this.deps.shadow
    if (!shadow) return task
    const recommendationId = await withShadowLock(shadow.intentId, async () => {
      const { log, learner } = await shadow.store.load(shadow.intentId)
      const draft = { department, kernel: { recommendation: kernel.recommendation, riskLevel: kernel.riskLevel } }
      const id = `rec-${log.recommendations.length + 1}`
      const r = recommend(log, {
        id,
        department,
        description: `[task ${task.id}] ${task.objective}`.slice(0, 1_000),
        proposedAt: new Date(this.now()).toISOString(),
        kernel: draft.kernel,
        source: task.submittedBy.startsWith('client:') || task.source === 'webhook' ? 'agent' : 'human',
        prediction: predictAccept(learner ?? newVerdictLearner(), draft),
      })
      if (!r.ok) throw new Error(r.reason)
      await shadow.store.save(shadow.intentId, r.log, learner)
      return id
    })
    return this.patch(task, { shadow: { intentId: shadow.intentId, recommendationId } }, 'quicksilver', 'logged-recommendation', `Shadow log ${shadow.intentId}, ${recommendationId}.`)
  }

  // ── Reads ──

  async get(principal: Principal | undefined, id: string): Promise<Task> {
    const p = this.requirePrincipal(principal)
    const scope = this.readScope(p)
    if (scope === 'none') throw new TaskError(403, 'forbidden', `No role grants "task:read" or "task:read-own" to "${p.id}".`)
    const task = await this.deps.store.get(id, this.deps.tenantId)
    // Someone else's task looks exactly like a missing one.
    if (!task || task.tenantId !== this.deps.tenantId || (scope === 'own' && task.submittedBy !== p.id)) throw new TaskError(404, 'not-found', 'No such task.')
    return this.refresh(task)
  }

  async list(principal: Principal | undefined, filter: { status?: string } = {}): Promise<Task[]> {
    const p = this.requirePrincipal(principal)
    const scope = this.readScope(p)
    if (scope === 'none') throw new TaskError(403, 'forbidden', `No role grants "task:read" or "task:read-own" to "${p.id}".`)
    if (filter.status !== undefined && !TASK_STATUSES.includes(filter.status as TaskStatus)) throw new TaskError(400, 'invalid', `status must be one of ${TASK_STATUSES.join(', ')}.`)
    const mine = (await this.deps.store.list(this.deps.tenantId)).filter((t) => t.tenantId === this.deps.tenantId && (scope === 'all' || t.submittedBy === p.id))
    const fresh = await Promise.all(mine.map((t) => this.refresh(t)))
    return fresh.filter((t) => !filter.status || t.status === filter.status).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  }

  /** Follow a task's workflow run: running, done or failed. */
  async refresh(task: Task): Promise<Task> {
    const runId = task.execution?.runId
    if (!runId || !this.deps.runs || TERMINAL.includes(task.status)) return task
    const run = await this.deps.runs.get(runId)
    if (!run) return task
    const next: TaskStatus | undefined = ({ queued: 'queued', running: 'running', completed: 'done', blocked: 'failed', 'dead-lettered': 'failed', cancelled: 'cancelled' } as Record<string, TaskStatus>)[run.status]
    if (!next || next === task.status) return task
    try {
      return await this.save(task, { status: next, ...(next === 'done' ? { result: run.result ?? null } : {}), ...(next === 'failed' && run.lastError ? { result: { error: run.lastError } } : {}) }, 'quicksilver', next, `Run ${runId} is ${run.status}.`)
    } catch (error) {
      if (error instanceof TaskConflictError) return (await this.deps.store.get(task.id, this.deps.tenantId)) ?? task
      throw error
    }
  }

  // ── Decisions (humans) ──

  async cancel(principal: Principal | undefined, id: string, reason?: unknown): Promise<Task> {
    const p = this.requirePrincipal(principal)
    const task = await this.get(p, id)
    const decider = p.kind === 'human' && this.can(p, 'task:approve', id).allowed
    if (task.submittedBy !== p.id && !decider) throw new TaskError(403, 'forbidden', 'Only the submitter or the founder may cancel a task.')
    if (!['received', 'awaiting-approval', 'queued'].includes(task.status)) throw new TaskError(409, 'conflict', `The task is ${task.status}; only a task that has not started running can be cancelled.`)
    const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : 'Cancelled on request.'
    const runId = task.execution?.runId
    if (runId && this.deps.runs) {
      const run = await this.deps.runs.get(runId)
      if (run && run.status !== 'queued') throw new TaskError(409, 'conflict', `The task's run is already ${run.status}; it can no longer be cancelled here.`)
      await this.deps.runs.cancel(runId, `Task ${id} cancelled by ${p.id}: ${note}`)
    }
    return this.save(task, { status: 'cancelled' }, p.id, 'cancelled', note)
  }

  private assertDecider(p: Principal, id: string) {
    if (p.kind !== 'human') throw new TaskError(403, 'forbidden', 'Only a human decides tasks, in the Quicksilver console or CLI.')
    const d = this.can(p, 'task:approve', id)
    if (!d.allowed) throw new TaskError(403, 'forbidden', d.reasons.join(' '))
  }

  async approve(principal: Principal | undefined, id: string, reason?: unknown): Promise<Task> {
    const p = this.requirePrincipal(principal)
    this.assertDecider(p, id)
    const task = await this.get(p, id)
    if (task.status !== 'awaiting-approval') throw new TaskError(409, 'conflict', `The task is ${task.status}; only a task awaiting approval can be approved.`)
    const justification = typeof reason === 'string' ? reason.trim().slice(0, 500) : ''
    // The submitter never counts as an approver (sole-operator override only with a written justification).
    const sod = checkSeparationOfDuties({ approverId: p.id, requestedBy: task.submittedBy, proposedBy: task.submittedBy, soleOperatorId: this.deps.soleOperatorId ?? null, justification })
    if (!sod.allowed) throw new TaskError(403, 'separation-of-duties', sod.reasons.join(' '))

    // Re-read the department's effective autonomy now, as at submit.
    const capabilityId = task.decision?.action?.capabilityId ?? task.capabilityId ?? this.deps.catalog.defaultCapabilityId
    const capability = this.deps.catalog.capabilities.find((c) => c.id === capabilityId)
    const department = capability?.department ?? task.department ?? this.deps.catalog.capabilities.find((c) => c.id === this.deps.catalog.defaultCapabilityId)!.department
    const autonomy = await this.deps.autonomy(department)
    const approval: TaskApproval = {
      decision: 'approved',
      by: p.id,
      at: new Date(this.now()).toISOString(),
      ...(justification ? { reason: justification } : {}),
      soleOperatorOverride: sod.soleOperatorOverride,
      requestHash: requestHash(task),
      decisionHash: decisionHash(task),
      autonomy,
    }
    const runsAfterApproval = task.decision?.kernel?.recommendation === 'request-approval' && APPROVED_RUN_DEPTHS.includes(autonomy.effective)
    const why = task.decision?.kernel?.recommendation !== 'request-approval'
      ? 'the kernel did not ask for approval'
      : !runsAfterApproval ? `the ${department} department's effective autonomy is ${autonomy.effective} (below act-with-approval)`
        : !capability?.workflow ? 'no executor is configured for this capability'
          : !this.deps.runs ? 'no run queue is available here (only the running host has one)' : ''
    const approved = await this.save(task, {
      status: 'queued',
      approval,
      execution: why
        ? { mode: 'human', note: `Approved by ${p.id}; queued for a human to carry out because ${why}.` }
        : { mode: 'human', note: `Approved by ${p.id}; about to run as workflow "${capability!.workflow}".` },
    }, p.id, 'approved', [justification, `Bound to request ${approval.requestHash!.slice(0, 19)} and decision ${approval.decisionHash!.slice(0, 19)}.`].filter(Boolean).join(' '))
    if (why) return approved
    return this.runApproved(approved, capability!)
  }

  /** Run an approved task, but only if the stored request and decision are exactly what was approved. */
  private async runApproved(approved: Task, capability: TaskCapability): Promise<Task> {
    const stored = await this.deps.store.get(approved.id, this.deps.tenantId)
    const approval = approved.approval!
    const problems: string[] = []
    if (!stored || requestHash(stored) !== approval.requestHash) problems.push('the request')
    if (!stored || decisionHash(stored) !== approval.decisionHash) problems.push('the decision')
    if (problems.length) {
      const note = `Not run: ${problems.join(' and ')} changed since the approval. A human must review it again.`
      try {
        return await this.save(approved, { execution: { mode: 'human', note } }, 'quicksilver', 'run-refused', note)
      } catch (error) {
        if (error instanceof TaskConflictError) throw new TaskError(409, 'conflict', note)
        throw error
      }
    }
    return this.execute(approved, capability, approval)
  }

  async deny(principal: Principal | undefined, id: string, reason?: unknown): Promise<Task> {
    const p = this.requirePrincipal(principal)
    this.assertDecider(p, id)
    const task = await this.get(p, id)
    if (task.status !== 'awaiting-approval') throw new TaskError(409, 'conflict', `The task is ${task.status}; only a task awaiting approval can be denied.`)
    const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : 'Denied.'
    return this.save(task, {
      status: 'refused',
      approval: { decision: 'denied', by: p.id, at: new Date(this.now()).toISOString(), reason: note, soleOperatorOverride: false },
      decision: task.decision ? { ...task.decision, route: 'refused', reasons: [`Denied by ${p.id}: ${note}`, ...task.decision.reasons] } : null,
    }, p.id, 'denied', note)
  }

  // ── Writes ──

  private async save(task: Task, change: Partial<Task>, by: string, event: string, note?: string): Promise<Task> {
    const at = new Date(this.now()).toISOString()
    const to = change.status ?? task.status
    const next: Task = {
      ...task,
      ...change,
      audit: [...task.audit, { seq: task.audit.length + 1, at, by, event, ...(to !== task.status ? { from: task.status } : {}), to, ...(note ? { note } : {}) }],
      revision: task.revision + 1,
    }
    await this.deps.store.put(next, task.revision)
    return next
  }

  private patch(task: Task, change: Partial<Task>, by: string, event: string, note?: string) {
    return this.save(task, change, by, event, note)
  }
}

/** Autonomy at which an approved task runs on its own (the founder's decision). */
export const APPROVED_RUN_DEPTHS: readonly string[] = ['act-with-approval', 'act-within-limits']

const sha256 = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`

/** The hash an approval binds to: the task's stored request. */
export function requestHash(task: Task): string {
  return sha256({ id: task.id, tenantId: task.tenantId, source: task.source, submittedBy: task.submittedBy, submittedAt: task.submittedAt, objective: task.objective, capabilityId: task.capabilityId, department: task.department, inputs: task.inputs, idempotencyKey: task.idempotencyKey })
}

/** The hash an approval binds to: the kernel decision record. */
export function decisionHash(task: Task): string {
  return sha256(task.decision)
}

/** What a caller sees. Readers of every task see the whole record; a client sees a summary of its own. */
export function taskView(task: Task, full: boolean): TaskView {
  const base = {
    id: task.id,
    source: task.source,
    submittedBy: task.submittedBy,
    submittedAt: task.submittedAt,
    objective: task.objective,
    ...(task.capabilityId ? { capabilityId: task.capabilityId } : {}),
    ...(task.department ? { department: task.department } : {}),
    ...(task.inputs ? { inputs: task.inputs } : {}),
    ...(task.idempotencyKey ? { idempotencyKey: task.idempotencyKey } : {}),
    status: task.status,
    ...(task.execution ? { execution: { mode: task.execution.mode, note: task.execution.note, ...(task.execution.runId ? { runId: task.execution.runId } : {}) } } : {}),
    ...(task.approval ? { approval: { decision: task.approval.decision, at: task.approval.at, ...(full ? { by: task.approval.by, soleOperatorOverride: task.approval.soleOperatorOverride, ...(task.approval.requestHash ? { requestHash: task.approval.requestHash, decisionHash: task.approval.decisionHash } : {}), ...(task.approval.autonomy ? { autonomy: task.approval.autonomy } : {}) } : {}), ...(task.approval.reason ? { reason: task.approval.reason } : {}) } } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
  }
  if (full) return { ...base, decision: task.decision, ...(task.shadow ? { shadow: task.shadow } : {}), audit: task.audit, revision: task.revision }
  return {
    ...base,
    decision: task.decision
      ? { route: task.decision.route, reasons: task.decision.reasons, ...(task.decision.kernel ? { kernel: { recommendation: task.decision.kernel.recommendation, riskLevel: task.decision.kernel.riskLevel } } : {}), boundaryRules: task.decision.boundary.rules }
      : null,
    audit: task.audit.map((a) => ({ at: a.at, event: a.event, to: a.to })),
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}
