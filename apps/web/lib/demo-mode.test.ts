/**
 * Public demo mode (Sanity Challenge edition): runs only against a public
 * synthetic dataset with no real credential, and then shows separation of
 * duties working (Marcus proposes, Sarah approves). Run by the root `seed:test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEMO_FORBIDDEN_VARIABLES, DEMO_PRINCIPALS, demoModeProblems, demoPrincipalForToken } from './demo-mode.ts'
import { checkRouteCaller, checkSupervisorCredential, checkWhoami, type CredentialEnv } from './nqc-approval.ts'

const SAFE: CredentialEnv = {
  NEXT_PUBLIC_QUICKSILVER_DEMO_MODE: 'on',
  NEXT_PUBLIC_SANITY_DATASET: 'challenge',
  SANITY_DATASET_PUBLIC: 'on',
}
const marcus = DEMO_PRINCIPALS.find((p) => p.id === 'entity-marcus-webb')!
const sarah = DEMO_PRINCIPALS.find((p) => p.id === 'entity-sarah-chen')!
const bearer = (t: string) => `Bearer ${t}`

test('demo mode is off unless switched on, and then needs a public synthetic dataset', () => {
  assert.deepEqual(demoModeProblems({}), [])
  assert.deepEqual(demoModeProblems({ NQC_SUPERVISOR_TOKEN: 'x'.repeat(40) }), [], 'off: nothing to check')
  assert.deepEqual(demoModeProblems(SAFE), [])
  assert.deepEqual(demoModeProblems({ ...SAFE, NEXT_PUBLIC_SANITY_DATASET: 'demo-2026' }), [])
  for (const dataset of ['production', '', 'Challenge', 'private-challenge', 'challenge/../production']) {
    assert.ok(demoModeProblems({ ...SAFE, NEXT_PUBLIC_SANITY_DATASET: dataset }).some((p) => p.includes('NEXT_PUBLIC_SANITY_DATASET')), dataset)
  }
  assert.ok(demoModeProblems({ ...SAFE, SANITY_DATASET_PUBLIC: undefined }).some((p) => p.includes('SANITY_DATASET_PUBLIC')))
})

test('demo mode refuses any real credential or development switch', () => {
  for (const name of DEMO_FORBIDDEN_VARIABLES) {
    assert.equal(demoModeProblems({ ...SAFE, [name]: 'set' }).length, 1, name)
    assert.deepEqual(demoModeProblems({ ...SAFE, [name]: 'off' }), [], `${name}=off is fine`)
  }
})

test('a misconfigured demo fails closed: every credential check answers 503', () => {
  const bad: CredentialEnv = { ...SAFE, NEXT_PUBLIC_SANITY_DATASET: 'production' }
  assert.equal(checkRouteCaller(['decision:read'], bearer(marcus.token), bad).ok, false)
  const r = checkRouteCaller(['decision:read'], bearer(marcus.token), bad)
  assert.ok(!r.ok && r.status === 503)
  const s = checkSupervisorCredential(bearer(sarah.token), 'decision:approve', bad)
  assert.ok(!s.ok && s.status === 503)
  assert.equal(checkWhoami(bearer(sarah.token), bad).status, 503)
})

test('demo tokens work only in demo mode', () => {
  const real: CredentialEnv = { NQC_SUPERVISOR_TOKEN: 'r'.repeat(40), NQC_SUPERVISOR_ID: 'entity-founder' }
  assert.equal(checkRouteCaller(['decision:read'], bearer(marcus.token), real).ok, false)
  assert.equal(checkSupervisorCredential(bearer(sarah.token), 'decision:approve', real).ok, false)
  assert.equal(checkRouteCaller(['decision:read'], bearer(marcus.token), {}).ok, false)
})

test('in demo mode, Marcus proposes and Sarah approves; neither can do the other\'s part', () => {
  assert.equal(demoPrincipalForToken(marcus.token)?.id, 'entity-marcus-webb')
  assert.equal(demoPrincipalForToken('nope'), undefined)

  const m = checkRouteCaller(['decision:propose'], bearer(marcus.token), SAFE)
  assert.ok(m.ok && m.principalId === 'entity-marcus-webb' && m.kind === 'human')
  assert.equal(checkSupervisorCredential(bearer(marcus.token), 'decision:approve', SAFE).ok, false, 'Marcus cannot approve')

  const s = checkSupervisorCredential(bearer(sarah.token), 'decision:approve', SAFE)
  assert.ok(s.ok && s.supervisorId === 'entity-sarah-chen')
  assert.equal(checkSupervisorCredential(bearer(sarah.token), 'decision:execute', SAFE).ok, true)
  assert.equal(checkSupervisorCredential(bearer(sarah.token), 'decision:rollback', SAFE).ok, true)
  const sp = checkRouteCaller(['decision:propose'], bearer(sarah.token), SAFE)
  assert.ok(!sp.ok && sp.status === 403, 'Sarah cannot propose')

  assert.equal(checkRouteCaller(['decision:read'], 'Bearer not-a-demo-token-at-all-000000000000', SAFE).ok, false)

  const who = checkWhoami(bearer(sarah.token), SAFE)
  assert.ok(who.ok)
  if (who.ok) {
    assert.equal(who.body.displayName, 'Sarah Chen (Chief Executive Officer)')
    assert.ok(who.body.permissions.includes('decision:approve'))
    assert.ok(!who.body.permissions.includes('decision:propose'))
  }
})

test('demo tokens are long enough to be principal tokens and are distinct', () => {
  assert.equal(new Set(DEMO_PRINCIPALS.map((p) => p.token)).size, DEMO_PRINCIPALS.length)
  for (const p of DEMO_PRINCIPALS) assert.ok(p.token.length >= 32 && p.token.startsWith('demo-public-'))
})
