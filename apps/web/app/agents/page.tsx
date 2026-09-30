'use client'

import { useEffect, useState } from 'react'
import { authFailureMessage, consoleHeaders, readConsoleToken, type ConsoleRoute } from '@/lib/console-auth'

type Agent = { agentId: string; displayName: string; description: string; version: number; manifest: { authority: 'propose' | 'review'; tasks: string[]; maximumImpact: string; requiresEvaluation: boolean }; digest: string; authoredBy: string; lifecycle: 'draft' | 'in-review' | 'published' | 'archived'; reviewedBy?: string; reviewNote?: string; rollbackFrom?: { version: number; digest: string }; builtIn?: true }
type Catalog = { agents: Agent[]; drafts: Agent[]; reviewQueue: Agent[]; audit: Array<{ event: string; agentId: string; version: number; actorId: string; at: number }> }
const taskOptions = ['reasoning', 'code', 'bulk', 'planning', 'routing', 'tool', 'memory', 'hydraulic', 'evaluation', 'other']

export default function AgentsPage() {
  const [catalog, setCatalog] = useState<Catalog>({ agents: [], drafts: [], reviewQueue: [], audit: [] })
  const [permissions, setPermissions] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, Agent[]>>({})
  const [name, setName] = useState('')
  const [id, setId] = useState('nuera-quicksilver:')
  const [description, setDescription] = useState('')
  const [tasks, setTasks] = useState<string[]>(['reasoning'])
  const [authority, setAuthority] = useState<'propose' | 'review'>('propose')
  const [impact, setImpact] = useState('low')

  async function request(route: ConsoleRoute, method: 'GET' | 'POST', body?: unknown, query = '') {
    const token = readConsoleToken()
    if (!token) throw new Error('Sign in on the home page before managing agent definitions.')
    const url = `/api/${route}${query}`
    const response = await fetch(url, { method, headers: consoleHeaders(url, token, body ? { 'content-type': 'application/json' } : {}), ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(authFailureMessage(response.status, route, payload.error) ?? payload.error ?? 'Agent request failed.')
    return payload
  }
  async function refresh() {
    setError(null)
    try { setCatalog(await request('agents/catalog', 'GET') as Catalog) }
    catch (cause) { setError((cause as Error).message) }
  }
  useEffect(() => {
    void refresh()
    const token = readConsoleToken()
    if (!token) return
    void fetch('/api/whoami', { headers: consoleHeaders('/api/whoami', token), cache: 'no-store' }).then(async (response) => {
      if (response.ok) setPermissions((await response.json() as { permissions?: string[] }).permissions ?? [])
    }).catch(() => undefined)
  }, [])

  async function mutate(route: Extract<ConsoleRoute, `agents/${string}`>, body: unknown, message: string) {
    setBusy(true); setError(null); setNotice(null)
    try { await request(route, 'POST', body); setNotice(message); await refresh() }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await mutate('agents/drafts', { displayName: name, description, manifest: { id: id.trim(), version: 1, authority, tasks, maximumImpact: impact, requiresEvaluation: true } }, 'Draft saved. Submit it for review when ready.')
  }

  async function submitForReview(agent: Agent) {
    await mutate('agents/drafts/submit', { agentId: agent.agentId, version: agent.version }, 'Definition submitted to the review queue.')
  }
  async function review(agent: Agent) {
    const note = window.prompt(`Review rationale for ${agent.displayName} v${agent.version} (10–500 characters):`)
    if (!note) return
    await mutate('agents/review', { agentId: agent.agentId, version: agent.version, note }, 'Independent review recorded. A separate publisher must release this version.')
  }
  async function publish(agent: Agent) {
    await mutate('agents/publish', { agentId: agent.agentId, version: agent.version }, 'Agent definition published.')
  }
  async function loadHistory(agent: Agent) {
    setError(null)
    try {
      const result = await request('agents/definitions', 'GET', undefined, `?agentId=${encodeURIComponent(agent.agentId)}`) as { versions: Agent[] }
      setHistory((current) => ({ ...current, [agent.agentId]: result.versions }))
    } catch (cause) { setError((cause as Error).message) }
  }
  async function rollback(agent: Agent, sourceVersion: number) {
    await mutate('agents/rollback', { agentId: agent.agentId, sourceVersion }, `Rollback draft created from v${sourceVersion}. It must be reviewed and published as a new version.`)
  }

  return <main className="mx-auto max-w-6xl space-y-8 px-6 py-10 text-white">
    <header className="space-y-2"><p className="text-sm uppercase tracking-widest text-quicksilver-signal">NQC Kernel · Governance</p><h1 className="text-3xl font-semibold">Nuera Quicksilver Agents</h1><p className="max-w-3xl text-sm text-white/70">Review and publish versioned declarative agent contracts. Definitions describe task scope and impact limits; they do not install plugins or execute submitted code.</p><a href="/" className="text-sm text-quicksilver-signal hover:underline">← Console home</a></header>
    {error && <p role="alert" className="rounded border border-red-400/40 bg-red-950/30 p-3 text-sm">{error}</p>}{notice && <p role="status" className="rounded border border-emerald-400/40 bg-emerald-950/30 p-3 text-sm">{notice}</p>}
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5"><h2 className="mb-4 text-xl font-medium">Published catalog</h2>{catalog.agents.length ? <div className="grid gap-3 md:grid-cols-2">{catalog.agents.map((agent) => <article key={agent.agentId} className="rounded-lg border border-white/10 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-medium">{agent.displayName}</h3><p className="font-mono text-xs text-white/50">{agent.agentId} · v{agent.version}</p></div><span className="rounded bg-emerald-900/50 px-2 py-1 text-xs">{agent.builtIn ? 'built-in' : 'published'}</span></div><p className="mt-3 text-sm text-white/70">{agent.description}</p><p className="mt-3 text-xs text-white/50">Authority: {agent.manifest.authority} · Max impact: {agent.manifest.maximumImpact} · Evaluation required: {agent.manifest.requiresEvaluation ? 'yes' : 'no'}</p><p className="mt-1 text-xs text-white/50">Tasks: {agent.manifest.tasks.join(', ')}</p>{!agent.builtIn && permissions.includes('agent:write') && <div className="mt-3"><button disabled={busy} onClick={() => void loadHistory(agent)} className="rounded border border-white/20 px-3 py-2 text-sm disabled:opacity-50">{history[agent.agentId] ? 'Refresh versions' : 'View versions'}</button>{history[agent.agentId] && <div className="mt-3 space-y-2 border-t border-white/10 pt-3">{history[agent.agentId].map((version) => <div key={`${version.agentId}@${version.version}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="text-white/70">v{version.version} · {version.lifecycle}{version.rollbackFrom ? ` · rollback of v${version.rollbackFrom.version}` : ''}</span>{version.lifecycle === 'archived' && <button disabled={busy} onClick={() => void rollback(agent, version.version)} className="rounded border border-white/20 px-2 py-1 text-xs disabled:opacity-50">Create rollback draft</button>}</div>)}</div>}</div>}</article>)}</div> : <p className="text-sm text-white/60">Loading catalog…</p>}</section>
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5"><div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-medium">Review queue</h2><span className="text-sm text-white/50">{catalog.reviewQueue.length} awaiting review</span></div>{catalog.reviewQueue.length ? <div className="space-y-3">{catalog.reviewQueue.map((agent) => <article key={`${agent.agentId}@${agent.version}`} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-white/10 p-4"><div><h3 className="font-medium">{agent.displayName} · v{agent.version}</h3><p className="font-mono text-xs text-white/50">{agent.agentId} · author {agent.authoredBy}</p><p className="text-sm text-white/70">{agent.description}</p>{agent.rollbackFrom && <p className="mt-1 text-xs text-amber-200/80">Rollback draft from v{agent.rollbackFrom.version}; this new version still needs review.</p>}{agent.reviewNote && <p className="mt-1 text-xs text-white/60">Review: {agent.reviewNote}</p>}</div><div className="flex gap-2">{!agent.reviewedBy && permissions.includes('agent:review') && <button disabled={busy} onClick={() => void review(agent)} className="rounded border border-white/20 px-3 py-2 text-sm disabled:opacity-50">Record review</button>}{agent.reviewedBy && permissions.includes('agent:publish') && <button disabled={busy} onClick={() => void publish(agent)} className="rounded bg-quicksilver-signal px-3 py-2 text-sm font-medium text-black disabled:opacity-50">Publish</button>}</div></article>)}</div> : <p className="text-sm text-white/60">No definitions are awaiting review.</p>}</section>
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5"><h2 className="mb-4 text-xl font-medium">Drafts</h2>{catalog.drafts.length ? <div className="space-y-3">{catalog.drafts.map((agent) => <article key={`${agent.agentId}@${agent.version}`} className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-white/10 p-4"><div><h3 className="font-medium">{agent.displayName} · v{agent.version}</h3><p className="font-mono text-xs text-white/50">{agent.agentId} · author {agent.authoredBy}</p><p className="text-sm text-white/70">{agent.description}</p>{agent.rollbackFrom && <p className="mt-1 text-xs text-amber-200/80">Rollback draft copied from v{agent.rollbackFrom.version}.</p>}</div>{permissions.includes('agent:write') && <button disabled={busy} onClick={() => void submitForReview(agent)} className="rounded border border-white/20 px-3 py-2 text-sm disabled:opacity-50">Submit for review</button>}</article>)}</div> : <p className="text-sm text-white/60">No saved drafts.</p>}</section>
    {permissions.includes('agent:write') && <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5"><h2 className="mb-1 text-xl font-medium">Create declarative agent definition</h2><p className="mb-4 text-sm text-white/60">The draft is immutable once saved. Each revision creates a new version and requires human review before publication.</p><form onSubmit={createDraft} className="grid gap-4 md:grid-cols-2"><label className="space-y-1 text-sm">Display name<input required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="block w-full rounded border border-white/20 bg-black/30 px-3 py-2" /></label><label className="space-y-1 text-sm">Stable agent ID<input required pattern="nuera-quicksilver:[a-z][a-z0-9-]{0,62}" value={id} onChange={(event) => setId(event.target.value)} className="block w-full rounded border border-white/20 bg-black/30 px-3 py-2 font-mono" /></label><label className="space-y-1 text-sm md:col-span-2">Description<textarea required minLength={10} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="block w-full rounded border border-white/20 bg-black/30 px-3 py-2" /></label><label className="space-y-1 text-sm">Authority<select value={authority} onChange={(event) => setAuthority(event.target.value as 'propose' | 'review')} className="block w-full rounded border border-white/20 bg-black/30 px-3 py-2"><option value="propose">Propose</option><option value="review">Review</option></select></label><label className="space-y-1 text-sm">Maximum impact<select value={impact} onChange={(event) => setImpact(event.target.value)} className="block w-full rounded border border-white/20 bg-black/30 px-3 py-2">{['low', 'moderate', 'high', 'critical'].map((item) => <option key={item}>{item}</option>)}</select></label><fieldset className="space-y-2 md:col-span-2"><legend className="text-sm">Approved task types</legend><div className="flex flex-wrap gap-3">{taskOptions.map((task) => <label key={task} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={tasks.includes(task)} onChange={(event) => setTasks((current) => event.target.checked ? [...current, task] : current.filter((item) => item !== task))} />{task}</label>)}</div></fieldset><div className="md:col-span-2"><button disabled={busy || !tasks.length} className="rounded bg-quicksilver-signal px-4 py-2 font-medium text-black disabled:opacity-50">Save draft</button></div></form></section>}
  </main>
}
