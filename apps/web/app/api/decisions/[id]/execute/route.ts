/**
 * POST /api/decisions/[id]/execute — Day 11 simulated execution.
 *
 * Takes an approved decision, runs a deterministic-but-noisy simulation
 * (downtime metric gets a delta based on action type and current policy
 * posture), updates the related `metric` document, and flips the
 * decision's status to `executed` or `failed`.
 *
 * Determinism: seeded by the decision id, so running the same decision
 * twice returns the same outcome — important for demo reproducibility.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { z } from 'zod'

function getSanityClient() {
  return createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    token: process.env.SANITY_AUTH_TOKEN,
  })
}

// Seeded RNG — same decision id always produces the same outcome.
function seedFromId(id: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < id.length; i++) {
    h = ((h ^ id.charCodeAt(i)) * 16777619) >>> 0
  }
  return (h % 1000) / 1000
}

interface SimulatedOutcome {
  metricName: string
  previousValue: number
  newValue: number
  delta: number
  unit: string
  success: boolean
}

function simulateExecution(decisionId: string, actionDescription: string): SimulatedOutcome {
  const seed = seedFromId(decisionId)
  const lower = actionDescription.toLowerCase()

  if (lower.includes('parameter') || lower.includes('controller') || lower.includes('process')) {
    // Parameter change: 70% chance of -15%..-25% downtime, 30% chance of -5%..+8% (noise)
    if (seed < 0.7) {
      const baseline = 32 // hours/week
      const reduction = 0.15 + (seed / 0.7) * 0.10
      const newValue = baseline * (1 - reduction)
      return {
        metricName: 'weekly downtime (hours)',
        previousValue: baseline,
        newValue,
        delta: newValue - baseline,
        unit: 'hours/week',
        success: true,
      }
    } else {
      const baseline = 32
      const noise = (seed - 0.7) / 0.3 * 0.13 - 0.05
      const newValue = baseline * (1 + noise)
      return {
        metricName: 'weekly downtime (hours)',
        previousValue: baseline,
        newValue,
        delta: newValue - baseline,
        unit: 'hours/week',
        success: Math.abs(noise) > 0.02,
      }
    }
  }

  // Default: small positive movement
  return {
    metricName: 'general-progress',
    previousValue: 0.5,
    newValue: 0.55,
    delta: 0.05,
    unit: 'index',
    success: true,
  }
}

const Body = z.object({}).optional()

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'Missing decision id' }, { status: 400 })

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Body optional
  }
  Body.parse(body ?? {})

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()

    const decision = await client.fetch<{
      _id: string
      status: string
      selectedAction: string
      executionContextId?: string
    } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, status, selectedAction }`,
      { id },
    )
    if (!decision) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }
    if (decision.status !== 'approved') {
      return NextResponse.json(
        { error: `Decision is in status "${decision.status}"; must be approved to execute` },
        { status: 400 },
      )
    }

    const outcome = simulateExecution(decision._id, decision.selectedAction)
    const now = new Date().toISOString()

    // Persist the simulated outcome as a metric document.
    await client.create({
      _type: 'metric',
      _id: `metric.${outcome.metricName.replace(/\W+/g, '-')}.${Date.now()}`,
      name: outcome.metricName,
      unit: outcome.unit,
      value: Math.round(outcome.newValue * 100) / 100,
      baseline: outcome.previousValue,
      direction: outcome.metricName.includes('downtime') ? 'lower-better' : 'higher-better',
      updatedAt: now,
    })

    // Update the decision record.
    const newStatus = outcome.success ? 'executed' : 'failed'
    await client.patch(decision._id).set({ status: newStatus, executedAt: now }).commit()

    return NextResponse.json({
      decisionId: decision._id,
      status: newStatus,
      outcome,
      at: now,
    })
  } catch (err) {
    console.error('[/api/decisions/[id]/execute]', err)
    return NextResponse.json(
      { error: 'Execution failed', detail: (err as Error).message },
      { status: 500 },
    )
  }
}