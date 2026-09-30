import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAgentRollbackDraft } from '@/lib/agent-catalog-store'
import { guardPublicationActor, publicationFailure, publicationRefusal, readPublicationBody } from '@/lib/workflow-publication-http'

const requestSchema = z.object({ agentId: z.string().regex(/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/), sourceVersion: z.number().int().positive() }).strict()

export async function POST(request: Request) {
  const caller = await guardPublicationActor(request, 'agents/rollback')
  if (!caller.ok) return publicationRefusal(caller.refusal)
  const body = await readPublicationBody(request)
  if (!body.ok) return body.response
  const parsed = requestSchema.safeParse(body.body)
  if (!parsed.success) return NextResponse.json({ error: 'A namespaced agentId and positive sourceVersion are required.' }, { status: 400 })
  try { return NextResponse.json(await createAgentRollbackDraft(parsed.data.agentId, parsed.data.sourceVersion, caller.actor), { status: 201 }) }
  catch (error) { return publicationFailure(error, 'Could not create an agent rollback draft.') }
}
