/**
 * The chat assistant reads the app as the person asking. These checks pin how: every tool is
 * served by one of the app's own read routes, run in-process with the person's credentials,
 * and nothing the assistant can reach writes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { APP_TOOL_SAMPLE_PATHS } from '../../../packages/agent/src/app-tools.ts'
import { mayCarryConsoleToken } from './console-auth.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const appFetch = read('./chat-app-fetch.ts')
const chatRoute = read('../app/api/chat/route.ts')

test('every path an assistant tool reads is served by a route listed in chat-app-fetch', () => {
  assert.ok(APP_TOOL_SAMPLE_PATHS.length >= 10)
  for (const path of APP_TOOL_SAMPLE_PATHS) {
    const pathname = new URL(path, 'http://x').pathname
    const isDetail = /^\/api\/decisions\/[A-Za-z0-9._:-]+$/.test(pathname)
    assert.ok(isDetail || appFetch.includes(`'${pathname}':`), `${pathname} has no handler`)
  }
})

test('the assistant reaches routes by calling their handlers, never over the network, and only with GET', () => {
  assert.equal(/\bfetch\(/.test(appFetch), false)
  assert.match(appFetch, /method: 'GET'/)
  assert.equal(/\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/.test(appFetch.replace(/\/\*[\s\S]*?\*\//g, '')), false)
  for (const forbidden of ['action', 'execute', 'rollback', 'publish', 'review', 'drafts', 'agents/run', 'workflows/run']) {
    assert.equal(new RegExp(`from '@/app/api/[^']*${forbidden}`).test(appFetch), false, `imports a ${forbidden} route`)
  }
})

test('only the asking person\'s Authorization and session cookie are passed on', () => {
  assert.match(appFetch, /\['authorization', 'cookie'\]/)
})

test('the chat route needs decision:read, is rate limited as a model route, and the tools run through the person\'s routes', async () => {
  assert.match(chatRoute, /guardWebRoute\(req, 'chat'\)/)
  assert.match(chatRoute, /appFetchFor\(req\)/)
  const { WEB_ROUTE_ACCESS } = await import('./route-guard.ts')
  assert.deepEqual(WEB_ROUTE_ACCESS.chat.permissions, ['decision:read'])
  assert.equal(WEB_ROUTE_ACCESS.chat.rateLimit, 'model')
  assert.deepEqual(WEB_ROUTE_ACCESS.decisions.permissions, ['decision:read'])
  assert.deepEqual(WEB_ROUTE_ACCESS['decisions/detail'].permissions, ['decision:read'])
})

test('the decision read routes are guarded and read-only', () => {
  const list = read('../app/api/decisions/route.ts')
  const detail = read('../app/api/decisions/[id]/route.ts')
  assert.match(list, /guardWebRoute\(request, 'decisions'\)/)
  assert.match(detail, /guardWebRoute\(request, 'decisions\/detail'\)/)
  for (const source of [list, detail]) {
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(source), false)
    assert.equal(/getSanityClient\('write'\)/.test(source), false)
  }
})

test('the console token may be sent to the chat and decision read paths, and nowhere else under decisions', () => {
  for (const url of ['/api/chat', '/api/decisions', '/api/decisions?limit=10', '/api/decisions?status=awaiting-approval&limit=10', '/api/decisions/decision-plan-abc-0']) {
    assert.equal(mayCarryConsoleToken(url), true, url)
  }
  for (const url of ['/api/decisions/a/b', '/api/decisions?status=x y', '/api/decisions/../chat', '/api/decisions?limit=abc', '/api/chats']) {
    assert.equal(mayCarryConsoleToken(url), false, url)
  }
})

test('a planned decision keeps the kernel\'s explanation so the decision page can show it later', () => {
  const plan = read('../app/api/plan/route.ts')
  assert.match(plan, /\.\.\.\(why \? \{ why \} : \{\}\)/)
  assert.match(plan, /why = explainWhy\(kernelArgs\)/)
})
