/**
 * POST /api/plan — the Quicksilver decision engine.
 *
 * Request body:  { objective: string }
 *
 * Flow:
 *   1. Plan via @quicksilver/agent → candidateActions (ProposedAction-shaped)
 *   2. Resolve each referenced entity/capability/policy/evidence via Sanity
 *   3. Convert to kernel types
 *   4. Run Quicksilver Engine evaluation and NQC Kernel governance on each
 *      candidate. The deterministic kernel is the only authority.
 *   5. Run reviewProposedAction() as an independent second opinion — ADVISORY
 *      ONLY, never changes the kernel's outcome (see packages/agent/src/reviewer.ts)
 *   6. Persist one `decision` document per authorized/rejected candidate
 *      (status `awaiting-approval`, or `rejected` on a kernel hard block),
 *      including the reviewer's notes.
 *      With QUICKSILVER_PROCESS_ENGINE=on, the initial status instead comes
 *      from the Decision Lifecycle process definition in Sanity: the kernel
 *      takes the first automatic transition out of `proposed` whose guard
 *      holds against the kernel's own result (kernel-reject, auto-approve,
 *      or route-to-human) and records it in processHistory.
 *   7. Return plan + kernel decisions + reviewer notes, each with its `decisionDocId`
 *
 * Response shape:
 *   {
 *     decomposition: { ... },
 *     reasoning: string,
 *     decisions: [
 *       {
 *         action: ProposedAction,
 *         decision: AuthorizeResult | null,   // kernel output; null if actor/capability didn't resolve
 *         review: ReviewResult | null,        // independent reviewer's notes; advisory only, null if not resolved
 *         decisionDocId: string | null,       // Sanity _id of the persisted decision; null if not persisted
 *         resolvedReferences: {
 *           actor: { id, name, entityType },
 *           capability: { id, name, riskLevel },
 *           policies: [{ id, name, scope, priority }],
 *           evidence: [{ id, title, confidence }],
 *         }
 *       },
 *       ...
 *     ]
 *   }
 */

import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { safeErrorName } from '@/lib/safe-log'
import { getSanityClient } from '@/lib/sanity-client'
import { z } from 'zod'
import { decisionActionFingerprint, policySnapshotVersion } from '@/lib/nqc-approval'
import { guardWebRoute } from '@/lib/route-guard'
import {
  executeGovernedAgent,
  isLlmConfigured,
  plannerQuicksilverAgent,
  reviewerQuicksilverAgent,
  type ReviewResult,
} from '@quicksilver/agent'
import {
  applyUpstreamEscalation,
  evaluateAndAuthorize,
  nextAutomaticTransition,
  CAPABILITIES_QUERY,
  ENTITY_QUERY,
  POLICIES_QUERY,
  capabilityFromSanity,
  entityFromSanity,
  policyFromSanity,
  policyScopesToFetch,
  snapshotPolicyIds,
  type AuthorizeResult,
  type Facts,
  type CapabilityRef,
  type EntityRef,
  type EvidenceRef,
  type PolicyRef,
  type ProposedAction,
  type RiskLevel,
  type EvaluationResult,
  type SanityCapabilityDocument,
  type SanityEntityDocument,
  type SanityPolicyDocument,
} from '@quicksilver/kernel'
import { estimateModelCostUsd } from '@quicksilver/agent'
import { persistTraceSpans } from '@/lib/telemetry-store'
import type { TraceSpanInput } from '@/lib/telemetry'
import {
  KERNEL_ACTOR,
  loadDecisionLifecycle,
  processStatus,
  processView,
  transitionFields,
} from '@/lib/process-engine'

// ── Resolution: planner IDs → kernel refs ──────────────────────────────────

type Resolved = {
  actor: EntityRef | null
  capability: CapabilityRef | null
  /** The whole capability graph (M7): conflicts and requirements need more than the one capability. */
  capabilities: CapabilityRef[]
  policies: PolicyRef[]
  /** Revisions of every fetched policy; the snapshot is taken over those the decision's rows name. */
  policyRevisions: Array<{ id: string; revision: string }>
  evidence: EvidenceRef[]
}

async function resolveAction(
  client: ReturnType<typeof getSanityClient>,
  action: ProposedAction,
): Promise<Resolved> {
  // NOTE on the GROQ: reference arrays are read with `arr[]._ref` (the raw
  // reference keys), NOT `arr[]->._ref` — dereferencing returns the target
  // document, which has no `_ref`, so that yields `[null]`. The queries live
  // in @quicksilver/kernel (model-document.ts) and are all parameterized.
  //
  // All capabilities are fetched, not just the action's: conflicts may be
  // declared only on the other capability, and the actor's other grants count
  // for conflicts. Company models are small, so one query cannot under-fetch.
  const [actorDoc, capabilityDocs, evidenceDocs] = await Promise.all([
    client.fetch<SanityEntityDocument | null>(ENTITY_QUERY, { id: action.actorId }),
    client.fetch<SanityCapabilityDocument[]>(CAPABILITIES_QUERY),
    client.fetch<Array<{ _id: string; title: string; confidence: number }>>(
      `*[_type == "evidence" && _id in $ids]{ _id, title, confidence }`,
      { ids: action.evidenceIds },
    ),
  ])

  const capabilities = (capabilityDocs ?? []).map(capabilityFromSanity)
  const capability = capabilities.find((c) => c.id === action.capabilityId) ?? null

  // Cited policies PLUS every policy in the capability's effective scopes (own
  // and inherited) or an ancestor scope of one, every policy naming the actor,
  // and their lineage siblings: the kernel decides what governs, not the planner.
  const policyDocs = await client.fetch<SanityPolicyDocument[]>(POLICIES_QUERY, {
    ids: action.applicablePolicyIds,
    scopes: capability ? policyScopesToFetch(capability.id, capabilities) : [],
    actorId: action.actorId,
  })

  const actor: EntityRef | null = actorDoc ? entityFromSanity(actorDoc) : null
  const policies: PolicyRef[] = policyDocs.map(policyFromSanity)

  const evidence: EvidenceRef[] = evidenceDocs.map((e) => ({
    id: e._id,
    title: e.title,
    confidence: e.confidence,
  }))

  const policyRevisions = policyDocs.map((policy) => ({ id: policy._id, revision: policy._rev }))
  return { actor, capability, capabilities, policies, policyRevisions, evidence }
}

// ── Persistence: kernel result → `decision` document ───────────────────────

const ref = (id: string) => ({ _type: 'reference' as const, _ref: id, _key: id })

/**
 * Build the auditable decision record (schema: apps/studio/schemas/decision.ts).
 * Only references documents that were actually resolved from Sanity — a planner-
 * invented ID must never become a dangling strong reference.
 */
function buildDecisionDoc(args: {
  id: string
  objective: string
  constraints: string[]
  reasoning: string
  action: ProposedAction
  refs: Resolved & { actor: EntityRef; capability: CapabilityRef }
  decision: AuthorizeResult
  evaluation: EvaluationResult
  safetyDecision: 'ALLOW' | 'BLOCK' | 'ESCALATE'
  review: ReviewResult | null
  policySnapshotVersion: string
  requestedBy: string
  now: string
}) {
  const { id, objective, constraints, reasoning, action, refs, decision, evaluation, safetyDecision, review, policySnapshotVersion: policyVersion, requestedBy, now } = args

  // The kernel reports conflicts per shared scope as text; mark every applicable
  // policy in a shared scope as `conflicts` in the per-policy audit rows.
  const scopeCount = new Map<string, number>()
  for (const c of decision.policyChecks) {
    if (c.result !== 'applies') continue
    const scope = refs.policies.find((p) => p.id === c.policyId)?.scope
    if (scope) scopeCount.set(scope, (scopeCount.get(scope) ?? 0) + 1)
  }

  return {
    _id: id,
    _type: 'decision' as const,
    question: objective,
    context: [refs.actor.id, refs.capability.id, ...refs.policies.map((p) => p.id)].map(ref),
    candidateActions: [
      {
        _key: 'k0',
        description: action.description,
        actor: { _type: 'reference' as const, _ref: refs.actor.id },
        capability: { _type: 'reference' as const, _ref: refs.capability.id },
      },
    ],
    selectedAction: action.description,
    reasoningSummary: reasoning,
    evidence: refs.evidence.map((e) => e.id).map(ref),
    constraints,
    policyChecks: decision.policyChecks.map((c) => {
      const scope = refs.policies.find((p) => p.id === c.policyId)?.scope
      // A shared scope is only a conflict when the kernel reported one for it;
      // structured policies that agree, or that priority resolved, are not conflicts.
      const conflicted =
        c.result === 'applies' &&
        scope !== undefined &&
        (scopeCount.get(scope) ?? 0) > 1 &&
        decision.policyConflicts.some((msg) => msg.includes(`"${scope}"`))
      return {
        _key: c.policyId,
        policy: { _type: 'reference' as const, _ref: c.policyId },
        result: conflicted ? 'conflicts' : c.result,
        reason: conflicted ? `${c.reason} Shares this scope with another applicable policy.` : c.reason,
      }
    }),
    policyResolutions: decision.policyResolutions ?? [],
    riskLevel: decision.riskLevel,
    requiredApproval: decision.requiresApproval,
    policySnapshotVersion: policyVersion,
    safetyDecision,
    evaluation: {
      reasoningScore: evaluation.reasoningScore,
      hallucinationRisk: evaluation.hallucinationRisk,
      brittleness: evaluation.brittleness,
      failedToolCount: evaluation.failedToolCount,
      issues: evaluation.diagnosticReport,
      corrections: evaluation.correctionSuggestions,
      failureExemplars: evaluation.failureExemplars,
      modelId: evaluation.modelId,
      taskType: evaluation.taskType,
      evaluatedAt: evaluation.evaluatedAt,
    },
    reviewerNotes: review
      ? {
          valid: review.valid,
          policyConflicts: review.policyConflicts,
          missingEvidence: review.missingEvidence,
          riskConcerns: review.riskConcerns,
          suggestions: review.suggestions,
        }
      : undefined,
    status: decision.recommendation === 'reject' ? ('rejected' as const) : ('awaiting-approval' as const),
    // Separation of duties: who asked, and which agent proposed this action.
    requestedBy,
    proposedBy: 'nuera-quicksilver:planner',
    createdAt: now,
  }
}

// ── Request validation ─────────────────────────────────────────────────────

const BodySchema = z.object({
  objective: z.string().min(3).max(2000),
})

export async function POST(req: Request) {
  // A principal with decision:propose, before the body is read (A-3); it is the
  // requester recorded on every decision, never anything in the body. Then the
  // per-principal model-route limit (A-5).
  const requester = await guardWebRoute(req, 'plan')
  if (!requester.ok) return NextResponse.json(requester.body, { status: requester.status, headers: requester.headers })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }
  const { objective } = parsed.data

  if (!isLlmConfigured()) {
    return NextResponse.json(
      {
        error:
          'No LLM configured on the server. Set AZURE_API_KEY and AZURE_RESOURCE_NAME (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) in the root .env.',
      },
      { status: 500 },
    )
  }
  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json(
      { error: 'Sanity project ID not configured.' },
      { status: 500 },
    )
  }

  const traceId = randomUUID()
  const requestSpanId = randomUUID()
  const traceStartedAt = Date.now()
  try {
    const client = getSanityClient('write')
    // The planner runs on the standard agent contract, so its output is evaluated
    // by the Quicksilver Engine before any candidate action reaches the kernel.
    const plannerRun = await executeGovernedAgent(plannerQuicksilverAgent, {
      agentId: plannerQuicksilverAgent.id,
      taskType: 'planning',
      input: { objective },
      impactLevel: 'moderate',
      signal: req.signal,
    })
    const plannerCompletedAt = Date.now()
    const plannerSpanId = randomUUID()
    const plan = plannerRun.output
    const now = new Date().toISOString()
    const runId = Date.now().toString(36)

    // Run each candidate action through the kernel.
    const results = await Promise.all(
      plan.candidateActions.map(async (action, i) => {
        const refs = await resolveAction(client, action as ProposedAction)
        let decision: AuthorizeResult | null = null
        let evaluation: EvaluationResult | null = null
        let safetyDecision: 'ALLOW' | 'BLOCK' | 'ESCALATE' | null = null
        let review: ReviewResult | null = null
        let reviewModel: { modelId: string; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }; startedAt: number; durationMs: number } | null = null
        let doc: ReturnType<typeof buildDecisionDoc> | null = null

        if (refs.actor && refs.capability) {
          // Construct a kernel-compatible ProposedAction. The planner returns
          // Zod-inferred numeric fields, but the kernel wants the RiskLevel
          // union (0–5). Cast at the boundary.
          const kernelAction: ProposedAction = {
            description: action.description,
            actorId: action.actorId,
            capabilityId: action.capabilityId,
            applicablePolicyIds: action.applicablePolicyIds,
            evidenceIds: action.evidenceIds,
            financialExposure: action.financialExposure,
            reversible: action.reversible,
            operationalImpact: action.operationalImpact as RiskLevel,
            uncertainty: action.uncertainty as RiskLevel,
          }
          const perAction = evaluateAndAuthorize({
            action: kernelAction,
            actor: refs.actor,
            capabilities: refs.capabilities,
            policies: refs.policies,
            evidence: refs.evidence,
            // Strict separation of duties at plan time: the sole-operator
            // override needs a written justification, which only the approval
            // step collects, so conflicting capabilities are refused here.
          }, {
            // Evaluate only the user-facing proposed action and source metadata;
            // private model reasoning traces are intentionally not collected.
            agentOutput: kernelAction.description,
            context: refs.evidence.map((e) => `${e.id}: ${e.title}`),
            taskType: 'planning',
            impactLevel: kernelAction.operationalImpact >= 5 ? 'critical'
              : kernelAction.operationalImpact >= 4 ? 'high'
                : kernelAction.operationalImpact >= 2 ? 'moderate' : 'low',
            citedReferences: kernelAction.evidenceIds,
            availableReferences: refs.evidence.map((e) => e.id),
            toolCalls: plan.toolCalls,
            modelId: plan.modelId,
            uncertainty: kernelAction.uncertainty,
            stepCount: 1,
          })
          // A planner run the engine escalated can only tighten each action's outcome.
          const governed = applyUpstreamEscalation(perAction, plannerRun.evaluation, 'The planner run')
          decision = governed.decision
          evaluation = governed.evaluation
          safetyDecision = governed.safetyDecision

          // Independent review — advisory only. The kernel above has already
          // authorized/rejected the action; the reviewer never changes that
          // outcome, it only adds a second opinion for the human approver to
          // see. A reviewer failure (bad output, provider error) must not
          // block the plan response, so reviewProposedAction() always
          // resolves (see its own fallback) rather than throwing.
          const reviewerStartedAt = Date.now()
          const reviewerRun = await executeGovernedAgent(reviewerQuicksilverAgent, {
            agentId: reviewerQuicksilverAgent.id,
            taskType: 'evaluation',
            impactLevel: 'low',
            input: {
            action: kernelAction,
            actor: { id: refs.actor.id, name: refs.actor.name, entityType: refs.actor.entityType },
            capability: {
              id: refs.capability.id,
              name: refs.capability.name,
              riskLevel: refs.capability.baseRiskLevel,
            },
            policies: refs.policies.map((p) => ({ id: p.id, name: p.name, scope: p.scope, priority: p.priority })),
            evidence: refs.evidence,
            },
          })
          review = reviewerRun.output
          reviewModel = { modelId: reviewerRun.modelId, usage: reviewerRun.usage, startedAt: reviewerStartedAt, durationMs: Date.now() - reviewerStartedAt }

          doc = buildDecisionDoc({
            id: `decision-plan-${runId}-${i}`,
            objective,
            constraints: plan.decomposition.constraints,
            reasoning: plan.reasoning,
            action: kernelAction,
            refs: { ...refs, actor: refs.actor, capability: refs.capability },
            decision: governed.decision,
            evaluation: governed.evaluation,
            safetyDecision: governed.safetyDecision,
            review,
            // Snapshot the revisions of the policies the decision's rows name, as
            // the execute and approval routes recompute it from those rows.
            policySnapshotVersion: policySnapshotVersion(
              refs.policyRevisions.filter((p) => snapshotPolicyIds(governed.decision.policyChecks).includes(p.id)),
            ),
            requestedBy: requester.principalId,
            now,
          })
        }

        return { action: action as ProposedAction, decision, evaluation, safetyDecision, review, reviewModel, refs, doc }
      }),
    )

    // Process engine (feature-flagged): let the Decision Lifecycle process
    // definition pick each decision's first state, instead of the hard-coded
    // "rejected or awaiting-approval" above. Low-risk actions the kernel marks
    // execute-autonomously are auto-approved here, with no human click.
    const lifecycle = await loadDecisionLifecycle(client)
    const processByDoc = new Map<string, unknown>()
    for (const r of results) {
      if (!r.doc || !r.decision) continue
      const facts: Facts = {
        'decision.kind': 'plan',
        'kernel.recommendation': r.decision.recommendation,
        'kernel.authorized': r.decision.authorized,
        'kernel.riskLevel': r.decision.riskLevel,
        'kernel.requiresApproval': r.decision.requiresApproval,
      }
      const doc = r.doc as Record<string, unknown>
      doc.kind = 'plan'
      // Store the kernel's verdict so a decision held in `proposed` (e.g. while
      // the definition was invalid) can resume later from the same facts.
      doc.kernelRecommendation = r.decision.recommendation
      doc.kernelAuthorized = r.decision.authorized
      if (lifecycle.kind === 'ready') {
        const step = nextAutomaticTransition(lifecycle.definition, lifecycle.definition.initialState, facts)
        if (step) {
          const f = transitionFields(lifecycle.definition, step, KERNEL_ACTOR, now)
          doc.status = f.status
          doc.process = f.process
          doc.processHistory = [f.historyEntry]
          processByDoc.set(r.doc._id, processView(lifecycle.definition, f.status, facts, step.transition?.id))
        } else {
          // No automatic route matched: the decision waits in the initial state.
          doc.status = lifecycle.definition.initialState
          processByDoc.set(r.doc._id, processView(lifecycle.definition, lifecycle.definition.initialState, facts))
        }
      } else if (lifecycle.kind === 'invalid') {
        // Fail closed: an invalid process definition moves nothing.
        doc.status = 'proposed'
        processByDoc.set(r.doc._id, processStatus(lifecycle))
      } else {
        processByDoc.set(r.doc._id, processStatus(lifecycle))
      }
    }

    // Persist every decision atomically. Failure here is loud on purpose: without
    // a decision document the Approve → Execute → Observe loop cannot proceed.
    const docs = results.flatMap((r) => (r.doc ? [r.doc] : []))
    if (docs.length > 0) {
      const tx = client.transaction()
      for (const d of docs) tx.create(d)
      await tx.commit()
    }

    const decisions = results.map((r) => ({
      action: r.action,
      decision: r.decision,
      evaluation: r.evaluation,
      safetyDecision: r.safetyDecision,
      review: r.review,
      decisionDocId: r.doc?._id ?? null,
      approvalFingerprint: r.doc ? decisionActionFingerprint({
        decisionId: r.doc._id,
        selectedAction: r.doc.selectedAction,
        policySnapshotVersion: r.doc.policySnapshotVersion,
        riskLevel: r.doc.riskLevel,
        requiredApproval: r.doc.requiredApproval,
      }) : null,
      status: (r.doc as { status?: string } | null)?.status ?? null,
      process: r.doc ? processByDoc.get(r.doc._id) ?? null : null,
      resolvedReferences: {
        actor: r.refs.actor && {
          id: r.refs.actor.id,
          name: r.refs.actor.name,
          entityType: r.refs.actor.entityType,
        },
        capability: r.refs.capability && {
          id: r.refs.capability.id,
          name: r.refs.capability.name,
          riskLevel: r.refs.capability.baseRiskLevel,
        },
        policies: r.refs.policies.map((p) => ({ id: p.id, name: p.name, scope: p.scope, priority: p.priority })),
        evidence: r.refs.evidence,
      },
    }))

    const traceCompletedAt = Date.now()
    const decisionSpans: TraceSpanInput[] = results.flatMap((item): TraceSpanInput[] => item.safetyDecision ? [{
      traceId, parentSpanId: requestSpanId, source: 'plan', kind: 'decision', name: 'nqc.decision',
      status: item.safetyDecision === 'ALLOW' ? 'ok' : 'blocked', startedAt: traceCompletedAt, durationMs: 0,
      requestedBy: requester.principalId, agentId: plannerQuicksilverAgent.id, decisionId: item.doc?._id ?? null,
      safetyDecision: item.safetyDecision,
    }, {
      traceId, parentSpanId: requestSpanId, source: 'plan', kind: 'evaluation', name: 'nqc.action-evaluation',
      status: item.safetyDecision === 'ALLOW' ? 'ok' : 'blocked', startedAt: traceCompletedAt, durationMs: 0,
      requestedBy: requester.principalId, agentId: plannerQuicksilverAgent.id, decisionId: item.doc?._id ?? null,
      safetyDecision: item.safetyDecision,
    }] : [])
    const traceSpans: TraceSpanInput[] = [
      {
        traceId, spanId: requestSpanId, source: 'plan', kind: 'request', name: 'plan.request', status: 'ok',
        startedAt: traceStartedAt, durationMs: traceCompletedAt - traceStartedAt, requestedBy: requester.principalId,
        agentId: plannerQuicksilverAgent.id,
      },
      {
        traceId, spanId: plannerSpanId, parentSpanId: requestSpanId, source: 'plan', kind: 'model', name: 'plan.model', status: 'ok',
        startedAt: traceStartedAt, durationMs: plannerCompletedAt - traceStartedAt, requestedBy: requester.principalId,
        agentId: plannerRun.agentId, modelId: plannerRun.modelId, inputTokens: plannerRun.usage?.inputTokens ?? null,
        outputTokens: plannerRun.usage?.outputTokens ?? null, totalTokens: plannerRun.usage?.totalTokens ?? null,
        estimatedCostUsd: estimateModelCostUsd(plannerRun.modelId, plannerRun.usage?.totalTokens ?? null),
      },
      ...plan.toolCalls.map((toolCall): TraceSpanInput => ({
        traceId, parentSpanId: plannerSpanId, source: 'plan', kind: 'tool', name: 'plan.tool',
        status: toolCall.succeeded ? 'ok' : 'error', startedAt: Math.max(traceStartedAt, plannerCompletedAt - (toolCall.durationMs ?? 0)),
        durationMs: toolCall.durationMs ?? 0, requestedBy: requester.principalId, agentId: plannerRun.agentId,
        toolName: toolCall.name, toolSucceeded: toolCall.succeeded,
      })),
      ...results.flatMap((item): TraceSpanInput[] => item.reviewModel ? [{
        traceId, parentSpanId: requestSpanId, source: 'plan', kind: 'model', name: 'plan.review-model', status: 'ok',
        startedAt: item.reviewModel.startedAt, durationMs: item.reviewModel.durationMs, requestedBy: requester.principalId, agentId: reviewerQuicksilverAgent.id,
        decisionId: item.doc?._id ?? null, modelId: item.reviewModel.modelId,
        inputTokens: item.reviewModel.usage?.inputTokens ?? null, outputTokens: item.reviewModel.usage?.outputTokens ?? null,
        totalTokens: item.reviewModel.usage?.totalTokens ?? null,
        estimatedCostUsd: estimateModelCostUsd(item.reviewModel.modelId, item.reviewModel.usage?.totalTokens ?? null),
      }] : []),
      ...decisionSpans,
    ]
    const telemetry = await persistTraceSpans(traceSpans)
    return NextResponse.json({
      decomposition: plan.decomposition,
      reasoning: plan.reasoning,
      decisions,
      telemetry: { traceId, persisted: telemetry.persisted },
    })
  } catch (err) {
    console.error('[/api/plan]', safeErrorName(err))
    const telemetry = await persistTraceSpans([{
      traceId, spanId: requestSpanId, source: 'plan', kind: 'request', name: 'plan.request', status: 'error',
      startedAt: traceStartedAt, durationMs: Date.now() - traceStartedAt, requestedBy: requester.principalId,
    }])
    return NextResponse.json(
      { error: 'Plan failed', detail: safeErrorName(err), telemetry: { traceId, persisted: telemetry.persisted } },
      { status: 500 },
    )
  }
}
