import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { graphLayout } from './workflow-layout.ts'

const page = readFileSync(new URL('../app/workflows/page.tsx', import.meta.url), 'utf8')

test('workflow editor presents a clear, responsive editing workspace', () => {
  assert.match(page, /<h1 className="qs-page-heading">Build a workflow<\/h1>/)
  assert.match(page, /className="grid grid-cols-1 gap-5 xl:grid-cols-\[minmax\(0,1\.2fr\)_minmax\(18rem,0\.8fr\)\]/)
  assert.match(page, /aria-label="Add workflow step"/)
  assert.match(page, /<section aria-label="Workflow graph" className="qs-panel">/)
  assert.match(page, /className="qs-action-primary[^>]*">\{validating \? 'Checking workflow…' : 'Validate workflow'\}/)
  assert.match(page, /role="alert"/)
  assert.match(page, /role="status"/)
  assert.match(page, /aria-label="Connection source"/)
  assert.match(page, /aria-label="Connection destination"/)
  assert.match(page, /<details[^>]*>[\s\S]*?Version history/)
  assert.match(page, /h-\[min\(56svh,44rem\)\] min-h-32/)
  assert.match(page, /overflow-hidden p-3 sm:p-5/)
  assert.doesNotMatch(page, /<main[^>]*overflow-x-scroll/)
})

test('workflow map fills the available canvas and remeasures at responsive breakpoints', () => {
  assert.match(page, /const diagramViewport = useRef<HTMLDivElement>\(null\)/)
  assert.match(page, /new ResizeObserver\(measure\)/)
  assert.match(page, /observer\.observe\(viewport\)/)
  assert.match(page, /window\.addEventListener\('resize', measure\)/)
  assert.match(page, /viewport\.clientWidth - horizontalPadding/)
  assert.match(page, /viewport\.clientHeight - verticalPadding/)
  assert.match(page, /width=\{diagramSize\.width \|\| map\.width\} height=\{diagramSize\.height \|\| map\.height\}/)
  assert.match(page, /viewBox=\{`0 0 \$\{map\.width\} \$\{map\.height\}`\}/)
  assert.match(page, /preserveAspectRatio="xMidYMid meet"/)
  assert.match(page, /className="block h-full w-full min-w-0"/)
  assert.doesNotMatch(page, /diagramScale|zoom slider|scale slider/i)
})

test('empty and single-step workflows always have a usable canvas viewBox', () => {
  const empty = graphLayout([], [])
  const oneNode = graphLayout([{ id: 'trigger-1', kind: 'trigger', label: 'Start' }], [])
  for (const layout of [empty, oneNode]) {
    assert.ok(Number.isFinite(layout.width) && layout.width > 0)
    assert.ok(Number.isFinite(layout.height) && layout.height > 0)
  }
  assert.equal(empty.positions.size, 0)
  assert.equal(oneNode.positions.get('trigger-1')?.x, 32)
})

test('workflow authoring and release routes keep their established contracts', () => {
  for (const route of ['workflows/validate', 'workflows/simulate', 'workflows/run', 'workflows/drafts', 'workflows/drafts/submit', 'workflows/review', 'workflows/publish', 'workflows/rollback', 'workflows/diff', 'workflows/publications', 'workflows/executions']) {
    assert.ok(page.includes(route), `missing workflow API route: ${route}`)
  }
  for (const action of ['savePlatformDraft', 'submitDraft', 'reviewVersion', 'publishVersion', 'rollbackVersion', 'forkVersionAsNextDraft', 'compareWithPrevious', 'runReadOnlyWorkflow', 'previewWorkflow', 'importDraft', 'exportDraft']) {
    assert.ok(page.includes(action), `missing workflow action: ${action}`)
  }
  assert.match(page, /externalEffectsEnabled: false/)
})

test('workflow editor provides bounded-loop authoring with validated non-recursive body graphs', () => {
  assert.match(page, /loop: \{ maxIterations: 5, maxDurationMs: 60_000, continueWhile: '\$input\.iteration < 2'/)
  assert.match(page, /\['agent', 'tool', 'condition', 'loop', 'output'\]/)
  assert.match(page, /Continue while/)
  assert.match(page, /Maximum iterations/)
  assert.match(page, /Time budget \(milliseconds\)/)
  assert.match(page, /Apply loop body/)
  assert.match(page, /candidate\.nodes\.some\(\(node\) => node\.kind === 'loop'\)/)
  assert.match(page, /validateWorkflowGraph\(candidate\)/)
})
