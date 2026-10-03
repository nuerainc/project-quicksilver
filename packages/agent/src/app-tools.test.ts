import assert from 'node:assert/strict'
import { test } from 'node:test'

import { APP_TOOL_NAMES, APP_TOOL_SAMPLE_PATHS, buildAppTools, isAllowedAppLink, shapeAppResult } from './app-tools.ts'
import { listAgentManifests } from './governance.ts'

type Executable = { execute: (input: unknown, options: unknown) => Promise<unknown>; inputSchema: { safeParse(v: unknown): { success: boolean } } }
const run = (tools: Record<string, unknown>, name: string, input: unknown) => (tools[name] as Executable).execute(input, {})

test('every tool only reads: names are get_ or list_, and there is no approve, execute or publish tool', () => {
  assert.ok(APP_TOOL_NAMES.length >= 10)
  for (const name of APP_TOOL_NAMES) assert.match(name, /^(get|list)_/)
  assert.ok(!APP_TOOL_NAMES.some((n) => /approve|reject|execute|publish|rollback|delete|write|send|run_/.test(n)))
})

test('each tool reads one fixed GET path built from validated input', async () => {
  const seen: string[] = []
  const tools = buildAppTools(async (path) => { seen.push(path); return { status: 200, body: { ok: true } } })
  await run(tools, 'get_my_access', {})
  await run(tools, 'list_decisions', { status: 'awaiting-approval', limit: 5 })
  await run(tools, 'list_decisions', { status: null, limit: null })
  await run(tools, 'get_decision', { id: 'decision-plan-abc-0' })
  await run(tools, 'get_workflow_runs', { workflowId: 'wf.one' })
  assert.deepEqual(seen, [
    '/api/whoami',
    '/api/decisions?status=awaiting-approval&limit=5',
    '/api/decisions?limit=10',
    '/api/decisions/decision-plan-abc-0',
    '/api/workflows/executions?workflowId=wf.one&limit=10',
  ])
})

test('input that could change the path is rejected before any request is made', () => {
  const tools = buildAppTools(async () => ({ status: 200, body: {} }))
  const decision = tools.get_decision as Executable
  assert.equal(decision.inputSchema.safeParse({ id: 'x' }).success, true)
  for (const id of ['../admin', 'a/b', 'a?b=c', '', 'x'.repeat(201)]) assert.equal(decision.inputSchema.safeParse({ id }).success, false, id)
  const runs = tools.get_workflow_runs as Executable
  assert.equal(runs.inputSchema.safeParse({ workflowId: 'a/../b' }).success, false)
  const list = tools.list_decisions as Executable
  assert.equal(list.inputSchema.safeParse({ status: 'anything', limit: 5 }).success, false)
  assert.equal(list.inputSchema.safeParse({ status: null, limit: 500 }).success, false)
})

test('a refusal comes back as "not available to you, you need X", never as data', () => {
  assert.deepEqual(shapeAppResult({ status: 403, body: { error: 'This credential is not permitted to perform this action.', needs: ['finance:read'] } }), {
    available: false, reason: 'This credential is not permitted to perform this action.', needs: ['finance:read'],
  })
  assert.deepEqual(shapeAppResult({ status: 401, body: {} }), { available: false, reason: 'The person is not signed in.' })
  assert.deepEqual(shapeAppResult({ status: 404, body: {} }), { available: false, reason: 'Not found.' })
  assert.match(String((shapeAppResult({ status: 503, body: {} }) as { reason: string }).reason), /status 503/)
})

test('a large reply is cut and says so', () => {
  const shaped = shapeAppResult({ status: 200, body: { rows: 'x'.repeat(50_000) } }) as { truncated: boolean; text: string }
  assert.equal(shaped.truncated, true)
  assert.equal(shaped.text.length, 12_000)
})

test('calls are logged for the evaluation, with failures marked', async () => {
  const log: Array<{ name: string; succeeded: boolean }> = []
  const tools = buildAppTools(async (path) => { if (path.includes('traces')) throw new Error('boom'); return { status: 200, body: {} } }, log as never)
  await run(tools, 'get_business_overview', {})
  await assert.rejects(run(tools, 'get_trace_summary', {}), /boom/)
  assert.deepEqual(log.map((c) => [c.name, c.succeeded]), [['get_business_overview', true], ['get_trace_summary', false]])
})

test('the assistant may only link to pages of the app', () => {
  for (const ok of ['/', '/decisions', '/decisions?id=decision-plan-1-0', '/workflows', '/monitoring', '/monitoring/traces', '/agents', '/entities', '/entities?search=Ana']) assert.equal(isAllowedAppLink(ok), true, ok)
  for (const bad of ['https://evil.example', '//evil.example', '/api/auth/logout', '/api/decisions/x/action', 'javascript:alert(1)', '/decisions?id=a b', '/studio', '/planning/../api']) assert.equal(isAllowedAppLink(bad), false, bad)
})

test('the assistant is a registered agent that reads and proposes nothing', () => {
  const assistant = listAgentManifests().find((m) => m.id === 'nuera-quicksilver:assistant')
  assert.ok(assistant)
  assert.equal(assistant!.authority, 'propose')
  assert.equal(assistant!.maximumImpact, 'low')
  assert.equal(assistant!.requiresEvaluation, true)
})

test('get_attention reads the inbox and tells the model to ask for the live list, not to list the items itself', () => {
  assert.ok(APP_TOOL_NAMES.includes('get_attention'))
  assert.ok(APP_TOOL_SAMPLE_PATHS.includes('/api/inbox'))
})
