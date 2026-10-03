import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const widget = readFileSync(new URL('../components/agent-chat-widget.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../components/agent-chat-widget.module.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')

test('there is one chat, with no mode switch, available across every app page', () => {
  assert.match(layout, /<AgentChatWidget\s*\/>/)
  assert.match(widget, /chatTurnRequest\(text, history, pageHint\(pathname, window\.location\.search\)\)/)
  assert.doesNotMatch(widget, /aria-label="Chat mode"|modeSwitch|setMode|Choose business specialist/)
  assert.match(widget, /signInPageHref\(pathname\)/)
})

test('work is offered as a card the person edits and presses; the model never runs it', () => {
  assert.match(widget, /function OfferCard/)
  assert.match(widget, /Create this plan\?/)
  assert.match(widget, /Ask the \$\{/)
  assert.match(widget, /Run workflow/)
  assert.match(widget, /offerRequest\(offer, text\)/)
  assert.match(widget, /Pressing a card is the person's act/)
  assert.match(widget, /BusinessAgentAnswer/)
  assert.match(widget, /Review \{proposed\.length\} saved/)
  // the offer is only sent from a click handler, never from the response handler
  assert.doesNotMatch(widget.slice(widget.indexOf('async function send('), widget.indexOf('function ask(')), /offerRequest|\/api\/plan|agents\/run/)
})

test('chat has stop, try again, a remembered conversation and page awareness', () => {
  assert.match(widget, /aria-label="Stop answering"/)
  assert.match(widget, /AbortController/)
  assert.match(widget, />Try again<\/button>/)
  assert.match(widget, /loadChat<ChatMessage>\(\)/)
  assert.match(widget, /saveChat\(messages\)/)
  assert.match(widget, /prefill/)
  const chatStore = readFileSync(new URL('./chat-store.ts', import.meta.url), 'utf8')
  assert.match(chatStore, /sessionStorage/)
  assert.match(chatStore, /catch/)
})

test('chat reads the whole app through /api/chat and links only to pages of the app', () => {
  const request = readFileSync(new URL('./chat-request.ts', import.meta.url), 'utf8')
  assert.match(request, /path: '\/api\/chat'/)
  assert.match(widget, /What I looked at/)
  assert.match(widget, /isLocalLink/)
  assert.match(widget, /href\.startsWith\('\/'\) && !href\.startsWith\('\/\/'\) && !href\.startsWith\('\/api\/'\)/)
  assert.match(widget, /never approves or changes anything/)
})

test('chat launcher and transcript have accessible, session-scoped controls', () => {
  assert.match(widget, /aria-haspopup="dialog"/)
  assert.match(widget, /aria-expanded=\{open\}/)
  assert.match(widget, /role="dialog" aria-modal=\{expanded \|\| undefined\} aria-labelledby="qs-chat-title"/)
  assert.match(widget, /aria-live="polite"/)
  assert.match(widget, /resolveConsoleAccess\(\)/)
  assert.doesNotMatch(widget, /localStorage|sessionStorage/)
  assert.match(widget, /event\.key === 'Escape'/)
  assert.match(widget, /quicksilver:open-chat/)
  assert.match(widget, /aria-modal=\{expanded \|\| undefined\}/)
  assert.match(widget, /Expand chat to workspace/)
  assert.match(widget, /aria-label="Business workspaces"/)
  assert.match(widget, /\['\/','Overview','Company health and priorities'\]/)
  assert.doesNotMatch(widget, /\/planning/)
  assert.match(styles, /\.panelExpanded/)
  assert.match(styles, /\.contextRail/)
  assert.match(styles, /@media \(max-width: 48rem\)\s*\{\s*\.launcher\s*\{\s*display:\s*none/s)
  assert.match(styles, /@media \(max-width: 38rem\)/)
  assert.match(styles, /@media \(max-width: 24rem\)/)
  assert.match(styles, /@media \(max-height: 32rem\)/)
  assert.match(styles, /env\(safe-area-inset-bottom\)/)
})
