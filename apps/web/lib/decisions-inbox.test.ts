/**
 * The decisions page is where a person reads a decision and acts on it. These pin how it is wired:
 * the server decides what is offered, the page draws it, and the list is read through guarded routes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const page = read('../app/decisions/page.tsx')
const detail = read('../components/decision-detail.tsx')
const list = read('../app/api/decisions/route.ts')
const one = read('../app/api/decisions/[id]/route.ts')

test('the page is a signed-in workspace with groups, a list, paging and a detail view, and it no longer reads the data store itself', () => {
  assert.equal(/getSanityClient/.test(page), false)
  assert.match(page, /resolveConsoleAccess\(undefined, undefined, \{ withWhoami: true \}\)/)
  for (const label of ['Needs a decision', 'Ready to run', 'Done', 'Refused or failed', 'All']) assert.match(page, new RegExp(label))
  assert.match(page, /Show older decisions/)
  assert.match(page, /Sign in to see decisions/)
  assert.match(page, /aria-current=\{selected === row\.id \? 'true' : undefined\}/)
  assert.match(page, /signInPageHref\('\/decisions'\)/)
})

test('a decision can be opened by link, which is how the bell and the cards reach it', () => {
  assert.match(page, /params\.get\('id'\)/)
  assert.match(page, /router\.push\(`\/decisions/)
})

test('the empty list sends people to the chat, and a failed load offers a retry', () => {
  assert.match(page, /Ask Quicksilver to plan something in the chat/)
  assert.match(page, /Try again/)
})

test('every control comes from decisionActionOptions: disabled ones say why, and effects ask first', () => {
  assert.match(detail, /decisionActionOptions\(/)
  assert.match(detail, /disabled=\{!option\.enabled \|\| busy\}/)
  assert.match(detail, /aria-describedby=\{option\.reason \? `why-\$\{option\.id\}` : undefined\}/)
  assert.match(detail, /if \(option\.needsNote \|\| option\.confirm\)/)
  assert.match(detail, /Confirm: /)
  assert.match(detail, /Reload this page to see the current version/)
  assert.equal(/expectedActionFingerprint/.test(detail), false, 'the fingerprint comes from the server, not from this component')
})

test('a note is sent only on the action route, and a self-approval note must be long enough', () => {
  assert.match(detail, /option\.call\.path\.endsWith\('\/action'\)/)
  assert.match(detail, /const MIN_REASON = 20/)
  assert.match(detail, /Why you are approving your own request/)
})

test('a changed policy is said aloud, a missing explanation is explained, and the explanation panel is the same one planning shows', () => {
  assert.match(detail, /A policy changed since this was planned/)
  assert.match(detail, /planned before explanations were kept/)
  assert.match(detail, /<WhyPanel why=\{detail\.why\} defaultOpen \/>/)
})

test('after an action the detail, the list and the shared needs-you list are refreshed', () => {
  assert.match(detail, /await load\(\)/)
  assert.match(detail, /onChanged\(\)/)
  assert.match(detail, /inboxStore\(\)\.refresh\(\)/)
})

test('the list route takes up to four statuses, a page boundary and returns counts and whether there is more; both routes only read', () => {
  assert.match(list, /statuses\.length > 4/)
  assert.match(list, /hasMore/)
  assert.match(list, /counts/)
  for (const source of [list, one]) {
    assert.equal(/getSanityClient\('write'\)/.test(source), false)
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(source), false)
  }
})

test('the detail route returns what an approval covers and whether policy moved, computed the way the approve route does, plus whether the viewer is the sole operator', () => {
  assert.match(one, /currentPolicySnapshotVersion/)
  assert.match(one, /decisionActionFingerprint/)
  assert.match(one, /viewer: \{ id: caller\.principalId, soleOperator:/)
})

test('the chat says before you type that Plan needs a permission you lack, and the planning box is empty outside demo mode', () => {
  const widget = read('../components/agent-chat-widget.tsx')
  assert.match(widget, /const cannotPlan = permissions !== null && !permissions\.includes\('decision:propose'\)/)
  assert.match(widget, /disabled=\{busy \|\| cannotPlan\}/)
  assert.match(widget, /Planning needs decision:propose/)
  const planning = read('../app/planning/page.tsx')
  assert.match(planning, /DEMO \? 'Reduce production downtime/)
  assert.match(planning, /placeholder="For example:/)
})
