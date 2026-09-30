import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedNetUsd, summarizeDecisions } from './business-dashboard.ts'

test('business overview counts approval, completed, blocked, and failed decisions without double-counting blocked outcomes', () => {
  assert.deepEqual(summarizeDecisions([
    { id: 'a', title: 'Approve campaign', status: 'awaiting-approval', riskLevel: 3, requiredApproval: true, safetyDecision: 'ESCALATE', createdAt: null },
    { id: 'b', title: 'Launch experiment', status: 'executed', riskLevel: 1, requiredApproval: false, safetyDecision: 'ALLOW', createdAt: null },
    { id: 'c', title: 'Unsafe export', status: 'rejected', riskLevel: 4, requiredApproval: true, safetyDecision: 'BLOCK', createdAt: null },
    { id: 'd', title: 'Provider error', status: 'failed', riskLevel: 1, requiredApproval: false, safetyDecision: 'ALLOW', createdAt: null },
  ]), { total: 4, awaitingApproval: 1, approved: 0, executed: 1, blocked: 1, failed: 1 })
})

test('ledger net uses recorded entries only and does not imply payment processor reconciliation', () => {
  assert.equal(recordedNetUsd({ entryCount: 4, spendUsd: 35, computeUsd: 5, revenueUsd: 100, refundsUsd: 4 }), 64)
  assert.equal(recordedNetUsd({ entryCount: 0, spendUsd: 0, computeUsd: 0, revenueUsd: 0, refundsUsd: 0 }), 0)
})
