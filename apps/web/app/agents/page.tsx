'use client'

import { useEffect, useState } from 'react'
import { authFailureMessage, consoleHeaders, resolveConsoleAccess, type ConsoleRoute } from '@/lib/console-auth'
import { agentReviewNoteProblem } from '@/lib/agent-review'

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
  const [reviewingAgentId, setReviewingAgentId] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')

  async function request(route: ConsoleRoute, method: 'GET' | 'POST', body?: unknown, query = '') {
    const access = await resolveConsoleAccess()
    if (!access.signedIn) throw new Error('Sign in before managing agent definitions.')
    const url = `/api/${route}${query}`
    const response = await fetch(url, { method, headers: consoleHeaders(url, access.token, body ? { 'content-type': 'application/json' } : {}), ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' })
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
    void resolveConsoleAccess().then(async (access) => {
      if (!access.signedIn) return
      if (access.whoami) { setPermissions(access.whoami.permissions); return }
      const response = await fetch('/api/whoami', { headers: consoleHeaders('/api/whoami', access.token), cache: 'no-store' })
      if (response.ok) setPermissions((await response.json() as { permissions?: string[] }).permissions ?? [])
    }).catch(() => undefined)
  }, [])

  async function mutate(route: Extract<ConsoleRoute, `agents/${string}`>, body: unknown, message: string): Promise<boolean> {
    setBusy(true); setError(null); setNotice(null)
    try { await request(route, 'POST', body); setNotice(message); await refresh(); return true }
    catch (cause) { setError((cause as Error).message); return false }
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
    const problem = agentReviewNoteProblem(reviewNote)
    if (problem) { setError(problem); return }
    const saved = await mutate('agents/review', { agentId: agent.agentId, version: agent.version, note: reviewNote.trim() }, 'Independent review recorded. A separate publisher must release this version.')
    if (!saved) return
    setReviewingAgentId(null)
    setReviewNote('')
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

  return <main className="app-main space-y-6 text-white">
    <header className="qs-page-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl"><p className="qs-eyebrow">NQC Kernel · Governance</p><h1 className="mt-2">Nuera Quicksilver Agents</h1><p className="qs-page-heading__summary mt-3">Review and publish versioned declarative agent contracts. Definitions set task scope and impact limits; they do not install plugins or run submitted code.</p></div>
        {permissions.includes('agent:write') && <a href="#create-agent" className="qs-action-primary">Create agent definition</a>}
      </div>
    </header>
    {error && <p role="alert" className="rounded border border-red-400/40 bg-red-950/30 p-3 text-sm">{error}</p>}{notice && <p role="status" className="rounded border border-emerald-400/40 bg-emerald-950/30 p-3 text-sm">{notice}</p>}
    <section aria-label="Agent catalog overview" className="grid gap-3 sm:grid-cols-3">
      {[[catalog.agents.length, 'Published definitions'], [catalog.reviewQueue.length, 'Awaiting review'], [catalog.drafts.length, 'Drafts']].map(([value, label]) => <article key={String(label)} className="qs-panel"><p className="qs-eyebrow">{label}</p><p className="mt-2 text-2xl font-semibold text-white">{value}</p></article>)}
    </section>
    <section aria-labelledby="published-title" className="qs-panel"><div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="qs-eyebrow">Available definitions</p><h2 id="published-title" className="mt-1 text-xl font-semibold">Published catalog</h2></div><span className="text-sm text-white/60">{catalog.agents.length} definitions</span></div>{catalog.agents.length ? <div className="grid gap-3 md:grid-cols-2">{catalog.agents.map((agent) => <article key={agent.agentId} className="min-w-0 rounded-xl border border-white/10 bg-black/10 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">{agent.displayName}</h3><p className="break-all font-mono text-xs text-white/50">{agent.agentId} · v{agent.version}</p></div><span className="shrink-0 rounded-full bg-emerald-900/50 px-2.5 py-1 text-xs text-emerald-200">{agent.builtIn ? 'Built in' : 'Published'}</span></div><p className="mt-3 text-sm leading-6 text-white/75">{agent.description}</p><dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-white/50">Authority</dt><dd className="mt-1">{agent.manifest.authority}</dd></div><div><dt className="text-white/50">Maximum impact</dt><dd className="mt-1">{agent.manifest.maximumImpact}</dd></div><div className="col-span-2"><dt className="text-white/50">Tasks</dt><dd className="mt-1 break-words">{agent.manifest.tasks.join(', ')}</dd></div><div className="col-span-2"><dt className="text-white/50">Evaluation</dt><dd className="mt-1">{agent.manifest.requiresEvaluation ? 'Required' : 'Not required'}</dd></div></dl>{!agent.builtIn && permissions.includes('agent:write') && <div className="mt-4 border-t border-white/10 pt-3"><button disabled={busy} onClick={() => void loadHistory(agent)} className="qs-action-secondary">{history[agent.agentId] ? 'Refresh versions' : 'View versions'}</button>{history[agent.agentId] && <div className="mt-3 space-y-2">{history[agent.agentId].map((version) => <div key={`${version.agentId}@${version.version}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="text-white/70">v{version.version} · {version.lifecycle}{version.rollbackFrom ? ` · rollback of v${version.rollbackFrom.version}` : ''}</span>{version.lifecycle === 'archived' && <button disabled={busy} onClick={() => void rollback(agent, version.version)} className="qs-action-secondary">Create rollback draft</button>}</div>)}</div>}</div>}</article>)}</div> : <p className="py-8 text-center text-sm text-white/60">{error ? 'Catalog unavailable.' : 'Loading catalog…'}</p>}</section>
    <section aria-labelledby="review-title" className="qs-panel"><div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="qs-eyebrow">Human governance</p><h2 id="review-title" className="mt-1 text-xl font-semibold">Review queue</h2></div><span className="rounded-full border border-amber-200/20 bg-amber-200/10 px-3 py-1 text-sm text-amber-100">{catalog.reviewQueue.length} awaiting review</span></div>{catalog.reviewQueue.length ? <div className="space-y-3">{catalog.reviewQueue.map((agent) => <article key={`${agent.agentId}@${agent.version}`} className="grid min-w-0 gap-4 rounded-xl border border-white/10 bg-black/10 p-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]"><div><h3 className="font-semibold">{agent.displayName} · v{agent.version}</h3><p className="break-all font-mono text-xs text-white/60">{agent.agentId} · author {agent.authoredBy}</p><p className="mt-2 text-sm leading-6 text-white/80">{agent.description}</p>{agent.rollbackFrom && <p className="mt-2 text-sm text-amber-200">Rollback draft from v{agent.rollbackFrom.version}; this new version still needs review.</p>}{agent.reviewNote && <p className="mt-2 text-sm text-white/70">Review: {agent.reviewNote}</p>}</div>{!agent.reviewedBy && permissions.includes('agent:review') && (reviewingAgentId === agent.agentId ? <form className="grid content-start gap-3" onSubmit={(event) => { event.preventDefault(); void review(agent) }}><label className="grid gap-2 text-sm" htmlFor={`review-note-${agent.version}-${agent.agentId}`}>Review rationale <span className="text-xs text-white/70">10–500 characters. This note is saved with the reviewed version.</span><textarea id={`review-note-${agent.version}-${agent.agentId}`} required minLength={10} maxLength={500} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={4} className="qs-field min-h-28" aria-describedby={`review-count-${agent.version}-${agent.agentId}`} /></label><div className="flex flex-wrap items-center gap-2"><span id={`review-count-${agent.version}-${agent.agentId}`} aria-live="polite" className="mr-auto text-xs text-white/70">{reviewNote.trim().length}/500 characters</span><button disabled={busy || Boolean(agentReviewNoteProblem(reviewNote))} className="qs-action-primary">Save review</button><button type="button" disabled={busy} onClick={() => { setReviewingAgentId(null); setReviewNote('') }} className="qs-action-secondary">Cancel</button></div></form> : <button disabled={busy} onClick={() => { setReviewingAgentId(agent.agentId); setReviewNote(''); setError(null) }} className="qs-action-secondary">Write review rationale</button>)}{agent.reviewedBy && permissions.includes('agent:publish') && <button disabled={busy} onClick={() => void publish(agent)} className="qs-action-primary">Publish version</button>}</article>)}</div> : <p className="py-6 text-sm text-white/60">No definitions are awaiting review.</p>}</section>
    <section aria-labelledby="drafts-title" className="qs-panel"><div className="mb-4"><p className="qs-eyebrow">Work in progress</p><h2 id="drafts-title" className="mt-1 text-xl font-semibold">Drafts</h2></div>{catalog.drafts.length ? <div className="space-y-3">{catalog.drafts.map((agent) => <article key={`${agent.agentId}@${agent.version}`} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/10 p-4"><div className="min-w-0"><h3 className="font-semibold">{agent.displayName} · v{agent.version}</h3><p className="break-all font-mono text-xs text-white/50">{agent.agentId} · author {agent.authoredBy}</p><p className="mt-2 text-sm text-white/70">{agent.description}</p>{agent.rollbackFrom && <p className="mt-1 text-xs text-amber-200/80">Rollback draft copied from v{agent.rollbackFrom.version}.</p>}</div>{permissions.includes('agent:write') && <button disabled={busy} onClick={() => void submitForReview(agent)} className="qs-action-secondary">Submit for review</button>}</article>)}</div> : <p className="text-sm text-white/60">No saved drafts.</p>}</section>
    {permissions.includes('agent:write') && <section id="create-agent" aria-labelledby="create-agent-title" className="qs-panel scroll-mt-24"><div className="mb-5"><p className="qs-eyebrow">New definition</p><h2 id="create-agent-title" className="mt-1 text-xl font-semibold">Create an agent</h2><p className="qs-helper mt-2">Each draft is immutable after saving. Revisions need a human review before publication.</p></div><form onSubmit={createDraft} className="grid gap-4 md:grid-cols-2"><label className="grid gap-2 text-sm" htmlFor="agent-display-name">Display name<input id="agent-display-name" required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className="qs-field" /></label><label className="grid gap-2 text-sm" htmlFor="agent-stable-id">Stable agent ID<input id="agent-stable-id" required pattern="nuera-quicksilver:[a-z][a-z0-9-]{0,62}" value={id} onChange={(event) => setId(event.target.value)} className="qs-field font-mono" /></label><label className="grid gap-2 text-sm md:col-span-2" htmlFor="agent-description">Description<textarea id="agent-description" required minLength={10} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="qs-field min-h-24" /></label><label className="grid gap-2 text-sm" htmlFor="agent-authority">Authority<select id="agent-authority" value={authority} onChange={(event) => setAuthority(event.target.value as 'propose' | 'review')} className="qs-field"><option value="propose">Propose</option><option value="review">Review</option></select></label><label className="grid gap-2 text-sm" htmlFor="agent-maximum-impact">Maximum impact<select id="agent-maximum-impact" value={impact} onChange={(event) => setImpact(event.target.value)} className="qs-field">{['low', 'moderate', 'high', 'critical'].map((item) => <option key={item}>{item}</option>)}</select></label><fieldset className="grid gap-3 md:col-span-2"><legend className="mb-1 text-sm font-medium">Approved task types</legend><div className="flex flex-wrap gap-2">{taskOptions.map((task) => <label key={task} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm"><input type="checkbox" checked={tasks.includes(task)} onChange={(event) => setTasks((current) => event.target.checked ? [...current, task] : current.filter((item) => item !== task))} />{task}</label>)}</div></fieldset><div className="md:col-span-2"><button disabled={busy || !tasks.length} className="qs-action-primary">Save draft</button></div></form></section>}
  </main>
}
