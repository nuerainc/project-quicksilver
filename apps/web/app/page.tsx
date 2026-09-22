'use client'

import { useState, useTransition } from 'react'

type DecisionDecision = {
  authorized: boolean
  riskLevel: number
  requiresApproval: boolean
  blockingReasons: string[]
  concerns: string[]
  policyConflicts: string[]
  recommendation: 'execute-autonomously' | 'request-approval' | 'reject'
}

type DecisionResponse = {
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
  decisionDocId: string | null
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
  | 'awaiting-approval'
  | 'approved'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'rollback-suggested'

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
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  async function handlePlan() {
    setBusy(true)
    setError(null)
    setPlan(null)
    setStatuses({})
    setObservations({})
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? data.detail ?? 'Plan failed')
      setPlan(data)
      const next: Record<string, DecisionStatus> = {}
      for (const d of data.decisions) {
        if (d.decisionDocId) {
          next[d.decisionDocId] = d.decision?.recommendation === 'reject' ? 'rejected' : 'awaiting-approval'
        }
      }
      setStatuses(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function postJSON<T = unknown>(url: string, body: Record<string, unknown>): Promise<T> {
    setError(null)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? data.detail ?? `${url} failed`)
    return data as T
  }

  async function handleAct(
    decisionDocId: string,
    action: 'approve' | 'reject' | 'request-evidence',
  ) {
    setActingId(decisionDocId)
    try {
      await postJSON(`/api/decisions/${decisionDocId}/action`, { action })
      startTransition(() => {
        setStatuses((s) => ({
          ...s,
          [decisionDocId]:
            action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : s[decisionDocId],
        }))
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
      const data = await postJSON<{ status: 'executed' | 'failed' }>(`/api/decisions/${decisionDocId}/execute`, {})
      startTransition(() => {
        setStatuses((s) => ({ ...s, [decisionDocId]: data.status }))
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
      const data = await postJSON<Observation>(`/api/decisions/${decisionDocId}/observe`, {})
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
      const data = await postJSON<{ rollbackDecisionId: string }>(
        `/api/decisions/${decisionDocId}/rollback`,
        {},
      )
      const obs = observations[decisionDocId]
      startTransition(() => {
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
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-12">
        <h1 className="qs-glow font-mono text-3xl tracking-[0.3em] text-quicksilver-quicksilver">
          QUICKSILVER
        </h1>
        <p className="mt-2 text-sm uppercase tracking-widest text-quicksilver-accent">
          Autonomous Company Operating System
        </p>
        <p className="mt-6 max-w-2xl text-base text-quicksilver-accent">
          A chatbot reads your documents.{' '}
          <span className="text-quicksilver-signal">Quicksilver reasons over your company.</span>
        </p>
      </header>

      <section className="mb-8 rounded border border-quicksilver-border bg-quicksilver-panel p-6">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
          CEO intent
        </h2>
        <textarea
          className="w-full rounded border border-quicksilver-border bg-quicksilver-bg p-3 font-mono text-sm text-quicksilver-signal focus:border-quicksilver-quicksilver focus:outline-none"
          rows={3}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
        <button
          onClick={handlePlan}
          disabled={busy || objective.trim().length < 3}
          className="mt-3 rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-2 font-mono text-xs uppercase tracking-widest text-quicksilver-signal transition hover:bg-quicksilver-quicksilver/15 disabled:opacity-40"
        >
          {busy ? 'Reasoning…' : 'Send to Quicksilver'}
        </button>
        {error && (
          <p className="mt-3 font-mono text-xs text-red-400">{error}</p>
        )}
      </section>

      {plan && (
        <PlanAndDecisions
          plan={plan}
          statuses={statuses}
          observations={observations}
          actingId={actingId}
          onPlan={handlePlan}
          onAct={handleAct}
          onExecute={handleExecute}
          onObserve={handleObserve}
          onRollback={handleRollback}
        />
      )}

      <footer className="mt-16 border-t border-quicksilver-border pt-6 font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
        Company → State → Intent → Decision → Action → State
      </footer>
    </main>
  )
}

function PlanAndDecisions({
  plan,
  statuses,
  observations,
  actingId,
  onPlan,
  onAct,
  onExecute,
  onObserve,
  onRollback,
}: {
  plan: PlanResponse
  statuses: Record<string, DecisionStatus>
  observations: Record<string, Observation | undefined>
  actingId: string | null
  onPlan: () => Promise<void>
  onAct: (id: string, a: 'approve' | 'reject' | 'request-evidence') => Promise<void>
  onExecute: (id: string) => Promise<void>
  onObserve: (id: string) => Promise<void>
  onRollback: (id: string) => Promise<void>
}) {
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
        <h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
          Decisions
        </h2>
        <button
          onClick={onPlan}
          className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent transition hover:text-quicksilver-signal"
        >
          Replan
        </button>
      </section>

      <section className="grid grid-cols-1 gap-6">
        {plan.decisions.map((d, i) => (
          <DecisionCard
            key={i}
            d={d}
            status={d.decisionDocId ? statuses[d.decisionDocId] ?? 'pending' : 'pending'}
            observation={d.decisionDocId ? observations[d.decisionDocId] : undefined}
            actingId={actingId}
            onAct={onAct}
            onExecute={onExecute}
            onObserve={onObserve}
            onRollback={onRollback}
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
  actingId,
  onAct,
  onExecute,
  onObserve,
  onRollback,
}: {
  d: DecisionResponse
  status: DecisionStatus
  observation: Observation | undefined
  actingId: string | null
  onAct: (id: string, a: 'approve' | 'reject' | 'request-evidence') => Promise<void>
  onExecute: (id: string) => Promise<void>
  onObserve: (id: string) => Promise<void>
  onRollback: (id: string) => Promise<void>
}) {
  const decision = d.decision
  const docId = d.decisionDocId

  const statusTone: Record<DecisionStatus, string> = {
    'pending': 'text-quicksilver-accent',
    'awaiting-approval': 'text-yellow-300',
    'approved': 'text-quicksilver-signal',
    'executed': 'text-green-400',
    'failed': 'text-red-400',
    'rejected': 'text-red-400',
    'rollback-suggested': 'text-yellow-300',
  }
  const statusLabel: Record<DecisionStatus, string> = {
    'pending': 'pending',
    'awaiting-approval': 'awaiting approval',
    'approved': 'approved',
    'executed': 'executed',
    'failed': 'failed',
    'rejected': 'rejected',
    'rollback-suggested': 'rollback suggested',
  }

  return (
    <article className="rounded border border-quicksilver-border bg-quicksilver-panel p-6">
      <header className="mb-4 flex items-baseline justify-between">
        <h3 className="text-base text-quicksilver-signal">{d.action.description}</h3>
        <span className={`font-mono text-xs ${statusTone[status]}`}>
          risk {decision?.riskLevel ?? '?'}/5 · {statusLabel[status]}
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

      {d.resolvedReferences.policies.length > 0 && (
        <div className="mb-3">
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
        <div className="mb-3">
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
        <pre className="mb-3 overflow-x-auto whitespace-pre-wrap rounded border border-quicksilver-border bg-quicksilver-bg p-3 font-mono text-xs leading-relaxed text-quicksilver-accent">
{`Policy conflict detected:\n${decision.policyConflicts.map((c) => `  ${c}`).join('\n')}`}
        </pre>
      )}

      {decision?.concerns && decision.concerns.length > 0 && (
        <ul className="mb-3 space-y-1">
          {decision.concerns.map((c, i) => (
            <li key={i} className="font-mono text-xs text-yellow-300">
              ! {c}
            </li>
          ))}
        </ul>
      )}

      {decision?.blockingReasons && decision.blockingReasons.length > 0 && (
        <ul className="mb-3 space-y-1">
          {decision.blockingReasons.map((c, i) => (
            <li key={i} className="font-mono text-xs text-red-400">
              ✗ {c}
            </li>
          ))}
        </ul>
      )}

      {/* Lifecycle buttons */}
      <div className="mt-4 flex flex-wrap gap-2">
        {!docId && <span className="font-mono text-xs text-quicksilver-accent">Not persisted — the actor or capability was not found in the company model.</span>}

        {docId && status === 'awaiting-approval' && (
          <>
            <ActionButton label="Approve" onClick={() => onAct(docId, 'approve')} busy={actingId === docId} tone="primary" />
            <ActionButton label="Reject" onClick={() => onAct(docId, 'reject')} busy={actingId === docId} tone="secondary" />
            <ActionButton label="Request more evidence" onClick={() => onAct(docId, 'request-evidence')} busy={actingId === docId} tone="tertiary" />
          </>
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
      </div>

      {/* Observation panel */}
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
                <p className="mt-2 font-mono text-xs text-quicksilver-signal">
                  rollback decision created: <code className="text-quicksilver-accent">{observation.rollbackDecisionId}</code>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </article>
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