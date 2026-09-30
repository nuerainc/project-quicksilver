import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessController } from '@quicksilver/kernel/identity'
import { FileAuthorizationAuditStore } from './authorization-audit.ts'

const person = { id: 'entity-a', kind: 'human' as const, tenantId: 'acme', roles: ['supervisor'] }

test('file authorization audit preserves allow and deny records across store restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-auth-audit-'))
  try {
    const path = join(dir, 'authorization.jsonl')
    const audit = new FileAuthorizationAuditStore(path)
    const access = new AccessController({ audit: (decision) => audit.append(decision) })
    assert.equal(access.authorize(person, 'decision:execute', { tenantId: 'acme' }).allowed, true)
    assert.equal(access.authorize(person, 'tenant:admin', { tenantId: 'acme' }).allowed, false)
    new FileAuthorizationAuditStore(path) // startup replay validates durable sequence/hash state
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { decision: { principalId: string; allowed: boolean } })
    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map((entry) => [entry.decision.principalId, entry.decision.allowed]), [['entity-a', true], ['entity-a', false]])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('file authorization audit rejects tampering and a failed sink denies an otherwise allowed action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-auth-audit-'))
  try {
    const path = join(dir, 'authorization.jsonl')
    const audit = new FileAuthorizationAuditStore(path)
    const access = new AccessController({ audit: (decision) => audit.append(decision) })
    access.authorize(person, 'decision:execute', { tenantId: 'acme' })
    const raw = await readFile(path, 'utf8')
    await writeFile(path, raw.replace('decision:execute', 'tenant:admin'))
    assert.throws(() => new FileAuthorizationAuditStore(path), /integrity check failed/)
    await writeFile(path, '')
    assert.throws(() => new FileAuthorizationAuditStore(path), /tail does not match its head checkpoint/)
    const failing = new AccessController({ audit: () => { throw new Error('disk unavailable') } })
    const denied = failing.authorize(person, 'decision:execute', { tenantId: 'acme' })
    assert.equal(denied.allowed, false)
    assert.match(denied.reasons.at(-1)!, /audit persistence failed/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
