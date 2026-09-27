import type { Principal } from '@quicksilver/kernel/identity'

import { taskView, TaskError, type TaskService, type TaskSource } from './tasks.ts'

/**
 * The governed task interface on the host (M7 part 4). Every route calls the
 * one intake (TaskService); none of them grants anything by itself.
 *
 *   POST /api/tasks                { objective, capabilityId?, department?, inputs?, idempotencyKey? }   task:submit
 *   GET  /api/tasks?status=        own tasks (task:read-own) or all (task:read)
 *   GET  /api/tasks/capabilities   capability ids and plain descriptions a client may request
 *   GET  /api/tasks/:id            own task (task:read-own) or any (task:read); another client's task is a 404
 *   POST /api/tasks/:id/cancel     { reason? }   the submitter, or the founder; only before it runs
 *   POST /api/tasks/:id/approve    { reason? }   a human with task:approve who did not submit it
 *   POST /api/tasks/:id/deny       { reason }    a human with task:approve
 *
 * Errors are always `{ error, code }` with a matching HTTP status. The MCP
 * server (mcp-tasks.ts) calls these same routes with the header
 * `X-Quicksilver-Task-Source: mcp`; that header only labels the channel and
 * can name `api` or `mcp`, nothing else.
 */

export interface TaskApiContext {
  method: string
  parts: string[]
  query: URLSearchParams
  principal: Principal
  /** The channel label: `mcp` when the MCP server calls, else `api`. */
  source: Extract<TaskSource, 'api' | 'mcp'>
  readBody: () => Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }>
}

type Response = { status: number; body: unknown; headers?: Record<string, string> }

export async function handleTaskRoute(ctx: TaskApiContext, service: TaskService): Promise<Response | undefined> {
  const { method, parts, principal } = ctx
  if (parts[1] !== 'tasks') return undefined
  try {
    const full = () => service.readScope(principal) === 'all'

    if (parts.length === 2 && method === 'POST') {
      const body = await ctx.readBody()
      if (!body.ok) return { status: body.status, body: { error: body.error, code: 'invalid' } }
      const b = body.value as Record<string, unknown>
      const { task, deduplicated } = await service.submit({
        source: ctx.source,
        principal,
        objective: b.objective,
        capabilityId: b.capabilityId,
        department: b.department,
        inputs: b.inputs,
        idempotencyKey: b.idempotencyKey,
      })
      return { status: deduplicated ? 200 : 201, body: { task: taskView(task, full()), deduplicated } }
    }
    if (parts.length === 2 && method === 'GET') {
      const status = ctx.query.get('status') ?? undefined
      const tasks = await service.list(principal, status ? { status } : {})
      const limit = Math.min(200, Math.max(1, Number(ctx.query.get('limit') ?? 50) || 50))
      return { status: 200, body: { tasks: tasks.slice(0, limit).map((t) => taskView(t, full())) } }
    }
    if (parts.length === 3 && parts[2] === 'capabilities' && method === 'GET') {
      return { status: 200, body: { capabilities: service.capabilities(principal) } }
    }
    if (parts.length === 3 && method === 'GET') {
      return { status: 200, body: { task: taskView(await service.get(principal, parts[2]!), full()) } }
    }
    if (parts.length === 4 && method === 'POST' && ['cancel', 'approve', 'deny'].includes(parts[3]!)) {
      const body = await ctx.readBody()
      if (!body.ok) return { status: body.status, body: { error: body.error, code: 'invalid' } }
      const reason = (body.value as { reason?: unknown }).reason
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) return { status: 422, body: { error: 'reason must be text of at most 500 characters.', code: 'invalid' } }
      const id = parts[2]!
      const task = parts[3] === 'cancel' ? await service.cancel(principal, id, reason)
        : parts[3] === 'approve' ? await service.approve(principal, id, reason)
          : await service.deny(principal, id, reason)
      return { status: 200, body: { task: taskView(task, full()) } }
    }
    return { status: 404, body: { error: 'Not found.', code: 'not-found' } }
  } catch (error) {
    if (error instanceof TaskError) {
      return {
        status: error.status,
        body: { error: error.message, code: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) },
        ...(error.retryAfterSeconds ? { headers: { 'retry-after': String(error.retryAfterSeconds) } } : {}),
      }
    }
    throw error
  }
}
