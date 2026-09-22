/**
 * POST /api/decisions/[id]/rollback — Day 12: propose a rollback decision.
 *
 * Creates a new `decision` document seeded for rollback. The original decision
 * is referenced as the parent. The new decision enters at awaiting-approval
 * so the UI can re-use the Approve / Reject buttons to confirm the rollback.
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

const Body = z.object({
  summary: z.string().optional(),
})

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  let body: { summary?: string } = {}
  try {
    body = await req.json()
  } catch {
    /* optional */
  }
  const parsed = Body.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }
  const { summary } = parsed.data

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()
    const original = await client.fetch<{ _id: string; selectedAction: string } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, selectedAction }`,
      { id },
    )
    if (!original) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }

    const rollbackId = `decision.rollback.${id}.${Date.now()}`
    await client.create({
      _id: rollbackId,
      _type: 'decision',
      question: `Roll back: ${original.selectedAction}`,
      context: [{ _type: 'reference', _ref: original._id, _key: original._id }],
      candidateActions: [],
      selectedAction: summary ?? `Roll back: ${original.selectedAction}`,
      reasoningSummary:
        'Closed-loop recovery: monitoring detected metric deviation in the wrong direction. High-confidence evidence (Historical Incident #17) suggests the underlying cause is mechanical (worn seal), not parameter drift. Rolling back the parameter change is the first corrective action.',
      evidence: [],
      constraints: [],
      policyChecks: [],
      riskLevel: 2,
      requiredApproval: false,
      status: 'awaiting-approval',
      createdAt: new Date().toISOString(),
    })

    return NextResponse.json({ rollbackDecisionId: rollbackId, parentDecisionId: id })
  } catch (err) {
    console.error('[/api/decisions/[id]/rollback]', err)
    return NextResponse.json(
      { error: 'Rollback failed', detail: (err as Error).message },
      { status: 500 },
    )
  }
}