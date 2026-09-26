/**
 * Evaluate the rule-based baseline parser on the labeled set:
 *   npm run aura:eval
 * The model-based parser is evaluated from the agent package (it needs model keys):
 *   npm run aura:eval:model
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateParser, type LabeledObjective } from './evaluate.ts'
import { parseObjectiveBaseline } from './parse.ts'

const setPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'objectives.json')
const set = (JSON.parse(readFileSync(setPath, 'utf8')) as { objectives: LabeledObjective[] }).objectives
const report = await evaluateParser(parseObjectiveBaseline, set)
console.log(`Baseline parser: ${report.exactMatches}/${report.objectives} objectives fully correct (${(report.parsingAccuracy * 100).toFixed(1)}%; charter target 90%).`)
console.log('Field accuracy:', report.fieldAccuracy)
if (process.argv.includes('--misses')) for (const m of report.misses) console.log(`  ${m.id} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`)
