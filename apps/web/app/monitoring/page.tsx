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
    <main className="app-main">
      <header className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-quicksilver-accent">Operations</p>
            <h1 className="mt-2 font-mono text-2xl uppercase tracking-[0.14em] text-quicksilver-quicksilver">Workflow monitoring</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-quicksilver-accent">Recent tenant-scoped workflow outcomes and runtimes. This view reads metadata only; it never loads request or response bodies.</p>
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="rounded border border-quicksilver-border px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-quicksilver-signal hover:border-quicksilver-quicksilver disabled:opacity-50">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div role="alert" className="mb-6 rounded border border-amber-300/40 bg-amber-300/5 p-4 text-sm text-amber-100">{error}</div>}

      <section aria-label="Recent workflow metrics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['Sampled runs', stats.total, `Latest ${sampleLimit} records maximum`],
          ['Success rate', `${stats.successRate}%`, `${stats.succeeded} successful`],
          ['Blocked', stats.blocked, 'Stopped by governance'],
          ['Failed', stats.failed, 'Unsuccessful executions'],
          ['Median duration', duration(stats.medianDuration), `${stats.workflows} workflows in sample`],
        ].map(([label, value, note]) => <article key={label} className="rounded border border-quicksilver-border bg-quicksilver-panel p-4">
          <p className="font-mono text-[9px] uppercase tracking-widest text-quicksilver-accent">{label}</p>
          <p className="mt-3 font-mono text-2xl text-quicksilver-signal">{loading ? '—' : value}</p>
          <p className="mt-2 text-[10px] text-quicksilver-accent">{note}</p>
        </article>)}
      </section>

      <section className="mt-8 rounded border border-quicksilver-border bg-quicksilver-panel p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Execution history</h2>
            <p className="mt-1 text-[10px] text-quicksilver-accent">{observedAt ? `Updated ${displayDate(observedAt)} · ${executions.length} of at most ${sampleLimit} recent runs` : 'Waiting for data'}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="sr-only" htmlFor="workflow-monitor-search">Filter workflows or requesters</label>
            <input id="workflow-monitor-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter workflow or requester" className="rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-xs text-quicksilver-signal placeholder:text-quicksilver-accent/60" />
            <label className="sr-only" htmlFor="workflow-monitor-status">Filter status</label>
            <select id="workflow-monitor-status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 font-mono text-[10px] uppercase text-quicksilver-signal">
              <option value="all">All statuses</option><option value="succeeded">Succeeded</option><option value="blocked">Blocked</option><option value="failed">Failed</option>
            </select>
          </div>
        </div>

        {loading && executions.length === 0 ? <p className="py-12 text-center text-sm text-quicksilver-accent">Loading recent executions…</p>
          : filtered.length === 0 ? <p className="py-12 text-center text-sm text-quicksilver-accent">{executions.length ? 'No executions match these filters.' : 'No published workflow executions are recorded for this tenant yet.'}</p>
            : <><div className="mt-4 space-y-3 lg:hidden">{filtered.map((run) => <article key={run.runId} className="grid min-w-0 gap-3 rounded border border-quicksilver-border bg-quicksilver-bg p-4"><div className="min-w-0"><h3 className="break-words font-mono text-sm text-quicksilver-signal">{run.workflowId} <span className="text-xs text-quicksilver-accent">v{run.version}</span></h3><p className={`mt-1 text-sm ${run.status === 'succeeded' ? 'text-emerald-300' : run.status === 'blocked' ? 'text-amber-200' : 'text-rose-300'}`}>{run.status}</p></div><dl className="grid grid-cols-2 gap-3 text-xs"><div><dt className="text-quicksilver-accent">Duration</dt><dd className="mt-1 font-mono">{duration(run.durationMs)}</dd></div><div><dt className="text-quicksilver-accent">Evaluations</dt><dd className="mt-1">{run.evaluationCount}</dd></div><div className="min-w-0"><dt className="text-quicksilver-accent">Requester</dt><dd className="mt-1 break-words">{run.requestedBy}</dd></div><div><dt className="text-quicksilver-accent">Completed</dt><dd className="mt-1 break-words">{displayDate(run.completedAt)}</dd></div></dl></article>)}</div><div className="mt-4 hidden overflow-x-auto lg:block"><table className="w-full min-w-[760px] border-collapse text-left text-xs">
              <thead><tr className="border-b border-quicksilver-border font-mono text-[9px] uppercase tracking-widest text-quicksilver-accent"><th className="py-3 pr-4">Workflow</th><th className="py-3 pr-4">Outcome</th><th className="py-3 pr-4">Duration</th><th className="py-3 pr-4">Evaluations</th><th className="py-3 pr-4">Requester</th><th className="py-3">Completed</th></tr></thead>
              <tbody>{filtered.map((run) => <tr key={run.runId} className="border-b border-quicksilver-border/60 text-quicksilver-signal last:border-0">
                <td className="py-3 pr-4"><span className="font-mono text-quicksilver-signal">{run.workflowId}</span><span className="ml-2 text-[10px] text-quicksilver-accent">v{run.version}</span></td>
                <td className="py-3 pr-4"><span className={run.status === 'succeeded' ? 'text-emerald-300' : run.status === 'blocked' ? 'text-amber-200' : 'text-rose-300'}>{run.status}</span></td>
                <td className="py-3 pr-4 font-mono">{duration(run.durationMs)}</td><td className="py-3 pr-4">{run.evaluationCount}</td><td className="py-3 pr-4">{run.requestedBy}</td><td className="py-3 text-quicksilver-accent">{displayDate(run.completedAt)}</td>
              </tr>)}</tbody>
            </table></div></>}
      </section>
      <p className="mt-4 text-[10px] leading-5 text-quicksilver-accent">Metrics are calculated from the latest {sampleLimit} metadata records, not a complete historical time series. This dashboard does not yet include host queue depth, model traces, alerting, or retention controls.</p>
    </main>
  )
}
