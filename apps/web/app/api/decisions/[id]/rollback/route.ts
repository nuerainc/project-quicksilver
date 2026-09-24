/**
 * POST /api/decisions/[id]/rollback — Day 12: propose a rollback decision.
 *
 * Creates a new `decision` document seeded for rollback. The original decision
 * is referenced as the parent. The new decision enters at awaiting-approval
 * so the UI can re-use the Approve / Reject buttons to confirm the rollback.
 *
 * With QUICKSILVER_PROCESS_ENGINE=on, the kernel first authorizes moving the
 * ORIGINAL decision to `rollback-proposed` (allowed only after an observed
 * deviation or a failed execution, and only by a human). The new rollback
 * decision then enters the lifecycle like any other: its first transition
 * (`route-to-human`, via decision.kind = rollback) is taken by the kernel.
 */

import { NextResponse } from 'next/server'
import { getDedicatedSanityProjectId } from '@/lib/sanity-config'
import { createClient } from '@sanity/client'
import { z } from 'zod'
import { authorizeTransition, nextAutomaticTransition } from '@quicksilver/kernel'
import { verifySupervisorCredential } from '@/lib/nqc-approval'
import {
  KERNEL_ACTOR,
  commitTransition,
  factsFromDecision,
  invalidDefinitionBody,
  isRevisionConflict,
  loadDecisionLifecycle,
  processView,
  refusal,
  transitionFields,
  uiOperator,
} from '@/lib/process-engine'

function getSanityClient() {
  return createClient({
    projectId: getDedicatedSanityProjectId(),
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    token: process.env.SANITY_AUTH_TOKEN,
  })
}

const Body = z.object({
  summary: z.string().optional(),
})

export const runtime = 'nodejs'

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
  const supervisor = verifySupervisorCredential(req)
  if (!supervisor.ok) return NextResponse.json({ error: supervisor.reason }, { status: supervisor.status })

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()
    const original = await client.fetch<{
      _id: string
      _rev: string
      selectedAction: string
      status: string
      kind?: string | null
      riskLevel?: number | null
      requiredApproval?: boolean | null
      observedDeviation?: boolean | null
      policySnapshotVersion?: string | null
      policyChecks?: unknown[]
    } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, _rev, selectedAction, status, kind, riskLevel, requiredApproval, observedDeviation, policySnapshotVersion, policyChecks }`,
      { id },
    )
    if (!original) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }
    const supervisorEntity = await client.fetch<{ entityType: string } | null>(
      '*[_type == "entity" && _id == $id][0]{ entityType }',
      { id: supervisor.supervisorId },
    )
    if (supervisorEntity?.entityType !== 'human') {
      return NextResponse.json({ error: 'Configured supervisor must resolve to a human entity.' }, { status: 403 })
    }

    // ── Process engine path ────────────────────────────────────────────────
    const lifecycle = await loadDecisionLifecycle(client)
    if (lifecycle.kind === 'invalid') {
      return NextResponse.json(invalidDefinitionBody(lifecycle), { status: 409 })
    }
    if (lifecycle.kind === 'ready') {
      const { definition } = lifecycle
      const actor = uiOperator(supervisor.supervisorId)
      // Earlier rollback attempts for this decision, newest first: the facts
      // behind `retry-rollback` (a failed rollback may be retried once nothing
      // else is still in flight).
      const attempts = await client.fetch<Array<{ status: string }>>(
        `*[_type == "decision" && rollbackOf._ref == $id] | order(coalesce(createdAt, _createdAt) desc){ status }`,
        { id },
      )
      const facts = {
        ...factsFromDecision(original),
        'rollback.lastAttemptFailed': attempts.length > 0 && attempts[0]!.status === 'failed',
        'rollback.pendingAttempts': attempts.filter((a) => ['proposed', 'awaiting-approval', 'approved'].includes(a.status)).length,
      }
      const step = authorizeTransition({ definition, currentState: original.status, to: 'rollback-proposed', facts, actor })
      if (!step.allowed) return NextResponse.json(refusal(step, definition), { status: 409 })

      const now = new Date().toISOString()
      try {
        await commitTransition(client, original._id, original._rev, definition, step, actor, now)
      } catch (err) {
        if (isRevisionConflict(err)) {
          return NextResponse.json({ error: 'This decision changed while you were acting on it. Reload and try again.' }, { status: 409 })
        }
        throw err
      }

      // The rollback is its own decision, entering the same lifecycle.
      const rollbackId = `decision-rollback-${id}-${Date.now()}`
      const rollbackFacts = { 'decision.kind': 'rollback' }
      const first = nextAutomaticTransition(definition, definition.initialState, rollbackFacts)
      const firstFields = first ? transitionFields(definition, first, KERNEL_ACTOR, now) : null
      await client.create({
        _id: rollbackId,
        _type: 'decision',
        kind: 'rollback',
        rollbackOf: { _type: 'reference', _ref: original._id },
        question: `Roll back: ${original.selectedAction}`,
        context: [{ _type: 'reference', _ref: original._id, _key: original._id }],
        candidateActions: [],
        selectedAction: summary ?? `Roll back: ${original.selectedAction}`,
        reasoningSummary: step.transition?.id === 'retry-rollback'
          ? 'Retry: the previous rollback attempt failed to execute. Rolling back again to reach the last known-good state.'
          : original.observedDeviation
          ? 'Closed-loop recovery: monitoring detected the metric moving in the wrong direction after execution. Rolling back the change is the first corrective action.'
          : 'Recovery after a failed execution: rolling back to the last known-good state.',
        evidence: [],
        constraints: [],
        policyChecks: original.policyChecks ?? [],
        policySnapshotVersion: original.policySnapshotVersion,
        requiredApproval: true,
        status: firstFields?.status ?? definition.initialState,
        ...(firstFields ? { process: firstFields.process, processHistory: [firstFields.historyEntry] } : {}),
        createdAt: now,
      })

      return NextResponse.json({
        rollbackDecisionId: rollbackId,
        parentDecisionId: id,
        parentStatus: step.to,
        parentProcess: processView(definition, step.to!, facts, step.transition?.id),
        process: processView(definition, firstFields?.status ?? definition.initialState, rollbackFacts, first?.transition?.id),
      })
    }

    // ── Legacy path (engine off, or definition not seeded yet) ─────────────

    // Hyphens, not dots -- Sanity treats a leading "drafts." as a special
    // document-id prefix, and mixing dots into an ordinary runtime id invites
    // confusion (or worse) with that convention. Every other generated id in
    // this codebase (decision-plan-<run>-<i>, etc.) already uses hyphens.
    const rollbackId = `decision-rollback-${id}-${Date.now()}`
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
      policyChecks: original.policyChecks ?? [],
      policySnapshotVersion: original.policySnapshotVersion,
      riskLevel: 2,
      requiredApproval: true,
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
