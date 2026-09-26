/** The frozen scorer v3 predictions for the fresh impact-ranking test. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIntent, IMPACT_SCORER_VERSION } from './index.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const frozen = JSON.parse(readFileSync(join(evalDir, 'impact-predictions-v3.json'), 'utf8')) as { scorerVersion: number; rankings: Record<string, Array<{ variableId: string; score: number }>> }
const set = JSON.parse(readFileSync(join(evalDir, 'impact-ranking-set-v3.json'), 'utf8')) as { objectives: Array<{ id: string; text: string }> }

test('the frozen v3 predictions are unchanged (an edit is a new version)', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(frozen)).digest('hex'), FROZEN_SHA256)
})

test('scorer v3 still produces exactly the frozen rankings', async () => {
  assert.equal(frozen.scorerVersion, IMPACT_SCORER_VERSION)
  assert.equal(set.objectives.length, 30)
  for (const o of set.objectives) {
    const r = await createIntent(o.text, { requestedBy: 'eval', now: new Date('2026-09-26T12:00:00Z') })
    assert.deepEqual(r.impact.map((i) => i.variableId), frozen.rankings[o.id]!.map((i) => i.variableId), o.id)
    assert.ok(r.impact.length > 3, o.id)
  }
})

const FROZEN_SHA256 = 'f7f7b59e9f3cfb73a45142302970a53bf69857693543bd8d37a1d31cd923503a'
