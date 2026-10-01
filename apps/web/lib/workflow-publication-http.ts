import { NextResponse } from 'next/server'
import type { Permission } from '@quicksilver/kernel'
import { checkRouteCaller } from './nqc-approval.ts'
import { guardWebRoute, type GuardRefusal, type WebRoute } from './route-guard.ts'
import { WorkflowPublicationFault, type PublicationActor } from './workflow-publication-store.ts'
import { AgentCatalogFault } from './agent-catalog-contract.ts'

const MAX_BODY_BYTES = 256 * 1024

export type PublicationMutationRoute = Extract<WebRoute,
  'workflows/drafts' | 'workflows/drafts/submit' | 'workflows/review' | 'workflows/publish' | 'workflows/rollback'
  | 'agents/drafts' | 'agents/drafts/submit' | 'agents/review' | 'agents/publish' | 'agents/rollback'>

export type PublicationActorResult =
  | { ok: true; actor: PublicationActor }
  | { ok: false; refusal: GuardRefusal }

export async function guardPublicationActor(request: Request, route: PublicationMutationRoute): Promise<PublicationActorResult> {
  const guarded = await guardWebRoute(request, route)
  if (!guarded.ok) return { ok: false, refusal: guarded }

  // The route guard preserves the authenticated kind for bearer and browser
  // sessions alike, so lifecycle writes keep the human-only boundary.
  if (!guarded.principalKind) return { ok: false, refusal: { ok: false, status: 503, body: { error: 'Authenticated principal kind is unavailable.', code: 'principal-kind-unavailable' } } }
  return { ok: true, actor: { id: guarded.principalId, kind: guarded.principalKind } }
}

export async function readPublicationBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) {
    return { ok: false, response: NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 }) }
  }
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: NextResponse.json({ error: 'Request body exceeds the 256 KiB limit.' }, { status: 413 }) }
  }
  try {
    return { ok: true, body: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 }) }
  }
}

export function requireMutationPermission(request: Request, permission: Permission): GuardRefusal | null {
  const caller = checkRouteCaller([permission], request.headers.get('authorization'), process.env)
  if (caller.ok) return null
  const code = caller.status === 401 ? 'unauthenticated' : caller.status === 403 ? 'forbidden' : 'unavailable'
  return { ok: false, status: caller.status, body: { error: caller.reason, code } }
}

export function publicationRefusal(refusal: GuardRefusal): Response {
  return NextResponse.json(refusal.body, { status: refusal.status, headers: refusal.headers })
}

export function publicationFailure(error: unknown, fallback: string): Response {
  if (error instanceof AgentCatalogFault) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof WorkflowPublicationFault) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  // Keep provider, database, and infrastructure details in server logs only.
  console.error('[workflow-publication] operation failed', error instanceof Error ? error.name : 'UnknownError')
  return NextResponse.json({ error: fallback }, { status: 500 })
}
