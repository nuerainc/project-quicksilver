/**
 * P-107: two tenants served by two host processes over the same storage. Run with `npm run host:test`.
 *
 * Every id that could collide does (run id, site id, principal id, review text), and the
 * file stores share one directory, so a missing tenant partition shows up as a leak here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { parseHostConfig } from './config.ts'
import { FileGenesisStore } from './genesis-api.ts'
import { FileHostingStore, MemoryHostingAdapter } from './hosting.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'
import { FakeMediaProvider, FileMediaStore, MediaService, MEDIA_KINDS } from './media.ts'

const T0 = Date.parse('2026-10-03T12:00:00Z')
const PAGE = '<!doctype html><html><head><title>Report</title></head><body><h1>Report</h1></body></html>'

const runConfig = (): GenesisRunConfig => ({
  schemaVersion: 1,
  runId: 'genesis-test',
  playbookId: 'genesis',
  budgetUsd: 500,
  durationDays: 30,
  digitalOnly: true,
  allowedCategories: ['compute', 'hosting', 'advertising'],
  prohibitedCategories: ['inventory'],
  spend: { autoMaxUsd: 10, autoMaxRisk: 2, dailyCapUsd: 50 },
  waesRequired: true,
  waesManualReviewAllowed: true,
  prerequisites: { entityApproved: true, paymentAccounts: ['genesis-card'] },
  owner: 'entity-founder',
})

async function startTenant(tenantId: string, dir: string, adapter: MemoryHostingAdapter) {
  const { token, tokenDigest } = generateToken()
  const founder: TokenPrincipalConfig = { id: 'entity-founder', kind: 'human', tenantId, roles: ['intent-provider'], tokenDigest }
  const agentTok = generateToken()
  const agent: TokenPrincipalConfig = { id: 'agent-genesis', kind: 'agent', tenantId, roles: ['agent-worker'], tokenDigest: agentTok.tokenDigest }
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-tenant-audit-'))
  const media = new MediaService({
    store: new FileMediaStore(dir, tenantId),
    policy: { budgetUsd: 1, autoMaxUsd: 0.1, maxRequestUsd: 0.5, defaultRetentionDays: 30, maxRetentionDays: 365, allowedKinds: MEDIA_KINDS, blockedTerms: [] },
    providers: [new FakeMediaProvider()],
    now: () => new Date(T0),
  })
  const host = new QuicksilverHost(parseHostConfig({ tenantId, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder, agent],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl') },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => T0,
    genesis: { config: runConfig(), store: new FileGenesisStore(dir, tenantId), vaultNames: async () => ['genesis-card'] },
    hosting: { store: new FileHostingStore(dir, tenantId), adapter },
    media,
  })
  const { port } = await host.start()
  const call = (path: string, bearer: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const stop = async () => { await host.stop(); await rm(auditDir, { recursive: true, force: true }) }
  return { call, stop, tokens: { founder: token, agent: agentTok.token } }
}

test('two tenants on shared storage: hosting, media and Genesis never cross, and a token works only on its own tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-tenants-'))
  const adapter = new MemoryHostingAdapter()
  const a = await startTenant('alpha', dir, adapter)
  const b = await startTenant('beta', dir, adapter)
  try {
    // Alpha does real work under ids that beta will reuse.
    assert.equal((await a.call('/api/genesis/reviews', a.tokens.founder, { text: PAGE, channel: 'landing-page', verdict: 'pass', note: 'ok' })).status, 201)
    assert.equal((await a.call('/api/hosting/sites', a.tokens.agent, { id: 'launch', title: 'Alpha launch' })).status, 201)
    assert.equal((await a.call('/api/hosting/sites/launch/releases', a.tokens.agent, { files: [{ path: 'index.html', text: PAGE }] })).status, 201)
    assert.equal((await a.call('/api/hosting/sites/launch/releases/1/publish', a.tokens.founder, {})).status, 200)
    const made = await a.call('/api/media/requests', a.tokens.founder, { kind: 'speech', input: { text: 'Hello from alpha' } })
    assert.equal(made.status, 201)
    const assetId = made.body.asset.id as string

    // Beta sees none of it.
    assert.equal((await b.call('/api/hosting/sites', b.tokens.founder)).body.sites?.length ?? 0, 0, 'beta lists no sites')
    assert.equal((await b.call('/api/hosting/sites/launch', b.tokens.founder)).status, 404)
    assert.deepEqual((await b.call('/api/media/assets', b.tokens.founder)).body.assets, [])
    assert.equal((await b.call(`/api/media/assets/${assetId}`, b.tokens.founder)).status, 404)
    assert.equal((await b.call(`/api/media/assets/${assetId}/content`, b.tokens.founder)).status, 404)
    assert.equal((await b.call('/api/media', b.tokens.founder)).body.spentUsd, 0, 'beta has spent nothing')
    const betaRun = await b.call('/api/genesis', b.tokens.founder)
    assert.equal(betaRun.body.reviews.length, 0, 'beta has no reviews')
    assert.equal(betaRun.body.ledger.entries, 0)
    assert.equal((await b.call('/api/media/provenance', b.tokens.founder)).body.count, 0)

    // A page reviewed in alpha does not unlock the same page in beta.
    assert.equal((await b.call('/api/hosting/sites', b.tokens.agent, { id: 'launch', title: 'Beta launch' })).status, 201)
    assert.equal((await b.call('/api/hosting/sites/launch/releases', b.tokens.agent, { files: [{ path: 'index.html', text: PAGE }] })).status, 201)
    assert.equal((await b.call('/api/hosting/sites/launch/releases/1/publish', b.tokens.founder, {})).status, 409, "alpha's review of the same text does not count in beta")
    assert.deepEqual([...adapter.live.keys()], ['alpha/launch'], 'only alpha deployed, under its own tenant')

    // The same site id is two different sites.
    assert.equal((await a.call('/api/hosting/sites/launch', a.tokens.founder)).body.site.title, 'Alpha launch')
    assert.equal((await b.call('/api/hosting/sites/launch', b.tokens.founder)).body.site.title, 'Beta launch')

    // A token is good for its own tenant only, even for the same principal id.
    assert.equal((await b.call('/api/hosting/sites', a.tokens.founder)).status, 401)
    assert.equal((await a.call('/api/media', b.tokens.founder)).status, 401)
    assert.equal((await b.call(`/api/media/assets/${assetId}`, a.tokens.founder)).status, 401)

    // On disk each tenant has its own directory.
    assert.deepEqual((await readdir(dir)).sort(), ['alpha', 'beta'])
  } finally { await a.stop(); await b.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('a host refuses principals that belong to another tenant', () => {
  const { tokenDigest } = generateToken()
  assert.throws(() => new QuicksilverHost(parseHostConfig({ tenantId: 'alpha', http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [{ id: 'entity-founder', kind: 'human', tenantId: 'beta', roles: ['viewer'], tokenDigest }],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
  }), /belong to another tenant/)
})
