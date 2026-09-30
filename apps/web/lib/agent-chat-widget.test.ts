import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const widget = readFileSync(new URL('../components/agent-chat-widget.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../components/agent-chat-widget.module.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')

test('read-only agent chat is available across every app page', () => {
  assert.match(layout, /<AgentChatWidget\s*\/>/)
  assert.match(widget, /fetch\('\/api\/query'/)
  assert.match(widget, /consoleHeaders\('\/api\/query', token/)
  assert.match(widget, /JSON\.stringify\(\{ question: text \}\)/)
  assert.match(widget, /Read-only · NQC-evaluated/)
  assert.match(widget, /Chat cannot approve or execute actions/)
  assert.match(widget, /\/planning#console-token/)
})

test('chat launcher and transcript have accessible, session-scoped controls', () => {
  assert.match(widget, /aria-haspopup="dialog"/)
  assert.match(widget, /aria-expanded=\{open\}/)
  assert.match(widget, /role="dialog" aria-labelledby="qs-chat-title"/)
  assert.match(widget, /aria-live="polite"/)
  assert.match(widget, /readConsoleToken\(\)/)
  assert.doesNotMatch(widget, /localStorage|sessionStorage\.setItem/)
  assert.match(widget, /event\.key === 'Escape'/)
  assert.match(styles, /@media \(max-width: 38rem\)/)
  assert.match(styles, /@media \(max-width: 24rem\)/)
  assert.match(styles, /@media \(max-height: 32rem\)/)
  assert.match(styles, /env\(safe-area-inset-bottom\)/)
})
