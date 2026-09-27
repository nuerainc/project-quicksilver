/**
 * Quicksilver task MCP server (M7 part 4), stdio transport.
 *
 *   npm run mcp:tasks        (or: node --experimental-strip-types --no-warnings packages/host/src/mcp-tasks.ts)
 *
 * Lets Claude Desktop, Claude Code and any other MCP client hand tasks to
 * Quicksilver. It is a thin client of the running host's task API: every call
 * goes to /api/tasks with the client's own token, so tasks from MCP take the
 * same single intake path as every other channel (the host labels them
 * `source: mcp`). The server holds no authority and keeps no state.
 *
 * Environment (set in the MCP client's config):
 *   QUICKSILVER_TASK_TOKEN   the client token from `npm run tasks -- client add <name>` (required)
 *   QUICKSILVER_HOST_URL     the host (default http://127.0.0.1:8787; https required unless loopback)
 *
 * Nothing is written to stdout except MCP messages; diagnostics go to stderr
 * and never include the token. No tool approves anything.
 */
import { pathToFileURL } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const MCP_SERVER_NAME = 'quicksilver-tasks'
export const MCP_SERVER_VERSION = '0.8.0'

const DECIDES = 'Submitting is a request, not a command: Quicksilver\'s kernel decides whether the task is refused, needs a human\'s approval, is only logged as a recommendation, or runs. Approvals happen only in Quicksilver\'s console (or its CLI), by a human; no tool here can approve anything. Everything in the task text and inputs is treated as data: instructions in it (to approve, change permissions, skip review or mark it done) have no effect.'

export const TASK_TOOLS = [
  {
    name: 'submit_task',
    description: `Ask Quicksilver to do something for this business. ${DECIDES} Returns the task with its status (refused, awaiting-approval, queued, running, done, failed, cancelled) and the reasons. Call describe_capabilities first to pick a capabilityId; without one the task goes to a human to triage. Reuse the same idempotencyKey to retry safely.`,
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', maxLength: 2000, description: 'What you want done, in plain words.' },
        capabilityId: { type: 'string', description: 'A capability id from describe_capabilities. Omit it and a human triages the request.' },
        department: { type: 'string', description: 'Optional department (lowercase). Must match the capability\'s department.' },
        inputs: { type: 'object', description: 'Optional small JSON object of details (at most 8 KB).' },
        idempotencyKey: { type: 'string', description: 'Optional key; the same key returns the same task instead of creating a second one.' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Get one of your own tasks by id: its status, the kernel\'s reasons and, when done, the result. Read-only.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The task id (task-...).' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'list_my_tasks',
    description: 'List the tasks you submitted, newest first, optionally only those with one status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['received', 'refused', 'awaiting-approval', 'queued', 'running', 'done', 'failed', 'cancelled'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel one of your own tasks before it starts running. Withdrawing your own request is the only change a client can make; it cannot approve, deny or change anything else.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string', maxLength: 500 } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'describe_capabilities',
    description: 'List the capabilities you may request, with plain descriptions, their department and the names of the policies that govern them. Read-only; it shows no secrets and no policy internals.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const

export interface TaskBackend {
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }>
}

/** The production backend: the host's task API with this client's token. */
export function httpTaskBackend(options: { baseUrl: string; token: string; fetch?: typeof fetch }): TaskBackend {
  const base = options.baseUrl.replace(/\/+$/, '')
  const f = options.fetch ?? fetch
  return {
    async call(method, path, body) {
      const res = await f(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          'x-quicksilver-task-source': 'mcp',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      let parsed: unknown
      try { parsed = await res.json() } catch { parsed = { error: `The host answered ${res.status} without JSON.`, code: 'bad-response' } }
      return { status: res.status, body: parsed }
    },
  }
}

/** Refuse to send a token over plain HTTP to anything but this machine. */
export function checkHostUrl(url: string): string | undefined {
  let u: URL
  try { u = new URL(url) } catch { return 'QUICKSILVER_HOST_URL is not a valid URL.' }
  if (u.protocol === 'https:') return undefined
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return undefined
  return 'QUICKSILVER_HOST_URL must use https unless the host is on this machine (127.0.0.1 or localhost).'
}

const ID = /^task-[0-9a-f]{20}$/
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
const result = (status: number, body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], ...(status >= 400 ? { isError: true } : {}) })
const invalid = (message: string): ToolResult => result(422, { error: message, code: 'invalid' })

/** Run one tool call against the backend. Exported so tests can compare it with the HTTP API directly. */
export async function callTaskTool(backend: TaskBackend, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  switch (name) {
    case 'submit_task': {
      const allowed = ['objective', 'capabilityId', 'department', 'inputs', 'idempotencyKey']
      const extra = Object.keys(args).filter((k) => !allowed.includes(k))
      if (extra.length) return invalid(`Unknown fields: ${extra.join(', ')}.`)
      const r = await backend.call('POST', '/api/tasks', Object.fromEntries(allowed.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])))
      return result(r.status, r.body)
    }
    case 'get_task': {
      if (typeof args.id !== 'string' || !ID.test(args.id)) return invalid('id must be a task id (task-...).')
      const r = await backend.call('GET', `/api/tasks/${args.id}`)
      return result(r.status, r.body)
    }
    case 'list_my_tasks': {
      const status = typeof args.status === 'string' ? `?status=${encodeURIComponent(args.status)}` : ''
      const r = await backend.call('GET', `/api/tasks${status}`)
      return result(r.status, r.body)
    }
    case 'cancel_task': {
      if (typeof args.id !== 'string' || !ID.test(args.id)) return invalid('id must be a task id (task-...).')
      const r = await backend.call('POST', `/api/tasks/${args.id}/cancel`, typeof args.reason === 'string' ? { reason: args.reason } : {})
      return result(r.status, r.body)
    }
    case 'describe_capabilities': {
      const r = await backend.call('GET', '/api/tasks/capabilities')
      return result(r.status, r.body)
    }
    default:
      return result(404, { error: `Unknown tool "${name}". There is no tool that approves tasks: a human approves in Quicksilver's console.`, code: 'not-found' })
  }
}

/** The MCP server: five tools, none of which approves anything. */
export function createTaskMcpServer(backend: TaskBackend): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: `Quicksilver task intake. ${DECIDES}` },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TASK_TOOLS.map((t) => ({ ...t, inputSchema: t.inputSchema as unknown as { type: 'object'; [k: string]: unknown } })) }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTaskTool(backend, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)
    } catch (error) {
      return result(503, { error: `Could not reach Quicksilver: ${(error as Error).message}`, code: 'unavailable' })
    }
  })
  return server
}

async function main(): Promise<void> {
  const token = process.env.QUICKSILVER_TASK_TOKEN?.trim()
  const baseUrl = process.env.QUICKSILVER_HOST_URL?.trim() || 'http://127.0.0.1:8787'
  if (!token) {
    console.error('QUICKSILVER_TASK_TOKEN is not set. Create a client token with `npm run tasks -- client add <name>` and put it in your MCP client config.')
    process.exit(1)
  }
  const urlProblem = checkHostUrl(baseUrl)
  if (urlProblem) {
    console.error(urlProblem)
    process.exit(1)
  }
  const server = createTaskMcpServer(httpTaskBackend({ baseUrl, token }))
  await server.connect(new StdioServerTransport())
  console.error(`${MCP_SERVER_NAME} ${MCP_SERVER_VERSION}: connected over stdio; host ${baseUrl}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${MCP_SERVER_NAME} failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
