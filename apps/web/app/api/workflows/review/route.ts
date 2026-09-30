import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardPublicationActor, publicationFailure, publicationRefusal, readPublicationBody } from '@/lib/workflow-publication-http'
import { reviewWorkflow } from '@/lib/workflow-publication-store'

const requestSchema = z.object({
  workflowId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  version: z.number().int().positive(),
  note: z.string().trim().min(10).max(500),
}).strict()

export async function POST(request: Request) {
  const caller = guardPublicationActor(request, 'workflows/review')
  if (!caller.ok) return publicationRefusal(caller.refusal)
  const body = await readPublicationBody(request)
  if (!body.ok) return body.response
  const parsed = requestSchema.safeParse(body.body)
  if (!parsed.success) return NextResponse.json({ error: 'A workflowId, positive version, and 10–500 character review rationale are required.' }, { status: 400 })
  try {
    return NextResponse.json(await reviewWorkflow(parsed.data.workflowId, parsed.data.version, caller.actor, parsed.data.note))
  } catch (error) {
    return publicationFailure(error, 'Could not review the workflow.')
  }
}
