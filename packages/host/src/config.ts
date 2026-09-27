import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { validatePrincipal, type Principal } from '@quicksilver/kernel/identity'
import { validateCron } from '@quicksilver/kernel/triggers/cron'
import { validateWorkflowGraph, type WorkflowGraph } from '@quicksilver/kernel/workflows/graph'
import { productionFlagProblems } from '@quicksilver/kernel/production-flags'

/**
 * Host configuration (single tenant).
 *
 * Loaded from a JSON file (`QUICKSILVER_HOST_CONFIG`). Credentials are never
 * written in this file: webhook secrets are references (`vault:<name>` or
 * `env:<NAME>`), human tokens come from `QUICKSILVER_PRINCIPALS`, and the
 * vault key and database URL come from environment variables named here.
 *
 * Validation is strict and fails at startup rather than at the first request:
 * one tenant for everything, trigger identities limited to the `trigger` role,
 * and workflow graphs that satisfy the M2 execution policy (read-only query
 * agents only; tool steps are blocked at run time).
 */

export type StoreConfig =
  | { kind: 'memory' }
  | { kind: 'file'; path: string }
  | { kind: 'postgres'; urlEnv: string; tablePrefix?: string }

export interface ScheduleConfig {
  id: string
  workflow: string
  cron: string
  input?: unknown
  principal: string
  priority?: number
  enabled?: boolean
}

export interface WebhookConfig {
  id: string
  /** The workflow a delivery enqueues. Omit it for a task webhook. */
  workflow?: string
  /**
   * Route deliveries into the one governed task intake (M7 part 4) instead of
   * enqueueing a workflow. The capability and department are fixed here: the
   * payload is untrusted data and cannot choose them.
   */
  task?: WebhookTaskConfig
  /** Secret references: `vault:<name>` or `env:<NAME>`. */
  secret: string
  principal: string
  priority?: number
  enabled?: boolean
  maxBodyBytes?: number
  /** This endpoint's delivery limit (default `http.rateLimits.webhook`), counted before the signature check. */
  rateLimit?: RateLimitSetting
}

export interface WebhookTaskConfig {
  capabilityId?: string
  department?: string
  /** Payload field that holds the objective text (default "objective"). */
  objectiveField?: string
}

/** The governed task interface (M7 part 4). All optional. */
export interface TasksConfig {
  /** Per-client token bucket: `burst` tasks at once, `perMinute` sustained. */
  rateLimit: { burst: number; perMinute: number }
  /** Capability catalog file (default deploy/tasks/catalog.json from the repo root). */
  catalog?: string
  /** Extra boundaries merged over the defaults (can add, never remove). */
  boundaries?: string
  /** Shadow log (intent id under intent/onboard/) where recommendation-only tasks are logged. */
  shadowIntentId: string
}

export interface ServicePrincipalConfig {
  id: string
  roles: string[]
}

/** A token bucket: `burst` requests at once, `perMinute` sustained. */
export interface RateLimitSetting {
  burst: number
  perMinute: number
}

/**
 * Per-principal limits on the host's routes (threat model A-5). Which class a
 * route belongs to is in the route table (routes.ts). In memory, per process.
 */
export interface HostRateLimits {
  /** Routes that change state, per principal. */
  write: RateLimitSetting
  /** Routes that call a model provider or enqueue a run that does, per principal. */
  model: RateLimitSetting
  /** Webhook deliveries, per endpoint (override one with `webhooks[].rateLimit`). */
  webhook: RateLimitSetting
}

export const DEFAULT_HOST_RATE_LIMITS: Readonly<HostRateLimits> = Object.freeze({
  write: Object.freeze({ burst: 60, perMinute: 120 }),
  model: Object.freeze({ burst: 10, perMinute: 20 }),
  webhook: Object.freeze({ burst: 60, perMinute: 120 }),
})

export interface HostConfig {
  tenantId: string
  http: { host: string; port: number; /** Serve /metrics without a token (use only on a private network). */ metricsPublic: boolean; maxBodyBytes: number; rateLimits: HostRateLimits }
  store: StoreConfig
  vault?: { path: string; keyEnv: string }
  worker: { id: string; concurrency: number; pollIntervalMs: number }
  queue: { maxQueued?: number; maxQueuedPerTenant?: number; maxRunningPerTenant?: number; leaseMs?: number; defaultMaxAttempts?: number }
  execution: { maxAgentSteps: number; allowedAgents: string[] }
  workflows: Record<string, WorkflowGraph>
  services: ServicePrincipalConfig[]
  schedules: ScheduleConfig[]
  webhooks: WebhookConfig[]
  tasks: TasksConfig
  log: { level: 'debug' | 'info' | 'warn' | 'error' }
}

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid host configuration:\n- ${problems.join('\n- ')}`)
    this.problems = problems
    this.name = 'ConfigError'
  }
}

/**
 * Refuse to start with a development-only switch on in production (threat
 * model A-10): `QUICKSILVER_ALLOW_FAULT_INJECTION` or
 * `QUICKSILVER_WORKFLOW_LIVE_RUNS` set to `on` while `NODE_ENV=production`.
 * The host shares its `.env` with the web app, so it checks both. Throws a
 * `ConfigError` naming each switch; returns quietly when it is safe.
 */
export function assertNoDevelopmentFlagsInProduction(env: Readonly<Record<string, string | undefined>>): void {
  const problems = productionFlagProblems(env)
  if (problems.length) throw new ConfigError(problems)
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const WEBHOOK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const SECRET_REF = /^(vault:[a-z0-9][a-z0-9._-]{0,127}|env:[A-Z_][A-Z0-9_]{0,127})$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/

/**
 * Read and validate a config file. Workflow entries may be inline graphs or `{ "file": "relative.json" }`.
 * When the file has no `tenantId`, `defaults.tenantId` is used (the host passes `QUICKSILVER_TENANT_ID`,
 * the same tenant the web app uses), so one `.env` configures both.
 */
export async function loadHostConfig(path: string, defaults: { tenantId?: string } = {}): Promise<HostConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ConfigError([`Could not read ${path}: ${(error as Error).message}`])
  }
  if (raw && typeof raw === 'object' && (raw as { tenantId?: unknown }).tenantId === undefined && defaults.tenantId) {
    (raw as { tenantId?: string }).tenantId = defaults.tenantId
  }
  const base = dirname(resolve(path))
  const workflows = (raw as { workflows?: Record<string, unknown> })?.workflows
  if (workflows && typeof workflows === 'object') {
    for (const [id, entry] of Object.entries(workflows)) {
      const file = (entry as { file?: unknown })?.file
      if (typeof file === 'string') {
        try {
          workflows[id] = JSON.parse(await readFile(isAbsolute(file) ? file : resolve(base, file), 'utf8'))
        } catch (error) {
          throw new ConfigError([`Workflow "${id}": could not read ${file}: ${(error as Error).message}`])
        }
      }
    }
  }
  const config = parseHostConfig(raw)
  if (config.store.kind === 'file' && !isAbsolute(config.store.path)) config.store.path = resolve(base, config.store.path)
  if (config.vault && !isAbsolute(config.vault.path)) config.vault.path = resolve(base, config.vault.path)
  if (config.tasks.catalog && !isAbsolute(config.tasks.catalog)) config.tasks.catalog = resolve(base, config.tasks.catalog)
  if (config.tasks.boundaries && !isAbsolute(config.tasks.boundaries)) config.tasks.boundaries = resolve(base, config.tasks.boundaries)
  return config
}

/** Validate a parsed config object and fill defaults. Throws `ConfigError` listing every problem. */
export function parseHostConfig(input: unknown): HostConfig {
  const p: string[] = []
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  if (!input || typeof input !== 'object') p.push('Config must be a JSON object.')

  const tenantId = raw.tenantId
  if (typeof tenantId !== 'string' || !ID.test(tenantId)) p.push('tenantId is required (letters, digits, . _ : -).')

  const http = {
    // Loopback unless the config says otherwise: a public bind (0.0.0.0) must be explicit (threat model A-4).
    host: typeof raw.http?.host === 'string' ? raw.http.host : '127.0.0.1',
    port: raw.http?.port ?? 8787,
    metricsPublic: raw.http?.metricsPublic === true,
    maxBodyBytes: raw.http?.maxBodyBytes ?? 262_144,
    rateLimits: {
      write: rateLimitSetting(raw.http?.rateLimits?.write, DEFAULT_HOST_RATE_LIMITS.write, 'http.rateLimits.write', p),
      model: rateLimitSetting(raw.http?.rateLimits?.model, DEFAULT_HOST_RATE_LIMITS.model, 'http.rateLimits.model', p),
      webhook: rateLimitSetting(raw.http?.rateLimits?.webhook, DEFAULT_HOST_RATE_LIMITS.webhook, 'http.rateLimits.webhook', p),
    },
  }
  for (const k of Object.keys(raw.http?.rateLimits ?? {})) if (!['write', 'model', 'webhook'].includes(k)) p.push(`http.rateLimits.${k} is not a known limit (write, model, webhook).`)
  if (!Number.isInteger(http.port) || http.port < 0 || http.port > 65_535) p.push('http.port must be 0–65535.')
  if (!Number.isInteger(http.maxBodyBytes) || http.maxBodyBytes < 1_024 || http.maxBodyBytes > 4 * 1_048_576) p.push('http.maxBodyBytes must be 1 KiB–4 MiB.')

  let store: StoreConfig = { kind: 'memory' }
  const s = raw.store ?? { kind: 'memory' }
  if (s.kind === 'memory') store = { kind: 'memory' }
  else if (s.kind === 'file' && typeof s.path === 'string' && s.path) store = { kind: 'file', path: s.path }
  else if (s.kind === 'postgres' && typeof s.urlEnv === 'string' && ENV_NAME.test(s.urlEnv)) {
    if (s.tablePrefix !== undefined && !/^[a-z][a-z0-9_]{0,30}$/.test(s.tablePrefix)) p.push('store.tablePrefix must be lowercase letters, digits and _.')
    store = { kind: 'postgres', urlEnv: s.urlEnv, ...(s.tablePrefix ? { tablePrefix: s.tablePrefix } : {}) }
  } else p.push('store must be { kind: "memory" }, { kind: "file", path }, or { kind: "postgres", urlEnv }. Put the database URL in the environment, not here.')

  let vault: HostConfig['vault']
  if (raw.vault !== undefined) {
    if (typeof raw.vault?.path !== 'string' || !raw.vault.path) p.push('vault.path is required when vault is set.')
    const keyEnv = raw.vault?.keyEnv ?? 'QUICKSILVER_VAULT_KEY'
    if (!ENV_NAME.test(keyEnv)) p.push('vault.keyEnv must be an environment variable name.')
    vault = { path: raw.vault?.path, keyEnv }
  }

  const worker = {
    id: raw.worker?.id ?? 'host-1',
    concurrency: raw.worker?.concurrency ?? 2,
    pollIntervalMs: raw.worker?.pollIntervalMs ?? 1_000,
  }
  if (typeof worker.id !== 'string' || !ID.test(worker.id)) p.push('worker.id is invalid.')
  if (!Number.isInteger(worker.concurrency) || worker.concurrency < 1 || worker.concurrency > 32) p.push('worker.concurrency must be 1–32.')
  if (!Number.isInteger(worker.pollIntervalMs) || worker.pollIntervalMs < 50) p.push('worker.pollIntervalMs must be at least 50.')

  const queue = { ...(raw.queue ?? {}) }
  for (const [k, v] of Object.entries(queue)) {
    if (!['maxQueued', 'maxQueuedPerTenant', 'maxRunningPerTenant', 'leaseMs', 'defaultMaxAttempts'].includes(k)) p.push(`queue.${k} is not a known setting.`)
    else if (!Number.isInteger(v) || (v as number) < 1) p.push(`queue.${k} must be a positive integer.`)
  }

  const execution = {
    maxAgentSteps: raw.execution?.maxAgentSteps ?? 3,
    allowedAgents: raw.execution?.allowedAgents ?? ['query'],
  }
  if (!Number.isInteger(execution.maxAgentSteps) || execution.maxAgentSteps < 1 || execution.maxAgentSteps > 16) p.push('execution.maxAgentSteps must be 1–16.')
  if (!Array.isArray(execution.allowedAgents) || execution.allowedAgents.some((a: unknown) => a !== 'query')) {
    p.push('execution.allowedAgents may only contain "query" at this version (read-only). Other agents arrive with the playbook milestone.')
  }

  const workflows: Record<string, WorkflowGraph> = {}
  for (const [id, graph] of Object.entries((raw.workflows ?? {}) as Record<string, unknown>)) {
    if (!ID.test(id)) { p.push(`Workflow id "${id}" is invalid.`); continue }
    const issues = checkWorkflow(graph as WorkflowGraph, execution)
    if (issues.length) p.push(...issues.map((i) => `Workflow "${id}": ${i}`))
    else workflows[id] = graph as WorkflowGraph
  }

  const services: ServicePrincipalConfig[] = []
  const serviceIds = new Set<string>()
  for (const svc of (raw.services ?? []) as ServicePrincipalConfig[]) {
    const principal: Principal = { id: svc?.id, kind: 'service', tenantId: tenantId, roles: svc?.roles }
    const errors = typeof tenantId === 'string' && ID.test(tenantId) ? validatePrincipal(principal) : []
    if (errors.length) p.push(`Service "${svc?.id}": ${errors.join(' ')}`)
    else if (serviceIds.has(svc.id)) p.push(`Service "${svc.id}" is defined twice.`)
    else {
      serviceIds.add(svc.id)
      services.push({ id: svc.id, roles: [...svc.roles] })
    }
  }
  const triggerService = (ref: string, where: string) => {
    const svc = services.find((s) => s.id === ref)
    if (!svc) p.push(`${where}: principal "${ref}" is not a configured service.`)
    else if (svc.roles.length !== 1 || svc.roles[0] !== 'trigger') p.push(`${where}: principal "${ref}" must hold only the "trigger" role.`)
  }

  const schedules: ScheduleConfig[] = []
  for (const sc of (raw.schedules ?? []) as ScheduleConfig[]) {
    const where = `Schedule "${sc?.id}"`
    if (typeof sc?.id !== 'string' || !ID.test(sc.id)) { p.push(`${where}: id is invalid.`); continue }
    if (schedules.some((x) => x.id === sc.id)) p.push(`${where} is defined twice.`)
    const cronError = typeof sc.cron === 'string' ? validateCron(sc.cron) : 'cron is required.'
    if (cronError) p.push(`${where}: ${cronError}`)
    if (!(sc.workflow in workflows) && !(raw.workflows ?? {})[sc.workflow]) p.push(`${where}: workflow "${sc.workflow}" is not defined.`)
    triggerService(sc.principal, where)
    schedules.push({ ...sc })
  }

  const webhooks: WebhookConfig[] = []
  for (const wh of (raw.webhooks ?? []) as WebhookConfig[]) {
    const where = `Webhook "${wh?.id}"`
    if (typeof wh?.id !== 'string' || !WEBHOOK_ID.test(wh.id)) { p.push(`${where}: id is invalid.`); continue }
    if (webhooks.some((x) => x.id === wh.id)) p.push(`${where} is defined twice.`)
    if (typeof wh.secret !== 'string' || !SECRET_REF.test(wh.secret)) p.push(`${where}: secret must be a reference ("vault:<name>" or "env:<NAME>"), never the secret itself.`)
    if (typeof wh.secret === 'string' && wh.secret.startsWith('vault:') && !vault) p.push(`${where}: uses a vault secret but no vault is configured.`)
    if (wh.task !== undefined) {
      const t = wh.task as WebhookTaskConfig
      if (!t || typeof t !== 'object') p.push(`${where}: task must be an object.`)
      else {
        if (wh.workflow !== undefined) p.push(`${where}: a task webhook names no workflow; the task intake decides what runs.`)
        if (t.capabilityId !== undefined && (typeof t.capabilityId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._:-]{0,127}$/.test(t.capabilityId))) p.push(`${where}: task.capabilityId is invalid.`)
        if (t.department !== undefined && (typeof t.department !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(t.department))) p.push(`${where}: task.department is invalid.`)
        if (t.objectiveField !== undefined && (typeof t.objectiveField !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(t.objectiveField))) p.push(`${where}: task.objectiveField must be a field name.`)
      }
    } else if (typeof wh.workflow !== 'string' || (!(wh.workflow in workflows) && !(raw.workflows ?? {})[wh.workflow])) p.push(`${where}: workflow "${wh.workflow}" is not defined.`)
    triggerService(wh.principal, where)
    const whRate = wh.rateLimit === undefined ? undefined : rateLimitSetting(wh.rateLimit, DEFAULT_HOST_RATE_LIMITS.webhook, `${where}: rateLimit`, p)
    webhooks.push({ ...wh, ...(whRate ? { rateLimit: whRate } : {}) })
  }

  const rateLimit = { burst: raw.tasks?.rateLimit?.burst ?? 10, perMinute: raw.tasks?.rateLimit?.perMinute ?? 30 }
  if (!Number.isInteger(rateLimit.burst) || rateLimit.burst < 1 || rateLimit.burst > 1_000) p.push('tasks.rateLimit.burst must be 1–1000.')
  if (typeof rateLimit.perMinute !== 'number' || !(rateLimit.perMinute > 0) || rateLimit.perMinute > 6_000) p.push('tasks.rateLimit.perMinute must be above 0 and at most 6000.')
  const shadowIntentId = raw.tasks?.shadowIntentId ?? 'tasks'
  if (typeof shadowIntentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(shadowIntentId)) p.push('tasks.shadowIntentId must be an intent id.')
  for (const k of ['catalog', 'boundaries'] as const) if (raw.tasks?.[k] !== undefined && (typeof raw.tasks[k] !== 'string' || !raw.tasks[k])) p.push(`tasks.${k} must be a file path.`)
  const tasks: TasksConfig = {
    rateLimit,
    shadowIntentId,
    ...(typeof raw.tasks?.catalog === 'string' ? { catalog: raw.tasks.catalog } : {}),
    ...(typeof raw.tasks?.boundaries === 'string' ? { boundaries: raw.tasks.boundaries } : {}),
  }

  const level = raw.log?.level ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(level)) p.push('log.level must be debug, info, warn or error.')

  if (p.length) throw new ConfigError(p)
  return { tenantId, http, store, ...(vault ? { vault } : {}), worker, queue, execution, workflows, services, schedules, webhooks, tasks, log: { level } }
}

/** A `{ burst, perMinute }` setting with defaults filled; problems are pushed onto `p`. */
function rateLimitSetting(raw: unknown, fallback: RateLimitSetting, where: string, p: string[]): RateLimitSetting {
  if (raw === undefined) return { ...fallback }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const setting = { burst: (r.burst ?? fallback.burst) as number, perMinute: (r.perMinute ?? fallback.perMinute) as number }
  if (!raw || typeof raw !== 'object') p.push(`${where} must be { burst, perMinute }.`)
  if (!Number.isInteger(setting.burst) || setting.burst < 1 || setting.burst > 1_000) p.push(`${where}.burst must be 1–1000.`)
  if (typeof setting.perMinute !== 'number' || !(setting.perMinute > 0) || setting.perMinute > 6_000) p.push(`${where}.perMinute must be above 0 and at most 6000.`)
  return setting
}

/** The M2 execution policy for a stored workflow graph. Also applied to API-submitted runs. */
export function checkWorkflow(graph: WorkflowGraph, execution: { maxAgentSteps: number; allowedAgents: string[] }): string[] {
  const validation = validateWorkflowGraph(graph)
  if (!validation.valid) return validation.errors
  const issues: string[] = []
  const agents = graph.nodes.filter((n) => n.kind === 'agent')
  if (agents.length > execution.maxAgentSteps) issues.push(`at most ${execution.maxAgentSteps} agent steps are allowed.`)
  for (const node of agents) {
    if (!execution.allowedAgents.includes(String(node.config?.agentId ?? '').replace(/^nuera-quicksilver:/, ''))) issues.push(`agent step "${node.id}" uses "${String(node.config?.agentId)}"; only ${execution.allowedAgents.join(', ')} can run on the host.`)
    if (node.config?.impact === 'high' || node.config?.impact === 'critical') issues.push(`agent step "${node.id}" cannot be high or critical impact on a read-only host.`)
  }
  return issues
}
