import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

import { AccessController, type AccessDecision, type Principal } from '@quicksilver/kernel/identity'
import { StaticTokenIdentityProvider, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import {
  InMemoryWorkflowRunStore,
  WorkflowRunQueue,
  WorkflowRunWorker,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowRunStore,
} from '@quicksilver/kernel/runtime'
import { CronScheduler, WebhookTrigger } from '@quicksilver/kernel/triggers'

import { checkWorkflow, type HostConfig } from './config.ts'
import { createHandlerFactory, type AgentRunner, type EvaluationSink } from './handlers.ts'
import { Logger, redactValue } from './log.ts'
import { createHostMetrics, type HostMetrics } from './metrics.ts'
import { SecretsVault, VaultError } from './vault.ts'
import { handleIntentRoute, type IntentApiDeps } from './intent-api.ts'
import { handleShadowRoute, type ShadowApiDeps } from './shadow-api.ts'
import { handleGenesisRoute, type GenesisApiDeps } from './genesis-api.ts'
import { handleDecisionRoute, type DecisionApiDeps } from './decisions-api.ts'

/**
 * The single-tenant Quicksilver host: one process that runs the governed
 * worker pool, cron schedules, signed webhooks, a management API, the secrets
 * vault, structured logs and Prometheus metrics.
 *
 * Authority stays with the kernel. The host only wires existing, tested
 * components together and adds authentication, limits and observability.
 */

export interface HostDependencies {
  /** Human and service principals with bearer tokens (from `QUICKSILVER_PRINCIPALS`). */
  principals?: readonly TokenPrincipalConfig[]
  /** A run store; defaults from `config.store` are built by `main.ts`. In-memory when omitted. */
  store?: WorkflowRunStore
  /** Environment for `env:` secret references and the vault key. */
  env?: Record<string, string | undefined>
  agentRunner?: AgentRunner
  evaluationSink?: EvaluationSink
  logger?: Logger
  now?: () => number
  /** Scheduler tick interval (default 30 s). */
  schedulerTickMs?: number
  /** Called during `stop()` after everything else, e.g. to close a database pool. */
  onStop?: () => Promise<void> | void
  /** Store readiness probe; defaults to listing running runs. */
  ready?: () => Promise<boolean>
  /** Aura intent entry point and ledger (M3). Routes return 404 when absent. */
  intent?: IntentApiDeps
  /** Shadow mode for the Onboard pilot (M4). Routes return 404 when absent. */
  shadow?: ShadowApiDeps
  /** Genesis run (M5): records and evaluates only. Routes return 404 when absent. */
  genesis?: GenesisApiDeps
  /** Aura decision journal: decisions the provider logs, plus judged shadow verdicts. Routes return 404 when absent. */
  decisions?: DecisionApiDeps
}

const CONSOLE_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
}
let consoleHtml: string | undefined
function consolePage(): string {
  consoleHtml ??= readFileSync(new URL('./console.html', import.meta.url), 'utf8')
  return consoleHtml
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = ['queued', 'running', 'completed', 'blocked', 'cancelled', 'dead-lettered']
const HOST_PRINCIPAL_ID = 'svc:quicksilver-host'

export class QuicksilverHost {
  readonly config: HostConfig
  readonly log: Logger
  readonly metrics: HostMetrics
  readonly access: AccessController
  readonly queue: WorkflowRunQueue
  readonly worker: WorkflowRunWorker
  readonly scheduler: CronScheduler
  readonly vault?: SecretsVault
  webhooks?: WebhookTrigger
  private readonly identity: StaticTokenIdentityProvider
  private readonly deps: HostDependencies
  private readonly hostPrincipal: Principal
  private server?: Server
  private started = false

  constructor(config: HostConfig, deps: HostDependencies = {}) {
    this.config = config
    this.deps = deps
    this.log = (deps.logger ?? new Logger({ level: config.log.level })).child({ service: 'quicksilver-host', tenantId: config.tenantId })
    this.metrics = createHostMetrics()

    // Single tenant: refuse any principal outside it.
    const principals = deps.principals ?? []
    const foreign = principals.filter((p) => p.tenantId !== config.tenantId)
    if (foreign.length) throw new Error(`Principals ${foreign.map((p) => p.id).join(', ')} belong to another tenant; this host serves "${config.tenantId}" only.`)
    this.identity = new StaticTokenIdentityProvider(principals)

    this.access = new AccessController({
      customRoles: [{ id: 'host-runtime', tenantId: config.tenantId, description: 'The host process: resolve secrets for triggers.', permissions: ['secret:use'] }],
      audit: (decision) => this.onAccessDecision(decision),
      ...(deps.now ? { now: deps.now } : {}),
    })
    this.hostPrincipal = { id: HOST_PRINCIPAL_ID, kind: 'service', tenantId: config.tenantId, roles: ['host-runtime'] }

    const store = deps.store ?? new InMemoryWorkflowRunStore()
    this.queue = new WorkflowRunQueue({ store, access: this.access, ...config.queue, ...(deps.now ? { now: deps.now } : {}) })
    this.worker = new WorkflowRunWorker({
      queue: this.queue,
      workerId: config.worker.id,
      concurrency: config.worker.concurrency,
      pollIntervalMs: config.worker.pollIntervalMs,
      execution: { maxConcurrentAgents: Math.min(3, config.execution.maxAgentSteps) },
      resolveHandlers: createHandlerFactory({
        agentRunner: deps.agentRunner,
        evaluationSink: deps.evaluationSink,
        execution: config.execution,
        log: this.log,
        metrics: this.metrics,
      }),
      onRunFinished: (run) => this.onRunFinished(run),
    })
    this.scheduler = new CronScheduler({
      queue: this.queue,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.schedulerTickMs ? { tickIntervalMs: deps.schedulerTickMs } : {}),
      onTick: (results) => {
        for (const r of results) {
          const outcome = r.result.accepted ? (r.result.deduplicated ? 'deduplicated' : 'enqueued') : r.result.code
          this.metrics.scheduleEnqueues.inc({ schedule: r.scheduleId, outcome })
          const fields = { scheduleId: r.scheduleId, slot: new Date(r.slot).toISOString(), outcome, ...(r.result.accepted ? { runId: r.result.run.runId } : { reasons: r.result.reasons }) }
          if (r.result.accepted) this.log.info('schedule slot enqueued', fields)
          else this.log.warn('schedule slot refused', fields)
        }
      },
    })
    const services = new Map(config.services.map((s) => [s.id, { id: s.id, kind: 'service' as const, tenantId: config.tenantId, roles: s.roles }]))
    for (const sc of config.schedules) {
      this.scheduler.add({
        id: sc.id,
        tenantId: config.tenantId,
        cron: sc.cron,
        graph: config.workflows[sc.workflow]!,
        ...(sc.input !== undefined ? { input: sc.input } : {}),
        principal: services.get(sc.principal)!,
        ...(sc.priority !== undefined ? { priority: sc.priority } : {}),
        enabled: sc.enabled !== false,
      })
    }

    if (config.vault) {
      const masterKey = (deps.env ?? process.env)[config.vault.keyEnv]
      if (!masterKey) throw new Error(`The vault is configured but ${config.vault.keyEnv} is not set.`)
      this.vault = new SecretsVault({
        path: config.vault.path,
        masterKey,
        tenantId: config.tenantId,
        access: this.access,
        ...(deps.now ? { now: deps.now } : {}),
        audit: (event) => {
          this.metrics.vaultAccess.inc({ operation: event.operation, outcome: event.allowed ? 'allowed' : 'denied' })
          this.log[event.allowed ? 'info' : 'warn']('vault access', { ...event })
        },
      })
    }
  }

  /** Open the vault, resolve webhook secrets, start the worker, scheduler and HTTP server. */
  async start(): Promise<{ port: number }> {
    if (this.started) throw new Error('Host already started.')
    await this.vault?.open()
    const services = new Map(this.config.services.map((s) => [s.id, { id: s.id, kind: 'service' as const, tenantId: this.config.tenantId, roles: s.roles }]))
    const endpoints = []
    for (const wh of this.config.webhooks) {
      endpoints.push({
        id: wh.id,
        tenantId: this.config.tenantId,
        graph: this.config.workflows[wh.workflow]!,
        secrets: await this.resolveSecret(wh.secret),
        principal: services.get(wh.principal)!,
        ...(wh.priority !== undefined ? { priority: wh.priority } : {}),
        ...(wh.maxBodyBytes !== undefined ? { maxBodyBytes: wh.maxBodyBytes } : {}),
        enabled: wh.enabled !== false,
      })
    }
    this.webhooks = new WebhookTrigger({ queue: this.queue, endpoints, ...(this.deps.now ? { now: this.deps.now } : {}) })

    this.metrics.registry.onCollect(async () => {
      const stats = await this.queue.stats()
      for (const status of RUN_STATUSES) this.metrics.queueRuns.set({ status }, stats.byStatus[status] ?? 0)
    })
    this.metrics.up.set({}, 1)

    this.server = createServer((req, res) => void this.handle(req, res))
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 15_000
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.config.http.port, this.config.http.host, () => resolve())
    })
    this.worker.start()
    this.scheduler.start()
    this.started = true
    const port = (this.server.address() as AddressInfo).port
    this.log.info('host started', {
      port,
      workerId: this.config.worker.id,
      concurrency: this.config.worker.concurrency,
      schedules: this.config.schedules.length,
      webhooks: this.config.webhooks.length,
      workflows: Object.keys(this.config.workflows).length,
      agents: this.deps.agentRunner ? 'configured' : 'not configured',
      vault: this.vault ? 'open' : 'off',
    })
    return { port }
  }

  /** Graceful shutdown: stop intake, stop scheduling, drain in-flight runs (or abort them). */
  async stop(options: { abort?: boolean } = {}): Promise<void> {
    if (!this.started) return
    this.started = false
    this.log.info('host stopping', { abort: options.abort === true })
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server?.closeAllConnections?.()
    await this.scheduler.stop()
    await this.worker.stop({ abort: options.abort })
    this.metrics.up.set({}, 0)
    await this.deps.onStop?.()
    this.log.info('host stopped')
  }

  /** Re-read webhook secrets (after a rotation). Requires `tenant:admin`. */
  async reloadWebhookSecrets(): Promise<string[]> {
    const reloaded: string[] = []
    for (const wh of this.config.webhooks) {
      this.webhooks?.setSecrets(wh.id, await this.resolveSecret(wh.secret))
      reloaded.push(wh.id)
    }
    this.log.info('webhook secrets reloaded', { endpoints: reloaded })
    return reloaded
  }

  private async resolveSecret(ref: string): Promise<string[]> {
    if (ref.startsWith('env:')) {
      const name = ref.slice(4)
      const env = this.deps.env ?? process.env
      const values = [env[name], env[`${name}_PREVIOUS`]].filter((v): v is string => typeof v === 'string' && v.length > 0)
      if (!values.length) throw new Error(`Secret reference ${ref}: ${name} is not set.`)
      values.forEach(redactValue)
      return values
    }
    if (!this.vault) throw new Error(`Secret reference ${ref} needs a vault.`)
    const values = await this.vault.useAll(this.hostPrincipal, ref.slice(6))
    values.forEach(redactValue)
    return values
  }

  private onRunFinished(run: WorkflowRunRecord): void {
    this.metrics.runsFinished.inc({ status: run.status, workflow: run.workflowId })
    this.metrics.runDuration.observe({ workflow: run.workflowId }, Math.max(0, (run.updatedAt - run.createdAt) / 1000))
    const fields = { runId: run.runId, workflowId: run.workflowId, status: run.status, attempt: run.attempt, trigger: run.trigger, requestedBy: run.requestedBy, ...(run.lastError ? { error: run.lastError } : {}) }
    if (run.status === 'completed') this.log.info('run finished', fields)
    else this.log.warn('run finished', fields)
  }

  private onAccessDecision(decision: AccessDecision): void {
    if (decision.allowed) this.log.debug('access allowed', { permission: decision.permission, principalId: decision.principalId, resourceId: decision.resourceId })
    else this.log.warn('access denied', { permission: decision.permission, principalId: decision.principalId, resourceId: decision.resourceId, reasons: decision.reasons })
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://host.local')
    const route = routeLabel(req.method ?? 'GET', url.pathname)
    let status = 500
    try {
      const out = await this.dispatch(req, url)
      status = out.status
      res.writeHead(status, {
        'content-type': out.contentType ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(out.headers ?? {}),
      })
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
    } catch (error) {
      this.log.error('request failed', { route, error: (error as Error).message })
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Internal error.' }))
    } finally {
      this.metrics.httpRequests.inc({ route, status: String(status) })
      if (route !== 'GET /healthz' && route !== 'GET /metrics') this.log.debug('http request', { route, status, ms: Date.now() - started })
    }
  }

  private async dispatch(req: IncomingMessage, url: URL): Promise<{ status: number; body: unknown; contentType?: string; headers?: Record<string, string> }> {
    const method = req.method ?? 'GET'
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const parts = path.split('/').filter(Boolean)

    if (method === 'GET' && path === '/healthz') return { status: 200, body: { status: 'ok' } }
    if (method === 'GET' && path === '/readyz') {
      const ready = await (this.deps.ready ?? (async () => { await this.queue.store.list({ status: 'running' }); return true }))().catch(() => false)
      return ready && this.started ? { status: 200, body: { status: 'ready' } } : { status: 503, body: { status: 'not ready' } }
    }
    if (method === 'GET' && path === '/metrics') {
      if (!this.config.http.metricsPublic) {
        const denied = this.require(req, 'audit:read')
        if (denied) return denied
      }
      return { status: 200, body: await this.metrics.registry.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' }
    }

    if (parts[0] === 'webhooks' && parts.length === 2) {
      if (method !== 'POST') return { status: 405, body: { accepted: false, error: 'Use POST.' } }
      const raw = await readBody(req, Math.max(this.config.http.maxBodyBytes, 262_144))
      if (raw === undefined) return this.webhookResult(parts[1]!, { status: 413, body: { accepted: false, error: 'Body too large.' } })
      const outcome = await this.webhooks!.receive(parts[1]!, { get: (name) => headerValue(req, name) }, raw)
      return this.webhookResult(parts[1]!, outcome)
    }

    // The console page (M3 web entry point). It holds no data: it calls the API with the viewer's own token.
    if (method === 'GET' && (path === '/' || path === '/console') && this.deps.intent) {
      return { status: 200, body: consolePage(), contentType: 'text/html; charset=utf-8', headers: CONSOLE_HEADERS }
    }

    if (parts[0] !== 'api') return { status: 404, body: { error: 'Not found.' } }
    const principal = this.authenticate(req)
    if (!principal) return { status: 401, body: { error: 'A valid bearer token is required.' } }
    const tenant = { tenantId: this.config.tenantId }

    // GET /api/whoami
    if (method === 'GET' && path === '/api/whoami') return { status: 200, body: { id: principal.id, kind: principal.kind, tenantId: principal.tenantId, roles: principal.roles } }

    // Aura intents and the intent ledger
    if ((parts[1] === 'intents' || parts[1] === 'intent-ledger') && this.deps.intent) {
      const handled = await handleIntentRoute({
        method, parts, principal, tenantId: this.config.tenantId, access: this.access,
        readBody: () => readJson(req, this.config.http.maxBodyBytes),
      }, { ...this.deps.intent, ...(this.deps.now ? { now: this.deps.now } : {}) })
      if (handled) return handled
    }

    // Shadow mode (M4)
    if (parts[1] === 'shadow' && this.deps.shadow) {
      const handled = await handleShadowRoute({
        method, parts, principal, tenantId: this.config.tenantId, access: this.access,
        readBody: () => readJson(req, this.config.http.maxBodyBytes),
      }, { ...this.deps.shadow, ...(this.deps.now ? { now: this.deps.now } : {}) })
      if (handled) return handled
    }

    // Aura decision journal
    if (parts[1] === 'decisions' && this.deps.decisions) {
      const handled = await handleDecisionRoute({
        method, parts, query: url.searchParams, principal, tenantId: this.config.tenantId, access: this.access,
        readBody: () => readJson(req, this.config.http.maxBodyBytes),
      }, { ...this.deps.decisions, ...(this.deps.now ? { now: this.deps.now } : {}) })
      if (handled) return handled
    }

    // Genesis run (M5): records and evaluates; never moves money
    if (parts[1] === 'genesis' && this.deps.genesis) {
      const vault = this.vault
      const handled = await handleGenesisRoute({
        method, parts, principal, tenantId: this.config.tenantId, access: this.access,
        readBody: () => readJson(req, this.config.http.maxBodyBytes),
      }, {
        ...(vault ? { vaultNames: async () => (await vault.list(this.hostPrincipal)).filter((s) => !s.disabled).map((s) => s.name) } : {}),
        ...this.deps.genesis,
        ...(this.deps.now ? { now: this.deps.now } : {}),
      })
      if (handled) return handled
    }

    // Runs
    if (path === '/api/runs' && method === 'GET') {
      const denied = this.authorize(principal, 'run:read')
      if (denied) return denied
      const statusParam = url.searchParams.get('status')
      if (statusParam && !RUN_STATUSES.includes(statusParam as WorkflowRunStatus)) return { status: 400, body: { error: 'Unknown status.' } }
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
      const runs = (await this.queue.store.list({ tenantId: this.config.tenantId, ...(statusParam ? { status: statusParam as WorkflowRunStatus } : {}), ...(url.searchParams.get('workflow') ? { workflowId: url.searchParams.get('workflow')! } : {}) }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
      return { status: 200, body: { runs: runs.map(summarize) } }
    }
    if (path === '/api/runs' && method === 'POST') {
      const body = await readJson(req, this.config.http.maxBodyBytes)
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const { workflow, input, idempotencyKey, priority } = body.value as Record<string, unknown>
      if (typeof workflow !== 'string' || !(workflow in this.config.workflows)) return { status: 422, body: { error: 'workflow must name a configured workflow.' } }
      const graph = this.config.workflows[workflow]!
      const issues = checkWorkflow(graph, this.config.execution)
      if (issues.length) return { status: 422, body: { error: 'Workflow violates the host execution policy.', issues } }
      const result = await this.queue.enqueue({
        graph,
        input: input ?? null,
        tenantId: this.config.tenantId,
        trigger: { kind: 'api', source: principal.id },
        principal,
        ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
        ...(typeof priority === 'number' ? { priority } : {}),
      })
      if (result.accepted) return { status: result.deduplicated ? 200 : 202, body: { runId: result.run.runId, deduplicated: result.deduplicated, status: result.run.status } }
      const code = { forbidden: 403, backpressure: 429, 'invalid-graph': 422, 'invalid-request': 400 }[result.code]
      return { status: code, body: { error: result.reasons.join(' '), code: result.code } }
    }
    if (parts[1] === 'runs' && parts.length === 3 && method === 'GET') {
      const denied = this.authorize(principal, 'run:read')
      if (denied) return denied
      const run = await this.queue.get(parts[2]!)
      if (!run || run.tenantId !== this.config.tenantId) return { status: 404, body: { error: 'Run not found.' } }
      return { status: 200, body: { run: { ...summarize(run), input: run.input, result: run.result, graphDigest: run.graphDigest }, events: await this.queue.store.events(run.runId) } }
    }
    if (parts[1] === 'runs' && parts.length === 4 && method === 'POST' && (parts[3] === 'cancel' || parts[3] === 'redrive')) {
      const body = await readJson(req, 16_384)
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const reason = (body.value as { reason?: unknown }).reason
      const run = await this.queue.get(parts[2]!)
      if (!run || run.tenantId !== this.config.tenantId) return { status: 404, body: { error: 'Run not found.' } }
      try {
        if (parts[3] === 'cancel') {
          const updated = await this.queue.cancel(run.runId, principal, typeof reason === 'string' && reason.trim() ? reason.slice(0, 500) : 'Cancelled through the host API.')
          return { status: 200, body: { run: updated ? summarize(updated) : null } }
        }
        if (typeof reason !== 'string' || reason.trim().length < 10) return { status: 400, body: { error: 'A redrive needs a reason of at least 10 characters.' } }
        const updated = await this.queue.redrive(run.runId, principal, reason.slice(0, 500))
        return { status: 200, body: { run: summarize(updated) } }
      } catch (error) {
        const denied = (error as Error).name === 'AccessDeniedError'
        return { status: denied ? 403 : 409, body: { error: (error as Error).message } }
      }
    }
    if (path === '/api/dead-letters' && method === 'GET') {
      const denied = this.authorize(principal, 'run:read')
      if (denied) return denied
      return { status: 200, body: { runs: (await this.queue.deadLetters(this.config.tenantId)).map(summarize) } }
    }
    if (path === '/api/stats' && method === 'GET') {
      const denied = this.authorize(principal, 'run:read')
      if (denied) return denied
      const stats = await this.queue.stats()
      return { status: 200, body: { byStatus: stats.byStatus, tenant: stats.byTenant[this.config.tenantId] ?? {} } }
    }
    if (path === '/api/schedules' && method === 'GET') {
      const denied = this.authorize(principal, 'run:read')
      if (denied) return denied
      return { status: 200, body: { schedules: this.scheduler.list().map((s) => ({ ...s, nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null })) } }
    }
    if (path === '/api/webhooks' && method === 'GET') {
      const denied = this.authorize(principal, 'run:read')
      if (denied) return denied
      return { status: 200, body: { webhooks: this.webhooks?.list() ?? [] } }
    }
    if (path === '/api/workflows' && method === 'GET') {
      const denied = this.authorize(principal, 'workflow:read')
      if (denied) return denied
      return { status: 200, body: { workflows: Object.entries(this.config.workflows).map(([id, g]) => ({ id, graphId: g.id, version: g.version, nodes: g.nodes.length })) } }
    }

    // Secrets (metadata and writes only; values are never returned by the API)
    if (path === '/api/secrets' && method === 'GET') {
      if (!this.vault) return { status: 404, body: { error: 'No vault is configured.' } }
      return this.vaultCall(() => this.vault!.list(principal).then((secrets) => ({ secrets })))
    }
    if (parts[1] === 'secrets' && parts.length === 3 && method === 'PUT') {
      if (!this.vault) return { status: 404, body: { error: 'No vault is configured.' } }
      const body = await readJson(req, 80_000)
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const { value, description, graceMs } = body.value as Record<string, unknown>
      return this.vaultCall(async () => {
        const meta = await this.vault!.put(principal, parts[2]!, value as string, {
          ...(typeof description === 'string' ? { description: description.slice(0, 200) } : {}),
          ...(typeof graceMs === 'number' ? { graceMs } : {}),
        })
        const affected = this.config.webhooks.filter((w) => w.secret === `vault:${parts[2]}`)
        if (affected.length) await this.reloadWebhookSecrets()
        return { secret: meta, reloadedWebhooks: affected.map((w) => w.id) }
      })
    }
    if (path === '/api/admin/reload-secrets' && method === 'POST') {
      const denied = this.authorize(principal, 'tenant:admin')
      if (denied) return denied
      return { status: 200, body: { reloaded: await this.reloadWebhookSecrets() } }
    }

    return { status: 404, body: { error: 'Not found.' } }
  }

  private webhookResult(endpointId: string, outcome: { status: number; body: unknown }) {
    this.metrics.webhookDeliveries.inc({ endpoint: endpointId.slice(0, 64), status: String(outcome.status) })
    if (outcome.status >= 400) this.log.warn('webhook delivery refused', { endpointId, status: outcome.status, error: (outcome.body as { error?: string }).error })
    else this.log.info('webhook delivery accepted', { endpointId, status: outcome.status, runId: (outcome.body as { runId?: string }).runId })
    return outcome
  }

  private async vaultCall(fn: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
    try {
      return { status: 200, body: await fn() }
    } catch (error) {
      if (error instanceof VaultError) {
        const status = { forbidden: 403, 'not-found': 404, disabled: 409, invalid: 400, corrupt: 500, 'wrong-key': 500 }[error.code]
        return { status, body: { error: error.message } }
      }
      throw error
    }
  }

  private authenticate(req: IncomingMessage): Principal | undefined {
    return this.identity.authenticateHeader(headerValue(req, 'authorization'))
  }

  private authorize(principal: Principal, permission: Parameters<AccessController['authorize']>[1]): { status: number; body: unknown } | undefined {
    const decision = this.access.authorize(principal, permission, { tenantId: this.config.tenantId })
    return decision.allowed ? undefined : { status: 403, body: { error: decision.reasons.join(' ') } }
  }

  private require(req: IncomingMessage, permission: Parameters<AccessController['authorize']>[1]) {
    const principal = this.authenticate(req)
    if (!principal) return { status: 401, body: { error: 'A valid bearer token is required.' } }
    return this.authorize(principal, permission)
  }
}

function summarize(run: WorkflowRunRecord) {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
    ...(run.lastError ? { lastError: run.lastError } : {}),
    ...(run.deadLetter ? { deadLetter: run.deadLetter } : {}),
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(', ') : value
}

function routeLabel(method: string, path: string): string {
  if (path.startsWith('/webhooks/')) return `${method} /webhooks/:id`
  const normalized = path.replace(/^\/api\/runs\/[^/]+/, '/api/runs/:id').replace(/^\/api\/secrets\/[^/]+/, '/api/secrets/:name').replace(/^\/api\/intents\/[^/]+/, '/api/intents/:id').replace(/^\/api\/intent-ledger\/[^/]+/, '/api/intent-ledger/:company').replace(/^\/api\/genesis\/experiments\/[^/]+/, '/api/genesis/experiments/:id')
  const known = ['/healthz', '/readyz', '/metrics', '/api/whoami', '/api/runs', '/api/runs/:id', '/api/runs/:id/cancel', '/api/runs/:id/redrive', '/api/dead-letters', '/api/stats', '/api/schedules', '/api/webhooks', '/api/workflows', '/api/secrets', '/api/secrets/:name', '/api/admin/reload-secrets', '/api/intents', '/api/intents/:id', '/api/intents/:id/answers', '/api/intent-ledger/:company', '/api/decisions', '/api/genesis', '/api/genesis/experiments', '/api/genesis/money', '/api/genesis/reviews', '/api/genesis/experiments/:id/start', '/api/genesis/experiments/:id/measurements', '/api/genesis/experiments/:id/evaluate', '/api/genesis/experiments/:id/decide']
  return known.includes(normalized) ? `${method} ${normalized}` : `${method} other`
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) {
    req.resume()
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) {
      req.resume()
      return undefined
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const contentType = headerValue(req, 'content-type') ?? ''
  if (!/^application\/json\b/i.test(contentType)) return { ok: false, status: 415, error: 'Content-Type must be application/json.' }
  const raw = await readBody(req, limit)
  if (raw === undefined) return { ok: false, status: 413, error: `Body exceeds ${limit} bytes.` }
  try {
    const value = JSON.parse(raw || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400, error: 'Body must be a JSON object.' }
    return { ok: true, value }
  } catch {
    return { ok: false, status: 400, error: 'Body must be valid JSON.' }
  }
}
