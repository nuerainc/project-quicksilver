import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardPublicationActor, publicationFailure, publicationRefusal, readPublicationBody } from '@/lib/workflow-publication-http'
import { createWorkflowDraft } from '@/lib/workflow-publication-store'
import { validateWorkflowGraph, type WorkflowGraph } from '@quicksilver/kernel'

const requestSchema = z.object({ graph: z.record(z.string(), z.unknown()) }).strict()

/** Save a validated immutable draft version in the dedicated Nuera Sanity project. */
export async function POST(request: Request) {
  const caller = guardPublicationActor(request, 'workflows/drafts')
  if (!caller.ok) return publicationRefusal(caller.refusal)
  const parsedBody = await readPublicationBody(request)
  if (!parsedBody.ok) return parsedBody.response
  const parsed = requestSchema.safeParse(parsedBody.body)
  if (!parsed.success) return NextResponse.json({ error: 'Expected an object containing a workflow graph.' }, { status: 400 })
  const graph = parsed.data.graph as unknown as WorkflowGraph
  const validation = validateWorkflowGraph(graph)
  if (!validation.valid) return NextResponse.json({ error: 'Workflow graph is invalid.', issues: validation.errors }, { status: 400 })
  try {
    return NextResponse.json(await createWorkflowDraft(graph, caller.actor), { status: 201 })
  } catch (error) {
    return publicationFailure(error, 'Could not save the workflow draft.')
  }
}
