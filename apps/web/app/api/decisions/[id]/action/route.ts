/**
 * POST /api/decisions/[id]/action — act on a proposed decision.
 *
 * Body: { action: 'approve' | 'reject' | 'request-evidence', approverId?: string }
 *
 * Updates the decision document in Sanity with the new status, approver,
 * and (for execute) the executedAt timestamp. Returns the updated decision.
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

const ActionBody = z.object({
  action: z.enum(['approve', 'reject', 'request-evidence']),
  approverId: z.string().optional(),
  comment: z.string().optional(),
})

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  if (!id) {
    return NextResponse.json({ error: 'Missing decision id' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = ActionBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }
  const { action, approverId, comment } = parsed.data

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()

    // Fetch existing decision to confirm it exists.
    const existing = await client.fetch<{ _id: string; status: string; reasoningSummary?: string } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, status, reasoningSummary }`,
      { id },
    )
    if (!existing) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }

    // Only a decision still waiting on a human can be approved / rejected / queried.
    // This is what makes a kernel `reject` (persisted as status "rejected") final:
    // it can't be approved afterwards, and an executed decision can't be re-approved.
    if (existing.status !== 'awaiting-approval' && existing.status !== 'proposed') {
      return NextResponse.json(
        { error: `Decision is "${existing.status}"; only awaiting-approval decisions can be acted on.` },
        { status: 409 },
      )
    }

    const now = new Date().toISOString()
    const patch: Record<string, unknown> = {}

    switch (action) {
      case 'approve':
        patch.status = 'approved'
        if (approverId) patch.approvedBy = { _type: 'reference', _ref: approverId }
        break
      case 'reject':
        patch.status = 'rejected'
        break
      case 'request-evidence':
        // Stays in awaiting-approval but a comment is recorded by appending
        // to a simple string field. If `reasoningSummary` exists, prepend.
        if (comment) {
          patch.reasoningSummary = `[REQUEST EVIDENCE] ${comment}\n\n-- existing reasoning --\n${existing.reasoningSummary ?? ''}`
        }
        patch.status = 'awaiting-approval'
        break
    }

    // NOTE: `executedAt` is deliberately NOT set here. Approval is not execution;
    // the /execute route stamps it when the action actually runs.

    // Persist the patch.
    const updated = await client
      .patch(id)
      .set(patch)
      .commit()

    return NextResponse.json({
      id: updated._id,
      status: updated.status ?? patch.status,
      approverId,
      comment,
      at: now,
    })
  } catch (err) {
    console.error('[/api/decisions/[id]/action]', err)
    return NextResponse.json(
      { error: 'Action failed', detail: (err as Error).message },
      { status: 500 },
    )
  }
}