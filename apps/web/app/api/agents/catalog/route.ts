import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { listAgentCatalog } from '@/lib/agent-catalog-store'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'

export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'agents/catalog')
  if (!caller.ok) return publicationRefusal(caller)
  try { return NextResponse.json(await listAgentCatalog(undefined, caller.principalId)) }
  catch (error) { return publicationFailure(error, 'Could not load the agent catalog.') }
}
