import { test } from 'node:test'
import assert from 'node:assert/strict'

import { aggregateWaesComponents, WAES_COMPONENTS, type WaesComponentResult } from './waes.ts'

const result = (component: typeof WAES_COMPONENTS[number], verdict: 'pass' | 'revise' | 'block' = 'pass'): WaesComponentResult => ({ component, verdict, findings: [] })

test('WAES requires every component exactly once and only unanimous clean results pass', () => {
  const pass = WAES_COMPONENTS.map((component) => result(component))
  assert.equal(aggregateWaesComponents(pass), 'pass')
  assert.equal(aggregateWaesComponents(pass.slice(1)), 'revise')
  assert.equal(aggregateWaesComponents([pass[0]!, pass[0]!, pass[2]!]), 'revise')
  assert.equal(aggregateWaesComponents([...pass, pass[0]!]), 'revise')
  assert.equal(aggregateWaesComponents([pass[0]!, result(WAES_COMPONENTS[1]!, 'revise'), pass[2]!]), 'revise')
  assert.equal(aggregateWaesComponents([pass[0]!, result(WAES_COMPONENTS[1]!, 'block'), result(WAES_COMPONENTS[2]!, 'revise')]), 'block')
})
