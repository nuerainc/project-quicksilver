'use client'

import { useCallback, useEffect, useState } from 'react'

import { WhyPanel } from '@/components/why-panel'
import { inboxStore } from '@/components/use-inbox'
import { authFailureMessage, consoleHeaders, type ConsoleAccess } from '@/lib/console-auth'
import { decisionActionOptions, type DecisionActionOption } from '@/lib/decision-actions'
import type { DecisionWhy } from '@quicksilver/kernel'
import styles from './decisions.module.css'

export interface DecisionDetailBody {
  id: string
  question: string | null
  selectedAction: string | null
  reasoningSummary: string | null
  constraints: string[] | null
  riskLevel: number | null
  requiredApproval: boolean | null
  status: string | null
  safetyDecision: string | null
  requestedBy: string | null
  proposedBy: string | null
  actorId: string | null
  approvedByName: string | null
  createdAt: string | null
  executedAt: string | null
  kind: string | null
  observedDeviation: unknown
  policyChecks: Array<{ result: string | null; reason: string | null; policyName: string | null }> | null
  policyResolutions: string[] | null
  evidenceTitles: Array<string | null> | null
  reviewerNotes: { policyConflicts?: string[] | null; missingEvidence?: string[] | null; riskConcerns?: string[] | null; suggestions?: string[] | null } | null
  evaluation: { reasoningScore?: number; hallucinationRisk?: string; brittleness?: string; issues?: string[] } | null
  why: DecisionWhy | null
  processName: string | null
  processVersion: number | null
  processHistory: Array<{ transitionId: string | null; from: string | null; to: string | null; actorId: string | null; actorType: string | null; at: string | null }> | null
  approvalFingerprint: string | null
  policyChanged: boolean
  viewer: { id: string; soleOperator: boolean }
}

const MIN_REASON = 20
const when = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded')
const DONE: Record<string, string> = { approve: 'Approved.', reject: 'Rejected.', 'request-evidence': 'More evidence requested.', execute: 'Executed (simulated).', observe: 'Metric observed.', rollback: 'A rollback was proposed. It waits for a person to approve it.', resume: 'Checked again.' }

/**
 * One decision in full, with the buttons the signed-in person may use. What is offered, and why
 * anything is not, comes from `decisionActionOptions`; each call goes to the decision routes as that
 * person, so the server's own checks (separation of duties, the fingerprint, the policy version)
 * still decide. Nothing here is written by a model.
 */
export function DecisionDetail({ id, access, onChanged }: { id: string; access: ConsoleAccess; onChanged: () => void }) {
  const [detail, setDetail] = useState<DecisionDetailBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<DecisionActionOption['id'] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const path = `/api/decisions/${encodeURIComponent(id)}`
      const response = await fetch(path, { headers: consoleHeaders(path, access.token), cache: 'no-store' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) { setError(authFailureMessage(response.status, 'decisions/detail', body.error) ?? body.error ?? 'Could not load this decision.'); setDetail(null); return }
      setDetail(body as DecisionDetailBody)
      setError(null)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }, [id, access.token])

  useEffect(() => { setStep(null); setNote(''); setOutcome(null); setActionError(null); void load() }, [load])

  async function send(option: DecisionActionOption) {
    setBusy(true)
    setActionError(null)
    try {
      const sendsNote = option.call.path.endsWith('/action') && note.trim().length > 0
      const response = await fetch(option.call.path, {
        method: option.call.method,
        headers: consoleHeaders(option.call.path, access.token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ ...option.call.body, ...(sendsNote ? { comment: note.trim() } : {}) }),
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const route = option.id === 'execute' ? 'execute' : option.id === 'observe' ? 'observe' : option.id === 'rollback' ? 'rollback' : option.id === 'resume' ? 'resume' : 'action'
        const server = typeof body?.error === 'string' ? [body.error, ...(Array.isArray(body.reasons) ? body.reasons : [])].join(' ') : undefined
        setActionError(`${authFailureMessage(response.status, route, server, body?.retryAfterSeconds) ?? server ?? 'That did not go through.'}${response.status === 409 ? ' Reload this page to see the current version.' : ''}`)
        return
      }
      setOutcome(option.id === 'observe' && typeof body?.observed?.diagnosis === 'string' ? `${DONE.observe} ${body.observed.diagnosis}` : DONE[option.id] ?? 'Done.')
      setStep(null)
      setNote('')
      await load()
      onChanged()
      void inboxStore().refresh()
    } catch {
      setActionError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  function click(option: DecisionActionOption) {
    if (!option.enabled) return
    if (option.needsNote || option.confirm) { setStep(option.id); setActionError(null); return }
    void send(option)
  }

  if (loading && !detail) return <p className={styles.empty} role="status">Loading this decision…</p>
  if (error && !detail) return <p className={styles.error} role="alert">{error}</p>
  if (!detail) return null

  const options = decisionActionOptions({
    id: detail.id, status: detail.status, safetyDecision: detail.safetyDecision, approvalFingerprint: detail.approvalFingerprint, policyChanged: detail.policyChanged,
    requestedBy: detail.requestedBy, proposedBy: detail.proposedBy, actorId: detail.actorId, riskBand: detail.why?.risk.band ?? null, kind: detail.kind,
  }, detail.viewer.id, access.whoami?.permissions ?? [], detail.viewer.soleOperator)
  const stepping = options.find((option) => option.id === step)
  const reviewNotes = [...(detail.reviewerNotes?.policyConflicts ?? []), ...(detail.reviewerNotes?.missingEvidence ?? []), ...(detail.reviewerNotes?.riskConcerns ?? [])]
  const conflicts = (detail.policyChecks ?? []).filter((check) => check.result === 'conflicts')

  return (
    <article className={styles.detail} aria-labelledby="decision-title" aria-busy={loading}>
      <header>
        <p className="qs-eyebrow">{detail.kind === 'rollback' ? 'Rollback' : 'Decision'}</p>
        <h2 id="decision-title">{detail.question || detail.selectedAction || detail.id}</h2>
      </header>

      {detail.policyChanged && <p className={styles.notice} role="status">A policy changed since this was planned, so it cannot be approved as it is. Ask for a fresh plan in the chat.</p>}

      <dl className={styles.facts}>
        <div><dt>Status</dt><dd>{(detail.status ?? 'unknown').replaceAll('-', ' ')}</dd></div>
        <div><dt>Risk</dt><dd>{detail.riskLevel === null ? 'Not rated' : `${detail.riskLevel} of 5`}</dd></div>
        <div><dt>Human approval</dt><dd>{detail.requiredApproval ? 'Required' : 'Not required'}</dd></div>
        <div><dt>Requested by</dt><dd>{detail.requestedBy ?? 'Not recorded'}</dd></div>
        <div><dt>Approved by</dt><dd>{detail.approvedByName ?? '—'}</dd></div>
        <div><dt>Planned</dt><dd>{when(detail.createdAt)}</dd></div>
        <div><dt>Executed</dt><dd>{when(detail.executedAt)}</dd></div>
      </dl>

      {detail.selectedAction && <section className={styles.section} aria-label="What it would do"><h3>What it would do</h3><p>{detail.selectedAction}</p></section>}

      {options.length > 0 && (
        <section className={styles.actionBar} aria-label="Actions">
          <div className={styles.actionButtons}>
            {options.map((option) => (
              <div key={option.id} className={styles.act}>
                <button type="button" className={styles.btn} data-tone={option.tone} data-confirming={step === option.id} disabled={!option.enabled || busy} aria-describedby={option.reason ? `why-${option.id}` : undefined} onClick={() => click(option)}>{option.label}</button>
                {option.reason && <span id={`why-${option.id}`} className={styles.why}>{option.reason}</span>}
              </div>
            ))}
          </div>
          {stepping && (
            <div className={styles.note}>
              {stepping.needsNote && (
                <>
                  <label htmlFor="decision-note">{stepping.needsNote === 'required' ? `Why you are approving your own request (at least ${MIN_REASON} characters)` : 'Add a note (optional)'}</label>
                  <textarea id="decision-note" value={note} onChange={(event) => setNote(event.currentTarget.value)} />
                </>
              )}
              <div className={styles.actionButtons}>
                <button type="button" className={styles.btn} data-tone={stepping.tone} disabled={busy || (stepping.needsNote === 'required' && note.trim().length < MIN_REASON)} onClick={() => void send(stepping)}>Confirm: {stepping.label.toLowerCase()}</button>
                <button type="button" className={styles.btn} onClick={() => { setStep(null); setNote('') }}>Cancel</button>
              </div>
            </div>
          )}
          {outcome && <p className={styles.outcome} role="status">{outcome}</p>}
          {actionError && <p className={styles.error} role="alert">{actionError}</p>}
        </section>
      )}
      {options.length === 0 && outcome && <p className={styles.outcome} role="status">{outcome}</p>}

      {detail.why ? <WhyPanel why={detail.why} defaultOpen /> : (
        <p className={styles.fine}>No stored explanation: this was planned before explanations were kept. The policy checks and reviewer notes below are what was recorded.</p>
      )}

      {(detail.policyChecks?.length ?? 0) > 0 && (
        <section className={styles.section} aria-label="Policy checks">
          <h3>Policy checks{conflicts.length ? ` (${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'})` : ''}</h3>
          <ul>{detail.policyChecks!.map((check, index) => <li key={index}>{check.policyName ?? 'Unnamed policy'}: {check.result ?? 'no result'}. {check.reason ?? ''}</li>)}</ul>
        </section>
      )}
      {reviewNotes.length > 0 && <section className={styles.section} aria-label="Independent review"><h3>Independent review</h3><ul>{reviewNotes.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      {(detail.evidenceTitles?.length ?? 0) > 0 && <section className={styles.section} aria-label="Evidence"><h3>Supporting evidence</h3><ul>{detail.evidenceTitles!.map((title, index) => <li key={index}>{title ?? 'Untitled'}</li>)}</ul></section>}
      {detail.reasoningSummary && <details className={styles.section}><summary>Reasoning summary</summary><p>{detail.reasoningSummary}</p></details>}
      {(detail.processHistory?.length ?? 0) > 0 && (
        <details className={styles.section}>
          <summary>History{detail.processName ? ` (${detail.processName}${detail.processVersion ? ` v${detail.processVersion}` : ''})` : ''}</summary>
          <ol>{detail.processHistory!.map((row, index) => <li key={index}>{row.from} → {row.to} ({row.transitionId} · {row.actorType === 'human' ? 'a person' : row.actorId} · {when(row.at)})</li>)}</ol>
        </details>
      )}
    </article>
  )
}
