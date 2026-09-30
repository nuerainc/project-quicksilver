import { NextResponse } from 'next/server'
import { z } from 'zod'
import { reviewAgentDefinition } from '@/lib/agent-catalog-store'
import { guardPublicationActor, publicationFailure, publicationRefusal, readPublicationBody } from '@/lib/workflow-publication-http'
const requestSchema = z.object({ agentId: z.string().regex(/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/), version: z.number().int().positive(), note: z.string().trim().min(10).max(500) }).strict()
export async function POST(request: Request) {
  const caller = guardPublicationActor(request, 'agents/review')
  if (!caller.ok) return publicationRefusal(caller.refusal)
  const body = await readPublicationBody(request); if (!body.ok) return body.response
  const parsed = requestSchema.safeParse(body.body)
  if (!parsed.success) return NextResponse.json({ error: 'An agentId, positive version, and 10–500 character review rationale are required.' }, { status: 400 })
  try { return NextResponse.json(await reviewAgentDefinition(parsed.data.agentId, parsed.data.version, caller.actor, parsed.data.note)) }
  catch (error) { return publicationFailure(error, 'Could not review the agent definition.') }
}
