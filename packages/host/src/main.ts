/**
 * Quicksilver host process.
 *
 *   npm run host                      start the host (reads QUICKSILVER_HOST_CONFIG)
 *   npm run host -- check             validate config and environment, then exit
 *   npm run host -- vault keygen      print a new vault master key
 *   npm run host -- vault list        list secret names and versions
 *   npm run host -- vault put <name>  store or rotate a secret (value read from stdin)
 *
 * Environment:
 *   QUICKSILVER_HOST_CONFIG   path to the host config JSON (default ./quicksilver.host.json)
 *   QUICKSILVER_PRINCIPALS    bearer-token principals (same format as the web app)
 *   QUICKSILVER_VAULT_KEY     vault master key (name configurable in the config)
 *   DATABASE_URL              Postgres URL when store.kind is "postgres" (name configurable)
 *   Model provider and SANITY_CONTEXT_* variables enable the read-only query agent.
 *   NEXT_PUBLIC_SANITY_PROJECT_ID + SANITY_AUTH_TOKEN enable durable evaluation records.
 */
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'

import { buildEvaluationRecord } from '@quicksilver/kernel'
import { AccessController } from '@quicksilver/kernel/identity'
import { principalsFromJson } from '@quicksilver/kernel/identity/tokens'
import { InMemoryWorkflowRunStore, type WorkflowRunStore } from '@quicksilver/kernel/runtime'

import { ConfigError, loadHostConfig, type HostConfig } from './config.ts'
import type { AgentRunner, EvaluationSink } from './handlers.ts'
import { QuicksilverHost } from './host.ts'
import { Logger, parseLogLevel } from './log.ts'
import { SecretsVault, generateMasterKey } from './vault.ts'

const LEGACY_CHALLENGE_PROJECT_ID = 'd280bqjc'

async function buildStore(config: HostConfig, log: Logger): Promise<{ store: WorkflowRunStore; close?: () => Promise<void>; ready?: () => Promise<boolean> }> {
  if (config.store.kind === 'memory') {
    log.warn('using the in-memory run store; runs are lost on restart')
    return { store: new InMemoryWorkflowRunStore() }
  }
  if (config.store.kind === 'file') {
    const { FileWorkflowRunStore } = await import('@quicksilver/kernel/runtime/file-store')
    return { store: await FileWorkflowRunStore.open(config.store.path) }
  }
  const url = process.env[config.store.urlEnv]
  if (!url) throw new Error(`store.kind is "postgres" but ${config.store.urlEnv} is not set.`)
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url, max: 10 })
  const { PostgresWorkflowRunStore } = await import('@quicksilver/kernel/runtime/postgres')
  const store = new PostgresWorkflowRunStore(pool, config.store.tablePrefix ? { prefix: config.store.tablePrefix } : {})
  await store.migrate()
  return {
    store,
    close: () => pool.end(),
    ready: async () => { await pool.query('select 1'); return true },
  }
}

async function buildAgentRunner(log: Logger): Promise<AgentRunner | undefined> {
  if (!process.env.SANITY_CONTEXT_MCP_URL || !process.env.SANITY_CONTEXT_TOKEN) {
    log.warn('Sanity Context MCP is not configured; agent steps will fail closed')
    return undefined
  }
  const agent = await import('@quicksilver/agent')
  try {
    agent.readEnvMcpConfig()
  } catch (error) {
    log.error('Context MCP configuration refused; agent steps will fail closed', { error: (error as Error).message })
    return undefined
  }
  if (!agent.isLlmConfigured()) {
    log.warn('no model provider is configured; agent steps will fail closed')
    return undefined
  }
  return async ({ input, impact, signal }) => {
    const run = await agent.executeGovernedAgent(agent.queryQuicksilverAgent, {
      agentId: agent.queryQuicksilverAgent.id,
      taskType: 'reasoning',
      input,
      impactLevel: impact,
      ...(signal ? { signal } : {}),
    })
    const out = run.output
    return {
      output: { question: out.question, entities: out.entities, capabilities: out.capabilities, policies: out.policies, supportingContext: out.supportingContext },
      modelId: run.modelId,
      evaluation: run.evaluation,
    }
  }
}

async function buildEvaluationSink(log: Logger): Promise<EvaluationSink | undefined> {
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  const token = process.env.SANITY_AUTH_TOKEN
  if (!projectId || !token) {
    log.warn('Sanity is not configured; step evaluations are logged but not stored as evaluationRecord documents')
    return undefined
  }
  if (projectId === LEGACY_CHALLENGE_PROJECT_ID) throw new Error('The legacy challenge Sanity project is blocked. Configure the dedicated Nuera Quicksilver project.')
  const { createClient } = await import('@sanity/client')
  const client = createClient({
    projectId,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production',
    apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? '2024-10-01',
    useCdn: false,
    token,
  })
  return async (entries) => {
    const now = new Date().toISOString()
    const docs = entries.map((e) => buildEvaluationRecord({
      id: `evaluation-host-run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      now,
      source: 'workflow-run',
      agentId: e.agentId,
      taskType: 'reasoning',
      modelId: e.modelId,
      subject: e.subject,
      requestedBy: e.requestedBy,
      evaluation: e.evaluation,
      runId: e.runId,
      nodeId: e.nodeId,
    }))
    const tx = client.transaction()
    for (const doc of docs) tx.create(doc)
    await tx.commit()
    return { persisted: true, ids: docs.map((d) => d._id) }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function vaultCommand(config: HostConfig, args: string[]): Promise<void> {
  if (!config.vault) throw new Error('No vault is configured in the host config.')
  const masterKey = process.env[config.vault.keyEnv]
  if (!masterKey) throw new Error(`${config.vault.keyEnv} is not set.`)
  // Whoever holds the key and the file controls the vault; the CLI acts as a
  // named tenant admin so every change is attributed in the audit log.
  const admin = { id: `cli:${userInfo().username.replace(/[^a-zA-Z0-9._-]/g, '_')}`, kind: 'human' as const, tenantId: config.tenantId, roles: ['tenant-admin'] }
  const log = new Logger({ bindings: { service: 'quicksilver-vault-cli' } })
  const vault = new SecretsVault({ path: config.vault.path, masterKey, tenantId: config.tenantId, access: new AccessController(), audit: (e) => log.info('vault access', { ...e }) })
  await vault.open()
  const [op, name] = args
  if (op === 'list') {
    for (const s of await vault.list(admin)) console.log(`${s.name}\tv${s.activeVersion}\t${s.disabled ? 'disabled' : 'active'}\t${s.versions.length} version(s)`)
  } else if (op === 'put' && name) {
    const value = await readStdin()
    const meta = await vault.put(admin, name, value)
    console.log(`Stored ${meta.name} v${meta.activeVersion}. Restart the host or call POST /api/admin/reload-secrets to use it.`)
  } else if (op === 'disable' && name) {
    await vault.disable(admin, name)
    console.log(`Disabled ${name}.`)
  } else {
    throw new Error('Usage: vault keygen | vault list | vault put <name> (value on stdin) | vault disable <name>')
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === 'vault' && args[1] === 'keygen') {
    console.log(generateMasterKey())
    return
  }
  const configPath = process.env.QUICKSILVER_HOST_CONFIG ?? 'quicksilver.host.json'
  const config = await loadHostConfig(configPath)
  if (args[0] === 'vault') return vaultCommand(config, args.slice(1))

  const log = new Logger({ level: parseLogLevel(process.env.QUICKSILVER_LOG_LEVEL ?? config.log.level) })
  const principals = principalsFromJson(process.env.QUICKSILVER_PRINCIPALS)
  const { store, close, ready } = await buildStore(config, log)
  const host = new QuicksilverHost(config, {
    principals,
    store,
    logger: log,
    agentRunner: await buildAgentRunner(log),
    evaluationSink: await buildEvaluationSink(log),
    ...(close ? { onStop: close } : {}),
    ...(ready ? { ready } : {}),
  })

  if (args[0] === 'check') {
    await host.vault?.open()
    console.log(`Config OK: tenant ${config.tenantId}, ${Object.keys(config.workflows).length} workflow(s), ${config.schedules.length} schedule(s), ${config.webhooks.length} webhook(s), ${principals.length} principal(s), store ${config.store.kind}.`)
    await close?.()
    return
  }

  await host.start()
  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) {
      log.warn('second signal; aborting in-flight runs', { signal })
      void host.stop({ abort: true }).finally(() => process.exit(1))
      return
    }
    stopping = true
    log.info('shutdown requested', { signal })
    const timer = setTimeout(() => {
      log.error('graceful shutdown timed out; aborting in-flight runs')
      void host.stop({ abort: true }).finally(() => process.exit(1))
    }, 60_000)
    timer.unref()
    void host.stop().then(() => process.exit(0), () => process.exit(1))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  if (error instanceof ConfigError) console.error(error.message)
  else console.error(`Host failed to start: ${(error as Error).message}`)
  process.exit(1)
})
