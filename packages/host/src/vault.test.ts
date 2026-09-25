import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccessController, type Principal } from '@quicksilver/kernel/identity'

import { SecretsVault, VaultError, generateMasterKey, parseMasterKey, type VaultAuditEvent } from './vault.ts'

const TENANT = 'nuera'
const admin: Principal = { id: 'entity-admin', kind: 'human', tenantId: TENANT, roles: ['tenant-admin'] }
const developer: Principal = { id: 'entity-dev', kind: 'human', tenantId: TENANT, roles: ['developer'] }
const viewer: Principal = { id: 'entity-viewer', kind: 'human', tenantId: TENANT, roles: ['viewer'] }
const agent: Principal = { id: 'agent:nuera-quicksilver:query', kind: 'agent', tenantId: TENANT, roles: ['agent-worker', 'tenant-admin'] }
const outsider: Principal = { id: 'entity-other', kind: 'human', tenantId: 'acme', roles: ['tenant-admin'] }

async function setup(options: { now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qs-vault-'))
  const key = generateMasterKey()
  const events: VaultAuditEvent[] = []
  const make = (masterKey = key, tenantId = TENANT) =>
    new SecretsVault({ path: join(dir, 'vault.json'), masterKey, tenantId, access: new AccessController(), audit: (e) => events.push(e), ...options })
  const vault = make()
  await vault.open()
  return { dir, key, vault, events, make, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('master keys must be 32 bytes, as base64 or hex', () => {
  assert.equal(parseMasterKey(generateMasterKey()).length, 32)
  assert.equal(parseMasterKey('ab'.repeat(32)).length, 32)
  assert.throws(() => parseMasterKey('too-short'), VaultError)
  assert.throws(() => parseMasterKey(undefined), VaultError)
})

test('values are encrypted at rest and round-trip for authorized principals', async () => {
  const { vault, dir, cleanup } = await setup()
  try {
    await vault.put(admin, 'erp-webhook', 'whsec_super_secret_value_123456789')
    const raw = await readFile(join(dir, 'vault.json'), 'utf8')
    assert.ok(!raw.includes('whsec_super_secret_value_123456789'))
    assert.equal(await vault.use(developer, 'erp-webhook'), 'whsec_super_secret_value_123456789')
    assert.equal(await vault.reveal(admin, 'erp-webhook'), 'whsec_super_secret_value_123456789')
  } finally {
    await cleanup()
  }
})

test('RBAC: viewers, agents and other tenants are refused; every access is audited without values', async () => {
  const { vault, events, cleanup } = await setup()
  try {
    await vault.put(admin, 'db-password', 'correct horse battery staple')
    await assert.rejects(vault.use(viewer, 'db-password'), (e: VaultError) => e.code === 'forbidden')
    await assert.rejects(vault.reveal(developer, 'db-password'), (e: VaultError) => e.code === 'forbidden')
    await assert.rejects(vault.put(developer, 'db-password', 'x'), (e: VaultError) => e.code === 'forbidden')
    await assert.rejects(vault.reveal(agent, 'db-password'), (e: VaultError) => e.code === 'forbidden')
    await assert.rejects(vault.use(outsider, 'db-password'), (e: VaultError) => e.code === 'forbidden')
    await assert.rejects(vault.use(undefined, 'db-password'), (e: VaultError) => e.code === 'forbidden')
    assert.ok(events.some((e) => e.operation === 'put' && e.allowed && e.principalId === 'entity-admin'))
    assert.equal(events.filter((e) => !e.allowed).length, 6)
    assert.ok(!JSON.stringify(events).includes('correct horse'))
  } finally {
    await cleanup()
  }
})

test('rotation keeps earlier versions valid for the grace period, then drops them', async () => {
  const clock = { t: Date.parse('2026-10-01T00:00:00Z') }
  const { vault, cleanup } = await setup({ now: () => clock.t })
  try {
    await vault.put(admin, 'erp-webhook', 'first-secret-value')
    const rotated = await vault.put(admin, 'erp-webhook', 'second-secret-value', { graceMs: 60_000 })
    assert.equal(rotated.activeVersion, 2)
    assert.equal(await vault.use(developer, 'erp-webhook'), 'second-secret-value')
    assert.deepEqual(await vault.useAll(developer, 'erp-webhook'), ['second-secret-value', 'first-secret-value'])
    clock.t += 61_000
    assert.deepEqual(await vault.useAll(developer, 'erp-webhook'), ['second-secret-value'])
    const third = await vault.put(admin, 'erp-webhook', 'third-secret-value', { graceMs: 0 })
    assert.deepEqual(third.versions.map((v) => v.version), [3], 'expired and zero-grace versions are dropped')
    assert.deepEqual(await vault.useAll(developer, 'erp-webhook'), ['third-secret-value'])
  } finally {
    await cleanup()
  }
})

test('the vault fails closed on a wrong key, another tenant, tampering, or a disabled secret', async () => {
  const { vault, make, dir, cleanup } = await setup()
  try {
    await vault.put(admin, 'api-key', 'sk-value-that-should-stay-private')
    await assert.rejects(make(generateMasterKey()).open(), (e: VaultError) => e.code === 'wrong-key')
    await assert.rejects(make(undefined, 'acme').open(), (e: VaultError) => e.code === 'invalid')

    const path = join(dir, 'vault.json')
    const original = await readFile(path, 'utf8')

    // A ciphertext copied to another name does not decrypt (the name is bound as associated data).
    const moved = JSON.parse(original)
    moved.secrets['moved'] = { ...moved.secrets['api-key'], name: 'moved' }
    await writeFile(path, JSON.stringify(moved))
    const copied = make()
    await copied.open()
    await assert.rejects(copied.use(developer, 'moved'), (e: VaultError) => e.code === 'corrupt')

    // Flipping one ciphertext bit is detected.
    const tampered = JSON.parse(original)
    const data = Buffer.from(tampered.secrets['api-key'].versions[0].data, 'base64')
    data[0] = data[0]! ^ 0xff
    tampered.secrets['api-key'].versions[0].data = data.toString('base64')
    await writeFile(path, JSON.stringify(tampered))
    const reopened = make()
    await reopened.open()
    await assert.rejects(reopened.use(developer, 'api-key'), (e: VaultError) => e.code === 'corrupt')

    await writeFile(path, original)
    await vault.disable(admin, 'api-key')
    await assert.rejects(vault.use(developer, 'api-key'), (e: VaultError) => e.code === 'disabled')
  } finally {
    await cleanup()
  }
})

test('names and sizes are validated', async () => {
  const { vault, cleanup } = await setup()
  try {
    await assert.rejects(vault.put(admin, 'Bad Name', 'x'), (e: VaultError) => e.code === 'invalid')
    await assert.rejects(vault.put(admin, 'ok-name', ''), (e: VaultError) => e.code === 'invalid')
    await assert.rejects(vault.put(admin, 'ok-name', 'x'.repeat(70_000)), (e: VaultError) => e.code === 'invalid')
    await assert.rejects(vault.use(developer, 'missing'), (e: VaultError) => e.code === 'not-found')
    const listed = await vault.list(developer)
    assert.deepEqual(listed, [])
  } finally {
    await cleanup()
  }
})
