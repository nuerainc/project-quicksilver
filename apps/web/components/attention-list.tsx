'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { AttentionAction, AttentionItem, SourceStatus } from '@/lib/attention'
import { useInbox } from '@/components/use-inbox'
import { authFailureMessage, consoleHeaders, resolveConsoleAccess } from '@/lib/console-auth'
import { signInPageHref } from '@/lib/session-control'
import { usePathname } from 'next/navigation'
import styles from './attention-list.module.css'

interface ItemState { confirming?: AttentionAction['id']; busy?: boolean; done?: string; error?: string }

const DONE_TEXT: Record<AttentionAction['id'], string> = { approve: 'Approved.', reject: 'Rejected.', execute: 'Executed (simulated).', review: '' }
const SOURCE_NAME: Record<SourceStatus['id'], string> = { decisions: 'decisions', workflows: 'workflow activity', agents: 'the agent catalog', traces: 'traces' }

function ago(iso: string | null, now: number): string | null {
  if (!iso) return null
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seconds)) return null
  if (seconds < 90) return 'just now'
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 129_600) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} days ago`
}

/**
 * What needs the signed-in person, with the one-click actions each item allows. The server
 * decides what is offered (lib/attention.ts); this only shows it and makes the call a person
 * clicks, as that person, through the app's own decision routes. Nothing here is written by a model.
 */
export function AttentionList({ onNavigate, heading = 'Needs you', hideHeading = false }: { onNavigate?: () => void; heading?: string; hideHeading?: boolean }) {
  const { inbox, error, needsSignIn, loading, checkedAt, refresh } = useInbox()
  const [states, setStates] = useState<Record<string, ItemState>>({})
  const [now, setNow] = useState(() => Date.now())
  const pathname = usePathname() ?? '/'

  // Keep "checked 3 min ago" honest between checks.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const patch = (id: string, next: ItemState) => setStates((current) => ({ ...current, [id]: next }))

  async function run(item: AttentionItem, action: AttentionAction) {
    const call = action.call
    if (!call) return
    const state = states[item.id] ?? {}
    if (call.confirm && state.confirming !== action.id) { patch(item.id, { confirming: action.id }); return }
    patch(item.id, { busy: true })
    try {
      const access = await resolveConsoleAccess()
      if (!access.signedIn) { patch(item.id, { error: 'Sign in to do this.' }); return }
      const response = await fetch(call.path, {
        method: call.method,
        headers: consoleHeaders(call.path, access.token, { 'content-type': 'application/json' }),
        body: JSON.stringify(call.body),
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const separation = body?.soleOperatorOverride?.available ? ' Open it to approve as the sole operator with a written reason.' : ''
        const route = action.id === 'approve' || action.id === 'reject' ? 'action' : 'execute'
        patch(item.id, { error: `${authFailureMessage(response.status, route, body.error) ?? body.error ?? 'That did not go through.'}${response.status === 409 ? ' Open it to review the current version.' : ''}${separation}` })
        return
      }
      patch(item.id, { done: DONE_TEXT[action.id] })
      await refresh()
    } catch {
      patch(item.id, { error: 'Could not reach the server.' })
    }
  }

  if (needsSignIn) {
    return <div className={styles.root}><p className={styles.empty}>Sign in to see what needs you. <Link href={signInPageHref(pathname)} onClick={onNavigate}>Sign in</Link></p></div>
  }

  const unchecked = inbox?.sources.filter((source) => source.status === 'unavailable') ?? []
  const actionable = inbox?.items.filter((item) => item.actionable) ?? []
  const other = inbox?.items.filter((item) => !item.actionable) ?? []

  return (
    <section className={styles.root} aria-label={heading} aria-busy={loading}>
      <div className={styles.summary}>
        {hideHeading ? <span /> : <h4>{inbox ? `${heading} (${inbox.counts.actionable}${inbox.counts.complete ? '' : '+'})` : heading}</h4>}
        <span className={styles.meta}>
          {checkedAt ? `Checked ${ago(new Date(checkedAt).toISOString(), now) ?? 'just now'}` : loading ? 'Checking…' : ''}{' '}
          <button type="button" className={`${styles.link} ${styles.retry}`} onClick={() => void refresh()} disabled={loading}>Refresh</button>
        </span>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {unchecked.length > 0 && (
        <p className={styles.notice} role="status">
          Could not check {unchecked.map((source) => SOURCE_NAME[source.id]).join(', ')}, so this list may be incomplete.
        </p>
      )}
      {inbox && actionable.length === 0 && unchecked.length === 0 && <p className={styles.empty}>Nothing needs you right now.</p>}
      {actionable.length > 0 && <ItemList items={actionable} states={states} now={now} onRun={run} onCancel={(id) => patch(id, {})} onNavigate={onNavigate} />}
      {other.length > 0 && (
        <details>
          <summary className={styles.meta}>Waiting on others or for your information ({other.length})</summary>
          <ItemList items={other} states={states} now={now} onRun={run} onCancel={(id) => patch(id, {})} onNavigate={onNavigate} />
        </details>
      )}
    </section>
  )
}

function ItemList({ items, states, now, onRun, onCancel, onNavigate }: { items: AttentionItem[]; states: Record<string, ItemState>; now: number; onRun: (item: AttentionItem, action: AttentionAction) => void; onCancel: (id: string) => void; onNavigate?: () => void }) {
  return (
    <ul className={styles.list}>
      {items.map((item) => {
        const state = states[item.id] ?? {}
        const since = ago(item.since, now)
        return (
          <li key={item.id} className={styles.item} data-actionable={item.actionable}>
            <div className={styles.head}>
              <span className={styles.tag} data-severity={item.severity}>{item.severity === 'critical' ? 'Urgent' : item.severity === 'warning' ? 'Needs a look' : 'For information'}</span>
              {since && <span className={styles.meta}>{since}</span>}
            </div>
            <p className={styles.title}>{item.title}</p>
            <p className={styles.reason}>{item.reason}</p>
            {item.covers && item.actions.some((action) => action.id === 'approve') && (
              <p className={styles.covers}>
                <span>Action: {item.covers.action ?? 'not recorded'}</span>
                <span>Risk: {item.covers.riskLevel === null ? 'not recorded' : `${item.covers.riskLevel} of 5`}</span>
                <span>Policy version: {item.covers.policyVersion ? item.covers.policyVersion.slice(7, 15) : 'not recorded'}</span>
              </p>
            )}
            {item.nearMiss && <p className={styles.nearMiss}>What would change it: {item.nearMiss}</p>}
            {state.done ? <p className={styles.outcome} role="status">{state.done}</p> : (
              <div className={styles.actions}>
                {item.actions.map((action) => action.link ? (
                  <Link key={action.id} className={styles.link} href={action.link} onClick={onNavigate}>{action.label}</Link>
                ) : (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.button}
                    data-tone={action.tone}
                    data-confirming={state.confirming === action.id}
                    disabled={state.busy}
                    onClick={() => onRun(item, action)}
                  >
                    {state.confirming === action.id ? `Confirm: ${action.label.toLowerCase()}` : action.label}
                  </button>
                ))}
                {state.confirming && !state.busy && <button type="button" className={styles.link} onClick={() => onCancel(item.id)}>Cancel</button>}
              </div>
            )}
            {state.error && <p className={styles.outcomeError} role="alert">{state.error}</p>}
          </li>
        )
      })}
    </ul>
  )
}
