import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAgentDraft } from '@/lib/agent-catalog-store'
import { guardPublicationActor, publicationFailure, publicationRefusal, readPublicationBody } from '@/lib/workflow-publication-http'

const manifestSchema = z.object({
  id: z.string().regex(/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/),
  version: z.number().int().positive(),
  authority: z.enum(['propose', 'review']),
  tasks: z.array(z.enum(['reasoning', 'code', 'bulk', 'planning', 'routing', 'tool', 'memory', 'hydraulic', 'evaluation', 'other'])).min(1).max(10),
  maximumImpact: z.enum(['low', 'moderate', 'high', 'critical']),
  requiresEvaluation: z.boolean(),
}).strict()
const requestSchema = z.object({ displayName: z.string().min(2).max(100), description: z.string().min(10).max(1000), manifest: manifestSchema }).strict()

export async function POST(request: Request) {
  const caller = await guardPublicationActor(request, 'agents/drafts')
  if (!caller.ok) return publicationRefusal(caller.refusal)
  const body = await readPublicationBody(request)
  if (!body.ok) return body.response
  const parsed = requestSchema.safeParse(body.body)
  if (!parsed.success) return NextResponse.json({ error: 'Expected a displayName, description, and valid agent manifest.', issues: parsed.error.issues }, { status: 400 })
  try { return NextResponse.json(await createAgentDraft(parsed.data, caller.actor), { status: 201 }) }
  catch (error) { return publicationFailure(error, 'Could not save the agent definition draft.') }
}
