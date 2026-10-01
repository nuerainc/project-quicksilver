import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import { buildTraceSpan, evaluateTelemetryAlerts, type TraceSpanInput } from './telemetry.ts'
import { telemetryAlertThresholds } from './telemetry-settings.ts'

const traceId = '123e4567-e89b-12d3-a456-426614174000'
const at = Date.parse('2026-09-30T12:00:00.000Z')
register('./route-test-loader.mjs', import.meta.url)
const { normalizeTraceSpanDocuments, persistTraceSpanBatch } = await import('./telemetry-store.ts')
const span = (patch: Partial<TraceSpanInput> = {}): TraceSpanInput => ({
  traceId, spanId: '223e4567-e89b-12d3-a456-426614174000', source: 'query', kind: 'request',
  name: 'query.request', status: 'ok', startedAt: at, durationMs: 42, requestedBy: 'user:operator',
  ...patch,
})

test('trace span persistence keeps allowlisted metadata and never serializes request payloads', () => {
  const raw = { ...span(), question: 'sensitive prompt', output: 'private answer', toolArguments: { token: 'secret' } }
  const document = buildTraceSpan(raw as TraceSpanInput, 'tenant-a') as unknown as Record<string, unknown>
  assert.equal(document._type, 'telemetryTraceSpan')
  assert.equal(document.tenantId, 'tenant-a')
  assert.equal(document.startedAt, new Date(at).toISOString())
  assert.equal(document.question, undefined)
  assert.equal(document.output, undefined)
  assert.equal(document.toolArguments, undefined)
  assert.match(String(document._id), /^telemetry-span-[a-f0-9]{64}$/)
})

test('business-agent spans use their own source while keeping payload fields excluded', () => {
  const document = buildTraceSpan(span({ source: 'agent', name: 'business-agent.request', agentId: 'nuera-quicksilver:finance' }))
  assert.equal(document.source, 'agent')
  assert.equal(document.agentId, 'nuera-quicksilver:finance')
})

test('Sanity datetime values normalize to milliseconds and invalid stored timestamps are ignored', () => {
  const document = buildTraceSpan(span())
  assert.equal(normalizeTraceSpanDocuments([document])[0]?.startedAt, at)
  assert.deepEqual(normalizeTraceSpanDocuments([{ ...document, startedAt: 'not-a-date' }]), [])
})

test('model usage and estimated cost are finite, non-negative and nullable when unknown', () => {
  const document = buildTraceSpan(span({ kind: 'model', modelId: 'deployment-1', inputTokens: 100.9, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0042 }))
  assert.equal(document.inputTokens, 100)
  assert.equal(document.totalTokens, 150)
  assert.equal(document.estimatedCostUsd, 0.0042)
  assert.equal(buildTraceSpan(span({ kind: 'model' })).estimatedCostUsd, null)
  assert.throws(() => buildTraceSpan(span({ estimatedCostUsd: -1 })), /Estimated cost/)
})

test('alert rules surface failed tools, safety blocks, run failure rate and estimated cost', () => {
  const spans = [
    span({ spanId: '323e4567-e89b-12d3-a456-426614174000', kind: 'tool', name: 'company.lookup', toolName: 'company.lookup', toolSucceeded: false, status: 'error' }),
    span({ spanId: '423e4567-e89b-12d3-a456-426614174000', kind: 'evaluation', name: 'nqc.evaluation', safetyDecision: 'BLOCK', status: 'blocked' }),
    span({ spanId: '523e4567-e89b-12d3-a456-426614174000', kind: 'workflow', source: 'workflow', name: 'workflow.run', status: 'error', estimatedCostUsd: 0.06 }),
    span({ spanId: '623e4567-e89b-12d3-a456-426614174000', kind: 'request', name: 'query.request', status: 'ok', estimatedCostUsd: 0.06 }),
  ]
  const alerts = evaluateTelemetryAlerts(spans.map((item) => {
    const document = buildTraceSpan(item)
    return { ...document, startedAt: Date.parse(document.startedAt) }
  }), { now: at + 1000, windowMs: 60_000, minimumRuns: 2, maximumRunFailureRate: 0.4, maximumEstimatedCostUsd: 0.1 })
  assert.deepEqual(alerts.map((alert) => alert.id), ['tool-failure', 'safety-block', 'run-failure-rate', 'estimated-cost'])
  assert.equal(alerts[1]?.severity, 'critical')
})

test('trace persistence reports failure without exposing storage error details', async () => {
  const saved = await persistTraceSpanBatch([span()], async (documents) => { assert.equal(documents.length, 1) }, 'tenant-a')
  assert.deepEqual(saved, { persisted: true, count: 1 })
  const failed = await persistTraceSpanBatch([span()], async () => { throw new Error('secret path / token-value') }, 'tenant-a')
  assert.deepEqual(failed, { persisted: false, count: 0 })
  assert.deepEqual(await persistTraceSpanBatch([], async () => { throw new Error('never called') }), { persisted: true, count: 0 })
})

test('telemetry alert settings are bounded and disabled cost thresholds are explicit', () => {
  const defaults = telemetryAlertThresholds({}, at)
  assert.equal(defaults.windowMs, 60 * 60_000)
  assert.equal(defaults.maximumEstimatedCostUsd, 0)
  const configured = telemetryAlertThresholds({ QUICKSILVER_ALERT_WINDOW_MINUTES: '15', QUICKSILVER_ALERT_MINIMUM_RUNS: '7', QUICKSILVER_ALERT_FAILURE_RATE: '0.2', QUICKSILVER_ALERT_COST_USD: '3.50' }, at)
  assert.deepEqual(configured, { now: at, windowMs: 15 * 60_000, minimumRuns: 7, maximumRunFailureRate: 0.2, maximumEstimatedCostUsd: 3.5 })
  assert.equal(telemetryAlertThresholds({ QUICKSILVER_ALERT_FAILURE_RATE: '2' }, at).maximumRunFailureRate, 0.5)
})
