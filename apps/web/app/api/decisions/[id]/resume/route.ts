/**
 * POST /api/decisions/[id]/resume — re-run the kernel's automatic step for a
 * decision that is still waiting in the process's initial state.
 *
 * Found in the Sep 22 live stress test: decisions planned while the process
 * definition was invalid are (correctly) held in `proposed`, but nothing ever
 * moved them on once the definition was fixed. This route re-evaluates the
 * definition's automatic transitions against the facts stored on the
 * decision (the kernel's recommendation, authorization and risk from plan
 * time). Older documents without a stored recommendation fall back to risk
 * alone, which can only route them to a human, never auto-approve them.
 *
 * Process engine only (QUICKSILVER_PROCESS_ENGINE=on).
 */

import { NextResponse } from 'next/server'
import { createClient } from '@sanity/client'
import { nextAutomaticTransition } from '@quicksilver/kernel'
import {
  KERNEL_ACTOR,
  commitTransition,
  factsFromDecision,
  invalidDefinitionBody,
  isRevisionConflict,
  loadDecisionLifecycle,
  processView,
} from '@/lib/process-engine'

function getSanityClient() {
  return createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    token: process.env.SANITY_AUTH_TOKEN,
  })
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'Missing decision id' }, { status: 400 })
  if (!process.env.NEXT_PUBLIC_SANITY_PROJECT_ID) {
    return NextResponse.json({ error: 'Sanity not configured' }, { status: 500 })
  }

  try {
    const client = getSanityClient()
    const lifecycle = await loadDecisionLifecycle(client)
    if (lifecycle.kind === 'invalid') return NextResponse.json(invalidDefinitionBody(lifecycle), { status: 409 })
    if (lifecycle.kind !== 'ready') {
      return NextResponse.json({ error: 'Resume needs the process engine (QUICKSILVER_PROCESS_ENGINE=on) and a seeded definition.' }, { status: 409 })
    }
    const { definition } = lifecycle

    const decision = await client.fetch<{
      _id: string
      _rev: string
      status: string
      kind?: string | null
      riskLevel?: number | null
      requiredApproval?: boolean | null
      kernelRecommendation?: string | null
      kernelAuthorized?: boolean | null
    } | null>(
      `*[_type == "decision" && _id == $id][0]{ _id, _rev, status, kind, riskLevel, requiredApproval, kernelRecommendation, kernelAuthorized }`,
      { id },
    )
    if (!decision) return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    if (decision.status !== definition.initialState) {
      return NextResponse.json(
        { error: `Only a decision still in "${definition.initialState}" can be resumed; this one is "${decision.status}".` },
        { status: 409 },
      )
    }

    const facts = factsFromDecision(decision)
    const step = nextAutomaticTransition(definition, decision.status, facts)
    if (!step) {
      return NextResponse.json(
        { error: 'No automatic transition applies to this decision yet.', process: processView(definition, decision.status, facts) },
        { status: 409 },
      )
    }

    const now = new Date().toISOString()
    try {
      await commitTransition(client, decision._id, decision._rev, definition, step, KERNEL_ACTOR, now)
    } catch (err) {
      if (isRevisionConflict(err)) {
        return NextResponse.json({ error: 'This decision changed while it was being resumed. Reload and try again.' }, { status: 409 })
      }
      throw err
    }
    return NextResponse.json({ id, status: step.to, process: processView(definition, step.to!, facts, step.transition?.id) })
  } catch (err) {
    console.error('[/api/decisions/[id]/resume]', err)
    return NextResponse.json({ error: 'Resume failed', detail: (err as Error).message }, { status: 500 })
  }
}
