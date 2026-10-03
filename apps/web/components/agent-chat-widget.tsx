'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { authFailureMessage, consoleHeaders, resolveConsoleAccess } from '@/lib/console-auth'
import { chatTurnRequest, offerRequest, pageHint } from '@/lib/chat-request'
import { loadChat, saveChat } from '@/lib/chat-store'
import type { AssistantOffer, BusinessAgentKey } from '@quicksilver/agent'
import { usePathname } from 'next/navigation'
import { signInPageHref } from '@/lib/session-control'
import { AttentionList } from '@/components/attention-list'
import { inboxStore } from '@/components/use-inbox'
import styles from './agent-chat-widget.module.css'

type QueryResponse = {
  answer: string
  links: Array<{ label: string; href: string }>
  showAttention?: boolean
  offers?: AssistantOffer[]
  confidence: number
  toolsUsed?: string[]
  audit?: { persisted: boolean; evaluationRecordIds: string[] }
  nqc?: { reasoningScore: number; hallucinationRisk: string; brittleness: string; safetyDecision: string; issues: string[] }
}

type WorkflowRunResponse = { status: string; error?: string; publishedWorkflow?: { version: number }; steps: Array<{ nodeId: string; status: string; detail?: string }> }

/** What came of pressing an offer card, kept beside the card so the conversation reads in order. */
type OfferResult = { plan?: PlanChatResponse; agent?: BusinessAgentResponse; workflow?: WorkflowRunResponse }

type ChatMessage = {
  id: string
  question: string
  response?: QueryResponse
  /** Results of offer cards pressed on this message, by offer index. */
  offerResults?: Record<number, OfferResult>
}

type BusinessAgentResponse = {
  agent: { key: BusinessAgentKey; name: string; specialty: string }
  routing: { mode: 'explicit' | 'keyword' | 'fallback'; reason: string }
  summary: string
  recommendations: Array<{ proposal: string; evidenceIds: string[]; confidence: number; impact: string }>
  unknowns: string[]
  questions: string[]
  externalEffects: string[]
  actionPolicy: 'proposal-only'
  nqc?: { safetyDecision: string; reasoningScore: number; issues: string[] }
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
  const pathname = usePathname() ?? '/'
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [tokenPresent, setTokenPresent] = useState(false)
  const [question, setQuestion] = useState('')
  // What the signed-in person may do, so a card they cannot use says so before they press it.
  const [permissions, setPermissions] = useState<string[] | null>(null)
  const cannotPlan = permissions !== null && !permissions.includes('decision:propose')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastAsked = useRef<string | null>(null)
  const restored = useRef(false)

  // The conversation lasts for this tab: closing the panel or reloading keeps it.
  useEffect(() => { setMessages(loadChat<ChatMessage>()); restored.current = true }, [])
  useEffect(() => { if (restored.current) saveChat(messages) }, [messages])

  useEffect(() => {
    if (open) {
      void resolveConsoleAccess(undefined, undefined, { withWhoami: true }).then((access) => { setTokenPresent(access.signedIn); setPermissions(access.whoami?.permissions ?? null) })
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    // Other pages open the chat with a sentence already in the box ("Try again with this change").
    const openChat = (event: Event) => {
      setOpen(true); setExpanded(true)
      const prefill = (event as CustomEvent<{ prefill?: string } | undefined>).detail?.prefill
      if (typeof prefill === 'string' && prefill.trim()) setQuestion(prefill.slice(0, 2_000))
    }
    window.addEventListener('quicksilver:open-chat', openChat)
    return () => window.removeEventListener('quicksilver:open-chat', openChat)
  }, [])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'auto' })
  }, [messages, busy, error])

  function close() {
    setOpen(false)
    setExpanded(false)
    triggerRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (expanded) setExpanded(false)
      else close()
      return
    }
    if (expanded && event.key === 'Tab') {
      const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]')
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }

  function stop() { abortRef.current?.abort() }

  async function send(text: string) {
    if (!text || busy) return
    const access = await resolveConsoleAccess()
    if (!access.signedIn) {
      setTokenPresent(false)
      setError('Sign in with a principal that has decision:read to use the business chat.')
      return
    }
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    lastAsked.current = text
    setMessages((current) => [...current, { id, question: text }])
    setQuestion('')
    setError(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const history = messages.flatMap((message) => message.response ? [{ question: message.question, answer: message.response.answer }] : [])
      const chat = chatTurnRequest(text, history, pageHint(pathname, window.location.search))
      const response = await fetch(chat.path, {
        method: 'POST',
        headers: consoleHeaders(chat.path, access.token, { 'content-type': 'application/json' }),
        body: JSON.stringify(chat.body),
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401) setTokenPresent(false)
        throw new Error(authFailureMessage(response.status, 'chat', payload.error, payload.retryAfterSeconds) ?? payload.error ?? payload.detail ?? 'Quicksilver could not answer that question.')
      }
      setMessages((current) => current.map((item) => item.id === id ? { ...item, response: payload as QueryResponse } : item))
    } catch (cause) {
      // A stopped turn leaves no half answer: the question is removed so it can be asked again.
      if ((cause as Error).name === 'AbortError') {
        setMessages((current) => current.filter((item) => item.id !== id))
        setQuestion(text)
        setError('Stopped. Your question is back in the box.')
      } else setError((cause as Error).message || 'Quicksilver could not answer that question.')
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  function ask(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void send(question.trim()) }

  /** Pressing a card is the person's act: the app's own route runs as them, with the text they saw and may have edited. */
  async function runOffer(messageId: string, index: number, offer: AssistantOffer, text: string): Promise<string | null> {
    const access = await resolveConsoleAccess()
    if (!access.signedIn) { setTokenPresent(false); return 'Sign in again to continue.' }
    const request = offerRequest(offer, text)
    try {
      const response = await fetch(request.path, {
        method: 'POST',
        headers: consoleHeaders(request.path, access.token, { 'content-type': 'application/json' }),
        body: JSON.stringify(request.body),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) return authFailureMessage(response.status, offer.kind === 'plan' ? 'plan' : offer.kind === 'specialist' ? 'agents/run' : 'workflows/run', payload.error, payload.retryAfterSeconds) ?? payload.error ?? payload.detail ?? 'That did not work.'
      const result: OfferResult = offer.kind === 'plan' ? { plan: payload as PlanChatResponse } : offer.kind === 'specialist' ? { agent: payload as BusinessAgentResponse } : { workflow: payload as WorkflowRunResponse }
      setMessages((current) => current.map((item) => item.id === messageId ? { ...item, offerResults: { ...item.offerResults, [index]: result } } : item))
      if (offer.kind === 'plan') inboxStore().refresh()
      return null
    } catch { return 'Could not reach the server.' }
  }

  return (
    <>
      {open && expanded && <div className={styles.expandedBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false) }} />}
      {open && (
        <section id="qs-chat-panel" className={`${styles.panel}${expanded ? ` ${styles.panelExpanded}` : ''}`} role="dialog" aria-modal={expanded || undefined} aria-labelledby="qs-chat-title" onKeyDown={handleKeyDown}>
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.avatar} aria-hidden="true">NQ</span>
              <div>
                <h2 id="qs-chat-title">Chat with Quicksilver</h2>
                <p>Ask anything, or describe work you want done</p>
              </div>
            </div>
            {messages.length > 0 && <button type="button" className={styles.expand} onClick={() => { setMessages([]); setError(null) }} aria-label="Start a new conversation" title="Start a new conversation">+</button>}
            <button type="button" className={styles.expand} onClick={() => setExpanded((current) => !current)} aria-label={expanded ? 'Restore chat widget' : 'Expand chat to workspace'} title={expanded ? 'Restore chat widget' : 'Expand chat to workspace'}>{expanded ? '↙' : '↗'}</button>
            <button type="button" className={styles.close} onClick={close} aria-label="Close Quicksilver chat">×</button>
          </header>

          <div className={styles.safetyNote}>
            Quicksilver reads the app and your company data as you. It never approves or changes anything: when you ask for work it offers a card, and nothing happens until you press the card&rsquo;s button.
          </div>

          <div className={styles.chatWorkspace}>
          <div className={styles.thread} ref={threadRef} aria-label="Conversation" aria-live="polite">
            {messages.length === 0 ? (
              <div className={styles.welcome}>
                {tokenPresent && <AttentionList onNavigate={() => setExpanded(false)} />}
                <span aria-hidden="true">✦</span>
                <h3>What would you like to know or get done?</h3>
                <p>Ask what needs your approval, why a decision was refused, or how spend and workflows are doing. Describe an outcome and Quicksilver will offer to plan it or ask a specialist.</p>
                <div className={styles.suggestions} aria-label="Examples">
                  {['What is waiting for my approval?', 'Why was the last plan refused, and what would change that?', 'Reduce operating costs without lowering service quality.', 'Find evidence behind our current sales slowdown.'].map((example) => (
                    <button key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className={styles.exchange} key={message.id}>
                  <p className={styles.userMessage}>{message.question}</p>
                  {message.response && <QueryAnswer result={message.response} onNavigate={() => setExpanded(false)} />}
                  {message.response?.offers?.map((offer, index) => {
                    const done = message.offerResults?.[index]
                    return done
                      ? <OfferOutcome key={index} result={done} />
                      : <OfferCard key={index} offer={offer} blockedReason={offer.kind === 'plan' && cannotPlan ? 'Planning needs decision:propose, which your account does not have.' : null} onRun={(text) => runOffer(message.id, index, offer, text)} />
                  })}
                </article>
              ))
            )}
            {busy && <p className={styles.thinking} role="status">Looking through the app and company data…</p>}
            {error && <p className={styles.error} role="alert">{error}{lastAsked.current && !busy && !error.startsWith('Stopped') && <> <button type="button" className={styles.retry} onClick={() => void send(lastAsked.current ?? '')}>Try again</button></>}</p>}
          </div>
          {expanded && (
            <aside className={styles.contextRail} aria-label="Business workspaces">
              <p className={styles.contextEyebrow}>Your workspace</p>
              <h3>Go deeper when you need to</h3>
              <p className={styles.contextIntro}>Chat stays available while you open the detailed tools.</p>
              <nav aria-label="Business areas">
                {[
                  ['/','Overview','Company health and priorities'],
                  ['/decisions','Decisions','Review proposals and approvals'],
                  ['/workflows','Workflows','Build and publish automations'],
                  ['/entities','Company data','Manage business records'],
                  ['/agents','Agents','Review the agent catalog'],
                  ['/monitoring','Monitoring','Runs, activity, and alerts'],
                  ['/monitoring/traces','Traces & alerts','Model calls, cost, and alerts'],
                ].map(([href, label, description]) => (
                  <Link key={href} href={href} className={styles.contextLink} onClick={() => setExpanded(false)}>
                    <span>{label}</span><small>{description}</small>
                  </Link>
                ))}
              </nav>
            </aside>
          )}
          </div>

          <footer className={styles.footer}>
            {tokenPresent ? (
              <form className={styles.form} onSubmit={ask}>
                <label className={styles.srOnly} htmlFor="qs-chat-question">Ask a question or describe work for Quicksilver</label>
                <input
                  id="qs-chat-question"
                  ref={inputRef}
                  value={question}
                  onChange={(event) => setQuestion(event.currentTarget.value)}
                  maxLength={2000}
                  placeholder="Ask, or describe what you want done…"
                  autoComplete="off"
                  disabled={busy}
                />
                {busy
                  ? <button type="button" onClick={stop} aria-label="Stop answering">Stop</button>
                  : <button type="submit" disabled={!question.trim()} aria-label="Send question">Send</button>}
              </form>
            ) : (
              <div className={styles.signInPrompt}>
            <p>Sign in to chat with Quicksilver about your business.</p>
                <Link href={signInPageHref(pathname)} onClick={() => setOpen(false)}>Sign in</Link>
              </div>
            )}
            <p className={styles.footerHint}>Read-only · NQC-evaluated · work is offered as a card you press</p>
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
        <span>{open ? 'Close' : 'Chat'}</span>
        {!open && <span className={styles.launcherSpark} aria-hidden="true">✦</span>}
      </button>
    </>
  )
}

const OFFER_COPY: Record<AssistantOffer['kind'], { title: (offer: AssistantOffer) => string; button: string; note: string }> = {
  plan: { title: () => 'Create this plan?', button: 'Create plan', note: 'Quicksilver drafts evaluated proposals and saves them as decisions. Nothing is approved or run.' },
  specialist: { title: (offer) => `Ask the ${offer.kind === 'specialist' && offer.agentKey !== 'auto' ? offer.agentKey : 'best-fit'} specialist?`, button: 'Ask specialist', note: 'The specialist researches and proposes. It cannot act outside the app.' },
  workflow: { title: (offer) => `Run workflow ${offer.kind === 'workflow' ? offer.workflowId : ''}?`, button: 'Run workflow', note: 'Runs the active published version, read-only, as you.' },
}

/** A model-suggested action, shown in full and editable. It is only a suggestion until the person presses the button. */
function OfferCard({ offer, blockedReason, onRun }: { offer: AssistantOffer; blockedReason: string | null; onRun: (text: string) => Promise<string | null> }) {
  const initial = offer.kind === 'workflow' ? offer.input : offer.objective
  const [text, setText] = useState(initial)
  const [running, setRunning] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const copy = OFFER_COPY[offer.kind]
  const tooShort = text.trim().length < 3
  return (
    <div className={styles.offer}>
      <p className={styles.offerTitle}><strong>{copy.title(offer)}</strong></p>
      <label className={styles.srOnly} htmlFor={`offer-${initial.slice(0, 12)}`}>Edit before you press the button</label>
      <textarea id={`offer-${initial.slice(0, 12)}`} className={styles.offerText} value={text} maxLength={2000} rows={3} disabled={running} onChange={(event) => setText(event.currentTarget.value)} />
      <p className={styles.agentRouting}>{copy.note}</p>
      {blockedReason && <p className={styles.agentRouting}>{blockedReason}</p>}
      {problem && <p className={styles.error} role="alert">{problem}</p>}
      <button type="button" className={styles.offerButton} disabled={running || tooShort || !!blockedReason} onClick={async () => { setRunning(true); setProblem(null); const failed = await onRun(text.trim()); setRunning(false); if (failed) setProblem(failed) }}>{running ? 'Working…' : copy.button}</button>
    </div>
  )
}

function OfferOutcome({ result }: { result: OfferResult }) {
  if (result.plan) return <PlanAnswer result={result.plan} />
  if (result.agent) return <BusinessAgentAnswer result={result.agent} />
  const run = result.workflow
  if (!run) return null
  return (
    <div className={styles.answer}>
      <p><strong>Workflow run</strong> · {run.status}{run.publishedWorkflow ? ` · published v${run.publishedWorkflow.version}` : ''}</p>
      {run.error && <p className={styles.error}>{run.error}</p>}
      <ul className={styles.planActions}>{run.steps.map((step) => <li key={step.nodeId}><strong>{step.nodeId}</strong><span>{step.status}</span>{step.detail && <small>{step.detail}</small>}</li>)}</ul>
      <Link className={styles.reviewPlan} href="/monitoring">See it in monitoring <span aria-hidden="true">→</span></Link>
    </div>
  )
}

function BusinessAgentAnswer({ result }: { result: BusinessAgentResponse }) {
  return <div className={styles.answer}>
    <p><strong>{result.agent.name}</strong><span className={styles.agentSpecialty}> · {result.agent.specialty}</span></p>
    <p className={styles.agentRouting}>{result.routing.mode === 'explicit' ? 'Selected specialist' : result.routing.mode === 'keyword' ? 'Auto-selected from your request' : 'General request routed to Research'} · {result.routing.reason}</p>
    <p className={styles.agentSummary}>{result.summary}</p>
    {result.recommendations.length > 0 && <ol className={styles.planActions}>{result.recommendations.map((item, index) => <li key={`${index}-${item.proposal}`}><strong>{item.proposal}</strong><span>{item.impact} impact · {Math.round(item.confidence * 100)}% confidence</span>{item.evidenceIds.length > 0 && <small>Evidence: {item.evidenceIds.join(', ')}</small>}</li>)}</ol>}
    {(result.unknowns.length > 0 || result.questions.length > 0 || result.externalEffects.length > 0) && <details className={styles.references}><summary>Open questions and effects to review</summary>{result.unknowns.map((item, i) => <p key={`u-${i}`}><strong>Unknown:</strong> {item}</p>)}{result.questions.map((item, i) => <p key={`q-${i}`}><strong>Question:</strong> {item}</p>)}{result.externalEffects.map((item, i) => <p key={`e-${i}`}><strong>Would require approval:</strong> {item}</p>)}</details>}
    <div className={styles.evaluation}><span>Proposal only</span>{result.nqc && <span>NQC · {result.nqc.safetyDecision}</span>}</div>
  </div>
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

const TOOL_LABELS: Record<string, string> = {
  get_my_access: 'your access', list_decisions: 'decisions', get_decision: 'a decision', get_business_overview: 'the overview',
  get_finance_summary: 'the money ledger', get_workflow_activity: 'workflow activity', get_trace_summary: 'traces',
  list_agent_catalog: 'the agent catalog', list_company_entities: 'company records', list_workflow_versions: 'workflow versions', get_workflow_runs: 'workflow runs',
}

/** Only pages of this app: the server already filters, and this is the second check. */
const isLocalLink = (href: string) => href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/')

function QueryAnswer({ result, onNavigate }: { result: QueryResponse; onNavigate?: () => void }) {
  const paragraphs = result.answer.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const links = (result.links ?? []).filter((link) => isLocalLink(link.href))
  const looked = [...new Set((result.toolsUsed ?? []).map((name) => TOOL_LABELS[name] ?? 'company data'))]
  return (
    <div className={styles.answer}>
      {paragraphs.length ? paragraphs.map((part, index) => <p key={`${index}-${part.slice(0, 20)}`}>{part}</p>) : <p>No answer was found for this question.</p>}
      {result.showAttention && <AttentionList onNavigate={onNavigate} />}
      {links.length > 0 && (
        <p className={styles.chatLinks}>{links.map((link) => <Link key={link.href} className={styles.reviewPlan} href={link.href}>{link.label} <span aria-hidden="true">→</span></Link>)}</p>
      )}
      {looked.length > 0 && <details className={styles.references}><summary>What I looked at</summary><p>{looked.join(', ')}</p></details>}
      <div className={styles.evaluation}>
        <span>{Math.round(result.confidence * 100)}% confidence</span>
        {result.nqc && <span>NQC · {result.nqc.safetyDecision}</span>}
        {result.audit?.persisted && <span>Evaluation recorded</span>}
      </div>
    </div>
  )
}
