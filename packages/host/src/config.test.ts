import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { ConfigError, assertNoDevelopmentFlagsInProduction, checkWorkflow, loadHostConfig, parseHostConfig } from './config.ts'

const graph = {
  schemaVersion: 1, id: 'brief', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'ask', kind: 'agent', label: 'Ask', config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'ask' }, { id: 'e2', from: 'ask', to: 'done' }],
}

function problems(input: unknown): string[] {
  try {
    parseHostConfig(input)
    return []
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    return error.problems
  }
}

test('defaults are filled for a minimal config', () => {
  const config = parseHostConfig({ tenantId: 'nuera' })
  assert.equal(config.http.port, 8787)
  assert.equal(config.http.host, '127.0.0.1', 'loopback unless the config says otherwise (A-4)')
  assert.equal(config.http.metricsPublic, false)
  assert.deepEqual(config.store, { kind: 'memory' })
  assert.deepEqual(config.execution, { maxAgentSteps: 3, allowedAgents: ['query'] })
  assert.equal(config.worker.concurrency, 2)
})

test('the host binds to loopback by default; a public bind must be explicit (A-4)', () => {
  assert.equal(parseHostConfig({ tenantId: 'nuera' }).http.host, '127.0.0.1')
  assert.equal(parseHostConfig({ tenantId: 'nuera', http: { port: 9000 } }).http.host, '127.0.0.1', 'an http block without host stays on loopback')
  assert.equal(parseHostConfig({ tenantId: 'nuera', http: { host: '0.0.0.0' } }).http.host, '0.0.0.0', 'an explicit public bind is honored')
})

test('secrets can only be references, never inline values', () => {
  const base = { tenantId: 'nuera', workflows: { brief: graph }, services: [{ id: 'svc:hook', roles: ['trigger'] }] }
  const inline = problems({ ...base, webhooks: [{ id: 'erp', workflow: 'brief', secret: 'whsec_actual_secret_value_here_123456', principal: 'svc:hook' }] })
  assert.ok(inline.some((p) => p.includes('must be a reference')))
  assert.deepEqual(problems({ ...base, webhooks: [{ id: 'erp', workflow: 'brief', secret: 'env:ERP_SECRET', principal: 'svc:hook' }] }), [])
  assert.ok(problems({ ...base, webhooks: [{ id: 'erp', workflow: 'brief', secret: 'vault:erp', principal: 'svc:hook' }] }).some((p) => p.includes('no vault')))
  assert.ok(problems({ tenantId: 'nuera', store: { kind: 'postgres', url: 'postgres://user:pw@db/qs' } }).some((p) => p.includes('not here')))
})

test('trigger identities must hold only the trigger role', () => {
  const p = problems({
    tenantId: 'nuera',
    workflows: { brief: graph },
    services: [{ id: 'svc:cron', roles: ['trigger', 'supervisor'] }],
    schedules: [{ id: 'morning', workflow: 'brief', cron: '0 7 * * *', principal: 'svc:cron' }],
  })
  assert.ok(p.some((x) => x.includes('only the "trigger" role')))
  assert.ok(problems({ tenantId: 'nuera', workflows: { brief: graph }, schedules: [{ id: 'm', workflow: 'brief', cron: '0 7 * * *', principal: 'svc:missing' }] }).some((x) => x.includes('not a configured service')))
})

test('schedules, workflows and the execution policy are validated at startup', () => {
  const p = problems({
    tenantId: 'nuera',
    workflows: {
      brief: graph,
      planner: { ...graph, id: 'planner', nodes: graph.nodes.map((n) => (n.id === 'ask' ? { ...n, config: { agentId: 'planner', evaluationRequired: true } } : n)) },
      risky: { ...graph, id: 'risky', nodes: graph.nodes.map((n) => (n.id === 'ask' ? { ...n, config: { agentId: 'query', impact: 'high', evaluationRequired: true, supervisorApprovalRequired: true } } : n)) },
      broken: { ...graph, id: 'broken', entryNodeId: 'nope' },
    },
    services: [{ id: 'svc:cron', roles: ['trigger'] }],
    schedules: [{ id: 'bad', workflow: 'brief', cron: '61 * * * *', principal: 'svc:cron' }, { id: 'lost', workflow: 'missing', cron: '@daily', principal: 'svc:cron' }],
    execution: { allowedAgents: ['query', 'planner'] },
  })
  assert.ok(p.some((x) => x.startsWith('Schedule "bad"')))
  assert.ok(p.some((x) => x.includes('workflow "missing" is not defined')))
  assert.ok(p.some((x) => x.includes('allowedAgents may only contain "query"')))
  assert.ok(p.some((x) => x.startsWith('Workflow "risky"') && x.includes('high or critical')))
  assert.ok(p.some((x) => x.startsWith('Workflow "broken"')))
})

test('checkWorkflow accepts query agents by short or full id and caps agent steps', () => {
  const policy = { maxAgentSteps: 1, allowedAgents: ['query'] }
  assert.deepEqual(checkWorkflow(graph as never, policy), [])
  const two = {
    ...graph,
    nodes: [...graph.nodes.slice(0, 2), { id: 'ask2', kind: 'agent', label: 'Ask 2', config: { agentId: 'query', evaluationRequired: true } }, graph.nodes[2]!],
    edges: [{ id: 'e1', from: 'start', to: 'ask' }, { id: 'e2', from: 'ask', to: 'ask2' }, { id: 'e3', from: 'ask2', to: 'done' }],
  }
  assert.ok(checkWorkflow(two as never, policy).some((x) => x.includes('at most 1')))
})

test('loadHostConfig reads workflow files relative to the config and resolves paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-config-'))
  try {
    await writeFile(join(dir, 'brief.json'), JSON.stringify(graph))
    await writeFile(join(dir, 'host.json'), JSON.stringify({ tenantId: 'nuera', store: { kind: 'file', path: 'data/runs.jsonl' }, vault: { path: 'data/vault.json' }, workflows: { brief: { file: 'brief.json' } } }))
    const config = await loadHostConfig(join(dir, 'host.json'))
    assert.equal(config.workflows.brief!.id, 'brief')
    assert.equal(config.store.kind === 'file' && config.store.path, join(dir, 'data/runs.jsonl'))
    assert.equal(config.vault!.path, join(dir, 'data/vault.json'))
    await assert.rejects(loadHostConfig(join(dir, 'missing.json')), ConfigError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a config without tenantId takes the tenant from the environment default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-config-'))
  try {
    await writeFile(join(dir, 'host.json'), JSON.stringify({ store: { kind: 'memory' } }))
    assert.equal((await loadHostConfig(join(dir, 'host.json'), { tenantId: 'default' })).tenantId, 'default')
    await writeFile(join(dir, 'host2.json'), JSON.stringify({ tenantId: 'nuera' }))
    assert.equal((await loadHostConfig(join(dir, 'host2.json'), { tenantId: 'default' })).tenantId, 'nuera', 'an explicit tenantId wins')
    await assert.rejects(loadHostConfig(join(dir, 'host.json')), ConfigError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('development-only switches stop the host in production (A-10)', () => {
  const refused = (env: Record<string, string>) => {
    try {
      assertNoDevelopmentFlagsInProduction(env)
      return []
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      return error.problems
    }
  }
  assert.deepEqual(refused({ NODE_ENV: 'production' }), [])
  assert.deepEqual(refused({ NODE_ENV: 'production', QUICKSILVER_ALLOW_FAULT_INJECTION: 'off', QUICKSILVER_WORKFLOW_LIVE_RUNS: '' }), [])
  assert.deepEqual(refused({ NODE_ENV: 'development', QUICKSILVER_ALLOW_FAULT_INJECTION: 'on', QUICKSILVER_WORKFLOW_LIVE_RUNS: 'on' }), [], 'allowed outside production')
  assert.deepEqual(refused({ QUICKSILVER_ALLOW_FAULT_INJECTION: 'on' }), [], 'allowed with NODE_ENV unset')
  const fault = refused({ NODE_ENV: 'production', QUICKSILVER_ALLOW_FAULT_INJECTION: ' ON ' })
  assert.equal(fault.length, 1)
  assert.match(fault[0]!, /QUICKSILVER_ALLOW_FAULT_INJECTION=on is not allowed when NODE_ENV=production/)
  const live = refused({ NODE_ENV: 'Production', QUICKSILVER_WORKFLOW_LIVE_RUNS: 'on' })
  assert.equal(live.length, 1)
  assert.match(live[0]!, /QUICKSILVER_WORKFLOW_LIVE_RUNS=on/)
  assert.equal(refused({ NODE_ENV: 'production', QUICKSILVER_ALLOW_FAULT_INJECTION: 'on', QUICKSILVER_WORKFLOW_LIVE_RUNS: 'on' }).length, 2, 'every switch is named')
})

test('the host process refuses to start with a development-only switch on in production (A-10)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-prod-flags-'))
  try {
    const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts')
    const env = { PATH: process.env.PATH ?? '', INIT_CWD: dir, NODE_ENV: 'production', QUICKSILVER_ALLOW_FAULT_INJECTION: 'on', QUICKSILVER_HOST_CONFIG: join(dir, 'missing.json') }
    const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--no-warnings', main, 'check'], { env, cwd: dir }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? '' }),
    )
    assert.equal(result.code, 1)
    assert.match(result.stderr, /QUICKSILVER_ALLOW_FAULT_INJECTION=on is not allowed when NODE_ENV=production/)
    assert.doesNotMatch(result.stderr, /missing\.json/, 'refused before the config is read')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
