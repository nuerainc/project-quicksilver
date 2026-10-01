import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { BUSINESS_AGENT_DEFINITIONS, businessAgents, estimateModelCostUsd, executeGovernedAgent, type BusinessAgentInput, type BusinessAgentKey, type BusinessAgentOutput, type NueraQuicksilverAgent } from '@quicksilver/agent'
import { persistEvaluations } from '@/lib/evaluation-store'
import { parseBusinessAgentRequest, selectBusinessAgent } from '@/lib/business-agent-request'
import { presentBusinessAgentResult } from '@/lib/business-agent-response'
import { guardWebRoute } from '@/lib/route-guard'
import { safeErrorName } from '@/lib/safe-log'
import { persistTraceSpans } from '@/lib/telemetry-store'
import type { TraceSpanInput } from '@/lib/telemetry'

/** Run one existing specialist for a bounded, proposal-only business objective. */
export async function POST(request: Request) {
  const caller = await guardWebRoute(request, 'agents/run')
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status, headers: caller.headers })

  let raw: unknown
  try { raw = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const input = parseBusinessAgentRequest(raw)
  if (!input) return NextResponse.json({ error: 'Provide a known agentKey and an objective of 3 to 2,000 characters; optional context is limited to 20 strings of 4,000 characters.' }, { status: 400 })

  const selected = input.agentKey === 'auto'
    ? selectBusinessAgent(input.objective)
    : { key: input.agentKey, mode: 'explicit' as const, reason: 'Selected directly by the user.' }
  const agentKey: BusinessAgentKey = selected.key
  const definition = BUSINESS_AGENT_DEFINITIONS[agentKey]
  const agent = businessAgents[agentKey] as NueraQuicksilverAgent<BusinessAgentInput, BusinessAgentOutput>
  const traceId = randomUUID()
  const requestSpanId = randomUUID()
  const requestStartedAt = Date.now()
  try {
    const result = await executeGovernedAgent(agent, {
      agentId: definition.id,
      taskType: definition.task,
      input,
      context: input.context,
      impactLevel: 'moderate',
      signal: request.signal,
    })
    const completedAt = Date.now()
    const evaluationStatus = result.evaluation.safetyDecision === 'BLOCK' ? 'blocked' : 'ok'
    const audit = await persistEvaluations([{
      source: 'business-agent', agentId: result.agentId, taskType: definition.task,
      modelId: result.modelId, subject: input.objective, requestedBy: caller.principalId,
      evaluation: result.evaluation,
    }])
    const spans: TraceSpanInput[] = [
      { traceId, spanId: requestSpanId, source: 'agent', kind: 'request', name: 'business-agent.request', status: evaluationStatus, startedAt: requestStartedAt, durationMs: completedAt - requestStartedAt, requestedBy: caller.principalId, agentId: result.agentId },
      { traceId, parentSpanId: requestSpanId, source: 'agent', kind: 'model', name: 'business-agent.model', status: 'ok', startedAt: requestStartedAt, durationMs: completedAt - requestStartedAt, requestedBy: caller.principalId, agentId: result.agentId, modelId: result.modelId, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, totalTokens: result.usage?.totalTokens, estimatedCostUsd: result.usage?.totalTokens == null ? null : estimateModelCostUsd(result.modelId, result.usage.totalTokens) },
      ...(result.toolCalls ?? []).map((call): TraceSpanInput => ({ traceId, parentSpanId: requestSpanId, source: 'agent', kind: 'tool', name: 'business-agent.tool', status: call.succeeded ? 'ok' : 'error', startedAt: Math.max(requestStartedAt, completedAt - (call.durationMs ?? 0)), durationMs: call.durationMs ?? 0, requestedBy: caller.principalId, agentId: result.agentId, toolName: call.name, toolSucceeded: call.succeeded })),
      { traceId, parentSpanId: requestSpanId, source: 'agent', kind: 'evaluation', name: 'nqc.evaluation', status: evaluationStatus, startedAt: completedAt, durationMs: 0, requestedBy: caller.principalId, agentId: result.agentId, modelId: result.modelId, safetyDecision: result.evaluation.safetyDecision },
    ]
    const telemetry = await persistTraceSpans(spans)
    return NextResponse.json({
      agent: { key: agentKey, id: result.agentId, name: definition.name, specialty: definition.specialty },
      routing: selected,
      ...presentBusinessAgentResult(result.output, result.evaluation),
      audit: { persisted: audit.persisted, evaluationRecordIds: audit.ids, ...(audit.error ? { error: audit.error } : {}) },
      telemetry: { traceId, persisted: telemetry.persisted },
    })
  } catch (error) {
    console.error('[/api/agents/run]', safeErrorName(error))
    await persistTraceSpans([{ traceId, spanId: requestSpanId, source: 'agent', kind: 'request', name: 'business-agent.request', status: 'error', startedAt: requestStartedAt, durationMs: Date.now() - requestStartedAt, requestedBy: caller.principalId, agentId: definition.id }])
    return NextResponse.json({ error: 'Business-agent request failed.', detail: safeErrorName(error) }, { status: 503 })
  }
}
