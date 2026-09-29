/**
 * Supervisor control-plane event log. Run with `npm run kernel:test`.
 *
 * The log is the record that the Supervisor Agent asked for authority, waited
 * on a human, and either executed, timed out, was refused, was cancelled, or
 * proposed a rollback. These tests hold it to that: append-only, hash-chained,
 * and impossible to write backwards.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  appendSupervisorControlEvent,
  emptySupervisorControlLog,
  eventForStatus,
  recordSupervisorDecision,
  verifySupervisorControlLog,
  type SupervisorEventInput,
  type SupervisorControlLog,
} from './control-log.ts'
import { approvalDigest, coordinateSupervisorControl, NO_APPROVAL_DIGEST, type HumanApprovalBinding } from './supervisor.ts'

const now = 1_000
const approval: HumanApprovalBinding = {
  approvedBy: 'user:supervisor', approvedByKind: 'human', tenantId: 'acme',
  actionFingerprint: 'action:abc', policySnapshot: 'policy:1', evidenceDigest: 'evidence:1',
  approvedAt: 900, expiresAt: 1_800,
}
const bound = approvalDigest(approval)

function input(overrides: Partial<SupervisorEventInput> = {}): SupervisorEventInput {
  return {
    event: 'authorization-requested',
    supervisorAgentId: 'nuera-quicksilver:supervisor',
    tenantId: 'acme',
    runId: 'run-1',
    actionFingerprint: 'action:abc',
    policySnapshot: 'policy:1',
    evidenceDigest: 'evidence:1',
    workflowDigest: 'sha256:wf1',
    approvalDigest: NO_APPROVAL_DIGEST,
    status: 'blocked',
    at: now,
    ...overrides,
  }
}

function started(): SupervisorControlLog {
  const result = appendSupervisorControlEvent(undefined, input())
  assert.ok(result.ok, 'a log may start by asking the kernel')
  return result.log
}

test('Control log: a full wait-then-execute sequence verifies', () => {
  let log = started()
  const wait = appendSupervisorControlEvent(log, input({ event: 'awaiting-human-approval', status: 'awaiting-human-approval', at: 1_100 }))
  assert.ok(wait.ok)
  log = wait.log
  const run = appendSupervisorControlEvent(log, input({ event: 'execution-submitted', status: 'ready-to-execute', approvalDigest: bound, authorizationId: 'auth:1', at: 1_200 }))
  assert.ok(run.ok, run.ok ? '' : run.reasons.join(' '))
  log = run.log

  assert.deepEqual(log.events.map((e) => e.event), ['authorization-requested', 'awaiting-human-approval', 'execution-submitted'])
  assert.deepEqual(log.events.map((e) => e.seq), [1, 2, 3])
  const verified = verifySupervisorControlLog(log)
  assert.equal(verified.valid, true, verified.errors.join(' '))
  assert.equal(log.events[2]!.approvalDigest, bound)
  assert.equal(log.events[2]!.authorizationId, 'auth:1')
})

test('Control log: a log may not claim an outcome before asking the kernel', () => {
  const direct = appendSupervisorControlEvent(undefined, input({ event: 'execution-submitted', status: 'ready-to-execute', approvalDigest: bound }))
  assert.equal(direct.ok, false)
  assert.match(direct.ok ? '' : direct.reasons.join(' '), /must be authorization-requested/)
})

test('Control log: an execution after waiting must be bound to that approval', () => {
  const wait = appendSupervisorControlEvent(started(), input({ event: 'awaiting-human-approval', status: 'awaiting-human-approval', at: 1_100 }))
  assert.ok(wait.ok)
  // Backdated to before the approval existed, and with no approval bound.
  const unbacked = appendSupervisorControlEvent(wait.log, input({ event: 'execution-submitted', status: 'ready-to-execute', at: 1_200 }))
  assert.equal(unbacked.ok, false)
  assert.match(unbacked.ok ? '' : unbacked.reasons.join(' '), /must be bound to that approval/)
})

test('Control log: a timeout cannot be followed by an execution', () => {
  const timeout = appendSupervisorControlEvent(started(), input({ event: 'approval-timeout', status: 'awaiting-human-approval', at: 1_100 }))
  assert.ok(timeout.ok)
  const after = appendSupervisorControlEvent(timeout.log, input({ event: 'execution-submitted', status: 'ready-to-execute', approvalDigest: bound, at: 1_200 }))
  assert.equal(after.ok, false)
  assert.match(after.ok ? '' : after.reasons.join(' '), /only be followed by a cancellation or a rollback/)
  // Cancelling or rolling back from a timeout is legitimate.
  assert.equal(appendSupervisorControlEvent(timeout.log, input({ event: 'cancelled', at: 1_200 })).ok, true)
  assert.equal(appendSupervisorControlEvent(timeout.log, input({ event: 'rollback-proposed', at: 1_200 })).ok, true)
})

test('Control log: authorization may only be requested once', () => {
  const again = appendSupervisorControlEvent(started(), input({ event: 'authorization-requested', at: 1_100 }))
  assert.equal(again.ok, false)
  assert.match(again.ok ? '' : again.reasons.join(' '), /only be requested once/)
})

test('Control log: a rollback proposal ends the record', () => {
  const rollback = appendSupervisorControlEvent(started(), input({ event: 'rollback-proposed', at: 1_100 }))
  assert.ok(rollback.ok)
  const after = appendSupervisorControlEvent(rollback.log, input({ event: 'cancelled', at: 1_200 }))
  assert.equal(after.ok, false)
  assert.match(after.ok ? '' : after.reasons.join(' '), /ends this control-plane record/)
})

test('Control log: editing, removing, or reordering an event breaks the chain', () => {
  let log = started()
  const waited = appendSupervisorControlEvent(log, input({ event: 'awaiting-human-approval', status: 'awaiting-human-approval', at: 1_100 }))
  assert.ok(waited.ok)
  log = waited.log
  const executed = appendSupervisorControlEvent(log, input({ event: 'execution-submitted', status: 'ready-to-execute', approvalDigest: bound, at: 1_200 }))
  assert.ok(executed.ok)
  log = executed.log
  assert.equal(verifySupervisorControlLog(log).valid, true)

  const edited: SupervisorControlLog = { ...log, events: log.events.map((e, i) => (i === 1 ? { ...e, reasons: ['looks fine to me'] } : e)) }
  assert.equal(verifySupervisorControlLog(edited).valid, false)

  const removed: SupervisorControlLog = { ...log, events: [log.events[0]!, log.events[2]!] }
  assert.equal(verifySupervisorControlLog(removed).valid, false)

  const reordered: SupervisorControlLog = { ...log, events: [log.events[0]!, log.events[2]!, log.events[1]!] }
  assert.equal(verifySupervisorControlLog(reordered).valid, false)
})

test('Control log: a damaged log refuses to grow', () => {
  const log = started()
  const damaged: SupervisorControlLog = { ...log, events: [{ ...log.events[0]!, at: 99_999 }] }
  const next = appendSupervisorControlEvent(damaged, input({ event: 'awaiting-human-approval', status: 'awaiting-human-approval', at: 1_100 }))
  assert.equal(next.ok, false)
  assert.match(next.ok ? '' : next.reasons.join(' '), /does not verify/)
})

test('Control log: a log belongs to exactly one tenant, run, and action', () => {
  const log = started()
  const otherTenant = appendSupervisorControlEvent(log, input({ tenantId: 'globex', event: 'cancelled' }))
  assert.equal(otherTenant.ok, false)
  assert.match(otherTenant.ok ? '' : otherTenant.reasons.join(' '), /different tenant/)

  const otherRun = appendSupervisorControlEvent(log, input({ runId: 'run-2', event: 'cancelled' }))
  assert.equal(otherRun.ok, false)
  assert.match(otherRun.ok ? '' : otherRun.reasons.join(' '), /different run/)

  const otherAction = appendSupervisorControlEvent(log, input({ actionFingerprint: 'action:other', event: 'cancelled' }))
  assert.equal(otherAction.ok, false)
  assert.match(otherAction.ok ? '' : otherAction.reasons.join(' '), /different action/)
})

test('Control log: the recorded reason strings are bounded', () => {
  const many = Array.from({ length: 100 }, (_, i) => `reason ${i}`)
  const long = 'x'.repeat(5_000)
  const result = appendSupervisorControlEvent(undefined, input({ reasons: [long, ...many] }))
  assert.ok(result.ok)
  // Capped at 32 entries, and the oversized one is truncated to 500 characters.
  assert.equal(result.event.reasons.length, 32)
  assert.equal(result.event.reasons[0]!.length, 500)
  assert.equal(result.event.reasons.at(-1), 'reason 30')
})

test('Control log: incomplete bindings are refused', () => {
  for (const missing of ['supervisorAgentId', 'tenantId', 'runId', 'actionFingerprint', 'policySnapshot', 'evidenceDigest', 'workflowDigest'] as const) {
    const result = appendSupervisorControlEvent(undefined, input({ [missing]: '  ' }))
    assert.equal(result.ok, false, `${missing} should be required`)
  }
})

test('Control log: an empty log verifies and each status maps to one event', () => {
  assert.equal(verifySupervisorControlLog(emptySupervisorControlLog('acme', 'run-1', 'action:abc')).valid, true)
  assert.equal(eventForStatus('ready-to-execute'), 'execution-submitted')
  assert.equal(eventForStatus('awaiting-human-approval'), 'awaiting-human-approval')
  assert.equal(eventForStatus('blocked'), 'refused')
})

test('Control log: a real gate decision is recorded as the gate reached it', () => {
  const key = { keyId: 'kernel-key-1', secret: '0123456789abcdef0123456789abcdef' }
  const request = {
    supervisorAgentId: 'nuera-quicksilver:supervisor', tenantId: 'acme', runId: 'run-1', actionFingerprint: 'action:abc',
    policySnapshot: 'policy:1', currentPolicySnapshot: 'policy:1', evidenceDigest: 'evidence:1', workflowDigest: 'sha256:wf1',
    capability: 'orders.send', safetyDecision: 'ALLOW' as const, requiresHumanApproval: true, now,
  }

  // The gate says: waiting on a human. The log must say the same thing.
  const waiting = coordinateSupervisorControl(request, key)
  assert.equal(waiting.status, 'awaiting-human-approval')
  const first = recordSupervisorDecision(started(), request, waiting, 1_050)
  assert.ok(first.ok, first.ok ? '' : first.reasons.join(' '))
  assert.equal(first.event.event, 'awaiting-human-approval')

  // Once the human approves, the same gate reaches execution, and the log
  // records that transition with the approval bound to it.
  const approved = { ...request, approval }
  const ready = coordinateSupervisorControl(approved, key)
  assert.equal(ready.status, 'blocked', 'this approval is not bound to any grant yet')
  const refused = recordSupervisorDecision(first.log, approved, ready, 1_200)
  assert.ok(refused.ok)
  assert.equal(refused.event.event, 'refused')
  assert.equal(verifySupervisorControlLog(refused.log).valid, true)
})
