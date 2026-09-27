/**
 * Operate (M6) files on the host: data/operate/<runId>/{ledger,plans,experiments}.json.
 *
 * - The money ledger is the kernel's hash-chained MoneyLedger (budget 0: the
 *   business's books, not a fixed run budget). It is verified on every load.
 * - plans.json is append-only: a new approval is appended, never edited.
 * - Every write goes to a temp file and is renamed into place, mode 0o600.
 * - Department autonomy reads the provider's grants from the Aura intent
 *   ledger (as `npm run onboard -- handover` records them) and the shadow
 *   evidence from data/intent/onboard/<intentId>/shadow.json.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { FileLedgerStore, loadLedger, replay, type CompanyIntent } from '@quicksilver/aura'
import { verifyMoneyLedger, type Experiment, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import { AUTONOMY_DEPTHS, departmentAutonomy, minDepth, type ApprovedPlan, type AutonomyDepth, type DepartmentAutonomy } from '@quicksilver/kernel/playbooks/operate'
import { shadowReport, type HandOverRules, type ShadowLog } from '@quicksilver/kernel/playbooks/shadow'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e }
}

/** Atomic write: temp file, then rename. Mode 0o600. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 })
  await rename(tmp, path)
}

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export class OperateStore {
  readonly dir: string
  readonly runId: string
  constructor(dataDir: string, runId: string) {
    if (!RUN_ID.test(runId)) throw new Error('Invalid runId.')
    this.dir = join(dataDir, runId)
    this.runId = runId
  }
  private path(name: 'ledger' | 'plans' | 'experiments') { return join(this.dir, `${name}.json`) }

  async ledger(): Promise<MoneyLedger> {
    const l = await readJson<MoneyLedger>(this.path('ledger'), { runId: this.runId, budgetUsd: 0, entries: [] })
    const v = verifyMoneyLedger(l)
    if (!v.valid) throw new Error(`The Operate money ledger does not verify: ${v.errors.join(' ')}`)
    return l
  }
  async saveLedger(l: MoneyLedger): Promise<void> {
    const v = verifyMoneyLedger(l)
    if (!v.valid) throw new Error(`Refusing to save a ledger that does not verify: ${v.errors.join(' ')}`)
    const before = await this.ledger()
    // Append-only: the saved ledger must extend what is on disk.
    if (l.entries.length < before.entries.length || before.entries.some((e, i) => l.entries[i]?.hash !== e.hash)) throw new Error('The ledger may only be appended to.')
    await writeJsonAtomic(this.path('ledger'), l)
  }
  async plans(): Promise<ApprovedPlan[]> { return readJson<ApprovedPlan[]>(this.path('plans'), []) }
  /** Append one approved plan (append-only; its seq must follow the last). */
  async appendPlan(record: ApprovedPlan): Promise<ApprovedPlan[]> {
    const plans = await this.plans()
    if (record.seq !== (plans.at(-1)?.seq ?? 0) + 1) throw new Error(`Plan ${record.seq} does not follow plan ${plans.at(-1)?.seq ?? 0}.`)
    const next = [...plans, record]
    await writeJsonAtomic(this.path('plans'), next)
    return next
  }
  async experiments(): Promise<Experiment[]> { return readJson<Experiment[]>(this.path('experiments'), []) }
  async saveExperiments(list: Experiment[]): Promise<void> { await writeJsonAtomic(this.path('experiments'), list) }
}

/**
 * The provider's grant for a department (goal `dept.<department>`). With more
 * than one provider, the lowest grant any of them set applies.
 */
export function grantedAutonomy(state: CompanyIntent | null, department: string): AutonomyDepth | undefined {
  if (!state) return undefined
  let granted: AutonomyDepth | undefined
  for (const byGoal of Object.values(state.autonomy)) {
    const d = byGoal[`dept.${department}`]
    if (d && AUTONOMY_DEPTHS.includes(d)) granted = granted ? minDepth(granted, d) : d
  }
  return granted
}

/** All Onboard shadow logs under <intentDir>/onboard/*, merged. */
export async function loadShadowLogs(intentDir: string): Promise<ShadowLog> {
  const base = join(intentDir, 'onboard')
  let ids: string[] = []
  try { ids = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort() } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const recommendations: ShadowLog['recommendations'] = []
  for (const id of ids) recommendations.push(...(await readJson<ShadowLog>(join(base, id, 'shadow.json'), { recommendations: [] })).recommendations)
  return { recommendations }
}

/** Each department's granted vs effective autonomy, from the intent ledger and the shadow logs. */
export async function departmentStatus(intentDir: string, companyId: string, rules: HandOverRules): Promise<{ departments: DepartmentAutonomy[]; notes: string[] }> {
  const notes: string[] = []
  let state: CompanyIntent | null = null
  try {
    const ledger = await loadLedger(new FileLedgerStore(join(intentDir, 'ledger')), companyId)
    if (ledger.entries.length) state = replay(ledger)
    else notes.push(`No intent ledger for ${companyId}: nothing is granted. Grant with: npm run onboard -- handover ${companyId} <department> <depth>`)
  } catch (error) {
    notes.push(`The intent ledger could not be read: ${(error as Error).message}. Treating every department as advise.`)
  }
  const reports = shadowReport(await loadShadowLogs(intentDir), rules)
  const granted = new Set<string>()
  for (const byGoal of Object.values(state?.autonomy ?? {})) for (const g of Object.keys(byGoal)) if (g.startsWith('dept.')) granted.add(g.slice(5))
  const names = [...new Set([...reports.map((r) => r.department), ...granted])].sort()
  return { departments: names.map((d) => departmentAutonomy(reports.find((r) => r.department === d), grantedAutonomy(state, d), d)), notes }
}
