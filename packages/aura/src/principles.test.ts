/** Importing the provider's confirmed decision principles into the intent ledger. Synthetic data only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Principal } from '@quicksilver/kernel/identity'

import {
  acceptedPrinciples,
  importPrinciples,
  loadLedger,
  MemoryLedgerStore,
  parsePrincipleExport,
  principleTexts,
  recordChange,
  replay,
  verifyLedger,
} from './index.ts'

const T = 'tenant-a'
const founder: Principal = { id: 'user:founder', kind: 'human', tenantId: T, roles: ['intent-provider'] }
const admin: Principal = { id: 'user:ops', kind: 'human', tenantId: T, roles: ['intent-admin'] }

async function company() {
  const store = new MemoryLedgerStore()
  const r = await recordChange(store, 'co', founder, { type: 'company.create', companyId: 'co', tenantId: T, admins: ['user:ops'], providers: [{ id: 'user:founder', kind: 'person', name: 'Founder', authority: 1 }] })
  assert.ok(r.ok)
  return store
}

const exported = {
  principles: [
    { id: 'conflict-small-first', text: 'When two goals conflict, take the smaller or test version first.', status: 'confirmed', appliesTo: ['conflict'], examples: ['s1-03'] },
    { id: 'ask-only-others', text: "Don't ask me unless someone else's authority or data is involved.", status: 'edited', appliesTo: ['ask'] },
    { id: 'always-cheapest', text: 'Always pick the cheapest option.', status: 'rejected' },
  ],
}

test('the export is checked: bad entries are listed, not recorded', () => {
  assert.throws(() => parsePrincipleExport({ nope: [] }), /Not a principles export/)
  const p = parsePrincipleExport({ principles: [...exported.principles, { id: 'x', text: '', status: 'confirmed' }, { id: 'y', text: 'ok', status: 'maybe' }, { id: 'conflict-small-first', text: 'dup', status: 'confirmed' }] })
  assert.equal(p.principles.length, 3)
  assert.deepEqual(p.invalid.map((i) => i.id), ['x', 'y', 'conflict-small-first'])
  assert.deepEqual(acceptedPrinciples(p).map((x) => x.id), ['conflict-small-first', 'ask-only-others'])
})

test('confirmed and edited principles are recorded as the provider\'s; rejected are skipped; re-import is a no-op', async () => {
  const store = await company()
  const first = await importPrinciples(store, 'co', founder, parsePrincipleExport(exported), { now: new Date('2026-09-27T10:00:00Z') })
  assert.deepEqual(first.recorded.map((r) => [r.id, r.changed]), [['conflict-small-first', false], ['ask-only-others', false]])
  assert.deepEqual(first.skipped, ['always-cheapest'])
  assert.deepEqual(first.refused, [])

  let ledger = await loadLedger(store, 'co')
  let state = replay(ledger)
  assert.deepEqual(Object.keys(state.principles).sort(), ['ask-only-others', 'conflict-small-first'])
  assert.equal(state.principles['ask-only-others']!.provenance, 'HUMAN_SPECIFIED')
  assert.equal(state.principles['ask-only-others']!.setBy, 'user:founder')
  assert.deepEqual(state.principles['conflict-small-first']!.examples, ['s1-03'])
  assert.ok(!('always-cheapest' in state.principles))
  // Same time: ordered by id.
  assert.deepEqual(principleTexts(state), [exported.principles[1]!.text, exported.principles[0]!.text])

  const again = await importPrinciples(store, 'co', founder, parsePrincipleExport(exported))
  assert.deepEqual(again.recorded, [])
  assert.deepEqual(again.unchanged, ['conflict-small-first', 'ask-only-others'])
  assert.equal((await loadLedger(store, 'co')).entries.length, 3, 'nothing new was written')

  // Changed wording is recorded again, as a tracked change keeping the old text.
  const edited = structuredClone(exported)
  edited.principles[0]!.text = 'When goals conflict, try the small version first.'
  const third = await importPrinciples(store, 'co', founder, parsePrincipleExport(edited))
  assert.deepEqual(third.recorded.map((r) => [r.id, r.changed]), [['conflict-small-first', true]])
  ledger = await loadLedger(store, 'co')
  state = replay(ledger)
  assert.equal(state.principles['conflict-small-first']!.text, 'When goals conflict, try the small version first.')
  assert.equal((ledger.entries.at(-1)!.previous as { text: string }).text, exported.principles[0]!.text)
  assert.equal(verifyLedger(ledger).valid, true)
})

test('an admin cannot import principles', async () => {
  const store = await company()
  const r = await importPrinciples(store, 'co', admin, parsePrincipleExport(exported))
  assert.deepEqual(r.recorded, [])
  assert.equal(r.refused.length, 2)
  assert.match(r.refused[0]!.reasons.join(' '), /Admins set decision rules only/)
})

test('principle texts for a prompt: empty without a ledger, active ones after import', async () => {
  const { loadPrincipleTexts } = await import('./index.ts')
  const store = new MemoryLedgerStore()
  assert.deepEqual(await loadPrincipleTexts(store, 'nobody'), [])
  const withCompany = await company()
  await importPrinciples(withCompany, 'co', founder, parsePrincipleExport(exported))
  assert.equal((await loadPrincipleTexts(withCompany, 'co')).length, 2)
})
