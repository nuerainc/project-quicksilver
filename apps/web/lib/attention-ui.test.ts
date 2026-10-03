/**
 * The attention list is shown in the chat and is clickable. These pin who writes what: the server
 * builds every item and every call; the component only shows them and makes the call a person
 * clicks, as that person; and the model can only ask for the live list to be shown.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const list = read('../components/attention-list.tsx')
const widget = read('../components/agent-chat-widget.tsx')
const chatRoute = read('../app/api/chat/route.ts')
const inboxRoute = read('../app/api/inbox/route.ts')

test('the component calls only the path the server put on the item, as the signed-in person', () => {
  assert.match(list, /const call = action\.call/)
  assert.match(list, /fetch\(call\.path/)
  assert.match(list, /consoleHeaders\(call\.path, access\.token/)
  assert.equal(/from '@quicksilver\/agent'/.test(list), false, 'no model code in the component')
  assert.equal(/\/api\/decisions\//.test(list), false, 'no decision path is written in the component')
})

test('a click that has an effect asks first, and a refusal is shown on the card', () => {
  assert.match(list, /call\.confirm && state\.confirming !== action\.id/)
  assert.match(list, /Confirm: /)
  assert.match(list, />Cancel</)
  assert.match(list, /role="alert"/)
  assert.match(list, /Open it to review the current version/)
})

test('a source that could not be checked is said aloud, and the count says it may be incomplete', () => {
  assert.match(list, /Could not check /)
  assert.match(list, /counts\.complete \? '' : '\+'/)
  assert.match(list, /Nothing needs you right now/)
  assert.match(list, /unchecked\.length === 0/)
})

test('it refreshes about once a minute and when the tab regains focus, and says it is a check, not a live feed', () => {
  assert.match(list, /POLL_MS = 60_000/)
  assert.match(list, /addEventListener\('focus'/)
  assert.match(list, /Checked /)
})

test('the chat shows the live list under an answer only when the assistant asks, and in the empty chat', () => {
  assert.match(widget, /result\.showAttention && <AttentionList/)
  assert.match(widget, /tokenPresent && <AttentionList/)
  assert.match(chatRoute, /showAttention: result\.showAttention/)
})

test('the inbox is computed from records without a model, and reads other sources only through their own routes', () => {
  assert.equal(/@quicksilver\/agent/.test(inboxRoute), false)
  assert.match(inboxRoute, /guardWebRoute\(request, 'inbox'\)/)
  assert.match(inboxRoute, /appFetchFor\(request\)/)
  assert.match(inboxRoute, /getSanityClient\('read'\)/)
  assert.equal(/getSanityClient\('write'\)/.test(inboxRoute), false)
  assert.match(inboxRoute, /currentPolicySnapshotVersion/)
  assert.match(inboxRoute, /decisionActionFingerprint/)
})
