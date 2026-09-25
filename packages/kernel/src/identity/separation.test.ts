import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSeparationOfDuties, MIN_SOLE_OPERATOR_JUSTIFICATION } from '../index.ts'

test('Separation: an independent approver is allowed', () => {
  const r = checkSeparationOfDuties({ approverId: 'entity-ana', requestedBy: 'entity-bo', proposedBy: 'nuera-quicksilver:planner', actorId: 'entity-agent' })
  assert.equal(r.allowed, true)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.soleOperatorOverride, false)
})

test('Separation: the requester cannot approve their own request', () => {
  const r = checkSeparationOfDuties({ approverId: 'entity-ana', requestedBy: 'entity-ana' })
  assert.equal(r.allowed, false)
  assert.match(r.reasons.join(' '), /requested this decision/)
})

test('Separation: the proposer of a rollback cannot approve it', () => {
  const r = checkSeparationOfDuties({ approverId: 'entity-ana', proposedBy: 'entity-ana' })
  assert.equal(r.allowed, false)
})

test('Separation: the entity that would carry out the action cannot approve it', () => {
  const r = checkSeparationOfDuties({ approverId: 'entity-jin', actorId: 'entity-jin' })
  assert.equal(r.allowed, false)
  assert.match(r.reasons.join(' '), /carry out/)
})

test('Separation: a sole operator may override only with a written justification', () => {
  const base = { approverId: 'entity-founder', requestedBy: 'entity-founder', soleOperatorId: 'entity-founder' }
  const short = checkSeparationOfDuties({ ...base, justification: 'ok' })
  assert.equal(short.allowed, false)
  assert.match(short.reasons.join(' '), /justification/)
  const ok = checkSeparationOfDuties({ ...base, justification: 'x'.repeat(MIN_SOLE_OPERATOR_JUSTIFICATION) })
  assert.equal(ok.allowed, true)
  assert.equal(ok.soleOperatorOverride, true)
  assert.equal(ok.conflicts.length, 1, 'the waived conflict is still reported for the audit trail')
})

test('Separation: a sole-operator setting does not let someone else self-approve', () => {
  const r = checkSeparationOfDuties({ approverId: 'entity-ana', requestedBy: 'entity-ana', soleOperatorId: 'entity-founder', justification: 'a long enough justification here' })
  assert.equal(r.allowed, false)
})

test('Separation: an empty approver is refused', () => {
  assert.equal(checkSeparationOfDuties({ approverId: '  ' }).allowed, false)
})
