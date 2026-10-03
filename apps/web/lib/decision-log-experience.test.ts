import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = readFileSync(new URL('../app/decisions/page.tsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../components/decision-detail.tsx', import.meta.url), 'utf8')

test('the decisions page says what it is for and groups decisions by what a person has to do', () => {
  assert.match(page, /<h1>Decisions<\/h1>/)
  assert.match(page, /what is waiting for you/)
  assert.match(page, /aria-label="Decision groups"/)
  assert.match(page, /aria-label="Decision list"/)
})

test('decision detail is progressively disclosed and the empty states say what to do next', () => {
  assert.match(detail, /<details className=\{styles\.section\}>/)
  assert.match(detail, /<summary>Reasoning summary<\/summary>/)
  assert.match(page, /Choose a decision to see why it was proposed/)
  assert.match(page, /Nothing is waiting for a decision/)
})

test('the audit-trail information the old log showed is still there: policy conflicts, review flags, evidence and history', () => {
  for (const label of ['Policy checks', 'Independent review', 'Supporting evidence', 'History']) assert.match(detail, new RegExp(label))
})
