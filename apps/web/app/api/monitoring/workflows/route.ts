import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'
import { listRecentWorkflowExecutions } from '@/lib/workflow-publication-store'

const limitSchema = z.coerce.number().int().min(1).max(100).default(100)

/** Returns only the latest tenant-scoped workflow execution metadata. */
export async function GET(request: Request) {
  const caller = guardWebRoute(request, 'monitoring/workflows')
  if (!caller.ok) return publicationRefusal(caller)

  const limit = limitSchema.safeParse(new URL(request.url).searchParams.get('limit') ?? undefined)
  if (!limit.success) return NextResponse.json({ error: 'limit must be an integer from 1 to 100.' }, { status: 400 })

  try {
    const executions = await listRecentWorkflowExecutions(limit.data)
    return NextResponse.json({ executions, observedAt: Date.now(), sampleLimit: limit.data })
  } catch (error) {
    return publicationFailure(error, 'Could not load workflow monitoring data.')
  }
}
