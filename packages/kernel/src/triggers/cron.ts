import type { WorkflowGraph } from '../workflows/graph.ts'
import type { Principal } from '../identity/rbac.ts'
import type { WorkflowRunQueue, EnqueueResult } from '../runtime/queue.ts'

/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in UTC.
 * Supports `*`, lists, ranges, steps (`*\/15`, `1-5/2`), day-of-week 0–7 (0 and 7
 * are Sunday), and the macros @hourly, @daily, @weekly, @monthly, @yearly.
 * When both day fields are restricted, a day matches if either does (Vixie cron).
 */
export interface CronSchedule {
  expression: string
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  daysOfWeek: ReadonlySet<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== 'string') throw new Error('Cron expression must be text.')
  const source = MACROS[expression.trim().toLowerCase()] ?? expression.trim()
  const fields = source.split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week.')
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  const daysOfWeek = new Set([...parseField(dow, 0, 7, 'day-of-week')].map((d) => (d === 7 ? 0 : d)))
  return {
    expression: expression.trim(),
    minutes: parseField(minute, 0, 59, 'minute'),
    hours: parseField(hour, 0, 23, 'hour'),
    daysOfMonth: parseField(dom, 1, 31, 'day-of-month'),
    months: parseField(month, 1, 12, 'month'),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
}

export function validateCron(expression: string): string | null {
  try {
    parseCron(expression)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

/** First matching minute strictly after `after` (epoch ms), or null if none within 5 years. */
export function nextCronTime(schedule: CronSchedule | string, after: number): number | null {
  const cron = typeof schedule === 'string' ? parseCron(schedule) : schedule
  const start = new Date(Math.floor(after / 60_000) * 60_000 + 60_000)
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
  for (let offset = 0; offset < 366 * 5; offset += 1) {
    const candidate = new Date(day.getTime() + offset * 86_400_000)
    if (!dayMatches(cron, candidate)) continue
    const sameDay = offset === 0
    for (const hour of sorted(cron.hours)) {
      if (sameDay && hour < start.getUTCHours()) continue
      for (const minute of sorted(cron.minutes)) {
        if (sameDay && hour === start.getUTCHours() && minute < start.getUTCMinutes()) continue
        return Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate(), hour, minute)
      }
    }
  }
  return null
}

/** Most recent matching minute at or before `at`, or null if none within 5 years. */
export function previousCronTime(schedule: CronSchedule | string, at: number): number | null {
  const cron = typeof schedule === 'string' ? parseCron(schedule) : schedule
  const end = new Date(Math.floor(at / 60_000) * 60_000)
  const day = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
  for (let offset = 0; offset < 366 * 5; offset += 1) {
    const candidate = new Date(day.getTime() - offset * 86_400_000)
    if (!dayMatches(cron, candidate)) continue
    const sameDay = offset === 0
    for (const hour of sorted(cron.hours).reverse()) {
      if (sameDay && hour > end.getUTCHours()) continue
      for (const minute of sorted(cron.minutes).reverse()) {
        if (sameDay && hour === end.getUTCHours() && minute > end.getUTCMinutes()) continue
        return Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate(), hour, minute)
      }
    }
  }
  return null
}

function dayMatches(cron: CronSchedule, date: Date): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false
  const dom = cron.daysOfMonth.has(date.getUTCDate())
  const dow = cron.daysOfWeek.has(date.getUTCDay())
  if (cron.domRestricted && cron.dowRestricted) return dom || dow
  if (cron.domRestricted) return dom
  if (cron.dowRestricted) return dow
  return true
}

function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b)
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!match) throw new Error(`Invalid ${name} field "${field}".`)
    const [, range, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid ${name} step in "${field}".`)
    let low = min
    let high = max
    if (range !== '*') {
      const [a, b] = range!.split('-').map(Number)
      low = a!
      high = b ?? (stepText === undefined ? a! : max)
    }
    if (low < min || high > max || low > high) throw new Error(`${name} value out of range in "${field}" (allowed ${min}–${max}).`)
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

// ── scheduler ─────────────────────────────────────────────────────────────

export interface ScheduledWorkflow {
  /** Stable id; part of every run's idempotency key. */
  id: string
  tenantId: string
  cron: string
  graph: WorkflowGraph
  /** Static input; the slot time is added as `scheduledFor`. */
  input?: unknown
  /** Service principal holding `run:enqueue` (e.g. the `trigger` role). */
  principal?: Principal
  priority?: number
  enabled?: boolean
}

export interface ScheduleTickResult {
  scheduleId: string
  slot: number
  result: EnqueueResult | { accepted: false; code: 'error'; reasons: string[] }
}

export interface CronSchedulerOptions {
  queue: WorkflowRunQueue
  now?: () => number
  /**
   * How far back a tick looks for a missed slot (default 1 hour). Only the most
   * recent missed slot is enqueued, so an outage never causes a stampede.
   */
  catchUpWindowMs?: number
  /** Poll interval for `start()` (default 30 s). */
  tickIntervalMs?: number
  onTick?(results: ScheduleTickResult[]): void
}

/**
 * Enqueues scheduled workflow runs. Each slot uses the idempotency key
 * `schedule:<id>:<ISO minute>`, so restarts, overlapping ticks, or several
 * scheduler replicas never create duplicate runs for the same slot.
 */
export class CronScheduler {
  private readonly queue: WorkflowRunQueue
  private readonly now: () => number
  private readonly catchUpWindowMs: number
  private readonly tickIntervalMs: number
  private readonly onTick?: (results: ScheduleTickResult[]) => void
  private readonly schedules = new Map<string, { config: ScheduledWorkflow; cron: CronSchedule; lastSlot?: number }>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<unknown>

  constructor(options: CronSchedulerOptions) {
    this.queue = options.queue
    this.now = options.now ?? Date.now
    this.catchUpWindowMs = options.catchUpWindowMs ?? 3_600_000
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000
    this.onTick = options.onTick
    if (!Number.isInteger(this.catchUpWindowMs) || this.catchUpWindowMs < 0) throw new Error('catchUpWindowMs must be a non-negative integer.')
    if (!Number.isInteger(this.tickIntervalMs) || this.tickIntervalMs < 1_000) throw new Error('tickIntervalMs must be at least 1000.')
  }

  add(config: ScheduledWorkflow): void {
    if (!config || typeof config.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(config.id)) throw new Error('Schedule id is invalid.')
    if (this.schedules.has(config.id)) throw new Error(`Schedule "${config.id}" already exists.`)
    const cron = parseCron(config.cron)
    this.schedules.set(config.id, { config: { ...config }, cron })
  }

  remove(id: string): boolean {
    return this.schedules.delete(id)
  }

  list(): Array<{ id: string; tenantId: string; cron: string; enabled: boolean; nextRunAt: number | null }> {
    const now = this.now()
    return [...this.schedules.values()].map(({ config, cron }) => ({
      id: config.id, tenantId: config.tenantId, cron: config.cron, enabled: config.enabled !== false, nextRunAt: nextCronTime(cron, now),
    }))
  }

  /** Enqueue the most recent due slot of every enabled schedule. Safe to call repeatedly. */
  async tick(): Promise<ScheduleTickResult[]> {
    const now = this.now()
    const results: ScheduleTickResult[] = []
    for (const entry of this.schedules.values()) {
      if (entry.config.enabled === false) continue
      const slot = previousCronTime(entry.cron, now)
      if (slot === null || now - slot > this.catchUpWindowMs || slot === entry.lastSlot) continue
      const iso = new Date(slot).toISOString().slice(0, 16)
      let result: ScheduleTickResult['result']
      try {
        result = await this.queue.enqueue({
          graph: entry.config.graph,
          input: { ...(isRecord(entry.config.input) ? entry.config.input : entry.config.input === undefined ? {} : { value: entry.config.input }), scheduledFor: new Date(slot).toISOString() },
          tenantId: entry.config.tenantId,
          trigger: { kind: 'schedule', source: entry.config.id },
          idempotencyKey: `schedule:${entry.config.id}:${iso}`,
          ...(entry.config.priority !== undefined ? { priority: entry.config.priority } : {}),
          ...(entry.config.principal ? { principal: entry.config.principal } : {}),
        })
      } catch (error) {
        result = { accepted: false, code: 'error', reasons: [(error as Error).message] }
      }
      // Remember the slot unless it failed transiently (backpressure/error), so the next tick retries it.
      if (result.accepted || (result.code !== 'backpressure' && result.code !== 'error')) entry.lastSlot = slot
      results.push({ scheduleId: entry.config.id, slot, result })
    }
    try {
      if (results.length) this.onTick?.(results)
    } catch {
      // Observability hooks never affect scheduling.
    }
    return results
  }

  start(): void {
    if (this.timer || this.running) return
    const loop = async () => {
      this.running = this.tick().catch(() => undefined)
      await this.running
      this.running = undefined
      if (this.timer !== undefined) this.timer = setTimeout(loop, this.tickIntervalMs)
    }
    this.timer = setTimeout(loop, 0)
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
