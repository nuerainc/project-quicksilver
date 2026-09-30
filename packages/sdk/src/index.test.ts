import assert from 'node:assert/strict'
import test from 'node:test'
import { QuicksilverApiError, QuicksilverClient } from './index.ts'

const graph = { nodes: [], edges: [] } as never

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const validation = { schemaVersion: 1, valid: true, errors: [], topologicalOrder: ['start'] }
const execution = {
  mode: 'simulation', externalEffectsEnabled: false, status: 'completed', outputs: {},
  steps: [{ nodeId: 'start', status: 'completed', safetyDecision: 'SKIPPED', retryAfterMs: 0 }],
}
const evaluation = {
  reasoningScore: 85, hallucinationRisk: 'low', brittleness: 'low', safetyDecision: 'ALLOW', issues: [], corrections: [],
}
const liveExecution = {
  mode: 'live-read-only', externalEffectsEnabled: false, status: 'completed', outputs: {}, steps: [], evaluations: { query: evaluation },
}

test('rejects cleartext API URLs outside loopback and allows loopback HTTP', () => {
  assert.throws(() => new QuicksilverClient({ baseUrl: 'http://api.example.com' }), /HTTPS/)
  assert.throws(() => new QuicksilverClient({ baseUrl: 'ftp://localhost:3000' }), /HTTPS/)
  assert.doesNotThrow(() => new QuicksilverClient({ baseUrl: 'http://localhost:3000' }))
  assert.doesNotThrow(() => new QuicksilverClient({ baseUrl: 'http://127.0.0.1:3000' }))
  assert.doesNotThrow(() => new QuicksilverClient({ baseUrl: 'http://[::1]:3000' }))
  assert.throws(() => new QuicksilverClient({ baseUrl: 'not a URL' }))
})

test('validateWorkflow sends a JSON POST and returns the validated contract', async () => {
  let request: RequestInit | undefined
  const client = new QuicksilverClient({ baseUrl: 'https://qs.example.com/', fetch: async (_url, init) => {
    request = init
    return response(validation)
  } })
  assert.deepEqual(await client.validateWorkflow(graph), validation)
  assert.equal(request?.method, 'POST')
  assert.equal(request?.headers && (request.headers as Record<string, string>)['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(request?.body)), { graph })
})

test('previewWorkflow accepts the simulation shape and rejects external effects or malformed step fields', async () => {
  const client = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => response(execution) })
  assert.equal((await client.previewWorkflow(graph)).steps[0]?.safetyDecision, 'SKIPPED')
  const invalid = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => response({
    ...execution, externalEffectsEnabled: true,
  }) })
  await assert.rejects(invalid.previewWorkflow(graph), QuicksilverApiError)
  const invalidRetry = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => response({
    ...execution, steps: [{ nodeId: 'x', status: 'failed', retryAfterMs: -1 }],
  }) })
  await assert.rejects(invalidRetry.previewWorkflow(graph), /invalid workflow simulation response/)
})

test('read-only run validates NQC evaluations and forwards AbortSignal', async () => {
  const controller = new AbortController()
  let forwarded: AbortSignal | undefined
  const client = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async (_url, init) => {
    forwarded = init?.signal as AbortSignal
    return response(liveExecution)
  } })
  assert.equal((await client.runReadOnlyWorkflow(graph, 'hello', { signal: controller.signal })).mode, 'live-read-only')
  assert.equal(forwarded, controller.signal)
  const invalid = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => response({
    ...liveExecution, evaluations: { query: { ...evaluation, reasoningScore: 'high' } },
  }) })
  await assert.rejects(invalid.runReadOnlyWorkflow(graph, 'hello'), /invalid read-only workflow run response/)
  const outOfRange = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => response({
    ...liveExecution, evaluations: { query: { ...evaluation, reasoningScore: 101 } },
  }) })
  await assert.rejects(outOfRange.runReadOnlyWorkflow(graph, 'hello'), /invalid read-only workflow run response/)
})

test('HTTP failures preserve structured details and use a safe fallback for malformed bodies', async () => {
  const client = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => response({ error: 'denied' }, 403) })
  await assert.rejects(client.validateWorkflow(graph), (error: unknown) => {
    assert.ok(error instanceof QuicksilverApiError)
    assert.equal(error.status, 403)
    assert.deepEqual(error.responseBody, { error: 'denied' })
    assert.equal(error.message, 'denied')
    return true
  })
  const malformed = new QuicksilverClient({ baseUrl: 'https://qs.example.com', fetch: async () => new Response('not json', { status: 502 }) })
  await assert.rejects(malformed.validateWorkflow(graph), /status 502/)
})
