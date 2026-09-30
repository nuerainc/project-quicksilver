/** Onboard CLI parity smoke tests against the same durable Aura intent model. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FileIntentGraphStore, MemoryLedgerStore } from '@quicksilver/aura'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const cli = join(here, 'onboard-cli.ts')

test('Onboard CLI creates and updates the same durable human-specified intent state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-onboard-cli-'))
  const env = { ...process.env, INIT_CWD: repo, QUICKSILVER_INTENT_DIR: join(dir, 'intent'), QUICKSILVER_ONBOARD_ACTOR: 'entity-founder', QUICKSILVER_TENANT_ID: 'nuera' }
  const run = async (...args: string[]) => exec(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd: repo, env })
  const credentials = generateToken()
  const founder: TokenPrincipalConfig = { id: 'entity-founder', kind: 'human', tenantId: 'nuera', roles: ['intent-provider', 'viewer'], tokenDigest: credentials.tokenDigest }
  const host = new QuicksilverHost(parseHostConfig({ tenantId: 'nuera', http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    intent: { graphs: new FileIntentGraphStore(join(dir, 'intent', 'graphs')), ledger: new MemoryLedgerStore() },
  })
  try {
    const { port } = await host.start()
    const apiRead = async (id: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/intents/${id}`, { headers: { authorization: `Bearer ${credentials.token}` } })
      return { status: response.status, body: await response.json() as { graph?: { objective: string; variables: Array<{ id: string; provenance: string; sources: Array<{ ref: string }> }> } } }
    }
    const created = await run('start', 'We run a feed store and need help understanding our margins.')
    const id = /Intent (intent-[a-z0-9]+)/.exec(created.stdout)?.[1]
    assert.ok(id, created.stdout)
    const createdThroughApi = await apiRead(id)
    assert.equal(createdThroughApi.status, 200)
    assert.equal(createdThroughApi.body.graph?.objective, 'We run a feed store and need help understanding our margins.')
    const variableId = /^\s+\? ([a-z][a-z0-9_]*)/m.exec(created.stdout)?.[1]
    assert.ok(variableId, 'new intent should ask at least one real question')
    const answer = await run('answer', id, variableId, 'Books and point-of-sale system')
    assert.match(answer.stdout, new RegExp(`Recorded your answer for ${variableId}`))
    const answeredThroughApi = await apiRead(id)
    assert.equal(answeredThroughApi.body.graph?.variables.find((variable) => variable.id === variableId)?.provenance, 'HUMAN_SPECIFIED')
    assert.equal(answeredThroughApi.body.graph?.variables.find((variable) => variable.id === variableId)?.sources[0]?.ref, 'entity-founder')
    const status = await run('status', id)
    assert.match(status.stdout, new RegExp(`Intent ${id}: We run a feed store`))
    assert.doesNotMatch(status.stdout, new RegExp(`\\? ${variableId}:`), 'answered questions must no longer be presented as open')
  } finally {
    await host.stop({ abort: true })
    await rm(dir, { recursive: true, force: true })
  }
})
