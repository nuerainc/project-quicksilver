/** Durable shadow (M4) and Genesis (M5) stores, against an in-memory Sanity fake. Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newVerdictLearner } from '@quicksilver/aura'
import { appendMoney, draftExperiment, experimentDigest, recordMeasurement, startExperiment, type Experiment, type ExperimentDefinition, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import { judge, recommend, recordOutcome, type ShadowLog } from '@quicksilver/kernel/playbooks/shadow'

import {
  ExperimentConflictError,
  ExperimentRecordError,
  FileExperimentStore,
  FileMoneyLedgerStore,
  genesisStoresFromEnv,
  MoneyLedgerConflictError,
  MoneyLedgerIntegrityError,
  SanityExperimentStore,
  SanityMoneyLedgerStore,
  type ExperimentStore,
  type MoneyLedgerStore,
} from './genesis-store.ts'
import { LegacySanityProjectError, sanityConfigFromEnv, type SanityDoc, type SanityMutation, type SanityStoreClient } from './sanity-client.ts'
import { ShadowRecordConflictError } from './shadow-api.ts'
import { SanityShadowStore } from './shadow-store-sanity.ts'

// ── In-memory Sanity ──────────────────────────────────────────────────────

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 })

/**
 * Enough of the Content Lake for the stores: documents with revisions,
 * fetch filtered by $type and the other params (field equality), and
 * all-or-nothing transactions with create / createIfNotExists / patch+ifRevisionID.
 */
class FakeSanity implements SanityStoreClient {
  readonly projectId: string
  docs = new Map<string, SanityDoc>()
  private revs = 0
  /** Runs just before a transaction commits (to simulate another writer). */
  beforeMutate?: () => void
  constructor(projectId = 'nuera-test') { this.projectId = projectId }
  private rev() { return `r${++this.revs}` }
  async fetch<T>(_query: string, params: Record<string, unknown>): Promise<T> {
    const { type, ...fields } = params
    return [...this.docs.values()]
      .filter((d) => d._type === type && Object.entries(fields).every(([k, v]) => d[k] === v))
      .map((d) => structuredClone(d)) as T
  }
  async getDocument<T extends { _id: string; _type: string }>(id: string): Promise<T | undefined> {
    const d = this.docs.get(id)
    return d ? (structuredClone(d) as unknown as T) : undefined
  }
  async createIfNotExists<T extends { _id: string; _type: string }>(doc: T): Promise<T> {
    if (!this.docs.has(doc._id)) this.docs.set(doc._id, { ...structuredClone(doc), _rev: this.rev() } as unknown as SanityDoc)
    return structuredClone(this.docs.get(doc._id)) as unknown as T
  }
  async mutate(mutations: SanityMutation[]): Promise<void> {
    this.beforeMutate?.()
    const next = new Map(this.docs)
    for (const m of mutations) {
      if ('create' in m) {
        if (next.has(m.create._id)) throw conflict(`Document ${m.create._id} already exists`)
        next.set(m.create._id, { ...structuredClone(m.create), _rev: this.rev() })
      } else if ('createIfNotExists' in m) {
        if (!next.has(m.createIfNotExists._id)) next.set(m.createIfNotExists._id, { ...structuredClone(m.createIfNotExists), _rev: this.rev() })
      } else {
        const cur = next.get(m.patch.id)
        if (!cur) throw Object.assign(new Error('not found'), { statusCode: 404 })
        if (m.patch.ifRevisionID !== undefined && m.patch.ifRevisionID !== cur._rev) throw conflict('Revision mismatch')
        next.set(m.patch.id, { ...cur, ...structuredClone(m.patch.set ?? {}), _rev: this.rev() })
      }
    }
    this.docs = next
  }
}

// ── Shadow records ────────────────────────────────────────────────────────

const human = { id: 'entity-founder', kind: 'human' as const }
const T0 = new Date('2026-11-01T12:00:00Z')

function shadowLog(): ShadowLog {
  let log: ShadowLog = { recommendations: [] }
  for (const [id, dept] of [['rec-1', 'finance'], ['rec-2', 'sales']] as const) {
    const r = recommend(log, { id, department: dept, description: `Do the ${dept} thing.`, proposedAt: T0.toISOString(), kernel: { recommendation: 'request-approval', riskLevel: 2 }, source: 'agent', features: { risk: 0.4 }, prediction: { accept: 0.6, observations: 0, model: 'verdict-logistic' } })
    assert.ok(r.ok)
    log = r.log
  }
  return log
}

test('shadow records round-trip through Sanity: one document per recommendation, one learner per intent', async () => {
  const sanity = new FakeSanity()
  const store = new SanityShadowStore(sanity)
  const judged = judge(shadowLog(), 'rec-1', human, 'accepted', T0, 'fine')
  assert.ok(judged.ok)
  const learner = { ...newVerdictLearner(), observations: 1 }
  await store.save('intent-demo', judged.log, learner)

  assert.deepEqual(await store.load('intent-demo'), { log: judged.log, learner })
  assert.deepEqual([...sanity.docs.keys()].sort(), ['aura-verdict-learner.intent-demo', 'shadow-recommendation.intent-demo.rec-1', 'shadow-recommendation.intent-demo.rec-2'])
  assert.equal(sanity.docs.get('aura-verdict-learner.intent-demo')!.provenance, 'AGENT_INFERRED')
  assert.deepEqual(await store.load('intent-other'), { log: { recommendations: [] }, learner: null })

  // Outcome is added once, later.
  const out = recordOutcome(judged.log, 'rec-1', human, 'good', T0)
  assert.ok(out.ok)
  await store.save('intent-demo', out.log, learner)
  assert.equal((await store.load('intent-demo')).log.recommendations[0]!.outcome?.value, 'good')
})

test('a verdict (or outcome) once stored is never rewritten or removed', async () => {
  const store = new SanityShadowStore(new FakeSanity())
  const base = shadowLog()
  await store.save('intent-demo', base, null)
  // Two writers load the same log; the first judges "accepted".
  const a = judge(base, 'rec-1', human, 'accepted', T0)
  const b = judge(base, 'rec-1', { id: 'entity-other', kind: 'human' }, 'rejected', T0)
  assert.ok(a.ok && b.ok)
  await store.save('intent-demo', a.log, null)
  await assert.rejects(store.save('intent-demo', b.log, null), ShadowRecordConflictError)
  await assert.rejects(store.save('intent-demo', base, null), /not rewritten/, 'dropping the verdict is refused too')
  assert.equal((await store.load('intent-demo')).log.recommendations[0]!.verdict?.value, 'accepted')
})

test('recommendations are append-only, and a racing writer loses on the revision check', async () => {
  const sanity = new FakeSanity()
  const store = new SanityShadowStore(sanity)
  const base = shadowLog()
  await store.save('intent-demo', base, null)
  const edited = { recommendations: base.recommendations.map((r) => (r.id === 'rec-2' ? { ...r, description: 'Something else.' } : r)) }
  await assert.rejects(store.save('intent-demo', edited, null), /append-only/)
  await assert.rejects(store.save('intent-demo', { recommendations: base.recommendations.slice(0, 1) }, null), /missing from this save/)

  const judged = judge(base, 'rec-2', human, 'modified', T0)
  assert.ok(judged.ok)
  sanity.beforeMutate = () => {
    sanity.beforeMutate = undefined
    const doc = sanity.docs.get('shadow-recommendation.intent-demo.rec-2')!
    sanity.docs.set(doc._id, { ...doc, verdict: { value: 'rejected', by: 'entity-other', at: T0.toISOString() }, _rev: 'someone-else' })
  }
  await assert.rejects(store.save('intent-demo', judged.log, null), ShadowRecordConflictError)
  assert.equal((await store.load('intent-demo')).log.recommendations[1]!.verdict?.value, 'rejected', 'the first writer\'s verdict stands')
})

// ── Money ledger ──────────────────────────────────────────────────────────

const RUN = 'genesis-500'

function entries(n: number, tweak?: (i: number) => Partial<Parameters<typeof appendMoney>[1]>) {
  let ledger: MoneyLedger = { runId: RUN, budgetUsd: 500, entries: [] }
  for (let i = 0; i < n; i++) {
    const r = appendMoney(ledger, { kind: i === 2 ? 'compute' : 'spend', amountUsd: 10 + i, category: i === 2 ? 'compute' : 'domains', description: `entry ${i + 1}`, source: { type: 'receipt', ref: `r-${i + 1}` }, ...(i === 1 ? { experimentId: 'exp-landing-1' } : {}), ...tweak?.(i) }, human, new Date(T0.getTime() + i * 1000))
    assert.ok(r.ok)
    ledger = r.ledger
  }
  return ledger.entries
}

async function ledgerStores(): Promise<Array<[string, MoneyLedgerStore, FakeSanity | string]>> {
  const dir = await mkdtemp(join(tmpdir(), 'genesis-ledger-'))
  const sanity = new FakeSanity()
  return [['file', new FileMoneyLedgerStore(dir, { budgetUsd: 500 }), dir], ['sanity', new SanityMoneyLedgerStore(sanity), sanity]]
}

test('money ledger: append and load round-trip with the chain verified (file and Sanity)', async () => {
  const list = entries(3)
  for (const [kind, store, backing] of await ledgerStores()) {
    for (const e of list) await store.append(RUN, e)
    await store.append(RUN, list[2]!) // a retry of the same entry is a no-op
    assert.deepEqual(await store.load(RUN), list, kind)
    assert.deepEqual(await store.load('another-run'), [], kind)
    if (backing instanceof FakeSanity) assert.deepEqual([...backing.docs.keys()].sort(), ['money-entry.genesis-500.00000001', 'money-entry.genesis-500.00000002', 'money-entry.genesis-500.00000003'])
    else assert.deepEqual(Object.keys(JSON.parse(await readFile(join(backing, RUN, 'ledger.json'), 'utf8'))).sort(), ['budgetUsd', 'entries', 'runId'], 'the file layout genesis-cli always used')
  }
})

test('money ledger: a seq that is already taken is a conflict, never an overwrite', async () => {
  const mine = entries(2)
  const theirs = entries(2, (i) => (i === 1 ? { amountUsd: 99 } : {}))
  for (const [kind, store] of await ledgerStores()) {
    for (const e of mine) await store.append(RUN, e)
    await assert.rejects(store.append(RUN, theirs[1]!), (e: unknown) => e instanceof MoneyLedgerConflictError && e.seq === 2, kind)
    const gap = entries(4)[3]!
    await assert.rejects(store.append(RUN, gap), MoneyLedgerConflictError, `${kind}: a gap is refused`)
    assert.deepEqual(await store.load(RUN), mine, kind)
  }
})

test('money ledger: an entry edited behind the store\'s back fails verification on load', async () => {
  for (const [kind, store, backing] of await ledgerStores()) {
    for (const e of entries(3)) await store.append(RUN, e)
    if (backing instanceof FakeSanity) {
      const doc = backing.docs.get('money-entry.genesis-500.00000002')!
      backing.docs.set(doc._id, { ...doc, amountUsd: 1 })
    } else {
      const path = join(backing, RUN, 'ledger.json')
      await writeFile(path, (await readFile(path, 'utf8')).replace('"amountUsd": 11', '"amountUsd": 1'))
    }
    await assert.rejects(store.load(RUN), (e: unknown) => e instanceof MoneyLedgerIntegrityError && /Entry 2 was altered/.test(e.message), kind)
  }
})

// ── Experiments ───────────────────────────────────────────────────────────

const def: ExperimentDefinition = {
  id: 'exp-landing-1',
  hypothesis: 'A one-page offer gets 3+ paid signups in 10 days.',
  playbookId: 'genesis',
  metric: { id: 'paid-signups', label: 'Paid signups', direction: 'higher-is-better', kill: 0, hold: 2, scale: 3 },
  budgetUsd: 60,
  durationDays: 10,
  customerFacing: true,
  proposedBy: 'entity-founder',
}

function drafted(d: ExperimentDefinition = def): Experiment {
  const r = draftExperiment(d)
  assert.ok(r.ok)
  return r.experiment
}

async function experimentStores(): Promise<Array<[string, ExperimentStore]>> {
  return [['file', new FileExperimentStore(await mkdtemp(join(tmpdir(), 'genesis-exp-')))], ['sanity', new SanityExperimentStore(new FakeSanity())]]
}

test('experiments: the definition may change in draft, and is fixed once started', async () => {
  for (const [kind, store] of await experimentStores()) {
    await store.put(RUN, drafted())
    await store.put(RUN, drafted({ ...def, budgetUsd: 50 })) // still a draft: redrafting is fine
    await store.put(RUN, drafted({ ...def, id: 'exp-second' }))
    const started = startExperiment(drafted({ ...def, budgetUsd: 50 }), human, T0, { remainingBudgetUsd: 500 })
    assert.ok(started.ok)
    await store.put(RUN, started.experiment)
    const measured = recordMeasurement(started.experiment, 1, human, 'stripe', T0)
    assert.ok(measured.ok)
    await store.put(RUN, measured.experiment)
    assert.deepEqual((await store.list(RUN)).map((e) => [e.definition.id, e.status]), [['exp-landing-1', 'running'], ['exp-second', 'draft']], kind)
    assert.deepEqual((await store.list(RUN))[0], measured.experiment, kind)

    const bigger = { ...def, budgetUsd: 400 }
    await assert.rejects(store.put(RUN, { ...measured.experiment, definition: bigger, digest: experimentDigest(bigger) }), (e: unknown) => e instanceof ExperimentRecordError && /fixed since it left draft/.test(e.message), kind)
    await assert.rejects(store.put(RUN, { ...measured.experiment, definition: bigger }), /digest does not match/, kind)
    await assert.rejects(store.put(RUN, { ...measured.experiment, status: 'draft' }), /back to draft/, kind)
    await assert.rejects(store.put(RUN, { ...measured.experiment, measurements: [] }), /only added/, kind)
    assert.equal((await store.list(RUN))[0]!.definition.budgetUsd, 50, kind)
  }
})

test('experiments: a stale write loses to the revision check in Sanity', async () => {
  const sanity = new FakeSanity()
  const store = new SanityExperimentStore(sanity)
  const exp = drafted()
  await store.put(RUN, exp)
  const started = startExperiment(exp, human, T0, { remainingBudgetUsd: 500 })
  assert.ok(started.ok)
  sanity.beforeMutate = () => {
    sanity.beforeMutate = undefined
    const doc = sanity.docs.get('experiment-record.genesis-500.exp-landing-1')!
    sanity.docs.set(doc._id, { ...doc, _rev: 'someone-else' })
  }
  await assert.rejects(store.put(RUN, started.experiment), ExperimentConflictError)
})

// ── Configuration and the legacy project ──────────────────────────────────

test('the legacy challenge project is refused by every Sanity store and by the env config', async () => {
  const legacy = new FakeSanity('d280bqjc')
  assert.throws(() => new SanityShadowStore(legacy), LegacySanityProjectError)
  assert.throws(() => new SanityMoneyLedgerStore(legacy), LegacySanityProjectError)
  assert.throws(() => new SanityExperimentStore(legacy), LegacySanityProjectError)
  assert.throws(() => sanityConfigFromEnv({ NEXT_PUBLIC_SANITY_PROJECT_ID: 'd280bqjc', SANITY_AUTH_TOKEN: 'test-token' }), LegacySanityProjectError)
  await assert.rejects(genesisStoresFromEnv({ dir: tmpdir(), budgetUsd: 500, env: { QUICKSILVER_GENESIS_STORE: 'sanity', NEXT_PUBLIC_SANITY_PROJECT_ID: 'd280bqjc', SANITY_AUTH_TOKEN: 'test-token' } }), LegacySanityProjectError)
})

test('Genesis stores: files by default, Sanity when asked (and only when configured)', async () => {
  assert.equal((await genesisStoresFromEnv({ dir: tmpdir(), budgetUsd: 500, env: {} })).kind, 'file')
  await assert.rejects(genesisStoresFromEnv({ dir: tmpdir(), budgetUsd: 500, env: { QUICKSILVER_GENESIS_STORE: 'sanity' } }), /needs NEXT_PUBLIC_SANITY_PROJECT_ID/)
  assert.equal((await genesisStoresFromEnv({ dir: tmpdir(), budgetUsd: 500, env: { QUICKSILVER_GENESIS_STORE: 'sanity' }, client: new FakeSanity() })).kind, 'sanity')
})
