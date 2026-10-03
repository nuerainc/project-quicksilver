import { test } from 'node:test'
import assert from 'node:assert/strict'

import { issueExecutionAuthorization, type AuthorizationSigningKey, type ExecutionAuthorizationRecord } from '@quicksilver/kernel/runtime'

import { dryRunTools, EffectfulToolExecutor, sha256, ToolRefusedError, type ExpectedGrant, type ToolCall } from './tool-executor.ts'

const KEY: AuthorizationSigningKey = { keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' }
const T0 = 1_780_000_000_000

const call = (over: Partial<ToolCall> = {}): ToolCall => ({ toolId: 'notification.send', input: { channel: 'ops', message: 'hello' }, tenantId: 'acme', runId: 'run-1', nodeId: 'send', idempotencyKey: 'run-1:send', ...over })
const expected = (c = call()): ExpectedGrant => ({ actionFingerprint: `action:${c.nodeId}:${c.toolId}`, workflowDigest: sha256({ toolId: c.toolId, input: c.input }), approvalDigest: 'sha256:approval', evidenceCount: 2 })
const grant = (c = call(), over: Partial<ExecutionAuthorizationRecord> = {}): { record: ExecutionAuthorizationRecord; expected: ExpectedGrant } => {
  const e = expected(c)
  const record = issueExecutionAuthorization({
    tenantId: c.tenantId, runId: c.runId, nodeId: c.nodeId, actionFingerprint: e.actionFingerprint, policySnapshot: 'sha256:policy',
    evidenceDigest: 'sha256:evidence', evidenceCount: e.evidenceCount, workflowDigest: e.workflowDigest, approvalDigest: e.approvalDigest,
    capability: c.toolId, expiresAt: T0 + 60_000,
  }, KEY, T0)
  return { record: { ...record, ...over }, expected: e }
}
const executor = (signingKey: AuthorizationSigningKey | null = KEY) => new EffectfulToolExecutor({ tools: dryRunTools(), ...(signingKey ? { signingKey } : {}), now: () => T0 + 1_000 })
const refusal = async (p: Promise<unknown>) => { try { await p } catch (e) { assert.ok(e instanceof ToolRefusedError, String(e)); return (e as ToolRefusedError).reasons.join(' ') } assert.fail('expected a refusal') }

test('an unregistered tool is refused and the refusal is audited', async () => {
  const ex = executor()
  assert.match(await refusal(ex.execute(call({ toolId: 'email.send' }))), /not registered/)
  assert.equal(ex.auditLog().at(-1)?.status, 'refused')
})

test('a read-only tool runs without a grant; a side-effect tool does not', async () => {
  const ex = executor()
  const read = await ex.execute(call({ toolId: 'sanity.query', input: {} }))
  assert.equal((read.output as { executed: boolean }).executed, false)
  assert.match(await refusal(ex.execute(call())), /needs a kernel-signed execution authorization/)
  assert.match(await refusal(executor(null).execute(call(), grant())), /signing key is not configured/)
})

test('a valid grant runs the tool once; the dry run says nothing happened; the audit names the grant', async () => {
  const ex = executor()
  const g = grant()
  const out = await ex.execute(call(), g)
  assert.deepEqual({ dryRun: (out.output as any).dryRun, executed: (out.output as any).executed }, { dryRun: true, executed: false })
  assert.equal(out.audit.status, 'success')
  assert.equal(out.audit.authorizationId, g.record.authorizationId)
  assert.equal(out.audit.keyId, KEY.keyId)
  assert.match(await refusal(ex.execute(call(), g)), /already used; replay refused/)
})

test('the grant is checked against what the caller expects, never against its own fields', async () => {
  // A genuine, correctly signed grant for one thing must not authorize another.
  const ex = () => executor()
  const g = grant()
  const other = { ...g.expected }
  assert.match(await refusal(ex().execute(call(), { record: g.record, expected: { ...other, workflowDigest: sha256({ toolId: 'notification.send', input: { channel: 'ops', message: 'something else' } }) } })), /not bound to this workflow content/)
  assert.match(await refusal(ex().execute(call(), { record: g.record, expected: { ...other, approvalDigest: 'sha256:a-different-approval' } })), /not bound to this approval/)
  assert.match(await refusal(ex().execute(call(), { record: g.record, expected: { ...other, evidenceCount: 5 } })), /different amount of evidence/)
  assert.match(await refusal(ex().execute(call(), { record: g.record, expected: { ...other, actionFingerprint: 'action:other:notification.send' } })), /action fingerprint does not match/)
  assert.match(await refusal(ex().execute(call({ tenantId: 'other' }), g)), /tenant does not match/)
  assert.match(await refusal(ex().execute(call({ runId: 'run-2' }), g)), /run does not match/)
  assert.match(await refusal(ex().execute(call({ nodeId: 'other' }), g)), /node does not match/)
})

test('a tampered, expired or wrong-tool grant is refused', async () => {
  assert.match(await refusal(executor().execute(call(), grant(call(), { evidenceCount: 9 }))), /tampered|different amount/)
  assert.match(await refusal(executor().execute(call(), grant(call(), { signature: 'f'.repeat(64) }))), /signature is invalid/)
  assert.match(await refusal(executor().execute(call(), grant(call(), { expiresAt: T0 }))), /expired/)
  const late = new EffectfulToolExecutor({ tools: dryRunTools(), signingKey: KEY, now: () => T0 + 120_000 })
  assert.match(await refusal(late.execute(call(), grant())), /expired/)
  // Signed for another tool, presented for this one.
  const c = call()
  const forOther = grant(call({ toolId: 'webhook.dispatch' }))
  assert.match(await refusal(executor().execute(c, { record: forOther.record, expected: forOther.expected })), /does not match|different tool/)
  assert.match(await refusal(executor().execute(call(), { record: { ...grant().record, status: 'consumed' }, expected: expected() })), /not issued/)
})

test('an adapter failure is audited as failed and rethrown; the grant stays spent', async () => {
  const ex = executor()
  const c = call({ toolId: 'webhook.dispatch', input: { url: 'http://insecure.example' } })
  const g = grant(c)
  await assert.rejects(ex.execute(c, g), /https:\/\//)
  assert.equal(ex.auditLog().at(-1)?.status, 'failed')
  assert.match(await refusal(ex.execute(c, g)), /replay refused/)
})

test('the shipped tools are dry runs: none reports an effect, and the public challenge project is off limits', async () => {
  for (const [toolId, input] of [['notification.send', { message: 'x' }], ['webhook.dispatch', { url: 'https://hooks.example.test/x' }], ['sanity.mutate', { projectId: 'p1', mutations: [] }]] as const) {
    const c = call({ toolId, input })
    const out = await executor().execute(c, grant(c))
    assert.equal((out.output as { executed: boolean }).executed, false, toolId)
  }
  const c = call({ toolId: 'sanity.mutate', input: { projectId: 'd280bqjc' } })
  await assert.rejects(executor().execute(c, grant(c)), /public Quicksilver challenge project/)
})
