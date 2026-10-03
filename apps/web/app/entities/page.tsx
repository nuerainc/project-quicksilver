'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { authFailureMessage, consoleHeaders, resolveConsoleAccess } from '@/lib/console-auth'

type EntityRecord = {
  id: string
  name: string
  entityType: string
  availability?: string | null
  riskProfile?: number | null
  costProfile?: string | null
  department?: string | null
  reportsTo?: { id: string; name: string } | null
  capabilities?: Array<{ id: string; name: string }>
}

const API_PATH = '/api/entities'

export default function EntitiesPage() {
  const [entities, setEntities] = useState<EntityRecord[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)

  useEffect(() => {
    setSearch(new URLSearchParams(window.location.search).get('search') ?? '')
    let current = true
    resolveConsoleAccess()
      .then((access) => {
        if (!access.signedIn) { if (current) setNeedsSignIn(true); throw new Error('Sign in with a principal that has decision:read to view company records.') }
        return fetch(API_PATH, { headers: consoleHeaders(API_PATH, access.token), cache: 'no-store' })
      })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          if (response.status === 401) { if (current) setNeedsSignIn(true); throw new Error(authFailureMessage(401, 'entities') ?? 'Sign in to view company records.') }
          throw new Error(body.error ?? 'Could not load company records.')
        }
        return body as { total: number; entities: EntityRecord[] }
      })
      .then((body) => {
        if (!current) return
        setTotal(body.total)
        setEntities(body.entities)
      })
      .catch((cause) => { if (current) setError((cause as Error).message) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [])

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return entities
    return entities.filter((entity) => [entity.name, entity.entityType, entity.department, entity.reportsTo?.name, ...(entity.capabilities ?? []).map(({ name }) => name)]
      .some((value) => value?.toLocaleLowerCase().includes(needle)))
  }, [entities, search])

  return (
    <main className="app-main">
      <div className="qs-page-heading">
        <div><p className="qs-eyebrow">Company workspace</p><h1>Company data</h1><p>Browse your people, agents, teams, and capabilities. Open a record in Studio to make governed changes.</p></div>
        <a className="qs-action-primary" href="/studio">Manage records in Studio <span aria-hidden="true">↗</span></a>
      </div>

      <section className="qs-panel" aria-labelledby="entity-directory-title">
        <div className="qs-section-heading">
          <div><h2 id="entity-directory-title">Entity directory</h2><p>{loading ? 'Loading company records…' : `${total} records · ${visible.length} shown`}</p></div>
          <label className="qs-field"><span>Search company records</span><input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Name, team, capability…" /></label>
        </div>

        {error && <div className="qs-data-card" role="alert"><p>{error}</p>{needsSignIn && <Link className="qs-action-secondary" href="/sign-in?returnTo=%2Fentities">Sign in</Link>}</div>}
        {!error && loading && <p className="qs-helper" role="status">Loading the authorized company directory…</p>}
        {!error && !loading && visible.length === 0 && <p className="qs-helper">{entities.length ? 'No records match this search.' : 'No entity records were found in the configured company dataset.'}</p>}
        {!error && visible.length > 0 && (
          <ul className="grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((entity) => (
              <li key={entity.id} className="qs-data-card min-w-0">
                <div className="flex items-start justify-between gap-3"><h3 className="break-words">{entity.name}</h3><span className="qs-status-pill qs-status-pill--neutral">{entity.entityType}</span></div>
                <p className="qs-helper mt-2">{[entity.department, entity.reportsTo?.name ? `Reports to ${entity.reportsTo.name}` : null].filter(Boolean).join(' · ') || 'No team or reporting relationship recorded'}</p>
                {(entity.capabilities?.length ?? 0) > 0 && <p className="qs-helper mt-2">Capabilities: {entity.capabilities!.map(({ name }) => name).join(', ')}</p>}
                <p className="qs-helper mt-2">{[entity.availability, entity.costProfile ? `Cost ${entity.costProfile}` : null, entity.riskProfile != null ? `Risk ${entity.riskProfile}/5` : null].filter(Boolean).join(' · ') || 'No operating profile recorded'}</p>
                <a className="qs-action-secondary mt-4" href={`/studio?intent=edit&id=${encodeURIComponent(entity.id)}&type=entity&path=name`}>Open record in Studio <span aria-hidden="true">↗</span></a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="qs-panel mt-5" aria-labelledby="chat-coverage-title">
        <div className="qs-section-heading"><div><h2 id="chat-coverage-title">Ask Quicksilver about your company</h2><p>Chat can answer questions from connected read-only context and prepare reviewed plans.</p></div></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <p className="qs-data-card"><strong>Ask mode</strong><br />Find people, capabilities, policies, and supporting context. Ask about an entity by name.</p>
          <p className="qs-data-card"><strong>Plan mode</strong><br />Describe an outcome; Quicksilver can create evaluated decision proposals for review.</p>
        </div>
        <p className="qs-helper mt-3">Chat does not currently edit company records or directly invoke every workflow and platform feature. Use the page controls for entity changes; approvals and execution remain governed separately.</p>
      </aside>
    </main>
  )
}
