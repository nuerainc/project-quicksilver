/**
 * Genesis run commands (M5), run on the founder's computer or the always-on host.
 *
 *   npm run genesis -- check
 *   npm run genesis -- experiment draft <definition.json>
 *   npm run genesis -- experiment start <experimentId>
 *   npm run genesis -- measure <experimentId> <value> "<source>"
 *   npm run genesis -- evaluate <experimentId>
 *   npm run genesis -- decide <experimentId> ["note"]
 *   npm run genesis -- spend <amountUsd> <category> "<what>" --source <type>:<ref> [--experiment <id>] [--confirm]
 *   npm run genesis -- compute <amountUsd> "<what>" --source provider-usage:<ref> [--experiment <id>]
 *   npm run genesis -- revenue <amountUsd> "<what>" --source <type>:<ref> [--experiment <id>]
 *   npm run genesis -- refund <amountUsd> <category> "<what>" --source <type>:<ref>
 *   npm run genesis -- status
 *   npm run genesis -- review <file-or-"text"> --channel <c> [--experiment <id>] pass|revise|block ["note"]
 *   npm run genesis -- reviews
 *   npm run genesis -- check-content <file-or-"text"> [--proposer <actorId>]
 *
 * These commands RECORD money that has already moved and apply the fixed
 * rules. They never move money. Data lives in data/genesis/<runId>/ (gitignored),
 * or in Sanity with QUICKSILVER_GENESIS_STORE=sanity (moneyEntry and
 * experimentRecord documents; see genesis-store.ts).
 * You act as QUICKSILVER_GENESIS_ACTOR (default entity-founder), a human;
 * `evaluate` acts as the kernel, which may only kill, continue or close.
 *
 * `review` records a MANUAL FOUNDER REVIEW of the exact text (you, a human, are
 * the reviewer). It is never a WAES run and is always labeled as manual. The
 * review commands send and publish nothing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
  startExperiment,
  type Experiment,
  type ExperimentDefinition,
  type MoneyEntryInput,
  type MoneyKind,
  type MoneyLedger,
} from '@quicksilver/kernel/playbooks/economics'
import { decideSpend, genesisBlockers, genesisFacts, validateGenesisConfig, type GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { loadHostConfig } from './config.ts'
import { contentStatus, createManualReview, MANUAL_REVIEW_LABEL, parseContentReviewInput, readContentArg, reviewSummary } from './genesis-reviews.ts'
import { genesisStoresFromEnv, MoneyLedgerIntegrityError, runStartedAt } from './genesis-store.ts'
import { SecretsVault } from './vault.ts'

const root = process.env.INIT_CWD ?? process.cwd()
const configPath = resolve(root, process.env.QUICKSILVER_GENESIS_CONFIG ?? 'deploy/genesis/genesis-500.json')
const actorId = process.env.QUICKSILVER_GENESIS_ACTOR || 'entity-founder'
const founder = { id: actorId, kind: 'human' as const }
const kernelActor = { id: 'kernel', kind: 'service' as const }
const [cmd, ...args] = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const VALUE_FLAGS = ['--source', '--experiment', '--channel', '--proposer']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1]!)))

function fail(message: string): never { console.error(message); process.exit(1) }
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e }
}
async function writeJson(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

const config = JSON.parse(await readFile(configPath, 'utf8')) as GenesisRunConfig
const configErrors = validateGenesisConfig(config)
if (configErrors.length) fail(`The run config is invalid:\n  - ${configErrors.join('\n  - ')}`)
const dataDir = resolve(root, process.env.QUICKSILVER_GENESIS_DIR ?? 'data/genesis')
const stores = await genesisStoresFromEnv({ dir: dataDir, budgetUsd: config.budgetUsd }).catch((e: Error) => fail(e.message))
const runPath = join(dataDir, config.runId, 'run.json')
let entries: MoneyLedger['entries']
try {
  entries = await stores.ledger.load(config.runId)
} catch (error) {
  if (error instanceof MoneyLedgerIntegrityError) fail(error.message)
  throw error
}
const ledger: MoneyLedger = { runId: config.runId, budgetUsd: config.budgetUsd, entries }
const experiments = await stores.experiments.list(config.runId)
// The file layout keeps run.json; Sanity derives the start from the first experiment started.
const run = stores.kind === 'file'
  ? await readJson<{ startedAt: string | null }>(runPath, { startedAt: runStartedAt(experiments) })
  : { startedAt: runStartedAt(experiments) }
async function saveExperiment(i: number, exp: Experiment) {
  await stores.experiments.put(config.runId, exp)
  experiments[i] = exp
}

async function vaultNames(): Promise<{ names: string[]; note?: string }> {
  try {
    const host = await loadHostConfig(resolve(root, process.env.QUICKSILVER_HOST_CONFIG ?? 'quicksilver.host.json'), { tenantId: process.env.QUICKSILVER_TENANT_ID?.trim() || 'default' })
    if (!host.vault) return { names: [], note: 'No vault is configured in the host config.' }
    const masterKey = process.env[host.vault.keyEnv]
    if (!masterKey) return { names: [], note: `${host.vault.keyEnv} is not set, so the vault can't be checked.` }
    const vault = new SecretsVault({ path: host.vault.path, masterKey, tenantId: host.tenantId, access: new AccessController(), audit: () => {} })
    await vault.open()
    const admin = { id: `genesis-cli:${actorId}`, kind: 'human' as const, tenantId: host.tenantId, roles: ['tenant-admin'] }
    return { names: (await vault.list(admin)).filter((s) => !s.disabled).map((s) => s.name) }
  } catch (error) {
    return { names: [], note: `The vault could not be read: ${(error as Error).message}` }
  }
}

function findExperiment(id: string | undefined): [Experiment, number] {
  const i = experiments.findIndex((e) => e.definition.id === id)
  if (!id || i < 0) fail(`No experiment "${id}". Draft one with: npm run genesis -- experiment draft <file.json>`)
  return [experiments[i]!, i]
}
function parseSource(): MoneyEntryInput['source'] {
  const raw = flag('--source') ?? ''
  const at = raw.indexOf(':')
  const type = raw.slice(0, at) as MoneyEntryInput['source']['type']
  if (at < 1 || !MONEY_SOURCES.includes(type)) fail(`--source must be <type>:<ref>, type one of ${MONEY_SOURCES.join(', ')}.`)
  return { type, ref: raw.slice(at + 1) }
}
const usd = (n: number) => `$${n.toFixed(2)}`

switch (cmd) {
  case 'check': {
    const playbook = JSON.parse(await readFile(resolve(root, 'deploy/playbooks', `${config.playbookId}.json`), 'utf8')) as PlaybookDefinition
    const pv = validatePlaybook(playbook)
    console.log(`Run ${config.runId}: ${usd(config.budgetUsd)} over ${config.durationDays} days, digital only. Playbook ${playbook.id} v${playbook.version}: ${pv.valid ? 'valid' : `INVALID (${pv.errors.join(' ')})`}.`)
    const vault = await vaultNames()
    if (vault.note) console.log(`  ! ${vault.note}`)
    const blockers = genesisBlockers(config, vault.names)
    if (blockers.length) { console.log('The run cannot start yet:'); for (const b of blockers) console.log(`  - ${b}`) }
    else console.log('Ready: nothing blocks the run.')
    break
  }
  case 'experiment': {
    const [sub, arg] = positional
    if (sub === 'draft') {
      if (!arg) fail('Usage: experiment draft <definition.json>')
      const def = JSON.parse(await readFile(resolve(root, arg), 'utf8')) as ExperimentDefinition
      if (def.playbookId !== config.playbookId) fail(`The experiment belongs to playbook "${def.playbookId}", not "${config.playbookId}".`)
      if (experiments.some((e) => e.definition.id === def.id)) fail(`Experiment "${def.id}" already exists; a changed experiment needs a new id.`)
      const d = draftExperiment(def)
      if (!d.ok) fail(d.reasons.join(' '))
      await saveExperiment(experiments.length, d.experiment)
      console.log(`Drafted ${def.id} (digest ${d.experiment.digest.slice(0, 12)}…). Start it with: npm run genesis -- experiment start ${def.id}`)
    } else if (sub === 'start') {
      const [exp, i] = findExperiment(arg)
      const vault = await vaultNames()
      const blockers = genesisBlockers(config, vault.names)
      if (blockers.length) fail(`The run cannot start experiments yet:\n  - ${blockers.join('\n  - ')}`)
      const now = new Date()
      if (run.startedAt && genesisFacts(config, ledger, experiments, new Date(run.startedAt), now)['run.daysLeft'] as number <= 0) fail('The run has ended.')
      const s = startExperiment(exp, founder, now, { remainingBudgetUsd: moneyTotals(ledger).remainingUsd })
      if (!s.ok) fail(s.reasons.join(' '))
      await saveExperiment(i, s.experiment)
      if (!run.startedAt && stores.kind === 'file') await writeJson(runPath, { startedAt: now.toISOString() })
      console.log(`Started ${exp.definition.id}. Its thresholds are fixed until ${s.experiment.endsAt}.`)
    } else fail('Usage: experiment draft <file.json> | experiment start <experimentId>')
    break
  }
  case 'measure': {
    const [id, raw, source] = positional
    const [exp, i] = findExperiment(id)
    const r = recordMeasurement(exp, Number(raw), founder, source ?? '', new Date())
    if (!r.ok) fail(r.reasons.join(' '))
    await saveExperiment(i, r.experiment)
    console.log(`Recorded ${exp.definition.metric.label}: ${raw}. Evaluate with: npm run genesis -- evaluate ${exp.definition.id}`)
    break
  }
  case 'evaluate':
  case 'decide': {
    const [id, note] = positional
    const [exp, i] = findExperiment(id)
    const ev = evaluateExperiment(exp, moneyTotals(ledger).byExperiment[exp.definition.id]?.capitalUsedUsd ?? 0, new Date())
    console.log(`${exp.definition.id}: ${ev.verdict}. ${ev.explanation}`)
    if (ev.verdict === 'no-data') break
    if (cmd === 'evaluate' && (ev.verdict === 'scale' || ev.verdict === 'hold')) {
      console.log(`Waiting for your decision. Apply it with: npm run genesis -- decide ${exp.definition.id} ["note"]`)
      break
    }
    const r = applyEvaluation(exp, ev, cmd === 'decide' ? founder : kernelActor, new Date(), note)
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
    const experimentId = flag('--experiment')
    const experiment = experimentId ? findExperiment(experimentId)[0] : undefined
    const now = new Date()
    if (cmd === 'spend' || cmd === 'compute') {
      const d = decideSpend(config, ledger, { amountUsd, category, description, ...(experimentId ? { experimentId } : {}) }, now, experiment)
      console.log(`Kernel: ${d.recommendation} (spend risk ${d.riskLevel}).${d.reasons.length ? ` ${d.reasons.join(' ')}` : ''}`)
      if (d.recommendation === 'reject') fail('Not recorded: the rules refuse this spend. If the money already moved outside the rules, stop the run and review it.')
      if (d.recommendation === 'request-approval' && !args.includes('--confirm')) fail('Not recorded: this needs your decision. Re-run with --confirm to approve it as yourself.')
    }
    const r = appendMoney(ledger, { kind: cmd as MoneyKind, amountUsd, category, description, source: parseSource(), ...(experimentId ? { experimentId } : {}) }, founder, now)
    if (!r.ok) fail(r.reasons.join(' '))
    await stores.ledger.append(config.runId, r.entry)
    const t = moneyTotals(r.ledger)
    console.log(`Recorded ${cmd} ${usd(amountUsd)} (entry ${r.entry.seq}). Capital used ${usd(t.capitalUsedUsd)} of ${usd(t.budgetUsd)}; revenue ${usd(t.revenueUsd)}.`)
    break
  }
  case 'status': {
    const t = moneyTotals(ledger)
    const facts = genesisFacts(config, ledger, experiments, run.startedAt ? new Date(run.startedAt) : null, new Date())
    console.log(`Run ${config.runId}: ${run.startedAt ? `started ${run.startedAt.slice(0, 10)}, ${facts['run.daysLeft']} day(s) left` : 'not started'}.`)
    console.log(`  Capital used ${usd(t.capitalUsedUsd)} (compute ${usd(t.computeUsd)}) of ${usd(t.budgetUsd)}; ${usd(t.remainingUsd)} left.`)
    console.log(`  Revenue ${usd(t.revenueUsd)}; net ${usd(t.netUsd)}; return on capital ${t.returnOnCapital ?? '—'}.`)
    for (const e of experiments) {
      const m = e.definition.metric
      const money = t.byExperiment[e.definition.id]
      console.log(`  ${e.definition.id} [${e.status}]: ${e.definition.hypothesis}`)
      console.log(`    ${m.label}: latest ${e.measurements.at(-1)?.value ?? '—'} (kill ${m.kill}, hold ${m.hold}, scale ${m.scale}); spent ${usd(money?.capitalUsedUsd ?? 0)} of ${usd(e.definition.budgetUsd)}`)
    }
    console.log(`  Ledger: ${ledger.entries.length} entries, chain verified.`)
    const rs = reviewSummary(await stores.reviews.list(config.runId))
    console.log(`  WAES reviews: ${rs.waes.total} (pass ${rs.waes.pass}, revise ${rs.waes.revise}, block ${rs.waes.block}).`)
    console.log(`  Manual founder reviews (not WAES): ${rs.manual.total} (pass ${rs.manual.pass}, revise ${rs.manual.revise}, block ${rs.manual.block}); manual reviews are ${config.waesManualReviewAllowed === true ? 'accepted' : 'NOT accepted'} at the WAES gate.`)
    break
  }
  case 'review': {
    const [arg, verdict, note] = positional
    const usage = 'Usage: review <file-or-"text"> --channel <channel> [--experiment <id>] pass|revise|block ["note"]'
    if (!arg) fail(usage)
    const content = await readContentArg(arg, root)
    const experimentId = flag('--experiment')
    if (experimentId) findExperiment(experimentId)
    const parsed = parseContentReviewInput({ text: content.text, channel: flag('--channel'), verdict, ...(note !== undefined ? { note } : {}), ...(experimentId ? { experimentId } : {}) })
    if (!parsed.ok) fail(`${parsed.error}\n${usage}`)
    const r = createManualReview(parsed.input, founder, new Date())
    if (!r.ok) fail(r.reasons.join(' '))
    await stores.reviews.append(config.runId, r.review)
    console.log(`${MANUAL_REVIEW_LABEL}. Recorded ${r.review.verdict} for ${r.review.channel} text ${content.from === 'file' ? `from ${content.path}` : '(from the argument)'}.`)
    console.log(`  reviewId ${r.review.reviewId}`)
    console.log(`  digest   ${r.review.contentDigest}`)
    console.log(`  reviewer ${r.review.reviewer} (human)`)
    if (config.waesManualReviewAllowed !== true) console.log('  ! This run does not accept manual reviews at the WAES gate, so this record alone will not unlock the text.')
    console.log('Nothing was sent or published.')
    break
  }
  case 'reviews': {
    const list = await stores.reviews.list(config.runId)
    if (!list.length) { console.log('No content reviews recorded yet.'); break }
    for (const r of list) {
      const label = r.kind === 'manual' ? 'MANUAL FOUNDER REVIEW (not WAES)' : `WAES (${r.components.join(', ')})`
      const first = r.text.replace(/\s+/g, ' ').trim()
      console.log(`${r.reviewedAt}  ${r.verdict.toUpperCase().padEnd(6)} ${label}  ${r.channel}${r.experimentId ? ` · ${r.experimentId}` : ''} · by ${r.reviewer}`)
      console.log(`  ${r.reviewId}  digest ${r.contentDigest.slice(0, 16)}…`)
      console.log(`  "${first.length > 100 ? `${first.slice(0, 100)}…` : first}"${r.note ? `  note: ${r.note}` : ''}`)
    }
    const rs = reviewSummary(list)
    console.log(`WAES reviews: ${rs.waes.total}. Manual founder reviews: ${rs.manual.total}.`)
    break
  }
  case 'check-content': {
    const [arg] = positional
    if (!arg) fail('Usage: check-content <file-or-"text"> [--proposer <actorId>]')
    const content = await readContentArg(arg, root)
    const proposer = flag('--proposer')
    const st = contentStatus(config, await stores.reviews.list(config.runId), content.text, proposer ?? '\u0000unnamed-proposer')
    console.log(`digest ${st.contentDigest} (${content.from === 'file' ? content.path : 'text from the argument'})`)
    if (!st.review) console.log('No review covers this exact text.')
    else {
      const r = st.review
      console.log(`Latest review of this exact text: ${r.verdict} by ${r.reviewer} at ${r.reviewedAt} (${r.reviewId}), ${st.reviewsOfThisText} review(s) of it in all.`)
      console.log(r.kind === 'manual' ? `  ${MANUAL_REVIEW_LABEL}.` : `  WAES review (${r.components.join(', ')}).`)
    }
    if (st.passes) {
      console.log(`PASSES the WAES gate${st.manual ? ' on a MANUAL founder review (recorded as waes.reviewKind: manual)' : ''}${proposer ? ` for an action proposed by ${proposer}` : ''}.`)
      if (!proposer && st.review) console.log(`  An action proposed by ${st.review.reviewer} would still be refused: the reviewer must differ from the proposer.`)
    } else {
      console.log(`BLOCKED at the WAES gate (${st.facts['waes.review']}): ${st.reason}`)
      process.exitCode = 1
    }
    console.log('Nothing was sent or published.')
    break
  }
  default:
    console.log('Commands: check, experiment draft|start, measure, evaluate, decide, spend, compute, revenue, refund, status, review, reviews, check-content. See the header of packages/host/src/genesis-cli.ts.')
}
