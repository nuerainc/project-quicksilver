'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import {
  authFailureMessage,
  clearConsoleToken,
  consoleHeaders,
  resolveConsoleAccess,
  saveConsoleToken,
  soleOperatorPrompt,
  type ConsoleDecisionRoute,
  type ConsoleWhoami,
  type SoleOperatorPrompt,
} from '@/lib/console-auth'
import { DEMO_PRINCIPALS } from '@/lib/demo-mode'
import { WhyPanel } from '@/components/why-panel'
import type { DecisionWhy } from '@quicksilver/kernel'

/** Inlined at build: the public demo (Sanity Challenge edition) offers one-click demo sign-in. */
const DEMO = (process.env.NEXT_PUBLIC_QUICKSILVER_DEMO_MODE ?? '').trim().toLowerCase() === 'on'

/** A refused console call, with the server's status and body (for the sole-operator prompt). */
class ConsoleCallError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

type DecisionDecision = {
  authorized: boolean
  riskLevel: number
  requiresApproval: boolean
  blockingReasons: string[]
  concerns: string[]
  policyConflicts: string[]
  recommendation: 'execute-autonomously' | 'request-approval' | 'reject'
}

type ReviewResult = {
  valid: boolean
  policyConflicts: string[]
  missingEvidence: string[]
  riskConcerns: string[]
  suggestions: string[]
}

/**
 * Where a decision stands in its process definition (QUICKSILVER_PROCESS_ENGINE=on).
 * engine 'off' / 'missing' = legacy lifecycle; 'invalid' = the definition in
 * Sanity failed validation, so the kernel is holding every decision in place.
 */
type ProcessInfo = {
  engine: 'on' | 'off' | 'missing' | 'invalid'
  definitionName?: string
  version?: number
  state?: string
  stateLabel?: string
  transitionId?: string | null
  next?: Array<{ id: string; label: string; to: string; requiresHuman: boolean; automatic: boolean; guardPassed: boolean }>
  errors?: string[]
}

type DecisionResponse = {
  status?: string | null
  process?: ProcessInfo | null
  action: {
    description: string
    actorId: string
    capabilityId: string
    applicablePolicyIds: string[]
    evidenceIds: string[]
    financialExposure: number
    reversible: boolean
    operationalImpact: number
    uncertainty: number
  }
  decision: DecisionDecision | null
  why?: DecisionWhy | null
  escalationReasons?: string[]
  review: ReviewResult | null
  decisionDocId: string | null
  approvalFingerprint: string | null
  resolvedReferences: {
    actor: { id: string; name: string; entityType: string } | null
    capability: { id: string; name: string; riskLevel: number } | null
    policies: Array<{ id: string; name: string; scope: string; priority: number }>
    evidence: Array<{ id: string; title: string; confidence: number }>
  }
}

type PlanResponse = {
  decomposition: {
    objective: string
    constraints: string[]
    successMetrics: string[]
    requiredCapabilities: string[]
    candidateWorkstreams: string[]
  }
  reasoning: string
  decisions: DecisionResponse[]
}

type DecisionStatus =
  | 'pending'
  | 'proposed'
  | 'awaiting-approval'
  | 'approved'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'rollback-suggested'
  | 'rollback-proposed'
  | 'rolled-back'

type Observation = {
  status: string
  observed: {
    metric: string
    unit: string
    baseline: number
    value: number
    delta: number
    pctChange: number
  } | null
  diagnosis: string
  deviationDetected: boolean
  recommendedRollback: { summary: string; rationale: string } | null
  rollbackDecisionId?: string
}

export default function HomePage() {
  const [objective, setObjective] = useState(
    'Reduce production downtime by 20% over the next 30 days without increasing OPEX.',
  )
  const [plan, setPlan] = useState<PlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, DecisionStatus>>({})
  const [observations, setObservations] = useState<Record<string, Observation | undefined>>({})
  const [processes, setProcesses] = useState<Record<string, ProcessInfo | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  // Console sign-in: the token lives in sessionStorage (this tab only) and in
  // memory; it is sent only to this app's own API routes (mayCarryConsoleToken).
  const [token, setToken] = useState<string | null>(null)
  // An approval separation of duties refused, where the sole-operator override
  // is open to the signed-in person: ask for the written justification.
  const [override, setOverride] = useState<{ decisionId: string; prompt: SoleOperatorPrompt; expectedActionFingerprint: string } | null>(null)
  const [who, setWho] = useState<ConsoleWhoami | null>(null)
  const [authNote, setAuthNote] = useState<string | null>(null)

  // Signed in with the organisation account (OIDC) rather than a pasted token: the
  // browser session cookie goes with each request, so there is no token to keep.
  const [session, setSession] = useState(false)
  const signedIn = Boolean(token) || session

  useEffect(() => {
    void resolveConsoleAccess().then((access) => {
      if (access.token) {
        setToken(access.token)
        void lookupWhoami(access.token)
      } else if (access.whoami) {
        setSession(true)
        setWho(access.whoami)
      }
    })
    // Run once on mount.
  }, [])

  async function lookupWhoami(t: string) {
    try {
      const res = await fetch('/api/whoami', { headers: consoleHeaders('/api/whoami', t), cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (res.status === 200 && data) {
        setWho(data as ConsoleWhoami)
        return
      }
      setWho(null)
      if (res.status === 401) {
        // The server does not recognise this token: do not keep it.
        clearConsoleToken()
        setToken(null)
        setAuthNote('That token was not accepted. Paste a valid supervisor or principal token.')
        return
      }
      setAuthNote(`Signed in, but the server could not confirm who this is (${res.status}${data?.error ? `: ${data.error}` : ''}).`)
    } catch {
      setWho(null)
      setAuthNote('Signed in, but the server could not be reached to confirm who this is.')
    }
  }

  function handleSignIn(pasted: string) {
    const t = pasted.trim()
    if (!t) return
    setAuthNote(saveConsoleToken(t) ? null : 'This browser blocked session storage, so the token is kept in this page only and is lost on reload.')
    setToken(t)
    setWho(null)
    void lookupWhoami(t)
  }

  function handleSignOut() {
    clearConsoleToken()
    setToken(null)
    setWho(null)
    setAuthNote(null)
  }

  async function handlePlan() {
    setBusy(true)
    setError(null)
    setPlan(null)
    setStatuses({})
    setObservations({})
    setProcesses({})
    setOverride(null)
    try {
      // Planning needs a principal with decision:propose (A-3); the server
      // records that principal as the requester.
      if (!signedIn) throw new Error(authFailureMessage(401, 'plan')!)
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: consoleHeaders('/api/plan', token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ objective }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(authFailureMessage(res.status, 'plan', data.error, data.retryAfterSeconds) ?? data.error ?? data.detail ?? 'Plan failed')
      setPlan(data)
      const next: Record<string, DecisionStatus> = {}
      const procs: Record<string, ProcessInfo | undefined> = {}
      for (const d of data.decisions as DecisionResponse[]) {
        if (d.decisionDocId) {
          // With the process engine on, the server's process definition picked
          // the first state (it may have auto-approved). Otherwise legacy mapping.
          const engineRan = d.process?.engine === 'on' || d.process?.engine === 'invalid'
          next[d.decisionDocId] =
            engineRan && d.status
              ? (d.status as DecisionStatus)
              : d.decision?.recommendation === 'reject' ? 'rejected' : 'awaiting-approval'
          procs[d.decisionDocId] = d.process ?? undefined
        }
      }
      setStatuses(next)
      setProcesses(procs)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * POST to a decision route with the signed-in token. A 401 or 403 becomes a
   * plain message; nothing is retried automatically.
   */
  async function callDecisionRoute<T = unknown>(decisionDocId: string, route: ConsoleDecisionRoute, body: Record<string, unknown>): Promise<T> {
    setError(null)
    if (!signedIn) throw new Error(authFailureMessage(401, route)!)
    const url = `/api/decisions/${encodeURIComponent(decisionDocId)}/${route}`
    const res = await fetch(url, {
      method: 'POST',
      headers: consoleHeaders(url, token, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const serverMessage = typeof data?.error === 'string'
        ? [data.error, ...(Array.isArray(data.reasons) ? data.reasons : [])].join(' ')
        : undefined
      throw new ConsoleCallError(authFailureMessage(res.status, route, serverMessage, data?.retryAfterSeconds) ?? data.error ?? data.detail ?? `${route} failed`, res.status, data)
    }
    return data as T
  }

  async function handleAct(
    decisionDocId: string,
    action: 'approve' | 'reject' | 'request-evidence',
    justification?: string,
    expectedActionFingerprint?: string | null,
  ) {
    if (action === 'approve' && !expectedActionFingerprint) {
      setError('Refresh the current plan before approving; its action fingerprint is unavailable.')
      return
    }
    setActingId(decisionDocId)
    try {
      const data = await callDecisionRoute<{ status?: string; process?: ProcessInfo }>(
        decisionDocId,
        'action',
        {
          action,
          ...(justification ? { comment: justification } : {}),
          ...(action === 'approve' && expectedActionFingerprint ? { expectedActionFingerprint } : {}),
        },
      )
      setOverride((o) => (o?.decisionId === decisionDocId ? null : o))
      startTransition(() => {
        setStatuses((s) => ({
          ...s,
          [decisionDocId]: data.process
            ? (data.status as DecisionStatus)
            : action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : s[decisionDocId],
        }))
        if (data.process) setProcesses((p) => ({ ...p, [decisionDocId]: data.process }))
      })
    } catch (err) {
      // Separation of duties with the sole-operator override open: ask for a
      // written justification instead of stopping here.
      const prompt = action === 'approve' && err instanceof ConsoleCallError ? soleOperatorPrompt(err.status, err.body) : null
      if (prompt) {
        setOverride({ decisionId: decisionDocId, prompt, expectedActionFingerprint: expectedActionFingerprint! })
        setError(null)
      } else {
        setError((err as Error).message)
      }
    } finally {
      setActingId(null)
    }
  }

  async function handleResume(decisionDocId: string) {
    setActingId(decisionDocId)
    try {
      const data = await callDecisionRoute<{ status: string; process?: ProcessInfo }>(decisionDocId, 'resume', {})
      startTransition(() => {
        setStatuses((s) => ({ ...s, [decisionDocId]: data.status as DecisionStatus }))
        if (data.process) setProcesses((p) => ({ ...p, [decisionDocId]: data.process }))
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setActingId(null)
    }
  }

  async function handleExecute(decisionDocId: string) {
    setActingId(decisionDocId)
    try {
      const data = await callDecisionRoute<{
        status: 'executed' | 'failed'
        process?: ProcessInfo
        rolledBackParent?: { id: string; status?: string; error?: string; process?: ProcessInfo } | null
      }>(decisionDocId, 'execute', {})
      startTransition(() => {
        setStatuses((s) => {
          const next = { ...s, [decisionDocId]: data.status }
          const parent = data.rolledBackParent
          if (parent?.status) next[parent.id] = parent.status as DecisionStatus
          return next
        })
        const parentProcess = data.rolledBackParent?.process
        setProcesses((p) => ({
          ...p,
          ...(data.process ? { [decisionDocId]: data.process } : {}),
          ...(parentProcess && data.rolledBackParent ? { [data.rolledBackParent.id]: parentProcess } : {}),
        }))
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setActingId(null)
    }
  }

  async function handleObserve(decisionDocId: string) {
    setActingId(decisionDocId)
    try {
      const data = await callDecisionRoute<Observation>(decisionDocId, 'observe', {})
      startTransition(() => {
        setObservations((o) => ({ ...o, [decisionDocId]: data }))
        if (data.deviationDetected) {
          setStatuses((s) => ({ ...s, [decisionDocId]: 'rollback-suggested' }))
        }
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setActingId(null)
    }
  }

  async function handleRollback(decisionDocId: string) {
    setActingId(decisionDocId)
    try {
      const data = await callDecisionRoute<{ rollbackDecisionId: string; parentStatus?: string; parentProcess?: ProcessInfo; process?: ProcessInfo }>(
        decisionDocId,
        'rollback',
        {},
      )
      const obs = observations[decisionDocId]
      startTransition(() => {
        // The rollback is its own decision: it waits for a human, like any other.
        setStatuses((s) => ({
          ...s,
          [data.rollbackDecisionId]: (data.process?.state as DecisionStatus | undefined) ?? 'awaiting-approval',
          ...(data.parentStatus ? { [decisionDocId]: data.parentStatus as DecisionStatus } : {}),
        }))
        setProcesses((p) => ({
          ...p,
          ...(data.process ? { [data.rollbackDecisionId]: data.process } : {}),
          ...(data.parentProcess ? { [decisionDocId]: data.parentProcess } : {}),
        }))
        setObservations((o) => ({
          ...o,
          [decisionDocId]: obs ? { ...obs, rollbackDecisionId: data.rollbackDecisionId } : obs,
        }))
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setActingId(null)
    }
  }

  return (
    <main className="app-main qs-home">
      <header className="qs-home__header">
        <p className="qs-eyebrow">Nuera Quicksilver · Governed operations</p>
        <h1 className="qs-page-heading">Turn intent into governed action.</h1>
        <p className="qs-page-heading__summary">
          Describe the outcome you want. The NQC Kernel evaluates the plan and keeps high-impact decisions under human oversight.
        </p>
      </header>

      <div className="qs-workspace-grid">
        <section aria-labelledby="intent-title" className="qs-panel qs-intent-panel">
          <div className="qs-panel__heading">
            <div>
              <p className="qs-eyebrow">01 · Start with an outcome</p>
              <h2 id="intent-title">What should change?</h2>
            </div>
            <span className="qs-status-pill">Plan first · no action runs</span>
          </div>
          <label htmlFor="business-objective" className="qs-field__label">Business objective</label>
          <textarea
            id="business-objective"
            className="qs-field qs-field--textarea"
            rows={4}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            aria-describedby="objective-help"
          />
          <div className="qs-intent-panel__footer">
            <p id="objective-help" className="qs-helper">
              Quicksilver will prepare a reviewable plan. Approvals and execution stay in the decision flow.
            </p>
            <button
              onClick={handlePlan}
              disabled={busy || objective.trim().length < 3 || !signedIn}
              className="qs-action-primary"
            >
              {busy ? 'Preparing plan…' : 'Create plan'}
            </button>
          </div>
          {error && (
            <p className="qs-inline-alert" role="alert">{error}</p>
          )}
        </section>

        <aside className="qs-access-column" aria-label="Access and guidance">
          <ConsoleSignIn token={token} session={session} who={who} note={authNote} onSignIn={handleSignIn} onSignOut={handleSignOut} />
          <section className="qs-guidance-card" aria-label="How governed planning works">
            <p className="qs-eyebrow">How it works</p>
            <ol>
              <li><span>1</span><div><strong>Describe the outcome</strong><p>Start with a measurable objective and its constraints.</p></div></li>
              <li><span>2</span><div><strong>Review the plan</strong><p>Inspect risks, evidence, and the kernel’s decision before acting.</p></div></li>
              <li><span>3</span><div><strong>Approve deliberately</strong><p>High-impact actions wait for an authorized human.</p></div></li>
            </ol>
          </section>
        </aside>
      </div>

      <nav className="qs-feature-section" aria-label="Quicksilver workspaces">
        <div className="qs-section-heading">
          <div>
            <p className="qs-eyebrow">Explore the workspace</p>
            <h2>Pick up where your work happens.</h2>
          </div>
          <p>Each area has its own tools, history, and governance controls.</p>
        </div>
        <div className="qs-feature-grid">
          <Link className="qs-feature-card" href="/decisions">
            <span className="qs-feature-card__icon" aria-hidden="true">01</span>
            <span><strong>Decision log</strong><small>Review approvals, actions, and outcomes.</small></span>
            <span className="qs-feature-card__arrow" aria-hidden="true">↗</span>
          </Link>
          <Link className="qs-feature-card" href="/workflows">
            <span className="qs-feature-card__icon" aria-hidden="true">02</span>
            <span><strong>Workflow studio</strong><small>Build, review, and publish automations.</small></span>
            <span className="qs-feature-card__arrow" aria-hidden="true">↗</span>
          </Link>
          <Link className="qs-feature-card" href="/monitoring">
            <span className="qs-feature-card__icon" aria-hidden="true">03</span>
            <span><strong>Run monitoring</strong><small>Track workflow health and recent activity.</small></span>
            <span className="qs-feature-card__arrow" aria-hidden="true">↗</span>
          </Link>
          <Link className="qs-feature-card" href="/agents">
            <span className="qs-feature-card__icon" aria-hidden="true">04</span>
            <span><strong>Agent catalog</strong><small>Manage agent definitions and reviews.</small></span>
            <span className="qs-feature-card__arrow" aria-hidden="true">↗</span>
          </Link>
        </div>
      </nav>

      {override && (
        <SoleOperatorJustification
          decisionId={override.decisionId}
          prompt={override.prompt}
          busy={actingId === override.decisionId}
          onSubmit={(text) => handleAct(override.decisionId, 'approve', text, override.expectedActionFingerprint)}
          onCancel={() => setOverride(null)}
        />
      )}

      {plan && (
        <PlanAndDecisions
          plan={plan}
          statuses={statuses}
          observations={observations}
          processes={processes}
          actingId={actingId}
          onPlan={handlePlan}
          onAct={handleAct}
          onExecute={handleExecute}
          onObserve={handleObserve}
          onRollback={handleRollback}
          onResume={handleResume}
        />
      )}

      <footer className="qs-process-footer">
        <span>Governed execution path</span>
        <p>Company <span>→</span> State <span>→</span> Intent <span>→</span> Decision <span>→</span> Action <span>→</span> State</p>
      </footer>
    </main>
  )
}

/**
 * Sign-in for the decision buttons. The pasted token is kept in this tab's
 * sessionStorage only and sent only to this app's own API routes (the decision
 * routes, whoami, plan, query and the workflow routes; see mayCarryConsoleToken).
 * The input is a password field and is cleared after sign-in.
 */
function ConsoleSignIn({
  token, session, who, note, onSignIn, onSignOut,
}: {
  token: string | null
  session: boolean
  who: ConsoleWhoami | null
  note: string | null
  onSignIn: (token: string) => void
  onSignOut: () => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <section aria-label="Supervisor sign-in" className="qs-panel qs-access-panel">
      {token || session ? (
        <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
          <span className="text-quicksilver-signal">
            {who
              ? <>Signed in as <strong>{who.displayName ?? who.principalId}</strong> <span className="text-quicksilver-accent">({who.kind}{who.displayName ? ` · ${who.principalId}` : ''}) · can: {who.permissions.filter((p) => p.startsWith('decision:')).map((p) => p.slice('decision:'.length)).join(', ') || 'no decision actions'}</span></>
              : 'Signed in'}
          </span>
          {token ? (
            <button
              onClick={onSignOut}
              className="rounded border border-quicksilver-border px-3 py-1.5 uppercase tracking-widest text-quicksilver-accent transition hover:text-quicksilver-signal"
            >
              Sign out
            </button>
          ) : <span className="text-quicksilver-accent">Organisation account · sign out from the menu</span>}
        </div>
      ) : DEMO ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Demo sign-in</span>
          {DEMO_PRINCIPALS.map((p) => (
            <button
              key={p.id}
              onClick={() => onSignIn(p.token)}
              className="rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-3 py-1.5 font-mono text-xs text-quicksilver-signal transition hover:bg-quicksilver-quicksilver/15"
            >
              {p.displayName}, {p.title} <span className="text-quicksilver-accent">({p.purpose})</span>
            </button>
          ))}
          <p className="w-full font-mono text-[11px] text-quicksilver-accent">
            Synthetic company, public dataset. Plan as Marcus, then sign out and approve as Sarah: separation of duties means neither can do both.
          </p>
        </div>
      ) : (
        <form
          className="qs-signin-form"
          onSubmit={(e) => {
            e.preventDefault()
            onSignIn(draft)
            setDraft('')
          }}
        >
          <label htmlFor="console-token" className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
            Supervisor or principal token
          </label>
          <input
            id="console-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="qs-field qs-field--token"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-quicksilver-signal transition hover:bg-quicksilver-quicksilver/15 disabled:opacity-40"
          >
            Sign in
          </button>
          <p className="w-full font-mono text-[11px] text-quicksilver-accent">
            Needed to plan, approve, execute, observe, resume and roll back. Kept in this tab only (cleared when the tab closes).
          </p>
        </form>
      )}
      {note && <p className="mt-2 font-mono text-xs text-yellow-300">{note}</p>}
    </section>
  )
}

/**
 * Separation of duties refused an approval because the signed-in person
 * requested (or proposed) the decision, and they are the configured sole
 * operator: they may approve anyway with a written justification, which is
 * stored on the approval record with `soleOperatorOverride: true`.
 */
function SoleOperatorJustification({
  decisionId, prompt, busy, onSubmit, onCancel,
}: {
  decisionId: string
  prompt: SoleOperatorPrompt
  busy: boolean
  onSubmit: (justification: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const long = text.trim().length >= prompt.minJustificationLength
  return (
    <section aria-label="Sole-operator justification" className="mb-8 rounded border border-yellow-500/60 bg-quicksilver-panel p-4 font-mono text-xs">
      <h2 className="mb-2 uppercase tracking-widest text-yellow-300">Separation of duties: justification needed</h2>
      <p className="mb-2 text-quicksilver-accent">
        You requested decision <span className="text-quicksilver-signal">{decisionId}</span>, so another person would normally approve it.
        As the sole operator you may approve it yourself with a written justification of at least {prompt.minJustificationLength} characters.
        It is kept on the approval record, marked as an override.
      </p>
      {prompt.reasons.length > 0 && (
        <ul className="mb-2 list-disc pl-5 text-quicksilver-accent">
          {prompt.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      <label htmlFor="sole-operator-justification" className="mb-1 block uppercase tracking-widest text-quicksilver-accent">Justification</label>
      <textarea
        id="sole-operator-justification"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded border border-quicksilver-border bg-quicksilver-bg p-2 text-quicksilver-signal focus:border-quicksilver-quicksilver focus:outline-none"
      />
      <p className="mt-1 text-quicksilver-accent">{text.trim().length} / {prompt.minJustificationLength} characters minimum</p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => onSubmit(text.trim())}
          disabled={!long || busy}
          className="rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-3 py-1.5 uppercase tracking-widest text-quicksilver-signal transition hover:bg-quicksilver-quicksilver/15 disabled:opacity-40"
        >
          {busy ? 'Approving…' : 'Approve with justification'}
        </button>
        <button
          onClick={onCancel}
          className="rounded border border-quicksilver-border px-3 py-1.5 uppercase tracking-widest text-quicksilver-accent transition hover:text-quicksilver-signal"
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

// Best-course-of-action ordering for the decision cards: autonomous-safe
// actions first, then things that need a human call, then anything the
// kernel would reject outright -- and within a tier, lower risk first. This
// is purely a render-order concern (local, derived, no API/schema change);
// the underlying plan.decisions array and its indices are untouched.
const RECOMMENDATION_ORDER: Record<DecisionDecision['recommendation'], number> = {
  'execute-autonomously': 0,
  'request-approval': 1,
  reject: 2,
}

function sortDecisions(decisions: DecisionResponse[]): DecisionResponse[] {
  return [...decisions].sort((a, b) => {
    // A decision the kernel couldn't evaluate at all (no resolved capability
    // or actor) sorts last -- it needs attention, but it isn't "best next
    // action" material since there's nothing to authorize yet.
    if (!a.decision && !b.decision) return 0
    if (!a.decision) return 1
    if (!b.decision) return -1

    const tierDiff =
      RECOMMENDATION_ORDER[a.decision.recommendation] - RECOMMENDATION_ORDER[b.decision.recommendation]
    if (tierDiff !== 0) return tierDiff

    return a.decision.riskLevel - b.decision.riskLevel
  })
}

function PlanAndDecisions({
  plan,
  statuses,
  observations,
  processes,
  actingId,
  onPlan,
  onAct,
  onExecute,
  onObserve,
  onRollback,
  onResume,
}: {
  plan: PlanResponse
  statuses: Record<string, DecisionStatus>
  observations: Record<string, Observation | undefined>
  processes: Record<string, ProcessInfo | undefined>
  actingId: string | null
  onPlan: () => Promise<void>
  onAct: (id: string, a: 'approve' | 'reject' | 'request-evidence', justification?: string, expectedActionFingerprint?: string | null) => Promise<void>
  onExecute: (id: string) => Promise<void>
  onObserve: (id: string) => Promise<void>
  onRollback: (id: string) => Promise<void>
  onResume: (id: string) => Promise<void>
}) {
  // Page-level nudge: how many of the current decisions still need a human
  // call. Purely derived from local state — no new data, just a count so a
  // first-time viewer knows at a glance whether there's something to do
  // before they scroll into the cards themselves.
  const awaitingCount = plan.decisions.filter(
    (d) => d.decisionDocId && statuses[d.decisionDocId] === 'awaiting-approval',
  ).length

  // Best-course-of-action first: see sortDecisions() above. Sorted once per
  // render from the same plan.decisions the API returned -- nothing is
  // mutated, and re-sorting on every render is fine since a click only
  // changes `statuses`/`observations`, never `plan` itself.
  const sortedDecisions = sortDecisions(plan.decisions)

  return (
    <>
      <section className="mb-6 rounded border border-quicksilver-border bg-quicksilver-panel p-6">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
          Plan
        </h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-quicksilver-signal">
          {plan.reasoning}
        </p>
        {plan.decomposition.requiredCapabilities.length > 0 && (
          <div className="mt-4">
            <h3 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
              Required capabilities
            </h3>
            <ul className="mt-2 space-y-1">
              {plan.decomposition.requiredCapabilities.map((c, i) => (
                <li key={i} className="font-mono text-xs text-quicksilver-signal">• {c}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.decomposition.constraints.length > 0 && (
          <div className="mt-4">
            <h3 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
              Constraints
            </h3>
            <ul className="mt-2 space-y-1">
              {plan.decomposition.constraints.map((c, i) => (
                <li key={i} className="font-mono text-xs text-quicksilver-signal">• {c}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="mb-4 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
            Decisions
          </h2>
          {awaitingCount > 0 && (
            <span className="rounded-full border border-yellow-300/50 px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-yellow-300">
              {awaitingCount} awaiting your approval
            </span>
          )}
        </div>
        <button
          onClick={onPlan}
          className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent transition hover:text-quicksilver-signal"
        >
          Replan
        </button>
      </section>

      <section className="grid grid-cols-1 gap-6">
        {sortedDecisions.map((d, i) => (
          <DecisionCard
            key={d.decisionDocId ?? `idx-${i}`}
            d={d}
            status={d.decisionDocId ? statuses[d.decisionDocId] ?? 'pending' : 'pending'}
            observation={d.decisionDocId ? observations[d.decisionDocId] : undefined}
            process={d.decisionDocId ? processes[d.decisionDocId] : undefined}
            rollbackStatus={(() => {
              const rb = d.decisionDocId ? observations[d.decisionDocId]?.rollbackDecisionId : undefined
              return rb ? statuses[rb] ?? 'awaiting-approval' : undefined
            })()}
            actingId={actingId}
            onAct={onAct}
            onExecute={onExecute}
            onObserve={onObserve}
            onRollback={onRollback}
            onResume={onResume}
          />
        ))}
      </section>
    </>
  )
}

function DecisionCard({
  d,
  status,
  observation,
  process,
  rollbackStatus,
  actingId,
  onAct,
  onExecute,
  onObserve,
  onRollback,
  onResume,
}: {
  d: DecisionResponse
  status: DecisionStatus
  observation: Observation | undefined
  process: ProcessInfo | undefined
  rollbackStatus: DecisionStatus | undefined
  actingId: string | null
  onAct: (id: string, a: 'approve' | 'reject' | 'request-evidence', justification?: string, expectedActionFingerprint?: string | null) => Promise<void>
  onExecute: (id: string) => Promise<void>
  onObserve: (id: string) => Promise<void>
  onRollback: (id: string) => Promise<void>
  onResume: (id: string) => Promise<void>
}) {
  const decision = d.decision
  const docId = d.decisionDocId

  // Reasoning and evidence (policies, evidence, the kernel's own
  // conflict/concern/blocking lists, and the independent reviewer's notes)
  // are collapsed by default. The summary above the fold — description,
  // status, the reference grid, and the action buttons — carries everything
  // needed to act on a decision; the "why" is one click away rather than
  // several screens of scroll.
  const [expanded, setExpanded] = useState(false)

  const statusTone: Record<DecisionStatus, string> = {
    'pending': 'border-quicksilver-border text-quicksilver-accent',
    'proposed': 'border-quicksilver-border text-quicksilver-accent',
    'awaiting-approval': 'border-yellow-300/60 text-yellow-300',
    'approved': 'border-quicksilver-quicksilver/60 text-quicksilver-signal',
    'executed': 'border-green-400/60 text-green-400',
    'failed': 'border-red-400/60 text-red-400',
    'rejected': 'border-red-400/60 text-red-400',
    'rollback-suggested': 'border-yellow-300/60 text-yellow-300',
    'rollback-proposed': 'border-yellow-300/60 text-yellow-300',
    'rolled-back': 'border-orange-400/60 text-orange-400',
  }
  const statusLabel: Record<DecisionStatus, string> = {
    'pending': 'pending',
    'proposed': 'proposed',
    'awaiting-approval': 'awaiting approval',
    'approved': 'approved',
    'executed': 'executed',
    'failed': 'failed',
    'rejected': 'rejected',
    'rollback-suggested': 'rollback suggested',
    'rollback-proposed': 'rollback proposed',
    'rolled-back': 'rolled back',
  }

  const kernelFlagCount =
    (decision?.policyConflicts?.length ?? 0) +
    (decision?.concerns?.length ?? 0) +
    (decision?.blockingReasons?.length ?? 0)
  const reviewFlagCount = d.review
    ? d.review.policyConflicts.length + d.review.missingEvidence.length + d.review.riskConcerns.length
    : 0
  const totalFlags = kernelFlagCount + reviewFlagCount

  // Whether one of the lifecycle buttons below applies to this status; when
  // none does, say why instead of showing an empty row.
  const hasLifecycleAction =
    status === 'awaiting-approval' ||
    status === 'approved' ||
    status === 'executed' ||
    status === 'failed' ||
    status === 'rollback-suggested' ||
    (status === 'proposed' && process?.engine === 'on')

  return (
    <article className="rounded border border-quicksilver-border bg-quicksilver-panel p-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h3 className="text-base text-quicksilver-signal">{d.action.description}</h3>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-xs whitespace-nowrap ${statusTone[status] ?? statusTone.proposed}`}
        >
          risk {decision?.riskLevel ?? '?'}/5 · {statusLabel[status] ?? status}
        </span>
      </header>

      <dl className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Reference label="Actor" value={d.resolvedReferences.actor?.name ?? '—'} />
        <Reference label="Capability" value={d.resolvedReferences.capability?.name ?? '—'} />
        <Reference label="Capability risk" value={d.resolvedReferences.capability?.riskLevel?.toString() ?? '—'} />
        <Reference label="Financial exposure" value={`$${d.action.financialExposure.toLocaleString()}`} />
        <Reference label="Reversible" value={d.action.reversible ? 'yes' : 'no'} />
        <Reference label="Kernel" value={decision?.recommendation ?? 'pending'} />
      </dl>

      {docId && status === 'awaiting-approval' && (
        <details className="mb-4 rounded border border-quicksilver-border px-3 py-2 text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
            Approval basis <span className="normal-case tracking-normal">· review the action snapshot before approving</span>
          </summary>
          <div className="space-y-2 border-t border-quicksilver-border pt-3">
            <p className="text-sm text-quicksilver-signal">Approval is bound to this action and its current policy snapshot. If either changes, review the updated decision before approving.</p>
            <p className="font-mono text-xs text-quicksilver-accent">Action fingerprint</p>
            <code className="block break-all rounded bg-black/20 p-2 font-mono text-xs text-quicksilver-signal">{d.approvalFingerprint ?? 'Unavailable — refresh the decision before approving.'}</code>
          </div>
        </details>
      )}

      {process && <ProcessStrip process={process} />}

      {/* Lifecycle buttons — always visible, never behind the expand toggle,
          so the thing a judge needs to click is never more than the
          reference grid away. */}
      <div className="mb-4 flex flex-wrap gap-2">
        {!docId && <span className="font-mono text-xs text-quicksilver-accent">Not persisted — the actor or capability was not found in the company model.</span>}

        {docId && status === 'awaiting-approval' && (
          <>
            <ActionButton label="Approve reviewed action" onClick={() => onAct(docId, 'approve', undefined, d.approvalFingerprint)} busy={actingId === docId} tone="primary" />
            <ActionButton label="Reject" onClick={() => onAct(docId, 'reject')} busy={actingId === docId} tone="secondary" />
            <ActionButton label="Request more evidence" onClick={() => onAct(docId, 'request-evidence')} busy={actingId === docId} tone="tertiary" />
          </>
        )}

        {docId && status === 'proposed' && process?.engine === 'on' && (
          <ActionButton label="Resume (re-check process)" onClick={() => onResume(docId)} busy={actingId === docId} tone="primary" />
        )}

        {docId && status === 'approved' && (
          <ActionButton label="Execute (simulated)" onClick={() => onExecute(docId)} busy={actingId === docId} tone="primary" />
        )}

        {docId && (status === 'executed' || status === 'failed') && (
          <ActionButton label="Observe metric" onClick={() => onObserve(docId)} busy={actingId === docId} tone="secondary" />
        )}

        {docId && status === 'rollback-suggested' && (
          <ActionButton label="Propose rollback" onClick={() => onRollback(docId)} busy={actingId === docId} tone="primary" />
        )}

        {docId && !hasLifecycleAction && (
          <span className="font-mono text-xs text-quicksilver-accent">{noActionReason(status, process)}</span>
        )}
      </div>

      <button
        onClick={() => setExpanded((e) => !e)}
        className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent transition hover:text-quicksilver-signal"
      >
        {expanded ? 'Hide reasoning & evidence ▴' : 'Show reasoning & evidence ▾'}
        {!expanded && totalFlags > 0 && (
          <span className="ml-2 normal-case tracking-normal text-yellow-300">
            ({totalFlags} flag{totalFlags === 1 ? '' : 's'})
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-quicksilver-border pt-4">
          <div>
            <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Proposed action</h4>
            <dl className="mt-1 grid grid-cols-1 gap-1 font-mono text-xs sm:grid-cols-2">
              <div><dt className="inline text-quicksilver-accent">actor </dt><dd className="inline text-quicksilver-signal">{d.action.actorId}</dd></div>
              <div><dt className="inline text-quicksilver-accent">capability </dt><dd className="inline text-quicksilver-signal">{d.action.capabilityId}</dd></div>
              <div><dt className="inline text-quicksilver-accent">operational impact </dt><dd className="inline text-quicksilver-signal">{d.action.operationalImpact}</dd></div>
              <div><dt className="inline text-quicksilver-accent">uncertainty </dt><dd className="inline text-quicksilver-signal">{d.action.uncertainty}</dd></div>
              <div><dt className="inline text-quicksilver-accent">policies cited </dt><dd className="inline text-quicksilver-signal">{d.action.applicablePolicyIds.join(', ') || 'none'}</dd></div>
              <div><dt className="inline text-quicksilver-accent">evidence cited </dt><dd className="inline text-quicksilver-signal">{d.action.evidenceIds.join(', ') || 'none'}</dd></div>
            </dl>
          </div>

          {d.resolvedReferences.policies.length === 0 && d.resolvedReferences.evidence.length === 0 && kernelFlagCount === 0 && !d.review && (
            <p className="font-mono text-xs text-quicksilver-accent">
              No policy or evidence in the company model matched the ids above, and neither the kernel nor the reviewer raised anything.
              {(d.action.applicablePolicyIds.length > 0 || d.action.evidenceIds.length > 0) && ' The planner cited ids that were not found.'}
            </p>
          )}
          {d.resolvedReferences.policies.length > 0 && (
            <div>
              <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
                Applicable policies
              </h4>
              <ul className="mt-1 space-y-1">
                {d.resolvedReferences.policies.map((p) => (
                  <li key={p.id} className="font-mono text-xs text-quicksilver-signal">
                    {p.name}{' '}
                    <span className="text-quicksilver-accent">
                      scope={p.scope} priority={p.priority}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {d.resolvedReferences.evidence.length > 0 && (
            <div>
              <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
                Supporting evidence
              </h4>
              <ul className="mt-1 space-y-1">
                {d.resolvedReferences.evidence.map((e) => (
                  <li key={e.id} className="font-mono text-xs text-quicksilver-signal">
                    {e.title}{' '}
                    <span className="text-quicksilver-accent">
                      confidence {(e.confidence * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {decision?.policyConflicts && decision.policyConflicts.length > 0 && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-quicksilver-border bg-quicksilver-bg p-3 font-mono text-xs leading-relaxed text-quicksilver-accent">
{`Policy conflict detected:\n${decision.policyConflicts.map((c) => `  ${c}`).join('\n')}`}
            </pre>
          )}

          {decision?.concerns && decision.concerns.length > 0 && (
            <ul className="space-y-1">
              {decision.concerns.map((c, i) => (
                <li key={i} className="font-mono text-xs text-yellow-300">
                  ! {c}
                </li>
              ))}
            </ul>
          )}

          {decision?.blockingReasons && decision.blockingReasons.length > 0 && (
            <ul className="space-y-1">
              {decision.blockingReasons.map((c, i) => (
                <li key={i} className="font-mono text-xs text-red-400">
                  ✗ {c}
                </li>
              ))}
            </ul>
          )}

          {d.why && <WhyPanel why={d.why} escalationReasons={d.escalationReasons} />}

          {/* Independent reviewer panel — advisory only. The kernel above is what
              actually authorizes or blocks; this is a second opinion for the
              human approver to weigh, never a gate. */}
          {d.review && (
            <div className="rounded border border-dashed border-quicksilver-accent/60 bg-quicksilver-bg p-3">
              <h4 className="mb-2 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
                Independent review <span className="normal-case tracking-normal">(advisory, not a gate)</span>
              </h4>
              {d.review.policyConflicts.length === 0 &&
              d.review.missingEvidence.length === 0 &&
              d.review.riskConcerns.length === 0 &&
              d.review.suggestions.length === 0 ? (
                <p className="font-mono text-xs text-quicksilver-signal">No concerns raised.</p>
              ) : (
                <div className="space-y-2">
                  {d.review.policyConflicts.length > 0 && (
                    <ul className="space-y-1">
                      {d.review.policyConflicts.map((c, i) => (
                        <li key={i} className="font-mono text-xs text-red-400">⚠ policy: {c}</li>
                      ))}
                    </ul>
                  )}
                  {d.review.missingEvidence.length > 0 && (
                    <ul className="space-y-1">
                      {d.review.missingEvidence.map((c, i) => (
                        <li key={i} className="font-mono text-xs text-yellow-300">? evidence: {c}</li>
                      ))}
                    </ul>
                  )}
                  {d.review.riskConcerns.length > 0 && (
                    <ul className="space-y-1">
                      {d.review.riskConcerns.map((c, i) => (
                        <li key={i} className="font-mono text-xs text-yellow-300">! risk: {c}</li>
                      ))}
                    </ul>
                  )}
                  {d.review.suggestions.length > 0 && (
                    <ul className="space-y-1">
                      {d.review.suggestions.map((c, i) => (
                        <li key={i} className="font-mono text-xs text-quicksilver-accent">→ {c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Observation panel — the result of an action already taken, so it
          stays outside the reasoning toggle and always visible once present. */}
      {observation && observation.observed && (
        <div className="mt-4 rounded border border-quicksilver-border bg-quicksilver-bg p-4">
          <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
            Closed-loop observation
          </h4>
          <dl className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
            <Reference label="Metric" value={observation.observed.metric} />
            <Reference label="Change" value={`${observation.observed.delta > 0 ? '+' : ''}${observation.observed.delta.toFixed(2)} ${observation.observed.unit} (${observation.observed.pctChange > 0 ? '+' : ''}${observation.observed.pctChange.toFixed(1)}%)`} />
            <Reference label="Baseline" value={`${observation.observed.baseline} ${observation.observed.unit}`} />
            <Reference label="Current" value={`${observation.observed.value.toFixed(2)} ${observation.observed.unit}`} />
          </dl>
          <p className="mt-3 font-mono text-xs text-quicksilver-signal">{observation.diagnosis}</p>
          {observation.recommendedRollback && (
            <div className="mt-3 rounded border border-yellow-700/40 bg-yellow-950/20 p-3">
              <p className="font-mono text-xs text-yellow-300">{observation.recommendedRollback.rationale}</p>
              {observation.rollbackDecisionId && (
                <>
                  <p className="mt-2 font-mono text-xs text-quicksilver-signal">
                    rollback decision created: <code className="text-quicksilver-accent">{observation.rollbackDecisionId}</code>
                    {rollbackStatus && <span className="text-quicksilver-accent"> · {rollbackStatus}</span>}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {rollbackStatus === 'awaiting-approval' && (
                      <ActionButton
                        label="Approve rollback"
                        onClick={() => onAct(observation.rollbackDecisionId!, 'approve')}
                        busy={actingId === observation.rollbackDecisionId}
                        tone="primary"
                      />
                    )}
                    {rollbackStatus === 'approved' && (
                      <ActionButton
                        label="Execute rollback (simulated)"
                        onClick={() => onExecute(observation.rollbackDecisionId!)}
                        busy={actingId === observation.rollbackDecisionId}
                        tone="primary"
                      />
                    )}
                    {rollbackStatus === 'failed' && docId && (
                      <ActionButton
                        label="Retry rollback"
                        onClick={() => onRollback(docId)}
                        busy={actingId === docId}
                        tone="primary"
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * One line under the reference grid: which process definition governs this
 * decision, where it is now, how it got there, and what can happen next.
 * Only rendered when the server ran the process engine.
 */
function ProcessStrip({ process }: { process: ProcessInfo }) {
  if (process.engine === 'off' || process.engine === 'missing') return null
  if (process.engine === 'invalid') {
    return (
      <div className="mb-4 rounded border border-red-400/60 p-3 font-mono text-xs text-red-400">
        Process definition {process.definitionName ?? ''} v{process.version ?? '?'} is invalid — the kernel is holding
        this decision until it is fixed in Studio.
        {process.errors?.slice(0, 3).map((e, i) => (
          <div key={i} className="mt-1 text-red-300">✗ {e}</div>
        ))}
      </div>
    )
  }
  const automatic = process.transitionId === 'auto-approve'
  const next = process.next ?? []
  return (
    <div className="mb-4 rounded border border-quicksilver-border p-3 font-mono text-xs">
      <div className="text-quicksilver-accent">
        Process · <span className="text-quicksilver-signal">{process.definitionName} v{process.version}</span> ·{' '}
        <span className="text-quicksilver-signal">{process.stateLabel}</span>
        {process.transitionId && <span> (via {process.transitionId})</span>}
      </div>
      {automatic && (
        <div className="mt-1 text-green-400">
          ✓ Auto-approved by the kernel: within this process&apos;s autonomy ceiling, no human needed.
        </div>
      )}
      {next.length > 0 && (
        <div className="mt-1 text-quicksilver-accent">
          Next:{' '}
          {next.map((n, i) => (
            <span key={n.id}>
              {i > 0 && ' · '}
              <span className={n.guardPassed ? 'text-quicksilver-signal' : ''}>{n.label}</span>
              {n.requiresHuman && ' (human)'}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Reference({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-quicksilver-signal">{value}</dd>
    </div>
  )
}

function ActionButton({
  label, onClick, busy, tone,
}: {
  label: string
  onClick: () => void
  busy: boolean
  tone: 'primary' | 'secondary' | 'tertiary'
}) {
  const cls =
    tone === 'primary'
      ? 'border-quicksilver-quicksilver bg-quicksilver-quicksilver/10 text-quicksilver-signal hover:bg-quicksilver-quicksilver/20'
      : 'border-quicksilver-border text-quicksilver-accent hover:border-quicksilver-accent hover:text-quicksilver-signal'
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`rounded border px-3 py-1.5 font-mono text-xs uppercase tracking-widest transition disabled:opacity-40 ${cls}`}
    >
      {busy ? 'Working…' : label}
    </button>
  )
}

/** Why a decision card shows no lifecycle button (shown in place of the buttons). */
function noActionReason(status: string, process: ProcessInfo | undefined): string {
  switch (status) {
    case 'rejected':
      return 'Rejected by the kernel: a hard block (see reasoning & evidence). Nothing to approve.'
    case 'proposed':
      return process?.engine === 'invalid'
        ? 'Held: the process definition in Sanity failed validation, so the kernel moves nothing.'
        : 'Proposed: waiting in the process definition\'s first state.'
    case 'rolled-back':
      return 'Rolled back. Nothing left to do.'
    case 'rollback-proposed':
      return 'Rollback proposed: waiting for a supervisor to approve it.'
    case 'pending':
      return 'Pending: not yet evaluated.'
    default:
      return `Status "${status}" has no console action${process?.stateLabel ? ` (process state: ${process.stateLabel})` : ''}.`
  }
}
