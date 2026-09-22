/**
 * POST /api/decisions/[id]/observe — Day 12 closed-loop: observe + diagnose.
 *
 * Reads the latest metric associated with the executed decision, compares
 * to baseline, and surfaces:
 *   - whether the action improved, held, or degraded state
 *   - whether a rollback is recommended
 *   - a one-line diagnosis grounded in supporting evidence
 *
 * Idempotent: same input → same output.
 *
 * With QUICKSILVER_PROCESS_ENGINE=on, the result is also recorded on the
 * decision as `observedDeviation`, which is the fact the Decision Lifecycle's
 * `propose-rollback` guard checks -- so a rollback can only be proposed for
 * a decision whose metric was actually observed moving the wrong way.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { loadDecisionLifecycle } from '@/lib/process-engine'

function getSanityClient() {
  return createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    token: process.env.SANITY_AUTH_TOKEN,
  })
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'Missing decision id' }, { status: 400 })

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()

    const decision = await client.fetch<{
      _id: string
      status: string
      selectedAction: string
      evidenceIds?: string[] | null
    } | null>(
      // Alias the projection: an un-aliased `evidence[]->._id` comes back under the
      // key `evidence`, leaving `evidenceIds` undefined.
      `*[_type == "decision" && _id == $id][0]{ _id, status, selectedAction, "evidenceIds": evidence[]._ref }`,
      { id },
    )
    if (!decision) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }

    // Latest metric (any). Demo uses simulated single-metric world.
    const metric = await client.fetch<{
      _id: string
      name: string
      value: number
      baseline: number
      unit: string
      direction: 'lower-better' | 'higher-better'
    } | null>(
      `*[_type == "metric"] | order(updatedAt desc)[0]{ _id, name, value, baseline, unit, direction }`,
    )

    if (!metric) {
      return NextResponse.json({
        decisionId: id,
        status: decision.status,
        observed: null,
        diagnosis: 'No metric observed yet. Was the decision executed?',
        deviationDetected: false,
        recommendedRollback: null,
      })
    }

    const delta = metric.value - metric.baseline
    const worse = metric.direction === 'lower-better' ? metric.value > metric.baseline : metric.value < metric.baseline
    const improved = metric.direction === 'lower-better' ? metric.value < metric.baseline : metric.value > metric.baseline
    const pctChange = (delta / metric.baseline) * 100

    // Look up the historical-incident #17 evidence for a grounded diagnosis.
    const evidenceIds = decision.evidenceIds ?? []
    const contradictingEvidence = evidenceIds.length
      ? await client.fetch<Array<{ _id: string; title: string; claim: string; confidence: number }>>(
          `*[_type == "evidence" && _id in $ids && confidence > 0.85]{ _id, title, claim, confidence } | order(confidence desc)[0..2]`,
          { ids: evidenceIds },
        )
      : []

    const diagnosis =
      contradictingEvidence.length > 0
        ? `High-confidence evidence contradicts the change: ${contradictingEvidence[0]?.claim ?? ''}`
        : improved
          ? 'Change moved the metric in the expected direction.'
          : 'No change detected.'

    const lifecycle = await loadDecisionLifecycle(client)
    if (lifecycle.kind === 'ready') {
      await client.patch(id).set({ observedDeviation: worse }).commit()
    }

    return NextResponse.json({
      decisionId: id,
      status: decision.status,
      observed: {
        metric: metric.name,
        unit: metric.unit,
        baseline: metric.baseline,
        value: metric.value,
        delta,
        pctChange: Math.round(pctChange * 10) / 10,
      },
      diagnosis,
      deviationDetected: worse,
      recommendedRollback: worse
        ? {
            summary: 'Roll back the parameter change and inspect the underlying cause.',
            rationale: `Metric "${metric.name}" moved ${Math.abs(pctChange).toFixed(1)}% in the wrong direction after the action.`,
          }
        : null,
    })
  } catch (err) {
    console.error('[/api/decisions/[id]/observe]', err)
    return NextResponse.json(
      { error: 'Observe failed', detail: (err as Error).message },
      { status: 500 },
    )
  }
}