import { createHash, randomUUID } from 'node:crypto'

import {
  consumeExecutionAuthorization,
  verifyExecutionAuthorization,
  type AuthorizationSigningKey,
  type ExecutionAuthorizationRecord,
} from '@quicksilver/kernel/runtime'
import { ToolRegistry, type ToolManifest } from '@quicksilver/kernel/tools/registry'

/**
 * Effectful tool execution behind the kernel authorization contract (P-095).
 *
 * A tool is a manifest plus an adapter. The executor runs an adapter only when:
 *   - the tool is registered (a ToolRegistry entry with a valid manifest and an adapter);
 *   - for a side-effect tool, a kernel-signed authorization record is presented and checked
 *     against what the CALLER says should be executed: tenant, run, step, action, content
 *     digest, approval digest and evidence count. Nothing is checked against the record's
 *     own fields, which would make the check always pass;
 *   - that record has not been used before by this executor.
 * Every attempt, including a refusal, leaves an audit record.
 *
 * The adapters that ship here are dry runs. They record what they were asked and report
 * `executed: false`; none of them sends, writes or deletes anything. A real adapter is
 * added by registering it with the host, one provider at a time.
 */

export interface ToolCall {
  toolId: string
  input: unknown
  tenantId: string
  runId: string
  nodeId: string
  /** Stable for one intended effect; an adapter passes it to the provider so a retry cannot repeat the effect. */
  idempotencyKey: string
  signal?: AbortSignal
}

export type ToolRun = (call: ToolCall) => Promise<unknown>

export interface ToolDefinition {
  manifest: ToolManifest
  run: ToolRun
  /** True when the adapter really sends or changes something; false (or absent) for a dry run. */
  live?: boolean
  /** A digest of the adapter's settings (allowed recipients or hosts). A change makes pending proposals stale. */
  configDigest?: string
  /** A reason this input can never run, or undefined. Checked when an action is proposed so nobody approves something that cannot run. */
  validate?: (input: unknown) => string | undefined
}

export interface ExpectedGrant {
  actionFingerprint: string
  workflowDigest: string
  approvalDigest: string
  evidenceCount: number
}

export interface ToolExecutionAudit {
  auditId: string
  toolId: string
  access: ToolManifest['access'] | 'unknown'
  tenantId: string
  runId: string
  nodeId: string
  authorizationId?: string
  keyId?: string
  actionFingerprint?: string
  inputDigest: string
  outputDigest?: string
  status: 'success' | 'failed' | 'refused'
  reasons?: string[]
  executedAt: string
}

export class ToolRefusedError extends Error {
  readonly reasons: string[]
  constructor(reasons: string[]) {
    super(reasons.join(' '))
    this.name = 'ToolRefusedError'
    this.reasons = reasons
  }
}

export interface EffectfulToolExecutorOptions {
  tools: readonly ToolDefinition[]
  signingKey?: AuthorizationSigningKey
  auditSink?: (record: ToolExecutionAudit) => Promise<void> | void
  now?: () => number
}

export const sha256 = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`

export class EffectfulToolExecutor {
  readonly registry = new ToolRegistry()
  private readonly runs = new Map<string, ToolRun>()
  private readonly definitions = new Map<string, ToolDefinition>()
  private readonly used = new Set<string>()
  private readonly signingKey?: AuthorizationSigningKey
  private readonly auditSink?: (record: ToolExecutionAudit) => Promise<void> | void
  private readonly now: () => number
  private readonly audit: ToolExecutionAudit[] = []

  constructor(options: EffectfulToolExecutorOptions) {
    this.signingKey = options.signingKey
    this.auditSink = options.auditSink
    this.now = options.now ?? Date.now
    for (const tool of options.tools) {
      this.registry.register(tool.manifest)
      this.runs.set(tool.manifest.id, tool.run)
      this.definitions.set(tool.manifest.id, tool)
    }
  }

  has(toolId: string): boolean { return this.runs.has(toolId) && this.registry.get(toolId) !== undefined }
  manifest(toolId: string): Readonly<ToolManifest> | undefined { return this.registry.get(toolId)?.manifest }
  definition(toolId: string): ToolDefinition | undefined { return this.definitions.get(toolId) }
  toolIds(): string[] { return this.registry.list().map((t) => t.manifest.id) }
  auditLog(): readonly ToolExecutionAudit[] { return [...this.audit] }

  async execute(call: ToolCall, grant?: { record: ExecutionAuthorizationRecord; expected: ExpectedGrant }): Promise<{ output: unknown; audit: ToolExecutionAudit }> {
    const manifest = this.manifest(call.toolId)
    const run = this.runs.get(call.toolId)
    const inputDigest = sha256(call.input)
    const base = { toolId: call.toolId, access: manifest?.access ?? ('unknown' as const), tenantId: call.tenantId, runId: call.runId, nodeId: call.nodeId, inputDigest }
    const refuse = async (reasons: string[]): Promise<never> => {
      await this.record({ ...base, status: 'refused', reasons, ...(grant ? { authorizationId: grant.record?.authorizationId } : {}) })
      throw new ToolRefusedError(reasons)
    }

    if (!manifest || !run) return refuse([`Tool "${call.toolId}" is not registered on this host.`])
    const protectedCall = manifest.access === 'side-effect' || manifest.requiresApproval
    if (protectedCall) {
      if (!grant?.record) return refuse([`"${call.toolId}" has side effects and needs a kernel-signed execution authorization.`])
      if (!this.signingKey) return refuse(['The authorization signing key is not configured; the call was not made.'])
      const { record, expected } = grant
      if (this.used.has(record.authorizationId)) return refuse([`Authorization "${record.authorizationId}" was already used; replay refused.`])
      const checked = verifyExecutionAuthorization(record, this.signingKey, {
        tenantId: call.tenantId, runId: call.runId, nodeId: call.nodeId,
        actionFingerprint: expected.actionFingerprint, workflowDigest: expected.workflowDigest,
        approvalDigest: expected.approvalDigest, evidenceCount: expected.evidenceCount, now: this.now(),
      })
      if (!checked.valid) return refuse(checked.reasons)
      if (record.capability !== call.toolId) return refuse(['Authorization was issued for a different tool.'])
      try { consumeExecutionAuthorization(record, this.signingKey, this.now()) } catch (e) { return refuse([(e as Error).message]) }
      this.used.add(record.authorizationId)
    }

    const authInfo = grant?.record ? { authorizationId: grant.record.authorizationId, keyId: grant.record.keyId, actionFingerprint: grant.record.actionFingerprint } : {}
    try {
      const output = await run(call)
      const audit = await this.record({ ...base, ...authInfo, status: 'success', outputDigest: sha256(output) })
      return { output, audit }
    } catch (error) {
      await this.record({ ...base, ...authInfo, status: 'failed', reasons: [(error as Error).message.slice(0, 300)] })
      throw error
    }
  }

  private async record(partial: Omit<ToolExecutionAudit, 'auditId' | 'executedAt'>): Promise<ToolExecutionAudit> {
    const audit: ToolExecutionAudit = { auditId: `audit:tool:${randomUUID()}`, executedAt: new Date(this.now()).toISOString(), ...partial }
    this.audit.push(audit)
    if (this.auditSink) await this.auditSink(audit)
    return audit
  }
}

// ── Dry-run adapters ───────────────────────────────────────────────────────

const PUBLIC_CHALLENGE_PROJECT = 'd280bqjc'

/** What a dry run returns: the request, digested, and an explicit statement that nothing happened. */
const dry = (call: ToolCall, extra: Record<string, unknown> = {}) => ({
  dryRun: true,
  executed: false,
  note: 'Dry run: nothing was sent, written or changed.',
  toolId: call.toolId,
  idempotencyKey: call.idempotencyKey,
  inputDigest: sha256(call.input),
  ...extra,
})

/** The shipped tools. Each keeps the manifest a real adapter would use, so swapping the adapter later changes no contract. */
export function dryRunTools(): ToolDefinition[] {
  return [
    {
      manifest: { id: 'notification.send', contractVersion: 1, provider: 'notification', access: 'side-effect', requiresApproval: true, description: 'Send an operational notification to a verified recipient (dry run).' },
      run: async (call) => dry(call),
    },
    {
      manifest: { id: 'webhook.dispatch', contractVersion: 1, provider: 'http', access: 'side-effect', requiresApproval: true, description: 'Send a signed event payload to an external URL (dry run).' },
      run: async (call) => {
        const url = (call.input as { url?: unknown } | null)?.url
        if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('webhook.dispatch needs an https:// url.')
        return dry(call, { targetHost: new URL(url).hostname })
      },
    },
    {
      manifest: { id: 'sanity.mutate', contractVersion: 1, provider: 'sanity', access: 'side-effect', requiresApproval: true, description: 'Apply an approved metadata mutation in the dedicated Sanity project (dry run).' },
      run: async (call) => {
        if ((call.input as { projectId?: unknown } | null)?.projectId === PUBLIC_CHALLENGE_PROJECT) throw new Error(`Tool execution is prohibited in the public Quicksilver challenge project (${PUBLIC_CHALLENGE_PROJECT}).`)
        return dry(call)
      },
    },
    {
      manifest: { id: 'sanity.query', contractVersion: 1, provider: 'sanity', access: 'read-only', requiresApproval: false, description: 'Read-only state query (dry run: returns no data).' },
      run: async (call) => dry(call, { results: [] }),
    },
  ]
}
