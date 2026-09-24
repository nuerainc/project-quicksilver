import { NextResponse } from 'next/server'
import { z } from 'zod'
import { executeWorkflowGraph, type WorkflowGraph } from '@quicksilver/kernel'

const requestSchema = z.object({
  graph: z.record(z.string(), z.unknown()),
}).strict()
const MAX_REQUEST_BYTES = 256 * 1024

/** Safe preview only: no models, tools, approvals, or external effects are invoked. */
export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REQUEST_BYTES) return NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 })

  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 })

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Expected a workflow graph and optional condition outcomes.' }, { status: 400 })

  const result = await executeWorkflowGraph(parsed.data.graph as unknown as WorkflowGraph, { simulation: true }, {
    runAgent: async (node) => ({ simulation: true, agentId: node.config?.agentId, note: 'No model was called; this is a placeholder result.' }),
    validateTool: async () => ({ allowed: false, reasons: ['Simulation never validates or dispatches a real tool.'] }),
    runTool: async () => { throw new Error('Tool execution is disabled in simulation.') },
    evaluate: async () => ({ safetyDecision: 'SKIPPED', simulated: true, issues: ['Simulation does not perform a live Quicksilver Engine evaluation.'] }),
  })

  return NextResponse.json({ mode: 'simulation', externalEffectsEnabled: false, ...result })
}
