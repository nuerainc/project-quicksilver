import assert from 'node:assert/strict'
import { test } from 'node:test'
import { presentBusinessAgentResult } from './business-agent-response.ts'

const output = { summary: 'Model output', recommendations: [{ proposal: 'Send the campaign', evidenceIds: ['brief-1'], confidence: 0.7, impact: 'moderate' as const }], unknowns: ['Approval status'], questions: ['Is this approved?'], externalEffects: ['Email customers'] }
const evaluation = (safetyDecision: 'ALLOW' | 'ESCALATE' | 'BLOCK') => ({ reasoningScore: 70, hallucinationRisk: 'low' as const, brittleness: 'low' as const, issues: ['review'], corrections: [], safetyDecision })

test('business specialist results are clearly marked as proposals even when allowed', () => {
  const result = presentBusinessAgentResult(output, evaluation('ALLOW'))
  assert.equal(result.summary, output.summary)
  assert.deepEqual(result.recommendations, output.recommendations)
  assert.equal(result.actionPolicy, 'proposal-only')
})

test('NQC BLOCK hides the model result and all proposed effects from chat', () => {
  const result = presentBusinessAgentResult(output, evaluation('BLOCK'))
  assert.equal(result.summary, 'The NQC Kernel blocked this specialist result from display.')
  assert.deepEqual(result.recommendations, [])
  assert.deepEqual(result.unknowns, [])
  assert.deepEqual(result.questions, [])
  assert.deepEqual(result.externalEffects, [])
  assert.equal(JSON.stringify(result).includes('Send the campaign'), false)
})

test('NQC ESCALATE remains labeled provisional but is not misrepresented as approval', () => {
  const result = presentBusinessAgentResult(output, evaluation('ESCALATE'))
  assert.deepEqual(result.recommendations, output.recommendations)
  assert.equal(result.nqc.safetyDecision, 'ESCALATE')
  assert.equal(result.actionPolicy, 'proposal-only')
})
