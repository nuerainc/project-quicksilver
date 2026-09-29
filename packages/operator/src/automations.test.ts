/**
 * Automations (M8 part 5): plain-language schedules compiled to the kernel's
 * cron, time zones across DST, once-per-slot runs with latest-only catch-up,
 * previous results carried forward, costs, and pausing on failure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { automationPreamble, AutomationStore, costSummary, dueSlot, nextRunTime, previewRuns, scheduleToCron, tickAutomations, zoneOffsetMinutes, type Automation } from './index.ts'

test('schedules: plain language compiles to cron; nonsense does not', () => {
  const cases: Record<string, string> = {
    'every weekday at 8am': '0 8 * * 1-5',
    'Every day at 6:30 pm': '30 18 * * *',
    'daily at noon': '0 12 * * *',
    'every 15 minutes': '*/15 * * * *',
    'every hour': '0 * * * *',
    'every 2 hours': '0 */2 * * *',
    'mondays at 9:30': '30 9 * * 1',
    'every tue and thu at 7am': '0 7 * * 2,4',
    'weekends at 10': '0 10 * * 0,6',
    'every month on the 15th at 9am': '0 9 15 * *',
    'first of the month': '0 9 1 * *',
    'at 5pm': '0 17 * * *',
    '0 8 * * 1-5': '0 8 * * 1-5',
    '@daily': '@daily',
  }
  for (const [phrase, cron] of Object.entries(cases)) assert.equal(scheduleToCron(phrase), cron, phrase)
  for (const bad of ['whenever you like', 'every 90 minutes', 'at 25:00', 'every blursday', 'at 13pm']) assert.equal(scheduleToCron(bad), null, bad)
})

test('time zones: 8am Denver is 8am local on both sides of the DST change', () => {
  // DST in the US ends Nov 1 2026 (02:00 local).
  const before = nextRunTime('0 8 * * *', 'America/Denver', Date.UTC(2026, 9, 30, 12))!
  assert.equal(new Date(before).toISOString(), '2026-10-30T14:00:00.000Z', 'MDT = UTC-6')
  const after = nextRunTime('0 8 * * *', 'America/Denver', Date.UTC(2026, 10, 1, 12))!
  assert.equal(new Date(after).toISOString(), '2026-11-01T15:00:00.000Z', 'MST = UTC-7')
  assert.equal(zoneOffsetMinutes('UTC', Date.now()), 0)
  assert.equal(previewRuns('0 8 * * 1-5', 'America/Denver', Date.UTC(2026, 8, 25, 20)).length, 3)
})

async function store() {
  return new AutomationStore(join(await mkdtemp(join(tmpdir(), 'qs-auto-')), 'automations.json'))
}

test('the store refuses unreadable schedules and unknown zones', async () => {
  const s = await store()
  await assert.rejects(s.add({ name: 'x', instructions: 'y', schedule: 'whenever', timeZone: 'UTC', personId: 'p', deliver: 'log' }), /could not read/)
  await assert.rejects(s.add({ name: 'x', instructions: 'y', schedule: 'daily', timeZone: 'Mars/Olympus', personId: 'p', deliver: 'log' }), /Unknown time zone/)
  const a = await s.add({ name: 'Brief', instructions: 'Summarize.', schedule: 'every weekday at 8am', timeZone: 'America/Denver', personId: 'p', deliver: 'telegram' })
  assert.equal(a.schedule.cron, '0 8 * * 1-5')
})

test('scheduling: each slot runs once, and a long outage catches up only the latest slot', async () => {
  const s = await store()
  const created = new Date(Date.UTC(2026, 8, 28, 0, 0))
  const a = await s.add({ name: 'Hourly', instructions: 'Check.', schedule: 'every hour', timeZone: 'UTC', personId: 'p', deliver: 'log' }, created)
  assert.equal(dueSlot(a, created.getTime() + 30 * 60_000), null, 'nothing due before the first slot')
  let runs = 0
  const deps = { store: s, execute: async () => { runs++; return { status: 'done-unverified' as const, summary: 'ok', tokens: 100 } }, deliver: async () => true }
  await tickAutomations({ ...deps, now: () => created.getTime() + 10 * 3_600_000 + 5 * 60_000 })
  assert.equal(runs, 1, 'ten missed hours run once')
  await tickAutomations({ ...deps, now: () => created.getTime() + 10 * 3_600_000 + 30 * 60_000 })
  assert.equal(runs, 1, 'the same slot does not run twice')
  await tickAutomations({ ...deps, now: () => created.getTime() + 11 * 3_600_000 + 1 * 60_000 })
  assert.equal(runs, 2)
})

test('scheduling: results are delivered, carried into the next run, costed, and failures pause it', async () => {
  const s = await store()
  const t0 = Date.UTC(2026, 8, 28, 0, 0)
  const a = await s.add({ name: 'Brief', instructions: 'Summarize.', schedule: 'every hour', timeZone: 'UTC', personId: 'p', deliver: 'telegram' }, new Date(t0))
  const sent: string[] = []
  let outcome: any = { status: 'verified', summary: '3 new invoices.', tokens: 2_000_000 }
  const deps = { store: s, execute: async () => outcome, deliver: async (_a: Automation, text: string) => { sent.push(text); return true } }
  await tickAutomations({ ...deps, now: () => t0 + 3_600_000 + 60_000 })
  assert.match(sent[0]!, /Brief:\n3 new invoices\./)
  const after = (await s.get(a.id))!
  assert.match(automationPreamble(after, t0).join('\n'), /Last run .* reported:\n3 new invoices\./)
  assert.deepEqual(costSummary(after, t0 + 2 * 3_600_000, { inputPerMillion: 2, outputPerMillion: 8 }), { runs: 1, tokens: 2_000_000, usd: 10 })

  outcome = { status: 'failed', summary: 'checks failed', tokens: 10 }
  for (let h = 2; h <= 4; h++) await tickAutomations({ ...deps, now: () => t0 + h * 3_600_000 + 60_000 })
  const paused = (await s.get(a.id))!
  assert.equal(paused.enabled, false)
  assert.match(paused.pausedReason!, /3 runs in a row/)
  assert.ok(sent.some((x) => /is paused/.test(x)))
  await tickAutomations({ ...deps, now: () => t0 + 5 * 3_600_000 + 60_000 })
  assert.equal((await s.get(a.id))!.runs.length, 4, 'a paused automation does not run')

  await s.setEnabled(a.id, true)
  outcome = undefined
  const boom = { ...deps, execute: async () => { throw new Error('model quota exceeded') } }
  await tickAutomations({ ...boom, now: () => t0 + 6 * 3_600_000 + 60_000 })
  assert.match((await s.get(a.id))!.pausedReason!, /model quota exceeded/, 'a provider error pauses at once')
})
