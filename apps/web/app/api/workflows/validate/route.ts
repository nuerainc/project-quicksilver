import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { z } from 'zod'
import { validateWorkflowGraph, type WorkflowGraph } from '@quicksilver/kernel'

const requestSchema = z.object({
  graph: z.record(z.string(), z.unknown()),
}).strict()

const MAX_REQUEST_BYTES = 256 * 1024

/** Stateless validation endpoint used by workflow authoring clients. */
export async function POST(request: Request) {
  // A principal with workflow:read (A-3). No model and no write, so no rate limit.
  const caller = await guardWebRoute(request, 'workflows/validate')
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status, headers: caller.headers })

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 })
  }

  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Expected an object containing a workflow graph.' }, { status: 400 })
  }

  const result = validateWorkflowGraph(parsed.data.graph as unknown as WorkflowGraph)
  return NextResponse.json({
    schemaVersion: 1,
    valid: result.valid,
    errors: result.errors,
    topologicalOrder: result.topologicalOrder,
  })
}
