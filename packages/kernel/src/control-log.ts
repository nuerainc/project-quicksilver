/**
 * Supervisor control-plane event log.
 *
 * The M8-B contract requires the Supervisor Agent to record what it did: the
 * wait, a timeout, a refusal, an execution, a cancellation, and a rollback
 * proposal. This is that record.
 *
 * Design follows the money ledger (`playbooks/economics.ts`): append-only,
 * hash-chained, functional, and re-verified on every append so a tampered log
 * refuses to grow. Sequence numbers plus per-entry hashes detect edits,
 * removals, and reordering.
 *
 * Two properties are deliberate:
 *
 * - **Observable facts only.** Every field is an identifier, a status, a
 *   timestamp, or a reason string the kernel itself produced. Nothing here is
 *   model reasoning, and no private chain-of-thought is accepted, stored, or
 *   derivable. The reasons recorded are the same deterministic strings the
 *   authorization gate reports to a caller.
 * - **A log cannot be written backwards.** Transitions are checked, so
 *   `execution-submitted` cannot be the first entry and cannot follow a
 *   timeout. A clean-looking log therefore has to reflect the real sequence.
 */
import { createHash } from 'node:crypto'

import { approvalDigest, NO_APPROVAL_DIGEST, type SupervisorControlRequest, type SupervisorControlResult, type SupervisorControlStatus } from './supervisor.ts'

export type SupervisorControlEventType =
  /** The Supervisor received Engine output and asked the kernel for authority. */
  | 'authorization-requested'
  /** Routed to a Human Supervisor and is waiting. */
  | 'awaiting-human-approval'
  /** The human did not answer in time. */
  | 'approval-timeout'
  /** The kernel or a check refused the action. */
  | 'refused'
  /** An authorized execution was submitted to an executor. */
  | 'execution-submitted'
  /** The run was cancelled. */
  | 'cancelled'
  /** A rollback was proposed for work that already ran. */
  | 'rollback-proposed'

/** The no-approval sentinel, mirrored from supervisor.ts without importing it. */
const NO_APPROVAL = 'approval:none'
const GENESIS_HASH = '0'.repeat(64)
const MAX_REASONS = 32
const MAX_REASON_CHARS = 500

export interface SupervisorControlEvent {
  seq: number
  at: number
  event: SupervisorControlEventType
  supervisorAgentId: string
  tenantId: string
  runId: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  workflowDigest: string
  approvalDigest: string
  status: SupervisorControlStatus
  authorizationId?: string
  /** Deterministic kernel reasons. Never model reasoning. */
  reasons: string[]
  prevHash: string
  hash: string
}

export interface SupervisorControlLog {
  tenantId: string
  runId: string
  actionFingerprint: string
  events: SupervisorControlEvent[]
}

/**
 * What the runtime observed, reported to a control-plane sink.
 *
 * The runtime is deliberately kept ignorant of policy, evidence, and workflow
 * content — it does not know the bindings, only what happened. The sink knows
 * those and turns a report into a logged event, so the runtime cannot record a
 * decision the gate did not reach, and the host does not have to reconstruct
 * outcomes from step results after the fact.
 */
export type SupervisorControlReportKind =
  /** Authorization was requested from the kernel for this step. */
  | 'authorization-requested'
  /** The control-plane gate returned a verdict. */
  | 'gate-decision'
  /** An authorized step failed in the executor. */
  | 'executor-failed'

export interface SupervisorControlReport {
  kind: SupervisorControlReportKind
  nodeId: string
  runId: string
  tenantId: string
  /** The gate's verdict. `blocked` covers both refusals and executor failure. */
  status: SupervisorControlStatus
  reasons: string[]
  authorizationId?: string
  actionFingerprint?: string
  at: number
}

export type AppendSupervisorEventResult =
  | { ok: true; log: SupervisorControlLog; event: SupervisorControlEvent }
  | { ok: false; reasons: string[] }

export interface SupervisorEventInput {
  event: SupervisorControlEventType
  supervisorAgentId: string
  tenantId: string
  runId: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  workflowDigest: string
  approvalDigest: string
  status: SupervisorControlStatus
  authorizationId?: string
  reasons?: readonly string[]
  at: number
}

function emptyLog(tenantId: string, runId: string, actionFingerprint: string): SupervisorControlLog {
  return { tenantId, runId, actionFingerprint, events: [] }
}

export function verifySupervisorControlLog(log: SupervisorControlLog): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  let prevHash = GENESIS_HASH
  log.events.forEach((entry, i) => {
    const { hash, ...rest } = entry
    if (entry.seq !== i + 1) errors.push(`Event ${i + 1} has sequence ${entry.seq}.`)
    if (entry.prevHash !== prevHash) errors.push(`Event ${entry.seq} does not follow the previous event.`)
    if (entryHash(rest) !== hash) errors.push(`Event ${entry.seq} does not match its hash; it was altered.`)
    prevHash = hash
  })
  const transitions = checkTransitions(log.events)
  errors.push(...transitions)
  return { valid: errors.length === 0, errors }
}

/**
 * Append one control-plane event.
 *
 * The log is re-verified first: a chain that no longer holds refuses to grow,
 * so a damaged record cannot be quietly extended past the damage.
 */
export function appendSupervisorControlEvent(
  log: SupervisorControlLog | undefined,
  input: SupervisorEventInput,
): AppendSupervisorEventResult {
  const reasons: string[] = []
  if (!input.supervisorAgentId.trim()) reasons.push('Supervisor agent id is required.')
  if (!input.tenantId.trim()) reasons.push('Tenant binding is required.')
  if (!input.runId.trim()) reasons.push('Durable run id is required.')
  if (!input.actionFingerprint.trim()) reasons.push('Action fingerprint is required.')
  if (!input.policySnapshot.trim()) reasons.push('Policy snapshot binding is required.')
  if (!input.evidenceDigest.trim()) reasons.push('Evidence digest binding is required.')
  if (!input.workflowDigest.trim()) reasons.push('Workflow content digest is required.')
  if (!Number.isFinite(input.at) || input.at < 0) reasons.push('Event time is invalid.')

  const current = log ?? emptyLog(input.tenantId, input.runId, input.actionFingerprint)
  if (current.tenantId !== input.tenantId) reasons.push('The log belongs to a different tenant.')
  if (current.runId !== input.runId) reasons.push('The log belongs to a different run.')
  if (current.actionFingerprint !== input.actionFingerprint) reasons.push('The log belongs to a different action.')

  const verified = verifySupervisorControlLog(current)
  if (!verified.valid) reasons.push(`The control-plane log does not verify: ${verified.errors.join(' ')}`)

  // The candidate must also leave a valid log behind.
  const prev = current.events.at(-1)
  reasons.push(...allowedTransitions(prev?.event, input.event, input.approvalDigest))
  if (reasons.length) return { ok: false, reasons }

  const base: Omit<SupervisorControlEvent, 'hash'> = {
    seq: (prev?.seq ?? 0) + 1,
    at: input.at,
    event: input.event,
    supervisorAgentId: input.supervisorAgentId,
    tenantId: input.tenantId,
    runId: input.runId,
    actionFingerprint: input.actionFingerprint,
    policySnapshot: input.policySnapshot,
    evidenceDigest: input.evidenceDigest,
    workflowDigest: input.workflowDigest,
    approvalDigest: input.approvalDigest,
    status: input.status,
    ...(input.authorizationId ? { authorizationId: input.authorizationId } : {}),
    reasons: (input.reasons ?? []).slice(0, MAX_REASONS).map((reason) => reason.slice(0, MAX_REASON_CHARS)),
    prevHash: prev?.hash ?? GENESIS_HASH,
  }
  const event: SupervisorControlEvent = Object.freeze({ ...base, hash: entryHash(base) })
  return { ok: true, log: { ...current, events: [...current.events, event] }, event }
}

export function emptySupervisorControlLog(tenantId: string, runId: string, actionFingerprint: string): SupervisorControlLog {
  return emptyLog(tenantId, runId, actionFingerprint)
}

/** The event that corresponds to a control-plane result. */
export function eventForStatus(status: SupervisorControlStatus): SupervisorControlEventType {
  if (status === 'ready-to-execute') return 'execution-submitted'
  if (status === 'awaiting-human-approval') return 'awaiting-human-approval'
  return 'refused'
}

/** Digest of the approval a request carries, or the no-approval sentinel. */
function approvalDigestFor(request: Pick<SupervisorControlRequest, 'approval'>): string {
  return request.approval ? approvalDigest(request.approval) : NO_APPROVAL_DIGEST
}

/**
 * Record one control-plane decision.
 *
 * The event, bindings, and reason strings are all taken from the request and
 * the result the kernel just produced, so a caller cannot record a decision
 * the gate did not actually reach. Use this for the decisions the gate makes on
 * its own; terminal events with no gate result (a timeout, a cancellation, a
 * rollback proposal) are appended directly.
 */
export function recordSupervisorDecision(
  log: SupervisorControlLog | undefined,
  request: SupervisorControlRequest,
  result: SupervisorControlResult,
  at = Date.now(),
): AppendSupervisorEventResult {
  return appendSupervisorControlEvent(log, {
    event: eventForStatus(result.status),
    supervisorAgentId: request.supervisorAgentId,
    tenantId: request.tenantId,
    runId: request.runId,
    actionFingerprint: request.actionFingerprint,
    policySnapshot: request.policySnapshot,
    evidenceDigest: request.evidenceDigest,
    workflowDigest: request.workflowDigest,
    approvalDigest: approvalDigestFor(request),
    status: result.status,
    ...(result.authorization?.authorizationId ? { authorizationId: result.authorization.authorizationId } : {}),
    reasons: result.reasons,
    at,
  })
}

function allowedTransitions(
  previous: SupervisorControlEventType | undefined,
  next: SupervisorControlEventType,
  approvalDigest: string,
): string[] {
  if (previous === undefined) {
    // A log always starts by asking the kernel, never by claiming an outcome.
    if (next !== 'authorization-requested') return ['The first control-plane event must be authorization-requested.']
    return []
  }
  if (previous === 'rollback-proposed') return ['A rollback proposal ends this control-plane record.']
  if (previous === 'approval-timeout') {
    return next === 'rollback-proposed' || next === 'cancelled'
      ? []
      : ['An approval timeout can only be followed by a cancellation or a rollback proposal.']
  }
  if (previous === 'cancelled' || previous === 'refused') {
    return next === 'rollback-proposed' ? [] : ['A refused or cancelled action can only be followed by a rollback proposal.']
  }
  if (next === 'authorization-requested') return ['Authorization may only be requested once per control-plane record.']
  if (next === 'execution-submitted' && approvalDigest === NO_APPROVAL && previous === 'awaiting-human-approval') {
    return ['An execution submitted after waiting for a human must be bound to that approval.']
  }
  return []
}

function checkTransitions(events: readonly SupervisorControlEvent[]): string[] {
  const errors: string[] = []
  let previous: SupervisorControlEventType | undefined
  for (const entry of events) {
    for (const problem of allowedTransitions(previous, entry.event, entry.approvalDigest)) {
      errors.push(`Event ${entry.seq} (${entry.event}): ${problem}`)
    }
    previous = entry.event
  }
  return errors
}

function entryHash(body: Omit<SupervisorControlEvent, 'hash'>): string {
  return createHash('sha256').update(canonical(body)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
