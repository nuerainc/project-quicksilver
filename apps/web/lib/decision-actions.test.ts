import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decisionActionOptions, type DecisionActionView } from './decision-actions.ts'
import { mayCarryConsoleToken } from './console-auth.ts'

const FP = `sha256:${'b'.repeat(64)}`
const view = (over: Partial<DecisionActionView> = {}): DecisionActionView => ({
  id: 'decision-1', status: 'awaiting-approval', approvalFingerprint: FP, policyChanged: false,
  requestedBy: 'entity-pat', proposedBy: 'nuera-quicksilver:planner', actorId: 'entity-eng', riskBand: 'needs-approval', ...over,
})
const APPROVER = ['decision:read', 'decision:approve', 'decision:execute', 'decision:rollback']
const byId = (options: ReturnType<typeof decisionActionOptions>, id: string) => options.find((o) => o.id === id)

test('an approver can approve, reject or ask for more evidence on a pending decision', () => {
  const options = decisionActionOptions(view(), 'entity-ana', APPROVER)
  assert.deepEqual(options.map((o) => [o.id, o.enabled]), [['approve', true], ['reject', true], ['request-evidence', true]])
  const approve = byId(options, 'approve')!
  assert.deepEqual(approve.call.body, { action: 'approve', expectedActionFingerprint: FP })
  assert.equal(approve.confirm, false)
  assert.equal(byId(options, 'reject')!.confirm, true)
})

test('without decision:approve every pending action is shown disabled with what is needed', () => {
  for (const o of decisionActionOptions(view(), 'entity-vic', ['decision:read'])) {
    assert.equal(o.enabled, false)
    assert.equal(o.reason, 'Needs decision:approve.')
  }
})

test('nobody who requested, proposed or would carry it out can approve it, and the reason says which', () => {
  for (const [over, me, text] of [[{}, 'entity-pat', /You requested this/], [{ proposedBy: 'entity-ana' }, 'entity-ana', /You proposed this/], [{ actorId: 'entity-ana' }, 'entity-ana', /You would carry this out/]] as const) {
    const approve = byId(decisionActionOptions(view(over), me, APPROVER), 'approve')!
    assert.equal(approve.enabled, false)
    assert.match(approve.reason!, text)
  }
})

test('the sole operator may approve their own request, but only with a written reason', () => {
  const approve = byId(decisionActionOptions(view(), 'entity-pat', APPROVER, true), 'approve')!
  assert.equal(approve.enabled, true)
  assert.equal(approve.needsNote, 'required')
  assert.match(approve.label, /written reason/)
})

test('a changed policy, a kernel block, or no recorded action each disable approval with the reason; reject stays available', () => {
  for (const [over, text] of [[{ policyChanged: true }, /fresh plan/], [{ safetyDecision: 'BLOCK' }, /kernel blocked/], [{ approvalFingerprint: null }, /no recorded action/]] as const) {
    const options = decisionActionOptions(view(over), 'entity-ana', APPROVER)
    assert.equal(byId(options, 'approve')!.enabled, false)
    assert.match(byId(options, 'approve')!.reason!, text)
    assert.equal(byId(options, 'reject')!.enabled, true)
  }
})

test('above the review ceiling, approving asks first', () => {
  assert.equal(byId(decisionActionOptions(view({ riskBand: 'above-review-ceiling' }), 'entity-ana', APPROVER), 'approve')!.confirm, true)
})

test('a proposed (held) decision can be re-checked; an approved one can be executed after a confirm; an executed one can be observed or rolled back', () => {
  assert.ok(byId(decisionActionOptions(view({ status: 'proposed' }), 'entity-ana', APPROVER), 'resume'))
  const exec = byId(decisionActionOptions(view({ status: 'approved' }), 'entity-ana', APPROVER), 'execute')!
  assert.equal(exec.enabled, true)
  assert.equal(exec.confirm, true)
  const executed = decisionActionOptions(view({ status: 'executed' }), 'entity-ana', APPROVER)
  assert.deepEqual(executed.map((o) => o.id), ['observe', 'rollback'])
  assert.equal(byId(executed, 'rollback')!.confirm, true)
  assert.equal(byId(decisionActionOptions(view({ status: 'executed' }), 'entity-ana', ['decision:read']), 'rollback')!.reason, 'Needs decision:rollback.')
})

test('a rollback decision cannot itself be rolled back, and a rollback proposal is never one-click approvable without its fingerprint', () => {
  assert.ok(!byId(decisionActionOptions(view({ status: 'executed', kind: 'rollback' }), 'entity-ana', APPROVER), 'rollback'))
  const rollbackProposal = decisionActionOptions(view({ status: 'rollback-proposed', approvalFingerprint: FP }), 'entity-ana', APPROVER)
  assert.equal(byId(rollbackProposal, 'approve')!.enabled, true)
})

test('statuses with nothing to do offer nothing', () => {
  for (const status of ['rejected', 'failed', 'rolled-back']) assert.deepEqual(decisionActionOptions(view({ status }), 'entity-ana', APPROVER), [], status)
})

test('every call is a path the console may send credentials to', () => {
  const all = ['awaiting-approval', 'proposed', 'approved', 'executed'].flatMap((status) => decisionActionOptions(view({ status }), 'entity-ana', APPROVER))
  assert.ok(all.length >= 8)
  for (const o of all) assert.equal(mayCarryConsoleToken(o.call.path), true, o.call.path)
})

test('a disabled option always says why, and an enabled one never carries a reason', () => {
  for (const status of ['awaiting-approval', 'approved', 'executed']) {
    for (const perms of [APPROVER, ['decision:read']]) {
      for (const o of decisionActionOptions(view({ status }), 'entity-ana', perms)) assert.equal(o.enabled, o.reason === undefined, `${status} ${o.id}`)
    }
  }
})
