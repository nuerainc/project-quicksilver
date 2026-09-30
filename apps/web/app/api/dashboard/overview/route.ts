import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'
import { getSanityClient } from '@/lib/sanity-client'
import type { BusinessOverview, DecisionSnapshot, ExperimentSnapshot, OperatingMetric } from '@/lib/business-dashboard'

export const dynamic = 'force-dynamic'

type RawDecision = Omit<DecisionSnapshot, 'id' | 'title'> & { _id: string; question?: string | null; selectedAction?: string | null }

const SUMMARY_QUERY = `{
  "decisionCounts": {
    "total": count(*[_type == "decision"]),
    "awaitingApproval": count(*[_type == "decision" && status in ["awaiting-approval", "proposed", "rollback-proposed"]]),
    "approved": count(*[_type == "decision" && status == "approved"]),
    "executed": count(*[_type == "decision" && status in ["executed", "rolled-back"]]),
    "blocked": count(*[_type == "decision" && (status == "rejected" || safetyDecision == "BLOCK")]),
    "failed": count(*[_type == "decision" && status == "failed"])
  },
  "decisions": *[_type == "decision"] | order(coalesce(createdAt, _createdAt) desc)[0...8]{_id, question, selectedAction, status, riskLevel, requiredApproval, safetyDecision, createdAt},
  "metrics": *[_type == "metric" && !defined(faultInjection)] | order(coalesce(updatedAt, _updatedAt) desc)[0...8]{_id, name, value, unit, baseline, direction, updatedAt},
  "experiments": *[_type == "experimentRecord"] | order(coalesce(startedAt, _createdAt) desc)[0...8]{_id, experimentId, hypothesis, status, budgetUsd, endsAt}
}`

/** Authenticated, read-only operating snapshot from currently available business records. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'dashboard/overview')
  if (!caller.ok) return publicationRefusal(caller)

  try {
    const client = getSanityClient('read')
    const raw = await client.fetch<{
      decisionCounts: BusinessOverview['decisionCounts']
      decisions: RawDecision[]
      metrics: Array<OperatingMetric & { _id: string }>
      experiments: Array<ExperimentSnapshot & { _id: string; experimentId?: string }>
    }>(SUMMARY_QUERY)
    const decisions: DecisionSnapshot[] = (raw.decisions ?? []).map((decision) => ({
      id: decision._id,
      title: decision.question?.trim() || decision.selectedAction?.trim() || 'Untitled decision',
      status: decision.status ?? 'proposed',
      riskLevel: decision.riskLevel ?? null,
      requiredApproval: decision.requiredApproval === true,
      safetyDecision: decision.safetyDecision ?? null,
      createdAt: decision.createdAt ?? null,
    }))
    const metrics: OperatingMetric[] = (raw.metrics ?? []).map(({ _id, ...metric }) => ({ ...metric, id: _id }))
    const experiments: ExperimentSnapshot[] = (raw.experiments ?? []).map((experiment) => ({
      id: experiment.experimentId?.trim() || experiment._id,
      hypothesis: experiment.hypothesis ?? 'Experiment hypothesis not recorded.',
      status: experiment.status ?? 'unknown',
      budgetUsd: experiment.budgetUsd ?? null,
      endsAt: experiment.endsAt ?? null,
    }))
    const overview: BusinessOverview = {
      observedAt: new Date().toISOString(),
      decisionCounts: raw.decisionCounts,
      recentDecisions: decisions.slice(0, 8),
      metrics,
      experiments,
    }
    return NextResponse.json(overview, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[dashboard-overview] data load failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load the business overview. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
