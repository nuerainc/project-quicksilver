import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * P-025: media. A versioned contract for image, video, speech, transcription,
 * diagram and image-understanding requests, with the controls the plan asks
 * for: moderation, retention, a cost cap and asset provenance.
 *
 * Contract-first: this module is the contract, the controls, a store and a
 * service. It ships no real provider. A vendor is a `MediaProvider` that
 * implements the contract and is registered in code; until then the service
 * answers "no provider" and nothing is called. The fake provider below exists
 * for tests.
 *
 * What the controls do:
 *   - Moderation runs on the input before any provider call and on the output
 *     before anything is stored. A moderator that throws blocks the request
 *     (fail closed). Blocked requests are recorded; blocked output is never kept.
 *   - Cost: each request is estimated first. A person (a human principal) may
 *     run up to `maxRequestUsd`, anything else up to `autoMaxUsd`, and neither
 *     may take total spend past `budgetUsd`. The provider's reported cost is
 *     what is recorded, including for output that moderation then blocked,
 *     because that money was spent.
 *   - Retention: every asset has an expiry (default and maximum set by policy).
 *     Expired or deleted assets lose their bytes and keep their provenance.
 *   - Provenance: an append-only, hash-chained event log. Each stored asset
 *     records its kind, provider, contract version, input digest, output digest,
 *     size, cost, who asked and when. The prompt itself is not kept, only its
 *     digest.
 *
 * Nothing here moves money. Cost is tracked against the media budget and each
 * result carries a suggested ledger entry for a human to record through the
 * money route.
 */

export const MEDIA_CONTRACT_VERSION = 1

export const MEDIA_KINDS = ['image-generation', 'video-generation', 'speech', 'transcription', 'diagram', 'image-understanding'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export const MAX_PROMPT_CHARS = 4_000
export const MAX_SPEC_CHARS = 8_000
export const MAX_INPUT_BYTES = 10 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 30
const SIZES = ['256x256', '512x512', '1024x1024'] as const
const AUDIO_INPUT = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm'] as const
const IMAGE_INPUT = ['image/png', 'image/jpeg', 'image/webp'] as const

/** The output types each kind may produce. Anything else from a provider is refused. */
export const OUTPUT_TYPES: Readonly<Record<MediaKind, readonly string[]>> = Object.freeze({
  'image-generation': ['image/png', 'image/jpeg', 'image/webp'],
  'video-generation': ['video/mp4', 'video/webm'],
  speech: ['audio/mpeg', 'audio/wav'],
  transcription: ['text/plain'],
  diagram: ['image/png'],
  'image-understanding': ['text/plain'],
})

export type MediaInput =
  | { kind: 'image-generation'; prompt: string; size: (typeof SIZES)[number] }
  | { kind: 'video-generation'; prompt: string; seconds: number }
  | { kind: 'speech'; text: string; voice?: string }
  | { kind: 'transcription'; audioBase64: string; mediaType: (typeof AUDIO_INPUT)[number] }
  | { kind: 'diagram'; spec: string }
  | { kind: 'image-understanding'; imageBase64: string; mediaType: (typeof IMAGE_INPUT)[number]; question?: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max

function base64Ok(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0
}

export function parseMediaInput(kind: unknown, value: unknown): { ok: true; input: MediaInput } | { ok: false; error: string } {
  if (!MEDIA_KINDS.includes(kind as MediaKind)) return { ok: false, error: `kind must be one of ${MEDIA_KINDS.join(', ')}.` }
  if (!isObj(value)) return { ok: false, error: 'input must be an object.' }
  const v = value
  switch (kind as MediaKind) {
    case 'image-generation': {
      if (!text(v.prompt, MAX_PROMPT_CHARS)) return { ok: false, error: `prompt must be 1 to ${MAX_PROMPT_CHARS} characters.` }
      const size = v.size === undefined ? '1024x1024' : v.size
      if (!SIZES.includes(size as never)) return { ok: false, error: `size must be one of ${SIZES.join(', ')}.` }
      return { ok: true, input: { kind: 'image-generation', prompt: v.prompt.trim(), size: size as (typeof SIZES)[number] } }
    }
    case 'video-generation': {
      if (!text(v.prompt, MAX_PROMPT_CHARS)) return { ok: false, error: `prompt must be 1 to ${MAX_PROMPT_CHARS} characters.` }
      if (typeof v.seconds !== 'number' || !Number.isInteger(v.seconds) || v.seconds < 1 || v.seconds > MAX_VIDEO_SECONDS) return { ok: false, error: `seconds must be a whole number from 1 to ${MAX_VIDEO_SECONDS}.` }
      return { ok: true, input: { kind: 'video-generation', prompt: v.prompt.trim(), seconds: v.seconds } }
    }
    case 'speech': {
      if (!text(v.text, MAX_PROMPT_CHARS)) return { ok: false, error: `text must be 1 to ${MAX_PROMPT_CHARS} characters.` }
      if (v.voice !== undefined && (typeof v.voice !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(v.voice))) return { ok: false, error: 'voice must be lowercase letters, digits, "_" and "-".' }
      return { ok: true, input: { kind: 'speech', text: v.text.trim(), ...(typeof v.voice === 'string' ? { voice: v.voice } : {}) } }
    }
    case 'transcription': {
      if (!base64Ok(v.audioBase64)) return { ok: false, error: `audioBase64 must be valid base64 of at most ${MAX_INPUT_BYTES / 1024 / 1024} MiB.` }
      if (!AUDIO_INPUT.includes(v.mediaType as never)) return { ok: false, error: `mediaType must be one of ${AUDIO_INPUT.join(', ')}.` }
      return { ok: true, input: { kind: 'transcription', audioBase64: v.audioBase64, mediaType: v.mediaType as (typeof AUDIO_INPUT)[number] } }
    }
    case 'diagram': {
      if (!text(v.spec, MAX_SPEC_CHARS)) return { ok: false, error: `spec must be 1 to ${MAX_SPEC_CHARS} characters.` }
      return { ok: true, input: { kind: 'diagram', spec: v.spec.trim() } }
    }
    case 'image-understanding': {
      if (!base64Ok(v.imageBase64)) return { ok: false, error: `imageBase64 must be valid base64 of at most ${MAX_INPUT_BYTES / 1024 / 1024} MiB.` }
      if (!IMAGE_INPUT.includes(v.mediaType as never)) return { ok: false, error: `mediaType must be one of ${IMAGE_INPUT.join(', ')}.` }
      if (v.question !== undefined && !text(v.question, 1_000)) return { ok: false, error: 'question must be 1 to 1,000 characters.' }
      return { ok: true, input: { kind: 'image-understanding', imageBase64: v.imageBase64, mediaType: v.mediaType as (typeof IMAGE_INPUT)[number], ...(typeof v.question === 'string' ? { question: v.question.trim() } : {}) } }
    }
  }
}

/** The human-readable text of an input, for moderation. Binary inputs contribute none. */
export function inputText(input: MediaInput): string {
  switch (input.kind) {
    case 'image-generation': case 'video-generation': return input.prompt
    case 'speech': return input.text
    case 'diagram': return input.spec
    case 'image-understanding': return input.question ?? ''
    case 'transcription': return ''
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex')
export const inputDigest = (input: MediaInput) => `sha256:${sha(canonical(input))}`

// ── Providers and moderation ──────────────────────────────────────────────

export interface MediaResult {
  mediaType: string
  content: Buffer
  /** What the provider charged, in USD. */
  costUsd: number
  model?: string
  providerRef?: string
}

/** A vendor implements this and is registered in code. The service never talks to one directly. */
export interface MediaProvider {
  readonly id: string
  readonly contractVersion: number
  readonly kinds: readonly MediaKind[]
  /** Before any call: what this request is expected to cost, in USD. */
  estimateCostUsd(input: MediaInput): number
  run(input: MediaInput, signal: AbortSignal): Promise<MediaResult>
}

export interface ModerationVerdict { allowed: boolean; reasons: string[] }

/** Both checks must answer; one that throws blocks the request. */
export interface MediaModerator {
  moderateInput(input: MediaInput): Promise<ModerationVerdict>
  /** `text` is set for text outputs (transcripts, descriptions); binary outputs give type, size and digest only. */
  moderateOutput(output: { kind: MediaKind; mediaType: string; bytes: number; sha256: string; text?: string }): Promise<ModerationVerdict>
}

/** Blocks any input or text output containing one of the configured terms (case-insensitive). */
export class TermModerator implements MediaModerator {
  private readonly terms: string[]
  constructor(terms: readonly string[]) { this.terms = terms.map((t) => t.trim().toLowerCase()).filter(Boolean) }
  private check(s: string): ModerationVerdict {
    const lower = s.toLowerCase()
    const hits = this.terms.filter((t) => lower.includes(t))
    return hits.length ? { allowed: false, reasons: [`contains a blocked term (${hits.length})`] } : { allowed: true, reasons: [] }
  }
  async moderateInput(input: MediaInput) { return this.check(inputText(input)) }
  async moderateOutput(o: Parameters<MediaModerator['moderateOutput']>[0]) { return this.check(o.text ?? '') }
}

/** Deterministic provider for tests: output bytes derive from the input; cost, failures and output type are scriptable. */
export class FakeMediaProvider implements MediaProvider {
  readonly id: string
  readonly contractVersion: number
  readonly kinds: readonly MediaKind[]
  readonly calls: MediaInput[] = []
  costUsd: Record<string, number> = {}
  estimateUsd: Record<string, number> = {}
  failNext = false
  override: Partial<Pick<MediaResult, 'mediaType' | 'content' | 'costUsd'>> | undefined
  outputText: string | undefined
  constructor(id = 'fake', kinds: readonly MediaKind[] = MEDIA_KINDS, contractVersion = MEDIA_CONTRACT_VERSION) { this.id = id; this.kinds = kinds; this.contractVersion = contractVersion }
  estimateCostUsd(input: MediaInput) { return this.estimateUsd[input.kind] ?? this.costUsd[input.kind] ?? 0.05 }
  async run(input: MediaInput): Promise<MediaResult> {
    this.calls.push(input)
    if (this.failNext) { this.failNext = false; throw new Error('provider unavailable') }
    const type = OUTPUT_TYPES[input.kind][0]!
    const body = type === 'text/plain' ? Buffer.from(this.outputText ?? `result for ${inputDigest(input).slice(7, 19)}`) : Buffer.from(`${input.kind}:${inputDigest(input)}`)
    return { mediaType: type, content: body, costUsd: this.costUsd[input.kind] ?? 0.05, model: 'fake-1', providerRef: `fake-${this.calls.length}`, ...this.override }
  }
}

// ── Policy ────────────────────────────────────────────────────────────────

export interface MediaPolicy {
  /** The total the media service may spend. */
  budgetUsd: number
  /** Up to this per request for anyone allowed to ask. */
  autoMaxUsd: number
  /** Up to this per request when a human asks. At least `autoMaxUsd`. */
  maxRequestUsd: number
  defaultRetentionDays: number
  maxRetentionDays: number
  allowedKinds: readonly MediaKind[]
  blockedTerms: readonly string[]
}

export function parseMediaPolicy(value: unknown): { ok: true; policy: MediaPolicy } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObj(value)) return { ok: false, errors: ['The media policy must be an object.'] }
  const usd = (k: string, max: number): number => {
    const n = value[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > max) errors.push(`${k} must be a positive number of USD up to ${max.toLocaleString('en-US')}.`)
    return typeof n === 'number' ? n : 0
  }
  const budgetUsd = usd('budgetUsd', 1_000_000)
  const autoMaxUsd = usd('autoMaxUsd', 10_000)
  const maxRequestUsd = usd('maxRequestUsd', 10_000)
  if (autoMaxUsd > maxRequestUsd) errors.push('autoMaxUsd cannot exceed maxRequestUsd.')
  if (maxRequestUsd > budgetUsd) errors.push('maxRequestUsd cannot exceed budgetUsd.')
  const days = (k: string, fallback: number): number => {
    const n = value[k] === undefined ? fallback : value[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3650) errors.push(`${k} must be a whole number of days from 1 to 3650.`)
    return typeof n === 'number' ? n : fallback
  }
  const defaultRetentionDays = days('defaultRetentionDays', 30)
  const maxRetentionDays = days('maxRetentionDays', 365)
  if (defaultRetentionDays > maxRetentionDays) errors.push('defaultRetentionDays cannot exceed maxRetentionDays.')
  let allowedKinds: MediaKind[] = [...MEDIA_KINDS]
  if (value.allowedKinds !== undefined) {
    if (!Array.isArray(value.allowedKinds) || !value.allowedKinds.length || value.allowedKinds.some((k) => !MEDIA_KINDS.includes(k as MediaKind))) errors.push(`allowedKinds must list at least one of ${MEDIA_KINDS.join(', ')}.`)
    else allowedKinds = value.allowedKinds as MediaKind[]
  }
  let blockedTerms: string[] = []
  if (value.blockedTerms !== undefined) {
    if (!Array.isArray(value.blockedTerms) || value.blockedTerms.some((t) => typeof t !== 'string' || !t.trim() || t.length > 100) || value.blockedTerms.length > 500) errors.push('blockedTerms must be up to 500 non-empty strings.')
    else blockedTerms = value.blockedTerms as string[]
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: { budgetUsd, autoMaxUsd, maxRequestUsd, defaultRetentionDays, maxRetentionDays, allowedKinds, blockedTerms } }
}

// ── Provenance: an append-only, hash-chained event log ────────────────────

export type MediaEventType = 'created' | 'blocked' | 'failed' | 'expired' | 'deleted'

export interface MediaAssetRecord {
  id: string
  kind: MediaKind
  contractVersion: number
  provider: { id: string; model?: string; ref?: string }
  inputDigest: string
  output: { mediaType: string; bytes: number; sha256: string }
  costUsd: number
  requestedBy: string
  requestedByKind: string
  createdAt: string
  retentionDays: number
  expiresAt: string
  experimentId?: string
}

export interface MediaEvent {
  seq: number
  type: MediaEventType
  at: string
  by: string
  /** The asset id this event is about (created, expired, deleted) or would have been (blocked, failed). */
  assetId: string
  /** `created`: the full record. `blocked`: stage, reasons, kind, input digest, and cost when the output was blocked. `failed`: kind, input digest, error class. `expired`/`deleted`: a reason. */
  data: Record<string, unknown>
  prevHash: string
  hash: string
}

const GENESIS_HASH = '0'.repeat(64)
const eventHash = (e: Omit<MediaEvent, 'hash'>) => sha(canonical(e))

export function verifyMediaEvents(events: readonly MediaEvent[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  let prev = GENESIS_HASH
  events.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`event ${i + 1} has sequence ${e.seq}.`)
    if (e.prevHash !== prev) errors.push(`event ${e.seq} does not follow the previous event.`)
    const { hash, ...rest } = e
    if (hash !== eventHash(rest)) errors.push(`event ${e.seq} does not match its hash.`)
    prev = e.hash
  })
  return { valid: errors.length === 0, errors }
}

export type MediaAssetStatus = 'stored' | 'expired' | 'deleted'
export interface MediaAssetView extends MediaAssetRecord { status: MediaAssetStatus; endedAt?: string; endedBy?: string; endReason?: string }

/** Fold the log into the current assets. Blocked and failed attempts are events only; they are not assets. */
export function assetsFrom(events: readonly MediaEvent[]): MediaAssetView[] {
  const byId = new Map<string, MediaAssetView>()
  for (const e of events) {
    if (e.type === 'created') byId.set(e.assetId, { ...(e.data as unknown as MediaAssetRecord), status: 'stored' })
    else if (e.type === 'expired' || e.type === 'deleted') {
      const a = byId.get(e.assetId)
      if (a && a.status === 'stored') byId.set(e.assetId, { ...a, status: e.type, endedAt: e.at, endedBy: e.by, ...(typeof e.data.reason === 'string' ? { endReason: e.data.reason } : {}) })
    }
  }
  return [...byId.values()]
}

const micro = (usd: number) => Math.round(usd * 1_000_000)

/** What an event cost: a created asset's cost, or the cost of output that moderation blocked after the provider charged for it. */
function eventCost(e: MediaEvent): number {
  if (e.type === 'created') return (e.data as unknown as MediaAssetRecord).costUsd
  if (e.type === 'blocked' && typeof e.data.costUsd === 'number') return e.data.costUsd
  return 0
}

/** Total spent across the log. */
export function spentUsd(events: readonly MediaEvent[]): number {
  return events.reduce((sum, e) => sum + micro(eventCost(e)), 0) / 1_000_000
}

// ── Store ─────────────────────────────────────────────────────────────────

export class MediaStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'MediaStoreError' }
}

export interface MediaStore {
  events(): Promise<MediaEvent[]>
  /** Append one event. Throws MediaStoreError when its sequence or previous hash does not follow the log. */
  append(event: MediaEvent): Promise<void>
  putContent(assetId: string, content: Buffer): Promise<void>
  getContent(assetId: string): Promise<Buffer | undefined>
  deleteContent(assetId: string): Promise<void>
}

export const DEFAULT_MEDIA_TENANT = 'default'
export const ASSET_ID_PATTERN = /^ma-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ASSET_ID = ASSET_ID_PATTERN

function checkAppend(current: readonly MediaEvent[], e: MediaEvent): void {
  if (e.seq !== current.length + 1) throw new MediaStoreError(`The next event is ${current.length + 1}, not ${e.seq}. Reload and try again.`)
  if (e.prevHash !== (current.at(-1)?.hash ?? GENESIS_HASH)) throw new MediaStoreError(`Event ${e.seq} does not follow the last event.`)
  const { hash, ...rest } = e
  if (hash !== eventHash(rest)) throw new MediaStoreError(`Event ${e.seq} does not match its hash.`)
}

/** <dir>/<tenantId>/media/events.json and content/<assetId>. Callers serialize writes (the host's lock). */
export class FileMediaStore implements MediaStore {
  private readonly root: string
  constructor(dir: string, tenantId: string = DEFAULT_MEDIA_TENANT) { this.root = resolve(dir, tenantId, 'media') }
  private contentPath(id: string) {
    if (!ASSET_ID.test(id)) throw new MediaStoreError(`Invalid asset id "${id}".`)
    return join(this.root, 'content', id)
  }
  async events() {
    try { return JSON.parse(await readFile(join(this.root, 'events.json'), 'utf8')) as MediaEvent[] } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  async append(event: MediaEvent) {
    const current = await this.events()
    checkAppend(current, event)
    const path = join(this.root, 'events.json')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify([...current, event]), { mode: 0o600 })
    await rename(tmp, path)
  }
  async putContent(id: string, content: Buffer) {
    const path = this.contentPath(id)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { mode: 0o600, flag: 'wx' })
  }
  async getContent(id: string) {
    try { return await readFile(this.contentPath(id)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async deleteContent(id: string) { await rm(this.contentPath(id), { force: true }) }
}

/** In-memory twin for tests and file-less hosts; partitioned by tenant. */
export class MemoryMediaStore implements MediaStore {
  readonly tenantId: string
  private log: MediaEvent[] = []
  private readonly content = new Map<string, Buffer>()
  constructor(tenantId: string = DEFAULT_MEDIA_TENANT) { this.tenantId = tenantId }
  async events() { return structuredClone(this.log) }
  async append(event: MediaEvent) { checkAppend(this.log, event); this.log = [...this.log, structuredClone(event)] }
  async putContent(id: string, content: Buffer) {
    if (!ASSET_ID.test(id)) throw new MediaStoreError(`Invalid asset id "${id}".`)
    if (this.content.has(id)) throw new MediaStoreError(`Asset "${id}" already has content.`)
    this.content.set(id, Buffer.from(content))
  }
  async getContent(id: string) {
    if (!ASSET_ID.test(id)) throw new MediaStoreError(`Invalid asset id "${id}".`)
    const c = this.content.get(id)
    return c ? Buffer.from(c) : undefined
  }
  async deleteContent(id: string) { this.content.delete(id) }
}

// ── Service ───────────────────────────────────────────────────────────────

export interface MediaRequest {
  kind: unknown
  input: unknown
  retentionDays?: unknown
  experimentId?: unknown
  /** Name a provider; otherwise the first registered one that supports the kind. */
  provider?: unknown
}

export interface MediaActor { id: string; kind: string }

export type MediaOutcome =
  | { ok: true; asset: MediaAssetView; costUsd: number; ledgerSuggestion: LedgerSuggestion; text?: string }
  | { ok: false; status: number; error: string; reasons?: string[]; blocked?: boolean; eventSeq?: number }

export interface LedgerSuggestion { kind: 'compute'; amountUsd: number; category: 'compute'; description: string; source: { type: 'provider-usage'; ref: string }; note: string }

export interface MediaServiceDeps {
  store: MediaStore
  policy: MediaPolicy
  providers: readonly MediaProvider[]
  moderator?: MediaModerator
  now?: () => Date
  providerTimeoutMs?: number
}

const EXP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const DAY_MS = 86_400_000

export class MediaService {
  private readonly d: MediaServiceDeps
  private readonly moderator: MediaModerator
  /** Appends are serialized so concurrent requests never race for a sequence number. */
  private appendChain: Promise<unknown> = Promise.resolve()
  /** Spend in millionths of a dollar, loaded once and then kept in step with every append. A host serves one tenant from one process. */
  private spentMicro: number | undefined
  /** Estimates of requests that have passed the cap but not finished, so simultaneous requests cannot jointly overspend. */
  private reservedMicro = 0
  constructor(deps: MediaServiceDeps) {
    for (const p of deps.providers) {
      if (p.contractVersion !== MEDIA_CONTRACT_VERSION) throw new Error(`Media provider "${p.id}" implements contract ${p.contractVersion}; this host speaks contract ${MEDIA_CONTRACT_VERSION}.`)
    }
    if (new Set(deps.providers.map((p) => p.id)).size !== deps.providers.length) throw new Error('Media provider ids must be unique.')
    this.d = deps
    this.moderator = deps.moderator ?? new TermModerator(deps.policy.blockedTerms)
  }
  private now() { return this.d.now?.() ?? new Date() }

  private log(type: MediaEventType, assetId: string, by: string, data: Record<string, unknown>): Promise<MediaEvent> {
    const run = async (): Promise<MediaEvent> => {
      await this.loadSpend()
      const events = await this.d.store.events()
      const base = { seq: events.length + 1, type, at: this.now().toISOString(), by, assetId, data, prevHash: events.at(-1)?.hash ?? GENESIS_HASH }
      const event: MediaEvent = { ...base, hash: eventHash(base) }
      await this.d.store.append(event)
      this.spentMicro = this.spentMicro! + micro(eventCost(event))
      return event
    }
    const next = this.appendChain.then(run, run)
    this.appendChain = next.catch(() => undefined)
    return next
  }

  private async loadSpend(): Promise<void> {
    if (this.spentMicro === undefined) this.spentMicro = micro(spentUsd(await this.d.store.events()))
  }

  /** Summary for the status route: limits, spend, and what is registered. Never contains a prompt or content. */
  async summary() {
    const events = await this.d.store.events()
    const spent = spentUsd(events)
    return {
      contractVersion: MEDIA_CONTRACT_VERSION,
      providers: this.d.providers.map((p) => ({ id: p.id, kinds: p.kinds })),
      policy: { ...this.d.policy, blockedTerms: this.d.policy.blockedTerms.length },
      spentUsd: spent,
      remainingUsd: Math.max(0, Math.round((this.d.policy.budgetUsd - spent) * 1_000_000) / 1_000_000),
      assets: assetsFrom(events).length,
      provenance: verifyMediaEvents(events),
    }
  }

  async assets() { return assetsFrom(await this.d.store.events()) }
  async asset(id: string) { return (await this.assets()).find((a) => a.id === id) }
  async events() { return this.d.store.events() }
  async content(id: string): Promise<{ asset: MediaAssetView; content: Buffer } | undefined> {
    const asset = await this.asset(id)
    if (!asset || asset.status !== 'stored') return undefined
    const content = await this.d.store.getContent(id)
    return content ? { asset, content } : undefined
  }

  /** Remove the bytes of every asset past its expiry; the provenance stays. Returns the ids purged. */
  async purgeExpired(by = 'kernel'): Promise<string[]> {
    const at = this.now().getTime()
    const purged: string[] = []
    for (const a of await this.assets()) {
      if (a.status === 'stored' && Date.parse(a.expiresAt) <= at) {
        await this.d.store.deleteContent(a.id)
        await this.log('expired', a.id, by, { reason: 'Retention period ended.' })
        purged.push(a.id)
      }
    }
    return purged
  }

  /** Delete an asset's bytes before its expiry. The provenance stays. */
  async deleteAsset(id: string, by: string, reason: string): Promise<MediaAssetView | undefined> {
    const a = await this.asset(id)
    if (!a || a.status !== 'stored') return undefined
    await this.d.store.deleteContent(id)
    await this.log('deleted', id, by, { reason })
    return this.asset(id)
  }

  async run(req: MediaRequest, actor: MediaActor): Promise<MediaOutcome> {
    const { policy } = this.d
    await this.purgeExpired()
    const parsed = parseMediaInput(req.kind, req.input)
    if (!parsed.ok) return { ok: false, status: 422, error: parsed.error }
    const input = parsed.input
    if (!policy.allowedKinds.includes(input.kind)) return { ok: false, status: 409, error: `Media kind "${input.kind}" is not enabled for this host.` }
    if (req.experimentId !== undefined && (typeof req.experimentId !== 'string' || !EXP_ID.test(req.experimentId))) return { ok: false, status: 422, error: 'experimentId is invalid.' }
    const retentionDays = req.retentionDays === undefined ? policy.defaultRetentionDays : req.retentionDays
    if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > policy.maxRetentionDays) return { ok: false, status: 422, error: `retentionDays must be a whole number from 1 to ${policy.maxRetentionDays}.` }
    if (req.provider !== undefined && typeof req.provider !== 'string') return { ok: false, status: 422, error: 'provider must be a provider id.' }
    const provider = this.d.providers.find((p) => p.kinds.includes(input.kind) && (req.provider === undefined || p.id === req.provider))
    if (!provider) return { ok: false, status: 503, error: req.provider ? `No provider "${String(req.provider)}" supports ${input.kind}.` : `No media provider is registered for ${input.kind}. Nothing was called.` }

    const digest = inputDigest(input)
    const blockedEvent = async (stage: 'input' | 'cost' | 'output', reasons: string[], extra: Record<string, unknown> = {}) =>
      (await this.log('blocked', `ma-${randomUUID()}`, actor.id, { stage, kind: input.kind, inputDigest: digest, reasons, ...extra })).seq

    // 1. Moderate the input before anything else.
    let verdict: ModerationVerdict
    try { verdict = await this.moderator.moderateInput(input) } catch { verdict = { allowed: false, reasons: ['moderation was unavailable, so the request fails closed'] } }
    if (!verdict.allowed) return { ok: false, status: 422, blocked: true, error: 'The request was blocked by moderation.', reasons: verdict.reasons, eventSeq: await blockedEvent('input', verdict.reasons) }

    // 2. The cost cap, before the provider is called.
    let estimate: number
    try { estimate = provider.estimateCostUsd(input) } catch { return { ok: false, status: 502, error: `Provider "${provider.id}" could not estimate the cost. Nothing was called.` } }
    if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) return { ok: false, status: 502, error: `Provider "${provider.id}" gave an invalid cost estimate. Nothing was called.` }
    const human = actor.kind === 'human'
    const perRequest = human ? policy.maxRequestUsd : policy.autoMaxUsd
    await this.loadSpend()
    // From here to the reservation below there is no await, so the check and the reservation are one step.
    const spent = (this.spentMicro! + this.reservedMicro) / 1_000_000
    const reasons: string[] = []
    if (estimate > perRequest) reasons.push(`The estimate $${estimate.toFixed(4)} is over the $${perRequest} ${human ? 'per-request cap' : 'limit for a request that is not made by a person'}${human ? '' : ` ($${policy.maxRequestUsd} when a person asks)`}.`)
    if (spent + estimate > policy.budgetUsd) reasons.push(`The estimate would take media spend to $${(spent + estimate).toFixed(4)}, past the $${policy.budgetUsd} budget.`)
    if (reasons.length) return { ok: false, status: 422, blocked: true, error: 'The cost cap refused this request. Nothing was called.', reasons, eventSeq: await blockedEvent('cost', reasons, { estimateUsd: estimate }) }
    const reserved = micro(estimate)
    this.reservedMicro += reserved
    try {
      return await this.callAndStore(provider, input, req, actor, digest, retentionDays, blockedEvent)
    } finally {
      this.reservedMicro -= reserved
    }
  }

  private async callAndStore(
    provider: MediaProvider,
    input: MediaInput,
    req: MediaRequest,
    actor: MediaActor,
    digest: string,
    retentionDays: number,
    blockedEvent: (stage: 'input' | 'cost' | 'output', reasons: string[], extra?: Record<string, unknown>) => Promise<number>,
  ): Promise<MediaOutcome> {
    // 3. The provider call.
    let result: MediaResult
    try {
      result = await provider.run(input, AbortSignal.timeout(this.d.providerTimeoutMs ?? 60_000))
    } catch (error) {
      const seq = (await this.log('failed', `ma-${randomUUID()}`, actor.id, { kind: input.kind, inputDigest: digest, provider: provider.id, error: (error as Error).name })).seq
      return { ok: false, status: 502, error: `The media provider failed: ${(error as Error).message}.`, eventSeq: seq }
    }
    if (typeof result.costUsd !== 'number' || !Number.isFinite(result.costUsd) || result.costUsd < 0) return { ok: false, status: 502, error: 'The provider reported an invalid cost; nothing was stored.' }
    if (!OUTPUT_TYPES[input.kind].includes(result.mediaType) || !Buffer.isBuffer(result.content) || result.content.length === 0 || result.content.length > MAX_OUTPUT_BYTES) {
      const why = [`The provider returned ${result.mediaType} (${Buffer.isBuffer(result.content) ? result.content.length : 0} bytes); ${input.kind} allows ${OUTPUT_TYPES[input.kind].join(', ')} up to ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB.`]
      return { ok: false, status: 502, blocked: true, error: 'The provider output was refused and not stored.', reasons: why, eventSeq: await blockedEvent('output', why, { costUsd: result.costUsd, provider: provider.id }) }
    }

    // 4. Moderate the output before keeping it. The money is spent either way, so the cost is recorded.
    const outDigest = sha(result.content)
    const isText = result.mediaType === 'text/plain'
    let outVerdict: ModerationVerdict
    try { outVerdict = await this.moderator.moderateOutput({ kind: input.kind, mediaType: result.mediaType, bytes: result.content.length, sha256: outDigest, ...(isText ? { text: result.content.toString('utf8') } : {}) }) } catch { outVerdict = { allowed: false, reasons: ['moderation was unavailable, so the output is not kept'] } }
    if (!outVerdict.allowed) return { ok: false, status: 422, blocked: true, error: 'The output was blocked by moderation and not stored.', reasons: outVerdict.reasons, eventSeq: await blockedEvent('output', outVerdict.reasons, { costUsd: result.costUsd, provider: provider.id, outputDigest: `sha256:${outDigest}` }) }

    // 5. Store the bytes, then the provenance.
    const at = this.now()
    const id = `ma-${randomUUID()}`
    const record: MediaAssetRecord = {
      id,
      kind: input.kind,
      contractVersion: provider.contractVersion,
      provider: { id: provider.id, ...(result.model ? { model: result.model } : {}), ...(result.providerRef ? { ref: result.providerRef } : {}) },
      inputDigest: digest,
      output: { mediaType: result.mediaType, bytes: result.content.length, sha256: `sha256:${outDigest}` },
      costUsd: result.costUsd,
      requestedBy: actor.id,
      requestedByKind: actor.kind,
      createdAt: at.toISOString(),
      retentionDays,
      expiresAt: new Date(at.getTime() + retentionDays * DAY_MS).toISOString(),
      ...(typeof req.experimentId === 'string' ? { experimentId: req.experimentId } : {}),
    }
    await this.d.store.putContent(id, result.content)
    await this.log('created', id, actor.id, record as unknown as Record<string, unknown>)
    const asset = (await this.asset(id))!
    return {
      ok: true,
      asset,
      costUsd: result.costUsd,
      ...(isText ? { text: result.content.toString('utf8') } : {}),
      ledgerSuggestion: {
        kind: 'compute',
        amountUsd: result.costUsd,
        category: 'compute',
        description: `Media ${input.kind} via ${provider.id} (asset ${id})`.slice(0, 500),
        source: { type: 'provider-usage', ref: id },
        note: 'Not recorded. A human records it through the Genesis money route if it counts against a run.',
      },
    }
  }
}
