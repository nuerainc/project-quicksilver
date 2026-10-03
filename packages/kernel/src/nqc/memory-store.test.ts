import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FileMemoryStore, MemoryStore } from '../index.ts'
import type { GovernedMemoryEntry } from './memory.ts'

const agent = { id: 'nuera-quicksilver:planner', kind: 'agent' as const }
const person = { id: 'ada', kind: 'human' as const }
const DAY = 86_400_000
const t0 = Date.parse('2026-10-03T12:00:00Z')

const exemplar = (over: Partial<GovernedMemoryEntry> = {}): GovernedMemoryEntry => ({
  id: 'm1', kind: 'failure-exemplar', domain: 'planning', content: 'Plans that skip the evidence step were refused.',
  source: 'quicksilver-engine/model-x', confidence: 0.8, retentionDays: 30, ...over,
})

test('a governed write is stored with its author, source and expiry', () => {
  const store = new MemoryStore()
  const r = store.write(exemplar(), { proposedBy: agent, now: t0 })
  assert.equal(r.stored, true)
  const [stored] = store.entries()
  assert.deepEqual(stored!.proposedBy, agent)
  assert.equal(stored!.source, 'quicksilver-engine/model-x')
  assert.equal(stored!.expiresAt, new Date(t0 + 30 * DAY).toISOString())
  assert.match(stored!.contentHash, /^sha256:[0-9a-f]{64}$/)
})

test('what the governor refuses never reaches the store, and the refusal is recorded without the text', () => {
  const store = new MemoryStore()
  const secret = 'api_key = sk-abcdefghijklmnopqrstuvwxyz'
  const r = store.write(exemplar({ content: secret }), { proposedBy: agent, now: t0 })
  assert.equal(r.stored, false)
  assert.equal(store.entries().length, 0)
  const [event] = store.events()
  assert.equal(event!.event, 'refused')
  assert.ok(!JSON.stringify(store.events()).includes('sk-abcdef'))
})

test('an agent cannot write a behaviour-changing kind without a verified supervisor approval', () => {
  const store = new MemoryStore()
  const rule = exemplar({ id: 'r1', kind: 'routing-rule', content: 'Send planning to the cheaper model.' })
  assert.equal(store.write(rule, { proposedBy: agent, now: t0 }).stored, false)
  assert.equal(store.write({ ...rule, approvalId: 'apr-1' }, { proposedBy: agent, now: t0, verifySupervisorApproval: () => false }).stored, false)
  const ok = store.write({ ...rule, approvalId: 'apr-1' }, { proposedBy: agent, now: t0, verifySupervisorApproval: (id) => id === 'apr-1' })
  assert.equal(ok.stored, true)
  assert.equal(store.entries()[0]!.approvalId, 'apr-1')
})

test('recall is advisory, hides the approval record, skips expired entries and orders by confidence', () => {
  const store = new MemoryStore()
  store.write(exemplar({ id: 'a', confidence: 0.6 }), { proposedBy: agent, now: t0 })
  store.write(exemplar({ id: 'b', confidence: 0.9, content: 'Another lesson.' }), { proposedBy: agent, now: t0 })
  store.write(exemplar({ id: 'c', retentionDays: 1, content: 'Short lived.' }), { proposedBy: agent, now: t0 })
  const recalled = store.recall({ domain: 'planning', now: t0 + 2 * DAY })
  assert.deepEqual(recalled.map((m) => m.id), ['b', 'a'])
  assert.ok(recalled.every((m) => m.advisory === true && !('approvalId' in m) && !('proposedBy' in m)))
  assert.deepEqual(store.recall({ kind: 'routing-rule', now: t0 }), [])
})

test('the same id with the same text changes nothing; the same id with new text is refused', () => {
  const store = new MemoryStore()
  store.write(exemplar(), { proposedBy: agent, now: t0 })
  assert.equal(store.write(exemplar(), { proposedBy: agent, now: t0 + 1000 }).unchanged, true)
  const changed = store.write(exemplar({ content: 'A different claim under the same id.' }), { proposedBy: agent, now: t0 + 2000 })
  assert.equal(changed.stored, false)
  assert.match(changed.decision.reasons[0]!, /not edited/)
  assert.equal(store.entries().length, 1)
  assert.equal(store.entries()[0]!.content, 'Plans that skip the evidence step were refused.')
})

test('only a person can have an entry forgotten', () => {
  const store = new MemoryStore()
  store.write(exemplar(), { proposedBy: agent, now: t0 })
  assert.equal(store.forget('m1', agent, t0 + 1), false)
  assert.equal(store.entries().length, 1)
  assert.equal(store.forget('m1', person, t0 + 2), true)
  assert.equal(store.entries().length, 0)
  assert.equal(store.events().at(-1)!.event, 'forgotten')
  assert.equal(store.verify().valid, true)
})

test('expired entries are swept and leave a record', () => {
  const store = new MemoryStore()
  store.write(exemplar({ retentionDays: 1 }), { proposedBy: agent, now: t0 })
  assert.deepEqual(store.sweepExpired(t0 + 2 * DAY), ['m1'])
  assert.equal(store.entries().length, 0)
  assert.equal(store.events().at(-1)!.event, 'expired')
  assert.equal(store.verify().valid, true)
})

test('the file store reloads what was written and refuses a file that was edited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-memory-'))
  const path = join(dir, 'tenant-a', 'memory.json')
  const first = new FileMemoryStore(path)
  first.write(exemplar(), { proposedBy: agent, now: t0 })
  assert.deepEqual(readdirSync(join(dir, 'tenant-a')), ['memory.json'])

  const reloaded = new FileMemoryStore(path)
  assert.equal(reloaded.entries().length, 1)
  assert.equal(reloaded.verify().valid, true)

  const doc = JSON.parse(readFileSync(path, 'utf8'))
  doc.entries[0].content = 'Plans that skip the evidence step are fine.'
  writeFileSync(path, JSON.stringify(doc))
  assert.throws(() => new FileMemoryStore(path), /failed verification.*does not match its hash/)
})

test('deleting an entry from the file without a record is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-memory-'))
  const path = join(dir, 'memory.json')
  new FileMemoryStore(path).write(exemplar(), { proposedBy: agent, now: t0 })
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  doc.entries = []
  writeFileSync(path, JSON.stringify(doc))
  assert.throws(() => new FileMemoryStore(path), /removed without a record/)
})

test('removing or reordering an event breaks the chain', () => {
  const store = new MemoryStore()
  store.write(exemplar({ id: 'a' }), { proposedBy: agent, now: t0 })
  store.write(exemplar({ id: 'b', content: 'Second.' }), { proposedBy: agent, now: t0 + 1 })
  const internals = store as unknown as { doc: { events: unknown[] } }
  internals.doc.events.shift()
  assert.equal(store.verify().valid, false)
})
