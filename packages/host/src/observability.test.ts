import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Logger, REDACTED, redact, redactValue } from './log.ts'
import { MetricsRegistry, createHostMetrics } from './metrics.ts'

function capture(level: 'debug' | 'info' = 'info') {
  const lines: string[] = []
  const log = new Logger({ level, sink: { write: (l) => lines.push(l) }, now: () => Date.parse('2026-10-01T00:00:00Z') })
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) }
}

test('logs are one JSON object per line with bindings and levels', () => {
  const { log, parsed } = capture()
  log.child({ service: 'host', runId: 'run_1' }).info('run finished', { status: 'completed' })
  log.debug('hidden at info level')
  const [entry, ...rest] = parsed()
  assert.equal(rest.length, 0)
  assert.deepEqual(entry, { time: '2026-10-01T00:00:00.000Z', level: 'info', msg: 'run finished', service: 'host', runId: 'run_1', status: 'completed' })
})

test('secrets are redacted by key, by credential shape, and by registered value', () => {
  const { log, lines } = capture()
  redactValue('hunter2-registered-secret')
  log.info('auth Bearer qs_abcdefghijklmnopqrstuvwxyz123456', {
    authorization: 'Bearer anything',
    nested: { apiKey: 'k', password: 'p', tokenDigest: 'sha256:abc', note: 'uses whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    list: ['hunter2-registered-secret'],
    error: new Error('failed with qs_abcdefghijklmnopqrstuvwxyz123456'),
  })
  const text = lines.join('\n')
  for (const leaked of ['qs_abcdefghijklmnopqrstuvwxyz', 'whsec_ABCDEFGHIJ', 'hunter2-registered-secret', '"p"', 'Bearer anything']) assert.ok(!text.includes(leaked), leaked)
  const entry = JSON.parse(lines[0]!)
  assert.equal(entry.authorization, REDACTED)
  assert.equal(entry.nested.tokenDigest, 'sha256:abc', 'digests are not credentials and stay visible')
  assert.equal(entry.error.message, `failed with ${REDACTED}`)
})

test('redact handles cycles and depth', () => {
  const a: Record<string, unknown> = { name: 'a' }
  a.self = a
  assert.deepEqual(redact(a), { name: 'a', self: '[circular]' })
})

test('metrics render Prometheus text with escaped labels, histograms and collectors', async () => {
  const registry = new MetricsRegistry()
  const c = registry.counter('qs_test_total', 'A counter.')
  c.inc({ route: 'GET /x', status: '200' })
  c.inc({ route: 'GET /x', status: '200' }, 2)
  c.inc({ note: 'quote " and \\ backslash' })
  assert.throws(() => c.inc({}, -1))
  assert.throws(() => c.inc({ 'bad-label': 'x' }))
  const h = registry.histogram('qs_latency_seconds', 'Latency.', [0.1, 1])
  h.observe({}, 0.05)
  h.observe({}, 0.5)
  h.observe({}, 5)
  const g = registry.gauge('qs_depth', 'Depth.')
  registry.onCollect(() => g.set({ status: 'queued' }, 7))
  registry.onCollect(() => { throw new Error('collector errors are ignored') })
  assert.throws(() => registry.counter('qs_test_total', 'dup'))
  const text = await registry.render()
  assert.match(text, /# TYPE qs_test_total counter/)
  assert.match(text, /qs_test_total\{route="GET \/x",status="200"\} 3/)
  assert.match(text, /qs_test_total\{note="quote \\" and \\\\ backslash"\} 1/)
  assert.match(text, /qs_latency_seconds_bucket\{le="0.1"\} 1/)
  assert.match(text, /qs_latency_seconds_bucket\{le="1"\} 2/)
  assert.match(text, /qs_latency_seconds_bucket\{le="\+Inf"\} 3/)
  assert.match(text, /qs_latency_seconds_count 3/)
  assert.match(text, /qs_depth\{status="queued"\} 7/)
})

test('the standard host metric set registers once per registry', () => {
  const m = createHostMetrics()
  m.runsFinished.inc({ status: 'completed', workflow: 'w' })
  assert.equal(m.runsFinished.get({ status: 'completed', workflow: 'w' }), 1)
  assert.throws(() => createHostMetrics(m.registry))
})
