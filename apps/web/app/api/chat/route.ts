/**
 * POST /api/chat — the chat assistant. It answers questions about the app and the company by
 * reading, as the person asking: every tool it uses is one of the app's own read routes, run with
 * that person's credentials (lib/chat-app-fetch.ts). It cannot approve, execute or change anything.
 *
 * Request body: { message: string, history?: [{ question, answer }] }   (the last six turns are used)
 * Response:     { answer, links[], confidence, audit, telemetry, nqc }
 */

import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { safeErrorName } from '@/lib/safe-log'
import { APP_TOOL_NAMES, askAssistant, buildAppTools, estimateModelCostUsd } from '@quicksilver/agent'
import { evaluateNqcRequest } from '@quicksilver/kernel'
import { appFetchFor } from '@/lib/chat-app-fetch'
import { persistEvaluations } from '@/lib/evaluation-store'
import { guardWebRoute } from '@/lib/route-guard'
import { persistTraceSpans } from '@/lib/telemetry-store'
import type { TraceSpanInput } from '@/lib/telemetry'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const requester = await guardWebRoute(req, 'chat')
  if (!requester.ok) return NextResponse.json(requester.body, { status: requester.status, headers: requester.headers })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { message, history } = (body ?? {}) as { message?: unknown; history?: unknown }
  if (typeof message !== 'string' || message.trim().length < 2 || message.length > 2_000) {
    return NextResponse.json({ error: 'message must be a string of 2 to 2,000 characters.' }, { status: 400 })
  }
  const turns = Array.isArray(history)
    ? history.slice(-6).filter((t): t is { question: string; answer: string } => !!t && typeof t === 'object' && typeof (t as { question?: unknown }).question === 'string' && typeof (t as { answer?: unknown }).answer === 'string')
    : []

  const traceId = randomUUID()
  const requestSpanId = randomUUID()
  const startedAt = Date.now()
  try {
    const fetchApp = appFetchFor(req)
    const result = await askAssistant(message, { history: turns, buildAppTools: (callLog) => buildAppTools(fetchApp, callLog), signal: req.signal })
    const modelSpanId = randomUUID()
    const governance = evaluateNqcRequest({
      agentId: 'nuera-quicksilver:assistant',
      taskType: 'reasoning',
      modelId: result.modelId,
      agentOutput: JSON.stringify({ answer: result.answer, links: result.links }),
      context: result.toolCalls.map((call) => call.name),
      toolCalls: result.toolCalls,
      impactLevel: 'low',
    })
    const audit = await persistEvaluations([{
      source: 'query', agentId: 'nuera-quicksilver:assistant', taskType: 'reasoning', modelId: result.modelId,
      subject: message, requestedBy: requester.principalId, evaluation: governance,
    }])
    const completedAt = Date.now()
    const spans: TraceSpanInput[] = [
      { traceId, spanId: requestSpanId, source: 'query', kind: 'request', name: 'chat.request', status: governance.safetyDecision === 'ALLOW' ? 'ok' : 'blocked', startedAt, durationMs: completedAt - startedAt, requestedBy: requester.principalId, agentId: 'nuera-quicksilver:assistant' },
      { traceId, spanId: modelSpanId, parentSpanId: requestSpanId, source: 'query', kind: 'model', name: 'chat.model', status: 'ok', startedAt, durationMs: completedAt - startedAt, requestedBy: requester.principalId, agentId: 'nuera-quicksilver:assistant', modelId: result.modelId, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens, estimatedCostUsd: estimateModelCostUsd(result.modelId, result.usage.totalTokens) },
      ...result.toolCalls.map((call): TraceSpanInput => ({ traceId, parentSpanId: modelSpanId, source: 'query', kind: 'tool', name: APP_TOOL_NAMES.includes(call.name) ? 'chat.app-tool' : 'chat.tool', status: call.succeeded ? 'ok' : 'error', startedAt: Math.max(startedAt, completedAt - (call.durationMs ?? 0)), durationMs: call.durationMs ?? 0, requestedBy: requester.principalId, agentId: 'nuera-quicksilver:assistant', toolName: call.name, toolSucceeded: call.succeeded })),
      { traceId, parentSpanId: requestSpanId, source: 'query', kind: 'evaluation', name: 'nqc.evaluation', status: governance.safetyDecision === 'ALLOW' ? 'ok' : 'blocked', startedAt: completedAt, durationMs: 0, requestedBy: requester.principalId, agentId: 'nuera-quicksilver:assistant', modelId: result.modelId, safetyDecision: governance.safetyDecision },
    ]
    const telemetry = await persistTraceSpans(spans)
    return NextResponse.json({
      answer: result.answer,
      links: result.links,
      confidence: result.confidence,
      toolsUsed: [...new Set(result.toolCalls.map((call) => call.name))],
      audit: { persisted: audit.persisted, evaluationRecordIds: audit.ids, ...(audit.error ? { error: audit.error } : {}) },
      telemetry: { traceId, persisted: telemetry.persisted },
      nqc: { reasoningScore: governance.reasoningScore, hallucinationRisk: governance.hallucinationRisk, brittleness: governance.brittleness, issues: governance.issues, corrections: governance.corrections, safetyDecision: governance.safetyDecision },
    })
  } catch (err) {
    console.error('[/api/chat]', safeErrorName(err))
    const telemetry = await persistTraceSpans([{ traceId, spanId: requestSpanId, source: 'query', kind: 'request', name: 'chat.request', status: 'error', startedAt, durationMs: Date.now() - startedAt, requestedBy: requester.principalId }])
    return NextResponse.json({ error: 'Chat failed', detail: safeErrorName(err), telemetry: { traceId, persisted: telemetry.persisted } }, { status: 500 })
  }
}
