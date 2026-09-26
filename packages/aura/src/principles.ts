import type { Principal } from '@quicksilver/kernel/identity'

import { checkPrinciple, replay, type CompanyIntent, type IntentChange, type Principle, type PrincipleInput } from './ledger.ts'
import { loadLedger, recordChange, type LedgerStore } from './store.ts'

/**
 * Decision principles from the review page's export:
 *
 *   { principles: [{ id, text, status: 'confirmed' | 'edited' | 'rejected', appliesTo?, examples? }] }
 *
 * Confirmed and edited principles are the provider's stated intent (an edited
 * one carries the provider's own wording) and go into the intent ledger with
 * `principle.set`. Rejected ones are never recorded. Importing is idempotent:
 * a principle already active with the same text, appliesTo and examples is
 * left alone; a changed one is recorded again as a tracked change.
 */

export const PRINCIPLE_STATUSES = ['confirmed', 'edited', 'rejected'] as const
export type PrincipleStatus = (typeof PRINCIPLE_STATUSES)[number]

export interface ExportedPrinciple extends PrincipleInput {
  status: PrincipleStatus
}

export interface PrincipleExport {
  principles: ExportedPrinciple[]
  /** Entries that could not be read, with why. */
  invalid: Array<{ index: number; id?: string; reasons: string[] }>
}

/** Read and check an export. Throws only when the file is not an export at all. */
export function parsePrincipleExport(value: unknown): PrincipleExport {
  const list = (value as { principles?: unknown } | null)?.principles
  if (!Array.isArray(list)) throw new Error('Not a principles export: expected { principles: [...] }.')
  const principles: ExportedPrinciple[] = []
  const invalid: PrincipleExport['invalid'] = []
  const seen = new Set<string>()
  list.forEach((raw, index) => {
    const p = (raw ?? {}) as Record<string, unknown>
    const reasons = checkPrinciple(p)
    if (!PRINCIPLE_STATUSES.includes(p.status as PrincipleStatus)) reasons.push(`status must be one of ${PRINCIPLE_STATUSES.join(', ')}.`)
    if (typeof p.id === 'string' && seen.has(p.id)) reasons.push(`Principle id "${p.id}" appears more than once.`)
    if (reasons.length) { invalid.push({ index, ...(typeof p.id === 'string' ? { id: p.id } : {}), reasons }); return }
    seen.add(p.id as string)
    principles.push({
      id: p.id as string,
      text: (p.text as string).trim(),
      status: p.status as PrincipleStatus,
      ...(Array.isArray(p.appliesTo) && p.appliesTo.length ? { appliesTo: (p.appliesTo as string[]).map((x) => x.trim()) } : {}),
      ...(Array.isArray(p.examples) && p.examples.length ? { examples: (p.examples as string[]).map((x) => x.trim()) } : {}),
    })
  })
  return { principles, invalid }
}

/** The principles the provider stands behind: confirmed and edited ones. */
export function acceptedPrinciples(exported: PrincipleExport): ExportedPrinciple[] {
  return exported.principles.filter((p) => p.status !== 'rejected')
}

const same = (a: string[] | undefined, b: string[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

export interface PrincipleImportPlan {
  changes: Array<{ type: 'principle.set'; principle: PrincipleInput }>
  /** Already active with the same content. */
  unchanged: string[]
  /** Rejected by the provider; not recorded. */
  skipped: string[]
}

/** What an import would record against the current state. Pure. */
export function planPrincipleImport(state: CompanyIntent, exported: PrincipleExport): PrincipleImportPlan {
  const plan: PrincipleImportPlan = { changes: [], unchanged: [], skipped: [] }
  for (const p of exported.principles) {
    if (p.status === 'rejected') { plan.skipped.push(p.id); continue }
    const current = state.principles[p.id]
    if (current && current.text === p.text && same(current.appliesTo, p.appliesTo) && same(current.examples, p.examples)) { plan.unchanged.push(p.id); continue }
    plan.changes.push({ type: 'principle.set', principle: { id: p.id, text: p.text, ...(p.appliesTo ? { appliesTo: p.appliesTo } : {}), ...(p.examples ? { examples: p.examples } : {}) } })
  }
  return plan
}

export interface PrincipleImportResult {
  recorded: Array<{ id: string; seq: number; changed: boolean }>
  unchanged: string[]
  skipped: string[]
  invalid: PrincipleExport['invalid']
  refused: Array<{ id: string; reasons: string[] }>
}

/** Record an export's confirmed and edited principles in a company's intent ledger, as `actor`. */
export async function importPrinciples(store: LedgerStore, companyId: string, actor: Principal, exported: PrincipleExport, options: Parameters<typeof recordChange>[4] = {}): Promise<PrincipleImportResult> {
  const state = replay(await loadLedger(store, companyId, options.publicKey))
  const plan = planPrincipleImport(state, exported)
  const out: PrincipleImportResult = { recorded: [], unchanged: plan.unchanged, skipped: plan.skipped, invalid: exported.invalid, refused: [] }
  for (const change of plan.changes) {
    const r = await recordChange(store, companyId, actor, change as IntentChange, options)
    if (r.ok) out.recorded.push({ id: change.principle.id, seq: r.entry.seq, changed: !!state.principles[change.principle.id] })
    else out.refused.push({ id: change.principle.id, reasons: r.reasons })
  }
  return out
}

/** Active principles, oldest first (stable order for prompts). */
export function listPrinciples(state: CompanyIntent): Principle[] {
  return Object.values(state.principles ?? {}).sort((a, b) => a.setAt.localeCompare(b.setAt) || a.id.localeCompare(b.id))
}

/** The principles' texts, as given to a model. */
export function principleTexts(state: CompanyIntent): string[] {
  return listPrinciples(state).map((p) => p.text)
}

/**
 * The texts of a company's active principles, for a model prompt. An empty
 * list when the company has no ledger yet; a ledger that fails verification
 * throws (LedgerIntegrityError) rather than being trusted.
 */
export async function loadPrincipleTexts(store: LedgerStore, companyId: string, publicKey?: Parameters<typeof loadLedger>[2]): Promise<string[]> {
  const ledger = await loadLedger(store, companyId, publicKey)
  return ledger.entries.length ? principleTexts(replay(ledger)) : []
}
