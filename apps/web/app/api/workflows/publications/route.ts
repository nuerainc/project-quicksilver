import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'
import { listWorkflowPublications } from '@/lib/workflow-publication-store'

const workflowIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)

/** List immutable workflow versions and their publication audit for one tenant. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'workflows/publications')
  if (!caller.ok) return publicationRefusal(caller)
  const workflowId = workflowIdSchema.safeParse(new URL(request.url).searchParams.get('workflowId'))
  if (!workflowId.success) return NextResponse.json({ error: 'A valid workflowId query parameter is required.' }, { status: 400 })
  try {
    return NextResponse.json(await listWorkflowPublications(workflowId.data))
  } catch (error) {
    return publicationFailure(error, 'Could not load workflow versions.')
  }
}
