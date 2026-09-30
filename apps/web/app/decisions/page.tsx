/**
 * /decisions — the Decision Log.
 *
 * Sanity's own Studio already stores every `decision` document Quicksilver
 * has ever created, and `sanity-plugin-workflow` tracks a parallel state
 * machine per decision. Neither is meant for a non-technical reviewer: the
 * Studio is a content editor, and the workflow plugin's own board never
 * reliably reflects decisions created via the API rather than by hand in
 * the Studio UI (see BUILD-LOG.md, "Begin Workflow" investigation).
 *
 * This page is a read-only, front-of-house view of the same underlying
 * `decision` documents Quicksilver already writes -- no schema change, no
 * new write path, no dependency on the workflow plugin. It exists purely so
 * a reviewer (or the CEO) can see the full history of what the system has
 * proposed, approved, rejected, and executed, across every session, without
 * opening the Studio at all.
 *
 * Server Component: fetches directly from Sanity at request time (no
 * client-side fetch, no loading state to manage) and is deliberately
 * excluded from static generation (see `dynamic` below) since the decision
 * log is, by definition, always changing.
 */

import Link from 'next/link'
import { getSanityClient } from '@/lib/sanity-client'

export const dynamic = 'force-dynamic'

type PolicyCheckRow = {
  result: 'applies' | 'superseded' | 'conflicts' | 'inapplicable' | null
  reason: string | null
  policyName: string | null
}

type ReviewerNotes = {
  valid: boolean | null
  policyConflicts: string[] | null
  missingEvidence: string[] | null
  riskConcerns: string[] | null
  suggestions: string[] | null
} | null

type DecisionRow = {
  _id: string
  question: string | null
  selectedAction: string | null
  reasoningSummary: string | null
  riskLevel: number | null
  requiredApproval: boolean | null
  status: string | null
  createdAt: string | null
  executedAt: string | null
  approvedByName: string | null
  policyChecks: PolicyCheckRow[] | null
  evidenceTitles: string[] | null
  reviewerNotes: ReviewerNotes
  kind: string | null
  faultInjection: string | null
  processName: string | null
  processVersion: number | null
  processHistory: ProcessHistoryRow[] | null
}

type ProcessHistoryRow = {
  transitionId: string | null
  from: string | null
  to: string | null
  actorId: string | null
  actorType: string | null
  at: string | null
}

const DECISIONS_QUERY = `*[_type == "decision"] | order(coalesce(createdAt, _createdAt) desc) {
  _id,
  question,
  selectedAction,
  reasoningSummary,
  riskLevel,
  requiredApproval,
  status,
  createdAt,
  executedAt,
  "approvedByName": approvedBy->name,
  "policyChecks": policyChecks[]{
    result,
    reason,
    "policyName": policy->name
  },
  "evidenceTitles": evidence[]->title,
  reviewerNotes,
  kind,
  faultInjection,
  "processName": process.definition->name,
  "processVersion": process.version,
  processHistory[]{ transitionId, from, to, actorId, actorType, at }
}`

const STATUS_TONE: Record<string, string> = {
  proposed: 'border-quicksilver-border text-quicksilver-accent',
  'awaiting-approval': 'border-yellow-300/60 text-yellow-300',
  approved: 'border-quicksilver-quicksilver/60 text-quicksilver-signal',
  executed: 'border-green-400/60 text-green-400',
  failed: 'border-red-400/60 text-red-400',
  rejected: 'border-red-400/60 text-red-400',
  'rollback-proposed': 'border-yellow-300/60 text-yellow-300',
  'rolled-back': 'border-orange-400/60 text-orange-400',
}

function statusTone(status: string | null): string {
  return STATUS_TONE[status ?? ''] ?? 'border-quicksilver-border text-quicksilver-accent'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

async function loadDecisions(): Promise<{ decisions: DecisionRow[] | null; error: string | null }> {
  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return { decisions: null, error: 'Sanity project ID not configured.' }
  }
  try {
    const client = getSanityClient('read')
    const decisions = await client.fetch<DecisionRow[]>(DECISIONS_QUERY)
    return { decisions, error: null }
  } catch (err) {
    return { decisions: null, error: (err as Error).message }
  }
}

export default async function DecisionLogPage() {
  const { decisions, error } = await loadDecisions()
  const awaiting = decisions?.filter((d) => d.status === 'awaiting-approval').length ?? 0
  const executed = decisions?.filter((d) => d.status === 'executed').length ?? 0
  const conflicts = decisions?.reduce((count, d) => count + (d.policyChecks ?? []).filter((check) => check.result === 'conflicts').length, 0) ?? 0

  return (
    <main className="app-main">
      <header className="qs-page-heading">
        <p className="qs-eyebrow">Govern · Audit trail</p>
        <h1>Decision log</h1>
        <p className="qs-page-heading__summary">
          A read-only record of what Quicksilver proposed, approved, rejected, and executed. Entries are shown newest first from the kernel&apos;s decision records.
        </p>
      </header>

      {error && (
        <div className="qs-panel qs-inline-alert" role="alert">
          <strong>Decision history is unavailable.</strong>
          <p>{error}</p>
        </div>
      )}

      {!error && decisions && decisions.length === 0 && (
        <section className="qs-panel qs-empty-state" aria-labelledby="empty-decisions-title">
          <span className="qs-empty-state__icon" aria-hidden="true">✓</span>
          <h2 id="empty-decisions-title">No decisions yet</h2>
          <p>Start with a business objective. Quicksilver will prepare a plan for review before any action is taken.</p>
          <Link href="/" className="qs-action-primary">Create a plan</Link>
        </section>
      )}

      {!error && decisions && decisions.length > 0 && (
        <>
          <section className="qs-stat-grid" aria-label="Decision summary">
            <article className="qs-stat-card"><span>On record</span><strong>{decisions.length}</strong></article>
            <article className="qs-stat-card"><span>Awaiting approval</span><strong>{awaiting}</strong></article>
            <article className="qs-stat-card"><span>Executed</span><strong>{executed}</strong></article>
            <article className="qs-stat-card"><span>Policy conflicts</span><strong>{conflicts}</strong></article>
          </section>
          <section className="qs-decision-list" aria-label="Decision history">
            {decisions.map((d) => (
              <DecisionLogRow key={d._id} d={d} />
            ))}
          </section>
        </>
      )}
    </main>
  )
}

function DecisionLogRow({ d }: { d: DecisionRow }) {
  const flaggedPolicies = (d.policyChecks ?? []).filter((c) => c.result === 'conflicts')
  const reviewerFlagCount = d.reviewerNotes
    ? (d.reviewerNotes.policyConflicts?.length ?? 0) +
      (d.reviewerNotes.missingEvidence?.length ?? 0) +
      (d.reviewerNotes.riskConcerns?.length ?? 0)
    : 0

  return (
    <article className="qs-data-card">
      <header className="qs-data-card__header">
        <div className="qs-data-card__title">
          <time className="qs-data-card__date" dateTime={d.createdAt ?? undefined}>{formatDate(d.createdAt)}</time>
          <h2>{d.selectedAction || d.question || d._id}</h2>
        </div>
        <span className={`qs-status-badge ${statusTone(d.status)}`}>
          {d.status ?? 'Unknown'} <span aria-hidden="true">·</span> {d.riskLevel == null ? (d.kind === 'rollback' ? 'Rollback' : 'Risk not rated') : `Risk ${d.riskLevel}/5`}
        </span>
      </header>

      <dl className="qs-decision-facts">
        <Reference label="Human approval" value={d.requiredApproval ? 'Required' : 'Not required'} />
        <Reference label="Approved by" value={d.approvedByName ?? '—'} />
        <Reference label="Executed" value={formatDate(d.executedAt)} />
        <Reference label="Policy conflicts" value={flaggedPolicies.length > 0 ? String(flaggedPolicies.length) : 'None'} />
      </dl>

      {(d.processHistory?.length ?? 0) > 0 && (
        <div className="qs-nested-card">
          <h3 className="font-mono text-[11px] uppercase tracking-widest text-quicksilver-accent">
            Process: {d.processName ?? 'unknown'}{d.processVersion ? ` v${d.processVersion}` : ''}
            {d.faultInjection && (
              <span className="ml-2 normal-case tracking-normal text-yellow-300">
                · execution outcome forced by the e2e test ({d.faultInjection})
              </span>
            )}
          </h3>
          <ol className="mt-1 space-y-0.5">
            {d.processHistory!.map((h, i) => (
              <li key={i} className="font-mono text-xs text-quicksilver-signal">
                {h.from} → {h.to}{' '}
                <span className="text-quicksilver-accent">
                  ({h.transitionId} · {h.actorType === 'human' ? 'human' : h.actorId} · {formatDate(h.at)})
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(d.reasoningSummary || flaggedPolicies.length > 0 || reviewerFlagCount > 0 || (d.evidenceTitles?.length ?? 0) > 0) && (
        <details className="qs-decision-details">
          <summary>Inspect reasoning, review, and evidence</summary>
          <div className="qs-decision-details__body">
          {d.reasoningSummary && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-quicksilver-accent">
              {d.reasoningSummary}
            </p>
          )}
          {flaggedPolicies.length > 0 && (
            <div className="qs-detail-section">
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-quicksilver-accent">
                Policy conflicts
              </h3>
              <ul className="mt-1 space-y-1">
                {flaggedPolicies.map((c, i) => (
                  <li key={i} className="font-mono text-xs text-red-400">
                    • {c.policyName ?? 'unnamed policy'}: {c.reason ?? 'no reason recorded'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {reviewerFlagCount > 0 && d.reviewerNotes && (
            <div className="qs-detail-section qs-detail-section--review">
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-quicksilver-accent">
                Independent review ({reviewerFlagCount} flag{reviewerFlagCount === 1 ? '' : 's'})
              </h3>
              {[...(d.reviewerNotes.policyConflicts ?? []), ...(d.reviewerNotes.missingEvidence ?? []), ...(d.reviewerNotes.riskConcerns ?? [])].map(
                (note, i) => (
                  <p key={i} className="mt-1 font-mono text-xs text-yellow-300">
                    ⚠ {note}
                  </p>
                ),
              )}
            </div>
          )}
          {(d.evidenceTitles?.length ?? 0) > 0 && (
            <div className="qs-detail-section">
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-quicksilver-accent">
                Supporting evidence
              </h3>
              <ul className="mt-1 space-y-1">
                {d.evidenceTitles!.map((title, i) => (
                  <li key={i} className="font-mono text-xs text-quicksilver-accent">
                    • {title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          </div>
        </details>
      )}
    </article>
  )
}

function Reference({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">{label}</dt>
      <dd className="text-xs text-quicksilver-signal">{value}</dd>
    </div>
  )
}
