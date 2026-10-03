import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * P-026: experiment hosting. A site is a set of static files published in
 * immutable, digest-pinned versions, and torn down when its experiment ends.
 *
 * Contract-first: this module is the model, the validation, the stores and a
 * deploy adapter interface. The only adapter that ships writes files to a
 * directory; it deploys nothing and serves nothing. A real target (Azure,
 * Vercel, a static host) is a new adapter, chosen later.
 *
 * Rules the model enforces:
 *   - A release is immutable. Its files and digest never change; a new
 *     version is a new release. Publishing an older version again is a
 *     rollback and is recorded as such.
 *   - The history is append-only: every stage, publish, supersede and
 *     teardown is an event on the site, and a stored site's events only grow.
 *   - Static only. No scripts, frames, objects, forms, event handlers or
 *     `javascript:` links, and no external resource loads from CSS. This is a
 *     lint that refuses the obvious; it is not a sanitizer, and pages are
 *     meant to be served from their own origin, never the API's.
 *   - Customer-facing text (HTML and text files) is gated at publish by a
 *     passing review of its exact content (see hosting-api.ts).
 */

export const SITE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
export const MAX_FILES = 60
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024
const PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}(\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}){0,5}$/

/** Extension → content type. Anything else is refused. SVG and JS are deliberately absent. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html',
  css: 'text/css',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
})
const TEXT_TYPES = new Set(['text/html', 'text/css', 'text/plain'])
/** Types a customer reads as copy: these need a passing review of their exact text. */
export const REVIEWED_TYPES: ReadonlySet<string> = new Set(['text/html', 'text/plain'])

export interface HostedFile { path: string; contentType: string; bytes: number; sha256: string }
export interface StoredFile extends HostedFile { content: Buffer }

export type ReleaseStatus = 'staged' | 'published' | 'superseded' | 'torn-down'
export interface SiteRelease {
  version: number
  status: ReleaseStatus
  files: HostedFile[]
  /** sha256 over the sorted file list (path, content type, size, sha256). */
  digest: string
  createdBy: string
  createdAt: string
  note?: string
  publishedBy?: string
  publishedAt?: string
  /** Set when this publish re-activated an older version. */
  rollbackOf?: number
  endedAt?: string
}

export type SiteEventAction = 'site-created' | 'release-staged' | 'release-published' | 'release-superseded' | 'site-torn-down'
export interface SiteEvent { at: string; by: string; action: SiteEventAction; version?: number; detail?: string }

export interface HostedSite {
  id: string
  title: string
  /** The Genesis experiment this site exists for; the site is torn down when it ends. */
  experimentId?: string
  status: 'active' | 'torn-down'
  createdBy: string
  createdAt: string
  liveVersion?: number
  tornDownBy?: string
  tornDownAt?: string
  tornDownReason?: string
  releases: SiteRelease[]
  events: SiteEvent[]
}

// ── Files ─────────────────────────────────────────────────────────────────

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

export function releaseDigest(files: readonly HostedFile[]): string {
  const list = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.contentType, f.bytes, f.sha256])
  return `sha256:${sha(JSON.stringify(list))}`
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPG = Buffer.from([0xff, 0xd8, 0xff])
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00])
function magicOk(type: string, b: Buffer): boolean {
  if (type === 'image/png') return b.subarray(0, 4).equals(PNG)
  if (type === 'image/jpeg') return b.subarray(0, 3).equals(JPG)
  if (type === 'image/webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
  if (type === 'image/x-icon') return b.subarray(0, 4).equals(ICO)
  return true
}

const HTML_BANNED: ReadonlyArray<[RegExp, string]> = [
  [/<\s*script\b/i, 'a <script> element'],
  [/<\s*(iframe|frame|frameset|object|embed|applet)\b/i, 'a frame, object or embed element'],
  [/<\s*form\b/i, 'a <form> element'],
  [/<\s*base\b/i, 'a <base> element'],
  [/<\s*meta[^>]+http-equiv\s*=\s*["']?refresh/i, 'a meta refresh'],
  [/\son[a-z]+\s*=/i, 'an inline event handler'],
  [/javascript\s*:/i, 'a javascript: URL'],
  [/data\s*:\s*text\/html/i, 'a data:text/html URL'],
  [/<\s*link\b[^>]+rel\s*=\s*["']?(?:import|prefetch|preload)/i, 'a link import or preload'],
]
const CSS_BANNED: ReadonlyArray<[RegExp, string]> = [
  [/@import\b/i, 'an @import'],
  [/url\s*\(\s*["']?\s*(?:https?:|\/\/|javascript:|data:text)/i, 'an external or script URL'],
  [/expression\s*\(/i, 'a CSS expression'],
  [/behavior\s*:/i, 'a CSS behavior'],
]

/** Why a text file is not static-only, or undefined when it passes the lint. */
export function staticLint(contentType: string, text: string): string | undefined {
  const rules = contentType === 'text/html' ? HTML_BANNED : contentType === 'text/css' ? CSS_BANNED : []
  for (const [re, what] of rules) if (re.test(text)) return `contains ${what}`
  return undefined
}

export interface FileInput { path: string; text?: string; base64?: string }

export function buildFiles(inputs: unknown): { ok: true; files: StoredFile[] } | { ok: false; error: string } {
  if (!Array.isArray(inputs) || inputs.length === 0) return { ok: false, error: 'files must be a non-empty array.' }
  if (inputs.length > MAX_FILES) return { ok: false, error: `A release has at most ${MAX_FILES} files.` }
  const seen = new Set<string>()
  const out: StoredFile[] = []
  let total = 0
  for (const raw of inputs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Each file must be an object.' }
    const f = raw as Record<string, unknown>
    const path = f.path
    if (typeof path !== 'string' || !PATH_RE.test(path) || path.split('/').some((s) => s === '.' || s === '..')) return { ok: false, error: `"${String(path)}" is not a valid file path (letters, digits, . _ -, up to 6 segments, no leading dot).` }
    const key = path.toLowerCase()
    if (seen.has(key)) return { ok: false, error: `"${path}" appears twice.` }
    seen.add(key)
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const contentType = path.includes('.') ? CONTENT_TYPES[ext] : undefined
    if (!contentType) return { ok: false, error: `"${path}": only ${Object.keys(CONTENT_TYPES).join(', ')} files are allowed (no scripts or SVG).` }
    if ((f.text === undefined) === (f.base64 === undefined)) return { ok: false, error: `"${path}": give exactly one of text or base64.` }
    let content: Buffer
    if (f.text !== undefined) {
      if (typeof f.text !== 'string') return { ok: false, error: `"${path}": text must be a string.` }
      if (!TEXT_TYPES.has(contentType)) return { ok: false, error: `"${path}": images need base64, not text.` }
      content = Buffer.from(f.text, 'utf8')
    } else {
      if (typeof f.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)) return { ok: false, error: `"${path}": base64 is not valid.` }
      if (TEXT_TYPES.has(contentType)) return { ok: false, error: `"${path}": text files need text, not base64.` }
      content = Buffer.from(f.base64, 'base64')
    }
    if (content.length === 0) return { ok: false, error: `"${path}" is empty.` }
    if (content.length > MAX_FILE_BYTES) return { ok: false, error: `"${path}" is over ${MAX_FILE_BYTES / 1024} KiB.` }
    total += content.length
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: `The release is over ${MAX_TOTAL_BYTES / 1024 / 1024} MiB in total.` }
    if (!magicOk(contentType, content)) return { ok: false, error: `"${path}" is not really a ${contentType} file.` }
    if (TEXT_TYPES.has(contentType)) {
      const why = staticLint(contentType, content.toString('utf8'))
      if (why) return { ok: false, error: `"${path}" ${why}; hosted pages are static only.` }
    }
    out.push({ path, contentType, bytes: content.length, sha256: sha(content), content })
  }
  if (!seen.has('index.html')) return { ok: false, error: 'A release needs an index.html.' }
  return { ok: true, files: out.sort((a, b) => a.path.localeCompare(b.path)) }
}

// ── Immutability and history ──────────────────────────────────────────────

/** Why storing `next` over `prev` would break a site's fixed record (empty when fine). */
export function siteChangeProblems(prev: HostedSite | undefined, next: HostedSite): string[] {
  const problems: string[] = []
  if (next.releases.some((r, i) => r.version !== i + 1)) problems.push('release versions must run 1, 2, 3 ... with no gaps.')
  for (const r of next.releases) if (releaseDigest(r.files) !== r.digest) problems.push(`release ${r.version}'s digest does not match its files.`)
  if (!prev) return problems
  if (next.id !== prev.id || next.createdAt !== prev.createdAt || next.createdBy !== prev.createdBy || next.experimentId !== prev.experimentId) problems.push('a site\'s id, creator, creation time and experiment are fixed.')
  if (next.events.length < prev.events.length || prev.events.some((e, i) => JSON.stringify(e) !== JSON.stringify(next.events[i]))) problems.push('the event history is append-only.')
  if (next.releases.length < prev.releases.length) problems.push('releases cannot be removed.')
  for (const p of prev.releases) {
    const n = next.releases[p.version - 1]
    if (!n) continue // already reported as removed above
    if (n.digest !== p.digest || n.createdBy !== p.createdBy || n.createdAt !== p.createdAt || JSON.stringify(n.files) !== JSON.stringify(p.files)) problems.push(`release ${p.version} is immutable.`)
  }
  if (prev.status === 'torn-down' && next.status !== 'torn-down') problems.push('a torn-down site cannot come back; make a new site.')
  return problems
}

export class HostingStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'HostingStoreError' }
}

// ── Store ─────────────────────────────────────────────────────────────────

export interface HostingStore {
  listSites(): Promise<HostedSite[]>
  getSite(id: string): Promise<HostedSite | undefined>
  /** Create or update one site. Refuses a change that breaks immutability or the history. */
  putSite(site: HostedSite): Promise<void>
  putFiles(siteId: string, version: number, files: readonly StoredFile[]): Promise<void>
  getFiles(siteId: string, version: number): Promise<StoredFile[]>
}

export const DEFAULT_HOSTING_TENANT = 'default'

/** <dir>/<tenantId>/hosting/<siteId>/site.json and releases/v<N>/<path>. Callers serialize writes (the host's lock). */
export class FileHostingStore implements HostingStore {
  private readonly root: string
  constructor(dir: string, tenantId: string = DEFAULT_HOSTING_TENANT) { this.root = resolve(dir, tenantId, 'hosting') }
  private siteDir(id: string) {
    if (!SITE_ID.test(id)) throw new HostingStoreError(`Invalid site id "${id}".`)
    return join(this.root, id)
  }
  async listSites() {
    let names: string[] = []
    try { names = await readdir(this.root) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const sites = await Promise.all(names.filter((n) => SITE_ID.test(n)).map((n) => this.getSite(n)))
    return sites.filter((s): s is HostedSite => !!s).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
  async getSite(id: string) {
    try { return JSON.parse(await readFile(join(this.siteDir(id), 'site.json'), 'utf8')) as HostedSite } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async putSite(site: HostedSite) {
    const problems = siteChangeProblems(await this.getSite(site.id), site)
    if (problems.length) throw new HostingStoreError(`Site "${site.id}" cannot be stored: ${problems.join(' ')}`)
    const path = join(this.siteDir(site.id), 'site.json')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(site, null, 2), { mode: 0o600 })
    await rename(tmp, path)
  }
  async putFiles(siteId: string, version: number, files: readonly StoredFile[]) {
    const base = join(this.siteDir(siteId), 'releases', `v${version}`)
    // A version the site already records is immutable. Anything else at this path is an orphan from a failed stage.
    if ((await this.getSite(siteId))?.releases.some((r) => r.version === version)) throw new HostingStoreError(`Release ${version} of "${siteId}" already exists and is immutable.`)
    await rm(base, { recursive: true, force: true })
    for (const f of files) {
      const target = resolve(base, f.path)
      if (!target.startsWith(base + sep)) throw new HostingStoreError(`"${f.path}" escapes the release directory.`)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, f.content, { mode: 0o600, flag: 'wx' }) // never overwrite a stored release file
    }
    await writeFile(join(base, '.manifest.json'), JSON.stringify(files.map(({ content: _c, ...meta }) => meta)), { mode: 0o600, flag: 'wx' })
  }
  async getFiles(siteId: string, version: number) {
    const base = join(this.siteDir(siteId), 'releases', `v${version}`)
    let meta: HostedFile[]
    try { meta = JSON.parse(await readFile(join(base, '.manifest.json'), 'utf8')) as HostedFile[] } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return Promise.all(meta.map(async (m) => ({ ...m, content: await readFile(resolve(base, m.path)) })))
  }
}

/** In-memory twin for tests and file-less hosts; partitioned by tenant. */
export class MemoryHostingStore implements HostingStore {
  private readonly sites = new Map<string, HostedSite>()
  private readonly files = new Map<string, StoredFile[]>()
  readonly tenantId: string
  constructor(tenantId: string = DEFAULT_HOSTING_TENANT) { this.tenantId = tenantId }
  async listSites() { return structuredClone([...this.sites.values()]).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) }
  async getSite(id: string) {
    if (!SITE_ID.test(id)) throw new HostingStoreError(`Invalid site id "${id}".`)
    return structuredClone(this.sites.get(id))
  }
  async putSite(site: HostedSite) {
    const problems = siteChangeProblems(await this.getSite(site.id), site)
    if (problems.length) throw new HostingStoreError(`Site "${site.id}" cannot be stored: ${problems.join(' ')}`)
    this.sites.set(site.id, structuredClone(site))
  }
  async putFiles(siteId: string, version: number, files: readonly StoredFile[]) {
    const key = `${siteId}\u0000${version}`
    if (this.sites.get(siteId)?.releases.some((r) => r.version === version)) throw new HostingStoreError(`Release ${version} of "${siteId}" already exists and is immutable.`)
    for (const f of files) if (!PATH_RE.test(f.path) || f.path.split('/').some((seg) => seg === '..')) throw new HostingStoreError(`"${f.path}" escapes the release directory.`)
    this.files.set(key, files.map((f) => ({ ...f, content: Buffer.from(f.content) })))
  }
  async getFiles(siteId: string, version: number) { return (this.files.get(`${siteId}\u0000${version}`) ?? []).map((f) => ({ ...f, content: Buffer.from(f.content) })) }
}

// ── Deploy adapter ────────────────────────────────────────────────────────

export interface DeployTarget { siteId: string; tenantId: string }

/** The only thing that touches a deploy target. A real host is a new adapter. */
export interface HostingAdapter {
  readonly name: string
  /** Make `release` the live content of the site. Replaces any earlier live content. */
  publish(target: DeployTarget, release: SiteRelease, files: readonly StoredFile[]): Promise<{ location: string }>
  /** Remove everything live for the site. Idempotent. */
  teardown(target: DeployTarget): Promise<void>
}

/**
 * Writes `<dir>/<tenantId>/<siteId>/live/` for a separate static server to
 * serve. It deploys nothing and serves nothing. The swap is write-then-rename,
 * so a reader sees the old release or the new one, never a mix.
 */
export class FileHostingAdapter implements HostingAdapter {
  readonly name = 'file'
  private readonly dir: string
  constructor(dir: string) { this.dir = resolve(dir) }
  private siteRoot(t: DeployTarget) {
    if (!SITE_ID.test(t.siteId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(t.tenantId)) throw new HostingStoreError('Invalid site or tenant id.')
    return join(this.dir, t.tenantId, t.siteId)
  }
  async publish(t: DeployTarget, release: SiteRelease, files: readonly StoredFile[]) {
    const root = this.siteRoot(t)
    const next = join(root, `.next-v${release.version}`)
    await rm(next, { recursive: true, force: true })
    await mkdir(next, { recursive: true, mode: 0o755 })
    for (const f of files) {
      const target = resolve(next, f.path)
      if (!target.startsWith(next + sep)) throw new HostingStoreError(`"${f.path}" escapes the site directory.`)
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await writeFile(target, f.content, { mode: 0o644 })
    }
    await writeFile(join(next, '.release.json'), JSON.stringify({ version: release.version, digest: release.digest }), { mode: 0o644 })
    const live = join(root, 'live')
    const old = join(root, `.old-${Date.now()}`)
    let hadLive = true
    try { await rename(live, old) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hadLive = false; else throw error }
    await rename(next, live)
    if (hadLive) await rm(old, { recursive: true, force: true })
    return { location: live }
  }
  async teardown(t: DeployTarget) { await rm(this.siteRoot(t), { recursive: true, force: true }) }
}

/** Records what it was asked to do; for tests. */
export class MemoryHostingAdapter implements HostingAdapter {
  readonly name = 'memory'
  readonly live = new Map<string, { version: number; digest: string; paths: string[] }>()
  readonly ops: string[] = []
  failNext: 'publish' | 'teardown' | undefined
  async publish(t: DeployTarget, release: SiteRelease, files: readonly StoredFile[]) {
    if (this.failNext === 'publish') { this.failNext = undefined; throw new Error('deploy target unavailable') }
    this.ops.push(`publish ${t.siteId} v${release.version}`)
    this.live.set(`${t.tenantId}/${t.siteId}`, { version: release.version, digest: release.digest, paths: files.map((f) => f.path) })
    return { location: `memory://${t.tenantId}/${t.siteId}` }
  }
  async teardown(t: DeployTarget) {
    if (this.failNext === 'teardown') { this.failNext = undefined; throw new Error('deploy target unavailable') }
    this.ops.push(`teardown ${t.siteId}`)
    this.live.delete(`${t.tenantId}/${t.siteId}`)
  }
}
