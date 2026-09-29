/**
 * Core types of the Quicksilver Operator: the governed agent runtime.
 *
 * Every tool call an agent makes passes the gate (gate.ts) before it runs:
 * the command policy, the write-safe root, the tool's risk tier and the
 * approval mode decide whether it runs, waits for a human, or is refused.
 * Every decision and every result goes into the audit log (audit.ts).
 */
import type { z } from 'zod'

/** How much a tool can change. Drives the default approval behaviour. */
export type ToolTier =
  /** Reads only (files, search, web read). */
  | 'read'
  /** Changes files inside the workspace; checkpointed, so reversible. */
  | 'write'
  /** Runs commands or code in the sandbox. */
  | 'execute'
  /** Reaches outside: sends messages, spends money, publishes. */
  | 'external'

/**
 * How the gate treats calls that are not refused outright:
 * - `manual`: every call above `read` waits for a human.
 * - `guarded` (default): `read` and `write` run; `execute` runs unless the
 *   command matches a dangerous pattern; `external` always waits for a human.
 * - `trusted`: everything runs except `external` calls, which still wait.
 * The hardline blocklist and the write-safe root apply in every mode, and no
 * mode lets an `external` call run without a human.
 */
export type ApprovalMode = 'manual' | 'guarded' | 'trusted'

export interface ToolContext {
  /** Absolute path of the workspace root; file tools never leave it. */
  workspace: string
  /** The sandbox that runs commands and code. */
  sandbox: Sandbox
  /** Snapshots files before a write so it can be undone. */
  checkpoints: CheckpointStore
  /** The run this call belongs to. */
  runId: string
  signal?: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** What the model sees. Kept short; long output is truncated with a note. */
  output: string
  /** Structured facts for the audit log and completion checks (exit codes, paths). */
  facts?: Record<string, unknown>
}

export interface OperatorTool<I = unknown> {
  name: string
  description: string
  tier: ToolTier
  input: z.ZodType<I>
  /** A one-line summary of a call, for approval prompts and the audit log. */
  summarize(input: I): string
  /** Commands this call will run, for the command policy (execute-tier tools). */
  commands?(input: I): string[]
  /** Paths this call will write, for the write-safe root check (write-tier tools). */
  writes?(input: I): string[]
  run(input: I, ctx: ToolContext): Promise<ToolResult>
}

export interface SandboxRunOptions {
  cwd?: string
  timeoutMs?: number
  /** Standard input for the process. */
  stdin?: string
  signal?: AbortSignal
}

export interface SandboxRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  /** True when output was cut at the sandbox's limit. */
  truncated: boolean
}

export interface Sandbox {
  readonly kind: 'local' | 'docker' | 'ssh'
  /** Run a shell command (bash -lc on POSIX). */
  run(command: string, options?: SandboxRunOptions): Promise<SandboxRunResult>
  describe(): string
}

export interface CheckpointStore {
  /** Snapshot the current content of `path` (or its absence) before a change. */
  snapshot(runId: string, path: string): Promise<string>
  /** Restore every file changed in a run, newest change first. Returns the paths restored. */
  rollback(runId: string): Promise<string[]>
  list(runId: string): Promise<Array<{ id: string; path: string; existed: boolean; at: string }>>
}
