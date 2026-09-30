import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'
import { listWorkflowExecutions } from '@/lib/workflow-publication-store'

const workflowIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)

/** List metadata-only execution history for one tenant and workflow. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'workflows/executions')
  if (!caller.ok) return publicationRefusal(caller)
  const url = new URL(request.url)
  const workflowId = workflowIdSchema.safeParse(url.searchParams.get('workflowId'))
  const requestedLimit = Number(url.searchParams.get('limit') ?? '25')
  if (!workflowId.success || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return NextResponse.json({ error: 'Provide a valid workflowId and a limit from 1 to 100.' }, { status: 400 })
  }
  try {
    return NextResponse.json({ executions: await listWorkflowExecutions(workflowId.data, requestedLimit) })
  } catch (error) {
    return publicationFailure(error, 'Could not load workflow execution history.')
  }
}
