/**
 * Model-role resolution tests. No network: models are constructed, never called.
 *
 * Run with:   npm run agent:test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AZURE_DEPLOYMENTS,
  getMode,
  isLlmConfigured,
  languageModelForId,
  modelForRole,
  resolveId,
  type MeasuredRoutingConfig,
} from './models.ts'

const ENV_KEYS = [
  'AZURE_API_KEY',
  'AZURE_RESOURCE_NAME',
  'AZURE_DEPLOYMENT',
  'AZURE_API_MODE',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'QUICKSILVER_MODEL_MODE',
  'QUICKSILVER_PLANNER_MODEL',
  'QUICKSILVER_REVIEWER_MODEL',
  'QUICKSILVER_ROUTER_MODEL',
  'QUICKSILVER_EXECUTOR_MODEL',
  'QUICKSILVER_ROUTING_CONFIG',
] as const

/** Run `fn` with exactly `env` set (all other model-related vars cleared), then restore. */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  try {
    for (const k of ENV_KEYS) delete process.env[k]
    Object.assign(process.env, env)
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const AZURE = { AZURE_API_KEY: 'test-key', AZURE_RESOURCE_NAME: 'demo-resource' }

test('Mode: azure credentials select azure mode, and win over direct provider keys', () => {
  withEnv(AZURE, () => assert.equal(getMode(), 'azure'))
  withEnv({ ...AZURE, OPENAI_API_KEY: 'sk-test' }, () => assert.equal(getMode(), 'azure'))
})

test('Mode: azure needs BOTH key and resource name to auto-select', () => {
  withEnv({ AZURE_API_KEY: 'test-key' }, () => assert.equal(getMode(), 'local'))
  withEnv({ AZURE_RESOURCE_NAME: 'demo-resource' }, () => assert.equal(getMode(), 'local'))
})

test('Mode: direct provider key -> cloud, nothing -> local, QUICKSILVER_MODEL_MODE forces', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () => assert.equal(getMode(), 'cloud'))
  withEnv({}, () => assert.equal(getMode(), 'local'))
  withEnv({ ...AZURE, QUICKSILVER_MODEL_MODE: 'cloud' }, () => assert.equal(getMode(), 'cloud'))
})

test('Deployments: default to qs-<role>; AZURE_DEPLOYMENT and per-role env override in that order', () => {
  withEnv(AZURE, () => {
    assert.deepEqual(
      (['planner', 'reviewer', 'router', 'executor'] as const).map((r) => resolveId(r, 'azure')),
      ['qs-planner', 'qs-reviewer', 'qs-router', 'qs-executor'],
    )
    assert.equal(AZURE_DEPLOYMENTS.planner, 'qs-planner')
  })
  withEnv({ ...AZURE, AZURE_DEPLOYMENT: 'shared' }, () => {
    assert.equal(resolveId('planner', 'azure'), 'shared')
    assert.equal(resolveId('router', 'azure'), 'shared')
  })
  withEnv({ ...AZURE, AZURE_DEPLOYMENT: 'shared', QUICKSILVER_REVIEWER_MODEL: 'my-reviewer' }, () => {
    assert.equal(resolveId('reviewer', 'azure'), 'my-reviewer')
    assert.equal(resolveId('planner', 'azure'), 'shared')
  })
})

test('Azure models are AI SDK 6-compatible (spec v3), not the v1/v4 skew that broke before', () => {
  withEnv(AZURE, () => {
    for (const role of ['planner', 'reviewer', 'router', 'executor'] as const) {
      const m = modelForRole(role) as { specificationVersion?: string; modelId?: string; provider?: string }
      assert.equal(m.specificationVersion, 'v3', `${role} must be a v3 model`)
      assert.equal(m.modelId, AZURE_DEPLOYMENTS[role])
      assert.match(String(m.provider), /^azure/)
    }
  })
})

test('Azure: AZURE_API_MODE=chat switches to the Chat Completions API', () => {
  withEnv({ ...AZURE, AZURE_API_MODE: 'chat' }, () => {
    assert.match(String((modelForRole('planner') as { provider?: string }).provider), /chat/)
  })
})

test('Azure mode without credentials fails with an actionable message', () => {
  withEnv({ QUICKSILVER_MODEL_MODE: 'azure' }, () => {
    assert.throws(() => modelForRole('planner'), /AZURE_API_KEY and AZURE_RESOURCE_NAME/)
  })
})

test('Cloud and local providers also produce spec v3 models (Claude/Ollama used to be v1)', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test', GOOGLE_GENERATIVE_AI_API_KEY: 'g-test' }, () => {
    for (const id of ['claude-sonnet-5', 'gpt-5.6-sol', 'gemini-3.8-flash']) {
      assert.equal((languageModelForId(id, 'cloud') as { specificationVersion?: string }).specificationVersion, 'v3', id)
    }
  })
  withEnv({}, () => {
    assert.equal((languageModelForId('qwen2.5:7b', 'local') as { specificationVersion?: string }).specificationVersion, 'v3')
  })
})

test('Cloud mode rejects unrecognized ids instead of silently routing them to Ollama', () => {
  withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
    assert.throws(() => languageModelForId('qs-planner', 'cloud'), /Unrecognized model id/)
  })
})

test('isLlmConfigured: azure, direct key, or explicit local opt-in', () => {
  withEnv({}, () => assert.equal(isLlmConfigured(), false))
  withEnv(AZURE, () => assert.equal(isLlmConfigured(), true))
  withEnv({ GOOGLE_GENERATIVE_AI_API_KEY: 'g' }, () => assert.equal(isLlmConfigured(), true))
  withEnv({ QUICKSILVER_MODEL_MODE: 'local' }, () => assert.equal(isLlmConfigured(), true))
})

test('Measured routing: selects the measured profile for the actual role dispatch model', () => {
  const config: MeasuredRoutingConfig = {
    profiles: [
      { modelId: 'gpt-5.6-sol', supportedTasks: ['planning'], taskAccuracy: { planning: 0.7 }, successRate: 0.95, averageCostPer1kTokens: 0.01, p95LatencyMs: 2000, available: true },
      { modelId: 'claude-sonnet-5', supportedTasks: ['planning'], taskAccuracy: { planning: 0.95 }, successRate: 0.98, averageCostPer1kTokens: 0.02, p95LatencyMs: 1500, available: true },
    ],
  }
  withEnv({ OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test' }, () => {
    const model = modelForRole('planner', 'cloud', config) as { modelId?: string }
    assert.equal(model.modelId, 'claude-sonnet-5')
  })
})

test('Measured routing: per-role override remains authoritative over profiles', () => {
  const config: MeasuredRoutingConfig = {
    profiles: [{ modelId: 'claude-sonnet-5', supportedTasks: ['planning'], taskAccuracy: { planning: 0.99 }, successRate: 1, averageCostPer1kTokens: 0, p95LatencyMs: 1, available: true }],
  }
  withEnv({ OPENAI_API_KEY: 'test', QUICKSILVER_PLANNER_MODEL: 'gpt-5.6-sol' }, () => {
    const model = modelForRole('planner', 'cloud', config) as { modelId?: string }
    assert.equal(model.modelId, 'gpt-5.6-sol')
  })
})

test('Measured routing: configured policy fails closed when no profile meets constraints', () => {
  const config: MeasuredRoutingConfig = {
    profiles: [{ modelId: 'gpt-5.6-sol', supportedTasks: ['planning'], taskAccuracy: { planning: 0.5 }, successRate: 1, averageCostPer1kTokens: 0, p95LatencyMs: 1, available: true }],
    requests: { planner: { minimumAccuracy: 0.9 } },
  }
  withEnv({ OPENAI_API_KEY: 'test' }, () => {
    assert.throws(() => modelForRole('planner', 'cloud', config), /Measured model routing refused planner dispatch/)
  })
})

test('Measured routing: environment configuration is parsed and malformed profiles are rejected', () => {
  const profile = { modelId: 'gpt-5.6-sol', supportedTasks: ['planning'], taskAccuracy: { planning: 0.9 }, successRate: 1, averageCostPer1kTokens: 0, p95LatencyMs: 1, available: true }
  withEnv({ OPENAI_API_KEY: 'test', QUICKSILVER_ROUTING_CONFIG: JSON.stringify({ profiles: [profile] }) }, () => {
    assert.equal((modelForRole('planner') as { modelId?: string }).modelId, 'gpt-5.6-sol')
  })
  withEnv({ OPENAI_API_KEY: 'test', QUICKSILVER_ROUTING_CONFIG: '{' }, () => {
    assert.throws(() => modelForRole('planner'), /must be valid JSON/)
  })
  withEnv({ OPENAI_API_KEY: 'test', QUICKSILVER_ROUTING_CONFIG: JSON.stringify({ profiles: [{ ...profile, successRate: 'high' }] }) }, () => {
    assert.throws(() => modelForRole('planner'), /invalid model performance profile/)
  })
})
