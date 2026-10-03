'use client'

import Link from 'next/link'
import { AttentionList } from '@/components/attention-list'
import { useCallback, useEffect, useState } from 'react'
import { authFailureMessage, consoleHeaders, resolveConsoleAccess, type ConsoleAccess, type ConsoleRoute } from '@/lib/console-auth'
import type { BusinessOverview, FinanceOverview } from '@/lib/business-dashboard'

type WorkflowRun = { runId: string; workflowId: string; status: 'succeeded' | 'blocked' | 'failed'; completedAt: number; durationMs: number }
type WorkflowResponse = { executions: WorkflowRun[]; observedAt: number; sampleLimit: number }

async function getJson<T>(path: string, route: ConsoleRoute, token: string | null): Promise<T> {
  const response = await fetch(path, { headers: consoleHeaders(path, token), cache: 'no-store' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = authFailureMessage(response.status, route, payload.error, payload.retryAfterSeconds)
      ?? payload.error
      ?? 'This dashboard section could not be loaded.'
    throw new Error(error)
  }
  return payload as T
}

function currency(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

function when(value: string | number | null | undefined) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function BusinessDashboard() {
  const [access, setAccess] = useState<ConsoleAccess | null>(null)
  const signedIn = Boolean(access?.signedIn)
  const [overview, setOverview] = useState<BusinessOverview | null>(null)
  const [finance, setFinance] = useState<FinanceOverview | null>(null)
  const [workflowData, setWorkflowData] = useState<WorkflowResponse | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [financeError, setFinanceError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (current: ConsoleAccess | null = access) => {
    if (!current?.signedIn) {
      setOverview(null)
      setFinance(null)
      setWorkflowData(null)
      return
    }
    setLoading(true)
    const [business, financial, workflows] = await Promise.allSettled([
      getJson<BusinessOverview>('/api/dashboard/overview', 'dashboard/overview', current.token),
      getJson<FinanceOverview>('/api/dashboard/finance', 'dashboard/finance', current.token),
      getJson<WorkflowResponse>('/api/monitoring/workflows', 'monitoring/workflows', current.token),
    ])
    if (business.status === 'fulfilled') { setOverview(business.value); setOverviewError(null) }
    else { setOverview(null); setOverviewError(business.reason instanceof Error ? business.reason.message : 'Business records are unavailable.') }
    if (financial.status === 'fulfilled') { setFinance(financial.value); setFinanceError(null) }
    else { setFinance(null); setFinanceError(financial.reason instanceof Error ? financial.reason.message : 'Finance records are unavailable.') }
    if (workflows.status === 'fulfilled') { setWorkflowData(workflows.value); setWorkflowError(null) }
    else { setWorkflowData(null); setWorkflowError(workflows.reason instanceof Error ? workflows.reason.message : 'Workflow activity is unavailable.') }
    setLoading(false)
  }, [access])

  useEffect(() => { void resolveConsoleAccess().then(setAccess) }, [])
  useEffect(() => { if (access?.signedIn) void refresh(access) }, [refresh, access])

  const runs = workflowData?.executions ?? []
  const succeeded = runs.filter((run) => run.status === 'succeeded').length
  const successRate = runs.length ? Math.round((succeeded / runs.length) * 100) : null
  const pending = overview?.decisionCounts.awaitingApproval ?? 0
  const activeExperiments = overview?.experiments.filter((experiment) => experiment.status === 'running') ?? []

  return (
    <main className="app-main qs-business-dashboard">
      <header className="qs-dashboard-heading">
        <div>
          <p className="qs-eyebrow">Owner workspace · operating overview</p>
          <h1 className="qs-page-heading">Business overview</h1>
          <p className="qs-page-heading__summary">See what needs your attention, how governed work is progressing, and what the system has actually recorded.</p>
        </div>
        <div className="qs-dashboard-heading__actions">
          {workflowData?.observedAt && <span className="qs-dashboard-updated">Updated {when(workflowData.observedAt)}</span>}
          <button type="button" className="qs-action-secondary" onClick={() => void refresh()} disabled={!signedIn || loading}>
            {loading ? 'Refreshing…' : 'Refresh overview'}
          </button>
        </div>
      </header>

      {access !== null && !signedIn && <section className="qs-dashboard-signin" aria-labelledby="dashboard-signin-title">
        <div><p className="qs-eyebrow">Sign in to load your business data</p><h2 id="dashboard-signin-title">Your operating picture is private to your principal.</h2><p>Sign in to load it. This overview reads existing decision, workflow, metric, experiment, and ledger records; it does not create activity or estimate missing values.</p></div>
        <Link className="qs-action-primary" href="/sign-in">Sign in</Link>
      </section>}

      {signedIn && (overviewError || workflowError) && <div className="qs-dashboard-errors">
        {overviewError && <p role="alert"><strong>Business records:</strong> {overviewError}</p>}
        {workflowError && <p role="alert"><strong>Workflow activity:</strong> {workflowError}</p>}
      </div>}
      {signedIn && financeError && <p role="status" className="qs-dashboard-finance-access">Money ledger is hidden: {financeError}</p>}

      <section aria-label="Business status summary" className="qs-dashboard-stat-grid">
        <article className="qs-dashboard-stat qs-dashboard-stat--attention"><span>Decisions needing review</span><strong>{overview ? pending : '—'}</strong><small>{overview ? `${overview.decisionCounts.total} total recorded` : signedIn ? 'Waiting for decision data' : 'Sign in to view'}</small></article>
        <article className="qs-dashboard-stat"><span>Experiments running</span><strong>{overview ? activeExperiments.length : '—'}</strong><small>{overview ? `${overview.experiments.length} recent experiment records` : signedIn ? 'Waiting for experiment data' : 'Sign in to view'}</small></article>
        <article className="qs-dashboard-stat"><span>Workflow success · recent sample</span><strong>{successRate === null ? '—' : `${successRate}%`}</strong><small>{workflowData ? `${runs.length} of up to ${workflowData.sampleLimit} recent runs` : signedIn ? 'Waiting for workflow data' : 'Sign in to view'}</small></article>
        <article className="qs-dashboard-stat"><span>Business measures</span><strong>{overview?.metrics.length ?? '—'}</strong><small>{overview ? 'Latest recorded metric documents' : signedIn ? 'Waiting for metric data' : 'Sign in to view'}</small></article>
      </section>

      <section className="qs-dashboard-main-grid">
        <article className="qs-panel qs-dashboard-panel" aria-labelledby="needs-attention-title">
          <div className="qs-dashboard-section-heading"><div><p className="qs-eyebrow">What needs you</p><h2 id="needs-attention-title">Needs your attention</h2></div><Link href="/decisions">Review decisions <span aria-hidden="true">→</span></Link></div>
          <AttentionList hideHeading />
        </article>

        <article className="qs-panel qs-dashboard-panel" aria-labelledby="quick-actions-title">
          <div className="qs-dashboard-section-heading"><div><p className="qs-eyebrow">Move work forward</p><h2 id="quick-actions-title">Quick actions</h2></div></div>
          <div className="qs-dashboard-actions">
            <button type="button" className="qs-dashboard-action" onClick={() => window.dispatchEvent(new Event('quicksilver:open-chat'))}><span aria-hidden="true">＋</span><span><strong>Plan an initiative</strong><small>Describe an outcome in the chat, then press the plan card to create it.</small></span><b aria-hidden="true">→</b></button>
            <Link href="/workflows" className="qs-dashboard-action"><span aria-hidden="true">◇</span><span><strong>Automate a process</strong><small>Build, validate, and publish a governed workflow.</small></span><b aria-hidden="true">→</b></Link>
            <Link href="/monitoring" className="qs-dashboard-action"><span aria-hidden="true">◷</span><span><strong>Check activity and cost</strong><small>See workflow runs, model calls and alerts.</small></span><b aria-hidden="true">→</b></Link>
            <Link href="/agents" className="qs-dashboard-action"><span aria-hidden="true">◎</span><span><strong>Manage your agents</strong><small>Review the published worker catalog and drafts.</small></span><b aria-hidden="true">→</b></Link>
          </div>
        </article>
      </section>

      <section className="qs-dashboard-main-grid qs-dashboard-main-grid--lower">
        <article className="qs-panel qs-dashboard-panel" aria-labelledby="business-measures-title">
          <div className="qs-dashboard-section-heading"><div><p className="qs-eyebrow">Observed company state</p><h2 id="business-measures-title">Business measures</h2></div></div>
          {!overview?.metrics.length ? <DashboardEmpty>{signedIn ? 'No operating metrics have been recorded yet. Values are never filled with sample or estimated data.' : 'Sign in to view recorded company measures.'}</DashboardEmpty> : <div className="qs-dashboard-metrics">{overview.metrics.map((metric) => <div className="qs-dashboard-metric" key={metric.id}><div><strong>{metric.name}</strong><small>{metric.baseline === null ? 'Baseline not recorded' : `Baseline ${metric.baseline}${metric.unit ? ` ${metric.unit}` : ''} · ${metric.direction === 'higher-better' ? 'higher is better' : metric.direction === 'lower-better' ? 'lower is better' : 'direction not set'}`}</small></div><b>{metric.value}{metric.unit ? ` ${metric.unit}` : ''}</b></div>)}</div>}
        </article>

        <article className="qs-panel qs-dashboard-panel" aria-labelledby="experiment-title">
          <div className="qs-dashboard-section-heading"><div><p className="qs-eyebrow">Genesis and business trials</p><h2 id="experiment-title">Experiments</h2></div><span className="qs-dashboard-count">{activeExperiments.length} running</span></div>
          {!overview?.experiments.length ? <DashboardEmpty>{signedIn ? 'No experiment records are available yet.' : 'Sign in to view experiments.'}</DashboardEmpty> : <ul className="qs-dashboard-list">{overview.experiments.map((experiment) => <li key={experiment.id}><span className={`qs-dashboard-status qs-dashboard-status--${experiment.status}`}>{experiment.status}</span><div><strong>{experiment.hypothesis}</strong><small>{experiment.budgetUsd === null ? 'Budget not recorded' : `${currency(experiment.budgetUsd)} budget`} · ends {when(experiment.endsAt)}</small></div></li>)}</ul>}
        </article>
      </section>

      <section className="qs-dashboard-main-grid qs-dashboard-main-grid--lower">
        <article className="qs-panel qs-dashboard-panel" aria-labelledby="recent-decisions-title">
          <div className="qs-dashboard-section-heading"><div><p className="qs-eyebrow">Governed activity</p><h2 id="recent-decisions-title">Recent decisions</h2></div><Link href="/decisions">Decision log <span aria-hidden="true">→</span></Link></div>
          {!overview?.recentDecisions.length ? <DashboardEmpty>{signedIn ? 'No decision records are available yet.' : 'Sign in to view recent decisions.'}</DashboardEmpty> : <ul className="qs-dashboard-list">{overview.recentDecisions.map((decision) => <li key={decision.id}><span className={`qs-dashboard-status qs-dashboard-status--${decision.status}`}>{decision.status.replaceAll('-', ' ')}</span><div><strong>{decision.title}</strong><small>{when(decision.createdAt)} · {decision.riskLevel === null ? 'Risk not recorded' : `risk ${decision.riskLevel}/5`}{decision.requiredApproval ? ' · approval required' : ''}{decision.safetyDecision ? ` · NQC ${decision.safetyDecision}` : ''}</small></div></li>)}</ul>}
        </article>

        <article className="qs-panel qs-dashboard-panel" aria-labelledby="ledger-title">
          <div className="qs-dashboard-section-heading"><div><p className="qs-eyebrow">Recorded financial activity</p><h2 id="ledger-title">Money ledger</h2></div></div>
          {!finance || finance.ledger.entryCount === 0 ? <DashboardEmpty>{finance ? 'No ledger entries are recorded. This is not a bank balance, live payments feed, or reconciled cash position.' : signedIn ? 'Ledger totals require a principal with finance access.' : 'Sign in to view recorded ledger totals.'}</DashboardEmpty> : <><div className="qs-ledger-net"><span>Net recorded</span><strong>{currency(finance.ledger.revenueUsd + finance.ledger.refundsUsd - finance.ledger.spendUsd - finance.ledger.computeUsd)}</strong></div><dl className="qs-ledger-breakdown"><div><dt>Revenue</dt><dd>{currency(finance.ledger.revenueUsd)}</dd></div><div><dt>Spend</dt><dd>{currency(finance.ledger.spendUsd)}</dd></div><div><dt>Compute</dt><dd>{currency(finance.ledger.computeUsd)}</dd></div><div><dt>Refunds</dt><dd>{currency(finance.ledger.refundsUsd)}</dd></div></dl><p className="qs-dashboard-disclaimer">{finance.ledger.entryCount} recorded entries · Ledger data only; processor and bank reconciliation are not connected.</p></>}
        </article>
      </section>

      {overview && <p className="qs-dashboard-footnote">Decision and business-record summaries come from the configured Sanity project; workflow outcomes come from the tenant-scoped execution history. Missing integrations are shown as unavailable, never estimated. The current storage model is single-tenant; multi-tenant hosting remains gated.</p>}
    </main>
  )
}

function DashboardEmpty({ children }: { children: React.ReactNode }) {
  return <p className="qs-dashboard-empty">{children}</p>
}
