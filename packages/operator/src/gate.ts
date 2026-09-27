/**
 * The gate: every tool call an agent makes is decided here before it runs.
 *
 * Order (the first refusal wins):
 *   1. The tool exists and the input matches its schema.
 *   2. Writes: every path is inside the workspace and not protected.
 *   3. Commands: the hardline blocklist refuses in every mode; dangerous
 *      patterns ask for a human in `manual` and `guarded` modes.
 *   4. `external` calls (messages, money, publishing) go to the kernel's
 *      `authorize()` when it is wired in, and always need a human's approval
 *      before they run. No approval mode removes that.
 *   5. The approval mode decides the rest (see ApprovalMode).
 *
 * An approval is bound to the exact call: the hash of the tool name and its
 * canonical input. A call that changed after approval does not run.
 */
import { createHash, randomBytes } from 'node:crypto'

import { canonicalJson } from '@quicksilver/kernel/runtime'

import type { AuditSink } from './audit.ts'
import { checkWritePath, classifyCommand, type CommandRule } from './policy.ts'
import type { ApprovalMode, OperatorTool } from './types.ts'

export type GateDecision =
  | { verdict: 'run'; callHash: string; summary: string }
  | { verdict: 'ask'; callHash: string; summary: string; reasons: string[]; rules: string[] }
  | { verdict: 'refuse'; callHash: string; summary: string; reasons: string[]; rules: string[] }

/** What the kernel says about an external call (from `authorize()` when wired in). */
export interface ExternalAuthorization {
  authorized: boolean
  reasons: string[]
}

export interface GateOptions {
  mode: ApprovalMode
  workspace: string
  audit: AuditSink
  /** Kernel authorization for `external` calls; without it, external calls are refused. */
  authorizeExternal?: (tool: OperatorTool, input: unknown) => Promise<ExternalAuthorization>
  extraHardline?: readonly CommandRule[]
  extraDangerous?: readonly CommandRule[]
}

export function callHash(tool: string, input: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson({ tool, input })).digest('hex')}`
}

export class Gate {
  private readonly o: GateOptions
  private readonly tools = new Map<string, OperatorTool<any>>()

  constructor(tools: readonly OperatorTool<any>[], options: GateOptions) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Tool "${t.name}" is registered twice.`)
      this.tools.set(t.name, t)
    }
    this.o = options
  }

  tool(name: string): OperatorTool<any> | undefined { return this.tools.get(name) }
  list(): OperatorTool<any>[] { return [...this.tools.values()] }

  /** Decide one call and record the decision. */
  async decide(runId: string, name: string, rawInput: unknown): Promise<GateDecision & { input?: unknown }> {
    const decision = await this.evaluate(name, rawInput)
    await this.o.audit.append({ runId, kind: 'gate', at: new Date().toISOString(), data: { tool: name, verdict: decision.verdict, callHash: decision.callHash, summary: decision.summary, ...('reasons' in decision ? { reasons: decision.reasons, rules: decision.rules } : {}) } })
    return decision
  }

  private async evaluate(name: string, rawInput: unknown): Promise<GateDecision & { input?: unknown }> {
    const tool = this.tools.get(name)
    const hash = callHash(name, rawInput)
    if (!tool) return { verdict: 'refuse', callHash: hash, summary: name, reasons: [`There is no tool "${name}".`], rules: ['unknown-tool'] }
    const parsed = tool.input.safeParse(rawInput)
    if (!parsed.success) {
      return { verdict: 'refuse', callHash: hash, summary: name, reasons: [`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`], rules: ['invalid-input'] }
    }
    const input = parsed.data
    const summary = tool.summarize(input)
    const ask: string[] = []
    const askRules: string[] = []

    for (const path of tool.writes?.(input) ?? []) {
      const v = checkWritePath(this.o.workspace, path)
      if (!v.ok) return { verdict: 'refuse', callHash: hash, summary, reasons: [v.reason], rules: ['write-path'], input }
    }

    for (const command of tool.commands?.(input) ?? []) {
      const v = classifyCommand(command, this.o.extraHardline, this.o.extraDangerous)
      if (v.level === 'refuse') return { verdict: 'refuse', callHash: hash, summary, reasons: v.reasons, rules: v.rules, input }
      if (v.level === 'ask') { ask.push(...v.reasons); askRules.push(...v.rules) }
    }

    if (tool.tier === 'external') {
      if (!this.o.authorizeExternal) {
        return { verdict: 'refuse', callHash: hash, summary, reasons: ['External actions need the kernel, and none is connected to this operator.'], rules: ['external-no-kernel'], input }
      }
      const k = await this.o.authorizeExternal(tool, input)
      if (!k.authorized) return { verdict: 'refuse', callHash: hash, summary, reasons: k.reasons.length ? k.reasons : ['The kernel refused this action.'], rules: ['kernel'], input }
      return { verdict: 'ask', callHash: hash, summary, reasons: ['It reaches outside (a message, money or a publication): a person approves every one.', ...ask], rules: ['external', ...askRules], input }
    }

    const mode = this.o.mode
    if (mode === 'manual' && tool.tier !== 'read') {
      return { verdict: 'ask', callHash: hash, summary, reasons: ['Manual mode: every change waits for a person.', ...ask], rules: ['manual', ...askRules], input }
    }
    if (ask.length && mode !== 'trusted') return { verdict: 'ask', callHash: hash, summary, reasons: ask, rules: askRules, input }
    return { verdict: 'run', callHash: hash, summary, input }
  }
}

/** A pending approval: a call waiting for a person. */
export interface ApprovalRequest {
  id: string
  runId: string
  tool: string
  summary: string
  callHash: string
  reasons: string[]
  at: string
}

export interface ApprovalAnswer {
  approved: boolean
  /** Who decided (a human principal id). */
  by: string
  /** The hash the person saw; must equal the request's. */
  callHash: string
  note?: string
}

/** Decides approvals: an interactive terminal, the console, a channel, or a policy for unattended runs. */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalAnswer>

/** Unattended runs: nothing that needs a person runs. */
export const denyAll: Approver = async (r) => ({ approved: false, by: 'policy:unattended', callHash: r.callHash, note: 'No one is here to approve; the run continues without it.' })

export function newApprovalId(): string {
  return `appr-${randomBytes(8).toString('hex')}`
}
