'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { authFailureMessage, consoleHeaders, readConsoleToken } from '@/lib/console-auth'
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
  response?: QueryResponse
}

export function AgentChatWidget() {
  const [open, setOpen] = useState(false)
  const [tokenPresent, setTokenPresent] = useState(false)
  const [question, setQuestion] = useState('')
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
      setError('Sign in with a principal that has decision:read to ask company questions.')
      return
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    setMessages((current) => [...current, { id, question: text }])
    setQuestion('')
    setError(null)
    setBusy(true)
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: consoleHeaders('/api/query', token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ question: text }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401) setTokenPresent(false)
        const message = authFailureMessage(response.status, 'query', payload.error, payload.retryAfterSeconds)
          ?? payload.error
          ?? payload.detail
          ?? 'Quicksilver could not answer that question.'
        throw new Error(message)
      }
      setMessages((current) => current.map((item) => item.id === id ? { ...item, response: payload as QueryResponse } : item))
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
                <p>Company knowledge · read only</p>
              </div>
            </div>
            <button type="button" className={styles.close} onClick={close} aria-label="Close Quicksilver chat">×</button>
          </header>

          <div className={styles.safetyNote}>
            Answers use the company model and NQC evaluation. Chat cannot approve or execute actions.
          </div>

          <div className={styles.thread} ref={threadRef} aria-label="Conversation" aria-live="polite">
            {messages.length === 0 ? (
              <div className={styles.welcome}>
                <span aria-hidden="true">✦</span>
                <h3>What would you like to know?</h3>
                <p>Ask about company entities, capabilities, policies, or the evidence behind them.</p>
                <div className={styles.suggestions} aria-label="Example questions">
                  {['Which policies apply to an action?', 'What evidence supports this capability?'].map((example) => (
                    <button key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className={styles.exchange} key={message.id}>
                  <p className={styles.userMessage}>{message.question}</p>
                  {message.response && <QueryAnswer result={message.response} />}
                </article>
              ))
            )}
            {busy && <p className={styles.thinking} role="status">Searching company knowledge…</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>

          <footer className={styles.footer}>
            {tokenPresent ? (
              <form className={styles.form} onSubmit={ask}>
                <label className={styles.srOnly} htmlFor="qs-chat-question">Ask a company question</label>
                <input
                  id="qs-chat-question"
                  ref={inputRef}
                  value={question}
                  onChange={(event) => setQuestion(event.currentTarget.value)}
                  maxLength={2000}
                  placeholder="Ask Quicksilver…"
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
            <p className={styles.footerHint}>Read-only · NQC-evaluated · Not a substitute for an approval</p>
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
