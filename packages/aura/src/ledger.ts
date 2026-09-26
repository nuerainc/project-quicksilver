import { createHash, sign, verify, type KeyObject } from 'node:crypto'

import type { AccessController, Principal } from '@quicksilver/kernel/identity'

import type { AutonomyDepth } from './types.ts'
import { AUTONOMY_DEPTHS } from './types.ts'

/**
 * The intent ledger: who a company acts for, what they want, and how they
 * decide, kept as an append-only, hash-chained log.
 *
 * Charter rules enforced here:
 *   - Intent providers (a person, a group, or an organization) are the only
 *     source of intent: goals, horizons, weights, autonomy, and customer
 *     commitments. Each provider changes only their own weights and autonomy.
 *   - Admins set the decision rule and the admin list. They have no input into
 *     intent unless they are also recorded as a provider.
 *   - Every change is recorded with who made it, in which role, when, the old
 *     and new value and an optional reason, and is never overwritten.
 *   - Each entry is chained to the one before by SHA-256, and may be signed
 *     (Ed25519), so anyone can check that nothing was altered or removed.
 *   - Decisions store the ledger head they were made under, so the weights and
 *     rule in force at that moment can always be replayed.
 *   - Identity goes through the NQC Kernel's access control when a controller
 *     is supplied: `intent:provide` for intent, `intent:rules` for rules.
 *     Agents can never hold either permission.
 * All functions are pure: a ledger is never mutated in place.
 */

export const PROVIDER_KINDS = ['person', 'group', 'organization'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const HORIZONS = ['week', 'quarter', 'year', 'enduring'] as const
export type Horizon = (typeof HORIZONS)[number]

export interface IntentProvider {
  /** Kernel principal id of whoever speaks for this provider. */
  id: string
  kind: ProviderKind
  name: string
  /** Share of authority, 0–1. Shares across providers sum to 1. */
  authority: number
}

export interface ProviderGoal {
  id: string
  label: string
  horizon: Horizon
  /** Longer-horizon goals this goal serves. */
  serves: string[]
  /** Short-term goals lapse at this time unless renewed. */
  expiresAt?: string
  setBy: string
}

export type DecisionRule =
  | { kind: 'majority' }
  | { kind: 'veto'; vetoBy: string[] }
  | { kind: 'final-say'; providerId: string }

export interface Commitment {
  id: string
  /** The promise as made, e.g. "No hidden fees". */
  text: string
  audience: 'customers' | 'public' | 'partners'
  setBy: string
}

export interface CompanyIntent {
  companyId: string
  tenantId: string
  providers: IntentProvider[]
  admins: string[]
  goals: Record<string, ProviderGoal>
  /** providerId → goalId → weight (0–1). */
  weights: Record<string, Record<string, number>>
  /** providerId → goalId → how far the company may act alone. */
  autonomy: Record<string, Record<string, AutonomyDepth>>
  rule: DecisionRule | null
  commitments: Record<string, Commitment>
}

export type IntentChange =
  | { type: 'company.create'; companyId: string; tenantId: string; providers: IntentProvider[]; admins?: string[] }
  | { type: 'providers.set'; providers: IntentProvider[] }
  | { type: 'admins.set'; admins: string[] }
  | { type: 'rule.set'; rule: DecisionRule | null }
  | { type: 'goal.set'; goal: Omit<ProviderGoal, 'setBy'> }
  | { type: 'goal.retire'; goalId: string }
  | { type: 'weight.set'; goalId: string; weight: number }
  | { type: 'autonomy.set'; goalId: string; depth: AutonomyDepth }
  | { type: 'commitment.set'; commitment: Omit<Commitment, 'setBy'> }
  | { type: 'commitment.retire'; commitmentId: string }

export type ActorRole = 'provider' | 'admin'

export interface LedgerEntry {
  seq: number
  at: string
  actor: { id: string; role: ActorRole }
  change: IntentChange
  /** The value this change replaced (absent when nothing was there). */
  previous?: unknown
  reason?: string
  prevHash: string
  hash: string
  /** Ed25519 signature of `hash`, base64, when a signing key is used. */
  signature?: string
}

export interface IntentLedger {
  entries: LedgerEntry[]
}

export const GENESIS_HASH = '0'.repeat(64)

const INTENT_CHANGES = new Set<IntentChange['type']>(['goal.set', 'goal.retire', 'weight.set', 'autonomy.set', 'commitment.set', 'commitment.retire'])
const RULE_CHANGES = new Set<IntentChange['type']>(['rule.set', 'admins.set'])

export function emptyLedger(): IntentLedger {
  return { entries: [] }
}

export interface AppendOptions {
  now?: Date
  reason?: string
  /** When given, the actor must pass the kernel's access check. */
  access?: AccessController
  /** Ed25519 private key; signs each entry's hash. */
  signingKey?: KeyObject
}

export type AppendResult =
  | { ok: true; ledger: IntentLedger; entry: LedgerEntry; state: CompanyIntent }
  | { ok: false; reasons: string[] }

/** Append one change after checking who may make it. */
export function appendChange(ledger: IntentLedger, actor: Principal, change: IntentChange, options: AppendOptions = {}): AppendResult {
  const state = ledger.entries.length ? replay(ledger) : null
  const reasons: string[] = []
  if (!actor?.id) return { ok: false, reasons: ['A verified actor is required.'] }
  if (actor.kind === 'agent') return { ok: false, reasons: ['Agents cannot change intent or rules; only providers and admins can.'] }

  const isProvider = !!state?.providers.some((p) => p.id === actor.id)
  const isAdmin = !!state?.admins.includes(actor.id)
  let role: ActorRole
  let permission: 'intent:provide' | 'intent:rules'

  if (change.type === 'company.create') {
    if (state) reasons.push('The company already exists in this ledger.')
    const inList = change.providers.some((p) => p.id === actor.id)
    const asAdmin = (change.admins ?? []).includes(actor.id)
    if (!inList && !asAdmin) reasons.push('Whoever creates the company must be one of its providers or admins.')
    role = inList ? 'provider' : 'admin'
    permission = inList ? 'intent:provide' : 'intent:rules'
    reasons.push(...checkProviders(change.providers))
  } else {
    if (!state) return { ok: false, reasons: ['Create the company first.'] }
    if (INTENT_CHANGES.has(change.type) || change.type === 'providers.set') {
      if (!isProvider) {
        reasons.push(isAdmin
          ? 'Admins set decision rules only; intent comes from providers. Record this person as a provider to let them shape intent.'
          : `"${actor.id}" is not an intent provider for this company.`)
      }
      role = 'provider'
      permission = 'intent:provide'
    } else if (RULE_CHANGES.has(change.type)) {
      if (!isProvider && !isAdmin) reasons.push(`"${actor.id}" is neither a provider nor an admin for this company.`)
      role = isAdmin ? 'admin' : 'provider'
      permission = isAdmin ? 'intent:rules' : 'intent:provide'
    } else {
      return { ok: false, reasons: ['Unknown change type.'] }
    }
    reasons.push(...checkChange(state, actor.id, change))
  }

  if (options.access) {
    const tenantId = change.type === 'company.create' ? change.tenantId : state!.tenantId
    const decision = options.access.authorize(actor, permission, { tenantId, kind: 'intent-ledger', id: change.type === 'company.create' ? change.companyId : state!.companyId })
    if (!decision.allowed) reasons.push(...decision.reasons)
  }
  if (reasons.length) return { ok: false, reasons }

  const prevHash = ledger.entries.at(-1)?.hash ?? GENESIS_HASH
  const body: Omit<LedgerEntry, 'hash' | 'signature'> = {
    seq: ledger.entries.length + 1,
    at: (options.now ?? new Date()).toISOString(),
    actor: { id: actor.id, role },
    change,
    ...(state ? previousValue(state, actor.id, change) : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    prevHash,
  }
  const hash = hashEntry(body)
  const entry: LedgerEntry = { ...body, hash, ...(options.signingKey ? { signature: sign(null, Buffer.from(hash), options.signingKey).toString('base64') } : {}) }
  const next = { entries: [...ledger.entries, entry] }
  return { ok: true, ledger: next, entry, state: replay(next) }
}

function checkProviders(providers: IntentProvider[]): string[] {
  const reasons: string[] = []
  if (!providers.length) reasons.push('A company needs at least one intent provider.')
  if (new Set(providers.map((p) => p.id)).size !== providers.length) reasons.push('Provider ids must be unique.')
  for (const p of providers) {
    if (!PROVIDER_KINDS.includes(p.kind)) reasons.push(`Provider "${p.id}" has an unknown kind.`)
    if (!(p.authority > 0 && p.authority <= 1)) reasons.push(`Provider "${p.id}" needs an authority share above 0 and at most 1.`)
  }
  const total = providers.reduce((s, p) => s + p.authority, 0)
  if (providers.length && Math.abs(total - 1) > 1e-6) reasons.push(`Authority shares must sum to 1 (they sum to ${total.toFixed(3)}).`)
  return reasons
}

function checkChange(state: CompanyIntent, actorId: string, change: IntentChange): string[] {
  const r: string[] = []
  switch (change.type) {
    case 'providers.set': {
      r.push(...checkProviders(change.providers))
      // Who the company acts for is not one provider's call to make alone.
      const sole = state.providers.length === 1 && state.providers[0]!.id === actorId
      const finalSay = state.rule?.kind === 'final-say' && state.rule.providerId === actorId
      if (!sole && !finalSay) r.push('Changing who the providers are needs the sole provider, or the provider with the final say; otherwise all providers must agree outside the ledger first.')
      break
    }
    case 'rule.set': {
      const rule = change.rule
      const ids = new Set(state.providers.map((p) => p.id))
      if (rule?.kind === 'final-say' && !ids.has(rule.providerId)) r.push('The final say must belong to a current provider.')
      if (rule?.kind === 'veto' && (!rule.vetoBy.length || rule.vetoBy.some((id) => !ids.has(id)))) r.push('Veto holders must be current providers.')
      break
    }
    case 'goal.set': {
      const g = change.goal
      if (!g.id?.trim() || !g.label?.trim()) r.push('A goal needs an id and a label.')
      if (g.id?.startsWith('rule.')) r.push('Goals cannot use the "rule." prefix; the law and WAES are system constraints, not provider intent.')
      if (!HORIZONS.includes(g.horizon)) r.push(`Unknown horizon "${g.horizon}".`)
      const rank = HORIZONS.indexOf(g.horizon)
      for (const s of g.serves ?? []) {
        const target = state.goals[s]
        if (!target) r.push(`Goal "${g.id}" serves "${s}", which does not exist.`)
        else if (HORIZONS.indexOf(target.horizon) <= rank) r.push(`Goal "${g.id}" can only serve longer-horizon goals; "${s}" is ${target.horizon}.`)
      }
      if (g.horizon === 'enduring' && g.expiresAt) r.push('Enduring goals do not expire.')
      break
    }
    case 'goal.retire':
      if (!state.goals[change.goalId]) r.push(`Goal "${change.goalId}" does not exist.`)
      break
    case 'weight.set':
      if (!state.goals[change.goalId]) r.push(`Goal "${change.goalId}" does not exist.`)
      if (!(change.weight >= 0 && change.weight <= 1)) r.push('Weights are between 0 and 1.')
      break
    case 'autonomy.set':
      if (!state.goals[change.goalId]) r.push(`Goal "${change.goalId}" does not exist.`)
      if (!AUTONOMY_DEPTHS.includes(change.depth)) r.push(`Unknown autonomy depth "${change.depth}".`)
      break
    case 'commitment.set':
      if (!change.commitment.id?.trim() || !change.commitment.text?.trim()) r.push('A commitment needs an id and its text.')
      break
    case 'commitment.retire':
      if (!state.commitments[change.commitmentId]) r.push(`Commitment "${change.commitmentId}" does not exist.`)
      break
  }
  return r
}

function previousValue(state: CompanyIntent, actorId: string, change: IntentChange): { previous?: unknown } {
  const v = ((): unknown => {
    switch (change.type) {
      case 'providers.set': return state.providers
      case 'admins.set': return state.admins
      case 'rule.set': return state.rule
      case 'goal.set': return state.goals[change.goal.id]
      case 'goal.retire': return state.goals[change.goalId]
      case 'weight.set': return state.weights[actorId]?.[change.goalId]
      case 'autonomy.set': return state.autonomy[actorId]?.[change.goalId]
      case 'commitment.set': return state.commitments[change.commitment.id]
      case 'commitment.retire': return state.commitments[change.commitmentId]
      default: return undefined
    }
  })()
  return v === undefined ? {} : { previous: structuredClone(v) }
}

/** Rebuild the company's intent from the ledger, optionally as it stood at a time or sequence number. */
export function replay(ledger: IntentLedger, until?: { at?: Date | string; seq?: number }): CompanyIntent {
  const limitAt = until?.at ? new Date(until.at).getTime() : Infinity
  const limitSeq = until?.seq ?? Infinity
  let s: CompanyIntent | null = null
  for (const e of ledger.entries) {
    if (e.seq > limitSeq || new Date(e.at).getTime() > limitAt) break
    const c = e.change
    const who = e.actor.id
    if (c.type === 'company.create') {
      s = { companyId: c.companyId, tenantId: c.tenantId, providers: structuredClone(c.providers), admins: [...(c.admins ?? [])], goals: {}, weights: {}, autonomy: {}, rule: null, commitments: {} }
      continue
    }
    if (!s) continue
    switch (c.type) {
      case 'providers.set': s.providers = structuredClone(c.providers); break
      case 'admins.set': s.admins = [...c.admins]; break
      case 'rule.set': s.rule = c.rule ? structuredClone(c.rule) : null; break
      case 'goal.set': s.goals[c.goal.id] = { ...structuredClone(c.goal), serves: [...(c.goal.serves ?? [])], setBy: who }; break
      case 'goal.retire': delete s.goals[c.goalId]; break
      case 'weight.set': (s.weights[who] ??= {})[c.goalId] = c.weight; break
      case 'autonomy.set': (s.autonomy[who] ??= {})[c.goalId] = c.depth; break
      case 'commitment.set': s.commitments[c.commitment.id] = { ...structuredClone(c.commitment), setBy: who }; break
      case 'commitment.retire': delete s.commitments[c.commitmentId]; break
    }
  }
  if (!s) throw new Error('The ledger has no company.create entry in range.')
  return s
}

/** Goals in force at a moment: short-term goals past their expiry have lapsed. */
export function activeGoals(state: CompanyIntent, now = new Date()): ProviderGoal[] {
  return Object.values(state.goals).filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now.getTime())
}

/** Structural issues worth showing the providers (not errors). */
export function intentIssues(state: CompanyIntent, now = new Date()): string[] {
  const issues: string[] = []
  const active = new Set(activeGoals(state, now).map((g) => g.id))
  for (const g of Object.values(state.goals)) {
    if (!active.has(g.id)) issues.push(`Goal "${g.id}" has lapsed; renew or retire it.`)
    else if (g.horizon !== 'enduring' && g.serves.length === 0) issues.push(`Short-term goal "${g.id}" does not say which longer-term goal it serves.`)
    for (const s of g.serves) if (!state.goals[s]) issues.push(`Goal "${g.id}" serves "${s}", which was retired.`)
  }
  if (state.providers.length > 1 && !state.rule) issues.push('No decision rule is set; every disagreement goes to all providers.')
  return issues
}

// ---------------------------------------------------------------------------
// Integrity

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function hashEntry(body: Omit<LedgerEntry, 'hash' | 'signature'>): string {
  return createHash('sha256').update(canonical(body)).digest('hex')
}

export type VerifyResult = { valid: true; entries: number; head: string } | { valid: false; brokenAt: number; reason: string }

/** Check the chain (and signatures, when a public key is given). Detects edits, removals and reordering. */
export function verifyLedger(ledger: IntentLedger, publicKey?: KeyObject): VerifyResult {
  let prev = GENESIS_HASH
  for (let i = 0; i < ledger.entries.length; i++) {
    const { hash, signature, ...body } = ledger.entries[i]!
    if (body.seq !== i + 1) return { valid: false, brokenAt: i + 1, reason: 'Sequence numbers are out of order or missing.' }
    if (body.prevHash !== prev) return { valid: false, brokenAt: body.seq, reason: 'Entry does not chain to the one before it.' }
    if (hashEntry(body) !== hash) return { valid: false, brokenAt: body.seq, reason: 'Entry content does not match its hash; it was altered.' }
    if (publicKey && (!signature || !verify(null, Buffer.from(hash), publicKey, Buffer.from(signature, 'base64')))) {
      return { valid: false, brokenAt: body.seq, reason: 'Signature is missing or invalid.' }
    }
    prev = hash
  }
  return { valid: true, entries: ledger.entries.length, head: prev }
}

// ---------------------------------------------------------------------------
// Decisions

/** What a decision records about the intent it was made under. */
export interface DecisionIntentRef {
  ledgerSeq: number
  ledgerHead: string
  rule: DecisionRule | null
  weights: CompanyIntent['weights']
}

/** Take the reference a decision stores, as of now (or a given time). */
export function intentInForce(ledger: IntentLedger, at?: Date): DecisionIntentRef {
  const entries = at ? ledger.entries.filter((e) => new Date(e.at).getTime() <= at.getTime()) : ledger.entries
  const last = entries.at(-1)
  if (!last) throw new Error('No intent recorded yet.')
  const state = replay(ledger, { seq: last.seq })
  return { ledgerSeq: last.seq, ledgerHead: last.hash, rule: state.rule, weights: structuredClone(state.weights) }
}

export type Resolution =
  | { outcome: 'decided'; choice: string; rule: DecisionRule | 'unanimous'; explanation: string }
  | { outcome: 'escalate'; rule: DecisionRule | null; explanation: string }

/**
 * Combine providers' positions on one decision under the rule in force.
 * `positions` maps provider id → the option that provider's intent favors.
 * Anyone missing from `positions` has not weighed in.
 */
export function resolvePositions(state: CompanyIntent, positions: Record<string, string>): Resolution {
  const given = state.providers.filter((p) => positions[p.id] !== undefined)
  const choices = new Set(given.map((p) => positions[p.id]))
  if (given.length === state.providers.length && choices.size === 1) {
    return { outcome: 'decided', choice: [...choices][0]!, rule: 'unanimous', explanation: 'All providers agree.' }
  }
  const rule = state.rule
  if (!rule) return { outcome: 'escalate', rule: null, explanation: 'Providers disagree or have not all weighed in, and no decision rule is set; ask all providers.' }
  if (rule.kind === 'final-say') {
    const choice = positions[rule.providerId]
    return choice !== undefined
      ? { outcome: 'decided', choice, rule, explanation: `"${rule.providerId}" has the final say.` }
      : { outcome: 'escalate', rule, explanation: `"${rule.providerId}" has the final say and has not weighed in.` }
  }
  const share: Record<string, number> = {}
  for (const p of given) share[positions[p.id]!] = (share[positions[p.id]!] ?? 0) + p.authority
  const [top, topShare] = Object.entries(share).sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0]
  if (!top || topShare <= 0.5) return { outcome: 'escalate', rule, explanation: `No option holds a majority of authority (largest share ${(topShare * 100).toFixed(0)}%).` }
  if (rule.kind === 'veto') {
    const vetoers = rule.vetoBy.filter((id) => positions[id] !== undefined && positions[id] !== top)
    const silent = rule.vetoBy.filter((id) => positions[id] === undefined)
    if (vetoers.length) return { outcome: 'escalate', rule, explanation: `Majority favors "${top}", but ${vetoers.join(', ')} holds a veto and disagrees.` }
    if (silent.length) return { outcome: 'escalate', rule, explanation: `Majority favors "${top}", but veto holder ${silent.join(', ')} has not weighed in.` }
  }
  return { outcome: 'decided', choice: top, rule, explanation: `"${top}" holds ${(topShare * 100).toFixed(0)}% of provider authority.` }
}

// ---------------------------------------------------------------------------
// Reversals

export interface Reversal {
  providerId: string
  goalId: string
  changes: number
  values: number[]
  firstAt: string
  lastAt: string
}

/**
 * Weights a provider has moved back and forth within a window. Shown to the
 * provider, never blocked.
 */
export function weightReversals(ledger: IntentLedger, { windowDays = 30, minChanges = 3, now = new Date() } = {}): Reversal[] {
  const since = now.getTime() - windowDays * 86_400_000
  const series = new Map<string, { at: string; value: number }[]>()
  for (const e of ledger.entries) {
    if (e.change.type !== 'weight.set' || new Date(e.at).getTime() < since) continue
    const key = `${e.actor.id}\u0000${e.change.goalId}`
    series.set(key, [...(series.get(key) ?? []), { at: e.at, value: e.change.weight }])
  }
  const out: Reversal[] = []
  for (const [key, points] of series) {
    if (points.length < minChanges) continue
    let turns = 0
    for (let i = 2; i < points.length; i++) {
      const a = points[i - 1]!.value - points[i - 2]!.value
      const b = points[i]!.value - points[i - 1]!.value
      if (a * b < 0) turns++
    }
    if (turns === 0) continue
    const [providerId, goalId] = key.split('\u0000') as [string, string]
    out.push({ providerId, goalId, changes: points.length, values: points.map((p) => p.value), firstAt: points[0]!.at, lastAt: points.at(-1)!.at })
  }
  return out
}
