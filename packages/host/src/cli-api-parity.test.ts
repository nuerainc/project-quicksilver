/**
 * P-117: the Genesis money CLI (spend, compute, revenue, refund) and POST /api/genesis/money must apply the same rules.
 * Each case is run through the real CLI process and through a real host over separate data directories, then the
 * outcomes (recorded, needs confirmation, refused) and the ledger entries are compared.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { parseHostConfig } from './config.ts'
import { FileGenesisStore } from './genesis-api.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const cli = join(here, 'genesis-cli.ts')

type Outcome = 'recorded' | 'needs-confirmation' | 'refused'
interface Case {
  name: string
  kind: 'spend' | 'compute' | 'revenue' | 'refund'
  amountUsd: number | string
  category?: string
  description: string
  source?: string
  experimentId?: string
  confirm?: boolean
}

const OK = 'provider-usage:run-1'
const CASES: Case[] = [
  { name: 'compute inside the auto limit', kind: 'compute', amountUsd: 5, description: 'Model calls for the landing page.', source: OK },
  { name: 'spend on an allowed category inside the auto limit', kind: 'spend', amountUsd: 5, category: 'hosting', description: 'One month of hosting.', source: 'invoice:inv-1' },
  { name: 'spend above the auto limit needs a decision', kind: 'spend', amountUsd: 25, category: 'advertising', description: 'Ad test.', source: 'receipt:r-1' },
  { name: 'the same spend with confirmation is recorded', kind: 'spend', amountUsd: 25, category: 'advertising', description: 'Ad test.', source: 'receipt:r-2', confirm: true },
  { name: 'spend on a prohibited category', kind: 'spend', amountUsd: 5, category: 'inventory', description: 'Stock.', source: 'receipt:r-3' },
  { name: 'spend over the whole budget', kind: 'spend', amountUsd: 600, category: 'hosting', description: 'Too much.', source: 'receipt:r-4', confirm: true },
  { name: 'zero amount', kind: 'compute', amountUsd: 0, description: 'Nothing.', source: OK },
  { name: 'negative amount', kind: 'compute', amountUsd: -5, description: 'Negative.', source: OK },
  { name: 'amount that is not a number', kind: 'compute', amountUsd: 'abc', description: 'Text.', source: OK },
  { name: 'revenue with an allowed source', kind: 'revenue', amountUsd: 20, description: 'First sale.', source: 'payment-processor:pi_1' },
  { name: 'revenue above one million dollars', kind: 'revenue', amountUsd: 2_000_000, description: 'Huge.', source: 'payment-processor:pi_2' },
  { name: 'a valid refund of earlier revenue', kind: 'refund', amountUsd: 5, category: 'sales', description: 'Refund of the first sale.', source: 'payment-processor:re_0' },
  { name: 'a refund with an uppercase, spaced category', kind: 'refund', amountUsd: 5, category: 'Sales Q3', description: 'Odd category.', source: 'payment-processor:re_3' },
  { name: 'a description of 600 characters', kind: 'compute', amountUsd: 5, description: 'x'.repeat(600), source: OK },
  { name: 'a description of only spaces', kind: 'compute', amountUsd: 5, description: '   ', source: OK },
  { name: 'an unknown source type', kind: 'compute', amountUsd: 5, description: 'Bad source.', source: 'telepathy:abc' },
  { name: 'a source with an empty reference', kind: 'compute', amountUsd: 5, description: 'Empty ref.', source: 'receipt:' },
  { name: 'a source reference of 300 characters', kind: 'compute', amountUsd: 5, description: 'Long ref.', source: `receipt:${'r'.repeat(300)}` },
  { name: 'an experiment that does not exist', kind: 'compute', amountUsd: 5, description: 'No such experiment.', source: OK, experimentId: 'exp-missing' },
  { name: 'an experiment id with illegal characters', kind: 'compute', amountUsd: 5, description: 'Bad id.', source: OK, experimentId: 'Bad Id!' },
  { name: 'a refund larger than any revenue', kind: 'refund', amountUsd: 50, category: 'sales', description: 'Refund.', source: 'payment-processor:re_1' },
]

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'qs-parity-'))
  const config = JSON.parse(await readFile(join(repo, 'deploy', 'genesis', 'genesis-500.json'), 'utf8')) as GenesisRunConfig
  const shared = { ...config, prerequisites: { entityApproved: true, paymentAccounts: ['genesis-payments', 'genesis-card'] } }
  const configPath = join(dir, 'genesis.json')
  await writeFile(configPath, JSON.stringify(shared))
  const credentials = generateToken()
  const founder: TokenPrincipalConfig = { id: 'entity-founder', kind: 'human', tenantId: 'nuera', roles: ['intent-provider', 'viewer'], tokenDigest: credentials.tokenDigest }
  const cliData = join(dir, 'cli-data')
  const apiData = join(dir, 'api-data')
  const host = new QuicksilverHost(parseHostConfig({ tenantId: 'nuera', http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    genesis: { config: shared, store: new FileGenesisStore(apiData, 'nuera'), vaultNames: async () => ['genesis-payments', 'genesis-card'] },
  })
  const env = {
    ...process.env, INIT_CWD: repo, QUICKSILVER_GENESIS_CONFIG: configPath, QUICKSILVER_GENESIS_DIR: cliData, QUICKSILVER_GENESIS_STORE: 'file',
    QUICKSILVER_GENESIS_ACTOR: 'entity-founder', QUICKSILVER_HOST_CONFIG: join(dir, 'no-host.json'), QUICKSILVER_TENANT_ID: 'nuera',
  }
  const { port } = await host.start()
  const runCli = async (c: Case): Promise<Outcome> => {
    const hasCategory = c.kind === 'spend' || c.kind === 'refund'
    const args = [c.kind, String(c.amountUsd), ...(hasCategory ? [c.category ?? ''] : []), c.description, ...(c.source !== undefined ? ['--source', c.source] : []), ...(c.experimentId ? ['--experiment', c.experimentId] : []), ...(c.confirm ? ['--confirm'] : [])]
    try { await exec(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd: repo, env }); return 'recorded' } catch (e) {
      return /needs your decision/.test((e as { stderr?: string }).stderr ?? '') ? 'needs-confirmation' : 'refused'
    }
  }
  const runApi = async (c: Case): Promise<Outcome> => {
    const sep = c.source?.indexOf(':') ?? -1
    const body = {
      kind: c.kind, amountUsd: c.amountUsd, description: c.description,
      ...(c.category !== undefined ? { category: c.category } : {}),
      ...(c.source !== undefined && sep > 0 ? { source: { type: c.source.slice(0, sep), ref: c.source.slice(sep + 1) } } : {}),
      ...(c.experimentId ? { experimentId: c.experimentId } : {}), ...(c.confirm ? { confirm: true } : {}),
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/genesis/money`, { method: 'POST', headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return res.status === 201 ? 'recorded' : res.status === 409 ? 'needs-confirmation' : 'refused'
  }
  const ledger = async (root: string, tenant: string) => {
    try {
      const raw = JSON.parse(await readFile(join(root, tenant, config.runId as string, 'ledger.json'), 'utf8')) as { entries?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
      const entries = Array.isArray(raw) ? raw : raw.entries ?? []
      return entries.map((e) => ({ kind: e.kind, amountUsd: e.amountUsd, category: e.category, description: e.description, source: e.source }))
    } catch { return [] }
  }
  return { runCli, runApi, ledger, cliData, apiData, stop: async () => { await host.stop({ abort: true }); await rm(dir, { recursive: true, force: true }) } }
}

test('Genesis money: the CLI and the HTTP API reach the same outcome for the same input', async () => {
  const h = await setup()
  const diffs: string[] = []
  try {
    for (const c of CASES) {
      const [viaCli, viaApi] = [await h.runCli(c), await h.runApi(c)]
      if (viaCli !== viaApi) diffs.push(`${c.name}: CLI ${viaCli}, API ${viaApi}`)
    }
    assert.deepEqual(diffs, [], `the CLI and the API disagree on:\n${diffs.join('\n')}`)
    // What was recorded is the same on both sides, entry for entry.
    const recorded = await h.ledger(h.apiData, 'nuera')
    assert.ok(recorded.length >= 4, `the comparison covers real entries (${recorded.length})`)
    assert.deepEqual(await h.ledger(h.cliData, 'nuera'), recorded)
  } finally { await h.stop() }
})
