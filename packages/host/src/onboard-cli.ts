/**
 * Onboard pilot commands (M4), run on the founder's computer.
 *
 *   npm run onboard -- start "<objective>"
 *   npm run onboard -- answer <intentId> <variableId> "<your answer>"
 *   npm run onboard -- dismiss <intentId> <variableId>      (a question not worth asking)
 *   npm run onboard -- connect <intentId> <ledger.csv>
 *   npm run onboard -- backtest <intentId>
 *   npm run onboard -- recommend <intentId> <department> "<what to do>" [--kernel execute-autonomously|request-approval|reject] [--risk 0-5]
 *   npm run onboard -- judge <intentId> <recommendationId> accepted|modified|rejected ["note"]
 *   npm run onboard -- outcome <intentId> <recommendationId> good|neutral|bad ["note"]
 *   npm run onboard -- status <intentId>
 *   npm run onboard -- company <companyId> "<your name>"
 *   npm run onboard -- handover <companyId> <department> advise|propose|act-with-approval|act-within-limits ["reason"]
 *
 * Data lives in data/intent (git-ignored), the same place the local host's
 * intent API reads, so graphs show up there too. Nothing here acts on the
 * business: connectors only read, and shadow mode only records
 * recommendations and your verdicts.
 *
 * You act as QUICKSILVER_ONBOARD_ACTOR (default entity-founder).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  applyBeliefUpdate,
  AUTONOMY_DEPTHS,
  backtestRevenue,
  FileLedgerStore,
  loadLedger,
  recordChange,
  replay,
  createIntent,
  FileIntentGraphStore,
  monthlyTotals,
  observeInto,
  readCsvLedger,
  scoreImpact,
  openQuestions,
  questionQuality,
  recordQuestionFeedback,
  learnFromAnswer,
  learnFromDismissal,
  newRanker,
  learnFromVerdict,
  newVerdictLearner,
  predictAccept,
  predictionAgreement,
  type LearnerState,
  type Transaction,
} from '@quicksilver/aura'
import { availableTransitions, nextAutomaticTransition, type Facts } from '@quicksilver/kernel/process'
import { validatePlaybook, type PlaybookDefinition } from '@quicksilver/kernel/playbooks'
import { fileRankerStore } from './ranker-store.ts'
import { judge, recommend, recordOutcome, shadowFacts, shadowReport, type Outcome, type ShadowLog, type Verdict } from '@quicksilver/kernel/playbooks/shadow'

const root = process.env.INIT_CWD ?? process.cwd()
const dir = resolve(root, process.env.QUICKSILVER_INTENT_DIR ?? 'data/intent')
const graphs = new FileIntentGraphStore(join(dir, 'graphs'))
const actorId = process.env.QUICKSILVER_ONBOARD_ACTOR || 'entity-founder'
const human = { id: actorId, kind: 'human' as const }
const tenantId = process.env.QUICKSILVER_TENANT_ID || 'nuera'
const ledgerStore = new FileLedgerStore(join(dir, 'ledger'))
// The provider's learned question order (train it with: npm run aura:rank -- train --out data/intent/ranker.json).
const rankerStore = fileRankerStore(join(dir, 'ranker.json'))
const ranker = await rankerStore.load()
// The local, trusted command line acts as the founder's principal.
const principal = { id: actorId, kind: 'human' as const, tenantId, roles: ['intent-provider'] }
const [cmd, ...args] = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')))

function fail(message: string): never { console.error(message); process.exit(1) }
const workDir = (id: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) fail('Invalid intent id.'); return join(dir, 'onboard', id) }
async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e }
}
async function writeJsonFile(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 1), { mode: 0o600 })
}
async function graphOrFail(id: string) { const g = await graphs.get(id).catch(() => undefined); if (!g) fail(`No intent "${id}". Start one with: npm run onboard -- start "<objective>"`); return g }

switch (cmd) {
  case 'start': {
    const objective = positional[0]
    if (!objective) fail('Usage: start "<objective>"')
    const { graph } = await createIntent(objective, { requestedBy: actorId, id: `intent-${Date.now().toString(36)}`, mode: 'onboard' })
    await graphs.put(graph)
    console.log(`Intent ${graph.id} (onboard).`)
    for (const q of openQuestions(graph, ranker).slice(0, 3)) console.log(`  ? ${q.variableId}: ${q.question}`)
    break
  }
  case 'answer': {
    const [id, variableId, answer] = positional
    if (!id || !variableId || !answer?.trim()) fail('Usage: answer <intentId> <variableId> "<your answer>"')
    const graph = await graphOrFail(id)
    const numeric = /^\s*\$?\s*-?\d[\d,]*(\.\d+)?\s*$/.test(answer) ? Number(answer.replace(/[$,\s]/g, '')) : undefined
    const fb = recordQuestionFeedback(graph, human, variableId, 'answered', new Date(), ranker)
    const openBefore = openQuestions(graph, ranker).map((q) => q.variableId)
    const r = applyBeliefUpdate(fb.ok ? fb.graph : graph, human, { variableId, value: numeric ?? answer.trim(), provenance: 'HUMAN_SPECIFIED', confidence: 1, sources: [{ type: 'human', ref: actorId, quote: answer.trim() }] })
    if (!r.accepted) fail(r.reasons.join(' '))
    await graphs.put(r.graph)
    if (fb.ok && ranker) await rankerStore.save(learnFromAnswer(ranker, graph, variableId, openBefore))
    console.log(`Recorded your answer for ${variableId}.`)
    for (const q of openQuestions(r.graph, ranker).slice(0, 3)) console.log(`  ? ${q.variableId}: ${q.question}`)
    break
  }
  case 'dismiss': {
    const [id, variableId] = positional
    if (!id || !variableId) fail('Usage: dismiss <intentId> <variableId>')
    const graph = await graphOrFail(id)
    const r = recordQuestionFeedback(graph, human, variableId, 'not-worth-asking', new Date(), ranker)
    if (!r.ok) fail(r.reason)
    await graphs.put(r.graph)
    const learned = learnFromDismissal(ranker ?? newRanker(), graph, variableId, openQuestions(graph, ranker).map((q) => q.variableId))
    await rankerStore.save(learned)
    console.log(`Noted: "${variableId}" was not worth asking (it was Aura's #${r.feedback.rank} of ${r.feedback.openQuestions}).`)
    for (const q of openQuestions(r.graph, learned).slice(0, 3)) console.log(`  ? ${q.variableId}: ${q.question}`)
    break
  }
  case 'connect': {
    const [id, file] = positional
    if (!id || !file) fail('Usage: connect <intentId> <ledger.csv>')
    const graph = await graphOrFail(id)
    const text = await readFile(resolve(root, file), 'utf8')
    const reading = readCsvLedger(text, { source: file.split(/[\\/]/).at(-1)! })
    for (const w of reading.warnings) console.log(`  ! ${w}`)
    const result = observeInto(graph, reading)
    await graphs.put(result.graph)
    await writeJsonFile(join(workDir(id), 'transactions.json'), { source: reading.source, transactions: reading.transactions })
    await writeJsonFile(join(workDir(id), 'connectors.json'), { connected: [reading.source] })
    console.log(`Connected ${reading.source}: ${reading.transactions.length} transactions.`)
    for (const o of reading.observations) console.log(`  ${o.label}: ${o.value}${o.unit ? ` ${o.unit}` : ''}`)
    for (const r of result.refused) console.log(`  refused ${r.variableId}: ${r.reasons.join(' ')}`)
    break
  }
  case 'backtest': {
    const [id] = positional
    if (!id) fail('Usage: backtest <intentId>')
    await graphOrFail(id)
    const { transactions } = await readJsonFile<{ transactions: Transaction[] }>(join(workDir(id), 'transactions.json'), { transactions: [] })
    if (!transactions.length) fail('Connect a ledger first.')
    const report = backtestRevenue(monthlyTotals(transactions))
    await writeJsonFile(join(workDir(id), 'backtest.json'), report)
    console.log(report.summary)
    for (const r of report.reasons) console.log(`  - ${r}`)
    break
  }
  case 'recommend': {
    const [id, department, description] = positional
    if (!id || !department || !description) fail('Usage: recommend <intentId> <department> "<what to do>"')
    const path = join(workDir(id), 'shadow.json')
    const log = await readJsonFile<ShadowLog>(path, { recommendations: [] })
    const kernel = (flag('--kernel') ?? 'request-approval') as 'execute-autonomously' | 'request-approval' | 'reject'
    const learner = await readJsonFile<LearnerState | null>(join(workDir(id), 'learner.json'), null) ?? newVerdictLearner()
    const draft = { department, kernel: { recommendation: kernel, riskLevel: Number(flag('--risk') ?? 1) } }
    const r = recommend(log, { id: `rec-${log.recommendations.length + 1}`, description, proposedAt: new Date().toISOString(), source: 'human', ...draft, prediction: predictAccept(learner, draft) })
    if (!r.ok) fail(r.reason)
    await writeJsonFile(path, r.log)
    console.log(`Recorded rec-${log.recommendations.length + 1} for ${department}. Nothing was executed.`)
    break
  }
  case 'judge':
  case 'outcome': {
    const [id, recId, value, note] = positional
    const allowed = cmd === 'judge' ? ['accepted', 'modified', 'rejected'] : ['good', 'neutral', 'bad']
    if (!id || !recId || !allowed.includes(value ?? '')) fail(`Usage: ${cmd} <intentId> <recommendationId> ${allowed.join('|')} ["note"]`)
    const path = join(workDir(id), 'shadow.json')
    const log = await readJsonFile<ShadowLog>(path, { recommendations: [] })
    const r = cmd === 'judge' ? judge(log, recId, human, value as Verdict, new Date(), note) : recordOutcome(log, recId, human, value as Outcome, new Date(), note)
    if (!r.ok) fail(r.reason)
    await writeJsonFile(path, r.log)
    if (cmd === 'judge') {
      // Aura learns from the verdict (its own record; never the intent ledger).
      const learnerPath = join(workDir(id), 'learner.json')
      const learner = await readJsonFile<LearnerState | null>(learnerPath, null) ?? newVerdictLearner()
      await writeJsonFile(learnerPath, learnFromVerdict(learner, r.log.recommendations.find((x) => x.id === recId)!, value as Verdict))
    }
    console.log(`Recorded ${cmd} for ${recId}: ${value}.`)
    break
  }
  case 'status': {
    const [id] = positional
    if (!id) fail('Usage: status <intentId>')
    const graph = await graphOrFail(id)
    const playbook = JSON.parse(await readFile(resolve(root, 'deploy/playbooks/onboard.json'), 'utf8')) as PlaybookDefinition
    const v = validatePlaybook(playbook)
    if (!v.valid) fail(`The Onboard playbook is invalid: ${v.errors.join(' ')}`)
    const connectors = await readJsonFile<{ connected: string[] }>(join(workDir(id), 'connectors.json'), { connected: [] })
    const backtest = await readJsonFile<{ passed?: boolean } | null>(join(workDir(id), 'backtest.json'), null)
    const shadow = await readJsonFile<ShadowLog>(join(workDir(id), 'shadow.json'), { recommendations: [] })
    const facts: Facts = {
      'connectors.connected': connectors.connected.length,
      'observed.variables': graph.variables.filter((x) => x.provenance === 'OBSERVED').length,
      'aura.openQuestions': openQuestions(graph, ranker).length,
      ...(backtest ? { 'backtest.passed': backtest.passed === true } : {}),
      ...shadowFacts(shadow),
    }
    // Where the facts put this business in the playbook (automatic transitions only;
    // hand-over is always a human decision in the intent ledger).
    let stage = playbook.process.initialState
    const visited = new Set([stage])
    for (;;) {
      const next = nextAutomaticTransition(playbook.process, stage, facts)
      if (!next?.allowed || !next.to || visited.has(next.to)) break
      stage = next.to
      visited.add(stage)
    }
    console.log(`Intent ${id}: ${graph.objective}`)
    console.log(`Playbook stage: ${stage}`)
    console.log('Facts:', facts)
    const open = openQuestions(graph, ranker).slice(0, 3)
    const qq = questionQuality(await graphs.list())
    if (qq.scored) console.log(`Question quality: ${qq.answered}/${qq.scored} of Aura's top-3 questions answered rather than dismissed (target 80%).`)
    if (open.length) { console.log('Open questions (answer with: npm run onboard -- answer <intentId> <variableId> "..."):'); for (const q of open) console.log(`  ? ${q.variableId}: ${q.question}`) }
    const waiting = availableTransitions(playbook.process, stage, facts).filter((o) => !o.guard.passed || o.transition.requiresHumanApproval)
    for (const o of waiting) console.log(`  next: ${o.transition.label ?? o.transition.id}${o.transition.requiresHumanApproval ? ' (your decision)' : ''}${o.guard.results.length ? ` — ${o.guard.results.filter((r) => !r.passed).map((r) => r.explanation).join('; ')}` : ''}`)
    const agreement = predictionAgreement(shadow)
    if (agreement.scored) console.log(`Aura predicted your verdict ${agreement.agreed}/${agreement.scored} times (made before each verdict).`)
    const report = shadowReport(shadow)
    if (report.length) {
      console.log('Shadow mode by department:')
      for (const d of report) console.log(`  ${d.department}: ${d.judged}/${d.recommendations} judged, agreement ${d.agreement === null ? '—' : `${Math.round(d.agreement * 100)}%`}${d.readyForHandOver ? ' — ready to propose hand-over' : ` — ${d.reasons.join(' ')}`}`)
    }
    break
  }
  case 'company': {
    const [companyId, name] = positional
    if (!companyId || !name) fail('Usage: company <companyId> "<your name>"')
    const r = await recordChange(ledgerStore, companyId, principal, { type: 'company.create', companyId, tenantId, providers: [{ id: actorId, kind: 'person', name, authority: 1 }] })
    if (!r.ok) fail(r.reasons.join(' '))
    console.log(`Created the intent ledger for ${companyId}, with ${actorId} as its intent provider.`)
    break
  }
  case 'handover': {
    const [companyId, department, depth, reason] = positional
    if (!companyId || !department || !AUTONOMY_DEPTHS.includes(depth as never)) fail(`Usage: handover <companyId> <department> ${AUTONOMY_DEPTHS.join('|')} ["reason"]`)
    const goalId = `dept.${department}`
    const state = replay(await loadLedger(ledgerStore, companyId).catch((e) => fail((e as Error).message)))
    if (!state.goals[goalId]) {
      const g = await recordChange(ledgerStore, companyId, principal, { type: 'goal.set', goal: { id: goalId, label: `Run the ${department} department well`, horizon: 'year', serves: [] } })
      if (!g.ok) fail(g.reasons.join(' '))
    }
    const r = await recordChange(ledgerStore, companyId, principal, { type: 'autonomy.set', goalId, depth: depth as (typeof AUTONOMY_DEPTHS)[number] }, reason ? { reason } : {})
    if (!r.ok) fail(r.reasons.join(' '))
    console.log(`Recorded: ${department} may now ${depth}. Entry ${r.entry.seq}, hash ${r.entry.hash.slice(0, 12)}…`)
    break
  }
  default:
    console.log('Commands: start, answer, dismiss, connect, backtest, recommend, judge, outcome, status, company, handover. See the header of packages/host/src/onboard-cli.ts.')
}
