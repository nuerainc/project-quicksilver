import type { AppFetch } from '@quicksilver/agent'

import { GET as whoami } from '@/app/api/whoami/route'
import { GET as listDecisions } from '@/app/api/decisions/route'
import { GET as getDecision } from '@/app/api/decisions/[id]/route'
import { GET as dashboardOverview } from '@/app/api/dashboard/overview/route'
import { GET as dashboardFinance } from '@/app/api/dashboard/finance/route'
import { GET as monitoringWorkflows } from '@/app/api/monitoring/workflows/route'
import { GET as monitoringTraces } from '@/app/api/monitoring/traces/route'
import { GET as agentCatalog } from '@/app/api/agents/catalog/route'
import { GET as entities } from '@/app/api/entities/route'
import { GET as workflowPublications } from '@/app/api/workflows/publications/route'
import { GET as workflowExecutions } from '@/app/api/workflows/executions/route'

type Handler = (request: Request) => Promise<Response>

/** The only pages of data the chat assistant can read. Each is a GET route that does its own permission check. */
const FIXED: Readonly<Record<string, Handler>> = Object.freeze({
  '/api/whoami': whoami,
  '/api/decisions': listDecisions,
  '/api/dashboard/overview': dashboardOverview,
  '/api/dashboard/finance': dashboardFinance,
  '/api/monitoring/workflows': monitoringWorkflows,
  '/api/monitoring/traces': monitoringTraces,
  '/api/agents/catalog': agentCatalog,
  '/api/entities': entities,
  '/api/workflows/publications': workflowPublications,
  '/api/workflows/executions': workflowExecutions,
})

const DECISION_DETAIL = /^\/api\/decisions\/([A-Za-z0-9._:-]{1,200})$/

/** The route that serves a path, or undefined. Exported so tests can check every assistant tool has one. */
export function appHandlerFor(pathname: string): ((request: Request) => Promise<Response>) | undefined {
  const fixed = FIXED[pathname]
  if (fixed) return fixed
  const match = DECISION_DETAIL.exec(pathname)
  if (match) return (request) => getDecision(request, { params: Promise.resolve({ id: match[1]! }) })
  return undefined
}

/**
 * Reads the app on behalf of the person who sent the chat message: runs the route's own
 * handler in this process with only that person's Authorization header and session cookie.
 * No network request is made, so there is no address to redirect, and the route's permission
 * check, audit record and data shaping apply exactly as they would for the person's browser.
 */
export function appFetchFor(request: Request): AppFetch {
  const headers = new Headers()
  for (const name of ['authorization', 'cookie']) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const origin = new URL(request.url).origin
  return async (path) => {
    const url = new URL(path, origin)
    const handler = appHandlerFor(url.pathname)
    if (!handler) return { status: 404, body: null }
    const response = await handler(new Request(url, { method: 'GET', headers }))
    return { status: response.status, body: await response.json().catch(() => null) }
  }
}
