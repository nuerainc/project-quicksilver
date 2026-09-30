import { createHash, randomUUID } from 'node:crypto'

export type TraceSource = 'query' | 'plan' | 'workflow' | 'decision'
export type TraceKind = 'request' | 'model' | 'tool' | 'evaluation' | 'decision' | 'workflow'
export type TraceStatus = 'ok' | 'error' | 'blocked'

/** Deliberately excludes prompts, outputs, tool arguments, and arbitrary attributes. */
export interface TraceSpanInput {
  traceId: string
  spanId?: string
  parentSpanId?: string | null
  source: TraceSource
  kind: TraceKind
  name: string
  status: TraceStatus
  startedAt: number
  durationMs: number
  requestedBy: string
  runId?: string | null
  workflowId?: string | null
  decisionId?: string | null
  agentId?: string | null
  modelId?: string | null
  toolName?: string | null
  toolSucceeded?: boolean | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  estimatedCostUsd?: number | null
  safetyDecision?: 'ALLOW' | 'BLOCK' | 'ESCALATE' | null
}

export interface TraceSpan extends TraceSpanInput {
  spanId: string
  parentSpanId: string | null
  runId: string | null
  workflowId: string | null
  decisionId: string | null
  agentId: string | null
  modelId: string | null
  toolName: string | null
  toolSucceeded: boolean | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
}

export interface TraceSpanDocument extends Omit<TraceSpan, 'startedAt'> {
  _id: string
  _type: 'telemetryTraceSpan'
  tenantId: string
  startedAt: string
  completedAt: string
}

const token = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null

export function buildTraceSpan(input: TraceSpanInput, tenantId = 'default'): TraceSpanDocument {
  if (!input || typeof input !== 'object' || !/^[a-f0-9-]{16,64}$/i.test(input.traceId)) throw new Error('Trace id is invalid.')
  if (!['query', 'plan', 'workflow', 'decision'].includes(input.source)) throw new Error('Trace source is invalid.')
  if (!['request', 'model', 'tool', 'evaluation', 'decision', 'workflow'].includes(input.kind)) throw new Error('Trace span kind is invalid.')
  if (!['ok', 'error', 'blocked'].includes(input.status)) throw new Error('Trace status is invalid.')
  if (typeof input.name !== 'string' || !/^[a-z][a-z0-9._:-]{0,95}$/i.test(input.name)) throw new Error('Trace span name is invalid.')
  if (!Number.isFinite(input.startedAt) || input.startedAt < 0 || Number.isNaN(new Date(input.startedAt).getTime()) || !Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 86_400_000) throw new Error('Trace timing is invalid.')
  if (typeof input.requestedBy !== 'string' || input.requestedBy.length < 1 || input.requestedBy.length > 256) throw new Error('Trace requester is invalid.')
  if (typeof tenantId !== 'string' || tenantId.length < 1 || tenantId.length > 128) throw new Error('Trace tenant is invalid.')
  if (input.estimatedCostUsd !== undefined && input.estimatedCostUsd !== null && (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0)) throw new Error('Estimated cost is invalid.')
  const spanId = input.spanId ?? randomUUID()
  if (!/^[a-f0-9-]{16,64}$/i.test(spanId)) throw new Error('Span id is invalid.')
  const completedAt = new Date(input.startedAt + input.durationMs).toISOString()
  const id = createHash('sha256').update(`${tenantId}\0${input.traceId}\0${spanId}`).digest('hex')
  return {
    _id: `telemetry-span-${id}`,
    _type: 'telemetryTraceSpan',
    tenantId,
    traceId: input.traceId,
    spanId,
    parentSpanId: input.parentSpanId ?? null,
    source: input.source,
    kind: input.kind,
    name: input.name,
    status: input.status,
    startedAt: new Date(input.startedAt).toISOString(),
    completedAt,
    durationMs: Math.floor(input.durationMs),
    requestedBy: input.requestedBy,
    runId: input.runId ?? null,
    workflowId: input.workflowId ?? null,
    decisionId: input.decisionId ?? null,
    agentId: input.agentId ?? null,
    modelId: input.modelId ?? null,
    toolName: input.toolName ?? null,
    toolSucceeded: input.toolSucceeded ?? null,
    inputTokens: token(input.inputTokens),
    outputTokens: token(input.outputTokens),
    totalTokens: token(input.totalTokens),
    estimatedCostUsd: input.estimatedCostUsd ?? null,
    safetyDecision: input.safetyDecision ?? null,
  }
}

export interface TelemetryAlert {
  id: 'tool-failure' | 'safety-block' | 'run-failure-rate' | 'estimated-cost'
  severity: 'warning' | 'critical'
  summary: string
  spanIds: string[]
}

export interface TelemetryAlertThresholds {
  now: number
  windowMs: number
  minimumRuns: number
  maximumRunFailureRate: number
  maximumEstimatedCostUsd: number
}

export function evaluateTelemetryAlerts(spans: TraceSpan[], thresholds: TelemetryAlertThresholds): TelemetryAlert[] {
  const start = thresholds.now - thresholds.windowMs
  const recent = spans.filter((span) => span.startedAt >= start && span.startedAt <= thresholds.now)
  const alerts: TelemetryAlert[] = []
  const failedTools = recent.filter((span) => span.kind === 'tool' && (span.toolSucceeded === false || span.status === 'error'))
  if (failedTools.length) alerts.push({ id: 'tool-failure', severity: 'warning', summary: `${failedTools.length} tool call(s) failed in the selected window.`, spanIds: failedTools.map((span) => span.spanId) })
  const blocked = recent.filter((span) => span.kind === 'evaluation' && (span.safetyDecision === 'BLOCK' || span.safetyDecision === 'ESCALATE'))
  if (blocked.length) alerts.push({ id: 'safety-block', severity: 'critical', summary: `${blocked.length} evaluation(s) blocked or escalated for human review.`, spanIds: blocked.map((span) => span.spanId) })
  const runs = recent.filter((span) => span.kind === 'request' || span.kind === 'workflow')
  const failedRuns = runs.filter((span) => span.status === 'error' || span.status === 'blocked')
  if (runs.length >= thresholds.minimumRuns && failedRuns.length / runs.length > thresholds.maximumRunFailureRate) {
    alerts.push({ id: 'run-failure-rate', severity: 'critical', summary: `Run failure rate is ${Math.round(failedRuns.length / runs.length * 100)}% across ${runs.length} runs.`, spanIds: failedRuns.map((span) => span.spanId) })
  }
  const estimatedCost = recent.reduce((sum, span) => sum + (span.estimatedCostUsd ?? 0), 0)
  if (thresholds.maximumEstimatedCostUsd > 0 && estimatedCost > thresholds.maximumEstimatedCostUsd) {
    alerts.push({ id: 'estimated-cost', severity: 'warning', summary: `Estimated model cost is $${estimatedCost.toFixed(4)} for the selected window.`, spanIds: recent.filter((span) => span.estimatedCostUsd !== null).map((span) => span.spanId) })
  }
  return alerts
}
