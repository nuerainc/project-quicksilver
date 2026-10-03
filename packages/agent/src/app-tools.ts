import { tool } from 'ai'
import { z } from 'zod'
import { ToolRegistry, type EvaluatorToolCall } from '@quicksilver/kernel'

/**
 * Read-only tools that let the chat assistant look at the app the way the person
 * asking can: decisions, the overview, workflow activity, traces, the agent catalog,
 * company records, and what the person is allowed to do.
 *
 * Every tool reads one fixed GET route of the app, through `fetchApp`, which the web
 * layer backs with the caller's own credentials. So the assistant sees exactly what the
 * person would see, the route's permission check decides, and a refusal comes back as
 * "not available to you, you need X" rather than as data. Nothing here can write: there
 * is no tool for approving, executing, publishing or changing anything. Those stay
 * buttons on the pages, pressed by a person.
 */

export interface AppFetchResult { status: number; body: unknown }
export type AppFetch = (path: string) => Promise<AppFetchResult>

const MAX_CHARS = 12_000
const ID = /^[A-Za-z0-9._:-]{1,200}$/
const WORKFLOW_ID = /^[a-zA-Z0-9._:%-]{1,256}$/
const DECISION_STATUSES = ['proposed', 'awaiting-approval', 'approved', 'executed', 'failed', 'rejected', 'rollback-proposed', 'rolled-back'] as const

/** What the model gets back: the data, or the reason it is not available to this person. */
export function shapeAppResult(result: AppFetchResult): unknown {
  const body = result.body as { error?: unknown; needs?: unknown } | null
  if (result.status === 200) {
    const text = JSON.stringify(result.body ?? null)
    return text.length > MAX_CHARS ? { truncated: true, note: `Shown the first ${MAX_CHARS} characters of ${text.length}.`, text: text.slice(0, MAX_CHARS) } : result.body
  }
  if (result.status === 401) return { available: false, reason: 'The person is not signed in.' }
  if (result.status === 403) {
    return { available: false, reason: typeof body?.error === 'string' ? body.error : 'This person is not permitted to see this.', ...(Array.isArray(body?.needs) ? { needs: body.needs } : {}) }
  }
  if (result.status === 404) return { available: false, reason: 'Not found.' }
  return { available: false, reason: `The app could not load this (status ${result.status}).` }
}

interface Spec<S extends z.ZodTypeAny> {
  name: string
  description: string
  schema: S
  path: (input: z.infer<S>) => string
  /** An input that is valid, so tests can check every tool's path is served by a route. */
  sample: z.infer<S>
}

const spec = <S extends z.ZodTypeAny>(s: Spec<S>) => s

const SPECS = [
  spec({
    name: 'get_attention',
    description: 'What needs the person right now: approvals they can give, things to execute, refused plans with the near-miss, failed runs, reviews and alerts, each with the actions they may take. When you use this to answer "what needs me?", set showAttention so the app shows the live list with its buttons under your answer; do not list the items yourself.',
    schema: z.object({}),
    path: () => '/api/inbox',
    sample: {},
  }),
  spec({ name: 'get_my_access', description: 'Who the person asking is and which actions they are permitted to take in the app. Use it to explain why something is or is not available to them.', schema: z.object({}), path: () => '/api/whoami', sample: {} }),
  spec({
    name: 'list_decisions',
    description: 'Recent decisions (proposed actions) with status, risk and whether approval is required. Filter by status to find what is waiting for approval.',
    schema: z.object({ status: z.enum(DECISION_STATUSES).nullable(), limit: z.number().int().min(1).max(25).nullable() }),
    path: ({ status, limit }) => `/api/decisions?${new URLSearchParams({ ...(status ? { status } : {}), limit: String(limit ?? 10) })}`,
    sample: { status: 'awaiting-approval' as const, limit: 5 },
  }),
  spec({
    name: 'get_decision',
    description: 'One decision in full: the action, policy checks, risk, who asked, who approved, the reviewer notes, the kernel\'s explanation of why (risk arithmetic and what would change the answer), and its history.',
    schema: z.object({ id: z.string().regex(ID) }),
    path: ({ id }) => `/api/decisions/${encodeURIComponent(id)}`,
    sample: { id: 'decision-plan-1-0' },
  }),
  spec({ name: 'get_business_overview', description: 'Decision counts, recent decisions, recorded business metrics and experiments.', schema: z.object({}), path: () => '/api/dashboard/overview', sample: {} }),
  spec({ name: 'get_finance_summary', description: 'Recorded money-ledger totals (revenue, spend, compute, refunds). Not a bank balance.', schema: z.object({}), path: () => '/api/dashboard/finance', sample: {} }),
  spec({ name: 'get_workflow_activity', description: 'Recent workflow runs across all workflows with their status.', schema: z.object({}), path: () => '/api/monitoring/workflows', sample: {} }),
  spec({ name: 'get_trace_summary', description: 'Model, tool and agent call traces, alerts, token and cost totals.', schema: z.object({}), path: () => '/api/monitoring/traces', sample: {} }),
  spec({ name: 'list_agent_catalog', description: 'The governed agent definitions: published, in review and draft, with versions.', schema: z.object({}), path: () => '/api/agents/catalog', sample: {} }),
  spec({ name: 'list_company_entities', description: 'The company directory: people, agents and teams with their capabilities.', schema: z.object({}), path: () => '/api/entities', sample: {} }),
  spec({ name: 'list_workflow_versions', description: 'Saved and published versions of one workflow.', schema: z.object({ workflowId: z.string().regex(WORKFLOW_ID) }), path: ({ workflowId }) => `/api/workflows/publications?workflowId=${encodeURIComponent(workflowId)}`, sample: { workflowId: 'wf-1' } }),
  spec({ name: 'get_workflow_runs', description: 'Recent runs of one workflow.', schema: z.object({ workflowId: z.string().regex(WORKFLOW_ID) }), path: ({ workflowId }) => `/api/workflows/executions?workflowId=${encodeURIComponent(workflowId)}&limit=10`, sample: { workflowId: 'wf-1' } }),
]

export const APP_TOOL_NAMES: readonly string[] = SPECS.map((s) => s.name)

/** One valid request path per tool, for tests that check every tool is served by a route. */
export const APP_TOOL_SAMPLE_PATHS: readonly string[] = SPECS.map((s) => (s.path as (input: unknown) => string)(s.sample))

/** The AI SDK tools, each logged for the NQC evaluation and checked against a kernel registry of read-only tools. */
export function buildAppTools(fetchApp: AppFetch, callLog: EvaluatorToolCall[] = []): Record<string, unknown> {
  const registry = new ToolRegistry()
  const tools: Record<string, unknown> = {}
  for (const s of SPECS) {
    registry.register({ id: s.name, contractVersion: 1, provider: 'quicksilver-app', description: s.description, access: 'read-only', requiresApproval: false })
    tools[s.name] = tool({
      description: s.description,
      inputSchema: s.schema as z.ZodType,
      execute: async (input: unknown) => {
        const startedAt = Date.now()
        const validation = registry.validate({ name: s.name, arguments: input })
        if (!validation.allowed) {
          callLog.push({ name: s.name, succeeded: false, durationMs: 0 })
          throw new Error(`NQC Kernel denied tool call "${s.name}": ${validation.reasons.join(' ')}`)
        }
        try {
          const result = shapeAppResult(await fetchApp(s.path(input as never)))
          callLog.push({ name: s.name, succeeded: true, durationMs: Math.max(0, Date.now() - startedAt) })
          return result
        } catch (error) {
          callLog.push({ name: s.name, succeeded: false, durationMs: Math.max(0, Date.now() - startedAt) })
          throw error
        }
      },
    })
  }
  return tools
}

/** Paths the assistant may link to. Anything else is dropped before it reaches the person. */
const LINK_PATTERNS: readonly RegExp[] = [
  /^\/$/, /^\/decisions(?:\?id=[A-Za-z0-9._:-]{1,200})?$/, /^\/workflows$/, /^\/monitoring$/, /^\/monitoring\/traces$/,
  /^\/agents$/, /^\/entities(?:\?search=[^\s&#]{1,100})?$/,
]
export function isAllowedAppLink(href: string): boolean {
  return LINK_PATTERNS.some((pattern) => pattern.test(href))
}
