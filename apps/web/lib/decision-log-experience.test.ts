import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = readFileSync(new URL('../app/decisions/page.tsx', import.meta.url), 'utf8')

test('decision log keeps a clear read-only audit purpose and summary', () => {
  assert.match(page, /<h1>Decision log<\/h1>/)
  assert.match(page, /read-only record/)
  assert.match(page, /aria-label="Decision summary"/)
  assert.match(page, /Awaiting approval/)
  assert.match(page, /Policy conflicts/)
})

test('decision detail is progressively disclosed and exposes an accessible empty state', () => {
  assert.match(page, /<details className="qs-decision-details">/)
  assert.match(page, /<summary>Inspect reasoning, review, and evidence<\/summary>/)
  assert.match(page, /aria-labelledby="empty-decisions-title"/)
  assert.match(page, /href="\/" className="qs-action-primary"/)
})
