/** Operate on the host (M6): the store, and the plan / approve-plan / status commands. Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { FileLedgerStore, recordChange } from '@quicksilver/aura'
import { appendMoney, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import type { ApprovedPlan } from '@quicksilver/kernel/playbooks/operate'
import type { ShadowLog } from '@quicksilver/kernel/playbooks/shadow'

import { departmentStatus, OperateStore } from './operate-store.ts'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const cli = join(here, 'operate-cli.ts')
const RUN = 'operate-nuera'
const founder = { id: 'entity-founder', kind: 'human' as const }

/**
 * Assert a written file is owner-only. Windows has no POSIX mode bits, so
 * `chmod` is a no-op and access there is governed by ACLs instead; the 0o600
 * contract is therefore only assertable on POSIX platforms.
 */
async function assertOwnerOnly(path: string): Promise<void> {
  if (process.platform === 'win32') return
  assert.equal((await stat(path)).mode & 0o777, 0o600)
}

async function operate(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], {
      cwd: repo,
      env: { ...process.env, INIT_CWD: repo, QUICKSILVER_OPERATE_DIR: join(dir, 'operate'), QUICKSILVER_INTENT_DIR: join(dir, 'intent'), QUICKSILVER_HOST_CONFIG: join(dir, 'no-host.json'), ...env },
    })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string }
    return { code: err.code, out: err.stdout + err.stderr }
  }
}

async function seedLedger(dir: string) {
  const now = Date.now()
  let l: MoneyLedger = { runId: RUN, budgetUsd: 0, entries: [] }
  for (const [kind, amountUsd, daysAgo] of [['revenue', 2000, 5], ['spend', 300, 4], ['compute', 100, 3], ['refund', 50, 2]] as const) {
    const at = new Date(now - daysAgo * 86_400_000)
    const r = appendMoney(l, { kind, amountUsd, category: kind === 'revenue' ? 'sales' : 'hosting', description: kind, source: { type: 'bank', ref: `s${daysAgo}` }, occurredAt: at.toISOString(), ...((kind === 'spend' || kind === 'compute') ? { spendAuthorization: { decisionId: `decision-${daysAgo}`, recommendation: 'execute-autonomously' as const, riskLevel: 1 as const, reasons: [], confirmedBy: founder.id, confirmedAt: at.toISOString() } } : {}) }, founder, at)
    assert.ok(r.ok)
    if (r.ok) l = r.ledger
  }
  await new OperateStore(join(dir, 'operate'), RUN).saveLedger(l)
}

test('store: plans are append-only and written atomically with mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-operate-'))
  try {
    const store = new OperateStore(dir, RUN)
    assert.deepEqual(await store.plans(), [])
    const rec = (seq: number): ApprovedPlan => ({ seq, approvedAt: new Date().toISOString(), approvedBy: 'entity-founder', period: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }, cashOnHandUsd: 0, plan: { surplusUsd: 0, toReserveUsd: 0, reinvestUsd: 0, experimentPoolUsd: 0, keptUsd: 0, needsFounder: true, notes: [] } })
    await store.appendPlan(rec(1))
    await assert.rejects(store.appendPlan(rec(1)), /does not follow/)
    await store.appendPlan(rec(2))
    assert.deepEqual((await store.plans()).map((p) => p.seq), [1, 2])
    await assertOwnerOnly(join(dir, RUN, 'plans.json'))
    // The money ledger may only be appended to.
    let l: MoneyLedger = { runId: RUN, budgetUsd: 0, entries: [] }
    const r = appendMoney(l, { kind: 'revenue', amountUsd: 10, category: 'sales', description: 'x', source: { type: 'bank', ref: 'a' } }, founder, new Date())
    assert.ok(r.ok)
    if (r.ok) l = r.ledger
    await store.saveLedger(l)
    await assert.rejects(store.saveLedger({ ...l, entries: [] }), /appended/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status: effective autonomy is min(grant, shadow evidence)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-operate-'))
  try {
    const intent = join(dir, 'intent')
    const store = new FileLedgerStore(join(intent, 'ledger'))
    const principal = { id: 'entity-founder', kind: 'human' as const, tenantId: 'nuera', roles: ['intent-provider'] }
    assert.ok((await recordChange(store, 'nuera', principal, { type: 'company.create', companyId: 'nuera', tenantId: 'nuera', providers: [{ id: 'entity-founder', kind: 'person', name: 'Founder', authority: 1 }] })).ok)
    for (const [dept, depth] of [['collections', 'act-within-limits'], ['sales', 'act-within-limits'], ['support', 'propose']] as const) {
      assert.ok((await recordChange(store, 'nuera', principal, { type: 'goal.set', goal: { id: `dept.${dept}`, label: dept, horizon: 'year', serves: [] } })).ok)
      assert.ok((await recordChange(store, 'nuera', principal, { type: 'autonomy.set', goalId: `dept.${dept}`, depth })).ok)
    }
    const at = new Date().toISOString()
    const log: ShadowLog = { recommendations: [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, department: 'collections', description: 'remind', proposedAt: at, kernel: { recommendation: 'execute-autonomously' as const, riskLevel: 1 }, executed: false as const, verdict: { value: 'accepted' as const, by: 'entity-founder', at } })),
      { id: 's1', department: 'sales', description: 'follow up', proposedAt: at, kernel: { recommendation: 'request-approval' as const, riskLevel: 2 }, executed: false as const },
    ] }
    await mkdir(join(intent, 'onboard', 'intent-1'), { recursive: true })
    await writeFile(join(intent, 'onboard', 'intent-1', 'shadow.json'), JSON.stringify(log))
    const { departments } = await departmentStatus(intent, 'nuera', { minJudged: 20, minAgreement: 0.8 })
    const by = Object.fromEntries(departments.map((d) => [d.department, d]))
    assert.equal(by.collections!.effective, 'act-within-limits')
    assert.equal(by.sales!.effective, 'act-with-approval', 'evidence caps it')
    assert.equal(by.support!.effective, 'propose', 'the grant is the ceiling')
    const s = await operate(dir, ['status'])
    assert.equal(s.code, 0, s.out)
    assert.match(s.out, /sales: granted act-within-limits → effective act-with-approval/)
    assert.match(s.out, /No approved reinvestment plan yet/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plan and approve-plan: a proposal, then the founder\'s append-only approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-operate-'))
  try {
    await seedLedger(dir)
    const missing = await operate(dir, ['plan'])
    assert.notEqual(missing.code, 0)
    assert.match(missing.out, /--cash/)
    // Surplus 2,000 − (300 + 100 − 50) = 1,650; reserve 1,000 − 600 = 400; reinvest 625; pool 187.50; kept 625.
    const p = await operate(dir, ['plan', '--cash', '600'])
    assert.equal(p.code, 0, p.out)
    assert.match(p.out, /Surplus \$1650\.00: reserve top-up \$400\.00, reinvest \$625\.00 \(experiment pool \$187\.50\), kept \$625\.00/)
    const plansPath = join(dir, 'operate', RUN, 'plans.json')
    await assert.rejects(readFile(plansPath), 'plan writes nothing')

    const byAgent = await operate(dir, ['approve-plan', '--cash', '600'], { QUICKSILVER_OPERATE_ACTOR: 'agent-ops', QUICKSILVER_OPERATE_ACTOR_KIND: 'agent' })
    assert.notEqual(byAgent.code, 0)
    assert.match(byAgent.out, /Only a human approves/)
    const byOther = await operate(dir, ['approve-plan', '--cash', '600'], { QUICKSILVER_OPERATE_ACTOR: 'someone-else' })
    assert.notEqual(byOther.code, 0)
    assert.match(byOther.out, /Only the founder/)

    const ok = await operate(dir, ['approve-plan', '--cash', '600', 'first cycle'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /Approved plan #1/)
    const plans = JSON.parse(await readFile(plansPath, 'utf8')) as ApprovedPlan[]
    assert.equal(plans.length, 1)
    assert.equal(plans[0]!.plan.experimentPoolUsd, 187.5)
    assert.equal(plans[0]!.approvedBy, 'entity-founder')
    assert.equal(plans[0]!.note, 'first cycle')
    await assertOwnerOnly(plansPath)

    // The next period starts where the approved one ended: its money is not counted again.
    const again = await operate(dir, ['plan', '--cash', '600'])
    assert.match(again.out, /No surplus/)
    const status = await operate(dir, ['status'])
    assert.match(status.out, /Latest approved plan #1 .*experiment pool \$187\.50, committed \$0\.00/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('departments: Operate derives a unit-economics proposal from verified evidence and records founder approval without executing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-operate-departments-'))
  try {
    await seedLedger(dir)
    const approvedPlan = await operate(dir, ['approve-plan', '--cash', '5000'])
    assert.equal(approvedPlan.code, 0, approvedPlan.out)
    const inputPath = join(dir, 'department-economics.json')
    const policy = {
      schemaVersion: 1, playbookId: 'operate', version: 1, owner: 'entity-founder',
      minimumPeriodsForSpawn: 2, minimumPeriodsForFund: 2, minimumPeriodsForRetirement: 3,
      spawnReturnMultiple: 1.5, fundReturnMultiple: 1.25, shrinkBelowReturnMultiple: 0.8, retireBelowReturnMultiple: 0.2,
    }
    const candidate = {
      departmentId: 'market-intelligence', status: 'candidate', qualifyingPeriods: 3,
      netContributionUsd: 180, capitalUsedUsd: 100, currentBudgetUsd: 0, proposedBudgetUsd: 50,
      evidenceRefs: ['ledger:1', 'ledger:2', 'ledger:3'],
    }
    await writeFile(inputPath, JSON.stringify({ policy, candidates: [candidate] }))
    const proposalRun = await operate(dir, ['departments', 'propose', inputPath])
    assert.equal(proposalRun.code, 0, proposalRun.out)
    assert.match(proposalRun.out, /spawn proposed/i)
    assert.match(proposalRun.out, /No department was changed and no money moved/)
    const store = new OperateStore(join(dir, 'operate'), RUN)
    const [stored] = await store.departmentProposals()
    assert.ok(stored)
    assert.equal(stored!.decisions.length, 0)
    const actionId = stored!.portfolio.proposals[0]!.proposalId
    const decisionRun = await operate(dir, ['departments', 'decide', stored!.portfolio.proposalId, '--approve', actionId, '--note', 'Approved using the verified ledger evidence.'])
    assert.equal(decisionRun.code, 0, decisionRun.out)
    assert.match(decisionRun.out, /Approval records intent only; apply it with: npm run operate -- departments apply/)
    const reviewed = await store.departmentProposals()
    assert.deepEqual(reviewed[0]!.decisions[0]!.approvedActionIds, [actionId])
    assert.equal(reviewed[0]!.portfolio.digest, stored!.portfolio.digest)

    const unavailableSanity = await operate(dir, ['departments', 'apply', stored!.portfolio.proposalId], {
      NEXT_PUBLIC_SANITY_PROJECT_ID: '', SANITY_WRITE_TOKEN: '', SANITY_AUTH_TOKEN: '',
    })
    assert.notEqual(unavailableSanity.code, 0)
    assert.match(unavailableSanity.out, /No dedicated Nuera Sanity write client is configured/)
    assert.equal((await store.departmentProposals())[0]!.decisions[0]!.digest, stored!.portfolio.digest, 'credential failure must preserve the exact approval record')

    const agentDecision = await operate(dir, ['departments', 'decide', stored!.portfolio.proposalId, '--approve', actionId, '--note', 'Agents may not approve.'], { QUICKSILVER_OPERATE_ACTOR_KIND: 'agent' })
    assert.notEqual(agentDecision.code, 0)
    assert.match(agentDecision.out, /Only a human founder/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
