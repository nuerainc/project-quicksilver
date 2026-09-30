import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientProviderFailure, withMeasuredProviderFallback } from './provider-fallback.ts'

test('provider fallback is limited to explicit retryable and transient HTTP failures', () => {
  assert.equal(isTransientProviderFailure({ isRetryable: true }), true)
  assert.equal(isTransientProviderFailure({ statusCode: 429 }), true)
  assert.equal(isTransientProviderFailure({ status: 503 }), true)
  assert.equal(isTransientProviderFailure({ statusCode: 400 }), false)
  assert.equal(isTransientProviderFailure(new Error('bad request')), false)
})

test('measured fallback tries the selected model, then ordered eligible alternatives', async () => {
  const prior = {
    mode: process.env.QUICKSILVER_MODEL_MODE,
    override: process.env.QUICKSILVER_REVIEWER_MODEL,
    config: process.env.QUICKSILVER_ROUTING_CONFIG,
  }
  process.env.QUICKSILVER_MODEL_MODE = 'local'
  delete process.env.QUICKSILVER_REVIEWER_MODEL
  process.env.QUICKSILVER_ROUTING_CONFIG = JSON.stringify({ profiles: [
    { modelId: 'first', supportedTasks: ['evaluation'], taskAccuracy: { evaluation: 0.95 }, successRate: 0.9, averageCostPer1kTokens: 0.1, p95LatencyMs: 100, available: true },
    { modelId: 'second', supportedTasks: ['evaluation'], taskAccuracy: { evaluation: 0.9 }, successRate: 0.9, averageCostPer1kTokens: 0.1, p95LatencyMs: 100, available: true },
    { modelId: 'ineligible', supportedTasks: ['evaluation'], taskAccuracy: { evaluation: 0.4 }, successRate: 1, averageCostPer1kTokens: 0, p95LatencyMs: 1, available: true },
  ] })
  try {
    const attempted: string[] = []
    const result = await withMeasuredProviderFallback('reviewer', async (model) => {
      const id = (model as { modelId?: string }).modelId ?? ''
      attempted.push(id)
      if (attempted.length === 1) throw { statusCode: 503 }
      return id
    })
    assert.deepEqual(attempted, ['first', 'second'])
    assert.equal(result, 'second')
  } finally {
    if (prior.mode === undefined) delete process.env.QUICKSILVER_MODEL_MODE
    else process.env.QUICKSILVER_MODEL_MODE = prior.mode
    if (prior.override === undefined) delete process.env.QUICKSILVER_REVIEWER_MODEL
    else process.env.QUICKSILVER_REVIEWER_MODEL = prior.override
    if (prior.config === undefined) delete process.env.QUICKSILVER_ROUTING_CONFIG
    else process.env.QUICKSILVER_ROUTING_CONFIG = prior.config
  }
})

test('non-transient failures do not trigger a measured fallback', async () => {
  const prior = {
    mode: process.env.QUICKSILVER_MODEL_MODE,
    override: process.env.QUICKSILVER_REVIEWER_MODEL,
    config: process.env.QUICKSILVER_ROUTING_CONFIG,
  }
  process.env.QUICKSILVER_MODEL_MODE = 'local'
  delete process.env.QUICKSILVER_REVIEWER_MODEL
  process.env.QUICKSILVER_ROUTING_CONFIG = JSON.stringify({ profiles: [
    { modelId: 'first', supportedTasks: ['evaluation'], taskAccuracy: { evaluation: 0.95 }, successRate: 0.9, averageCostPer1kTokens: 0.1, p95LatencyMs: 100, available: true },
    { modelId: 'second', supportedTasks: ['evaluation'], taskAccuracy: { evaluation: 0.9 }, successRate: 0.9, averageCostPer1kTokens: 0.1, p95LatencyMs: 100, available: true },
  ] })
  try {
    let calls = 0
    await assert.rejects(withMeasuredProviderFallback('reviewer', async () => {
      calls += 1
      throw { statusCode: 400 }
    }))
    assert.equal(calls, 1)
  } finally {
    if (prior.mode === undefined) delete process.env.QUICKSILVER_MODEL_MODE
    else process.env.QUICKSILVER_MODEL_MODE = prior.mode
    if (prior.override === undefined) delete process.env.QUICKSILVER_REVIEWER_MODEL
    else process.env.QUICKSILVER_REVIEWER_MODEL = prior.override
    if (prior.config === undefined) delete process.env.QUICKSILVER_ROUTING_CONFIG
    else process.env.QUICKSILVER_ROUTING_CONFIG = prior.config
  }
})
