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

import { createClient } from '@sanity/client'

export const dynamic = 'force-dynamic'

function getSanityClient() {
  return createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    // Read-only here, but the project's existing token is already scoped for
    // this dataset and every other route in the app reuses it the same way.
    token: process.env.SANITY_AUTH_TOKEN,
  })
}

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
    const client = getSanityClient()
    const decisions = await client.fetch<DecisionRow[]>(DECISIONS_QUERY)
    return { decisions, error: null }
  } catch (err) {
    return { decisions: null, error: (err as Error).message }
  }
}

export default async function DecisionLogPage() {
  const { decisions, error } = await loadDecisions()

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-10">
        <a
          href="/"
          className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent transition hover:text-quicksilver-signal"
        >
          ← Back to console
        </a>
        <h1 className="qs-glow mt-4 font-mono text-3xl tracking-[0.3em] text-quicksilver-quicksilver">
          DECISION LOG
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-quicksilver-accent">
          Every decision Quicksilver has proposed, authorized, rejected, or executed —
          read-only, newest first. This is the same <code className="text-quicksilver-signal">decision</code>{' '}
          document the kernel writes on every run; nothing here is re-computed or summarized by an LLM.
        </p>
      </header>

      {error && (
        <p className="rounded border border-red-400/60 bg-quicksilver-panel p-4 font-mono text-xs text-red-400">
          Could not load the decision log: {error}
        </p>
      )}

      {!error && decisions && decisions.length === 0 && (
        <p className="rounded border border-quicksilver-border bg-quicksilver-panel p-6 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
          No decisions recorded yet. Send a CEO intent from the console to create the first one.
        </p>
      )}

      {!error && decisions && decisions.length > 0 && (
        <>
          <p className="mb-4 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
            {decisions.length} decision{decisions.length === 1 ? '' : 's'} on record
          </p>
          <section className="grid grid-cols-1 gap-4">
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
    <article className="rounded border border-quicksilver-border bg-quicksilver-panel p-5">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] uppercase tracking-widest text-quicksilver-accent">
            {formatDate(d.createdAt)}
          </p>
          <p className="mt-1 text-sm text-quicksilver-signal">
            {d.selectedAction || d.question || d._id}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-xs whitespace-nowrap ${statusTone(d.status)}`}
        >
          {d.riskLevel == null ? (d.kind === 'rollback' ? 'rollback' : 'risk —') : `risk ${d.riskLevel}/5`} · {d.status ?? 'unknown'}
        </span>
      </header>

      <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Reference label="Requires approval" value={d.requiredApproval ? 'yes' : 'no'} />
        <Reference label="Approved by" value={d.approvedByName ?? '—'} />
        <Reference label="Executed" value={formatDate(d.executedAt)} />
        <Reference
          label="Policy conflicts"
          value={flaggedPolicies.length > 0 ? String(flaggedPolicies.length) : 'none'}
        />
      </dl>

      {(d.processHistory?.length ?? 0) > 0 && (
        <div className="mb-3 rounded border border-quicksilver-border/60 p-3">
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

      {d.reasoningSummary && (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-quicksilver-accent">
          {d.reasoningSummary}
        </p>
      )}

      {(flaggedPolicies.length > 0 || reviewerFlagCount > 0 || (d.evidenceTitles?.length ?? 0) > 0) && (
        <div className="mt-3 border-t border-quicksilver-border pt-3">
          {flaggedPolicies.length > 0 && (
            <div className="mb-2">
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
            <div className="mb-2 rounded border border-dashed border-quicksilver-border p-3">
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
            <div>
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
