/**
 * Strict structured-output guard for every schema we send to a model.
 *
 * Azure OpenAI / OpenAI strict `response_format` rejects any object whose
 * `required` array doesn't list every key in `properties`. A Zod
 * `.optional()` or `.default()` silently drops the key from `required`, and
 * this project shipped that bug three times (planner financialExposure,
 * reviewer arrays, query agent `role`), each only caught live in production.
 * This test converts each schema exactly the way the AI SDK does and fails
 * on the first object that would be rejected.
 *
 * Run with:   npm run agent:test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zodSchema } from 'ai'

import { PlanOutputSchema } from './planner.ts'
import { ReviewResultSchema } from './reviewer.ts'
import { QueryResultSchema } from './query.ts'
import { IntentParseSchema } from './intent-parser.ts'

type JsonSchema = { type?: unknown; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema | JsonSchema[]; anyOf?: JsonSchema[]; [k: string]: unknown }

function strictViolations(schema: JsonSchema, path = '$'): string[] {
  const out: string[] = []
  if (schema.properties) {
    const keys = Object.keys(schema.properties)
    const required = new Set(schema.required ?? [])
    for (const k of keys) if (!required.has(k)) out.push(`${path}.${k} is not in "required"`)
    for (const [k, v] of Object.entries(schema.properties)) out.push(...strictViolations(v, `${path}.${k}`))
  }
  const items = schema.items
  if (Array.isArray(items)) items.forEach((it, i) => out.push(...strictViolations(it, `${path}[${i}]`)))
  else if (items) out.push(...strictViolations(items, `${path}[]`))
  for (const alt of schema.anyOf ?? []) out.push(...strictViolations(alt, path))
  return out
}

for (const [name, schema] of [
  ['PlanOutputSchema (planner)', PlanOutputSchema],
  ['ReviewResultSchema (reviewer)', ReviewResultSchema],
  ['QueryResultSchema (/api/query)', QueryResultSchema],
  ['IntentParseSchema (Aura objective parser)', IntentParseSchema],
] as const) {
  test(`Strict output: ${name} lists every property as required`, () => {
    const json = zodSchema(schema as never).jsonSchema as JsonSchema
    assert.deepEqual(strictViolations(json), [])
  })
}
