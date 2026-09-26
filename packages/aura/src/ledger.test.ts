/** Intent ledger tests: the provider operating rules from the Aura charter. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'

import { AccessController, type Principal } from '@quicksilver/kernel/identity'

import {
  activeGoals,
  appendChange,
  emptyLedger,
  intentInForce,
  intentIssues,
  replay,
  resolvePositions,
  verifyLedger,
  weightReversals,
  type IntentChange,
  type IntentLedger,
} from './index.ts'

const T = 'tenant-a'
const ana: Principal = { id: 'user:ana', kind: 'human', tenantId: T, roles: ['intent-provider'] }
const ben: Principal = { id: 'user:ben', kind: 'human', tenantId: T, roles: ['intent-provider'] }
const ops: Principal = { id: 'user:ops', kind: 'human', tenantId: T, roles: ['intent-admin'] }
const bot: Principal = { id: 'agent:nuera-quicksilver:planner', kind: 'agent', tenantId: T, roles: ['agent-worker', 'intent-provider'] }
const at = (d: number) => ({ now: new Date(Date.UTC(2026, 9, d, 12)) })

function must(ledger: IntentLedger, actor: Principal, change: IntentChange, opts = {}): IntentLedger {
  const r = appendChange(ledger, actor, change, opts)
  if (!r.ok) assert.fail(r.reasons.join(' '))
  return r.ledger
}

function coOwned(): IntentLedger {
  let l = must(emptyLedger(), ana, { type: 'company.create', companyId: 'feed-co', tenantId: T, admins: ['user:ops'], providers: [
    { id: 'user:ana', kind: 'person', name: 'Ana', authority: 0.5 },
    { id: 'user:ben', kind: 'person', name: 'Ben', authority: 0.5 },
  ] }, at(1))
  l = must(l, ana, { type: 'goal.set', goal: { id: 'trust', label: 'Most trusted feed store in the valley', horizon: 'enduring', serves: [] } }, at(1))
  l = must(l, ben, { type: 'goal.set', goal: { id: 'q4-margin', label: 'Raise margin 3 points', horizon: 'quarter', serves: ['trust'], expiresAt: '2027-01-01T00:00:00Z' } }, at(2))
  return l
}

test('only providers shape intent; admins set rules only; agents do neither', () => {
  let l = coOwned()
  const adminGoal = appendChange(l, ops, { type: 'goal.set', goal: { id: 'x', label: 'x', horizon: 'year', serves: [] } })
  assert.equal(adminGoal.ok, false)
  if (!adminGoal.ok) assert.match(adminGoal.reasons.join(' '), /Admins set decision rules only/)
  assert.equal(appendChange(l, ops, { type: 'weight.set', goalId: 'trust', weight: 1 }).ok, false)

  l = must(l, ops, { type: 'rule.set', rule: { kind: 'final-say', providerId: 'user:ana' } }, at(3))
  assert.equal(l.entries.at(-1)!.actor.role, 'admin')
  l = must(l, ben, { type: 'rule.set', rule: { kind: 'majority' } }, at(4))
  assert.equal(l.entries.at(-1)!.actor.role, 'provider')

  const agent = appendChange(l, bot, { type: 'weight.set', goalId: 'trust', weight: 0.9 })
  assert.equal(agent.ok, false)
  assert.equal(appendChange(l, { ...ana, id: 'user:stranger' }, { type: 'weight.set', goalId: 'trust', weight: 0.9 }).ok, false)
})

test('an admin recorded as a provider too may shape intent', () => {
  let l = must(emptyLedger(), ana, { type: 'company.create', companyId: 'c', tenantId: T, admins: ['user:ana'], providers: [{ id: 'user:ana', kind: 'person', name: 'Ana', authority: 1 }] })
  l = must(l, ana, { type: 'goal.set', goal: { id: 'g', label: 'g', horizon: 'enduring', serves: [] } })
  assert.equal(replay(l).goals.g!.setBy, 'user:ana')
})

test('identity goes through the kernel access controller when supplied', () => {
  const access = new AccessController()
  const l = coOwned()
  // Ana is a listed provider but her principal lacks the intent-provider role here.
  const noRole = appendChange(l, { ...ana, roles: ['viewer'] }, { type: 'weight.set', goalId: 'trust', weight: 0.8 }, { access })
  assert.equal(noRole.ok, false)
  assert.equal(appendChange(l, ana, { type: 'weight.set', goalId: 'trust', weight: 0.8 }, { access }).ok, true)
  assert.equal(appendChange(l, { ...ana, tenantId: 'tenant-b' }, { type: 'weight.set', goalId: 'trust', weight: 0.8 }, { access }).ok, false, 'tenants are hard boundaries')
  assert.equal(appendChange(l, ops, { type: 'rule.set', rule: { kind: 'majority' } }, { access }).ok, true)
})

test('each provider sets only their own weights and autonomy; every change keeps the old value', () => {
  let l = coOwned()
  l = must(l, ana, { type: 'weight.set', goalId: 'trust', weight: 0.9 }, at(3))
  l = must(l, ben, { type: 'weight.set', goalId: 'trust', weight: 0.4 }, at(3))
  l = must(l, ana, { type: 'weight.set', goalId: 'trust', weight: 0.7 }, { ...at(4), reason: 'Harvest season; margin matters more for now.' })
  l = must(l, ana, { type: 'autonomy.set', goalId: 'q4-margin', depth: 'propose' }, at(4))
  const s = replay(l)
  assert.deepEqual(s.weights, { 'user:ana': { trust: 0.7 }, 'user:ben': { trust: 0.4 } })
  assert.equal(s.autonomy['user:ana']!['q4-margin'], 'propose')
  const change = l.entries.find((e) => e.reason)!
  assert.equal(change.previous, 0.9)
  assert.equal(change.actor.id, 'user:ana')
  assert.equal(appendChange(l, ana, { type: 'weight.set', goalId: 'trust', weight: 1.5 }).ok, false)
})

test('horizons: short-term goals serve longer ones and lapse unless renewed; the law is not a provider goal', () => {
  const l = coOwned()
  assert.equal(appendChange(l, ana, { type: 'goal.set', goal: { id: 'bad', label: 'x', horizon: 'year', serves: ['q4-margin'] } }).ok, false, 'a year goal cannot serve a quarter goal')
  assert.equal(appendChange(l, ana, { type: 'goal.set', goal: { id: 'rule.skip-waes', label: 'x', horizon: 'week', serves: [] } }).ok, false)
  const s = replay(l)
  assert.deepEqual(activeGoals(s, new Date('2026-12-01')).map((g) => g.id).sort(), ['q4-margin', 'trust'])
  assert.deepEqual(activeGoals(s, new Date('2027-02-01')).map((g) => g.id), ['trust'])
  assert.ok(intentIssues(s, new Date('2027-02-01')).some((i) => i.includes('lapsed')))
  assert.ok(intentIssues(s).some((i) => i.includes('No decision rule')))
})

test('the ledger is tamper-evident, and signatures prove who kept it', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  let l = must(emptyLedger(), ana, { type: 'company.create', companyId: 'c', tenantId: T, providers: [{ id: 'user:ana', kind: 'person', name: 'Ana', authority: 1 }] }, { signingKey: privateKey })
  l = must(l, ana, { type: 'goal.set', goal: { id: 'g', label: 'Serve small farms', horizon: 'enduring', serves: [] } }, { signingKey: privateKey })
  l = must(l, ana, { type: 'weight.set', goalId: 'g', weight: 0.9 }, { signingKey: privateKey })
  assert.equal(verifyLedger(l, publicKey).valid, true)

  const edited = structuredClone(l)
  ;(edited.entries[2]!.change as { weight: number }).weight = 0.1
  assert.deepEqual(verifyLedger(edited), { valid: false, brokenAt: 3, reason: 'Entry content does not match its hash; it was altered.' })

  const removed = { entries: [l.entries[0]!, l.entries[2]!] }
  assert.equal(verifyLedger(removed).valid, false)

  const resigned = structuredClone(l)
  resigned.entries[1]!.signature = resigned.entries[0]!.signature
  assert.equal(verifyLedger(resigned, publicKey).valid, false)
})

test('decisions keep the weights and rule in force when they were made', () => {
  let l = coOwned()
  l = must(l, ops, { type: 'rule.set', rule: { kind: 'majority' } }, at(3))
  l = must(l, ana, { type: 'weight.set', goalId: 'trust', weight: 0.9 }, at(3))
  const decisionRef = intentInForce(l, new Date(Date.UTC(2026, 9, 3, 18)))
  l = must(l, ana, { type: 'weight.set', goalId: 'trust', weight: 0.2 }, at(5))
  l = must(l, ops, { type: 'rule.set', rule: { kind: 'final-say', providerId: 'user:ben' } }, at(5))
  assert.deepEqual(decisionRef.rule, { kind: 'majority' })
  assert.equal(decisionRef.weights['user:ana']!.trust, 0.9)
  const then = replay(l, { seq: decisionRef.ledgerSeq })
  assert.equal(then.weights['user:ana']!.trust, 0.9, 'later changes never rewrite the past')
  assert.equal(l.entries[decisionRef.ledgerSeq - 1]!.hash, decisionRef.ledgerHead)
})

test('decision rules: unanimous, majority by authority, veto, final say, and escalation without a rule', () => {
  const s = replay(coOwned())
  assert.equal(resolvePositions(s, { 'user:ana': 'a', 'user:ben': 'a' }).outcome, 'decided')
  assert.equal(resolvePositions(s, { 'user:ana': 'a', 'user:ben': 'b' }).outcome, 'escalate', 'no rule: disagreement goes to all providers')

  const three = { ...s, providers: [
    { id: 'p1', kind: 'person' as const, name: 'P1', authority: 0.5 },
    { id: 'p2', kind: 'organization' as const, name: 'P2', authority: 0.3 },
    { id: 'p3', kind: 'group' as const, name: 'P3', authority: 0.2 },
  ] }
  const majority = resolvePositions({ ...three, rule: { kind: 'majority' } }, { p1: 'a', p2: 'a', p3: 'b' })
  assert.equal(majority.outcome === 'decided' && majority.choice, 'a')
  assert.equal(resolvePositions({ ...three, rule: { kind: 'majority' } }, { p1: 'a', p2: 'b', p3: 'c' }).outcome, 'escalate', '50% is not a majority')
  assert.equal(resolvePositions({ ...three, rule: { kind: 'veto', vetoBy: ['p3'] } }, { p1: 'a', p2: 'a', p3: 'b' }).outcome, 'escalate')
  assert.equal(resolvePositions({ ...three, rule: { kind: 'veto', vetoBy: ['p3'] } }, { p1: 'a', p2: 'a' }).outcome, 'escalate', 'a silent veto holder is asked')
  const fs = resolvePositions({ ...three, rule: { kind: 'final-say', providerId: 'p3' } }, { p1: 'a', p2: 'a', p3: 'b' })
  assert.equal(fs.outcome === 'decided' && fs.choice, 'b')
})

test('changing who the providers are is not one co-owner\'s call', () => {
  let l = coOwned()
  const solo = appendChange(l, ben, { type: 'providers.set', providers: [{ id: 'user:ben', kind: 'person', name: 'Ben', authority: 1 }] })
  assert.equal(solo.ok, false)
  l = must(l, ops, { type: 'rule.set', rule: { kind: 'final-say', providerId: 'user:ana' } })
  assert.equal(appendChange(l, ana, { type: 'providers.set', providers: [
    { id: 'user:ana', kind: 'person', name: 'Ana', authority: 0.6 },
    { id: 'user:ben', kind: 'person', name: 'Ben', authority: 0.4 },
  ] }).ok, true)
  assert.equal(appendChange(l, ana, { type: 'providers.set', providers: [{ id: 'user:ana', kind: 'person', name: 'Ana', authority: 0.6 }] }).ok, false, 'shares must sum to 1')
})

test('customer commitments are provider intent, recorded for later say-do checks', () => {
  let l = coOwned()
  assert.equal(appendChange(l, ops, { type: 'commitment.set', commitment: { id: 'fees', text: 'No hidden fees', audience: 'customers' } }).ok, false)
  l = must(l, ana, { type: 'commitment.set', commitment: { id: 'fees', text: 'No hidden fees', audience: 'customers' } })
  assert.equal(replay(l).commitments.fees!.setBy, 'user:ana')
})

test('back-and-forth weight changes are reported, never blocked', () => {
  let l = coOwned()
  for (const [d, w] of [[3, 0.9], [4, 0.3], [5, 0.9], [6, 0.3]] as const) l = must(l, ana, { type: 'weight.set', goalId: 'trust', weight: w }, at(d))
  const r = weightReversals(l, { now: new Date(Date.UTC(2026, 9, 10)) })
  assert.equal(r.length, 1)
  assert.deepEqual(r[0]!.values, [0.9, 0.3, 0.9, 0.3])
})

test('decision principles are stated intent: providers set and retire their own; admins and agents cannot', () => {
  let l = coOwned()
  const principle = { id: 'p.conflict', text: 'When two goals conflict, take the smaller or test version first.', appliesTo: ['conflict'], examples: ['s1-07'] }
  const byAdmin = appendChange(l, ops, { type: 'principle.set', principle })
  assert.equal(byAdmin.ok, false)
  if (!byAdmin.ok) assert.match(byAdmin.reasons.join(' '), /Admins set decision rules only/)
  assert.equal(appendChange(l, bot, { type: 'principle.set', principle }).ok, false)
  assert.equal(appendChange(l, ana, { type: 'principle.set', principle: { ...principle, text: '' } }).ok, false)
  assert.equal(appendChange(l, ana, { type: 'principle.set', principle: { ...principle, text: 'x'.repeat(501) } }).ok, false)

  l = must(l, ana, { type: 'principle.set', principle }, at(5))
  const set = l.entries.at(-1)!
  assert.equal(set.actor.role, 'provider')
  assert.equal(set.previous, undefined)
  let s = replay(l)
  assert.deepEqual(s.principles['p.conflict'], { ...principle, setBy: 'user:ana', setAt: set.at, provenance: 'HUMAN_SPECIFIED' })

  // Another provider cannot rewrite or retire Ana's principle.
  assert.equal(appendChange(l, ben, { type: 'principle.set', principle: { ...principle, text: 'Go big.' } }).ok, false)
  assert.equal(appendChange(l, ben, { type: 'principle.retire', principleId: 'p.conflict' }).ok, false)
  assert.equal(appendChange(l, ops, { type: 'principle.retire', principleId: 'p.conflict' }).ok, false)

  // A reworded principle is a tracked change with the old wording kept.
  l = must(l, ana, { type: 'principle.set', principle: { ...principle, text: 'When goals conflict, try the small version first.' } }, at(6))
  assert.equal((l.entries.at(-1)!.previous as { text: string }).text, principle.text)
  assert.equal(replay(l).principles['p.conflict']!.text, 'When goals conflict, try the small version first.')

  l = must(l, ana, { type: 'principle.retire', principleId: 'p.conflict', reason: 'Folded into another principle' }, at(7))
  s = replay(l)
  assert.deepEqual(s.principles, {})
  assert.equal(appendChange(l, ana, { type: 'principle.retire', principleId: 'p.conflict' }).ok, false, 'cannot retire twice')
  // History keeps it: replay as of before the retirement.
  assert.equal(replay(l, { seq: l.entries.length - 1 }).principles['p.conflict']!.setBy, 'user:ana')
  assert.deepEqual(verifyLedger(l), { valid: true, entries: l.entries.length, head: l.entries.at(-1)!.hash })

  const tampered = structuredClone(l)
  ;(tampered.entries.at(-2)!.change as { principle: { text: string } }).principle.text = 'Always go big.'
  assert.equal(verifyLedger(tampered).valid, false)
})

test('principle changes pass the kernel access check like other intent', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const access = new AccessController()
  let l = coOwned()
  const r = appendChange(l, ana, { type: 'principle.set', principle: { id: 'ask', text: "Don't ask me unless someone else's authority or data is involved." } }, { access, signingKey: privateKey })
  assert.ok(r.ok)
  if (r.ok) { l = r.ledger; assert.deepEqual(r.state.principles.ask!.appliesTo, []) }
  const last = l.entries.at(-1)!
  assert.ok(last.signature && verify(null, Buffer.from(last.hash), publicKey, Buffer.from(last.signature, 'base64')))
  assert.equal(verifyLedger(l).valid, true)
  assert.equal(appendChange(l, { ...ana, roles: ['viewer'] }, { type: 'principle.set', principle: { id: 'x', text: 'y' } }, { access }).ok, false, 'needs intent:provide')
  const outsider: Principal = { id: 'user:ana', kind: 'human', tenantId: 'tenant-b', roles: ['intent-provider'] }
  assert.equal(appendChange(l, outsider, { type: 'principle.set', principle: { id: 'x', text: 'y' } }, { access }).ok, false)
})
