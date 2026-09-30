import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardPublicationActor, publicationFailure, publicationRefusal, readPublicationBody } from '@/lib/workflow-publication-http'
import { rollbackWorkflow } from '@/lib/workflow-publication-store'

const requestSchema = z.object({
  workflowId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  version: z.number().int().positive(),
}).strict()

export async function POST(request: Request) {
  const caller = guardPublicationActor(request, 'workflows/rollback')
  if (!caller.ok) return publicationRefusal(caller.refusal)
  const body = await readPublicationBody(request)
  if (!body.ok) return body.response
  const parsed = requestSchema.safeParse(body.body)
  if (!parsed.success) return NextResponse.json({ error: 'A workflowId and positive version are required.' }, { status: 400 })
  try {
    return NextResponse.json(await rollbackWorkflow(parsed.data.workflowId, parsed.data.version, caller.actor))
  } catch (error) {
    return publicationFailure(error, 'Could not roll back the workflow.')
  }
}
