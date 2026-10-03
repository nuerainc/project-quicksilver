import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'
import { getSanityClient } from '@/lib/sanity-client'
import { DECISION_DETAIL_QUERY } from '@/lib/decision-audit'
import { currentPolicySnapshotVersion, decisionActionFingerprint, soleOperatorId } from '@/lib/nqc-approval'

export const dynamic = 'force-dynamic'

const ID = /^[A-Za-z0-9._:-]{1,200}$/

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
    const doc = await getSanityClient('read').fetch<Record<string, unknown> | null>(DECISION_DETAIL_QUERY, { id })
    if (!doc) return NextResponse.json({ error: 'Decision not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } })
    const { _id, policyIds, ...rest } = doc as Record<string, unknown> & { _id: string; policyIds?: string[] | null; selectedAction?: string | null; policySnapshotVersion?: string | null; riskLevel?: number | null; requiredApproval?: boolean | null; status?: string | null }
    // What an approval covers, and whether the policies it was planned under have since changed:
    // the same two facts the approve route checks, so the page can show a button only when it can work.
    const pending = rest.status === 'awaiting-approval' || rest.status === 'proposed'
    const live = pending && rest.policySnapshotVersion ? await currentPolicySnapshotVersion(getSanityClient('read'), policyIds ?? []) : null
    const policyChanged = pending && (!rest.policySnapshotVersion || live !== rest.policySnapshotVersion)
    const approvalFingerprint = rest.selectedAction && rest.policySnapshotVersion
      ? decisionActionFingerprint({ decisionId: _id, selectedAction: rest.selectedAction, policySnapshotVersion: rest.policySnapshotVersion, riskLevel: rest.riskLevel ?? 0, requiredApproval: rest.requiredApproval ?? false })
      : null
    return NextResponse.json({
      id: _id, ...rest, approvalFingerprint, policyChanged,
      // Only the configured sole operator may approve their own request, with a written reason.
      viewer: { id: caller.principalId, soleOperator: soleOperatorId()?.trim() === caller.principalId },
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[decisions] detail failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load this decision. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
