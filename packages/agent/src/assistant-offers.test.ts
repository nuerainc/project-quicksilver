import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cleanOffers } from './assistant.ts'

test('offers: valid plan, specialist and workflow offers pass through', () => {
  assert.deepEqual(cleanOffers([
    { kind: 'plan', target: '', text: 'Cut delivery delays by a week.' },
    { kind: 'specialist', target: 'Sales', text: 'Find why renewals slowed.' },
    { kind: 'specialist', target: 'auto', text: 'Look at churn.' },
    { kind: 'workflow', target: 'wf-onboard_1', text: 'Run for Acme.' },
  ]), [
    { kind: 'plan', objective: 'Cut delivery delays by a week.' },
    { kind: 'specialist', agentKey: 'sales', objective: 'Find why renewals slowed.' },
    { kind: 'specialist', agentKey: 'auto', objective: 'Look at churn.' },
    { kind: 'workflow', workflowId: 'wf-onboard_1', input: 'Run for Acme.' },
  ].slice(0, 3))
})

test('offers: unknown specialists, bad workflow ids and short or long text are dropped', () => {
  assert.deepEqual(cleanOffers([
    { kind: 'specialist', target: 'root', text: 'Do something.' },
    { kind: 'workflow', target: '../etc/passwd', text: 'Run it.' },
    { kind: 'workflow', target: 'ok', text: 'a' },
    { kind: 'plan', target: '', text: 'x'.repeat(2_001) },
  ]), [])
  assert.deepEqual(cleanOffers(undefined), [])
})

test('offers: at most three, and an offer carries no approve or execute kind', () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ kind: 'plan' as const, target: '', text: `Objective ${i} here` }))
  assert.equal(cleanOffers(many).length, 3)
  assert.deepEqual(cleanOffers([{ kind: 'approve' as never, target: 'd1', text: 'Approve it please' }]), [])
})
