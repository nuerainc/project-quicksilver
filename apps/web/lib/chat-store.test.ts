import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadChat, saveChat } from './chat-store.ts'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data }
}

test('a conversation is saved and restored, capped at the last twenty messages', () => {
  const storage = memory()
  saveChat(Array.from({ length: 30 }, (_, i) => ({ id: String(i) })), storage)
  const restored = loadChat<{ id: string }>(storage)
  assert.equal(restored.length, 20)
  assert.equal(restored[0]!.id, '10')
})

test('an empty conversation clears the stored copy', () => {
  const storage = memory()
  saveChat([{ id: 'a' }], storage)
  saveChat([], storage)
  assert.deepEqual(loadChat(storage), [])
  assert.equal(storage.data.size, 0)
})

test('blocked, full or corrupt storage never breaks the chat', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('blocked') } }
  assert.deepEqual(loadChat(broken), [])
  assert.doesNotThrow(() => saveChat([{ id: 'a' }], broken))
  assert.deepEqual(loadChat({ getItem: () => '{not json' }), [])
  assert.deepEqual(loadChat({ getItem: () => '{"a":1}' }), [])
})
