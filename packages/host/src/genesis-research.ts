import { createHash } from 'node:crypto'

import { experimentDigest, moneyTotals, verifyMoneyLedger, type Experiment, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import { judgeMetric } from '@quicksilver/kernel/playbooks'
import { contentReviewProblems, type ContentReviewRecord } from './genesis-reviews.ts'

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
const sha256 = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')

export interface GenesisResearchTrajectory {
  trajectoryId: string
  playbookIdDigest: string
  metricDirection: 'higher-is-better' | 'lower-is-better'
  plannedDurationDays: number
  customerFacing: boolean
  observations: Array<{ day: number; signal: 'kill' | 'hold' | 'continue' | 'scale' }>
  decisions: Array<{ day: number; verdict: string; applied: string; authority: 'human' | 'kernel' | 'other' }>
  contentReviewSignals: Array<{ channel: string; kind: 'manual' | 'waes'; verdict: 'pass' | 'revise' | 'block' }>
  outcome: { status: Experiment['status']; durationDays: number | null; budgetUseRatio: number; revenueToBudgetRatio: number }
}

export interface GenesisResearchDataset {
  schemaVersion: 1
  kind: 'quicksilver.genesis-research-trajectories'
  generatedAt: string
  exportedBy: string
  privacyReview: { declaration: 'structured-only-no-free-text'; noteDigest: string }
  source: { runIdDigest: string; ledgerDigest: string; experimentDigest: string; reviewsDigest: string }
  includedCount: number
  excludedWithoutDecisionCount: number
  trajectories: GenesisResearchTrajectory[]
  digest: string
}

function channelCategory(channel: string): string {
  const known = new Set(['landing-page', 'email', 'ad', 'sms', 'website', 'social-post'])
  return known.has(channel) ? channel : 'other'
}

export function verifyGenesisResearchDataset(value: unknown): value is GenesisResearchDataset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const dataset = value as GenesisResearchDataset
  if (dataset.schemaVersion !== 1 || dataset.kind !== 'quicksilver.genesis-research-trajectories' || !Array.isArray(dataset.trajectories) || typeof dataset.digest !== 'string') return false
  const { digest: supplied, ...core } = dataset
  return supplied === sha256(core)
}

/**
 * Project founder-reviewed Genesis experiments into a low-disclosure,
 * quantitative learning dataset. Free text, raw measurements, transaction
 * details, reviewer identities, secret references, and private reasoning are
 * deliberately never included.
 */
export function exportGenesisResearchTrajectories(input: {
  runId: string
  experiments: Experiment[]
  ledger: MoneyLedger
  reviews: ContentReviewRecord[]
  reviewer: { id: string; kind: 'human' | 'agent' | 'service' }
  privacyNote: string
  now: Date
}): GenesisResearchDataset {
  if (!input.runId.trim()) throw new Error('A Genesis run id is required.')
  if (input.ledger.runId !== input.runId || !verifyMoneyLedger(input.ledger).valid) throw new Error('The Genesis ledger does not verify for this run; research export refused.')
  if (input.reviewer.kind !== 'human' || !input.reviewer.id.trim()) throw new Error('Only a named human can approve a research export.')
  if (!input.privacyNote.trim() || input.privacyNote.length > 500) throw new Error('A privacy review note of 1 to 500 characters is required.')
  if (Number.isNaN(input.now.getTime())) throw new Error('Export time is invalid.')

  for (const experiment of input.experiments) {
    if (experiment.digest !== experimentDigest(experiment.definition)) throw new Error(`Experiment ${experiment.definition.id} failed its definition digest check; research export refused.`)
    if (experiment.measurements.some((measurement) => !Number.isFinite(Date.parse(measurement.at)) || !Number.isFinite(measurement.value))) throw new Error(`Experiment ${experiment.definition.id} has an invalid measurement; research export refused.`)
    if (experiment.decisions.some((decision) => !Number.isFinite(Date.parse(decision.at)))) throw new Error(`Experiment ${experiment.definition.id} has an invalid decision timestamp; research export refused.`)
  }
  for (const review of input.reviews) if (contentReviewProblems(review).length) throw new Error(`Content review ${review.reviewId} is invalid; research export refused.`)

  const totals = moneyTotals(input.ledger)
  const decided = input.experiments.filter((experiment) => experiment.decisions.length > 0)
    .sort((a, b) => a.startedAt?.localeCompare(b.startedAt ?? '') || a.digest.localeCompare(b.digest))
  const trajectories = decided.map((experiment, index): GenesisResearchTrajectory => {
    const started = experiment.startedAt ? Date.parse(experiment.startedAt) : NaN
    const day = (at: string) => Number.isFinite(started) ? Math.max(0, Math.floor((Date.parse(at) - started) / 86_400_000)) : 0
    const perExperiment = totals.byExperiment[experiment.definition.id] ?? { capitalUsedUsd: 0, revenueUsd: 0 }
    const budget = experiment.definition.budgetUsd
    return {
      trajectoryId: `trajectory-${index + 1}`,
      playbookIdDigest: sha256(experiment.definition.playbookId),
      metricDirection: experiment.definition.metric.direction,
      plannedDurationDays: experiment.definition.durationDays,
      customerFacing: experiment.definition.customerFacing,
      observations: [...experiment.measurements].sort((a, b) => a.at.localeCompare(b.at)).map((measurement) => ({ day: day(measurement.at), signal: judgeMetric(experiment.definition.metric, measurement.value) })),
      decisions: [...experiment.decisions].sort((a, b) => a.at.localeCompare(b.at)).map((decision) => ({
        day: day(decision.at),
        verdict: decision.verdict,
        applied: decision.applied,
        authority: decision.by === 'kernel' ? 'kernel' : decision.by === input.reviewer.id ? 'human' : 'other',
      })),
      contentReviewSignals: input.reviews.filter((review) => review.experimentId === experiment.definition.id)
        .map((review) => ({ channel: channelCategory(review.channel), kind: review.kind, verdict: review.verdict })),
      outcome: {
        status: experiment.status,
        durationDays: experiment.startedAt && experiment.endsAt
          ? Math.max(0, Math.floor((Date.parse(experiment.endsAt) - started) / 86_400_000))
          : null,
        budgetUseRatio: budget > 0 ? Math.round((perExperiment.capitalUsedUsd / budget) * 10_000) / 10_000 : 0,
        revenueToBudgetRatio: budget > 0 ? Math.round((perExperiment.revenueUsd / budget) * 10_000) / 10_000 : 0,
      },
    }
  })
  const core = {
    schemaVersion: 1 as const,
    kind: 'quicksilver.genesis-research-trajectories' as const,
    generatedAt: input.now.toISOString(),
    exportedBy: input.reviewer.id,
    privacyReview: { declaration: 'structured-only-no-free-text' as const, noteDigest: sha256(input.privacyNote.trim()) },
    source: {
      runIdDigest: sha256(input.runId),
      ledgerDigest: sha256(input.ledger.entries.map((entry) => entry.hash)),
      experimentDigest: sha256(input.experiments.map((experiment) => experiment.digest).sort()),
      reviewsDigest: sha256(input.reviews.map((review) => ({ contentDigest: review.contentDigest, verdict: review.verdict, kind: review.kind })).sort((a, b) => a.contentDigest.localeCompare(b.contentDigest))),
    },
    includedCount: trajectories.length,
    excludedWithoutDecisionCount: input.experiments.length - trajectories.length,
    trajectories,
  }
  const dataset = { ...core, digest: sha256(core) }
  if (!verifyGenesisResearchDataset(dataset)) throw new Error('The generated research dataset failed its own integrity check.')
  return dataset
}
