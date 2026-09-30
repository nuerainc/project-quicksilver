/**
 * POST /api/query — run a single question against the Quicksilver query agent.
 *
 * Request body: { question: string }
 * Response:     QueryResult (see @quicksilver/agent)
 */

import { NextResponse } from 'next/server'
import { safeErrorName } from '@/lib/safe-log'
import { queryCompany } from '@quicksilver/agent'
import { evaluateNqcRequest } from '@quicksilver/kernel'
import { persistEvaluations } from '@/lib/evaluation-store'
import { guardWebRoute } from '@/lib/route-guard'

export async function POST(req: Request) {
  // A principal with decision:read before anything else (A-3), then the
  // per-principal model-route limit (A-5).
  const requester = guardWebRoute(req, 'query')
  if (!requester.ok) return NextResponse.json(requester.body, { status: requester.status, headers: requester.headers })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { question } = (body ?? {}) as { question?: string }
  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'Missing required field: question' }, { status: 400 })
  }

  try {
    const result = await queryCompany(question)
    const governance = evaluateNqcRequest({
      agentId: 'nuera-quicksilver:query',
      taskType: 'reasoning',
      modelId: result.modelId,
      agentOutput: JSON.stringify({
        question: result.question,
        entities: result.entities.map(({ id, name, entityType }) => ({ id, name, entityType })),
        capabilities: result.capabilities,
        policies: result.policies,
      }),
      context: result.supportingContext,
      toolCalls: result.toolCalls,
      impactLevel: 'low',
    })
    const audit = await persistEvaluations([
      {
        source: 'query',
        agentId: 'nuera-quicksilver:query',
        taskType: 'reasoning',
        modelId: result.modelId,
        subject: question,
        requestedBy: requester.principalId,
        evaluation: governance,
      },
    ])
    return NextResponse.json({
      ...result,
      audit: { persisted: audit.persisted, evaluationRecordIds: audit.ids, ...(audit.error ? { error: audit.error } : {}) },
      nqc: {
        reasoningScore: governance.reasoningScore,
        hallucinationRisk: governance.hallucinationRisk,
        brittleness: governance.brittleness,
        issues: governance.issues,
        corrections: governance.corrections,
        safetyDecision: governance.safetyDecision,
      },
    })
  } catch (err) {
    console.error('[/api/query]', safeErrorName(err))
    return NextResponse.json(
      { error: 'Query failed', detail: safeErrorName(err) },
      { status: 500 },
    )
  }
}
