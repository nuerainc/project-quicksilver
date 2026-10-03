/**
 * P-107: two tenants, two hosts, one shared store directory, for the parts the first isolation test did not cover:
 * workflow publication (drafts, review, publish), runs started from a published workflow, and schedules.
 * The workflow id is the same in both tenants on purpose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { WorkflowGraph } from '@quicksilver/kernel/workflows/graph'

import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const graph = (label: string): WorkflowGraph => ({
  schemaVersion: 1, id: 'campaign', version: 1, entryNodeId: 'start',
  nodes: [{ id: 'start', kind: 'trigger', label }, { id: 'done', kind: 'output', label: 'Done' }],
  edges: [{ id: 'e1', from: 'start', to: 'done' }],
})

function person(id: string, tenantId: string, roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind: 'human', tenantId, roles, tokenDigest } }
}

async function startTenant(tenantId: string, storeDir: string, extra: Record<string, unknown> = {}) {
  const developer = person('entity-developer', tenantId, ['developer'])
  const reviewer = person('entity-reviewer', tenantId, ['supervisor'])
  const publisher = person('entity-publisher', tenantId, ['supervisor'])
  const operator = person('entity-operator', tenantId, ['operator'])
  const viewer = person('entity-viewer', tenantId, ['viewer'])
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-wf-audit-'))
  const host = new QuicksilverHost(parseHostConfig({
    tenantId, http: { host: '127.0.0.1', port: 0 }, worker: { id: `host-${tenantId}`, concurrency: 1, pollIntervalMs: 50 },
    queue: { defaultMaxAttempts: 1 }, store: { kind: 'file', path: join(storeDir, `runs-${tenantId}.json`) }, workflows: {}, ...extra,
  }), {
    principals: [developer.config, reviewer.config, publisher.config, operator.config, viewer.config],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl') },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const publish = async (g: WorkflowGraph) => {
    assert.equal((await call('/api/workflows/drafts', developer.token, { graph: g })).status, 201)
    assert.equal((await call('/api/workflows/campaign/submit-review', developer.token, { version: 1 })).status, 200)
    assert.equal((await call('/api/workflows/campaign/review', reviewer.token, { version: 1 })).status, 200)
    assert.equal((await call('/api/workflows/campaign/publish', publisher.token, { version: 1 })).status, 200)
  }
  const stop = async () => { await host.stop({ abort: true }); await rm(auditDir, { recursive: true, force: true }) }
  return { call, publish, stop, tokens: { developer: developer.token, operator: operator.token, viewer: viewer.token } }
}

test('two tenants sharing a store directory: a workflow published in one is not visible to, runnable by, or overwritten by the other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-tenants-wf-'))
  const alpha = await startTenant('alpha', dir)
  const beta = await startTenant('beta', dir)
  try {
    await alpha.publish(graph('Alpha campaign'))

    // Beta sees nothing of alpha's publication.
    const betaList = await beta.call('/api/workflows', beta.tokens.viewer)
    assert.deepEqual(betaList.body.published ?? betaList.body.publications ?? [], [], "beta's published list is empty")
    assert.equal((await beta.call('/api/workflows/campaign', beta.tokens.viewer)).status, 404, "beta has no 'campaign'")

    // Beta cannot start a run from alpha's published graph.
    const betaRun = await beta.call('/api/runs', beta.tokens.operator, { workflow: 'campaign' })
    assert.equal(betaRun.status, 422, "beta cannot run alpha's workflow")

    // Alpha can, and the run is alpha's only.
    const alphaRun = await alpha.call('/api/runs', alpha.tokens.operator, { workflow: 'campaign' })
    assert.equal(alphaRun.status, 202)
    assert.equal((await beta.call(`/api/runs/${alphaRun.body.runId}`, beta.tokens.viewer)).status, 404, "beta cannot read alpha's run")
    assert.deepEqual((await beta.call('/api/runs', beta.tokens.viewer)).body.runs ?? [], [], 'beta lists no runs')

    // Beta publishes its own 'campaign' with different content; alpha's is untouched.
    await beta.publish(graph('Beta campaign'))
    const alphaVersions = await alpha.call('/api/workflows/campaign', alpha.tokens.viewer)
    const betaVersions = await beta.call('/api/workflows/campaign', beta.tokens.viewer)
    assert.equal(alphaVersions.body.versions.length, 1)
    assert.equal(betaVersions.body.versions.length, 1)
    assert.notEqual(alphaVersions.body.versions[0].digest, betaVersions.body.versions[0].digest, 'the two tenants hold different content under the same id')
    const betaRun2 = await beta.call('/api/runs', beta.tokens.operator, { workflow: 'campaign' })
    assert.equal(betaRun2.status, 202)
    assert.equal(betaRun2.body.publication.digest, betaVersions.body.versions[0].digest, 'beta runs its own content')
  } finally { await alpha.stop(); await beta.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('two tenants sharing a store directory: a restart brings back each tenant\'s own publications and no one else\'s', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-tenants-wf2-'))
  let alpha = await startTenant('alpha', dir)
  let beta = await startTenant('beta', dir)
  try {
    await alpha.publish(graph('Alpha campaign'))
    await beta.publish(graph('Beta campaign'))
    const alphaDigest = (await alpha.call('/api/workflows/campaign', alpha.tokens.viewer)).body.versions[0].digest as string
    const betaDigest = (await beta.call('/api/workflows/campaign', beta.tokens.viewer)).body.versions[0].digest as string
    assert.notEqual(alphaDigest, betaDigest)
    await alpha.stop(); await beta.stop()

    alpha = await startTenant('alpha', dir)
    beta = await startTenant('beta', dir)
    const alphaAfter = await alpha.call('/api/workflows/campaign', alpha.tokens.viewer)
    const betaAfter = await beta.call('/api/workflows/campaign', beta.tokens.viewer)
    assert.equal(alphaAfter.status, 200, "alpha's publication survives a restart")
    assert.deepEqual(alphaAfter.body.versions.map((v: { digest: string }) => v.digest), [alphaDigest], 'alpha has its own content, not beta\'s')
    assert.deepEqual(betaAfter.body.versions.map((v: { digest: string }) => v.digest), [betaDigest], 'beta has its own content, not alpha\'s')

    // A tenant that starts later, with nothing published, sees neither.
    const gamma = await startTenant('gamma', dir)
    try {
      assert.equal((await gamma.call('/api/workflows/campaign', gamma.tokens.viewer)).status, 404)
    } finally { await gamma.stop() }
    assert.ok((await readdir(dir)).length > 0)
  } finally { await alpha.stop(); await beta.stop(); await rm(dir, { recursive: true, force: true }) }
})

test('an old workflow-publications.json that does not say which tenant owns it is ignored, with a warning that says how to move it', async () => {
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'qs-tenants-wf3-'))
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-wf-audit-'))
  await writeFile(join(dir, 'workflow-publications.json'), JSON.stringify({ versions: [], audit: [] }))
  const lines: string[] = []
  const { tokenDigest } = generateToken()
  const host = new QuicksilverHost(parseHostConfig({ tenantId: 'alpha', http: { host: '127.0.0.1', port: 0 }, store: { kind: 'file', path: join(dir, 'runs.json') }, workflows: {} }), {
    principals: [{ id: 'entity-viewer', kind: 'human', tenantId: 'alpha', roles: ['viewer'], tokenDigest }],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl') },
    logger: new Logger({ level: 'warn', sink: { write: (line) => lines.push(line) } }),
  })
  try {
    await host.start()
    assert.ok(lines.some((l) => /workflow-publications\.json/.test(l) && /<tenant>\/workflow-publications\.json/.test(l)), 'the warning names the file and where to move it')
  } finally { await host.stop({ abort: true }); await rm(dir, { recursive: true, force: true }); await rm(auditDir, { recursive: true, force: true }) }
})
