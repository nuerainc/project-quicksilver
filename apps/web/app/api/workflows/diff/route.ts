import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'
import { compareWorkflowVersions } from '@/lib/workflow-publication-store'

const workflowIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)

/** Compare two verified immutable versions without exposing config values. */
export async function GET(request: Request) {
  const caller = guardWebRoute(request, 'workflows/diff')
  if (!caller.ok) return publicationRefusal(caller)
  const query = new URL(request.url).searchParams
  const workflowId = workflowIdSchema.safeParse(query.get('workflowId'))
  const fromVersion = z.coerce.number().int().positive().safeParse(query.get('from'))
  const toVersion = z.coerce.number().int().positive().safeParse(query.get('to'))
  if (!workflowId.success || !fromVersion.success || !toVersion.success) {
    return NextResponse.json({ error: 'Provide a valid workflowId and positive from/to versions.' }, { status: 400 })
  }
  try {
    return NextResponse.json(await compareWorkflowVersions(workflowId.data, fromVersion.data, toVersion.data))
  } catch (error) {
    return publicationFailure(error, 'Could not compare workflow versions.')
  }
}
