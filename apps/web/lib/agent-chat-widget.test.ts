import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const widget = readFileSync(new URL('../components/agent-chat-widget.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../components/agent-chat-widget.module.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')

test('business chat is available across every app page and separates asking from planning', () => {
  assert.match(layout, /<AgentChatWidget\s*\/>/)
  assert.match(widget, /chatRequest\(submittedMode, text\)/)
  assert.match(widget, /aria-label="Chat mode"/)
  assert.match(widget, />Ask<\/button>/)
  assert.match(widget, />Plan<\/button>/)
  assert.match(widget, /Plan mode creates evaluated proposals for review/)
  assert.match(widget, /never approves or executes actions/)
  assert.match(widget, /Review \{proposed\.length\} saved/)
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
