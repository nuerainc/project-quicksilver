'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { authFailureMessage, consoleHeaders, resolveConsoleAccess } from '@/lib/console-auth'
import { chatRequest, type ChatMode } from '@/lib/chat-request'
import { businessAgentContext } from '@/lib/business-agent-context'
import type { BusinessAgentKey } from '@quicksilver/agent'
import type { BusinessAgentChoice } from '@/lib/business-agent-request'
import { usePathname } from 'next/navigation'
import { signInPageHref } from '@/lib/session-control'
import { AttentionList } from '@/components/attention-list'
import styles from './agent-chat-widget.module.css'

type QueryResponse = {
  answer: string
  links: Array<{ label: string; href: string }>
  showAttention?: boolean
  confidence: number
  toolsUsed?: string[]
  audit?: { persisted: boolean; evaluationRecordIds: string[] }
  nqc?: { reasoningScore: number; hallucinationRisk: string; brittleness: string; safetyDecision: string; issues: string[] }
}

type ChatMessage = {
  id: string
  question: string
  mode: ChatMode
  response?: QueryResponse
  plan?: PlanChatResponse
  agent?: BusinessAgentResponse
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

const BUSINESS_AGENTS: Array<{ key: BusinessAgentChoice; label: string }> = [
  { key: 'auto', label: 'Auto select' },
  { key: 'research', label: 'Research' }, { key: 'offer', label: 'Offer design' },
  { key: 'content', label: 'Content' }, { key: 'outreach', label: 'Outreach' },
  { key: 'sales', label: 'Sales' }, { key: 'fulfillment', label: 'Fulfillment' },
  { key: 'finance', label: 'Finance' },
]

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
  const [mode, setMode] = useState<ChatMode>('ask')
  // What the signed-in person may do, so a mode they cannot use says so before they type.
  const [permissions, setPermissions] = useState<string[] | null>(null)
  const cannotPlan = permissions !== null && !permissions.includes('decision:propose')
  const [agentKey, setAgentKey] = useState<BusinessAgentChoice>('auto')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      void resolveConsoleAccess(undefined, undefined, { withWhoami: true }).then((access) => { setTokenPresent(access.signedIn); setPermissions(access.whoami?.permissions ?? null) })
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    const openChat = () => { setOpen(true); setExpanded(true) }
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
      const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]')
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = question.trim()
    if (!text || busy) return
    const access = await resolveConsoleAccess()
    if (!access.signedIn) {
      setTokenPresent(false)
      setError(mode === 'plan'
        ? 'Sign in with a principal allowed to propose decisions before asking Quicksilver to plan work.'
        : 'Sign in with a principal that has decision:read to use the business chat.')
      return
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    const submittedMode = mode
    setMessages((current) => [...current, { id, question: text, mode: submittedMode }])
    setQuestion('')
    setError(null)
    setBusy(true)
    try {
      const context = submittedMode === 'agent'
        ? businessAgentContext(messages.map((message) => ({
            question: message.question,
            ...(message.agent ? { summary: message.agent.summary, safetyDecision: message.agent.nqc?.safetyDecision } : {}),
            ...(message.plan ? { summary: message.plan.reasoning } : {}),
            ...(message.response ? { summary: message.response.answer } : {}),
          })))
        : []
      const history = messages.flatMap((message) => message.response ? [{ question: message.question, answer: message.response.answer }] : [])
      const chat = chatRequest(submittedMode, text, agentKey, context, history)
      const path = chat.path
      const response = await fetch(path, {
        method: 'POST',
        headers: consoleHeaders(path, access.token, { 'content-type': 'application/json' }),
        body: JSON.stringify(chat.body),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 401) setTokenPresent(false)
        const route = submittedMode === 'plan' ? 'plan' : submittedMode === 'agent' ? 'agents/run' : 'chat'
        const message = authFailureMessage(response.status, route, payload.error, payload.retryAfterSeconds)
          ?? payload.error
          ?? payload.detail
          ?? 'Quicksilver could not answer that question.'
        throw new Error(message)
      }
      setMessages((current) => current.map((item) => item.id !== id ? item : submittedMode === 'plan'
        ? { ...item, plan: payload as PlanChatResponse }
        : submittedMode === 'agent'
          ? { ...item, agent: payload as BusinessAgentResponse }
          : { ...item, response: payload as QueryResponse }))
    } catch (cause) {
      setError((cause as Error).message || 'Quicksilver could not answer that question.')
    } finally {
      setBusy(false)
    }
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
                <p>Ask a question, explore a workspace, or describe work to plan</p>
              </div>
            </div>
            <button type="button" className={styles.expand} onClick={() => setExpanded((current) => !current)} aria-label={expanded ? 'Restore chat widget' : 'Expand chat to workspace'} title={expanded ? 'Restore chat widget' : 'Expand chat to workspace'}>{expanded ? '↙' : '↗'}</button>
            <button type="button" className={styles.close} onClick={close} aria-label="Close Quicksilver chat">×</button>
          </header>

          <div className={styles.safetyNote}>
            {mode === 'ask'
              ? 'Ask reads the app and your company data as you. It can explain and link, and it never approves or changes anything.'
              : mode === 'plan'
                ? 'Plan mode creates evaluated proposals for review. It never approves or executes actions.'
                : 'A business specialist researches and proposes work. It never approves or performs outside actions.'}
          </div>

          <div className={styles.chatWorkspace}>
          <div className={styles.thread} ref={threadRef} aria-label="Conversation" aria-live="polite">
            {messages.length === 0 ? (
              <div className={styles.welcome}>
                {tokenPresent && <AttentionList onNavigate={() => setExpanded(false)} />}
                <span aria-hidden="true">✦</span>
                <h3>{mode === 'ask' ? 'What would you like to know?' : mode === 'plan' ? 'What outcome should the business pursue?' : agentKey === 'auto' ? 'Put Quicksilver to work' : `Work with the ${BUSINESS_AGENTS.find((agent) => agent.key === agentKey)?.label ?? 'business'} agent`}</h3>
                <p>{mode === 'ask'
                  ? 'Ask what needs your approval, why a decision was refused, how workflows and spend are doing, what you can do, or who and what is in the company.'
                  : mode === 'plan'
                    ? 'Describe a goal in plain language. Quicksilver will propose actions, evaluate them, and save decisions for review.'
                    : 'Give a specialist a task in your own words. You’ll get recommendations, evidence gaps, and questions to resolve.'}</p>
                <div className={styles.suggestions} aria-label={mode === 'ask' ? 'Example questions' : 'Example objectives'}>
                  {(mode === 'ask'
                    ? ['What is waiting for my approval?', 'Why was the last plan refused, and what would change that?', 'How are my workflows doing?', 'What am I allowed to do here?']
                    : mode === 'plan'
                      ? ['Reduce operating costs without lowering service quality.', 'Improve on-time delivery over the next quarter.']
                      : ['Find evidence behind our current sales slowdown.', 'Draft a plan to reduce fulfillment delays.']).map((example) => (
                    <button key={example} type="button" onClick={() => setQuestion(example)}>{example}</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className={styles.exchange} key={message.id}>
                  <p className={styles.userMessage}>{message.question}</p>
                  {message.response && <QueryAnswer result={message.response} onNavigate={() => setExpanded(false)} />}
                  {message.plan && <PlanAnswer result={message.plan} />}
                  {message.agent && <BusinessAgentAnswer result={message.agent} />}
                </article>
              ))
            )}
            {busy && <p className={styles.thinking} role="status">{mode === 'ask' ? 'Looking through the app and company data…' : mode === 'plan' ? 'Preparing a plan for review…' : 'The specialist is working…'}</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}
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
                  ['/planning','Planning','Set outcomes and business context'],
                  ['/workflows','Workflows','Build and operate automations'],
                  ['/entities','Company data','Manage business records'],
                  ['/agents','Agents','Explore agent capabilities'],
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
                <div className={styles.modeSwitch} role="group" aria-label="Chat mode">
                  <button type="button" aria-pressed={mode === 'ask'} disabled={busy} onClick={() => setMode('ask')}>Ask</button>
                  <button type="button" aria-pressed={mode === 'plan'} disabled={busy || cannotPlan} aria-describedby={cannotPlan ? 'qs-plan-why' : undefined} onClick={() => setMode('plan')}>Plan</button>
                  <button type="button" aria-pressed={mode === 'agent'} disabled={busy} onClick={() => setMode('agent')}>Work</button>
                </div>
                {cannotPlan && <span id="qs-plan-why" className={styles.agentRouting}>Planning needs decision:propose, which your account does not have.</span>}
                {mode === 'agent' && <label className={styles.agentSelectLabel}>Specialist<select className={styles.agentSelect} aria-label="Choose business specialist" value={agentKey} disabled={busy} onChange={(event) => setAgentKey(event.currentTarget.value as BusinessAgentChoice)}>{BUSINESS_AGENTS.map((agent) => <option key={agent.key} value={agent.key}>{agent.label}</option>)}</select></label>}
                <label className={styles.srOnly} htmlFor="qs-chat-question">{mode === 'plan' || mode === 'agent' ? 'Describe work for Quicksilver' : 'Ask a company question'}</label>
                <input
                  id="qs-chat-question"
                  ref={inputRef}
                  value={question}
                  onChange={(event) => setQuestion(event.currentTarget.value)}
                  maxLength={2000}
                  placeholder={mode === 'plan' ? 'Describe an outcome to work toward…' : mode === 'agent' ? 'Describe what the specialist should work on…' : 'Ask Quicksilver…'}
                  autoComplete="off"
                  disabled={busy}
                />
                <button type="submit" disabled={busy || !question.trim()} aria-label="Send question">{busy ? '…' : 'Send'}</button>
              </form>
            ) : (
              <div className={styles.signInPrompt}>
            <p>Sign in to chat with Quicksilver about your business.</p>
                <Link href={signInPageHref(pathname)} onClick={() => setOpen(false)}>Sign in</Link>
              </div>
            )}
            <p className={styles.footerHint}>{mode === 'ask' ? 'Ask · read-only · NQC-evaluated' : mode === 'plan' ? 'Plan · proposals require review and approval' : 'Work · specialist proposals only · external actions stay gated'}</p>
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
