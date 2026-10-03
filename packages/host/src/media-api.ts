import { ASSET_ID_PATTERN, verifyMediaEvents, type MediaService } from './media.ts'

/**
 * P-025: media routes.
 *
 *   GET  /api/media                              decision:read: limits, spend, providers, provenance check
 *   POST /api/media/requests { kind, input, retentionDays?, experimentId?, provider? }
 *                                                provider or proposer: run one request
 *   GET  /api/media/assets                       decision:read: assets (never prompts or bytes)
 *   GET  /api/media/assets/:id                   decision:read: one asset's provenance
 *   GET  /api/media/assets/:id/content           decision:read: the bytes (text as text, the rest as base64)
 *   POST /api/media/assets/:id/delete { reason } a human provider: delete the bytes early
 *   POST /api/media/purge                        a human provider: delete the bytes of everything past its expiry
 *   GET  /api/media/provenance                   decision:read: the chain check and the latest events
 *
 * A request runs straight away within the cost cap (a person up to
 * `maxRequestUsd`, anything else up to `autoMaxUsd`, and never past the total
 * budget); over the cap it is refused and recorded, not queued. Moderation
 * runs before the provider is called and again on the output. Nothing here
 * transfers money: the cost is tracked against the media budget, and each
 * result carries a suggested ledger entry for a human to record.
 */

type Response = { status: number; body: unknown }

export interface MediaRouteContext {
  method: string
  parts: string[]
  principal: { id: string; kind: string }
  media: MediaService
  needRead(): Response | undefined
  needRequest(): Response | undefined
  humanOnly(what: string): Response | undefined
  bodyOf(): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }>
}

const RECENT_EVENTS = 200

export async function handleMediaRoute(ctx: MediaRouteContext): Promise<Response | undefined> {
  const { method, parts, principal, media } = ctx
  if (parts[1] !== 'media') return undefined

  // GET /api/media
  if (parts.length === 2 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    return { status: 200, body: await media.summary() }
  }

  // POST /api/media/requests
  if (parts.length === 3 && parts[2] === 'requests' && method === 'POST') {
    const denied = ctx.needRequest()
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const { kind, input, retentionDays, experimentId, provider } = body.value
    const out = await media.run({ kind, input, retentionDays, experimentId, provider }, { id: principal.id, kind: principal.kind })
    if (!out.ok) return { status: out.status, body: { error: out.error, ...(out.reasons ? { reasons: out.reasons } : {}), ...(out.blocked ? { blocked: true } : {}), ...(out.eventSeq !== undefined ? { eventSeq: out.eventSeq } : {}) } }
    return { status: 201, body: { asset: out.asset, costUsd: out.costUsd, ...(out.text !== undefined ? { text: out.text } : {}), ledgerSuggestion: out.ledgerSuggestion } }
  }

  // POST /api/media/purge
  if (parts.length === 3 && parts[2] === 'purge' && method === 'POST') {
    const denied = ctx.humanOnly('purges expired media')
    if (denied) return denied
    return { status: 200, body: { purged: await media.purgeExpired(principal.id) } }
  }

  // GET /api/media/provenance
  if (parts.length === 3 && parts[2] === 'provenance' && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const events = await media.events()
    return { status: 200, body: { ...verifyMediaEvents(events), count: events.length, events: events.slice(-RECENT_EVENTS) } }
  }

  if (parts[2] !== 'assets') return undefined

  // GET /api/media/assets
  if (parts.length === 3 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    return { status: 200, body: { assets: await media.assets() } }
  }

  if (parts.length < 4) return undefined
  const id = parts[3]!
  if (!ASSET_ID_PATTERN.test(id)) return { status: 404, body: { error: 'Unknown asset.' } }

  // GET /api/media/assets/:id
  if (parts.length === 4 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const asset = await media.asset(id)
    return asset ? { status: 200, body: { asset } } : { status: 404, body: { error: `No asset "${id}".` } }
  }

  // GET /api/media/assets/:id/content
  if (parts.length === 5 && parts[4] === 'content' && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const asset = await media.asset(id)
    if (!asset) return { status: 404, body: { error: `No asset "${id}".` } }
    const found = await media.content(id)
    if (!found) return { status: 410, body: { error: `The bytes of "${id}" are gone (${asset.status}); its provenance remains.`, asset } }
    const isText = asset.output.mediaType === 'text/plain'
    return { status: 200, body: { asset, mediaType: asset.output.mediaType, ...(isText ? { text: found.content.toString('utf8') } : { base64: found.content.toString('base64') }) } }
  }

  // POST /api/media/assets/:id/delete
  if (parts.length === 5 && parts[4] === 'delete' && method === 'POST') {
    const denied = ctx.humanOnly('deletes a media asset')
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const reason = body.value.reason
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return { status: 422, body: { error: 'reason must be 1 to 500 characters.' } }
    const asset = await media.deleteAsset(id, principal.id, reason.trim())
    return asset ? { status: 200, body: { asset } } : { status: 409, body: { error: `Asset "${id}" does not exist or its bytes are already gone.` } }
  }

  return undefined
}
