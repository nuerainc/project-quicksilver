/**
 * POST /api/query — run a single question against the Quicksilver query agent.
 *
 * Request body: { question: string }
 * Response:     QueryResult (see @quicksilver/agent)
 */

import { NextResponse } from 'next/server'
import { queryCompany } from '@quicksilver/agent'

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { question } = (body ?? {}) as { question?: string }
  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'Missing required field: question' }, { status: 400 })
  }

  try {
    const result = await queryCompany(question)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[/api/query]', err)
    return NextResponse.json(
      { error: 'Query failed', detail: (err as Error).message },
      { status: 500 },
    )
  }
}