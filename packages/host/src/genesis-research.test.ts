import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { appendMoney, experimentDigest, type Experiment, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import { createManualReview } from './genesis-reviews.ts'
import { exportGenesisResearchTrajectories, verifyGenesisResearchDataset } from './genesis-research.ts'

const exec = promisify(execFile)
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const runId = 'genesis-private-run'
const now = new Date('2026-09-30T12:00:00Z')
const reviewer = { id: 'entity-founder', kind: 'human' as const }

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  const definition: Experiment['definition'] = {
    id: 'campaign-1',
    hypothesis: 'Private hypothesis must never be exported',
    playbookId: 'genesis',
    metric: { id: 'private-metric-id', label: 'Private customer metric label', direction: 'higher-is-better', kill: 0, hold: 10, scale: 20 },
    budgetUsd: 100,
    durationDays: 14,
    customerFacing: true,
    proposedBy: reviewer.id,
  }
  return {
    definition,
    digest: experimentDigest(definition),
    status: 'completed',
    startedAt: '2026-09-01T00:00:00.000Z',
    startedBy: reviewer.id,
    endsAt: '2026-09-15T00:00:00.000Z',
    measurements: [{ at: '2026-09-03T00:00:00.000Z', value: 15, by: reviewer.id, source: 'private://customer-list' }],
    decisions: [{ at: '2026-09-04T00:00:00.000Z', verdict: 'continue', applied: 'completed', by: 'kernel', note: 'Private decision note' }],
    ...overrides,
  }
}

function ledger(): MoneyLedger {
  const base: MoneyLedger = { runId, budgetUsd: 100, entries: [] }
  const spend = appendMoney(base, {
    kind: 'spend', amountUsd: 25, category: 'advertising', description: 'Private transaction description',
    experimentId: 'campaign-1', source: { type: 'manual', ref: 'private-source-ref' },
    spendAuthorization: { decisionId: 'decision-1', recommendation: 'request-approval', riskLevel: 2, reasons: [], confirmedBy: reviewer.id, confirmedAt: now.toISOString() },
  }, reviewer, now)
  if (!spend.ok) throw new Error(spend.reasons.join(' '))
  const revenue = appendMoney(spend.ledger, {
    kind: 'revenue', amountUsd: 40, category: 'sales', description: 'Private revenue description',
    experimentId: 'campaign-1', source: { type: 'manual', ref: 'private-revenue-ref' },
  }, reviewer, now)
  if (!revenue.ok) throw new Error(revenue.reasons.join(' '))
  return revenue.ledger
}

test('Genesis research export provides outcome trajectories without free text or transaction data', () => {
  const review = createManualReview({ text: 'Private customer-facing copy', channel: 'private-client-email', verdict: 'pass', note: 'Private review note', experimentId: 'campaign-1' }, reviewer, now)
  if (!review.ok) throw new Error(review.reasons.join(' '))
  const dataset = exportGenesisResearchTrajectories({
    runId, experiments: [experiment()], ledger: ledger(), reviews: [review.review], reviewer,
    privacyNote: 'Reviewed for research export; no customer content included.', now,
  })
  const serialized = JSON.stringify(dataset)
  for (const secret of [
    'Private hypothesis', 'Private customer metric label', 'private-metric-id', 'private://customer-list',
    'Private decision note', 'Private customer-facing copy', 'Private review note', 'Private transaction description',
    'private-source-ref',
  ]) assert.equal(serialized.includes(secret), false, `export leaked ${secret}`)
  assert.equal(dataset.exportedBy, reviewer.id, 'the top-level export keeps explicit owner accountability')
  assert.equal(JSON.stringify(dataset.trajectories).includes(reviewer.id), false, 'trajectory samples exclude personal actor identities')
  const trajectory = dataset.trajectories[0]!
  assert.deepEqual(trajectory.observations, [{ day: 2, signal: 'continue' }])
  assert.deepEqual(trajectory.decisions, [{ day: 3, verdict: 'continue', applied: 'completed', authority: 'kernel' }])
  assert.deepEqual(trajectory.contentReviewSignals, [{ channel: 'other', kind: 'manual', verdict: 'pass' }])
  assert.deepEqual(trajectory.outcome, { status: 'completed', durationDays: 14, budgetUseRatio: 0.25, revenueToBudgetRatio: 0.4 })
  assert.equal(dataset.includedCount, 1)
  assert.equal(dataset.digest.length, 64)
  assert.equal(verifyGenesisResearchDataset(dataset), true)
  assert.equal(verifyGenesisResearchDataset({ ...dataset, includedCount: 10 }), false)
})

test('Genesis research export excludes undecided experiments and is digest-bound to the verified sources', () => {
  const draft = experiment({ status: 'draft', startedAt: undefined, startedBy: undefined, endsAt: undefined, decisions: [], measurements: [] })
  const args = { runId, experiments: [experiment(), draft], ledger: ledger(), reviews: [], reviewer, privacyNote: 'Reviewed.', now }
  const first = exportGenesisResearchTrajectories(args)
  const second = exportGenesisResearchTrajectories(args)
  assert.equal(first.includedCount, 1)
  assert.equal(first.excludedWithoutDecisionCount, 1)
  assert.equal(first.digest, second.digest)
  assert.equal(first.source.runIdDigest, second.source.runIdDigest)
})

test('Genesis research export fails closed for wrong owner, missing review, or tampered ledger', () => {
  const args = { runId, experiments: [experiment()], ledger: ledger(), reviews: [], reviewer, privacyNote: 'Reviewed.', now }
  assert.throws(() => exportGenesisResearchTrajectories({ ...args, reviewer: { id: 'agent', kind: 'agent' } }), /Only a named human/)
  assert.throws(() => exportGenesisResearchTrajectories({ ...args, privacyNote: ' ' }), /privacy review note/)
  const corrupt = structuredClone(args.ledger)
  corrupt.entries[0]!.amountUsd += 1
  assert.throws(() => exportGenesisResearchTrajectories({ ...args, ledger: corrupt }), /ledger does not verify/)
  assert.throws(() => exportGenesisResearchTrajectories({ ...args, runId: 'other-run' }), /ledger does not verify/)
})

test('Genesis CLI requires explicit owner privacy review and writes the bounded dataset into the private data directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-genesis-research-'))
  const config = JSON.parse(await readFile(join(repo, 'deploy', 'genesis', 'genesis-500.json'), 'utf8')) as Record<string, unknown>
  config.runId = runId
  const configPath = join(dir, 'genesis.json')
  const dataDir = join(dir, 'data')
  // genesis-cli.ts resolves tenantId from QUICKSILVER_TENANT_ID, defaulting to "default" when unset (as here).
  const runDir = join(dataDir, 'default', runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(configPath, JSON.stringify(config))
  await writeFile(join(runDir, 'ledger.json'), JSON.stringify(ledger()))
  await writeFile(join(runDir, 'experiments.json'), JSON.stringify([experiment()]))
  await writeFile(join(runDir, 'reviews.json'), JSON.stringify([]))
  const env = {
    ...process.env,
    INIT_CWD: dir,
    QUICKSILVER_GENESIS_CONFIG: configPath,
    QUICKSILVER_GENESIS_DIR: dataDir,
    QUICKSILVER_GENESIS_STORE: 'file',
    QUICKSILVER_GENESIS_ACTOR: reviewer.id,
    QUICKSILVER_HOST_CONFIG: join(dir, 'no-host.json'),
  }
  const cli = join(repo, 'packages', 'host', 'src', 'genesis-cli.ts')
  const run = (...args: string[]) => exec(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd: repo, env })
  try {
    await assert.rejects(run('research', 'export', '--note', 'Reviewed.'), /pass --confirm-privacy-review/)
    const { stdout } = await run('research', 'export', '--confirm-privacy-review', '--note', 'Reviewed for quantitative training data.')
    assert.match(stdout, /1 decided Genesis experiment trajectory/)
    assert.match(stdout, /no hypothesis text, raw measurements, ledger details/)
    const outputPath = /Private research dataset: (.+)/.exec(stdout)?.[1]
    assert.ok(outputPath)
    const exported = JSON.parse(await readFile(outputPath!, 'utf8')) as ReturnType<typeof exportGenesisResearchTrajectories>
    assert.equal(exported.trajectories.length, 1)
    assert.equal(JSON.stringify(exported).includes('Private hypothesis'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
