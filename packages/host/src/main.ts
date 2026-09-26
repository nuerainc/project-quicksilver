/**
 * Quicksilver host process.
 *
 *   npm run host                      start the host (reads QUICKSILVER_HOST_CONFIG)
 *   npm run host -- check             validate config and environment, then exit
 *   npm run host -- run <workflow> ["question"]   run one workflow now (no server), print the result
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
 *   QUICKSILVER_SHADOW_STORE=sanity keeps shadow recommendations and Aura's verdict
 *     learner in Sanity (shadowRecommendation, auraVerdictLearner) instead of files.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { buildEvaluationRecord } from '@quicksilver/kernel'
import { AccessController } from '@quicksilver/kernel/identity'
import { principalsFromJson } from '@quicksilver/kernel/identity/tokens'
import { InMemoryWorkflowRunStore, type WorkflowRunStore } from '@quicksilver/kernel/runtime'

import { ConfigError, loadHostConfig, type HostConfig } from './config.ts'
import type { AgentRunner, EvaluationSink } from './handlers.ts'
import { QuicksilverHost } from './host.ts'
import { Logger, parseLogLevel } from './log.ts'
import { createSanityStoreClient, sanityConfigFromEnv } from './sanity-client.ts'
import { FileShadowStore, MemoryShadowStore, type ShadowApiDeps, type ShadowStore } from './shadow-api.ts'
import { SanityShadowStore } from './shadow-store-sanity.ts'
import { FileGenesisStore, MemoryGenesisStore, type GenesisApiDeps } from './genesis-api.ts'
import { SecretsVault, generateMasterKey } from './vault.ts'

/** Where the command was run from (npm sets INIT_CWD; workspace scripts run inside packages/host). */
const baseDir = process.env.INIT_CWD ?? process.cwd()

/**
 * Load `.env` files from the invocation directory up to the filesystem root,
 * nearest first. Real environment variables and nearer files win. Values are
 * never printed.
 */
function loadEnvFiles(startDir: string): string[] {
  const loaded: string[] = []
  let dir = resolve(startDir)
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
        if (!match || process.env[match[1]!] !== undefined) continue
        process.env[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, '$2')
      }
      loaded.push(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return loaded
}

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

/**
 * Aura intent stores: next to the run store for a file store, in memory otherwise.
 * QUICKSILVER_INTENT_PARSER=model uses the production parser: the model with the autonomy guard (needs a model provider).
 */
async function buildIntent(config: HostConfig, log: Logger) {
  const aura = await import('@quicksilver/aura')
  let graphs, ledger
  if (config.store.kind === 'file') {
    const dir = join(dirname(config.store.path), 'intent')
    graphs = new aura.FileIntentGraphStore(join(dir, 'graphs'))
    ledger = new aura.FileLedgerStore(join(dir, 'ledger'))
  } else {
    log.warn('intent graphs and the intent ledger are kept in memory; use a file store to keep them')
    graphs = new aura.MemoryIntentGraphStore()
    ledger = new aura.MemoryLedgerStore()
  }
  let parser: import('@quicksilver/aura').ObjectiveParser | undefined
  if (process.env.QUICKSILVER_INTENT_PARSER === 'model') {
    const agent = await import('@quicksilver/agent')
    const { parseObjectiveGuarded } = await import('@quicksilver/agent/intent')
    if (agent.isLlmConfigured()) parser = (text) => parseObjectiveGuarded(text)
    else log.warn('QUICKSILVER_INTENT_PARSER=model but no model provider is configured; using the rule-based parser')
  }
  return { graphs, ledger, ...(parser ? { parser } : {}) }
}

/**
 * Shadow mode (M4): the log and Aura's verdict learner sit next to the intent
 * graphs (<intent>/onboard/<intentId>/), where `npm run onboard` keeps them too.
 * QUICKSILVER_SHADOW_STORE=sanity keeps them in Sanity instead (one shadowRecommendation
 * per recommendation, one auraVerdictLearner per intent), through the same client
 * configuration as evaluation records; the legacy challenge project is refused.
 * The shadow-stage agent needs a model provider; without one, proposals are entered by hand.
 */
async function buildShadowStore(config: HostConfig, log: Logger): Promise<ShadowStore> {
  if ((process.env.QUICKSILVER_SHADOW_STORE ?? '').trim() === 'sanity') {
    const client = await createSanityStoreClient()
    if (!client) throw new Error('QUICKSILVER_SHADOW_STORE=sanity needs NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_AUTH_TOKEN.')
    log.info('shadow records are kept in Sanity')
    return new SanityShadowStore(client)
  }
  return config.store.kind === 'file'
    ? new FileShadowStore(join(dirname(config.store.path), 'intent', 'onboard'))
    : new MemoryShadowStore()
}

async function buildShadow(config: HostConfig, log: Logger, graphs: import('@quicksilver/aura').IntentGraphStore): Promise<ShadowApiDeps> {
  const store = await buildShadowStore(config, log)
  const agent = await import('@quicksilver/agent')
  if (!agent.isLlmConfigured()) {
    log.warn('no model provider is configured; shadow recommendations can only be entered by hand')
    return { store, graphs }
  }
  const { proposeShadowActions } = await import('@quicksilver/agent/shadow')
  return { store, graphs, generator: (ctx) => proposeShadowActions(ctx) }
}

/**
 * Genesis run (M5): the same run config and data/genesis/<runId>/ files as `npm run genesis`.
 * Config from QUICKSILVER_GENESIS_CONFIG (default deploy/genesis/genesis-500.json); data next to
 * the intent stores, or QUICKSILVER_GENESIS_DIR. Vault names come from the host's own vault.
 */
async function buildGenesis(config: HostConfig, log: Logger): Promise<GenesisApiDeps | undefined> {
  const configPath = resolve(baseDir, process.env.QUICKSILVER_GENESIS_CONFIG ?? 'deploy/genesis/genesis-500.json')
  if (!existsSync(configPath)) {
    log.info('no Genesis run config; the Genesis routes are off', { configPath })
    return undefined
  }
  const { validateGenesisConfig } = await import('@quicksilver/kernel/playbooks/genesis')
  const genesis = JSON.parse(readFileSync(configPath, 'utf8'))
  const errors = validateGenesisConfig(genesis)
  if (errors.length) {
    log.error('the Genesis run config is invalid; the Genesis routes are off', { configPath, errors })
    return undefined
  }
  const dir = process.env.QUICKSILVER_GENESIS_DIR
    ? resolve(baseDir, process.env.QUICKSILVER_GENESIS_DIR)
    : config.store.kind === 'file' ? join(dirname(config.store.path), 'genesis') : undefined
  if (!dir) log.warn('the Genesis ledger and experiments are kept in memory; use a file store or QUICKSILVER_GENESIS_DIR to keep them')
  if ((process.env.QUICKSILVER_GENESIS_STORE ?? 'file').trim() === 'sanity') {
    const { genesisStoresFromEnv, StoresGenesisAdapter } = await import('./genesis-store.ts')
    const stores = await genesisStoresFromEnv({ dir: dir ?? join(baseDir, 'data', 'genesis'), budgetUsd: genesis.budgetUsd })
    return { config: genesis, store: new StoresGenesisAdapter(stores) }
  }
  return { config: genesis, store: dir ? new FileGenesisStore(dir) : new MemoryGenesisStore() }
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
  // Throws for the legacy challenge project.
  const sanity = sanityConfigFromEnv()
  if (!sanity) {
    log.warn('Sanity is not configured; step evaluations are logged but not stored as evaluationRecord documents')
    return undefined
  }
  const { createClient } = await import('@sanity/client')
  const client = createClient({ ...sanity, useCdn: false })
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
  const envFiles = loadEnvFiles(baseDir)
  const configName = process.env.QUICKSILVER_HOST_CONFIG ?? 'quicksilver.host.json'
  const configPath = isAbsolute(configName) ? configName : resolve(baseDir, configName)
  const config = await loadHostConfig(configPath, { tenantId: process.env.QUICKSILVER_TENANT_ID?.trim() || 'default' })
  if (args[0] !== 'vault') console.error(`Config: ${configPath}${envFiles.length ? ` · env: ${envFiles.join(', ')}` : ''}`)
  if (args[0] === 'vault') return vaultCommand(config, args.slice(1))

  const log = new Logger({ level: parseLogLevel(process.env.QUICKSILVER_LOG_LEVEL ?? config.log.level) })
  const principals = principalsFromJson(process.env.QUICKSILVER_PRINCIPALS)
  const { store, close, ready } = await buildStore(config, log)
  const intent = await buildIntent(config, log)
  const host = new QuicksilverHost(config, {
    principals,
    store,
    logger: log,
    agentRunner: await buildAgentRunner(log),
    evaluationSink: await buildEvaluationSink(log),
    intent,
    shadow: await buildShadow(config, log, intent.graphs),
    genesis: await buildGenesis(config, log),
    ...(close ? { onStop: close } : {}),
    ...(ready ? { ready } : {}),
  })

  if (args[0] === 'run') {
    const workflowId = args[1]
    if (!workflowId || !(workflowId in config.workflows)) {
      throw new Error(`Usage: run <workflow> ["question"]. Configured workflows: ${Object.keys(config.workflows).join(', ') || 'none'}`)
    }
    const operator = { id: `cli:${userInfo().username.replace(/[^a-zA-Z0-9._-]/g, '_')}`, kind: 'human' as const, tenantId: config.tenantId, roles: ['operator'] }
    const scheduled = config.schedules.find((s) => s.workflow === workflowId)?.input
    const input = args[2] ? { question: args.slice(2).join(' ') } : (scheduled ?? null)
    const enq = await host.queue.enqueue({ graph: config.workflows[workflowId]!, input, tenantId: config.tenantId, trigger: { kind: 'manual', source: operator.id }, principal: operator, maxAttempts: 1 })
    if (!enq.accepted) throw new Error(`Run refused (${enq.code}): ${enq.reasons.join(' ')}`)
    const [finished] = await host.worker.drain()
    const run = finished ?? (await host.queue.get(enq.run.runId))
    // Print each agent step's output once (trigger and output nodes only echo other steps).
    const graph = config.workflows[workflowId]!
    const agentOutputs = Object.fromEntries(
      Object.entries(run?.result?.outputs ?? {}).filter(([nodeId]) => graph.nodes.find((n) => n.id === nodeId)?.kind === 'agent'),
    )
    console.log(JSON.stringify({ runId: run?.runId, status: run?.status, steps: run?.result?.steps, outputs: agentOutputs, error: run?.result?.error ?? run?.lastError }, null, 2))
    await close?.()
    process.exitCode = run?.status === 'completed' ? 0 : 1
    return
  }

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
