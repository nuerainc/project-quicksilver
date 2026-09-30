'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authFailureMessage, consoleHeaders, readConsoleToken } from '@/lib/console-auth'

type Execution = {
  runId: string
  workflowId: string
  version: number
  digest: string
  requestedBy: string
  status: 'succeeded' | 'blocked' | 'failed'
  startedAt: number
  completedAt: number
  durationMs: number
  evaluationCount: number
}
type MonitoringResponse = { executions: Execution[]; observedAt: number; sampleLimit: number }
type StatusFilter = 'all' | Execution['status']

const API_PATH = '/api/monitoring/workflows'
const CONSOLE_ROUTE = 'monitoring/workflows' as const

function displayDate(value: number): string {
  return new Date(value).toLocaleString()
}

function duration(value: number): string {
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(2)} s`
}

export default function WorkflowMonitoringPage() {
  const [executions, setExecutions] = useState<Execution[]>([])
  const [sampleLimit, setSampleLimit] = useState(100)
  const [observedAt, setObservedAt] = useState<number | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const token = readConsoleToken()
    if (!token) {
      setExecutions([])
      setLoading(false)
      setError(`${authFailureMessage(401, CONSOLE_ROUTE)}. Return to the home page and sign in with a principal that has workflow:read.`)
      return
    }
    try {
      const response = await fetch(API_PATH, { headers: consoleHeaders(API_PATH, token), cache: 'no-store' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(authFailureMessage(response.status, CONSOLE_ROUTE, result.error) ?? result.error ?? 'Could not load monitoring data.')
      const data = result as MonitoringResponse
      setExecutions(data.executions)
      setSampleLimit(data.sampleLimit)
      setObservedAt(data.observedAt)
    } catch (cause) {
      setError((cause as Error).message || 'Could not load monitoring data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const filtered = useMemo(() => executions.filter((run) =>
    (status === 'all' || run.status === status)
    && (!query.trim() || run.workflowId.toLowerCase().includes(query.trim().toLowerCase()) || run.requestedBy.toLowerCase().includes(query.trim().toLowerCase())),
  ), [executions, query, status])

  const stats = useMemo(() => {
    const durations = executions.map((run) => run.durationMs).sort((a, b) => a - b)
    const middle = Math.floor(durations.length / 2)
    const median = durations.length === 0 ? 0 : durations.length % 2 === 0
      ? Math.round((durations[middle - 1]! + durations[middle]!) / 2)
      : durations[middle]!
    const succeeded = executions.filter((run) => run.status === 'succeeded').length
    return {
      total: executions.length,
      succeeded,
      blocked: executions.filter((run) => run.status === 'blocked').length,
      failed: executions.filter((run) => run.status === 'failed').length,
      workflows: new Set(executions.map((run) => run.workflowId)).size,
      successRate: executions.length ? Math.round((succeeded / executions.length) * 100) : 0,
      medianDuration: median,
    }
  }, [executions])

  return (
    <main className="app-main space-y-6">
      <header className="qs-page-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="qs-eyebrow">Operations</p>
            <h1 className="mt-2">Workflow monitoring</h1>
            <p className="qs-page-heading__summary mt-3">Recent workflow outcomes for this tenant. This view uses execution metadata only and never loads request or response bodies.</p>
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="qs-action-secondary">
            {loading ? 'Refreshing…' : 'Refresh activity'}
          </button>
        </div>
      </header>

      {error && <div role="alert" className="mb-6 rounded border border-amber-300/40 bg-amber-300/5 p-4 text-sm text-amber-100">{error}</div>}

      <section aria-label="Recent workflow metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Sampled runs', stats.total, `Latest ${sampleLimit} records maximum`],
          ['Success rate', `${stats.successRate}%`, `${stats.succeeded} successful`],
          ['Blocked', stats.blocked, 'Stopped by governance'],
          ['Failed', stats.failed, 'Unsuccessful executions'],
          ['Median duration', duration(stats.medianDuration), `${stats.workflows} workflows in sample`],
        ].map(([label, value, note]) => <article key={label} className="qs-panel">
          <p className="text-sm text-white/65">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-white">{loading ? '—' : value}</p>
          <p className="mt-2 text-xs leading-5 text-white/55">{note}</p>
        </article>)}
      </section>

      <section aria-labelledby="execution-history-title" className="qs-panel">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="qs-eyebrow">Activity</p>
            <h2 id="execution-history-title" className="mt-1 text-xl font-semibold text-white">Execution history</h2>
            <p className="mt-2 text-sm text-white/55">{observedAt ? `Updated ${displayDate(observedAt)} · showing ${executions.length} of at most ${sampleLimit} recent runs` : 'Waiting for data'}</p>
          </div>
          <div className="grid w-full gap-3 sm:grid-cols-[minmax(12rem,1fr)_auto] xl:w-auto">
            <label className="sr-only" htmlFor="workflow-monitor-search">Filter workflows or requesters</label>
            <input id="workflow-monitor-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflow or requester" className="qs-field" />
            <label className="sr-only" htmlFor="workflow-monitor-status">Filter status</label>
            <select id="workflow-monitor-status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="qs-field sm:min-w-40">
              <option value="all">All statuses</option><option value="succeeded">Succeeded</option><option value="blocked">Blocked</option><option value="failed">Failed</option>
            </select>
          </div>
        </div>

        {loading && executions.length === 0 ? <p role="status" className="py-12 text-center text-sm text-white/60">Loading recent executions…</p>
          : filtered.length === 0 ? <p className="py-12 text-center text-sm text-white/60">{executions.length ? 'No executions match these filters.' : 'No published workflow executions are recorded for this tenant yet.'}</p>
            : <><div className="mt-5 space-y-3 lg:hidden">{filtered.map((run) => <article key={run.runId} className="grid min-w-0 gap-4 rounded-xl border border-white/10 bg-black/10 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-semibold text-white">{run.workflowId}</h3><p className="mt-1 text-xs text-white/55">Version {run.version}</p></div><span className={`rounded-full px-3 py-1 text-xs font-medium ${run.status === 'succeeded' ? 'bg-emerald-400/10 text-emerald-200' : run.status === 'blocked' ? 'bg-amber-300/10 text-amber-100' : 'bg-rose-400/10 text-rose-200'}`}>{run.status}</span></div><dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-white/50">Duration</dt><dd className="mt-1">{duration(run.durationMs)}</dd></div><div><dt className="text-xs text-white/50">Evaluations</dt><dd className="mt-1">{run.evaluationCount}</dd></div><div className="min-w-0"><dt className="text-xs text-white/50">Requester</dt><dd className="mt-1 break-words">{run.requestedBy}</dd></div><div><dt className="text-xs text-white/50">Completed</dt><dd className="mt-1 break-words">{displayDate(run.completedAt)}</dd></div></dl></article>)}</div><div className="mt-5 hidden overflow-x-auto lg:block"><table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead><tr className="border-b border-white/10 text-left text-xs font-medium text-white/55"><th scope="col" className="py-3 pr-4">Workflow</th><th scope="col" className="py-3 pr-4">Outcome</th><th scope="col" className="py-3 pr-4">Duration</th><th scope="col" className="py-3 pr-4">Evaluations</th><th scope="col" className="py-3 pr-4">Requester</th><th scope="col" className="py-3">Completed</th></tr></thead>
              <tbody>{filtered.map((run) => <tr key={run.runId} className="border-b border-white/10 text-white/85 last:border-0">
                <td className="py-4 pr-4"><span className="break-all font-medium">{run.workflowId}</span><span className="ml-2 text-xs text-white/50">v{run.version}</span></td>
                <td className="py-4 pr-4"><span className={run.status === 'succeeded' ? 'text-emerald-200' : run.status === 'blocked' ? 'text-amber-100' : 'text-rose-200'}>{run.status}</span></td>
                <td className="py-4 pr-4">{duration(run.durationMs)}</td><td className="py-4 pr-4">{run.evaluationCount}</td><td className="py-4 pr-4">{run.requestedBy}</td><td className="py-4 text-white/60">{displayDate(run.completedAt)}</td>
              </tr>)}</tbody>
            </table></div></>}
      </section>
      <p className="qs-helper px-1">Summary values cover the latest {sampleLimit} metadata records and are not a complete historical time series. Host queue depth, model traces, alerting, and retention controls are not yet available in this view.</p>
    </main>
  )
}
