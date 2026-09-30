import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShutdownHandler } from './shutdown.ts'

function fixture() {
  const events: string[] = []
  const timers: Array<() => void> = []
  const exits: number[] = []
  const options: Array<{ abort?: boolean } | undefined> = []
  const handler = createShutdownHandler({
    stop: async (value) => { options.push(value); events.push('stop') },
    exit: (code) => { exits.push(code) },
    schedule: (callback, delay) => { assert.equal(delay, 60_000); timers.push(callback); return { unref() { events.push('unref') } } },
    log: { info: () => events.push('info'), warn: () => events.push('warn'), error: () => events.push('error') },
  })
  return { handler, events, timers, exits, options }
}

test('shutdown: first signal drains cleanly and exits 0', async () => {
  const f = fixture()
  f.handler('SIGTERM')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.options, [undefined])
  assert.deepEqual(f.exits, [0])
  assert.deepEqual(f.events, ['info', 'unref', 'stop'])
})

test('shutdown: a second signal aborts in-flight work and exits 1', async () => {
  const f = fixture()
  f.handler('SIGTERM')
  f.handler('SIGTERM')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.options, [undefined, { abort: true }])
  assert.deepEqual(f.exits, [0, 1])
  assert.ok(f.events.includes('warn'))
})

test('shutdown: timeout aborts in-flight work and exits 1', async () => {
  const f = fixture()
  f.handler('SIGTERM')
  f.timers[0]!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.options, [undefined, { abort: true }])
  assert.deepEqual(f.exits, [0, 1])
  assert.ok(f.events.includes('error'))
})

test('shutdown: a second signal after clean exit still aborts conservatively', async () => {
  const f = fixture()
  f.handler('SIGINT')
  await new Promise((resolve) => setImmediate(resolve))
  f.handler('SIGINT')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.options, [undefined, { abort: true }])
})
