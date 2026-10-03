import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildGovernedMemory } from './governed-memory.ts'

const entry = { id: 'm1', kind: 'failure-exemplar' as const, domain: 'planning', content: 'A lesson.', source: 'test', confidence: 0.8, retentionDays: 30 }
const agent = { id: 'nuera-quicksilver:query', kind: 'agent' as const }

test('with the file store, memory is kept in the tenant folder and survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-host-memory-'))
  const config = { tenantId: 'acme', store: { kind: 'file' as const, path: join(dir, 'runs.json') } }
  const first = buildGovernedMemory(config)
  assert.equal(first.persistent, true)
  assert.equal(first.path, join(dir, 'acme', 'memory.json'))
  assert.equal(first.store.write(entry, { proposedBy: agent }).stored, true)
  assert.equal(buildGovernedMemory(config).store.recall().length, 1)
})

test('two tenants never share a memory file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-host-memory-'))
  const base = { kind: 'file' as const, path: join(dir, 'runs.json') }
  buildGovernedMemory({ tenantId: 'a', store: base }).store.write(entry, { proposedBy: agent })
  assert.equal(buildGovernedMemory({ tenantId: 'b', store: base }).store.recall().length, 0)
})

test('without the file store memory is held in memory and reported as not persistent', () => {
  const m = buildGovernedMemory({ tenantId: 'acme', store: { kind: 'memory' } as never })
  assert.equal(m.persistent, false)
  assert.equal(m.path, undefined)
})
