'use client'

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { DecisionDetail } from '@/components/decision-detail'
import styles from '@/components/decisions.module.css'
import { authFailureMessage, consoleHeaders, resolveConsoleAccess, type ConsoleAccess } from '@/lib/console-auth'
import { signInPageHref } from '@/lib/session-control'

interface Row { id: string; title: string; action: string | null; status: string; riskLevel: number | null; requiredApproval: boolean; requestedBy: string | null; createdAt: string | null; kind: string | null }
interface ListBody { observedAt: string; hasMore: boolean; counts: Record<string, number>; decisions: Row[] }

const TABS = [
  { key: 'needs', label: 'Needs a decision', statuses: ['awaiting-approval', 'proposed', 'rollback-proposed'] },
  { key: 'run', label: 'Ready to run', statuses: ['approved'] },
  { key: 'done', label: 'Done', statuses: ['executed', 'rolled-back'] },
  { key: 'stopped', label: 'Refused or failed', statuses: ['rejected', 'failed'] },
  { key: 'all', label: 'All', statuses: [] as string[] },
] as const
type TabKey = (typeof TABS)[number]['key']

const TONE: Record<string, string> = { 'awaiting-approval': 'wait', proposed: 'wait', 'rollback-proposed': 'wait', approved: 'good', executed: 'good', 'rolled-back': 'good', rejected: 'bad', failed: 'bad' }
const PAGE = 25

function ago(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'Date not recorded'
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 2) return 'just now'
  if (minutes < 90) return `${minutes} min ago`
  if (minutes < 2_160) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 1_440)} days ago`
}

export default function DecisionsPage() {
  return <Suspense fallback={<main className="app-main"><p role="status">Loading decisions…</p></main>}><Decisions /></Suspense>
}

function Decisions() {
  const router = useRouter()
  const params = useSearchParams()
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'needs') as TabKey
  const selected = params.get('id')
  const [access, setAccess] = useState<ConsoleAccess | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  useEffect(() => { void resolveConsoleAccess(undefined, undefined, { withWhoami: true }).then(setAccess) }, [])

  const load = useCallback(async (more = false) => {
    if (!access?.signedIn) return
    setLoading(true)
    const statuses = TABS.find((t) => t.key === tab)!.statuses
    const query = new URLSearchParams({ limit: String(PAGE), ...(statuses.length ? { status: statuses.join(',') } : {}) })
    if (more && rows.length) query.set('before', rows[rows.length - 1]!.createdAt ?? '')
    const path = `/api/decisions?${query}`
    try {
      const response = await fetch(path, { headers: consoleHeaders(path, access.token), cache: 'no-store' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) { setError(authFailureMessage(response.status, 'decisions', body.error) ?? body.error ?? 'Could not load decisions.'); return }
      const list = body as ListBody
      setRows((current) => (more ? [...current, ...list.decisions] : list.decisions))
      setCounts(list.counts)
      setHasMore(list.hasMore)
      setCheckedAt(list.observedAt)
      setError(null)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setLoading(false)
    }
    // rows is read only to find the page boundary
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access, tab])

  useEffect(() => { void load(false) }, [load])

  const go = (next: { tab?: TabKey; id?: string | null }) => {
    const query = new URLSearchParams()
    const t = next.tab ?? tab
    if (t !== 'needs') query.set('tab', t)
    const id = next.id === undefined ? selected : next.id
    if (id) query.set('id', id)
    router.push(`/decisions${query.size ? `?${query}` : ''}`)
  }

  const tabCount = (key: TabKey) => {
    const statuses = TABS.find((t) => t.key === key)!.statuses
    return statuses.length ? statuses.reduce((total, status) => total + (counts[status] ?? 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0)
  }

  return (
    <main className="app-main space-y-6">
      <header className="qs-page-heading">
        <p className="qs-eyebrow">Operate · Decisions</p>
        <h1>Decisions</h1>
        <p className="qs-page-heading__summary">What Quicksilver proposed, what is waiting for you, and what happened. Open a decision to read why, then approve, reject or run it.</p>
      </header>

      {access && !access.signedIn ? (
        <section className="qs-panel" aria-labelledby="decisions-signin">
          <h2 id="decisions-signin" className="text-lg font-semibold">Sign in to see decisions</h2>
          <p>Decisions are private to your organisation.</p>
          <p><Link className="qs-action-primary" href={signInPageHref('/decisions')}>Sign in</Link></p>
        </section>
      ) : (
        <>
          <nav aria-label="Decision groups">
            <ul className={styles.tabs}>
              {TABS.map((t) => (
                <li key={t.key}>
                  <button type="button" className={styles.tab} aria-current={tab === t.key ? 'page' : undefined} onClick={() => go({ tab: t.key, id: null })}>
                    {t.label}<span className={styles.count}>{access ? tabCount(t.key) : '…'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className={styles.layout} data-detail={selected ? 'true' : 'false'}>
            <section className={styles.listPane} aria-label="Decision list">
              {error && <p className={styles.error} role="alert">{error} <button type="button" className={styles.more} onClick={() => void load(false)}>Try again</button></p>}
              {!error && !loading && rows.length === 0 && (
                <p className={styles.empty}>{tab === 'needs' ? 'Nothing is waiting for a decision. Ask Quicksilver to plan something in the chat and it will show up here for review.' : 'No decisions in this group.'}</p>
              )}
              <ul className={styles.list}>
                {rows.map((row) => (
                  <li key={row.id}>
                    <button type="button" className={styles.row} aria-current={selected === row.id ? 'true' : undefined} onClick={() => go({ id: row.id })}>
                      <p className={styles.rowTitle}>{row.title}</p>
                      <span className={styles.rowMeta}>
                        <span className={styles.status} data-tone={TONE[row.status] ?? 'wait'}>{row.status.replaceAll('-', ' ')}</span>
                        <span>{row.riskLevel === null ? (row.kind === 'rollback' ? 'Rollback' : 'Risk not rated') : `Risk ${row.riskLevel} of 5`}</span>
                        <span>{ago(row.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className={styles.fine} role="status">{loading ? 'Loading…' : checkedAt ? `Checked ${ago(checkedAt)}.` : ''}</p>
              {hasMore && <button type="button" className={styles.more} disabled={loading} onClick={() => void load(true)}>Show older decisions</button>}
            </section>

            <section className={styles.detailPane} aria-label="Decision detail">
              {selected && access?.signedIn ? (
                <>
                  <button type="button" className={styles.back} onClick={() => go({ id: null })}>← All decisions</button>
                  <DecisionDetail id={selected} access={access} onChanged={() => void load(false)} />
                </>
              ) : (
                <p className={styles.empty}>Choose a decision to see why it was proposed, what it covers and what you can do with it.</p>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  )
}
