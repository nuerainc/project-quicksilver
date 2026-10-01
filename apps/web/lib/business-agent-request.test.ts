import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBusinessAgentRequest, selectBusinessAgent } from './business-agent-request.ts'

test('business agent chat accepts only a known specialist and a bounded objective', () => {
  assert.deepEqual(parseBusinessAgentRequest({ agentKey: 'finance', objective: 'Review our cash position.' }), {
    agentKey: 'finance', objective: 'Review our cash position.',
  })
  for (const value of [null, [], {}, { agentKey: 'unknown', objective: 'Help me' }, { agentKey: 'sales', objective: 'x' }, { agentKey: 'sales', objective: 'x'.repeat(2_001) }, { agentKey: 'sales', objective: 'Help me', approverId: 'forged' }]) {
    assert.equal(parseBusinessAgentRequest(value), null)
  }
})

test('business agent context is bounded and malformed input is refused', () => {
  assert.deepEqual(parseBusinessAgentRequest({ agentKey: 'research', objective: 'Research the market', context: ['internal brief'] }), {
    agentKey: 'research', objective: 'Research the market', context: ['internal brief'],
  })
  assert.equal(parseBusinessAgentRequest({ agentKey: 'research', objective: 'Research', context: Array(21).fill('x') }), null)
  assert.equal(parseBusinessAgentRequest({ agentKey: 'research', objective: 'Research', context: ['x'.repeat(4_001)] }), null)
  assert.equal(parseBusinessAgentRequest({ agentKey: 'research', objective: 'Research', context: ['ok', 7] }), null)
})

test('automatic specialist routing is transparent and only selects a proposal-only business domain', () => {
  assert.deepEqual(selectBusinessAgent('Please reduce our operating costs this month.'), {
    key: 'finance', mode: 'keyword', reason: 'Matched finance wording.',
  })
  assert.deepEqual(selectBusinessAgent('Help me improve the delivery backlog.'), {
    key: 'fulfillment', mode: 'keyword', reason: 'Matched delivery or operations wording.',
  })
  assert.deepEqual(selectBusinessAgent('Help me think through this.'), {
    key: 'research', mode: 'fallback', reason: 'No specialist phrase matched; routed to Research as the read-only default.',
  })
})
