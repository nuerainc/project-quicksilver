/** What-if CLI on the host (M7 part 3). Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { appendMoney, draftExperiment, recordMeasurement, startExperiment, type Experiment, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import type { ShadowLog, ShadowRecommendation } from '@quicksilver/kernel/playbooks/shadow'

import { OperateStore } from './operate-store.ts'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const cli = join(here, 'whatif-cli.ts')
const RUN = 'operate-nuera'
const founder = { id: 'entity-founder', kind: 'human' as const }
const DAY = 86_400_000

async function whatif(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], {
      cwd: repo,
      env: { ...process.env, INIT_CWD: repo, QUICKSILVER_OPERATE_DIR: join(dir, 'operate'), QUICKSILVER_GENESIS_DIR: join(dir, 'genesis'), QUICKSILVER_GENESIS_STORE: 'file', QUICKSILVER_INTENT_DIR: join(dir, 'intent') },
    })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string }
    return { code: err.code, out: err.stdout + err.stderr }
  }
}

/** Six 30-day periods ending today: revenue 2000, costs 1200 each period. */
async function seedOperate(dir: string) {
  const now = Date.now()
  let l: MoneyLedger = { runId: RUN, budgetUsd: 0, entries: [] }
  for (let p = 5; p >= 0; p--) {
    for (const [kind, amountUsd, offset] of [['revenue', 2000 + p * 50, 20], ['spend', 900, 15], ['compute', 300, 10]] as const) {
      const at = new Date(now - (p * 30 + offset) * DAY)
      const r = appendMoney(l, { kind, amountUsd, category: kind === 'revenue' ? 'sales' : 'hosting', description: kind, source: { type: 'bank', ref: `p${p}${kind}` }, occurredAt: at.toISOString(), ...((kind === 'spend' || kind === 'compute') ? { spendAuthorization: { decisionId: `decision-p${p}-${kind}`, recommendation: 'execute-autonomously' as const, riskLevel: 1 as const, reasons: [], confirmedBy: founder.id, confirmedAt: at.toISOString() } } : {}) }, founder, at)
      assert.ok(r.ok)
      if (r.ok) l = r.ledger
    }
  }
  const store = new OperateStore(join(dir, 'operate'), RUN)
  await store.saveLedger(l)
  // A running experiment with rising measurements.
  const d = draftExperiment({ id: 'op-exp-1', hypothesis: 'If we add a referral link, signups rise.', playbookId: 'operate', metric: { id: 'signups', label: 'Signups', direction: 'higher-is-better', kill: 5, hold: 10, scale: 30 }, budgetUsd: 200, durationDays: 30, customerFacing: false, proposedBy: 'entity-founder' })
  assert.ok(d.ok)
  const s = startExperiment((d as { experiment: Experiment }).experiment, founder, new Date(now - 5 * DAY), { remainingBudgetUsd: 200 })
  assert.ok(s.ok)
  let exp = (s as { experiment: Experiment }).experiment
  for (const [v, ago] of [[12, 4], [14, 3], [15, 2], [17, 1]] as const) {
    const r = recordMeasurement(exp, v, founder, 'analytics', new Date(now - ago * DAY))
    assert.ok(r.ok)
    exp = (r as { experiment: Experiment }).experiment
  }
  await store.saveExperiments([exp])
}

test('cash: prints an estimate with seed, runs and history size, deterministically; refuses without history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-whatif-'))
  try {
    const empty = await whatif(dir, ['cash', '--cash', '1000'])
    assert.equal(empty.code, 1)
    assert.match(empty.out, /no money history/)

    await seedOperate(dir)
    const noCash = await whatif(dir, ['cash'])
    assert.equal(noCash.code, 1)
    assert.match(noCash.out, /--cash <usd> is required/)

    const a = await whatif(dir, ['cash', '--cash', '1500', '--horizon', '4', '--runs', '500', '--seed', '3'])
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /ESTIMATE, not a decision/)
    assert.match(a.out, /Seed 3, 500 runs, history 6 period\(s\) of 30 days/)
    assert.match(a.out, /estimate from 6 period\(s\) of history/)
    assert.match(a.out, /\$1000\.00 reserve floor/)
    assert.match(a.out, /Assumptions:/)
    assert.equal(a.out.split('\n').filter((l) => /^\s+[1-4] /.test(l)).length, 4)
    const b = await whatif(dir, ['cash', '--cash', '1500', '--horizon', '4', '--runs', '500', '--seed', '3'])
    assert.equal(b.out, a.out, 'same seed, same output')

    const stressed = await whatif(dir, ['cash', '--cash', '1500', '--horizon', '4', '--runs', '500', '--seed', '3', '--scenario', 'revenue-50'])
    assert.equal(stressed.code, 0, stressed.out)
    assert.match(stressed.out, /Scenario: revenue −50%/)
    const missing = await whatif(dir, ['cash', '--cash', '1', '--scenario', 'lost-largest-customer'])
    assert.equal(missing.code, 1)
    assert.match(missing.out, /not available: .*counterparties/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scenarios and experiment odds; nothing is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-whatif-'))
  try {
    await seedOperate(dir)
    const before = await readFile(join(dir, 'operate', RUN, 'experiments.json'), 'utf8')
    const s = await whatif(dir, ['scenarios'])
    assert.equal(s.code, 0, s.out)
    assert.match(s.out, /History 6 period\(s\) of 30 days/)
    assert.match(s.out, /revenue-25: revenue −25%/)
    assert.match(s.out, /experiment-fails:op-exp-1/)
    assert.match(s.out, /\(skipped\) lost-largest-customer/)

    const e = await whatif(dir, ['experiment', 'op-exp-1', '--runs', '400', '--seed', '5'])
    assert.equal(e.code, 0, e.out)
    assert.match(e.out, /ESTIMATE, not a decision\. Seed 5, 400 runs, history 4 measurement\(s\)/)
    assert.match(e.out, /scale\s+\d/)
    assert.match(e.out, /over budget at the observed pace/)
    assert.match(e.out, /Nothing was applied/)
    assert.equal(await readFile(join(dir, 'operate', RUN, 'experiments.json'), 'utf8'), before)
    const unknown = await whatif(dir, ['experiment', 'nope'])
    assert.equal(unknown.code, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('genesis: reads data/genesis/<runId>/ledger.json with weekly periods and says when history is short', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-whatif-'))
  try {
    const config = JSON.parse(await readFile(join(repo, 'deploy/genesis/genesis-500.json'), 'utf8')) as { runId: string; budgetUsd: number }
    const now = Date.now()
    let l: MoneyLedger = { runId: config.runId, budgetUsd: config.budgetUsd, entries: [] }
    for (const [kind, amountUsd, ago] of [['spend', 40, 9], ['revenue', 25, 3]] as const) {
      const at = new Date(now - ago * DAY)
      const r = appendMoney(l, { kind, amountUsd, category: kind === 'revenue' ? 'sales' : 'advertising', description: kind, source: { type: 'bank', ref: `g${ago}` }, occurredAt: at.toISOString(), ...(kind === 'spend' ? { spendAuthorization: { decisionId: `decision-g${ago}-${kind}`, recommendation: 'execute-autonomously' as const, riskLevel: 1 as const, reasons: [], confirmedBy: founder.id, confirmedAt: at.toISOString() } } : {}) }, founder, at)
      assert.ok(r.ok)
      if (r.ok) l = r.ledger
    }
    await mkdir(join(dir, 'genesis', config.runId), { recursive: true })
    await writeFile(join(dir, 'genesis', config.runId, 'ledger.json'), JSON.stringify(l))
    const r = await whatif(dir, ['cash', '--run', 'genesis', '--runs', '200'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /genesis run genesis-500-30d/)
    assert.match(r.out, /history 1 period\(s\) of 7 days/)
    assert.match(r.out, /too short to say much/)
    assert.match(r.out, /Start cash is the run budget \(\$500\.00\) plus the ledger's net \(-\$15\.00\)/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('autonomy: counterfactual tables from the shadow logs; unknown outcomes stay unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-whatif-'))
  try {
    const t0 = Date.now() - 60 * DAY
    const recs: ShadowRecommendation[] = []
    for (let i = 0; i < 25; i++) {
      const at = new Date(t0 + i * DAY).toISOString()
      const verdict = i === 22 ? 'rejected' : 'accepted'
      recs.push({ id: `c${i}`, department: 'collections', description: `c${i}`, proposedAt: at, executed: false, kernel: { recommendation: 'execute-autonomously', riskLevel: 1 }, verdict: { value: verdict, by: 'entity-founder', at }, ...(i < 20 ? { outcome: { value: 'good' as const, by: 'entity-founder', at } } : {}) })
    }
    const log: ShadowLog = { recommendations: recs }
    await mkdir(join(dir, 'intent', 'onboard', 'intent-1'), { recursive: true })
    await writeFile(join(dir, 'intent', 'onboard', 'intent-1', 'shadow.json'), JSON.stringify(log))
    const r = await whatif(dir, ['autonomy'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /ESTIMATE from recorded shadow history, not a decision; it grants nothing/)
    assert.match(r.out, /History 25 judged of 25/)
    assert.match(r.out, /collections: 25 judged of 25/)
    assert.match(r.out, /← your rules/)
    // minJudged 20 at 80%: met on the 20th; 5 later would have run alone, 1 of them rejected.
    const mine = r.out.split('\n').find((l) => l.includes('← your rules'))!
    assert.match(mine, /\s5\s+1 \(1 rejected, 0 modified\)/)
    assert.match(r.out, /unknown, not assumed good/)
    assert.match(r.out, /Kernel vs owner \(25 judged\): matched 24, kernel too loose 1/)
    const none = await whatif(dir, ['autonomy', '--department', 'sales'])
    assert.match(none.out, /No shadow recommendations for sales/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
