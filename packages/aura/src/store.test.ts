/** Intent ledger and graph persistence tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Principal } from '@quicksilver/kernel/identity'

import {
  createIntent,
  FileLedgerStore,
  fromSanityIntentGraph,
  LedgerConflictError,
  LedgerIntegrityError,
  loadLedger,
  MemoryLedgerStore,
  recordChange,
  replay,
  SanityLedgerStore,
  toSanityIntentGraph,
  type LedgerStore,
  type SanityLikeClient,
} from './index.ts'

const T = 'tenant-a'
const ana: Principal = { id: 'user:ana', kind: 'human', tenantId: T, roles: ['intent-provider'] }
const ops: Principal = { id: 'user:ops', kind: 'human', tenantId: T, roles: ['intent-admin'] }

async function seed(store: LedgerStore): Promise<void> {
  const steps = [
    await recordChange(store, 'feed-co', ana, { type: 'company.create', companyId: 'feed-co', tenantId: T, admins: ['user:ops'], providers: [{ id: 'user:ana', kind: 'person', name: 'Ana', authority: 1 }] }),
    await recordChange(store, 'feed-co', ana, { type: 'goal.set', goal: { id: 'trust', label: 'Most trusted feed store', horizon: 'enduring', serves: [] } }),
    await recordChange(store, 'feed-co', ana, { type: 'weight.set', goalId: 'trust', weight: 0.8 }, { reason: 'First profile' }),
  ]
  for (const s of steps) assert.equal(s.ok, true, s.ok ? '' : s.reasons.join(' '))
}

class FakeSanity implements SanityLikeClient {
  docs = new Map<string, Record<string, unknown> & { _id: string; _type: string }>()
  async fetch<T>(_q: string, params: Record<string, unknown>): Promise<T> {
    return [...this.docs.values()].filter((d) => d._type === 'intentLedgerEntry' && d.companyId === params.companyId).sort((a, b) => (a.seq as number) - (b.seq as number)) as T
  }
  async createIfNotExists<T extends { _id: string; _type: string }>(doc: T): Promise<T> {
    if (!this.docs.has(doc._id)) this.docs.set(doc._id, structuredClone(doc) as never)
    return structuredClone(this.docs.get(doc._id)) as unknown as T
  }
}

test('memory, file and Sanity stores round-trip the ledger and keep the chain valid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aura-ledger-'))
  for (const store of [new MemoryLedgerStore(), new FileLedgerStore(dir), new SanityLedgerStore(new FakeSanity())]) {
    await seed(store)
    const ledger = await loadLedger(store, 'feed-co')
    assert.equal(ledger.entries.length, 3)
    assert.equal(replay(ledger).weights['user:ana']!.trust, 0.8)
    assert.equal(ledger.entries[2]!.reason, 'First profile')
  }
})

test('rules still apply when recording: an admin cannot write intent', async () => {
  const store = new MemoryLedgerStore()
  await seed(store)
  const r = await recordChange(store, 'feed-co', ops, { type: 'weight.set', goalId: 'trust', weight: 0.1 })
  assert.equal(r.ok, false)
  assert.equal((await store.load('feed-co')).length, 3, 'nothing was stored')
})

test('a ledger file edited behind Aura\'s back is refused on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aura-ledger-'))
  const store = new FileLedgerStore(dir)
  await seed(store)
  const path = join(dir, 'feed-co.intent-ledger.jsonl')
  await writeFile(path, (await readFile(path, 'utf8')).replace('"weight":0.8', '"weight":0.1'))
  await assert.rejects(loadLedger(store, 'feed-co'), (e: unknown) => e instanceof LedgerIntegrityError && e.brokenAt === 3)
})

test('two writers racing for the same entry: the second is refused, never overwrites', async () => {
  const sanity = new FakeSanity()
  const store = new SanityLedgerStore(sanity)
  await seed(store)
  const ledger = await loadLedger(store, 'feed-co')
  const { appendChange } = await import('./index.ts')
  const first = appendChange(ledger, ana, { type: 'weight.set', goalId: 'trust', weight: 0.9 })
  const second = appendChange(ledger, ana, { type: 'weight.set', goalId: 'trust', weight: 0.2 })
  assert.ok(first.ok && second.ok)
  await store.append('feed-co', first.entry)
  await assert.rejects(store.append('feed-co', second.entry), LedgerConflictError)
  assert.equal(replay(await loadLedger(store, 'feed-co')).weights['user:ana']!.trust, 0.9)
})

test('Sanity ids keep intent out of public reads and reject unsafe company ids', async () => {
  const sanity = new FakeSanity()
  await seed(new SanityLedgerStore(sanity))
  assert.ok([...sanity.docs.keys()].every((id) => /^intent-ledger\.feed-co\.\d{8}$/.test(id)))
  await assert.rejects(new SanityLedgerStore(sanity).load('bad"] | *'))
})

test('intent graphs round-trip through their Sanity document shape', async () => {
  const { graph } = await createIntent('I have $500 and want to start a small online business in 30 days, no paid ads.', { requestedBy: 'user:ana', now: new Date('2026-09-26T12:00:00Z'), id: 'intent-demo' })
  const doc = toSanityIntentGraph(graph)
  assert.equal(doc._id, 'intent-graph.intent-demo')
  assert.deepEqual(fromSanityIntentGraph(JSON.parse(JSON.stringify(doc))), graph)
})
