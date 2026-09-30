import { NextResponse } from 'next/server'
import { z } from 'zod'
import { listAgentDefinitions } from '@/lib/agent-catalog-store'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'
import { guardWebRoute } from '@/lib/route-guard'

const idSchema = z.string().regex(/^nuera-quicksilver:[a-z][a-z0-9-]{0,62}$/)
export async function GET(request: Request) {
  const caller = guardWebRoute(request, 'agents/definitions')
  if (!caller.ok) return publicationRefusal(caller)
  const id = new URL(request.url).searchParams.get('agentId')
  if (!idSchema.safeParse(id).success) return NextResponse.json({ error: 'A namespaced agentId is required.' }, { status: 400 })
  try { return NextResponse.json(await listAgentDefinitions(id!)) }
  catch (error) { return publicationFailure(error, 'Could not load agent versions.') }
}
