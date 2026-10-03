import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'

import { AccessController, type AccessDecision, type Principal } from '@quicksilver/kernel/identity'
import { StaticTokenIdentityProvider, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import {
  InMemoryWorkflowRunStore,
  WorkflowRunQueue,
  WorkflowRunWorker,
  type AuthorizationSigningKey,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowRunStore,
} from '@quicksilver/kernel/runtime'
import { CronScheduler, WebhookTrigger, type VerifiedWebhookDelivery, type WebhookSinkOutcome } from '@quicksilver/kernel/triggers'
import { TokenBucketLimiter } from '@quicksilver/kernel/rate-limit'
import { FileWorkflowPublicationStore, InMemoryWorkflowPublicationStore, type WorkflowPublicationActor, type WorkflowPublicationVersion } from '@quicksilver/kernel/workflows/publication'

import { checkWorkflow, type HostConfig, type WebhookTaskConfig } from './config.ts'
import { createHandlerFactory, type AgentRunner, type EvaluationSink } from './handlers.ts'
import { Logger, redactValue } from './log.ts'
import { createHostMetrics, type HostMetrics } from './metrics.ts'
import { SecretsVault, VaultError } from './vault.ts'
import { handleIntentRoute, type IntentApiDeps } from './intent-api.ts'
import { handleShadowRoute, type ShadowApiDeps } from './shadow-api.ts'
import { handleGenesisRoute, type GenesisApiDeps } from './genesis-api.ts'
import { genesisPaymentWebhookSink } from './genesis-payment-webhook.ts'
import { COMMERCE_KEY_VAULT_NAME, createStripeCommerceClient, type StripeCommerceClient } from './genesis-commerce.ts'
import { handleDecisionRoute, type DecisionApiDeps } from './decisions-api.ts'
import { handleTaskRoute } from './tasks-api.ts'
import { TaskError, TaskService, type TaskRunBackend, type TaskServiceDeps } from './tasks.ts'
import type { TaskClientRegistry } from './task-clients.ts'
import { hostRouteLabel, matchHostRoute, type HostRoute, type HostRouteFeature } from './routes.ts'
import { FileAuthorizationAuditStore, resolveAuthorizationAuditPath } from './authorization-audit.ts'

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
  /** Versioned workflow publication state; defaults to a file adapter for file-backed hosts. */
  publicationStore?: InMemoryWorkflowPublicationStore
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
  /**
   * The governed task interface (M7 part 4). The host adds its tenant, access
   * controller, the run queue and the configured rate limit. Routes return 404 when absent.
   */
  tasks?: Omit<TaskServiceDeps, 'tenantId' | 'access' | 'runs' | 'rateLimit' | 'now'> & { clients?: TaskClientRegistry }
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
const TASK_PRINCIPAL_ID = 'svc:quicksilver-tasks'

export class QuicksilverHost {
  readonly config: HostConfig
  readonly log: Logger
  readonly metrics: HostMetrics
  readonly access: AccessController
  readonly queue: WorkflowRunQueue
  readonly publications: InMemoryWorkflowPublicationStore
  readonly worker: WorkflowRunWorker
  readonly scheduler: CronScheduler
  readonly vault?: SecretsVault
  webhooks?: WebhookTrigger
  /** The one governed task intake (M7 part 4), when configured. */
  readonly tasks?: TaskService
  private readonly identity: StaticTokenIdentityProvider
  private readonly deps: HostDependencies
  /** Probes the route table's permission floor without logging each miss (the one denial is logged through `access`). */
  private readonly gate: AccessController
  /** Per-principal buckets for `write` and `model` routes, and per-endpoint buckets for webhooks (A-5). */
  private readonly limiters: { write: TokenBucketLimiter; model: TokenBucketLimiter; webhook: Map<string, TokenBucketLimiter> }
  private readonly hostPrincipal: Principal
  private readonly authorizationAudit: FileAuthorizationAuditStore
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
    this.authorizationAudit = new FileAuthorizationAuditStore(resolveAuthorizationAuditPath(config, deps.env ?? process.env))

    const customRoles = [
      { id: 'host-runtime', tenantId: config.tenantId, description: 'The host process: resolve secrets for triggers.', permissions: ['secret:use'] as const },
      { id: 'task-runtime', tenantId: config.tenantId, description: 'The task intake: enqueue, read and cancel the runs of tasks the kernel allowed.', permissions: ['run:enqueue', 'run:read', 'run:cancel'] as const },
    ]
    this.access = new AccessController({
      customRoles,
      audit: (decision) => this.onAccessDecision(decision),
      ...(deps.now ? { now: deps.now } : {}),
    })
    this.gate = new AccessController({ customRoles, ...(deps.now ? { now: deps.now } : {}) })
    const now = deps.now ?? Date.now
    this.limiters = {
      write: new TokenBucketLimiter(config.http.rateLimits.write, now),
      model: new TokenBucketLimiter(config.http.rateLimits.model, now),
      webhook: new Map(config.webhooks.map((wh) => [wh.id, new TokenBucketLimiter(wh.rateLimit ?? config.http.rateLimits.webhook, now)])),
    }
    this.hostPrincipal = { id: HOST_PRINCIPAL_ID, kind: 'service', tenantId: config.tenantId, roles: ['host-runtime'] }

    const store = deps.store ?? new InMemoryWorkflowRunStore()
    this.publications = deps.publicationStore ?? (config.store.kind === 'file'
      ? new FileWorkflowPublicationStore(join(dirname(config.store.path), 'workflow-publications.json'))
      : new InMemoryWorkflowPublicationStore())
    const authorizationSecret = (deps.env ?? process.env)[config.execution.authorizationKeyEnv]
    const authorizationKey: AuthorizationSigningKey | undefined = authorizationSecret
      ? { keyId: `${config.tenantId}:${config.worker.id}`, secret: authorizationSecret }
      : undefined
    this.queue = new WorkflowRunQueue({ store, tenantId: config.tenantId, access: this.access, ...config.queue, ...(deps.now ? { now: deps.now } : {}) })
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
        ...(authorizationKey ? { authorizationKey } : {}),
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
        graph: this.publications.getPublished(sc.workflow)?.graph ?? config.workflows[sc.workflow]!,
        ...(this.publications.getPublished(sc.workflow) ? { publication: { version: this.publications.getPublished(sc.workflow)!.version, digest: this.publications.getPublished(sc.workflow)!.digest } } : {}),
        ...(sc.input !== undefined ? { input: sc.input } : {}),
        principal: services.get(sc.principal)!,
        ...(sc.priority !== undefined ? { priority: sc.priority } : {}),
        enabled: sc.enabled !== false,
      })
    }

    if (deps.tasks) {
      const taskPrincipal: Principal = { id: TASK_PRINCIPAL_ID, kind: 'service', tenantId: config.tenantId, roles: ['task-runtime'] }
      const runs: TaskRunBackend = {
        enqueue: async ({ workflow, input, idempotencyKey }) => {
          const publication = this.publications.getPublished(workflow)
          const graph = publication?.graph ?? config.workflows[workflow]
          if (!graph) return { ok: false, reason: `workflow "${workflow}" is not configured on this host` }
          const issues = checkWorkflow(graph, config.execution)
          if (issues.length) return { ok: false, reason: issues.join(' ') }
          const r = await this.queue.enqueue({ graph, ...(publication ? { publication: { version: publication.version, digest: publication.digest } } : {}), input, tenantId: config.tenantId, trigger: { kind: 'event', source: `task:${idempotencyKey.slice(5)}` }, principal: taskPrincipal, idempotencyKey, maxAttempts: 1 })
          return r.accepted ? { ok: true, runId: r.run.runId } : { ok: false, reason: `${r.code}: ${r.reasons.join(' ')}` }
        },
        get: async (runId) => {
          const run = await this.queue.get(runId)
          return run && run.tenantId === config.tenantId ? { status: run.status, ...(run.result ? { result: run.result.outputs ?? null } : {}), ...(run.lastError ? { lastError: run.lastError } : {}) } : undefined
        },
        cancel: async (runId, reason) => {
          const run = await this.queue.cancel(runId, taskPrincipal, reason)
          return run ? { status: run.status } : undefined
        },
      }
      const { clients: _clients, ...taskDeps } = deps.tasks
      this.tasks = new TaskService({ ...taskDeps, tenantId: config.tenantId, access: this.access, runs, rateLimit: config.tasks.rateLimit, ...(deps.now ? { now: deps.now } : {}) })
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
      if (wh.task && !this.tasks) throw new Error(`Webhook "${wh.id}" routes to the task intake, but the task interface is not configured.`)
      if (wh.genesisPayment && !this.deps.genesis?.pending) throw new Error(`Webhook "${wh.id}" records Genesis payments, but no Genesis run with a pending-payment store is configured.`)
      endpoints.push({
        id: wh.id,
        tenantId: this.config.tenantId,
        ...(wh.scheme ? { scheme: wh.scheme } : {}),
        ...(wh.genesisPayment ? { deliver: (d: VerifiedWebhookDelivery) => this.genesisPaymentWebhook(d) }
          : wh.task ? { deliver: (d: VerifiedWebhookDelivery) => this.webhookTask(wh.task!, d) } : { graph: this.config.workflows[wh.workflow!]! }),
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

  /** P-027 commerce actions: the Stripe client for the run's mode, from the vault secret (or QUICKSILVER_GENESIS_STRIPE_API_KEY without a vault). */
  private async commerceClient(mode: 'off' | 'test' | undefined): Promise<StripeCommerceClient> {
    if (mode !== 'test') throw new Error('Commerce actions are off.')
    const [apiKey] = await this.resolveSecret(this.vault ? `vault:${COMMERCE_KEY_VAULT_NAME}` : 'env:QUICKSILVER_GENESIS_STRIPE_API_KEY')
    return createStripeCommerceClient({ apiKey: apiKey!, mode })
  }

  /** P-027: a verified Stripe delivery into the Genesis ledger (pending or recorded). Never calls Stripe. */
  private genesisPaymentWebhook(d: VerifiedWebhookDelivery): Promise<WebhookSinkOutcome> {
    const g = this.deps.genesis!
    return genesisPaymentWebhookSink({ config: g.config, store: g.store, pending: g.pending!, ...(this.deps.now ? { now: this.deps.now } : g.now ? { now: g.now } : {}) })(d)
  }

  /** A verified task-webhook delivery: into the one intake, as the endpoint's service principal. */
  private async webhookTask(cfg: WebhookTaskConfig, d: VerifiedWebhookDelivery): Promise<WebhookSinkOutcome> {
    const payload = (d.payload && typeof d.payload === 'object' && !Array.isArray(d.payload) ? d.payload : {}) as Record<string, unknown>
    const objective = payload[cfg.objectiveField ?? 'objective']
    const inputs = payload.inputs
    try {
      const { task, deduplicated } = await this.tasks!.submit({
        source: 'webhook',
        principal: d.principal,
        objective,
        ...(cfg.capabilityId ? { capabilityId: cfg.capabilityId } : {}),
        ...(cfg.department ? { department: cfg.department } : {}),
        ...(inputs !== undefined ? { inputs } : {}),
        idempotencyKey: d.idempotencyKey,
      })
      return { status: deduplicated ? 200 : 202, body: { accepted: true, taskId: task.id, status: task.status, deduplicated } }
    } catch (error) {
      if (error instanceof TaskError) return { status: error.status, body: { accepted: false, error: error.message, code: error.code } }
      throw error
    }
  }

  private onRunFinished(run: WorkflowRunRecord): void {
    if (this.tasks && run.trigger.kind === 'event' && run.trigger.source?.startsWith('task:')) {
      const taskId = run.trigger.source.slice(5)
      void this.tasks.deps.store.get(taskId).then((t) => (t ? this.tasks!.refresh(t) : undefined)).catch((error) => this.log.warn('task status update failed', { taskId, error: (error as Error).message }))
    }
    this.metrics.runsFinished.inc({ status: run.status, workflow: run.workflowId })
    this.metrics.runDuration.observe({ workflow: run.workflowId }, Math.max(0, (run.updatedAt - run.createdAt) / 1000))
    const fields = { runId: run.runId, workflowId: run.workflowId, status: run.status, attempt: run.attempt, trigger: run.trigger, requestedBy: run.requestedBy, ...(run.lastError ? { error: run.lastError } : {}) }
    if (run.status === 'completed') this.log.info('run finished', fields)
    else this.log.warn('run finished', fields)
  }

  private onAccessDecision(decision: AccessDecision): void {
    this.authorizationAudit.append(decision)
    if (decision.allowed) this.log.debug('access allowed', { permission: decision.permission, principalId: decision.principalId, resourceId: decision.resourceId })
    else this.log.warn('access denied', { permission: decision.permission, principalId: decision.principalId, resourceId: decision.resourceId, reasons: decision.reasons })
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://host.local')
    const route = hostRouteLabel(req.method ?? 'GET', url.pathname)
    let status = 500
    try {
      const out = await this.dispatch(req, url)
      status = out.status
      // Authentication failures happen before a Principal reaches RBAC. Keep
      // those refusals in the same durable decision ledger without recording
      // a supplied bearer token (or any request material).
      const matched = matchHostRoute(req.method ?? 'GET', url.pathname).route
      if (status === 401 && matched?.access.kind === 'permission') {
        this.authorizationAudit.append({
          allowed: false,
          permission: matched.access.anyOf[0]!,
          principalId: 'anonymous',
          principalKind: 'unknown',
          tenantId: this.config.tenantId,
          grantedBy: [],
          reasons: ['No authenticated principal.'],
          at: Date.now(),
        })
      }
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
        const denied = await this.require(req, 'audit:read')
        if (denied) return denied
      }
      return { status: 200, body: await this.metrics.registry.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' }
    }

    if (parts[0] === 'webhooks' && parts.length === 2) {
      if (method !== 'POST') return { status: 405, body: { accepted: false, error: 'Use POST.' } }
      // Per-endpoint delivery limit (A-5), before the body is read or the signature checked.
      const limited = this.rateLimited(this.limiters.webhook.get(parts[1]!), parts[1]!)
      if (limited) return this.webhookResult(parts[1]!, limited)
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
    const principal = await this.authenticate(req)
    if (!principal) return { status: 401, body: { error: 'A valid bearer token is required.' } }

    // The route table (routes.ts) decides which /api routes exist, the permission
    // floor each needs, and its rate limit, before any handler runs (A-5, A-9).
    const matched = matchHostRoute(method, path)
    if (!matched.route) return matched.methodMismatch ? { status: 405, body: { error: 'Method not allowed.' } } : { status: 404, body: { error: 'Not found.' } }
    if (this.hasFeature(matched.route.feature)) {
      const denied = this.checkRouteAccess(principal, matched.route)
      if (denied) return denied
      const cls = matched.route.rateLimit
      if (cls === 'write' || cls === 'model') {
        const limited = this.rateLimited(this.limiters[cls], principal.id)
        if (limited) {
          this.log.warn('rate limited', { route: `${method} ${matched.route.path}`, principalId: principal.id, class: cls })
          return limited
        }
      }
    }

    // GET /api/whoami
    if (method === 'GET' && path === '/api/whoami') return { status: 200, body: { id: principal.id, kind: principal.kind, tenantId: principal.tenantId, roles: principal.roles } }

    // The governed task interface (M7 part 4): the one intake for API and MCP callers.
    if (parts[1] === 'tasks' && this.tasks) {
      const channel = (headerValue(req, 'x-quicksilver-task-source') ?? '').trim().toLowerCase()
      const handled = await handleTaskRoute({
        method, parts, query: url.searchParams, principal,
        source: channel === 'mcp' ? 'mcp' : 'api',
        readBody: () => readJson(req, 16_384),
      }, this.tasks)
      if (handled) return handled
    }

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
      const g = this.deps.genesis
      // Commerce actions read the Stripe key only when an approval needs it, never at startup.
      const commerce = g.commerce && !g.commerce.client ? { ...g.commerce, client: () => this.commerceClient(g.config.commerceMode) } : g.commerce
      const handled = await handleGenesisRoute({
        method, parts, principal, tenantId: this.config.tenantId, access: this.access,
        readBody: () => readJson(req, this.config.http.maxBodyBytes),
      }, {
        ...(vault ? { vaultNames: async () => (await vault.list(this.hostPrincipal)).filter((s) => !s.disabled).map((s) => s.name) } : {}),
        ...this.deps.genesis,
        ...(commerce ? { commerce } : {}),
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
      if (typeof workflow !== 'string') return { status: 422, body: { error: 'workflow must name a published or configured workflow.' } }
      const publication = this.publications.getPublished(workflow)
      const graph = publication?.graph ?? this.config.workflows[workflow]
      if (!graph) return { status: 422, body: { error: 'workflow must name a published or configured workflow.' } }
      const issues = checkWorkflow(graph, this.config.execution)
      if (issues.length) return { status: 422, body: { error: 'Workflow violates the host execution policy.', issues } }
      const result = await this.queue.enqueue({
        graph,
        ...(publication ? { publication: { version: publication.version, digest: publication.digest } } : {}),
        input: input ?? null,
        tenantId: this.config.tenantId,
        trigger: { kind: 'api', source: principal.id },
        principal,
        ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
        ...(typeof priority === 'number' ? { priority } : {}),
      })
      if (result.accepted) return { status: result.deduplicated ? 200 : 202, body: { runId: result.run.runId, deduplicated: result.deduplicated, status: result.run.status, ...(publication ? { publication: { version: publication.version, digest: publication.digest } } : {}) } }
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
      const published = this.publications.snapshot().versions.filter((version) => version.status === 'published')
      return { status: 200, body: { workflows: Object.entries(this.config.workflows).map(([id, g]) => ({ id, graphId: g.id, version: g.version, nodes: g.nodes.length, source: 'host-config' })), published: published.map(publicationSummary) } }
    }
    if (parts[1] === 'workflows' && parts.length === 3 && method === 'GET') {
      const denied = this.authorize(principal, 'workflow:read')
      if (denied) return denied
      const versions = this.publications.snapshot().versions.filter((version) => version.workflowId === parts[2])
      if (!versions.length && !this.config.workflows[parts[2]!]) return { status: 404, body: { error: 'Workflow not found.' } }
      return { status: 200, body: { configured: this.config.workflows[parts[2]!] ?? null, versions: versions.map(publicationSummary) } }
    }
    if (path === '/api/workflows/drafts' && method === 'POST') {
      const denied = this.authorize(principal, 'workflow:write')
      if (denied) return denied
      const body = await readJson(req, this.config.http.maxBodyBytes)
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const graph = (body.value as { graph?: unknown }).graph
      if (!graph || typeof graph !== 'object') return { status: 400, body: { error: 'Provide a workflow graph in graph.' } }
      try {
        const created = this.publications.createDraft(graph as never, publicationActor(principal), Date.now())
        return { status: 201, body: { publication: publicationSummary(created) } }
      } catch (error) {
        return { status: 409, body: { error: (error as Error).message } }
      }
    }
    if (parts[1] === 'workflows' && parts.length === 4 && method === 'POST' && ['submit-review', 'review', 'publish', 'rollback'].includes(parts[3]!)) {
      const permission = parts[3] === 'submit-review' ? 'workflow:write' : 'workflow:publish'
      const denied = this.authorize(principal, permission)
      if (denied) return denied
      const body = await readJson(req, this.config.http.maxBodyBytes)
      if (!body.ok) return { status: body.status, body: { error: body.error } }
      const version = (body.value as { version?: unknown }).version
      if (!Number.isInteger(version) || (version as number) < 1) return { status: 400, body: { error: 'version must be a positive integer.' } }
      try {
        const actor = publicationActor(principal)
        let result: WorkflowPublicationVersion
        if (parts[3] === 'submit-review') result = this.publications.submitForReview(parts[2]!, version as number, actor, Date.now())
        else if (parts[3] === 'review') result = this.publications.review(parts[2]!, version as number, actor, Date.now())
        else if (parts[3] === 'publish') result = this.publications.publish(parts[2]!, version as number, actor, Date.now())
        else result = this.publications.rollback(parts[2]!, version as number, actor, Date.now())
        return { status: 200, body: { publication: publicationSummary(result) } }
      } catch (error) {
        const message = (error as Error).message
        return { status: /not found/i.test(message) ? 404 : 409, body: { error: message } }
      }
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

  /** Whether the part of the host a route belongs to is configured (a route of an absent part is a 404). */
  private hasFeature(feature: HostRouteFeature | undefined): boolean {
    if (!feature) return true
    if (feature === 'vault') return !!this.vault
    if (feature === 'tasks') return !!this.tasks
    return !!this.deps[feature]
  }

  /** The route table's permission floor: at least one of `anyOf`, in this tenant. Logs one denial. */
  private checkRouteAccess(principal: Principal, route: HostRoute): { status: number; body: unknown } | undefined {
    if (route.access.kind !== 'permission') return undefined
    const tenant = { tenantId: this.config.tenantId }
    if (route.access.anyOf.some((permission) => this.gate.authorize(principal, permission, tenant).allowed)) return undefined
    const decision = this.access.authorize(principal, route.access.anyOf[0]!, tenant)
    const needs = route.access.anyOf.length > 1 ? `one of ${route.access.anyOf.join(', ')}` : route.access.anyOf[0]
    return { status: 403, body: { error: `${decision.reasons.join(' ')} This route needs ${needs}.`, code: 'forbidden' } }
  }

  /** A 429 with Retry-After when the bucket for `key` is empty. */
  private rateLimited(limiter: TokenBucketLimiter | undefined, key: string): { status: number; body: unknown; headers: Record<string, string> } | undefined {
    const r = limiter?.take(key)
    if (!r || r.ok) return undefined
    return {
      status: 429,
      body: { error: `Too many requests; retry in ${r.retryAfterSeconds} s.`, code: 'rate-limited', retryAfterSeconds: r.retryAfterSeconds },
      headers: { 'retry-after': String(r.retryAfterSeconds) },
    }
  }

  /** Host principals first; then task clients (each holds only the task-client role). */
  private async authenticate(req: IncomingMessage): Promise<Principal | undefined> {
    const header = headerValue(req, 'authorization')
    return this.identity.authenticateHeader(header) ?? (await this.deps.tasks?.clients?.authenticateHeader(header))
  }

  private authorize(principal: Principal, permission: Parameters<AccessController['authorize']>[1]): { status: number; body: unknown } | undefined {
    const decision = this.access.authorize(principal, permission, { tenantId: this.config.tenantId })
    return decision.allowed ? undefined : { status: 403, body: { error: decision.reasons.join(' ') } }
  }

  private async require(req: IncomingMessage, permission: Parameters<AccessController['authorize']>[1]) {
    const principal = await this.authenticate(req)
    if (!principal) return { status: 401, body: { error: 'A valid bearer token is required.' } }
    return this.authorize(principal, permission)
  }
}
function publicationActor(principal: Principal): WorkflowPublicationActor {
  return { id: principal.id, kind: principal.kind, canPublish: principal.kind === 'human' }
}

function publicationSummary(version: WorkflowPublicationVersion) {
  return {
    workflowId: version.workflowId,
    version: version.version,
    digest: version.digest,
    authoredBy: version.authoredBy,
    status: version.status,
    createdAt: new Date(version.createdAt).toISOString(),
    ...(version.reviewedBy ? { reviewedBy: version.reviewedBy, reviewedAt: new Date(version.reviewedAt!).toISOString() } : {}),
    ...(version.publishedAt ? { publishedAt: new Date(version.publishedAt).toISOString() } : {}),
    ...(version.deprecatedAt ? { deprecatedAt: new Date(version.deprecatedAt).toISOString() } : {}),
    ...(version.rollbackOfVersion ? { rollbackOfVersion: version.rollbackOfVersion } : {}),
    nodes: version.graph.nodes.length,
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
    ...(run.publication ? { publication: run.publication } : {}),
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
