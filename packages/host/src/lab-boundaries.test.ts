/**
 * The lab's own boundaries (deploy/boundaries/lab.json) keep AMP material out
 * and Forkling read-only, exactly as the built-in rules did before they were
 * made generic. Public editions leave this file and test out.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { assertSourceAllowed, BlockedSourceError } from '@quicksilver/aura'
import { labConnectorPatterns, readLabBoundaries } from './lab-boundaries.ts'
import { checkTaskBoundaries, DEFAULT_TASK_BOUNDARIES, mergeBoundaries } from './task-boundaries.ts'

const repo = join(import.meta.dirname, '..', '..', '..')

test('lab boundaries: AMP material is refused and Forkling stays read-only', () => {
  const lab = readLabBoundaries(repo)
  assert.ok(lab, 'deploy/boundaries/lab.json exists')
  const rules = mergeBoundaries(DEFAULT_TASK_BOUNDARIES, lab)
  assert.deepEqual(checkTaskBoundaries({ objective: 'Summarize the claims in the AMP filing.' }, rules).rules, ['amp-patent-material'])
  assert.equal(checkTaskBoundaries({ objective: 'Summarize this.', inputs: { file: 'ppa-rev-4.2-draft.pdf' } }, rules).passed, false)
  assert.equal(checkTaskBoundaries({ objective: 'Tune it.', capabilityId: 'forkling.update' }, rules).rules[0], 'frozen:forkling')
  assert.equal(checkTaskBoundaries({ objective: 'Update the Forkling routing table and redeploy it.' }, rules).passed, false)
  assert.equal(checkTaskBoundaries({ objective: 'Summarize Forkling results.', capabilityId: 'forkling.read' }, rules).passed, true)
  assert.equal(checkTaskBoundaries({ objective: 'Brief me on sales.' }, rules).passed, true)
})

test('lab boundaries: the Onboard connector refuses AMP-looking sources', () => {
  const patterns = labConnectorPatterns(readLabBoundaries(repo))
  for (const s of ['AMP-ledger.csv', 'PPA Rev 4.2 budget.csv', 'patent costs.csv']) {
    assert.throws(() => assertSourceAllowed(s, patterns), BlockedSourceError, s)
  }
  assert.doesNotThrow(() => assertSourceAllowed('sample.csv', patterns))
  assert.equal(readLabBoundaries('/nonexistent-dir'), undefined)
})
