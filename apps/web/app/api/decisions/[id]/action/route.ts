/**
 * POST /api/decisions/[id]/action — act on a proposed decision.
 *
 * Body: { action: 'approve' | 'reject' | 'request-evidence' }
 *
 * Updates the decision document in Sanity with the new status, approver,
 * and (for execute) the executedAt timestamp. Returns the updated decision.
 *
 * With QUICKSILVER_PROCESS_ENGINE=on, the action is the transition of the
 * same name in the Decision Lifecycle process definition (approve / reject /
 * request-evidence), and the kernel's authorizeTransition() decides whether
 * it is legal from the decision's current state and whether this actor may
 * take it (all three require a human).
 */

import { NextResponse } from 'next/server'
import { getDedicatedSanityProjectId } from '@/lib/sanity-config'
import { createClient } from '@sanity/client'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authorizeTransition } from '@quicksilver/kernel'
import { currentPolicySnapshotVersion, decisionActionFingerprint, verifySupervisorCredential } from '@/lib/nqc-approval'
import {
  commitTransition,
  factsFromDecision,
  invalidDefinitionBody,
  isRevisionConflict,
  loadDecisionLifecycle,
  processView,
  refusal,
  uiOperator,
} from '@/lib/process-engine'

export const runtime = 'nodejs'

function getSanityClient() {
  return createClient({
    projectId: getDedicatedSanityProjectId(),
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    token: process.env.SANITY_AUTH_TOKEN,
  })
}

const ActionBody = z.object({
  action: z.enum(['approve', 'reject', 'request-evidence']),
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
  const { action, comment } = parsed.data

  const supervisor = verifySupervisorCredential(req)
  if (!supervisor.ok) return NextResponse.json({ error: supervisor.reason }, { status: supervisor.status })

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()

    // Fetch existing decision to confirm it exists.
    const existing = await client.fetch<{
      _id: string
      _rev: string
      status: string
      reasoningSummary?: string
      kind?: string | null
      riskLevel?: number | null
      requiredApproval?: boolean | null
      selectedAction?: string | null
      safetyDecision?: string | null
      policySnapshotVersion?: string | null
      policyIds?: string[]
    } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, _rev, status, reasoningSummary, kind, riskLevel, requiredApproval, selectedAction, safetyDecision, policySnapshotVersion, "policyIds": policyChecks[].policy._ref }`,
      { id },
    )
    if (!existing) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }

    const supervisorEntity = await client.fetch<{ _id: string; entityType: string } | null>(
      '*[_type == "entity" && _id == $id][0]{ _id, entityType }',
      { id: supervisor.supervisorId },
    )
    if (supervisorEntity?.entityType !== 'human') {
      return NextResponse.json({ error: 'Configured supervisor must resolve to a human entity.' }, { status: 403 })
    }
    const policyIds = [...new Set(existing.policyIds ?? [])].sort()
    if (action === 'approve') {
      const policies = await client.fetch<Array<{ _id: string; approvalRequirementIds?: string[] }>>(
        '*[_type == "policy" && _id in $ids]{ _id, "approvalRequirementIds": approvalRequirements[]._ref }',
        { ids: policyIds },
      )
      if (policies.length !== policyIds.length) {
        return NextResponse.json({ error: 'A policy used by this decision is missing; request a fresh plan.' }, { status: 409 })
      }
      if (policies.some((policy) => (policy.approvalRequirementIds?.length ?? 0) > 0 && !policy.approvalRequirementIds?.includes(supervisor.supervisorId))) {
        return NextResponse.json({ error: 'The configured supervisor is not authorized by every applicable policy.' }, { status: 403 })
      }
      const livePolicyVersion = await currentPolicySnapshotVersion(client, policyIds)
      if (!existing.policySnapshotVersion || livePolicyVersion !== existing.policySnapshotVersion) {
        return NextResponse.json({ error: 'Policy versions changed or were not recorded for this decision. Request a fresh plan.' }, { status: 409 })
      }
    }
    if (action === 'approve' && existing.safetyDecision === 'BLOCK') {
      return NextResponse.json({ error: 'The NQC Kernel blocked this decision; it cannot be approved.' }, { status: 409 })
    }

    const grantedAt = new Date().toISOString()
    const approvalRecord = action === 'approve'
      ? {
          id: `approval-${randomUUID()}`,
          requestId: id,
          actionFingerprint: decisionActionFingerprint({
            decisionId: id,
            selectedAction: existing.selectedAction ?? '',
            policySnapshotVersion: existing.policySnapshotVersion!,
            riskLevel: existing.riskLevel ?? 0,
            requiredApproval: existing.requiredApproval ?? false,
          }),
          policySnapshotVersion: existing.policySnapshotVersion,
          supervisorId: supervisor.supervisorId,
          grantedAt,
        }
      : undefined

    // ── Process engine path ────────────────────────────────────────────────
    const lifecycle = await loadDecisionLifecycle(client)
    if (lifecycle.kind === 'invalid') {
      return NextResponse.json(invalidDefinitionBody(lifecycle), { status: 409 })
    }
    if (lifecycle.kind === 'ready') {
      const { definition } = lifecycle
      const actor = uiOperator(supervisor.supervisorId)
      const facts = factsFromDecision(existing)
      const step = authorizeTransition({ definition, currentState: existing.status, transitionId: action, facts, actor })
      if (!step.allowed) return NextResponse.json(refusal(step, definition), { status: 409 })

      const now = new Date().toISOString()
      const extra: Record<string, unknown> = {}
      if (action === 'approve') {
        extra.approvedBy = { _type: 'reference', _ref: supervisor.supervisorId }
        extra.approvalRecord = approvalRecord
      }
      if (action === 'request-evidence' && comment) {
        extra.reasoningSummary = `[REQUEST EVIDENCE] ${comment}\n\n-- existing reasoning --\n${existing.reasoningSummary ?? ''}`
      }
      try {
        await commitTransition(client, id, existing._rev, definition, step, actor, now, extra)
      } catch (err) {
        if (isRevisionConflict(err)) {
          return NextResponse.json({ error: 'This decision changed while you were acting on it. Reload and try again.' }, { status: 409 })
        }
        throw err
      }
      return NextResponse.json({
        id,
        status: step.to,
        supervisorId: supervisor.supervisorId,
        approvalId: approvalRecord?.id ?? null,
        comment,
        at: now,
        process: processView(definition, step.to!, facts, step.transition?.id),
      })
    }

    // ── Legacy path (engine off, or definition not seeded yet) ─────────────

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
        patch.approvedBy = { _type: 'reference', _ref: supervisor.supervisorId }
        patch.approvalRecord = approvalRecord
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
    let updated
    try {
      updated = await client
        .patch(id)
        .ifRevisionId(existing._rev)
        .set(patch)
        .commit()
    } catch (err) {
      if (isRevisionConflict(err)) {
        return NextResponse.json({ error: 'This decision changed while you were acting on it. Reload and try again.' }, { status: 409 })
      }
      throw err
    }

    return NextResponse.json({
      id: updated._id,
      status: updated.status ?? patch.status,
      supervisorId: supervisor.supervisorId,
      approvalId: approvalRecord?.id ?? null,
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
