/**
 * POST /api/query — run a single question against the Quicksilver query agent.
 *
 * Request body: { question: string }
 * Response:     QueryResult (see @quicksilver/agent)
 */

import { NextResponse } from 'next/server'
import { queryCompany } from '@quicksilver/agent'
import { evaluateNqcRequest } from '@quicksilver/kernel'

export async function POST(req: Request) {
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
      agentId: 'nuera-quicksilver-reasoning-agent',
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
    return NextResponse.json({
      ...result,
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
    console.error('[/api/query]', err)
    return NextResponse.json(
      { error: 'Query failed', detail: (err as Error).message },
      { status: 500 },
    )
  }
}
