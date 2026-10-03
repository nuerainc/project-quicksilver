import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { approvalDigest, type HumanApprovalBinding } from '@quicksilver/kernel'
import { issueExecutionAuthorization, type AuthorizationSigningKey } from '@quicksilver/kernel/runtime'

import { EffectfulToolExecutor, sha256, ToolRefusedError } from './tool-executor.ts'

/**
 * P-095: approved actions. An agent or person proposes one effectful tool call; a different
 * human reads exactly what it would do and approves it; only then does the kernel sign a
 * single-use authorization and the executor run it.
 *
 * What stands in the way, in order:
 *   1. The feature is off unless the host is given an action policy listing the tools it allows.
 *   2. A proposal is a record. Proposing sends, writes and changes nothing.
 *   3. It must cite at least one piece of evidence (the kernel refuses an unevidenced action).
 *   4. Approval is humans-only and never by the proposer. The approver is the authenticated
 *      principal; the request body cannot name one.
 *   5. The signed authorization is bound to this exact tool call (a digest of tool and input),
 *      this exact approval, the evidence count and the policy in force, and is used once.
 *   6. The executor re-checks all of that against values taken from the stored proposal,
 *      not from the authorization itself.
 *   7. The proposal is saved as `executing` BEFORE the adapter runs. If the host dies in
 *      between, the outcome is unknown and a human settles it with `resolve`; the call is
 *      never repeated automatically.
 *
 * The tools shipped today are dry runs (see tool-executor.ts): approving one records the
 * decision and a dry-run result, and nothing leaves the host.
 */

export const ACTION_ID = /^ap-[0-9a-f-]{36}$/
export const ACTION_STATUSES = ['pending', 'rejected', 'executing', 'executed', 'failed', 'expired'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export interface ActionPolicy {
  enabledTools: string[]
  /** How long a proposal can wait for a decision. */
  proposalTtlMs: number
  /** How long a person's approval is valid; execution happens at once, so this is a ceiling. */
  approvalTtlMs: number
  maxInputBytes: number
}

export const DEFAULT_ACTION_POLICY: Omit<ActionPolicy, 'enabledTools'> = {
  proposalTtlMs: 24 * 3_600_000,
  approvalTtlMs: 15 * 60_000,
  maxInputBytes: 16 * 1024,
}

export interface ActionProposal {
  id: string
  toolId: string
  input: Record<string, unknown>
  inputDigest: string
  reason: string
  evidence: string[]
  policySnapshot: string
  proposedBy: { id: string; kind: string }
  proposedAt: string
  expiresAt: string
  /** 'expired' is never stored: a pending proposal past its expiry is shown as expired. */
  status: ActionStatus
  decision?: { by: string; at: string; outcome: 'approved' | 'rejected'; note?: string; approvalDigest?: string; authorizationId?: string }
  result?: { at: string; auditId?: string; outputDigest?: string; dryRun?: boolean; settledBy?: string; note?: string }
  error?: string
}

export interface ActionStore {
  list(): Promise<ActionProposal[]>
  get(id: string): Promise<ActionProposal | undefined>
  put(proposal: ActionProposal): Promise<void>
}

export class MemoryActionStore implements ActionStore {
  readonly tenantId: string
  private readonly items = new Map<string, ActionProposal>()
  constructor(tenantId: string) { this.tenantId = tenantId }
  async list() { return [...this.items.values()].map((p) => structuredClone(p)) }
  async get(id: string) { const p = this.items.get(id); return p ? structuredClone(p) : undefined }
  async put(proposal: ActionProposal) { this.items.set(proposal.id, structuredClone(proposal)) }
}

/** <dir>/<tenantId>/actions/proposals.json. Callers serialize writes (the host's lock). */
export class FileActionStore implements ActionStore {
  private readonly file: string
  constructor(dir: string, tenantId: string) { this.file = resolve(dir, tenantId, 'actions', 'proposals.json') }
  private async load(): Promise<ActionProposal[]> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as ActionProposal[] } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }
  async list() { return this.load() }
  async get(id: string) { return (await this.load()).find((p) => p.id === id) }
  async put(proposal: ActionProposal) {
    const all = await this.load()
    const next = all.some((p) => p.id === proposal.id) ? all.map((p) => (p.id === proposal.id ? proposal : p)) : [...all, proposal]
    await mkdir(resolve(this.file, '..'), { recursive: true })
    const tmp = join(resolve(this.file, '..'), `.proposals-${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(next, null, 1), { mode: 0o600 })
    await rename(tmp, this.file)
  }
}

type Fail = { ok: false; status: number; error: string; reasons?: string[] }
export type ActionResult = { ok: true; proposal: ActionProposal } | Fail
const fail = (status: number, error: string, reasons?: string[]): Fail => ({ ok: false, status, error, ...(reasons ? { reasons } : {}) })

export interface ActionServiceOptions {
  tenantId: string
  store: ActionStore
  executor: EffectfulToolExecutor
  policy: Partial<ActionPolicy> & { enabledTools: string[] }
  signingKey?: AuthorizationSigningKey
  now?: () => Date
}

export class ActionService {
  readonly tenantId: string
  readonly policy: ActionPolicy
  readonly policySnapshot: string
  private readonly store: ActionStore
  private readonly executor: EffectfulToolExecutor
  private readonly signingKey?: AuthorizationSigningKey
  private readonly now: () => Date

  constructor(options: ActionServiceOptions) {
    this.tenantId = options.tenantId
    this.store = options.store
    this.executor = options.executor
    this.signingKey = options.signingKey
    this.now = options.now ?? (() => new Date())
    const enabledTools = [...new Set(options.policy.enabledTools)].sort()
    const unknown = enabledTools.filter((id) => !this.executor.has(id))
    if (unknown.length) throw new Error(`The action policy enables tools this host does not have: ${unknown.join(', ')}.`)
    this.policy = { ...DEFAULT_ACTION_POLICY, ...options.policy, enabledTools }
    // The policy in force is the set of enabled tools and their contracts. A change to either changes the snapshot.
    this.policySnapshot = sha256({ tools: enabledTools.map((id) => this.executor.manifest(id)), limits: [this.policy.proposalTtlMs, this.policy.approvalTtlMs, this.policy.maxInputBytes] })
  }

  summary() {
    return {
      policySnapshot: this.policySnapshot,
      tools: this.policy.enabledTools.map((id) => {
        const m = this.executor.manifest(id)!
        return { id, access: m.access, requiresApproval: m.requiresApproval, description: m.description }
      }),
      limits: { proposalTtlMs: this.policy.proposalTtlMs, approvalTtlMs: this.policy.approvalTtlMs, maxInputBytes: this.policy.maxInputBytes },
      signingConfigured: Boolean(this.signingKey),
    }
  }

  /** A pending proposal past its expiry reads as expired. */
  private view(p: ActionProposal): ActionProposal {
    return p.status === 'pending' && Date.parse(p.expiresAt) <= this.now().getTime() ? { ...p, status: 'expired' } : p
  }

  async list(status?: ActionStatus) {
    const all = (await this.store.list()).map((p) => this.view(p)).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))
    return status ? all.filter((p) => p.status === status) : all
  }

  async get(id: string) {
    const p = await this.store.get(id)
    return p ? this.view(p) : undefined
  }

  async propose(by: { id: string; kind: string }, body: { toolId?: unknown; input?: unknown; reason?: unknown; evidence?: unknown }): Promise<ActionResult> {
    const { toolId, input, reason, evidence } = body
    if (typeof toolId !== 'string' || !this.policy.enabledTools.includes(toolId)) return fail(422, `toolId must be one of: ${this.policy.enabledTools.join(', ') || '(none enabled)'}.`)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(422, 'input must be an object.')
    let size: number
    try { size = Buffer.byteLength(JSON.stringify(input)) } catch { return fail(422, 'input must be plain JSON.') }
    if (size > this.policy.maxInputBytes) return fail(422, `input is larger than ${this.policy.maxInputBytes} bytes.`)
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return fail(422, 'reason must be 1 to 500 characters.')
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 10 || evidence.some((e) => typeof e !== 'string' || !e.trim() || e.length > 200)) {
      return fail(422, 'evidence must be 1 to 10 references (each 1 to 200 characters); an action with no evidence cannot be approved.')
    }
    const now = this.now()
    const proposal: ActionProposal = {
      id: `ap-${randomUUID()}`,
      toolId,
      input: structuredClone(input as Record<string, unknown>),
      inputDigest: sha256(input),
      reason: reason.trim(),
      evidence: (evidence as string[]).map((e) => e.trim()),
      policySnapshot: this.policySnapshot,
      proposedBy: { id: by.id, kind: by.kind },
      proposedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.policy.proposalTtlMs).toISOString(),
      status: 'pending',
    }
    await this.store.put(proposal)
    return { ok: true, proposal }
  }

  async reject(id: string, by: { id: string }, note?: unknown): Promise<ActionResult> {
    const p = await this.store.get(id)
    if (!p) return fail(404, `No action proposal "${id}".`)
    const v = this.view(p)
    if (v.status !== 'pending') return fail(409, `This proposal is ${v.status}, not pending.`)
    const next: ActionProposal = { ...p, status: 'rejected', decision: { by: by.id, at: this.now().toISOString(), outcome: 'rejected', ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 500) } : {}) } }
    await this.store.put(next)
    return { ok: true, proposal: next }
  }

  /** Approve and run. The caller has already checked that `by` is a human holding the approval permission. */
  async approve(id: string, by: { id: string }, note?: unknown): Promise<ActionResult> {
    const p = await this.store.get(id)
    if (!p) return fail(404, `No action proposal "${id}".`)
    const v = this.view(p)
    if (v.status === 'executing') return fail(409, 'This action is already executing, or the host stopped while it ran. If it stopped, check the provider and settle it with resolve; it is never repeated automatically.')
    if (v.status !== 'pending') return fail(409, `This proposal is ${v.status}, not pending.`)
    if (p.proposedBy.id === by.id) return fail(403, 'You proposed this action; someone else has to approve it.')
    if (p.policySnapshot !== this.policySnapshot) return fail(409, 'The action policy changed after this was proposed. Propose it again under the current policy.')
    if (!this.policy.enabledTools.includes(p.toolId) || !this.executor.has(p.toolId)) return fail(409, `Tool "${p.toolId}" is no longer enabled.`)
    if (!this.signingKey) return fail(503, 'The authorization signing key is not configured on this host, so nothing can be approved.')
    if (sha256(p.input) !== p.inputDigest) return fail(409, 'The stored input no longer matches its digest; nothing was run.')

    const now = this.now().getTime()
    const actionFingerprint = `action:${p.id}:${p.toolId}`
    const contentDigest = sha256({ toolId: p.toolId, input: p.input })
    const binding: HumanApprovalBinding = {
      approvedBy: by.id, approvedByKind: 'human', tenantId: this.tenantId, actionFingerprint,
      policySnapshot: this.policySnapshot, evidenceDigest: sha256(p.evidence),
      approvedAt: now, expiresAt: now + this.policy.approvalTtlMs,
    }
    const boundApproval = approvalDigest(binding)
    const record = issueExecutionAuthorization({
      tenantId: this.tenantId, runId: p.id, nodeId: 'action', actionFingerprint,
      policySnapshot: this.policySnapshot, evidenceDigest: binding.evidenceDigest, evidenceCount: p.evidence.length,
      workflowDigest: contentDigest, approvalDigest: boundApproval, capability: p.toolId, expiresAt: now + 60_000,
    }, this.signingKey, now)

    // Saved as executing before anything runs: a crash leaves a record that says "outcome unknown", never a silent repeat.
    const executing: ActionProposal = {
      ...p, status: 'executing',
      decision: { by: by.id, at: new Date(now).toISOString(), outcome: 'approved', approvalDigest: boundApproval, authorizationId: record.authorizationId, ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 500) } : {}) },
    }
    await this.store.put(executing)

    let ran: Awaited<ReturnType<EffectfulToolExecutor['execute']>>
    try {
      ran = await this.executor.execute(
        { toolId: p.toolId, input: p.input, tenantId: this.tenantId, runId: p.id, nodeId: 'action', idempotencyKey: p.id },
        // Expected values come from the stored proposal and this approval, not from the signed record.
        { record, expected: { actionFingerprint, workflowDigest: sha256({ toolId: p.toolId, input: p.input }), approvalDigest: boundApproval, evidenceCount: p.evidence.length } },
      )
    } catch (error) {
      const refused = error instanceof ToolRefusedError
      const failed: ActionProposal = { ...executing, status: 'failed', error: (refused ? error.reasons.join(' ') : (error as Error).message).slice(0, 300) }
      await this.store.put(failed)
      return { ok: true, proposal: failed }
    }
    // The adapter has run. If saving the result fails, the proposal stays `executing` (outcome unknown) and the error
    // reaches the caller; it is never recorded as failed, because the action may well have happened.
    const dryRun = (ran.output as { dryRun?: unknown } | null)?.dryRun === true
    const done: ActionProposal = { ...executing, status: 'executed', result: { at: this.now().toISOString(), auditId: ran.audit.auditId, ...(ran.audit.outputDigest ? { outputDigest: ran.audit.outputDigest } : {}), ...(dryRun ? { dryRun: true } : {}) } }
    await this.store.put(done)
    return { ok: true, proposal: done }
  }

  /** A human settles an action whose outcome is unknown (the host stopped mid-run). */
  async resolve(id: string, by: { id: string }, body: { outcome?: unknown; note?: unknown }): Promise<ActionResult> {
    const p = await this.store.get(id)
    if (!p) return fail(404, `No action proposal "${id}".`)
    if (p.status !== 'executing') return fail(409, `Only an executing action can be settled; this one is ${p.status}.`)
    if (body.outcome !== 'executed' && body.outcome !== 'failed') return fail(422, 'outcome must be "executed" or "failed".')
    if (typeof body.note !== 'string' || body.note.trim().length < 10 || body.note.length > 500) return fail(422, 'note must say, in 10 to 500 characters, what you checked at the provider.')
    const next: ActionProposal = {
      ...p, status: body.outcome,
      result: { at: this.now().toISOString(), settledBy: by.id, note: body.note.trim() },
      ...(body.outcome === 'failed' ? { error: 'Settled by a person as not done.' } : {}),
    }
    await this.store.put(next)
    return { ok: true, proposal: next }
  }
}
