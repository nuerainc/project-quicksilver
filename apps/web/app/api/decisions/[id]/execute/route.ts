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
 *
 * With QUICKSILVER_PROCESS_ENGINE=on, the kernel authorizes the move to
 * `executed` or `failed` against the Decision Lifecycle process definition,
 * using the simulated outcome as the `execution.success` fact, before
 * anything is written. When a rollback decision executes successfully, the
 * decision it undoes is moved to `rolled-back` the same way.
 *
 * Fault injection (testing only). Body `{ "inject": "success" | "failure" |
 * "deviation" }` forces the simulated outcome, so rare paths (a failed
 * rollback, a metric moving the wrong way) can be exercised on demand by
 * `npm run e2e:live`. It is refused unless QUICKSILVER_ALLOW_FAULT_INJECTION=on,
 * it can only make an already-authorized execution succeed or fail (the
 * kernel still authorizes the resulting transition), and every injected run
 * is stamped `faultInjection` on both the decision and its metric, so the
 * audit trail never passes a staged outcome off as an organic one.
 */

import { NextResponse } from 'next/server'
import { getDedicatedSanityProjectId } from '@/lib/sanity-config'
import { createClient } from '@sanity/client'
import { currentPolicySnapshotVersion, decisionActionFingerprint } from '@/lib/nqc-approval'
import { z } from 'zod'
import { authorizeTransition } from '@quicksilver/kernel'
import {
  EXECUTOR_ACTOR,
  KERNEL_ACTOR,
  commitTransition,
  factsFromDecision,
  invalidDefinitionBody,
  isRevisionConflict,
  loadDecisionLifecycle,
  processView,
  refusal,
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

type FaultInjection = 'success' | 'failure' | 'deviation'
const Body = z.object({ inject: z.enum(['success', 'failure', 'deviation']).optional() }).optional()

function faultInjectionAllowed(): boolean {
  return (process.env.QUICKSILVER_ALLOW_FAULT_INJECTION ?? '').trim().toLowerCase() === 'on'
}

/** A forced outcome on the downtime metric (baseline 32 h/week). */
function injectedOutcome(kind: FaultInjection): SimulatedOutcome {
  const baseline = 32
  const factor = kind === 'success' ? 0.82 : kind === 'deviation' ? 1.06 : 1.003
  const newValue = baseline * factor
  return {
    metricName: 'weekly downtime (hours)',
    previousValue: baseline,
    newValue,
    delta: newValue - baseline,
    unit: 'hours/week',
    success: kind !== 'failure',
  }
}

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
  const parsedBody = Body.safeParse(body ?? {})
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsedBody.error.issues }, { status: 400 })
  }
  const inject = parsedBody.data?.inject
  if (inject && !faultInjectionAllowed()) {
    return NextResponse.json({ error: 'Fault injection is disabled (QUICKSILVER_ALLOW_FAULT_INJECTION is not on).' }, { status: 403 })
  }

  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()

    const decision = await client.fetch<{
      _id: string
      _rev: string
      status: string
      selectedAction: string
      kind?: string | null
      riskLevel?: number | null
      requiredApproval?: boolean | null
      rollbackOfId?: string | null
      safetyDecision?: string | null
      policySnapshotVersion?: string | null
      policyIds?: string[]
      approvalRecord?: {
        id?: string
        requestId?: string
        actionFingerprint?: string
        policySnapshotVersion?: string
        supervisorId?: string
        grantedAt?: string
      } | null
      approvedById?: string | null
    } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, _rev, status, selectedAction, kind, riskLevel, requiredApproval, safetyDecision, policySnapshotVersion, "policyIds": policyChecks[].policy._ref, approvalRecord, "approvedById": approvedBy._ref, "rollbackOfId": rollbackOf._ref }`,
      { id },
    )
    if (!decision) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }

    if (decision.safetyDecision === 'BLOCK') {
      return NextResponse.json({ error: 'The NQC Kernel blocked this decision; it cannot execute.' }, { status: 409 })
    }
    const policyIds = [...new Set(decision.policyIds ?? [])].sort()
    const livePolicyVersion = await currentPolicySnapshotVersion(client, policyIds)
    if (!decision.policySnapshotVersion || livePolicyVersion !== decision.policySnapshotVersion) {
      return NextResponse.json({ error: 'Policy versions changed or were not recorded for this decision. Request a fresh plan.' }, { status: 409 })
    }

    const approvalRequired = decision.requiredApproval === true
      || decision.safetyDecision === 'ESCALATE'
      || (decision.riskLevel ?? 0) >= 4
    const actionFingerprint = decisionActionFingerprint({
      decisionId: decision._id,
      selectedAction: decision.selectedAction,
      policySnapshotVersion: decision.policySnapshotVersion,
      riskLevel: decision.riskLevel ?? 0,
      requiredApproval: decision.requiredApproval ?? false,
    })
    const approval = decision.approvalRecord
    if (approvalRequired && (
      !approval?.id
      || approval.requestId !== decision._id
      || approval.actionFingerprint !== actionFingerprint
      || approval.policySnapshotVersion !== decision.policySnapshotVersion
      || !approval.supervisorId
      || !approval.grantedAt
      || decision.approvedById !== approval.supervisorId
    )) {
      return NextResponse.json({ error: 'A current supervisor approval for this exact action and policy version is required.' }, { status: 409 })
    }
    if (approvalRequired) {
      const supervisor = await client.fetch<{ _id: string; entityType: string } | null>(
        '*[_type == "entity" && _id == $id][0]{ _id, entityType }',
        { id: approval!.supervisorId },
      )
      if (supervisor?.entityType !== 'human') {
        return NextResponse.json({ error: 'The recorded approver is no longer an active human entity.' }, { status: 409 })
      }
      const currentPolicies = await client.fetch<Array<{ _id: string; approvalRequirementIds?: string[] }>>(
        '*[_type == "policy" && _id in $ids]{ _id, "approvalRequirementIds": approvalRequirements[]._ref }',
        { ids: policyIds },
      )
      if (currentPolicies.length !== policyIds.length || currentPolicies.some((policy) => (policy.approvalRequirementIds?.length ?? 0) > 0 && !policy.approvalRequirementIds?.includes(approval!.supervisorId!))) {
        return NextResponse.json({ error: 'The recorded supervisor is not authorized by the current policies.' }, { status: 409 })
      }
    }

    // ── Process engine path ────────────────────────────────────────────────
    const lifecycle = await loadDecisionLifecycle(client)
    if (lifecycle.kind === 'invalid') {
      return NextResponse.json(invalidDefinitionBody(lifecycle), { status: 409 })
    }
    if (lifecycle.kind === 'ready') {
      const { definition } = lifecycle
      const startedAt = new Date().toISOString()
      const outcome = inject ? injectedOutcome(inject) : simulateExecution(decision._id, decision.selectedAction)
      const facts = { ...factsFromDecision(decision), 'execution.success': outcome.success }
      const target = outcome.success ? 'executed' : 'failed'
      const step = authorizeTransition({ definition, currentState: decision.status, to: target, facts, actor: EXECUTOR_ACTOR })
      if (!step.allowed) return NextResponse.json(refusal(step, definition), { status: 409 })

      const now = new Date().toISOString()
      const executionAudit = {
        ...(approval?.id ? { approvalId: approval.id } : {}),
        actionFingerprint,
        policySnapshotVersion: decision.policySnapshotVersion,
        executorId: EXECUTOR_ACTOR.id,
        startedAt,
        completedAt: now,
        outcome: outcome.success ? 'succeeded' : 'failed',
      }
      try {
        await commitTransition(client, decision._id, decision._rev, definition, step, EXECUTOR_ACTOR, now, {
          executedAt: now,
          executionAudit,
          ...(inject ? { faultInjection: inject } : {}),
        })
      } catch (err) {
        if (isRevisionConflict(err)) {
          return NextResponse.json({ error: 'This decision changed while it was being executed. Reload and try again.' }, { status: 409 })
        }
        throw err
      }
      await client.create({
        _type: 'metric',
        _id: `metric-${outcome.metricName.replace(/\W+/g, '-')}-${Date.now()}`,
        name: outcome.metricName,
        unit: outcome.unit,
        value: Math.round(outcome.newValue * 100) / 100,
        baseline: outcome.previousValue,
        direction: outcome.metricName.includes('downtime') ? 'lower-better' : 'higher-better',
        updatedAt: now,
        relatedDecision: { _type: 'reference', _ref: decision._id, _weak: true },
        ...(inject ? { faultInjection: inject } : {}),
      })

      // A successful rollback closes out the decision it undid.
      let parent: { id: string; status: string } | { id: string; error: string } | null = null
      if (outcome.success && decision.kind === 'rollback' && decision.rollbackOfId) {
        parent = await completeParentRollback(client, decision.rollbackOfId, definition, now)
      }

      return NextResponse.json({
        decisionId: decision._id,
        status: step.to,
        outcome,
        faultInjection: inject ?? null,
        at: now,
        process: processView(definition, step.to!, facts, step.transition?.id),
        rolledBackParent: parent,
      })
    }

    // ── Legacy path (engine off, or definition not seeded yet) ─────────────
    if (decision.status !== 'approved') {
      return NextResponse.json(
        { error: `Decision is in status "${decision.status}"; must be approved to execute` },
        { status: 400 },
      )
    }

    if (inject) {
      return NextResponse.json({ error: 'Fault injection needs the process engine (QUICKSILVER_PROCESS_ENGINE=on).' }, { status: 409 })
    }
    const startedAt = new Date().toISOString()
    const outcome = simulateExecution(decision._id, decision.selectedAction)
    const now = new Date().toISOString()
    const executionAudit = {
      ...(approval?.id ? { approvalId: approval.id } : {}),
      actionFingerprint,
      policySnapshotVersion: decision.policySnapshotVersion,
      executorId: EXECUTOR_ACTOR.id,
      startedAt,
      completedAt: now,
      outcome: outcome.success ? 'succeeded' : 'failed',
    }

    // Persist the simulated outcome as a metric document.
    // Hyphens, not dots, as separators -- see the matching note in
    // apps/web/app/api/decisions/[id]/rollback/route.ts.
    await client.create({
      _type: 'metric',
      _id: `metric-${outcome.metricName.replace(/\W+/g, '-')}-${Date.now()}`,
      name: outcome.metricName,
      unit: outcome.unit,
      value: Math.round(outcome.newValue * 100) / 100,
      baseline: outcome.previousValue,
      direction: outcome.metricName.includes('downtime') ? 'lower-better' : 'higher-better',
      updatedAt: now,
    })

    // Update the decision record.
    const newStatus = outcome.success ? 'executed' : 'failed'
    await client.patch(decision._id).ifRevisionId(decision._rev).set({ status: newStatus, executedAt: now, executionAudit }).commit()

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

async function completeParentRollback(
  client: ReturnType<typeof getSanityClient>,
  parentId: string,
  definition: Parameters<typeof authorizeTransition>[0]['definition'],
  now: string,
): Promise<{ id: string; status: string; process?: ReturnType<typeof processView> } | { id: string; error: string }> {
  const parent = await client.fetch<{
    _id: string
    _rev: string
    status: string
    kind?: string | null
    riskLevel?: number | null
    requiredApproval?: boolean | null
    observedDeviation?: boolean | null
  } | null>(
    `*[_type == "decision" && _id == $id][0]{ _id, _rev, status, kind, riskLevel, requiredApproval, observedDeviation }`,
    { id: parentId },
  )
  if (!parent) return { id: parentId, error: 'Original decision not found.' }
  const facts = { ...factsFromDecision(parent), 'rollback.executed': true }
  const step = authorizeTransition({ definition, currentState: parent.status, to: 'rolled-back', facts, actor: KERNEL_ACTOR })
  if (!step.allowed) return { id: parentId, error: step.reasons.join(' ') }
  try {
    await commitTransition(client, parent._id, parent._rev, definition, step, KERNEL_ACTOR, now)
  } catch (err) {
    return { id: parentId, error: (err as Error).message }
  }
  return { id: parentId, status: step.to!, process: processView(definition, step.to!, facts, step.transition?.id) }
}
