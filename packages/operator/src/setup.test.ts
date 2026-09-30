import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { memoryDir, migrateLegacyMemoryNamespace } from './setup.ts'

test('memory namespace: arbitrary person ids map injectively to contained directories', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qs-memory-ns-'))
  const ids = ['', 'a/b', 'a_b', '..', '../outside', 'entity-founder']
  const dirs = ids.map((id) => memoryDir(workspace, id))
  assert.equal(new Set(dirs).size, dirs.length)
  for (const dir of dirs) assert.ok(!relative(workspace, dir).split(sep).includes('..'), `${dir} must stay inside workspace`)
  assert.notEqual(memoryDir(workspace, ''), memoryDir(workspace, null))
  assert.equal(memoryDir(workspace, null), join(workspace, '.qs-memory'))
})

test('memory namespace: migrates an unambiguous legacy namespace without losing contents', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qs-memory-migrate-'))
  const legacy = join(workspace, '.qs-memory', 'entity-founder')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'memory.json'), '{"entries":[],"events":[]}')
  assert.equal(await migrateLegacyMemoryNamespace(workspace, 'entity-founder'), 'migrated')
  assert.equal(await readFile(join(memoryDir(workspace, 'entity-founder'), 'memory.json'), 'utf8'), '{"entries":[],"events":[]}')
  assert.equal(await migrateLegacyMemoryNamespace(workspace, 'entity-founder'), 'none')
})

test('memory namespace: refuses to guess ownership of a colliding legacy path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'qs-memory-ambiguous-'))
  const legacy = join(workspace, '.qs-memory', 'a_b')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'memory.json'), 'sensitive existing memory')
  assert.equal(await migrateLegacyMemoryNamespace(workspace, 'a/b'), 'manual-review-required')
  assert.equal(await readFile(join(legacy, 'memory.json'), 'utf8'), 'sensitive existing memory')
})
