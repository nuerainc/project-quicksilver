/**
 * Operate commands (M6), run on the founder's computer or the always-on host.
 *
 *   npm run operate -- check
 *   npm run operate -- status
 *   npm run operate -- plan --cash <usd>
 *   npm run operate -- approve-plan --cash <usd> ["note"]
 *   npm run operate -- experiment draft <definition.json>
 *   npm run operate -- experiment start <experimentId>
 *   npm run operate -- measure <experimentId> <value> "<source>"
 *   npm run operate -- evaluate <experimentId>
 *   npm run operate -- decide <experimentId> ["note"]
 *   npm run operate -- spend <amountUsd> <category> "<what>" --source <type>:<ref> [--experiment <id>] [--confirm]
 *   npm run operate -- compute <amountUsd> "<what>" --source provider-usage:<ref> [--experiment <id>] [--confirm]
 *   npm run operate -- revenue <amountUsd> "<what>" --source <type>:<ref> [--experiment <id>]
 *   npm run operate -- refund <amountUsd> <category> "<what>" --source <type>:<ref>
 *
 * Autonomy = min(the provider's grant, the shadow evidence). The grant comes
 * from the Aura intent ledger (`npm run onboard -- handover`), the evidence
 * from the Onboard shadow logs. These commands RECORD money that has already
 * moved and apply the fixed rules. They never move money or execute anything.
 * Data lives in data/operate/<runId>/ (gitignored). You act as
 * QUICKSILVER_OPERATE_ACTOR (default entity-founder), a human unless
 * QUICKSILVER_OPERATE_ACTOR_KIND says otherwise; `evaluate` acts as the
 * kernel, which may only kill, continue or complete.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { AccessController } from '@quicksilver/kernel/identity'
import { validatePlaybook, type PlaybookDefinition } from '@quicksilver/kernel/playbooks'
import {
  appendMoney,
  applyEvaluation,
  draftExperiment,
  evaluateExperiment,
  moneyTotals,
  MONEY_SOURCES,
  recordMeasurement,
  type Experiment,
  type ExperimentDefinition,
  type MoneyEntryInput,
  type MoneyKind,
} from '@quicksilver/kernel/playbooks/economics'
import {
  approvePlan,
  committedUsd,
  decideOperateSpend,
  handOverRules,
  operateBlockers,
  operateFacts,
  operatePeriod,
  periodTotals,
  reinvestmentPlan,
  startOperateExperiment,
  validateOperateConfig,
  type OperateConfig,
  type ReinvestmentPlan,
} from '@quicksilver/kernel/playbooks/operate'

import { loadHostConfig } from './config.ts'
import { departmentStatus, OperateStore } from './operate-store.ts'
import { SecretsVault } from './vault.ts'

const root = process.env.INIT_CWD ?? process.cwd()
const configPath = resolve(root, process.env.QUICKSILVER_OPERATE_CONFIG ?? 'deploy/operate/operate-nuera.json')
const actorId = process.env.QUICKSILVER_OPERATE_ACTOR || 'entity-founder'
const actorKind = (['human', 'agent', 'service'] as const).find((k) => k === process.env.QUICKSILVER_OPERATE_ACTOR_KIND) ?? 'human'
const actor = { id: actorId, kind: actorKind }
const kernelActor = { id: 'kernel', kind: 'service' as const }
const tenantId = process.env.QUICKSILVER_TENANT_ID?.trim() || 'nuera'
const [cmd, ...args] = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const VALUE_FLAGS = ['--source', '--experiment', '--cash']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1]!)))

function fail(message: string): never { console.error(message); process.exit(1) }
const usd = (n: number) => `$${n.toFixed(2)}`

const config = JSON.parse(await readFile(configPath, 'utf8')) as OperateConfig
const configErrors = validateOperateConfig(config)
if (configErrors.length) fail(`The Operate config is invalid:\n  - ${configErrors.join('\n  - ')}`)
const dataDir = resolve(root, process.env.QUICKSILVER_OPERATE_DIR ?? 'data/operate')
const intentDir = resolve(root, process.env.QUICKSILVER_INTENT_DIR ?? 'data/intent')
const companyId = config.companyId ?? tenantId
const store = new OperateStore(dataDir, config.runId)
const ledger = await store.ledger().catch((e: Error) => fail(e.message))
const plans = await store.plans()
const experiments = await store.experiments()
const now = new Date()

async function vaultNames(): Promise<{ names: string[]; note?: string }> {
  try {
    const host = await loadHostConfig(resolve(root, process.env.QUICKSILVER_HOST_CONFIG ?? 'quicksilver.host.json'), { tenantId: process.env.QUICKSILVER_TENANT_ID?.trim() || 'default' })
    if (!host.vault) return { names: [], note: 'No vault is configured in the host config.' }
    const masterKey = process.env[host.vault.keyEnv]
    if (!masterKey) return { names: [], note: `${host.vault.keyEnv} is not set, so the vault can't be checked.` }
    const vault = new SecretsVault({ path: host.vault.path, masterKey, tenantId: host.tenantId, access: new AccessController(), audit: () => {} })
    await vault.open()
    const admin = { id: `operate-cli:${actorId}`, kind: 'human' as const, tenantId: host.tenantId, roles: ['tenant-admin'] }
    return { names: (await vault.list(admin)).filter((s) => !s.disabled).map((s) => s.name) }
  } catch (error) {
    return { names: [], note: `The vault could not be read: ${(error as Error).message}` }
  }
}

function findExperiment(id: string | undefined): [Experiment, number] {
  const i = experiments.findIndex((e) => e.definition.id === id)
  if (!id || i < 0) fail(`No experiment "${id}". Draft one with: npm run operate -- experiment draft <file.json>`)
  return [experiments[i]!, i]
}
async function saveExperiment(i: number, exp: Experiment) {
  experiments[i] = exp
  await store.saveExperiments(experiments)
}
function parseSource(): MoneyEntryInput['source'] {
  const raw = flag('--source') ?? ''
  const at = raw.indexOf(':')
  const type = raw.slice(0, at) as MoneyEntryInput['source']['type']
  if (at < 1 || !MONEY_SOURCES.includes(type)) fail(`--source must be <type>:<ref>, type one of ${MONEY_SOURCES.join(', ')}.`)
  return { type, ref: raw.slice(at + 1) }
}
function cash(): number {
  const raw = flag('--cash')
  const n = Number(raw)
  if (raw === undefined || !Number.isFinite(n) || n < 0) fail('--cash <usd> is required: the cash on hand now (zero or more).')
  return n
}
function currentPlan(cashOnHandUsd: number) {
  const period = operatePeriod(config, plans.at(-1)?.period.to, now)
  const totals = periodTotals(ledger, period.from, period.to)
  return { period, totals, plan: reinvestmentPlan(config, totals, cashOnHandUsd) }
}
function printPlan(p: ReinvestmentPlan) {
  console.log(`  Surplus ${usd(p.surplusUsd)}: reserve top-up ${usd(p.toReserveUsd)}, reinvest ${usd(p.reinvestUsd)} (experiment pool ${usd(p.experimentPoolUsd)}), kept ${usd(p.keptUsd)}.`)
  for (const n of p.notes) console.log(`  - ${n}`)
}

switch (cmd) {
  case 'check': {
    const playbook = JSON.parse(await readFile(resolve(root, 'deploy/playbooks', `${config.playbookId}.json`), 'utf8')) as PlaybookDefinition
    const pv = validatePlaybook(playbook)
    console.log(`Operate ${config.runId}: ${config.periodDays}-day periods, reserve floor ${usd(config.reserveFloorUsd)}, experiments up to ${usd(config.maxExperimentUsd)}. Playbook ${playbook.id} v${playbook.version}: ${pv.valid ? 'valid' : `INVALID (${pv.errors.join(' ')})`}.`)
    const vault = await vaultNames()
    if (vault.note) console.log(`  ! ${vault.note}`)
    const blockers = operateBlockers(config, vault.names)
    if (blockers.length) { console.log('Operate cannot move money yet:'); for (const b of blockers) console.log(`  - ${b}`) }
    else console.log('Ready: nothing blocks Operate.')
    break
  }
  case 'status': {
    const { departments, notes } = await departmentStatus(intentDir, companyId, handOverRules(config))
    console.log(`Operate ${config.runId} (company ${companyId}). Autonomy = min(the provider's grant, the shadow evidence).`)
    for (const n of notes) console.log(`  ! ${n}`)
    if (!departments.length) console.log('  No departments yet: grant one with npm run onboard -- handover, or record shadow recommendations.')
    for (const d of departments) console.log(`  ${d.department}: granted ${d.granted ?? 'nothing'} → effective ${d.effective}${d.reasons.length ? ` (${d.reasons.join(' ')})` : ''}`)
    const period = operatePeriod(config, plans.at(-1)?.period.to, now)
    const t = periodTotals(ledger, period.from, period.to)
    console.log(`Period ${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}: revenue ${usd(t.revenueUsd)}; capital used ${usd(t.capitalUsedUsd)} (spend ${usd(t.spendUsd)}, compute ${usd(t.computeUsd)}, refunds ${usd(t.refundsUsd)}); surplus ${usd(t.netUsd)}.`)
    const last = plans.at(-1)
    if (last) console.log(`Latest approved plan #${last.seq} (${last.approvedAt.slice(0, 10)}): experiment pool ${usd(last.plan.experimentPoolUsd)}, committed ${usd(committedUsd(last, plans, experiments))}.`)
    else console.log('No approved reinvestment plan yet: experiments cannot start.')
    const open = experiments.filter((e) => ['draft', 'running', 'held', 'scaled'].includes(e.status))
    const all = moneyTotals(ledger)
    if (!open.length) console.log('No open experiments.')
    for (const e of open) console.log(`  ${e.definition.id} [${e.status}]: spent ${usd(all.byExperiment[e.definition.id]?.capitalUsedUsd ?? 0)} of ${usd(e.definition.budgetUsd)}; latest ${e.definition.metric.label}: ${e.measurements.at(-1)?.value ?? '—'}`)
    const facts = operateFacts({ config, departments, period: t, plans, ledger, experiments, now })
    console.log('Facts:', facts)
    console.log(`Ledger: ${ledger.entries.length} entries, chain verified.`)
    break
  }
  case 'plan': {
    const c = cash()
    const { period, plan } = currentPlan(c)
    console.log(`Reinvestment plan for ${period.from.slice(0, 10)} → ${period.to.slice(0, 10)} (cash on hand ${usd(c)}). A proposal: approve it with approve-plan.`)
    printPlan(plan)
    break
  }
  case 'approve-plan': {
    const c = cash()
    const [note] = positional
    const { period, plan } = currentPlan(c)
    const r = approvePlan(config, plans, plan, period, c, actor, now, note)
    if (!r.ok) fail(`Not approved: ${r.reasons.join(' ')}`)
    await store.appendPlan(r.record)
    console.log(`Approved plan #${r.record.seq} by ${r.record.approvedBy} for ${period.from.slice(0, 10)} → ${period.to.slice(0, 10)}. Experiments are now bounded by ${usd(Math.min(plan.experimentPoolUsd, config.maxExperimentUsd))}.`)
    printPlan(plan)
    console.log('Nothing was moved: the plan is a record of your decision.')
    break
  }
  case 'experiment': {
    const [sub, arg] = positional
    if (sub === 'draft') {
      if (!arg) fail('Usage: experiment draft <definition.json>')
      const def = JSON.parse(await readFile(resolve(root, arg), 'utf8')) as ExperimentDefinition
      if (def.playbookId !== 'operate') fail(`The experiment belongs to playbook "${def.playbookId}", not "operate".`)
      if (experiments.some((e) => e.definition.id === def.id)) fail(`Experiment "${def.id}" already exists; a changed experiment needs a new id.`)
      const d = draftExperiment(def)
      if (!d.ok) fail(d.reasons.join(' '))
      await saveExperiment(experiments.length, d.experiment)
      console.log(`Drafted ${def.id} (digest ${d.experiment.digest.slice(0, 12)}…). Start it with: npm run operate -- experiment start ${def.id}`)
    } else if (sub === 'start') {
      const [exp, i] = findExperiment(arg)
      const vault = await vaultNames()
      const blockers = operateBlockers(config, vault.names)
      if (blockers.length) fail(`Experiments cannot start yet:\n  - ${blockers.join('\n  - ')}`)
      const s = startOperateExperiment(config, exp, actor, now, plans, experiments)
      if (!s.ok) fail(s.reasons.join(' '))
      await saveExperiment(i, s.experiment)
      console.log(`Started ${exp.definition.id} inside plan #${plans.at(-1)!.seq}'s pool. Its thresholds are fixed until ${s.experiment.endsAt}.`)
    } else fail('Usage: experiment draft <file.json> | experiment start <experimentId>')
    break
  }
  case 'measure': {
    const [id, raw, source] = positional
    const [exp, i] = findExperiment(id)
    const r = recordMeasurement(exp, Number(raw), actor, source ?? '', now)
    if (!r.ok) fail(r.reasons.join(' '))
    await saveExperiment(i, r.experiment)
    console.log(`Recorded ${exp.definition.metric.label}: ${raw}. Evaluate with: npm run operate -- evaluate ${exp.definition.id}`)
    break
  }
  case 'evaluate':
  case 'decide': {
    const [id, note] = positional
    const [exp, i] = findExperiment(id)
    const ev = evaluateExperiment(exp, moneyTotals(ledger).byExperiment[exp.definition.id]?.capitalUsedUsd ?? 0, now)
    console.log(`${exp.definition.id}: ${ev.verdict}. ${ev.explanation}`)
    if (ev.verdict === 'no-data') break
    if (cmd === 'evaluate' && (ev.verdict === 'scale' || ev.verdict === 'hold')) {
      console.log(`Waiting for your decision. Apply it with: npm run operate -- decide ${exp.definition.id} ["note"]`)
      break
    }
    const r = applyEvaluation(exp, ev, cmd === 'decide' ? actor : kernelActor, now, note)
    if (!r.ok) fail(r.reasons.join(' '))
    await saveExperiment(i, r.experiment)
    console.log(`Applied: ${exp.definition.id} is now ${r.experiment.status}.`)
    break
  }
  case 'spend':
  case 'compute':
  case 'revenue':
  case 'refund': {
    const hasCategory = cmd === 'spend' || cmd === 'refund'
    const [raw, a, b] = positional
    const amountUsd = Number(raw)
    const category = hasCategory ? a : cmd === 'compute' ? 'compute' : 'sales'
    const description = hasCategory ? b : a
    if (!(amountUsd > 0) || !category || !description) fail(`Usage: ${cmd} <amountUsd> ${hasCategory ? '<category> ' : ''}"<what>" --source <type>:<ref> [--experiment <id>]`)
    const source = parseSource()
    const experimentId = flag('--experiment')
    const experiment = experimentId ? findExperiment(experimentId)[0] : undefined
    let spendAuthorization: MoneyEntryInput['spendAuthorization']
    if (cmd === 'spend' || cmd === 'compute') {
      const d = decideOperateSpend(config, ledger, plans, experiments, { amountUsd, category, description, ...(experimentId ? { experimentId } : {}) }, now, experiment)
      console.log(`Kernel: ${d.recommendation} (spend risk ${d.riskLevel}).${d.reasons.length ? ` ${d.reasons.join(' ')}` : ''}`)
      if (d.recommendation === 'reject') fail('Not recorded: the rules refuse this spend. If the money already moved outside the rules, stop Operate and review it.')
      if (d.recommendation === 'request-approval' && (!args.includes('--confirm') || actor.kind !== 'human')) fail('Not recorded: this needs the founder. Re-run with --confirm to approve it as yourself.')
      spendAuthorization = { decisionId: `spend-${randomUUID()}`, recommendation: d.recommendation, riskLevel: d.riskLevel, reasons: d.reasons, confirmedBy: actor.id, confirmedAt: now.toISOString() }
    }
    const r = appendMoney(ledger, { kind: cmd as MoneyKind, amountUsd, category, description, source, ...(experimentId ? { experimentId } : {}), ...(spendAuthorization ? { spendAuthorization } : {}) }, actor, now)
    if (!r.ok) fail(r.reasons.join(' '))
    await store.saveLedger(r.ledger)
    console.log(`Recorded ${cmd} ${usd(amountUsd)} (entry ${r.entry.seq}). Nothing was moved or executed.`)
    break
  }
  default:
    console.log('Commands: check, status, plan, approve-plan, experiment draft|start, measure, evaluate, decide, spend, compute, revenue, refund. See the header of packages/host/src/operate-cli.ts.')
}
