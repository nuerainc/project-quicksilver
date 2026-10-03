import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSessionState, signInHref } from './session-control.ts'

const reply = (status: number, body: unknown = {}) => async () => ({ status, json: async () => body })

test('a 200 session is signed in, preferring the display name', async () => {
  const state = await loadSessionState(reply(200, { principalId: 'p1', displayName: ' Ada ', roles: ['viewer', 3] }))
  assert.deepEqual(state, { status: 'signed-in', name: 'Ada', roles: ['viewer'] })
})

test('without a display name the principal id is shown', async () => {
  assert.deepEqual(await loadSessionState(reply(200, { principalId: 'p1' })), { status: 'signed-in', name: 'p1', roles: [] })
})

test('401 is signed out; 503, odd bodies and network errors are unavailable', async () => {
  assert.deepEqual(await loadSessionState(reply(401)), { status: 'signed-out' })
  assert.deepEqual(await loadSessionState(reply(503)), { status: 'unavailable' })
  assert.deepEqual(await loadSessionState(reply(200, {})), { status: 'unavailable' })
  assert.deepEqual(await loadSessionState(async () => { throw new Error('offline') }), { status: 'unavailable' })
})

test('the sign-in link returns to the current page and never to another site or an API path', () => {
  assert.equal(signInHref('/decisions'), '/api/auth/oidc/start?returnTo=%2Fdecisions')
  assert.equal(signInHref('//evil.example'), '/api/auth/oidc/start?returnTo=%2F')
  assert.equal(signInHref('/api/auth/logout'), '/api/auth/oidc/start?returnTo=%2F')
  assert.equal(signInHref('https://evil.example'), '/api/auth/oidc/start?returnTo=%2F')
})
