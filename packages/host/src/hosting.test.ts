/**
 * P-026: experiment hosting. Run with `npm run host:test`.
 *
 * Nothing here deploys anything: the file adapter writes into a temp directory and the
 * HTTP tests use an in-memory adapter that records what it was asked to do.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { parseHostConfig } from './config.ts'
import { MemoryGenesisStore } from './genesis-api.ts'
import {
  buildFiles,
  FileHostingAdapter,
  FileHostingStore,
  HostingStoreError,
  MemoryHostingAdapter,
  MemoryHostingStore,
  releaseDigest,
  siteChangeProblems,
  staticLint,
  type HostedSite,
  type SiteRelease,
} from './hosting.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const TENANT = 'nuera'
const T0 = Date.parse('2026-10-03T12:00:00Z')

const PAGE = '<!doctype html><html><head><title>Margin report</title><link rel="stylesheet" href="style.css"></head><body><h1>Margin report</h1><p>A feed-store margin report in 48 hours.</p><a href="https://buy.example.test/abc">Buy</a></body></html>'
const CSS = 'body { font-family: sans-serif; color: #222 }'
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]).toString('base64')

const index = (text = PAGE) => ({ path: 'index.html', text })
const files = (...extra: Array<Record<string, unknown>>) => [index(), ...extra]

// ── buildFiles ────────────────────────────────────────────────────────────

test('buildFiles: a static page with CSS and an image is accepted, with stable, order-independent digests', () => {
  const a = buildFiles([index(), { path: 'style.css', text: CSS }, { path: 'img/logo.png', base64: PNG_B64 }])
  assert.ok(a.ok)
  assert.deepEqual(a.files.map((f) => [f.path, f.contentType]), [['img/logo.png', 'image/png'], ['index.html', 'text/html'], ['style.css', 'text/css']])
  const b = buildFiles([{ path: 'img/logo.png', base64: PNG_B64 }, { path: 'style.css', text: CSS }, index()])
  assert.ok(b.ok)
  assert.equal(releaseDigest(a.files), releaseDigest(b.files), 'file order does not change the digest')
  const changed = buildFiles([index(PAGE.replace('48 hours', '24 hours')), { path: 'style.css', text: CSS }, { path: 'img/logo.png', base64: PNG_B64 }])
  assert.ok(changed.ok)
  assert.notEqual(releaseDigest(changed.files), releaseDigest(a.files), 'any content change changes the digest')
  assert.match(releaseDigest(a.files), /^sha256:[0-9a-f]{64}$/)
})

test('buildFiles: paths, types, sizes and encodings are checked', () => {
  const bad = (input: unknown, pattern: RegExp) => {
    const r = buildFiles(input)
    assert.ok(!r.ok, String(JSON.stringify(input)).slice(0, 80))
    assert.match(r.ok ? '' : r.error, pattern)
  }
  bad(undefined, /non-empty array/)
  bad([], /non-empty array/)
  bad([{ path: 'a.html', text: PAGE }], /needs an index\.html/)
  for (const path of ['../x.html', '/etc/x.html', 'a/../b.html', '.hidden.html', 'a//b.html', 'a\\b.html', 'a/./b.html', 'sp ace.html', 'x'.repeat(101) + '.html', 'a/b/c/d/e/f/g/h.html']) bad(files({ path, text: 'x' }), /not a valid file path/)
  bad(files({ path: 'app.js', text: 'alert(1)' }), /only html, css/)
  bad(files({ path: 'logo.svg', text: '<svg/>' }), /only html, css/)
  bad(files({ path: 'noextension', text: 'x' }), /only html, css/)
  bad(files({ path: 'INDEX.HTML', text: 'x' }), /appears twice/)
  bad([{ path: 'index.html' }], /exactly one of text or base64/)
  bad([{ path: 'index.html', text: 'x', base64: 'eA==' }], /exactly one of text or base64/)
  bad(files({ path: 'a.png', text: 'x' }), /images need base64/)
  bad(files({ path: 'a.txt', base64: 'eA==' }), /text files need text/)
  bad(files({ path: 'a.png', base64: '***' }), /base64 is not valid/)
  bad(files({ path: 'a.png', base64: Buffer.from('not a png at all').toString('base64') }), /not really a image\/png/)
  bad(files({ path: 'a.txt', text: '' }), /is empty/)
  bad([index('x'.repeat(1024 * 1024 + 1))], /over 1024 KiB/)
  bad(Array.from({ length: 61 }, (_, i) => ({ path: i === 0 ? 'index.html' : `p${i}.txt`, text: 'x' })), /at most 60 files/)
  bad([index(), ...Array.from({ length: 6 }, (_, i) => ({ path: `big${i}.png`, base64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1000 * 1024)]).toString('base64') }))], /over 5 MiB in total/)
})

test('static lint: scripts, frames, forms, handlers and external CSS loads are refused; ordinary markup is not', () => {
  for (const html of ['<script>1</script>', '<SCRIPT src=x>', '<iframe src=x>', '<object data=x>', '<embed src=x>', '<form action=x>', '<base href=x>', '<meta http-equiv="refresh" content="0;url=x">', '<a onclick="x()">', '<img src=x onerror=y>', '<a href="javascript:alert(1)">', '<a href="data:text/html,x">', '<link rel="preload" href=x>']) {
    assert.ok(staticLint('text/html', html), html)
  }
  for (const css of ['@import url(x.css)', 'a { background: url(https://x.test/a.png) }', 'a { background: url(//x.test/a.png) }', 'a { width: expression(1) }', 'a { behavior: url(x) }']) assert.ok(staticLint('text/css', css), css)
  assert.equal(staticLint('text/html', PAGE), undefined)
  assert.equal(staticLint('text/css', CSS + ' a { background: url(img/logo.png) }'), undefined)
  assert.equal(staticLint('text/plain', '<script>this is just text</script>'), undefined, 'plain text is not interpreted')
  const r = buildFiles([index('<p onclick="x()">hi</p>')])
  assert.ok(!r.ok && /inline event handler.*static only/.test(r.error))
})

// ── Immutability and history ──────────────────────────────────────────────

const release = (version: number, over: Partial<SiteRelease> = {}): SiteRelease => {
  const f = [{ path: 'index.html', contentType: 'text/html', bytes: 10, sha256: 'a'.repeat(63) + String(version) }]
  return { version, status: 'staged', files: f, digest: releaseDigest(f), createdBy: 'agent-genesis', createdAt: new Date(T0).toISOString(), ...over }
}
const site = (over: Partial<HostedSite> = {}): HostedSite => ({
  id: 'launch',
  title: 'Launch page',
  status: 'active',
  createdBy: 'agent-genesis',
  createdAt: new Date(T0).toISOString(),
  releases: [release(1)],
  events: [{ at: new Date(T0).toISOString(), by: 'agent-genesis', action: 'site-created' }],
  ...over,
})

test('siteChangeProblems: releases are immutable, history is append-only, a torn-down site stays down', () => {
  const base = site()
  assert.deepEqual(siteChangeProblems(undefined, base), [])
  assert.deepEqual(siteChangeProblems(base, { ...base, releases: [{ ...base.releases[0]!, status: 'published' }], events: [...base.events, { at: 'x', by: 'h', action: 'release-published', version: 1 }] }), [], 'status and new events are allowed')
  assert.deepEqual(siteChangeProblems(base, { ...base, releases: [...base.releases, release(2)] }), [])

  const tampered = release(1, { files: [{ ...base.releases[0]!.files[0]!, sha256: 'b'.repeat(64) }] })
  assert.ok(siteChangeProblems(base, { ...base, releases: [tampered] }).some((p) => p.includes('digest does not match')))
  const redigested = { ...tampered, digest: releaseDigest(tampered.files) }
  assert.ok(siteChangeProblems(base, { ...base, releases: [redigested] }).some((p) => p.includes('release 1 is immutable')))
  assert.ok(siteChangeProblems(base, { ...base, releases: [release(1, { createdBy: 'someone-else' })] }).some((p) => p.includes('immutable')))
  assert.ok(siteChangeProblems(base, { ...base, releases: [release(2)] }).some((p) => p.includes('no gaps')))
  assert.ok(siteChangeProblems(site({ releases: [release(1), release(2)] }), base).some((p) => p.includes('cannot be removed')))
  assert.ok(siteChangeProblems(base, { ...base, events: [] }).some((p) => p.includes('append-only')))
  assert.ok(siteChangeProblems(base, { ...base, events: [{ ...base.events[0]!, by: 'forged' }] }).some((p) => p.includes('append-only')))
  assert.ok(siteChangeProblems(base, { ...base, createdBy: 'forged' }).some((p) => p.includes('fixed')))
  assert.ok(siteChangeProblems(base, { ...base, experimentId: 'exp-new' }).some((p) => p.includes('fixed')))
  const down = site({ status: 'torn-down' })
  assert.ok(siteChangeProblems(down, { ...down, status: 'active' }).some((p) => p.includes('cannot come back')))
})

// ── Stores ────────────────────────────────────────────────────────────────

test('hosting stores (file and memory): sites, files, immutability, orphans, tenants, ids and path containment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-hosting-'))
  try {
    for (const make of [() => new FileHostingStore(dir, 'nuera'), () => new MemoryHostingStore('nuera')]) {
      const s = make()
      assert.deepEqual(await s.listSites(), [])
      assert.equal(await s.getSite('launch'), undefined)
      const built = buildFiles([{ path: 'index.html', text: PAGE }, { path: 'style.css', text: CSS }])
      assert.ok(built.ok)
      const meta = built.files.map(({ content: _c, ...m }) => m)
      const rel: SiteRelease = { version: 1, status: 'staged', files: meta, digest: releaseDigest(meta), createdBy: 'a', createdAt: new Date(T0).toISOString() }
      const first = site({ releases: [] })
      await s.putSite(first)
      await s.putFiles('launch', 1, built.files) // an orphan: the site does not record version 1 yet
      await s.putFiles('launch', 1, built.files) // retrying a stage that failed halfway is fine
      await s.putSite({ ...first, releases: [rel] })
      const back = await s.getFiles('launch', 1)
      assert.deepEqual(back.map((f) => f.path).sort(), ['index.html', 'style.css'])
      assert.equal(back.find((f) => f.path === 'index.html')!.content.toString(), PAGE)
      assert.equal(releaseDigest(back), rel.digest, 'stored files still match the digest')
      await assert.rejects(s.putFiles('launch', 1, built.files), /already exists and is immutable/)
      assert.deepEqual(await s.getFiles('launch', 9), [])
      await assert.rejects(s.putSite({ ...first, releases: [{ ...rel, digest: 'sha256:' + '0'.repeat(64) }] }), HostingStoreError)
      await assert.rejects(s.getSite('Bad_Id'), /Invalid site id/)
      await assert.rejects(s.getSite('../escape'), /Invalid site id/)
      assert.equal((await s.listSites()).length, 1)
      const evil = { ...built.files[0]!, path: '../../escape.html' }
      await assert.rejects(s.putFiles('launch', 2, [evil]), /escapes the release directory/)
    }
    assert.deepEqual(await new FileHostingStore(dir, 'other-tenant').listSites(), [], 'another tenant never sees these sites')
    const mem = new MemoryHostingStore('a')
    await mem.putSite(site())
    assert.deepEqual(await new MemoryHostingStore('b').listSites(), [])
    assert.ok((await readdir(join(dir, 'nuera', 'hosting', 'launch'))).includes('site.json'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── Adapters ──────────────────────────────────────────────────────────────

test('file adapter: publish writes live/ for a static server, a new release replaces it whole, teardown removes the site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-hosting-out-'))
  try {
    const adapter = new FileHostingAdapter(dir)
    const target = { siteId: 'launch', tenantId: 'nuera' }
    const v1 = buildFiles([{ path: 'index.html', text: PAGE }, { path: 'img/logo.png', base64: PNG_B64 }])
    assert.ok(v1.ok)
    const r1: SiteRelease = { ...release(1), digest: releaseDigest(v1.files) }
    const out = await adapter.publish(target, r1, v1.files)
    assert.equal(out.location, join(dir, 'nuera', 'launch', 'live'))
    assert.equal(await readFile(join(out.location, 'index.html'), 'utf8'), PAGE)
    assert.equal((await readFile(join(out.location, 'img', 'logo.png'))).length, 24)
    assert.deepEqual(JSON.parse(await readFile(join(out.location, '.release.json'), 'utf8')), { version: 1, digest: r1.digest })

    const v2 = buildFiles([{ path: 'index.html', text: PAGE.replace('48 hours', '24 hours') }])
    assert.ok(v2.ok)
    await adapter.publish(target, { ...release(2), digest: releaseDigest(v2.files) }, v2.files)
    assert.match(await readFile(join(out.location, 'index.html'), 'utf8'), /24 hours/)
    await assert.rejects(stat(join(out.location, 'img', 'logo.png')), /ENOENT/, 'a release replaces the live content whole; nothing of v1 lingers')
    assert.deepEqual((await readdir(join(dir, 'nuera', 'launch'))).sort(), ['live'], 'no temp or old directories are left behind')

    await adapter.teardown(target)
    await assert.rejects(stat(join(dir, 'nuera', 'launch')), /ENOENT/)
    await adapter.teardown(target) // idempotent
    await assert.rejects(adapter.publish({ siteId: '../x', tenantId: 'nuera' }, r1, v1.files), /Invalid site or tenant id/)
    await assert.rejects(adapter.publish({ siteId: 'launch', tenantId: '../x' }, r1, v1.files), /Invalid site or tenant id/)
    const evil = { ...v1.files[0]!, path: '../../escape.html' }
    await assert.rejects(adapter.publish(target, r1, [evil]), /escapes the site directory/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── HTTP: the full chain ──────────────────────────────────────────────────

function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

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

const definition = (id = 'exp-landing') => ({
  id,
  hypothesis: 'If we publish a landing page, return on capital reaches 1.0 within 14 days.',
  playbookId: 'genesis',
  metric: { id: 'roc', label: 'Return on capital', direction: 'higher-is-better', kill: 0.1, hold: 0.5, scale: 1 },
  budgetUsd: 100,
  durationDays: 14,
  customerFacing: true,
})

async function startHost(options: { hosting?: boolean; genesis?: boolean; adapter?: MemoryHostingAdapter } = {}) {
  const founder = who('entity-founder', 'human', ['intent-provider'])
  const agent = who('agent-genesis', 'agent', ['agent-worker'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const adapter = options.adapter ?? new MemoryHostingAdapter()
  const store = new MemoryHostingStore(TENANT)
  const genesisStore = new MemoryGenesisStore(TENANT)
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-hosting-audit-'))
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, agent.config, viewer.config],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl') },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => T0,
    ...(options.genesis === false ? {} : { genesis: { config: runConfig(), store: genesisStore, vaultNames: async () => ['genesis-card'] } }),
    ...(options.hosting === false ? {} : { hosting: { store, adapter } }),
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const stop = async () => { await host.stop(); await rm(auditDir, { recursive: true, force: true }) }
  return { call, stop, adapter, store, tokens: { founder: founder.token, agent: agent.token, viewer: viewer.token } }
}

type Harness = Awaited<ReturnType<typeof startHost>>
const H = '/api/hosting'
const manualPass = (h: Harness, text: string) => h.call('/api/genesis/reviews', h.tokens.founder, { text, channel: 'landing-page', verdict: 'pass', note: 'Reads fine.' })
const create = (h: Harness, body: unknown = { id: 'launch', title: 'Launch page' }, token = h.tokens.agent) => h.call(`${H}/sites`, token, body)
const stage = (h: Harness, f: unknown = [index()], token = h.tokens.agent, id = 'launch') => h.call(`${H}/sites/${id}/releases`, token, { files: f })
const publish = (h: Harness, version: number, token = h.tokens.founder, id = 'launch') => h.call(`${H}/sites/${id}/releases/${version}/publish`, token, {})

test('routes: absent without a hosting adapter or without a Genesis run; reads need decision:read; staging needs a proposer; publish, teardown and reconcile are humans only', async () => {
  for (const o of [{ hosting: false }, { genesis: false }]) {
    const h = await startHost(o)
    try { assert.equal((await h.call(`${H}/sites`, h.tokens.viewer)).status, 404) } finally { await h.stop() }
  }
  const h = await startHost()
  try {
    assert.equal((await h.call(`${H}/sites`, h.tokens.viewer)).status, 200)
    assert.equal((await create(h, { id: 'launch', title: 'Launch page' }, h.tokens.viewer)).status, 403, 'a viewer cannot create')
    assert.equal((await create(h)).status, 201, 'an agent can create')
    assert.equal((await stage(h, [index()], h.tokens.viewer)).status, 403, 'a viewer cannot stage')
    assert.equal((await stage(h)).status, 201, 'an agent can stage')
    assert.equal((await publish(h, 1, h.tokens.agent)).status, 403, 'an agent cannot publish')
    assert.equal((await publish(h, 1, h.tokens.viewer)).status, 403, 'a viewer cannot publish')
    assert.equal((await h.call(`${H}/sites/launch/teardown`, h.tokens.agent, { reason: 'x' })).status, 403)
    assert.equal((await h.call(`${H}/reconcile`, h.tokens.agent, {})).status, 403)
    assert.equal((await h.call(`${H}/reconcile`, h.tokens.viewer, {})).status, 403)
    assert.equal((await h.call(`${H}/sites/nope`, h.tokens.viewer)).status, 404)
    assert.equal((await h.call(`${H}/sites/Bad_Id`, h.tokens.viewer)).status, 404)
    assert.deepEqual(h.adapter.ops, [], 'nothing reached the adapter')
  } finally { await h.stop() }
})

test('create and stage: validation, duplicate ids, staging is a record and reports which pages still need a review', async () => {
  const h = await startHost()
  try {
    assert.equal((await create(h, { id: 'Bad Id', title: 'x' })).status, 422)
    assert.equal((await create(h, { id: 'launch', title: '' })).status, 422)
    assert.equal((await create(h, { id: 'launch', title: 'x', experimentId: 'bad id!' })).status, 422)
    assert.equal((await create(h, { id: 'launch', title: 'x', experimentId: 'exp-missing' })).status, 422, 'an unknown experiment')
    assert.equal((await create(h)).status, 201)
    assert.equal((await create(h)).status, 409, 'a duplicate site id')

    assert.equal((await stage(h, [])).status, 422)
    assert.equal((await stage(h, [index('<script>x</script>')])).status, 422)
    assert.equal((await stage(h, [{ path: 'app.js', text: 'x' }])).status, 422)
    assert.equal((await stage(h, [index()], h.tokens.agent, 'missing')).status, 404)

    const r = await stage(h, [index(), { path: 'style.css', text: CSS }, { path: 'img/logo.png', base64: PNG_B64 }, { path: 'terms.txt', text: 'Terms apply.' }])
    assert.equal(r.status, 201)
    assert.equal(r.body.deployed, false)
    assert.equal(r.body.release.version, 1)
    assert.equal(r.body.release.status, 'staged')
    assert.match(r.body.release.digest, /^sha256:/)
    assert.deepEqual(r.body.reviews.map((x: any) => [x.path, x.passes]).sort(), [['index.html', false], ['terms.txt', false]], 'only html and text are customer-facing copy; css and images are not reviewed')
    assert.equal((await stage(h, [index(PAGE.replace('48', '24'))])).body.release.version, 2)
    const read = await h.call(`${H}/sites/launch`, h.tokens.viewer)
    assert.equal(read.body.site.releases.length, 2)
    assert.equal(read.body.site.liveVersion, undefined)
    assert.deepEqual(read.body.site.events.map((e: any) => e.action), ['site-created', 'release-staged', 'release-staged'])
    assert.deepEqual(h.adapter.ops, [])
  } finally { await h.stop() }
})

test('publish: every HTML and text file needs a passing review of its exact content, from someone other than the stager; css and images are not gated', async () => {
  const h = await startHost()
  try {
    await create(h)
    await stage(h, [index(), { path: 'style.css', text: CSS }, { path: 'img/logo.png', base64: PNG_B64 }, { path: 'terms.txt', text: 'Terms apply.' }])
    const none = await publish(h, 1)
    assert.equal(none.status, 409)
    assert.deepEqual(none.body.blocked.map((b: any) => b.path).sort(), ['index.html', 'terms.txt'])
    assert.equal(none.body.deployed, false)

    await manualPass(h, PAGE + ' Now 50% off!') // a review of different text does not count
    assert.equal((await publish(h, 1)).status, 409)
    assert.equal((await manualPass(h, PAGE)).status, 201)
    const partial = await publish(h, 1)
    assert.equal(partial.status, 409)
    assert.deepEqual(partial.body.blocked.map((b: any) => b.path), ['terms.txt'], 'one reviewed page is not enough')
    assert.deepEqual(h.adapter.ops, [])

    await manualPass(h, 'Terms apply.')
    const done = await publish(h, 1)
    assert.equal(done.status, 200)
    assert.equal(done.body.deployed, true)
    assert.equal(done.body.site.liveVersion, 1)
    assert.equal(done.body.site.releases[0].status, 'published')
    assert.equal(done.body.site.releases[0].publishedBy, 'entity-founder')
    assert.deepEqual(h.adapter.ops, ['publish launch v1'])
    assert.deepEqual(h.adapter.live.get(`${TENANT}/launch`)?.paths.sort(), ['img/logo.png', 'index.html', 'style.css', 'terms.txt'])
    assert.equal((await publish(h, 1)).status, 409, 'a live release cannot be published again')
    assert.equal((await publish(h, 9)).status, 404)
    assert.equal((await h.call(`${H}/sites/launch/releases/abc/publish`, h.tokens.founder, {})).status, 404)
  } finally { await h.stop() }
})

test('publish: the stager cannot be the reviewer of their own page', async () => {
  const h = await startHost()
  try {
    await create(h, { id: 'launch', title: 'Launch page' }, h.tokens.founder)
    await stage(h, [index()], h.tokens.founder)
    await manualPass(h, PAGE) // the founder reviews what the founder staged
    const r = await publish(h, 1)
    assert.equal(r.status, 409)
    assert.equal(h.adapter.ops.length, 0)
  } finally { await h.stop() }
})

test('versions: a new release supersedes the live one, an older version can be published again as a rollback, and the history records each step', async () => {
  const h = await startHost()
  try {
    const v2 = PAGE.replace('48 hours', '24 hours')
    await manualPass(h, PAGE)
    await manualPass(h, v2)
    await create(h)
    await stage(h, [index()])
    await stage(h, [index(v2)])
    assert.equal((await publish(h, 1)).status, 200)
    const second = await publish(h, 2)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.site.releases.map((r: any) => r.status), ['superseded', 'published'])
    assert.equal(second.body.site.liveVersion, 2)
    assert.ok(second.body.site.releases[0].endedAt)

    const back = await publish(h, 1)
    assert.equal(back.status, 200)
    assert.deepEqual(back.body.site.releases.map((r: any) => r.status), ['published', 'superseded'])
    assert.equal(back.body.site.releases[0].rollbackOf, 2)
    assert.equal(back.body.site.releases[0].endedAt, undefined)
    assert.equal(h.adapter.live.get(`${TENANT}/launch`)?.version, 1)
    assert.deepEqual(back.body.site.events.map((e: any) => `${e.action}${e.version ? ` v${e.version}` : ''}`), [
      'site-created', 'release-staged v1', 'release-staged v2',
      'release-published v1', 'release-superseded v1', 'release-published v2', 'release-superseded v2', 'release-published v1',
    ])
    assert.equal(back.body.site.events.at(-1).detail, 'rollback')
  } finally { await h.stop() }
})

test('adapter failures: a failed publish changes nothing, a failed teardown leaves the site active, and both can be retried', async () => {
  const adapter = new MemoryHostingAdapter()
  const h = await startHost({ adapter })
  try {
    await manualPass(h, PAGE)
    await create(h)
    await stage(h)
    adapter.failNext = 'publish'
    const failed = await publish(h, 1)
    assert.equal(failed.status, 502)
    assert.equal(failed.body.deployed, false)
    const after = (await h.call(`${H}/sites/launch`, h.tokens.viewer)).body.site
    assert.equal(after.releases[0].status, 'staged')
    assert.equal(after.liveVersion, undefined)
    assert.deepEqual(after.events.map((e: any) => e.action), ['site-created', 'release-staged'])
    assert.equal((await publish(h, 1)).status, 200, 'the retry works')

    adapter.failNext = 'teardown'
    const down = await h.call(`${H}/sites/launch/teardown`, h.tokens.founder, { reason: 'Experiment over.' })
    assert.equal(down.status, 502)
    assert.equal((await h.call(`${H}/sites/launch`, h.tokens.viewer)).body.site.status, 'active')
    assert.equal((await h.call(`${H}/sites/launch/teardown`, h.tokens.founder, { reason: 'Experiment over.' })).status, 200)
  } finally { await h.stop() }
})

test('teardown: needs a reason, takes the live release down for good, and a torn-down site accepts nothing more', async () => {
  const h = await startHost()
  try {
    await manualPass(h, PAGE)
    await create(h)
    await stage(h)
    await publish(h, 1)
    assert.equal((await h.call(`${H}/sites/launch/teardown`, h.tokens.founder, {})).status, 422)
    const down = await h.call(`${H}/sites/launch/teardown`, h.tokens.founder, { reason: 'No longer needed.' })
    assert.equal(down.status, 200)
    assert.equal(down.body.site.status, 'torn-down')
    assert.equal(down.body.site.tornDownBy, 'entity-founder')
    assert.equal(down.body.site.tornDownReason, 'No longer needed.')
    assert.equal(down.body.site.liveVersion, undefined)
    assert.equal(down.body.site.releases[0].status, 'torn-down')
    assert.equal(h.adapter.live.has(`${TENANT}/launch`), false)
    assert.equal(down.body.site.events.at(-1).action, 'site-torn-down')

    assert.equal((await h.call(`${H}/sites/launch/teardown`, h.tokens.founder, { reason: 'again' })).status, 409)
    assert.equal((await stage(h)).status, 409)
    assert.equal((await publish(h, 1)).status, 409)
    assert.equal((await create(h)).status, 409, 'the id is not reusable')
  } finally { await h.stop() }
})

const E = '/api/genesis/experiments'

test('experiments: a site tied to an experiment comes down on its own when the experiment is killed, and cannot go live afterward', async () => {
  const h = await startHost()
  try {
    assert.equal((await h.call(E, h.tokens.founder, { definition: definition() })).status, 201)
    assert.equal((await create(h, { id: 'launch', title: 'Launch page', experimentId: 'exp-landing' })).status, 201, 'a draft experiment can have a site prepared')
    await manualPass(h, PAGE)
    await stage(h)
    assert.equal((await h.call(`${E}/exp-landing/start`, h.tokens.founder, {})).status, 200)
    assert.equal((await publish(h, 1)).status, 200)
    assert.equal(h.adapter.live.has(`${TENANT}/launch`), true)

    // A second site, tied to the same experiment, that was never published.
    await create(h, { id: 'spare', title: 'Spare', experimentId: 'exp-landing' })
    // And one tied to nothing, which an experiment ending must not touch.
    await create(h, { id: 'standalone', title: 'Standalone' })

    await h.call(`${E}/exp-landing/measurements`, h.tokens.agent, { value: 0.05, source: 'ledger totals, day 3' })
    const ev = await h.call(`${E}/exp-landing/evaluate`, h.tokens.viewer, {})
    assert.equal(ev.body.applied, 'killed')

    const list = (await h.call(`${H}/sites`, h.tokens.viewer)).body.sites as any[]
    const byId = Object.fromEntries(list.map((s) => [s.id, s]))
    assert.equal(byId.launch.status, 'torn-down')
    assert.equal(byId.launch.tornDownBy, 'kernel')
    assert.match(byId.launch.tornDownReason, /exp-landing.*killed/)
    assert.equal(byId.spare.status, 'torn-down')
    assert.equal(byId.standalone.status, 'active')
    assert.equal(h.adapter.live.has(`${TENANT}/launch`), false)
    assert.equal((await create(h, { id: 'late', title: 'Late', experimentId: 'exp-landing' })).status, 409, 'no new site for an ended experiment')
  } finally { await h.stop() }
})

test('reconcile: catches a site whose experiment ended without the hook running, and leaves running experiments alone', async () => {
  const h = await startHost()
  try {
    await h.call(E, h.tokens.founder, { definition: definition('exp-a') })
    await h.call(E, h.tokens.founder, { definition: definition('exp-b') })
    await h.call(`${E}/exp-a/start`, h.tokens.founder, {})
    await h.call(`${E}/exp-b/start`, h.tokens.founder, {})
    await manualPass(h, PAGE)
    for (const [id, exp] of [['site-a', 'exp-a'], ['site-b', 'exp-b']] as const) {
      await create(h, { id, title: id, experimentId: exp })
      await stage(h, [index()], h.tokens.agent, id)
      assert.equal((await publish(h, 1, h.tokens.founder, id)).status, 200)
    }
    await h.call(`${E}/exp-a/measurements`, h.tokens.agent, { value: 0.05, source: 'day 3' })
    // End exp-a with the adapter's next teardown failing, as if the hook had failed.
    h.adapter.failNext = 'teardown'
    assert.equal((await h.call(`${E}/exp-a/evaluate`, h.tokens.viewer, {})).body.applied, 'killed', 'the verdict stands even though the teardown failed')
    assert.equal(((await h.call(`${H}/sites/site-a`, h.tokens.viewer)).body.site).status, 'active', 'the hook failed, so the site is still up')

    const r = await h.call(`${H}/reconcile`, h.tokens.founder, {})
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.checked.sort(), ['site-a', 'site-b'])
    assert.deepEqual(r.body.tornDown, ['site-a'])
    assert.deepEqual(r.body.failed, [])
    assert.equal(((await h.call(`${H}/sites/site-a`, h.tokens.viewer)).body.site).status, 'torn-down')
    assert.equal(((await h.call(`${H}/sites/site-b`, h.tokens.viewer)).body.site).status, 'active')
    assert.deepEqual((await h.call(`${H}/reconcile`, h.tokens.founder, {})).body.tornDown, [], 'nothing left to do')
  } finally { await h.stop() }
})
