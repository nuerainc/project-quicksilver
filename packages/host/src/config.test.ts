import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigError, checkWorkflow, loadHostConfig, parseHostConfig } from './config.ts'

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
  assert.equal(config.http.metricsPublic, false)
  assert.deepEqual(config.store, { kind: 'memory' })
  assert.deepEqual(config.execution, { maxAgentSteps: 3, allowedAgents: ['query'] })
  assert.equal(config.worker.concurrency, 2)
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
