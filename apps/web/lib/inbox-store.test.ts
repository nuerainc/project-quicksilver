import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createInboxStore, type Inbox, type InboxLoad } from './inbox-store.ts'

const inbox = (n: number): Inbox => ({ observedAt: '2026-10-03T12:00:00Z', items: [], sources: [], counts: { actionable: n, other: 0, complete: true } })
const manualTimers = () => {
  const real = { si: globalThis.setInterval, ci: globalThis.clearInterval }
  const ticks: Array<() => void> = []
  let cleared = 0
  globalThis.setInterval = ((fn: () => void) => { ticks.push(fn); return ticks.length as unknown as ReturnType<typeof setInterval> }) as typeof setInterval
  globalThis.clearInterval = (() => { cleared++ }) as typeof clearInterval
  return { ticks, cleared: () => cleared, restore: () => { globalThis.setInterval = real.si; globalThis.clearInterval = real.ci } }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the first subscriber starts one check and one timer; the last to leave stops it', async () => {
  const t = manualTimers()
  try {
    let calls = 0
    const store = createInboxStore(async () => { calls++; return { kind: 'ok', inbox: inbox(2) } })
    const a = store.subscribe(() => {})
    const b = store.subscribe(() => {})
    await settle()
    assert.equal(calls, 1, 'two places showing the list ask once')
    assert.equal(t.ticks.length, 1)
    a()
    assert.equal(t.cleared(), 0)
    b()
    assert.equal(t.cleared(), 1)
    assert.equal(store.getState().inbox?.counts.actionable, 2)
  } finally { t.restore() }
})

test('a refresh while one is running joins it instead of starting another', async () => {
  let calls = 0
  let release: () => void = () => {}
  const load: InboxLoad = () => new Promise((resolve) => { calls++; release = () => resolve({ kind: 'ok', inbox: inbox(1) }) })
  const store = createInboxStore(load)
  const first = store.refresh()
  const second = store.refresh()
  assert.equal(store.getState().loading, true)
  release()
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(store.getState().loading, false)
})

test('a failed check keeps the last good list and says so, instead of showing an empty one', async () => {
  let n = 0
  const store = createInboxStore(async () => (++n === 1 ? { kind: 'ok', inbox: inbox(3) } : { kind: 'error', message: 'Could not load.' }), { now: () => 1000 })
  await store.refresh()
  await store.refresh()
  const state = store.getState()
  assert.equal(state.inbox?.counts.actionable, 3)
  assert.equal(state.error, 'Could not load.')
  assert.equal(state.checkedAt, 1000)
})

test('a thrown error is reported the same way, and the next good check clears it', async () => {
  let n = 0
  const store = createInboxStore(async () => { if (++n === 1) throw new Error('boom'); return { kind: 'ok', inbox: inbox(1) } })
  await store.refresh()
  assert.match(store.getState().error!, /Could not reach the server/)
  await store.refresh()
  assert.equal(store.getState().error, null)
  assert.equal(store.getState().inbox?.counts.actionable, 1)
})

test('signed out clears the list and asks for sign-in; it is not an error', async () => {
  const store = createInboxStore(async () => ({ kind: 'signed-out' }))
  await store.refresh()
  assert.deepEqual(store.getState(), { inbox: null, error: null, needsSignIn: true, loading: false, checkedAt: null })
})

test('listeners hear every change, and the state object changes only when something did', async () => {
  const store = createInboxStore(async () => ({ kind: 'ok', inbox: inbox(1) }))
  const seen: unknown[] = []
  const stop = store.subscribe(() => seen.push(store.getState()))
  await settle()
  stop()
  assert.ok(seen.length >= 2, 'loading, then the result')
  assert.notEqual(seen[0], seen[seen.length - 1])
})
