import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { PendingEvaluation } from './evaluation-store.ts'

register('./route-test-loader.mjs', import.meta.url)
const { persistEvaluationRecords } = await import('./evaluation-store.ts')

const pending: PendingEvaluation = {
  source: 'query', agentId: 'nq-query', taskType: 'reasoning', modelId: 'test-model',
  subject: 'What changed?', requestedBy: 'human-1',
  evaluation: {
    agentId: 'nq-query', evaluation: {} as PendingEvaluation['evaluation']['evaluation'],
    reasoningScore: 0.9, hallucinationRisk: 'low', brittleness: 'low', issues: [],
    corrections: [], safetyDecision: 'ALLOW', routingUpdate: null, memoryUpdates: [],
  } as PendingEvaluation['evaluation'],
}

test('evaluation persistence: empty writes succeed without opening a writer', async () => {
  let called = false
  const result = await persistEvaluationRecords([], async () => { called = true })
  assert.deepEqual(result, { persisted: true, ids: [] })
  assert.equal(called, false)
})

test('evaluation persistence: reports stored ids and writes records without private reasoning', async () => {
  let written: unknown[] = []
  const result = await persistEvaluationRecords([pending], async (docs) => { written = docs })
  assert.equal(result.persisted, true)
  assert.equal(result.ids.length, 1)
  const record = written[0] as Record<string, unknown>
  assert.equal(record._type, 'evaluationRecord')
  assert.equal('reasoningTrace' in record, false)
  assert.equal('chainOfThought' in record, false)
})

test('evaluation persistence: failed audit writes are explicit and return no false ids', async () => {
  const warnings: unknown[] = []
  const result = await persistEvaluationRecords([pending], async () => { throw new Error('store offline') }, (_message, error) => warnings.push(error))
  assert.deepEqual(result, { persisted: false, ids: [], error: 'The evaluation could not be saved to the audit store.' })
  assert.equal((warnings[0] as Error).message, 'store offline')
})
