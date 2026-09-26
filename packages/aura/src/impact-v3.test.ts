/** The frozen scorer v3 predictions for the fresh impact-ranking test. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IMPACT_SCORER_VERSION } from './index.ts'

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval')
const frozen = JSON.parse(readFileSync(join(evalDir, 'impact-predictions-v3.json'), 'utf8')) as { scorerVersion: number; rankings: Record<string, Array<{ variableId: string; score: number }>> }
const set = JSON.parse(readFileSync(join(evalDir, 'impact-ranking-set-v3.json'), 'utf8')) as { objectives: Array<{ id: string; text: string }> }

test('the frozen v3 predictions are unchanged (an edit is a new version)', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(frozen)).digest('hex'), FROZEN_SHA256)
})

test('the frozen file records scorer v3 on the 30-objective set (the scorer has since moved on)', () => {
  assert.equal(frozen.scorerVersion, 3)
  assert.ok(IMPACT_SCORER_VERSION > 3)
  assert.equal(set.objectives.length, 30)
  for (const o of set.objectives) assert.ok(frozen.rankings[o.id]!.length > 3, o.id)
})

const FROZEN_SHA256 = 'f7f7b59e9f3cfb73a45142302970a53bf69857693543bd8d37a1d31cd923503a'
