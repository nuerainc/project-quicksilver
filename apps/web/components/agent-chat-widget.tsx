'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { authFailureMessage, consoleHeaders, readConsoleToken } from '@/lib/console-auth'
import { chatRequest, type ChatMode } from '@/lib/chat-request'
import styles from './agent-chat-widget.module.css'

type QueryResponse = {
  question: string
  entities: Array<{ id: string; name: string; entityType: string; role: string | null; reasoning: string }>
  capabilities: Array<{ id: string; name: string; riskLevel: number }>
  policies: Array<{ id: string; name: string; scope: string }>
  supportingContext: string[]
  confidence: number
  audit?: { persisted: boolean; evaluationRecordIds: string[] }
  nqc?: { reasoningScore: number; hallucinationRisk: string; brittleness: string; safetyDecision: string; issues: string[] }
}

type ChatMessage = {
  id: string
  question: string
  mode: ChatMode
  response?: QueryResponse
  plan?: PlanChatResponse
}

type PlanChatResponse = {
  decomposition: { objective: string; constraints: string[]; successMetrics: string[]; candidateWorkstreams: string[] }
  reasoning: string
  decisions: Array<{
    action: { description: string; financialExposure: number; reversible: boolean }
    safetyDecision: 'ALLOW' | 'BLOCK' | 'ESCALATE' | null
    decisionDocId: string | null
    status: string | null
    decision: { recommendation: string; riskLevel: number; requiresApproval: boolean } | null
    review: { missingEvidence: string[]; riskConcerns: string[]; suggestions: string[] } | null
  }>
}

export function AgentChatWidget() {
  const [open, setOpen] = useState(false)
  const [tokenPresent, setTokenPresent] = useState(false)
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<ChatMode>('ask')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setTokenPresent(Boolean(readConsoleToken()))
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'auto' })
  }, [messages, busy, error])

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = question.trim()
    if (!text || busy) return
    const token = readConsoleToken()
    if (!token) {
      setTokenPresent(false)
      setError(mode === 'plan'
        ? 'Sign in with a principal allowed to propose decisions before asking Quicksilver to plan work.'
        : 'Sign in with a principal that has decision:read to ask company questions.')
      return
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    const submittedMode = mode
    setMessages((current) => [...current, { id, question: text, mode: submittedMode }])
    setQuestion('')
    setError(null)
    setBusy(true)
    try {
      const chat = chatRequest(submittedMode, text)
      const path = chat.path
      const response = await fetch(path, {
        method: 'POST',
        headers: consoleHeaders(path, token, { 'content-type': 'application/json' }),
        body: JSON.stringify(chat.body),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401) setTokenPresent(false)
        const message = authFailureMessage(response.status, submittedMode === 'plan' ? 'plan' : 'query', payload.error, payload.retryAfterSeconds)
          ?? payload.error
          ?? payload.detail
          ?? 'Quicksilver could not answer that question.'
        throw new Error(message)
      }
      setMessages((current) => current.map((item) => item.id !== id ? item : submittedMode === 'plan'
        ? { ...item, plan: payload as PlanChatResponse }
        : { ...item, response: payload as QueryResponse }))
    } catch (cause) {
      setError((cause as Error).message || 'Quicksilver could not answer that question.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {open && (
        <section id="qs-chat-panel" className={styles.panel} role="dialog" aria-labelledby="qs-chat-title" onKeyDown={handleKeyDown}>
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.avatar} aria-hidden="true">NQ</span>
              <div>
                <h2 id="qs-chat-title">Ask Quicksilver</h2>
                <p>Ask about your business or plan governed work</p>
              </div>
            </div>
            <button type="button" className={styles.close} onClick={close} aria-label="Close Quicksilver chat">×</button>
          </header>

          <div className={styles.safetyNote}>
            {mode === 'ask'
              ? 'Answers use company context and NQC evaluation. Ask mode is read-only.'
              : 'Plan mode creates evaluated proposals for review. It never approves or executes actions.'}
          </div>

          <div className={styles.thread} ref={threadRef} aria-label="Conversation" aria-live="polite">
            {messages.length === 0 ? (
              <div className={styles.welcome}>
                <span aria-hidden="true">✦</span>
                <h3>{mode === 'ask' ? 'What would you like to know?' : 'What outcome should the business pursue?'}</h3>
                <p>{mode === 'ask'
                  ? 'Ask about company entities, capabilities, policies, or the evidence behind them.'
                  : 'Describe a goal in plain language. Quicksilver will propose actions, evaluate them, and save decisions for review.'}</p>
                <div className={styles.suggestions} aria-label={mode === 'ask' ? 'Example questions' : 'Example objectives'}>
                  {(mode === 'ask'
                    ? ['Which policies apply to an action?', 'What evidence supports this capability?']
                    : ['Reduce operating costs without lowering service quality.', 'Improve on-time delivery over the next quarter.']).map((example) => (
                    <button key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className={styles.exchange} key={message.id}>
                  <p className={styles.userMessage}>{message.question}</p>
                  {message.response && <QueryAnswer result={message.response} />}
                  {message.plan && <PlanAnswer result={message.plan} />}
                </article>
              ))
            )}
            {busy && <p className={styles.thinking} role="status">Searching company knowledge…</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>

          <footer className={styles.footer}>
            {tokenPresent ? (
              <form className={styles.form} onSubmit={ask}>
                <div className={styles.modeSwitch} role="group" aria-label="Chat mode">
                  <button type="button" aria-pressed={mode === 'ask'} disabled={busy} onClick={() => setMode('ask')}>Ask</button>
                  <button type="button" aria-pressed={mode === 'plan'} disabled={busy} onClick={() => setMode('plan')}>Plan</button>
                </div>
                <label className={styles.srOnly} htmlFor="qs-chat-question">{mode === 'plan' ? 'Describe a business objective' : 'Ask a company question'}</label>
                <input
                  id="qs-chat-question"
                  ref={inputRef}
                  value={question}
                  onChange={(event) => setQuestion(event.currentTarget.value)}
                  maxLength={2000}
                  placeholder={mode === 'plan' ? 'Describe an outcome to work toward…' : 'Ask Quicksilver…'}
                  autoComplete="off"
                  disabled={busy}
                />
                <button type="submit" disabled={busy || !question.trim()} aria-label="Send question">{busy ? '…' : 'Send'}</button>
              </form>
            ) : (
              <div className={styles.signInPrompt}>
                <p>Sign in to ask questions about company information.</p>
                <Link href="/planning#console-token" onClick={() => setOpen(false)}>Go to sign in</Link>
              </div>
            )}
            <p className={styles.footerHint}>{mode === 'ask' ? 'Ask · read-only · NQC-evaluated' : 'Plan · proposals require review and approval'}</p>
          </footer>
        </section>
      )}

      <button
        ref={triggerRef}
        type="button"
        className={styles.launcher}
        aria-expanded={open}
        aria-controls="qs-chat-panel"
        aria-haspopup="dialog"
        aria-label={open ? 'Close Quicksilver chat' : 'Open Quicksilver chat'}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.launcherMark} aria-hidden="true">NQ</span>
        <span>{open ? 'Close' : 'Ask Quicksilver'}</span>
        {!open && <span className={styles.launcherSpark} aria-hidden="true">✦</span>}
      </button>
    </>
  )
}

function PlanAnswer({ result }: { result: PlanChatResponse }) {
  const proposed = result.decisions.filter((item) => item.decisionDocId)
  return (
    <div className={styles.answer}>
      <p><strong>Plan prepared</strong> · {result.decomposition.objective}</p>
      {result.decomposition.successMetrics.length > 0 && <p className={styles.planMeta}>Success measures: {result.decomposition.successMetrics.join(' · ')}</p>}
      <ol className={styles.planActions}>
        {result.decisions.map((item, index) => (
          <li key={item.decisionDocId ?? `${index}-${item.action.description}`}>
            <strong>{item.action.description}</strong>
            <span>{item.safetyDecision ?? 'UNRESOLVED'} · {item.status ?? 'Not saved for review'}</span>
            {item.review?.missingEvidence?.length ? <small>Evidence to add: {item.review.missingEvidence.join('; ')}</small> : null}
          </li>
        ))}
      </ol>
      {result.decomposition.constraints.length > 0 && <details className={styles.references}><summary>Constraints used</summary><ul>{result.decomposition.constraints.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      {proposed.length > 0
        ? <Link className={styles.reviewPlan} href="/decisions">Review {proposed.length} saved {proposed.length === 1 ? 'decision' : 'decisions'} <span aria-hidden="true">→</span></Link>
        : <p>No decision was saved. Review the plan details and clarify the objective before trying again.</p>}
      <div className={styles.evaluation}><span>NQC-governed</span><span>Approval remains a separate human decision</span></div>
    </div>
  )
}

function QueryAnswer({ result }: { result: QueryResponse }) {
  return (
    <div className={styles.answer}>
      {result.supportingContext.length ? (
        <ul className={styles.contextList}>
          {result.supportingContext.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
        </ul>
      ) : <p>No supporting company context was found for this question.</p>}

      {(result.entities.length > 0 || result.capabilities.length > 0 || result.policies.length > 0) && (
        <details className={styles.references}>
          <summary>Related records</summary>
          {result.entities.map((entity) => (
            <p key={entity.id}><strong>{entity.name}</strong> <span>{entity.entityType}{entity.role ? ` · ${entity.role}` : ''}</span></p>
          ))}
          {result.capabilities.map((capability) => <p key={capability.id}><strong>{capability.name}</strong> <span>Capability · risk {capability.riskLevel}/5</span></p>)}
          {result.policies.map((policy) => <p key={policy.id}><strong>{policy.name}</strong> <span>Policy · {policy.scope}</span></p>)}
        </details>
      )}

      <div className={styles.evaluation}>
        <span>{Math.round(result.confidence * 100)}% confidence</span>
        {result.nqc && <span>NQC · {result.nqc.safetyDecision}</span>}
        {result.audit?.persisted && <span>Evaluation recorded</span>}
      </div>
    </div>
  )
}
