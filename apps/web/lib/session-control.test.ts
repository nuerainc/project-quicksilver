import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSessionState, returnToFrom, signInHref, signInPageHref } from './session-control.ts'

const reply = (status: number, body: unknown = {}) => async () => ({ status, json: async () => body })

test('a signed-in status is a person, preferring the display name', async () => {
  const state = await loadSessionState(reply(200, { signedIn: true, principalId: 'p1', displayName: ' Ada ', roles: ['viewer', 3] }))
  assert.deepEqual(state, { status: 'signed-in', name: 'Ada', roles: ['viewer'] })
})

test('without a display name the principal id is shown', async () => {
  assert.deepEqual(await loadSessionState(reply(200, { signedIn: true, principalId: 'p1' })), { status: 'signed-in', name: 'p1', roles: [] })
})

test('not signed in is "signed out" only when sign-in is available; otherwise it is unavailable, and odd replies and network errors are unavailable too', async () => {
  assert.deepEqual(await loadSessionState(reply(200, { signedIn: false, signInAvailable: true })), { status: 'signed-out' })
  assert.deepEqual(await loadSessionState(reply(200, { signedIn: false, signInAvailable: false })), { status: 'unavailable' })
  assert.deepEqual(await loadSessionState(reply(200, { signedIn: false, unavailable: true })), { status: 'unavailable' })
  assert.deepEqual(await loadSessionState(reply(503)), { status: 'unavailable' })
  assert.deepEqual(await loadSessionState(reply(200, { signedIn: true })), { status: 'unavailable' })
  assert.deepEqual(await loadSessionState(async () => { throw new Error('offline') }), { status: 'unavailable' })
})

test('a signed-out visitor is not an error: the status route answers 200, never 401', async () => {
  let asked = ''
  await loadSessionState(async (url) => { asked = url; return { status: 200, json: async () => ({ signedIn: false, signInAvailable: true }) } })
  assert.equal(asked, '/api/auth/status')
})

test('the sign-in link returns to the current page and never to another site or an API path', () => {
  assert.equal(signInHref('/decisions'), '/api/auth/oidc/start?returnTo=%2Fdecisions')
  assert.equal(signInHref('//evil.example'), '/api/auth/oidc/start?returnTo=%2F')
  assert.equal(signInHref('/api/auth/logout'), '/api/auth/oidc/start?returnTo=%2F')
  assert.equal(signInHref('https://evil.example'), '/api/auth/oidc/start?returnTo=%2F')
})

test('after signing in a person goes back to a page of this app and nowhere else', () => {
  assert.equal(returnToFrom('?returnTo=%2Fdecisions%3Fid%3Dd1'), '/decisions?id=d1')
  assert.equal(returnToFrom(''), '/')
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/api/auth/logout', '/sign-in?returnTo=%2F', 'javascript:alert(1)', '/a\nb', '/a\tb', `/${'x'.repeat(400)}`]) {
    assert.equal(returnToFrom(`?returnTo=${encodeURIComponent(bad)}`), '/', bad)
  }
})

test('the sign-in page link carries the current page, and is plain for the home page and for unsafe paths', () => {
  assert.equal(signInPageHref('/decisions'), '/sign-in?returnTo=%2Fdecisions')
  assert.equal(signInPageHref('/'), '/sign-in')
  for (const bad of ['//evil.example', '/api/auth/logout', '/sign-in', 'https://evil.example']) assert.equal(signInPageHref(bad), '/sign-in', bad)
})
