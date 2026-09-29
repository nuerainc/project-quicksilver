/**
 * Automations (M8 part 5): the operator on a schedule.
 *
 * - Schedules are written in plain language ("every weekday at 8am",
 *   "every 15 minutes", "mondays at 9:30") and compiled to the kernel's
 *   five-field cron (`@quicksilver/kernel/triggers`), in the person's time
 *   zone. Anything the phrase parser does not understand can be given as
 *   cron directly; either way the next run times are shown before saving.
 * - Each slot runs once: the store records the last slot run, and a missed
 *   stretch (the machine was off) catches up only the latest missed slot,
 *   the same rule as the kernel's cron scheduler.
 * - Results are delivered to the person on a channel, or kept in the run log.
 * - Each automation remembers its previous result, so it can report what is
 *   new instead of repeating itself.
 * - Costs: tokens per run and a trailing 30-day total (and dollars, when
 *   prices are set).
 * - Safety: scheduled runs are unattended. Calls that need a person are
 *   asked in the person's chat when the gateway is running; otherwise they
 *   are denied. After three failed runs in a row, or a model or provider
 *   error, the automation pauses itself and says why.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

import { nextCronTime, parseCron, previousCronTime, validateCron } from '@quicksilver/kernel/triggers'

import type { RunStatus } from './loop.ts'

// ---------------------------------------------------------------------------
// Time zones on top of the kernel's UTC cron

/** Minutes the zone is ahead of UTC at instant `t`. */
export function zoneOffsetMinutes(timeZone: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t))
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
  return Math.round((wall - Math.floor(t / 60_000) * 60_000) / 60_000)
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** The next instant after `after` whose wall-clock time in `timeZone` matches `cron`. */
export function nextRunTime(cron: string, timeZone: string, after: number): number | null {
  const off = zoneOffsetMinutes(timeZone, after) * 60_000
  const wall = nextCronTime(cron, after + off)
  if (wall === null) return null
  // Convert the wall-clock match back to an instant (twice, for DST edges).
  let t = wall - zoneOffsetMinutes(timeZone, wall - off) * 60_000
  t = wall - zoneOffsetMinutes(timeZone, t) * 60_000
  return t > after ? t : nextRunTime(cron, timeZone, after + 60_000)
}

/** The latest slot at or before `at`, as an instant. */
export function previousRunTime(cron: string, timeZone: string, at: number): number | null {
  const off = zoneOffsetMinutes(timeZone, at) * 60_000
  const wall = previousCronTime(cron, at + off)
  if (wall === null) return null
  const t = wall - zoneOffsetMinutes(timeZone, wall - off) * 60_000
  return t <= at ? t : previousRunTime(cron, timeZone, at - 60_000)
}

// ---------------------------------------------------------------------------
// Plain-language schedules

const DAYS: Record<string, number> = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 }

function parseClock(text: string): { h: number; m: number } | null {
  const t = text.trim().toLowerCase()
  if (t === 'noon' || t === 'midday') return { h: 12, m: 0 }
  if (t === 'midnight') return { h: 0, m: 0 }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const ap = m[3]?.replace(/\./g, '')
  if (min > 59 || h > 23 || (ap && (h < 1 || h > 12))) return null
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return { h, m: min }
}

/**
 * Compile a plain-language schedule to cron. Returns null when the phrase is
 * not understood (then give cron directly). Pure.
 */
export function scheduleToCron(phrase: string): string | null {
  let p = phrase.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^every\s+/, 'every ')
  if (!validateCron(p)) return p // already cron (or a @macro)
  p = p.replace(/[.,]$/, '')
  const at = /(?:\bat\s+)(.+)$/.exec(p)
  const clock = at ? parseClock(at[1]!) : null
  if (at && !clock) return null
  const body = at ? p.slice(0, at.index).trim() : p
  const hm = clock ?? { h: 9, m: 0 }

  let m: RegExpExecArray | null
  if ((m = /^every (\d{1,2}) minutes?$/.exec(body)) && !at) { const n = Number(m[1]); return n >= 1 && n <= 59 ? `*/${n} * * * *` : null }
  if (body === 'every minute' && !at) return '* * * * *'
  if (body === 'every hour' || body === 'hourly') return `${clock ? clock.m : 0} * * * *`
  if ((m = /^every (\d{1,2}) hours?$/.exec(body))) { const n = Number(m[1]); return n >= 1 && n <= 23 ? `${clock ? clock.m : 0} */${n} * * *` : null }
  if (['every day', 'daily', 'each day', 'every morning', 'every evening', 'every night'].includes(body) || (body === '' && at)) {
    const h = !clock && body === 'every evening' ? 18 : !clock && body === 'every night' ? 21 : hm.h
    return `${hm.m} ${h} * * *`
  }
  if (['every weekday', 'weekdays', 'on weekdays', 'every workday'].includes(body)) return `${hm.m} ${hm.h} * * 1-5`
  if (['every weekend', 'weekends', 'on weekends'].includes(body)) return `${hm.m} ${hm.h} * * 0,6`
  if (body === 'every week' || body === 'weekly') return `${hm.m} ${hm.h} * * 1`
  if (body === 'every month' || body === 'monthly' || body === 'first of the month' || body === 'every first of the month' || body === 'on the first of the month') return `${hm.m} ${hm.h} 1 * *`
  if ((m = /^(?:every month on the |on the |every )(\d{1,2})(?:st|nd|rd|th)(?: of (?:the|each|every) month)?$/.exec(body))) {
    const d = Number(m[1]); return d >= 1 && d <= 31 ? `${hm.m} ${hm.h} ${d} * *` : null
  }
  // "every monday", "mondays", "monday and thursday", "every tue, thu"
  const dayWords = body.replace(/^every /, '').replace(/^on /, '').split(/\s*(?:,|and|&)\s*/).map((w) => w.replace(/s$/, '').trim()).filter(Boolean)
  if (dayWords.length && dayWords.every((w) => w in DAYS)) return `${hm.m} ${hm.h} * * ${[...new Set(dayWords.map((w) => DAYS[w]!))].sort().join(',')}`
  return null
}

/** Human-readable preview: the next few run times in the zone. */
export function previewRuns(cron: string, timeZone: string, from: number, count = 3): string[] {
  const out: string[] = []
  let t = from
  for (let i = 0; i < count; i++) {
    const n = nextRunTime(cron, timeZone, t)
    if (n === null) break
    out.push(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(n)))
    t = n
  }
  return out
}

// ---------------------------------------------------------------------------
// Automations and their store

export interface Automation {
  id: string
  name: string
  /** What the operator does each time. */
  instructions: string
  /** The phrase the person wrote, and the cron it compiled to. */
  schedule: { phrase: string; cron: string; timeZone: string }
  /** Who it runs for (their memory; approvals and results go to them). */
  personId: string
  /** Where results go: a channel id, or "log" to keep them in the run log only. */
  deliver: string
  verify?: string[]
  enabled: boolean
  pausedReason?: string
  createdAt: string
  lastSlot?: string
  lastResult?: { at: string; status: RunStatus | 'error'; summary: string; runId?: string }
  consecutiveFailures: number
  runs: Array<{ at: string; status: RunStatus | 'error'; tokens: number; runId?: string }>
}

export interface Prices { inputPerMillion?: number; outputPerMillion?: number }

export class AutomationStore {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(path: string) { this.path = path }

  async list(): Promise<Automation[]> {
    try { return (JSON.parse(await readFile(this.path, 'utf8')) as { automations: Automation[] }).automations } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }

  async get(id: string): Promise<Automation | undefined> { return (await this.list()).find((a) => a.id === id) }

  update<T>(fn: (all: Automation[]) => { all: Automation[]; result: T }): Promise<T> {
    const run = async () => {
      const { all, result } = fn(await this.list())
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(`${this.path}.tmp`, JSON.stringify({ automations: all }, null, 1), { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
      return result
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p as Promise<T>
  }

  /** Create from a plain-language schedule (or cron). Throws with a clear message on a bad schedule or zone. */
  async add(input: { name: string; instructions: string; schedule: string; timeZone: string; personId: string; deliver: string; verify?: string[] }, now = new Date()): Promise<Automation> {
    const cron = scheduleToCron(input.schedule)
    if (!cron) throw new Error(`I could not read the schedule "${input.schedule}". Try "every weekday at 8am", "mondays at 9:30", "every 2 hours", or a five-field cron like "0 8 * * 1-5".`)
    const bad = validateCron(cron)
    if (bad) throw new Error(bad)
    if (!validTimeZone(input.timeZone)) throw new Error(`Unknown time zone "${input.timeZone}" (use an IANA name like America/Denver).`)
    parseCron(cron)
    if (!input.instructions.trim()) throw new Error('Say what the automation should do.')
    const a: Automation = {
      id: `auto-${randomBytes(4).toString('hex')}`, name: input.name.trim() || input.instructions.slice(0, 40),
      instructions: input.instructions.trim(), schedule: { phrase: input.schedule, cron, timeZone: input.timeZone },
      personId: input.personId, deliver: input.deliver, ...(input.verify?.length ? { verify: input.verify } : {}),
      enabled: true, createdAt: now.toISOString(), lastSlot: new Date(now.getTime()).toISOString(), consecutiveFailures: 0, runs: [],
    }
    return this.update((all) => ({ all: [...all, a], result: a }))
  }

  setEnabled(id: string, enabled: boolean, reason?: string): Promise<boolean> {
    return this.update((all) => {
      const a = all.find((x) => x.id === id)
      if (!a) return { all, result: false }
      a.enabled = enabled
      if (enabled) { delete a.pausedReason; a.consecutiveFailures = 0 } else if (reason) a.pausedReason = reason
      return { all, result: true }
    })
  }

  remove(id: string): Promise<boolean> {
    return this.update((all) => ({ all: all.filter((a) => a.id !== id), result: all.some((a) => a.id === id) }))
  }
}

/** The slot due now for an automation, or null. Catches up only the latest missed slot. Pure. */
export function dueSlot(a: Automation, now: number): number | null {
  if (!a.enabled) return null
  const slot = previousRunTime(a.schedule.cron, a.schedule.timeZone, now)
  if (slot === null) return null
  const last = a.lastSlot ? Date.parse(a.lastSlot) : -Infinity
  return slot > last ? slot : null
}

/** Trailing 30-day tokens, runs and (with prices) dollars. Pure. */
export function costSummary(a: Automation, now: number, prices: Prices = {}): { runs: number; tokens: number; usd?: number } {
  const recent = a.runs.filter((r) => now - Date.parse(r.at) <= 30 * 86_400_000)
  const tokens = recent.reduce((n, r) => n + r.tokens, 0)
  const rate = prices.inputPerMillion !== undefined && prices.outputPerMillion !== undefined ? (prices.inputPerMillion + prices.outputPerMillion) / 2 : undefined
  return { runs: recent.length, tokens, ...(rate !== undefined ? { usd: Math.round((tokens / 1e6) * rate * 100) / 100 } : {}) }
}

export const PAUSE_AFTER_FAILURES = 3

export interface AutomationRunOutcome { status: RunStatus | 'error'; summary: string; runId?: string; tokens: number; error?: string }

export interface SchedulerDeps {
  store: AutomationStore
  /** Runs one automation (the caller wires runForPerson, approvals and the model). */
  execute: (a: Automation) => Promise<AutomationRunOutcome>
  /** Sends text to the automation's person on its channel; false when that is not possible. */
  deliver: (a: Automation, text: string) => Promise<boolean>
  now?: () => number
  log?: (line: string) => void
}

/** Check every automation once and run the ones that are due, one at a time. */
export async function tickAutomations(deps: SchedulerDeps): Promise<string[]> {
  const now = (deps.now ?? Date.now)()
  const ran: string[] = []
  for (const a of await deps.store.list()) {
    const slot = dueSlot(a, now)
    if (slot === null) continue
    // Claim the slot first, so a crash mid-run does not run it twice.
    await deps.store.update((all) => { const x = all.find((y) => y.id === a.id); if (x) x.lastSlot = new Date(slot).toISOString(); return { all, result: null } })
    deps.log?.(`running ${a.id} (${a.name})`)
    let outcome: AutomationRunOutcome
    try { outcome = await deps.execute(a) } catch (e) { outcome = { status: 'error', summary: '', tokens: 0, error: (e as Error).message } }
    const failed = outcome.status === 'failed' || outcome.status === 'stopped' || outcome.status === 'error'
    const at = new Date(now).toISOString()
    let pausedWhy: string | undefined
    await deps.store.update((all) => {
      const x = all.find((y) => y.id === a.id)
      if (!x) return { all, result: null }
      x.lastResult = { at, status: outcome.status, summary: outcome.error ? `Error: ${outcome.error}` : outcome.summary, ...(outcome.runId ? { runId: outcome.runId } : {}) }
      x.runs = [...x.runs, { at, status: outcome.status, tokens: outcome.tokens, ...(outcome.runId ? { runId: outcome.runId } : {}) }].slice(-500)
      x.consecutiveFailures = failed ? x.consecutiveFailures + 1 : 0
      if (outcome.status === 'error') pausedWhy = `The model or a provider failed: ${outcome.error}`
      else if (x.consecutiveFailures >= PAUSE_AFTER_FAILURES) pausedWhy = `${x.consecutiveFailures} runs in a row did not finish.`
      if (pausedWhy) { x.enabled = false; x.pausedReason = pausedWhy }
      return { all, result: null }
    })
    const text = outcome.status === 'error'
      ? `⚠ "${a.name}" could not run: ${outcome.error}`
      : `${a.name}:\n${outcome.summary}${failed ? '\n\n(This run did not finish cleanly.)' : ''}`
    if (a.deliver !== 'log') await deps.deliver(a, text).catch(() => false)
    if (pausedWhy) await deps.deliver(a, `"${a.name}" is paused: ${pausedWhy} Resume it with: npm run operator:auto -- resume ${a.id}`).catch(() => false)
    ran.push(a.id)
  }
  return ran
}

/** The context an automation's run gets: what it is, and what it reported last time. */
export function automationPreamble(a: Automation, now: number): string[] {
  return [
    `This is a scheduled automation, "${a.name}" (${a.schedule.phrase}), running unattended at ${new Date(now).toISOString()}. No one is watching: anything that needs a person will be asked in their chat or skipped.`,
    a.deliver !== 'log' ? 'Your finish summary is sent to the person as the automation\'s report: make it short and useful on its own.' : 'Your finish summary is kept in the run log.',
    a.lastResult ? `Last run (${a.lastResult.at}, ${a.lastResult.status}) reported:\n${a.lastResult.summary}\nReport what is new or changed since then rather than repeating it.` : 'This is the first run.',
  ]
}
