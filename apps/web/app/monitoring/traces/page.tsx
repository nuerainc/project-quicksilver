'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authFailureMessage, consoleHeaders, readConsoleToken } from '@/lib/console-auth'

type TraceSpan = {
  traceId: string; spanId: string; parentSpanId: string | null; source: string; kind: string
  name: string; status: string; startedAt: number; durationMs: number; requestedBy: string
  runId: string | null; workflowId: string | null; decisionId: string | null; agentId: string | null
  modelId: string | null; toolName: string | null; toolSucceeded: boolean | null
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null
  estimatedCostUsd: number | null; safetyDecision: string | null
}
type Alert = { id: string; severity: 'warning' | 'critical'; summary: string; spanIds: string[] }
type TelemetryResponse = {
  spans: TraceSpan[]; alerts: Alert[]; observedAt: number; sampleLimit: number; windowMs: number
  totals: { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null }
}
type KindFilter = 'all' | TraceSpan['kind']

const API_PATH = '/api/monitoring/traces'
const CONSOLE_ROUTE = 'monitoring/traces' as const
const dateTime = (value: number) => new Date(value).toLocaleString()
const compactId = (value: string) => value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value

export default function TraceMonitoringPage() {
  const [data, setData] = useState<TelemetryResponse | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const token = readConsoleToken()
    if (!token) {
      setData(null)
      setLoading(false)
      setError(`${authFailureMessage(401, CONSOLE_ROUTE)}. Sign in with a principal that has audit:read.`)
      return
    }
    try {
      const response = await fetch(API_PATH, { headers: consoleHeaders(API_PATH, token), cache: 'no-store' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(authFailureMessage(response.status, CONSOLE_ROUTE, result.error) ?? result.error ?? 'Could not load trace data.')
      setData(result as TelemetryResponse)
    } catch (cause) {
      setError((cause as Error).message || 'Could not load trace data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const filtered = useMemo(() => (data?.spans ?? []).filter((span) =>
    (kind === 'all' || span.kind === kind)
    && (!search.trim() || [span.name, span.source, span.agentId, span.modelId, span.toolName, span.workflowId, span.decisionId, span.traceId]
      .some((value) => value?.toLowerCase().includes(search.trim().toLowerCase()))),
  ), [data, kind, search])

  const modelCalls = data?.spans.filter((span) => span.kind === 'model').length ?? 0
  const toolCalls = data?.spans.filter((span) => span.kind === 'tool').length ?? 0
  const failures = data?.spans.filter((span) => span.status === 'error' || span.status === 'blocked').length ?? 0

  return <main className="app-main space-y-6">
    <header className="qs-page-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl"><p className="qs-eyebrow">Operations · Observability</p><h1 className="mt-2">Traces &amp; alerts</h1>
          <p className="qs-page-heading__summary mt-3">Inspect recent query, plan, and workflow activity using bounded metadata. Prompts, agent responses, tool arguments, and secrets are excluded.</p></div>
        <button onClick={() => void refresh()} disabled={loading} className="qs-action-secondary">{loading ? 'Refreshing…' : 'Refresh traces'}</button>
      </div>
    </header>

    {error && <div role="alert" className="rounded border border-amber-300/40 bg-amber-300/5 p-4 text-sm text-amber-100">{error}</div>}

    <section aria-label="Trace summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {[
        ['Trace spans', data?.spans.length ?? 0, `Latest ${data?.sampleLimit ?? 200} records`],
        ['Model calls', modelCalls, 'Provider-reported usage only'],
        ['Tool calls', toolCalls, 'Read-only tool activity'],
        ['Failed or blocked', failures, 'Errors and governance stops'],
        ['Estimated cost', data?.totals.estimatedCostUsd === null || data?.totals.estimatedCostUsd === undefined ? '—' : `$${data.totals.estimatedCostUsd.toFixed(4)}`, data?.totals.estimatedCostUsd == null ? 'No measured rate configured' : 'Estimate; not provider billing'],
      ].map(([label, value, note]) => <article key={String(label)} className="qs-panel"><p className="text-sm text-white/65">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight text-white">{loading ? '—' : value}</p><p className="mt-2 text-xs leading-5 text-white/55">{note}</p></article>)}
    </section>

    <section aria-labelledby="telemetry-alerts-title" className="qs-panel">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="qs-eyebrow">Policy signals</p><h2 id="telemetry-alerts-title" className="mt-1 text-xl font-semibold text-white">Alerts</h2></div>
        <p className="text-xs text-white/50">Window: {data ? `${Math.round(data.windowMs / 60_000)} minutes` : '—'} · evaluated {data ? dateTime(data.observedAt) : '—'}</p></div>
      {loading && !data ? <p role="status" className="py-6 text-sm text-white/60">Loading alert summary…</p>
        : !data?.alerts.length ? <p className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-100">No configured alerts in the current sample.</p>
          : <ul className="mt-4 grid gap-3">{data.alerts.map((alert) => <li key={alert.id} className={`rounded-lg border p-4 ${alert.severity === 'critical' ? 'border-rose-300/30 bg-rose-300/5' : 'border-amber-300/30 bg-amber-300/5'}`}><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-1 text-[11px] uppercase tracking-wide ${alert.severity === 'critical' ? 'bg-rose-300/10 text-rose-100' : 'bg-amber-300/10 text-amber-100'}`}>{alert.severity}</span><span className="text-xs text-white/55">{alert.id}</span></div><p className="mt-2 text-sm text-white/85">{alert.summary}</p></li>)}</ul>}
    </section>

    <section aria-labelledby="trace-history-title" className="qs-panel">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><p className="qs-eyebrow">Recent activity</p><h2 id="trace-history-title" className="mt-1 text-xl font-semibold text-white">Trace spans</h2><p className="mt-2 text-sm text-white/55">{data ? `Updated ${dateTime(data.observedAt)} · ${filtered.length} shown` : 'Waiting for data'}</p></div>
        <div className="grid w-full gap-3 sm:grid-cols-[minmax(12rem,1fr)_auto] xl:w-auto"><label className="sr-only" htmlFor="trace-search">Search trace metadata</label><input id="trace-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search IDs, agents, models" className="qs-field" />
          <label className="sr-only" htmlFor="trace-kind">Filter span kind</label><select id="trace-kind" value={kind} onChange={(event) => setKind(event.target.value as KindFilter)} className="qs-field sm:min-w-40"><option value="all">All span types</option><option value="request">Requests</option><option value="model">Models</option><option value="tool">Tools</option><option value="evaluation">Evaluations</option><option value="decision">Decisions</option><option value="workflow">Workflows</option></select></div>
      </div>
      {loading && !data ? <p role="status" className="py-12 text-center text-sm text-white/60">Loading trace spans…</p>
        : !filtered.length ? <p className="py-12 text-center text-sm text-white/60">{data?.spans.length ? 'No spans match these filters.' : 'No traces have been recorded for this tenant yet.'}</p>
          : <div className="mt-5 space-y-3">{filtered.map((span) => <article key={`${span.traceId}:${span.spanId}`} className="min-w-0 rounded-xl border border-white/10 bg-black/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-all font-medium text-white">{span.name}</h3><span className="rounded-full bg-white/5 px-2 py-1 text-[11px] text-white/65">{span.kind}</span><span className={`rounded-full px-2 py-1 text-[11px] ${span.status === 'ok' ? 'bg-emerald-400/10 text-emerald-100' : span.status === 'blocked' ? 'bg-amber-300/10 text-amber-100' : 'bg-rose-400/10 text-rose-100'}`}>{span.status}</span></div><p className="mt-2 break-all text-xs text-white/50">Trace {compactId(span.traceId)} · {span.source} · {dateTime(span.startedAt)}</p></div><span className="shrink-0 text-xs text-white/55">{span.durationMs} ms</span></div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 xl:grid-cols-6">{[
              ['Agent', span.agentId], ['Model', span.modelId], ['Tool', span.toolName], ['Tokens', span.totalTokens === null ? null : span.totalTokens.toLocaleString()], ['Safety', span.safetyDecision], ['Run', span.runId ?? span.workflowId ?? span.decisionId],
            ].filter((item) => item[1]).map(([label, value]) => <div key={String(label)} className="min-w-0"><dt className="text-[11px] uppercase tracking-wide text-white/45">{label}</dt><dd className="mt-1 break-all text-white/80">{value}</dd></div>)}</dl>
          </article>)}</div>}
    </section>
    <p className="qs-helper px-1">Cost appears only when a measured model profile provides a rate. Alerts are evaluated in-app against configured thresholds; they do not send external notifications. This bounded sample is not a complete historical time series.</p>
  </main>
}
