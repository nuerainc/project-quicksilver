import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attentionCounts, buildAttention, type AttentionInput, type DecisionInput } from './attention.ts'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const FP = `sha256:${'a'.repeat(64)}`
const why = (band = 'needs-approval', risk = 3): NonNullable<DecisionInput['why']> => ({ headline: `Risk ${risk} needs a human.`, risk: { band, finalRisk: risk }, whatWouldChangeIt: [] })
const decision = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  id: 'decision-1', title: 'Cut spend', action: 'Pause the ad set', status: 'awaiting-approval', riskLevel: 3, requiredApproval: true,
  requestedBy: 'entity-pat', createdAt: '2026-10-03T10:00:00Z', policySnapshotVersion: 'sha256:p', stale: false, why: why(), ...over,
})
const APPROVER = ['decision:read', 'decision:approve', 'decision:execute']
const input = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  me: 'entity-ana', permissions: APPROVER, now: NOW, decisions: [decision()], fingerprints: { 'decision-1': FP },
  workflowRuns: [], agentReviewQueue: [], traceAlerts: [], ...over,
})
const actionIds = (items: ReturnType<typeof buildAttention>) => items.flatMap((i) => i.actions.map((a) => a.id))

test('an approver sees a decision they did not request, with approve and reject one click away', () => {
  const [item] = buildAttention(input())
  assert.equal(item!.kind, 'approval')
  assert.equal(item!.actionable, true)
  assert.deepEqual(item!.actions.map((a) => a.id), ['approve', 'reject'])
  const approve = item!.actions[0]!
  assert.equal(approve.call!.path, '/api/decisions/decision-1/action')
  assert.deepEqual(approve.call!.body, { action: 'approve', expectedActionFingerprint: FP })
  assert.equal(approve.call!.confirm, false)
  assert.equal(item!.actions[1]!.call!.confirm, true, 'rejecting asks first')
  assert.deepEqual(item!.covers, { action: 'Pause the ad set', riskLevel: 3, why: 'Risk 3 needs a human.', policyVersion: 'sha256:p' })
})

test('a person is never offered approval of their own request, and it is listed quietly', () => {
  const [item] = buildAttention(input({ me: 'entity-pat' }))
  assert.equal(item!.kind, 'waiting-on-others')
  assert.equal(item!.actionable, false)
  assert.ok(!actionIds([item!]).includes('approve'))
})

test('nobody who proposed or would carry out the action is offered approval either', () => {
  for (const [over, text] of [[{ proposedBy: 'entity-ana' }, /You proposed this/], [{ actorId: 'entity-ana' }, /You would carry this out/]] as const) {
    const [item] = buildAttention(input({ decisions: [decision(over)] }))
    assert.equal(item!.kind, 'waiting-on-others')
    assert.match(item!.reason, text)
    assert.ok(!actionIds([item!]).includes('approve'))
  }
})

test('without decision:approve there is no approval item at all', () => {
  assert.deepEqual(buildAttention(input({ permissions: ['decision:read'] })), [])
})

test('above the review ceiling, or with no stored explanation, or no fingerprint, the card offers Review, not Approve', () => {
  for (const over of [{ why: why('above-review-ceiling', 5), riskLevel: 5 }, { why: null }, { policySnapshotVersion: null }]) {
    const [item] = buildAttention(input({ decisions: [decision(over)] }))
    assert.ok(!actionIds([item!]).includes('approve'), JSON.stringify(over))
    assert.ok(actionIds([item!]).includes('review'))
  }
  const [noFingerprint] = buildAttention(input({ fingerprints: {} }))
  assert.ok(!actionIds([noFingerprint!]).includes('approve'))
})

test('a decision whose policy changed is never offered for approval', () => {
  const [item] = buildAttention(input({ decisions: [decision({ stale: true })] }))
  assert.equal(item!.kind, 'stale-approval')
  assert.ok(!actionIds([item!]).includes('approve'))
  assert.match(item!.reason, /fresh plan/)
})

test('a rollback is never one click: it opens for review', () => {
  const [item] = buildAttention(input({ decisions: [decision({ status: 'rollback-proposed' })] }))
  assert.equal(item!.kind, 'rollback')
  assert.ok(!actionIds([item!]).includes('approve'))
})

test('an approved decision can be executed by someone with decision:execute, after a confirm', () => {
  const [item] = buildAttention(input({ decisions: [decision({ status: 'approved' })] }))
  assert.equal(item!.kind, 'execute')
  const execute = item!.actions.find((a) => a.id === 'execute')!
  assert.equal(execute.call!.path, '/api/decisions/decision-1/execute')
  assert.equal(execute.call!.confirm, true)
  assert.match(item!.reason, /simulation/)
  assert.deepEqual(buildAttention(input({ permissions: ['decision:read', 'decision:approve'], decisions: [decision({ status: 'approved' })] })), [])
})

test('a refused plan of mine shows the near-miss and is not counted as something to act on', () => {
  const refused = decision({
    status: 'rejected', requestedBy: 'entity-ana', riskLevel: 4,
    why: { headline: 'Refused: No evidence supports this action.', risk: { band: 'above-review-ceiling', finalRisk: 4 }, whatWouldChangeIt: [{ change: 'The action can be undone cleanly (reversible).', improves: true, simulated: true, outcome: { recommendation: 'request-approval', riskLevel: 3 } }] },
  })
  const items = buildAttention(input({ decisions: [refused] }))
  assert.equal(items[0]!.kind, 'refused')
  assert.equal(items[0]!.actionable, false)
  assert.match(items[0]!.nearMiss!, /reversible\)\. The kernel then says request-approval at risk 3\./)
  assert.deepEqual(attentionCounts(items, []), { actionable: 0, other: 1, complete: true })
})

test('old refusals and other people\'s refusals are not listed', () => {
  assert.deepEqual(buildAttention(input({ decisions: [decision({ status: 'rejected', requestedBy: 'entity-ana', createdAt: '2026-09-01T00:00:00Z' })] })), [])
  assert.deepEqual(buildAttention(input({ decisions: [decision({ status: 'rejected', requestedBy: 'entity-pat' })] })), [])
})

test('failed workflow runs are grouped per workflow and only the last day counts', () => {
  const runs = [
    { workflowId: 'wf-a', status: 'failed', completedAt: NOW - 1000 },
    { workflowId: 'wf-a', status: 'failed', completedAt: NOW - 2000 },
    { workflowId: 'wf-a', status: 'succeeded', completedAt: NOW - 3000 },
    { workflowId: 'wf-b', status: 'failed', completedAt: NOW - 3 * 86_400_000 },
  ]
  const items = buildAttention(input({ decisions: [], permissions: ['workflow:read'], workflowRuns: runs }))
  assert.equal(items.length, 1)
  assert.match(items[0]!.reason, /2 runs failed in the last 24 hours/)
  assert.deepEqual(buildAttention(input({ decisions: [], permissions: ['decision:read'], workflowRuns: runs })), [])
})

test('an agent definition waits for review by someone other than its author, with agent:review', () => {
  const queue = [{ agentId: 'nuera-quicksilver:x', displayName: 'X', version: 2, authoredBy: 'entity-ana', createdAt: NOW }, { agentId: 'nuera-quicksilver:y', displayName: 'Y', version: 1, authoredBy: 'entity-pat', createdAt: NOW }]
  const items = buildAttention(input({ decisions: [], permissions: ['agent:review'], agentReviewQueue: queue }))
  assert.deepEqual(items.map((i) => i.title), ['Y'])
  assert.deepEqual(buildAttention(input({ decisions: [], permissions: [], agentReviewQueue: queue })), [])
})

test('trace alerts need audit:read', () => {
  const alerts = [{ id: 'safety-block', severity: 'critical' as const, summary: '2 evaluation(s) blocked or escalated for human review.' }]
  assert.equal(buildAttention(input({ decisions: [], permissions: ['audit:read'], traceAlerts: alerts }))[0]!.severity, 'critical')
  assert.deepEqual(buildAttention(input({ decisions: [], permissions: ['decision:read'], traceAlerts: alerts })), [])
})

test('actionable items come first, then by severity, then oldest first', () => {
  const items = buildAttention(input({
    me: 'entity-ana',
    decisions: [
      decision({ id: 'low-new', riskLevel: 2, createdAt: '2026-10-03T11:00:00Z' }),
      decision({ id: 'high', riskLevel: 4, createdAt: '2026-10-03T11:30:00Z', why: why('needs-approval', 4) }),
      decision({ id: 'low-old', riskLevel: 2, createdAt: '2026-10-03T09:00:00Z' }),
      decision({ id: 'mine', requestedBy: 'entity-ana' }),
    ],
    fingerprints: {},
  }))
  assert.deepEqual(items.map((i) => i.id.split(':')[1]), ['high', 'low-old', 'low-new', 'mine'])
})

test('the badge is incomplete when a source could not be checked, so a zero is never silent', () => {
  const items = buildAttention(input({ decisions: [] }))
  assert.deepEqual(attentionCounts(items, [{ id: 'decisions', status: 'unavailable', reason: 'Sanity is not configured.' }]), { actionable: 0, other: 0, complete: false })
  assert.equal(attentionCounts(items, [{ id: 'traces', status: 'skipped' }, { id: 'decisions', status: 'ok' }]).complete, true)
})

test('every call an item offers is a path the console may send credentials to', async () => {
  const { mayCarryConsoleToken } = await import('./console-auth.ts')
  const items = buildAttention(input({ decisions: [decision(), decision({ id: 'd2', status: 'approved' })], fingerprints: { 'decision-1': FP, d2: FP } }))
  const calls = items.flatMap((i) => i.actions.flatMap((a) => (a.call ? [a.call.path] : [])))
  assert.ok(calls.length >= 3)
  for (const path of calls) assert.equal(mayCarryConsoleToken(path), true, path)
})
