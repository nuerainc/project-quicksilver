import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationFailure, publicationRefusal } from '@/lib/workflow-publication-http'
import { evaluateTelemetryAlerts } from '@/lib/telemetry'
import { telemetryAlertThresholds } from '@/lib/telemetry-settings'
import { listRecentTraceSpans } from '@/lib/telemetry-store'

const limitSchema = z.coerce.number().int().min(1).max(500).default(200)

/** Read-only, tenant-scoped metadata traces. No prompt, output, tool args, or secrets are returned. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'monitoring/traces')
  if (!caller.ok) return publicationRefusal(caller)

  const parsed = limitSchema.safeParse(new URL(request.url).searchParams.get('limit') ?? undefined)
  if (!parsed.success) return NextResponse.json({ error: 'limit must be an integer from 1 to 500.' }, { status: 400 })

  try {
    const spans = await listRecentTraceSpans(parsed.data)
    const thresholds = telemetryAlertThresholds()
    const estimated = spans.filter((span) => span.kind === 'model' && span.estimatedCostUsd !== null)
    return NextResponse.json({
      spans,
      alerts: evaluateTelemetryAlerts(spans, thresholds),
      observedAt: thresholds.now,
      sampleLimit: parsed.data,
      windowMs: thresholds.windowMs,
      totals: {
        inputTokens: spans.reduce((sum, span) => sum + (span.inputTokens ?? 0), 0),
        outputTokens: spans.reduce((sum, span) => sum + (span.outputTokens ?? 0), 0),
        estimatedCostUsd: estimated.length ? estimated.reduce((sum, span) => sum + (span.estimatedCostUsd ?? 0), 0) : null,
      },
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return publicationFailure(error, 'Could not load telemetry traces.')
  }
}
