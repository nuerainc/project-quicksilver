import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const agentsPage = readFileSync(new URL('../app/agents/page.tsx', import.meta.url), 'utf8')
const monitoringPage = readFileSync(new URL('../app/monitoring/page.tsx', import.meta.url), 'utf8')

test('agent workspace keeps its governance actions and gives each section a clear destination', () => {
  for (const heading of ['Nuera Quicksilver Agents', 'Published catalog', 'Review queue', 'Drafts', 'Create an agent']) {
    assert.ok(agentsPage.includes(heading), `missing agents page heading: ${heading}`)
  }
  for (const primitive of ['qs-page-heading', 'qs-eyebrow', 'qs-panel', 'qs-field', 'qs-action-primary', 'qs-action-secondary']) {
    assert.ok(agentsPage.includes(primitive), `missing shared presentation primitive: ${primitive}`)
  }
  for (const route of ['agents/catalog', 'agents/drafts', 'agents/drafts/submit', 'agents/review', 'agents/publish', 'agents/definitions', 'agents/rollback']) {
    assert.ok(agentsPage.includes(`'${route}'`), `missing governed agent action route ${route}`)
  }
  assert.match(agentsPage, /href="#create-agent"/)
  assert.match(agentsPage, /id="create-agent"/)
  assert.match(agentsPage, /aria-labelledby="published-title"/)
  assert.match(agentsPage, /aria-labelledby="review-title"/)
  assert.match(agentsPage, /aria-labelledby="drafts-title"/)
  for (const inputId of ['agent-display-name', 'agent-stable-id', 'agent-description', 'agent-authority', 'agent-maximum-impact']) {
    assert.match(agentsPage, new RegExp(`htmlFor="${inputId}"`))
    assert.match(agentsPage, new RegExp(`id="${inputId}"`))
  }
  assert.match(agentsPage, /grid gap-4 md:grid-cols-2/)
  assert.match(agentsPage, /md:grid-cols-\[minmax\(0,1fr\)_minmax\(18rem,0\.8fr\)\]/)
})

test('monitoring workspace keeps metadata-only behavior and responsive filters, cards, and table', () => {
  assert.match(monitoringPage, /const API_PATH = '\/api\/monitoring\/workflows'/)
  assert.match(monitoringPage, /resolveConsoleAccess\(\)/)
  assert.match(monitoringPage, /metadata only/i)
  assert.match(monitoringPage, /Workflow monitoring/)
  assert.match(monitoringPage, /Recent workflow metrics/)
  assert.match(monitoringPage, /Execution history/)
  assert.match(monitoringPage, /qs-page-heading/)
  assert.match(monitoringPage, /qs-action-secondary/)
  assert.match(monitoringPage, /id="workflow-monitor-search"/)
  assert.match(monitoringPage, /id="workflow-monitor-status"/)
  assert.match(monitoringPage, /sm:grid-cols-\[minmax\(12rem,1fr\)_auto\]/)
  assert.match(monitoringPage, /lg:hidden/)
  assert.match(monitoringPage, /hidden overflow-x-auto lg:block/)
  assert.match(monitoringPage, /scope="col"/)
  assert.match(monitoringPage, /Summary values cover the latest/)
  assert.match(monitoringPage, /blocked/)
  assert.match(monitoringPage, /succeeded/)
  assert.match(monitoringPage, /failed/)
})
