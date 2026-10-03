import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'
import { getSanityClient } from '@/lib/sanity-client'

export const dynamic = 'force-dynamic'

const ID = /^[A-Za-z0-9._:-]{1,200}$/

const DETAIL_QUERY = `*[_type == "decision" && _id == $id][0]{
  _id, question, selectedAction, reasoningSummary, constraints, riskLevel, requiredApproval, status, safetyDecision,
  requestedBy, proposedBy, createdAt, executedAt, policySnapshotVersion, policyResolutions, kind,
  "approvedByName": approvedBy->name,
  "policyChecks": policyChecks[]{ result, reason, "policyName": policy->name },
  "evidenceTitles": evidence[]->title,
  evaluation{ reasoningScore, hallucinationRisk, brittleness, failedToolCount, issues, corrections, modelId, evaluatedAt },
  reviewerNotes,
  why,
  "processName": process.definition->name,
  "processVersion": process.version,
  processHistory[]{ transitionId, from, to, actorId, actorType, at }
}`

/**
 * GET /api/decisions/:id — one decision in full, including the kernel's explanation of why
 * (risk arithmetic, policy guards, the policy revision, and what would change the answer)
 * when it was recorded. Read-only; needs decision:read.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await guardWebRoute(request, 'decisions/detail')
  if (!caller.ok) return publicationRefusal(caller)

  const { id } = await params
  if (!ID.test(id)) return NextResponse.json({ error: 'That is not a decision id.' }, { status: 400 })
  try {
    const doc = await getSanityClient('read').fetch<Record<string, unknown> | null>(DETAIL_QUERY, { id })
    if (!doc) return NextResponse.json({ error: 'Decision not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } })
    const { _id, ...rest } = doc
    return NextResponse.json({ id: _id, ...rest }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[decisions] detail failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load this decision. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
