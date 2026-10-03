import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * Memory may inform an agent; it must never widen what the agent is allowed to do.
 * That holds only while no authorization code reads memory, so this fails the moment
 * one of them imports it. It is a check on imports, not a proof: it cannot see a
 * caller who copies recalled text into an authorize() input, which is why recall
 * returns `advisory: true` text and nothing the kernel parses.
 */
const src = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUTHORIZATION_CODE = [
  'approval.ts', 'authority.ts', 'capability.ts', 'capability-graph.ts', 'risk.ts', 'supervisor.ts', 'waes.ts',
  'policy-snapshot.ts', 'identity/rbac.ts', 'runtime/authorization.ts', 'runtime/authorization-coordinator.ts',
]
const MEMORY_IMPORT = /from\s+['"][^'"]*(?:nqc\/memory|\.\/memory|nqc\/index)[^'"]*['"]/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? files(full) : [full]
  })
}

test('no authorization module imports memory', () => {
  for (const rel of AUTHORIZATION_CODE) {
    // A type-only import is erased at build time and carries no memory into the module.
    const text = readFileSync(join(src, rel), 'utf8').replace(/^import type [^\n]*$/gm, '')
    assert.ok(!MEMORY_IMPORT.test(text), `${rel} imports memory`)
  }
})

test('the list of authorization modules still exists', () => {
  const all = new Set(files(src).map((f) => relative(src, f).split('\\').join('/')))
  for (const rel of AUTHORIZATION_CODE) assert.ok(all.has(rel), `${rel} is listed but missing; update the list`)
})
