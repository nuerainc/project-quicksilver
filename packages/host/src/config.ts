import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { validatePrincipal, type Principal } from '@quicksilver/kernel/identity'
import { validateCron } from '@quicksilver/kernel/triggers/cron'
import { validateWorkflowGraph, type WorkflowGraph } from '@quicksilver/kernel/workflows/graph'

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
  workflow: string
  /** Secret references: `vault:<name>` or `env:<NAME>`. */
  secret: string
  principal: string
  priority?: number
  enabled?: boolean
  maxBodyBytes?: number
}

export interface ServicePrincipalConfig {
  id: string
  roles: string[]
}

export interface HostConfig {
  tenantId: string
  http: { host: string; port: number; /** Serve /metrics without a token (use only on a private network). */ metricsPublic: boolean; maxBodyBytes: number }
  store: StoreConfig
  vault?: { path: string; keyEnv: string }
  worker: { id: string; concurrency: number; pollIntervalMs: number }
  queue: { maxQueued?: number; maxQueuedPerTenant?: number; maxRunningPerTenant?: number; leaseMs?: number; defaultMaxAttempts?: number }
  execution: { maxAgentSteps: number; allowedAgents: string[] }
  workflows: Record<string, WorkflowGraph>
  services: ServicePrincipalConfig[]
  schedules: ScheduleConfig[]
  webhooks: WebhookConfig[]
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
    host: typeof raw.http?.host === 'string' ? raw.http.host : '0.0.0.0',
    port: raw.http?.port ?? 8787,
    metricsPublic: raw.http?.metricsPublic === true,
    maxBodyBytes: raw.http?.maxBodyBytes ?? 262_144,
  }
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
    if (!(wh.workflow in workflows) && !(raw.workflows ?? {})[wh.workflow]) p.push(`${where}: workflow "${wh.workflow}" is not defined.`)
    triggerService(wh.principal, where)
    webhooks.push({ ...wh })
  }

  const level = raw.log?.level ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(level)) p.push('log.level must be debug, info, warn or error.')

  if (p.length) throw new ConfigError(p)
  return { tenantId, http, store, ...(vault ? { vault } : {}), worker, queue, execution, workflows, services, schedules, webhooks, log: { level } }
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
