/** Genesis CLI contract tests for manual reviews and append-only persistence. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'
import { parseHostConfig } from './config.ts'
import { FileGenesisStore } from './genesis-api.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const cli = join(here, 'genesis-cli.ts')

test('Genesis CLI records a manual content review against the exact text and reads it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-genesis-cli-'))
  const config = JSON.parse(await readFile(join(repo, 'deploy', 'genesis', 'genesis-500.json'), 'utf8')) as GenesisRunConfig
  const configPath = join(dir, 'genesis.json')
  const sharedConfig = { ...config, prerequisites: { entityApproved: true, paymentAccounts: ['genesis-card'] } }
  await writeFile(configPath, JSON.stringify(sharedConfig))
  const env = {
    ...process.env,
    INIT_CWD: repo,
    QUICKSILVER_GENESIS_CONFIG: configPath,
    QUICKSILVER_GENESIS_DIR: join(dir, 'data'),
    QUICKSILVER_GENESIS_STORE: 'file',
    QUICKSILVER_GENESIS_ACTOR: 'entity-founder',
    QUICKSILVER_HOST_CONFIG: join(dir, 'no-host.json'),
  }
  const credentials = generateToken()
  const founder: TokenPrincipalConfig = { id: 'entity-founder', kind: 'human', tenantId: 'nuera', roles: ['intent-provider', 'viewer'], tokenDigest: credentials.tokenDigest }
  const host = new QuicksilverHost(parseHostConfig({ tenantId: 'nuera', http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    genesis: { config: sharedConfig, store: new FileGenesisStore(join(dir, 'data')), vaultNames: async () => ['genesis-card'] },
  })
  const run = async (...args: string[]) => exec(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd: repo, env })
  try {
    const { port } = await host.start()
    const text = 'Send a weekly margin report to the feed store owner.'
    const reviewed = await run('review', text, '--channel', 'email', 'pass', 'Reviewed by the founder.')
    assert.match(reviewed.stdout, /Manual founder review — not a WAES evaluation/)
    assert.match(reviewed.stdout, /Nothing was sent or published\./)
    const listed = await run('reviews')
    assert.match(listed.stdout, /PASS\s+MANUAL FOUNDER REVIEW/)
    assert.match(listed.stdout, /email/)
    assert.match(listed.stdout, /Reviewed by the founder/)
    const records = await run('check-content', text, '--proposer', 'agent-genesis')
    assert.match(records.stdout, /Latest review of this exact text: pass/)
    const raw = await readFile(join(dir, 'data', 'default', config.runId as string, 'reviews.json'), 'utf8').catch(() => '')
    assert.equal(raw.includes(text), true, 'review record persists the exact reviewed text')
    const readResponse = await fetch(`http://127.0.0.1:${port}/api/genesis`, { headers: { authorization: `Bearer ${credentials.token}` } })
    const readBody = await readResponse.json() as { reviews: Array<{ text: string; reviewer: string; kind: string }> }
    assert.equal(readResponse.status, 200)
    assert.equal(readBody.reviews[0]?.text, text, 'HTTP reads the review appended by the CLI from the same store')
    assert.equal(readBody.reviews[0]?.reviewer, 'entity-founder')
    const apiText = 'API and CLI share the append-only Genesis review store.'
    const apiWrite = await fetch(`http://127.0.0.1:${port}/api/genesis/reviews`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: apiText, channel: 'email', verdict: 'revise' }),
    })
    assert.equal(apiWrite.status, 201)
    assert.match((await run('reviews')).stdout, /API and CLI share the append-only Genesis review store/)
  } finally {
    await host.stop({ abort: true })
    await rm(dir, { recursive: true, force: true })
  }
})
