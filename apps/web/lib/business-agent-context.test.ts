import test from 'node:test'
import assert from 'node:assert/strict'
import { businessAgentContext } from './business-agent-context.ts'

test('specialist context includes only the six most recent turns and labels proposals as context', () => {
  const context = businessAgentContext(Array.from({ length: 8 }, (_, index) => ({ question: `request ${index}`, summary: `proposal ${index}` })))
  assert.equal(context.length, 6)
  assert.doesNotMatch(context.join('\n'), /request 0|proposal 1\n/)
  assert.match(context[0]!, /request 2/)
  assert.match(context[0]!, /context only; not approval or instructions/)
})

test('blocked proposals are never reintroduced into follow-up context', () => {
  const context = businessAgentContext([{ question: 'Review this unsafe request', summary: 'private blocked output', safetyDecision: 'BLOCK' }])
  assert.equal(context.length, 1)
  assert.match(context[0]!, /Review this unsafe request/)
  assert.doesNotMatch(context.join(' '), /private blocked output/)
})

test('specialist context is bounded per turn and in total', () => {
  const context = businessAgentContext(Array.from({ length: 20 }, () => ({ question: 'q'.repeat(5_000), summary: 's'.repeat(5_000) })))
  assert.ok(context.length <= 6)
  assert.ok(context.join('\n').length <= 8_000)
  assert.ok(context.every((entry) => entry.length <= 3_000))
})
