import type { Experiment } from '@quicksilver/kernel/playbooks/economics'

import type { GenesisApiDeps } from './genesis-api.ts'
import { contentStatus } from './genesis-reviews.ts'
import {
  buildFiles,
  HostingStoreError,
  releaseDigest,
  REVIEWED_TYPES,
  SITE_ID,
  type HostedSite,
  type HostingAdapter,
  type HostingStore,
  type SiteEvent,
  type SiteRelease,
} from './hosting.ts'

/**
 * P-026: experiment hosting routes.
 *
 *   GET  /api/hosting/sites                                  decision:read
 *   POST /api/hosting/sites { id, title, experimentId? }     provider or proposer: create a site
 *   GET  /api/hosting/sites/:id                              decision:read: releases and the event history
 *   POST /api/hosting/sites/:id/releases { files, note? }    provider or proposer: stage an immutable release
 *   POST /api/hosting/sites/:id/releases/:version/publish    a human provider: make it live
 *   POST /api/hosting/sites/:id/teardown { reason }          a human provider: take the site down for good
 *   POST /api/hosting/reconcile                              a human provider: tear down sites whose experiment ended
 *
 * Staging is a record, not a deploy. Publishing is the one step that touches
 * the deploy adapter, and it is humans-only and gated: every HTML and text
 * file needs a passing review of its exact content under the run's WAES
 * policy (the same gate as any customer-facing text), the reviewer cannot be
 * whoever staged it, and a site tied to an experiment can only go live while
 * that experiment has not ended. When the experiment ends the site comes down
 * (see `teardownSitesForExperiment`, which the host calls from the Genesis
 * routes), and `reconcile` catches any that were missed.
 *
 * Nothing here charges, spends or moves money. Hosting cost belongs in the
 * ledger as compute, recorded through the usual money route.
 */

type Response = { status: number; body: unknown }

export interface HostingApiDeps {
  store: HostingStore
  adapter: HostingAdapter
}

export interface HostingRouteContext {
  method: string
  parts: string[]
  principal: { id: string; kind: string }
  tenantId: string
  genesis: GenesisApiDeps
  hosting: HostingApiDeps
  needRead(): Response | undefined
  needPropose(): Response | undefined
  humanOnly(what: string): Response | undefined
  bodyOf(): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }>
  now(): Date
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>
}

const SYSTEM = { id: 'kernel', kind: 'service' as const }
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const lockKey = (tenantId: string) => `hosting:${tenantId}`
/** An experiment that has not ended: still being prepared, running or held. */
const ACTIVE = new Set<Experiment['status']>(['draft', 'running', 'held'])
const EXP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

function view(site: HostedSite) {
  const { releases, ...rest } = site
  return { ...rest, releases: releases.map((r) => ({ ...r, fileCount: r.files.length })) }
}

async function experimentStatus(genesis: GenesisApiDeps, id: string): Promise<Experiment['status'] | 'unknown'> {
  const state = await genesis.store.load(genesis.config)
  return state.experiments.find((e) => e.definition.id === id)?.status ?? 'unknown'
}

function event(by: string, at: Date, action: SiteEvent['action'], extra: Partial<SiteEvent> = {}): SiteEvent {
  return { at: at.toISOString(), by, action, ...extra }
}

/** Take a site down: adapter first (so a failure leaves the record honest), then the record. */
async function takeDown(deps: HostingApiDeps, tenantId: string, site: HostedSite, by: string, reason: string, at: Date): Promise<HostedSite> {
  await deps.adapter.teardown({ siteId: site.id, tenantId })
  const iso = at.toISOString()
  const releases = site.releases.map((r): SiteRelease => (r.status === 'published' ? { ...r, status: 'torn-down', endedAt: iso } : r))
  const next: HostedSite = {
    ...site,
    status: 'torn-down',
    releases,
    tornDownBy: by,
    tornDownAt: iso,
    tornDownReason: reason,
    events: [...site.events, event(by, at, 'site-torn-down', { ...(site.liveVersion !== undefined ? { version: site.liveVersion } : {}), detail: reason })],
  }
  delete (next as { liveVersion?: number }).liveVersion
  await deps.store.putSite(next)
  return next
}

/**
 * Tear down every active site tied to `experimentId`. The host calls this when
 * an experiment ends. A failure on one site is reported, not thrown, so one
 * stuck deploy target cannot stop the others or the Genesis route that called it.
 */
export async function teardownSitesForExperiment(
  deps: HostingApiDeps,
  tenantId: string,
  experimentId: string,
  reason: string,
  now: () => Date,
  withLock: HostingRouteContext['withLock'],
): Promise<{ tornDown: string[]; failed: Array<{ siteId: string; error: string }> }> {
  return withLock(lockKey(tenantId), async () => {
    const out = { tornDown: [] as string[], failed: [] as Array<{ siteId: string; error: string }> }
    for (const site of await deps.store.listSites()) {
      if (site.status !== 'active' || site.experimentId !== experimentId) continue
      try {
        await takeDown(deps, tenantId, site, SYSTEM.id, reason, now())
        out.tornDown.push(site.id)
      } catch (error) {
        out.failed.push({ siteId: site.id, error: (error as Error).message })
      }
    }
    return out
  })
}

export async function handleHostingRoute(ctx: HostingRouteContext): Promise<Response | undefined> {
  const { method, parts, principal, tenantId, genesis, hosting } = ctx
  if (parts[1] !== 'hosting') return undefined
  const { store, adapter } = hosting
  const runId = genesis.config.runId
  const lock = <T>(fn: () => Promise<T>) => ctx.withLock(lockKey(tenantId), fn)
  const notFound = (id: string): Response => ({ status: 404, body: { error: `No site "${id}".` } })

  if (parts[2] === 'reconcile') return handleHostingReconcile(ctx)

  // GET /api/hosting/sites
  if (parts.length === 3 && parts[2] === 'sites' && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    return { status: 200, body: { adapter: adapter.name, sites: (await store.listSites()).map(view) } }
  }

  // POST /api/hosting/sites
  if (parts.length === 3 && parts[2] === 'sites' && method === 'POST') {
    const denied = ctx.needPropose()
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const { id, title, experimentId } = body.value
    if (typeof id !== 'string' || !SITE_ID.test(id)) return { status: 422, body: { error: 'id must be lowercase letters, digits and "-", up to 63 characters.' } }
    if (!str(title, 200)) return { status: 422, body: { error: 'title must be 1 to 200 characters.' } }
    if (experimentId !== undefined && (typeof experimentId !== 'string' || !EXP_ID.test(experimentId))) return { status: 422, body: { error: 'experimentId is invalid.' } }
    if (typeof experimentId === 'string') {
      const status = await experimentStatus(genesis, experimentId)
      if (status === 'unknown') return { status: 422, body: { error: `No experiment "${experimentId}" in this run.` } }
      if (!ACTIVE.has(status)) return { status: 409, body: { error: `Experiment "${experimentId}" is ${status}; a new site cannot be tied to an ended experiment.` } }
    }
    return lock(async () => {
      if (await store.getSite(id)) return { status: 409, body: { error: `Site "${id}" already exists.` } }
      const at = ctx.now()
      const site: HostedSite = {
        id,
        title: title.trim(),
        ...(typeof experimentId === 'string' ? { experimentId } : {}),
        status: 'active',
        createdBy: principal.id,
        createdAt: at.toISOString(),
        releases: [],
        events: [event(principal.id, at, 'site-created')],
      }
      await store.putSite(site)
      return { status: 201, body: { site: view(site), deployed: false } }
    })
  }

  if (parts[2] !== 'sites' || parts.length < 4) return undefined
  const siteId = parts[3]!
  if (!SITE_ID.test(siteId)) return notFound(siteId)

  // GET /api/hosting/sites/:id
  if (parts.length === 4 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const site = await store.getSite(siteId)
    return site ? { status: 200, body: { site: view(site), adapter: adapter.name } } : notFound(siteId)
  }

  // POST /api/hosting/sites/:id/releases
  if (parts.length === 5 && parts[4] === 'releases' && method === 'POST') {
    const denied = ctx.needPropose()
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    if (body.value.note !== undefined && !str(body.value.note, 500)) return { status: 422, body: { error: 'note must be 1 to 500 characters.' } }
    const built = buildFiles(body.value.files)
    if (!built.ok) return { status: 422, body: { error: built.error, deployed: false } }
    return lock(async () => {
      const site = await store.getSite(siteId)
      if (!site) return notFound(siteId)
      if (site.status !== 'active') return { status: 409, body: { error: `Site "${siteId}" is torn down; make a new site.` } }
      const at = ctx.now()
      const version = site.releases.length + 1
      const files = built.files.map(({ content: _content, ...meta }) => meta)
      const release: SiteRelease = {
        version,
        status: 'staged',
        files,
        digest: releaseDigest(files),
        createdBy: principal.id,
        createdAt: at.toISOString(),
        ...(typeof body.value.note === 'string' ? { note: body.value.note.trim() } : {}),
      }
      await store.putFiles(siteId, version, built.files)
      await store.putSite({ ...site, releases: [...site.releases, release], events: [...site.events, event(principal.id, at, 'release-staged', { version, detail: release.digest })] })
      // Tell the proposer which pages still need a review before a human can publish.
      const reviews = await genesis.store.loadReviews(runId)
      const reviewed = built.files.filter((f) => REVIEWED_TYPES.has(f.contentType)).map((f) => {
        const st = contentStatus(genesis.config, reviews, f.content.toString('utf8'), principal.id)
        return { path: f.path, contentDigest: st.contentDigest, passes: st.passes, ...(st.reason ? { reason: st.reason } : {}) }
      })
      return { status: 201, body: { release, reviews: reviewed, deployed: false, note: 'Staged only. A human publishes it, and every HTML and text file needs a passing review of its exact content first.' } }
    })
  }

  // POST /api/hosting/sites/:id/releases/:version/publish
  if (parts.length === 7 && parts[4] === 'releases' && parts[6] === 'publish' && method === 'POST') {
    const denied = ctx.humanOnly('publishes a hosted page')
    if (denied) return denied
    const version = Number(parts[5])
    if (!Number.isInteger(version) || version < 1) return { status: 404, body: { error: 'Unknown release.' } }
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    return lock(async () => {
      const site = await store.getSite(siteId)
      if (!site) return notFound(siteId)
      if (site.status !== 'active') return { status: 409, body: { error: `Site "${siteId}" is torn down.`, deployed: false } }
      const release = site.releases[version - 1]
      if (!release) return { status: 404, body: { error: `Site "${siteId}" has no release ${version}.` } }
      if (release.status === 'published') return { status: 409, body: { error: `Release ${version} is already live.`, deployed: false } }
      if (site.experimentId) {
        const status = await experimentStatus(genesis, site.experimentId)
        if (status !== 'unknown' && !ACTIVE.has(status)) return { status: 409, body: { error: `Experiment "${site.experimentId}" is ${status}; its site cannot go live.`, deployed: false } }
      }
      const files = await store.getFiles(siteId, version)
      if (!files.length || releaseDigest(files) !== release.digest) return { status: 409, body: { error: 'The stored files do not match the release digest; nothing was published.', deployed: false } }
      const reviews = await genesis.store.loadReviews(runId)
      const blocked = files.filter((f) => REVIEWED_TYPES.has(f.contentType)).flatMap((f) => {
        const st = contentStatus(genesis.config, reviews, f.content.toString('utf8'), release.createdBy)
        return st.passes ? [] : [{ path: f.path, contentDigest: st.contentDigest, reason: st.reason }]
      })
      if (blocked.length) return { status: 409, body: { error: 'Some customer-facing text has no passing review of its exact content.', blocked, deployed: false } }

      let location: string
      try { location = (await adapter.publish({ siteId, tenantId }, release, files)).location } catch (error) {
        return { status: 502, body: { error: `The deploy adapter failed: ${(error as Error).message}. Nothing changed.`, deployed: false } }
      }
      const at = ctx.now()
      const iso = at.toISOString()
      const previous = site.liveVersion
      const events: SiteEvent[] = [...site.events]
      const releases = site.releases.map((r): SiteRelease => {
        if (r.version === previous) {
          events.push(event(principal.id, at, 'release-superseded', { version: r.version }))
          return { ...r, status: 'superseded', endedAt: iso }
        }
        return r
      })
      const rollback = release.status === 'superseded'
      releases[version - 1] = { ...release, status: 'published', publishedBy: principal.id, publishedAt: iso, ...(rollback && previous !== undefined ? { rollbackOf: previous } : {}) }
      delete (releases[version - 1] as { endedAt?: string }).endedAt
      events.push(event(principal.id, at, 'release-published', { version, detail: rollback ? 'rollback' : release.digest }))
      const next: HostedSite = { ...site, releases, liveVersion: version, events }
      await store.putSite(next)
      return { status: 200, body: { site: view(next), location, adapter: adapter.name, deployed: true } }
    })
  }

  // POST /api/hosting/sites/:id/teardown
  if (parts.length === 5 && parts[4] === 'teardown' && method === 'POST') {
    const denied = ctx.humanOnly('tears down a hosted site')
    if (denied) return denied
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    if (!str(body.value.reason, 500)) return { status: 422, body: { error: 'reason must be 1 to 500 characters.' } }
    const reason = body.value.reason.trim()
    return lock(async () => {
      const site = await store.getSite(siteId)
      if (!site) return notFound(siteId)
      if (site.status === 'torn-down') return { status: 409, body: { error: `Site "${siteId}" is already torn down.` } }
      try {
        const next = await takeDown(hosting, tenantId, site, principal.id, reason, ctx.now())
        return { status: 200, body: { site: view(next), adapter: adapter.name } }
      } catch (error) {
        if (error instanceof HostingStoreError) throw error
        return { status: 502, body: { error: `The deploy adapter failed: ${(error as Error).message}. The site is still recorded as active; try again.` } }
      }
    })
  }

  return undefined
}

/** POST /api/hosting/reconcile: tear down active sites whose experiment has ended. Separate because it is not under a site id. */
export async function handleHostingReconcile(ctx: HostingRouteContext): Promise<Response | undefined> {
  const { method, parts, genesis, hosting, tenantId } = ctx
  if (!(parts.length === 3 && parts[1] === 'hosting' && parts[2] === 'reconcile' && method === 'POST')) return undefined
  const denied = ctx.humanOnly('reconciles hosted sites')
  if (denied) return denied
  const checked: string[] = []
  const tornDown: string[] = []
  const failed: Array<{ siteId: string; error: string }> = []
  await ctx.withLock(lockKey(tenantId), async () => {
    for (const site of await hosting.store.listSites()) {
      if (site.status !== 'active' || !site.experimentId) continue
      checked.push(site.id)
      const status = await experimentStatus(genesis, site.experimentId)
      if (status === 'unknown' || ACTIVE.has(status)) continue
      try {
        await takeDown(hosting, tenantId, site, SYSTEM.id, `Experiment "${site.experimentId}" is ${status}.`, ctx.now())
        tornDown.push(site.id)
      } catch (error) {
        failed.push({ siteId: site.id, error: (error as Error).message })
      }
    }
  })
  return { status: 200, body: { checked, tornDown, failed } }
}
