/**
 * Scheduled automations.
 *
 *   npm run operator:auto -- add "every weekday at 8am" "Summarize yesterday's decisions and anything overdue" \
 *        --name "Morning brief" --for entity-founder --deliver telegram --tz America/Denver
 *   npm run operator:auto -- list          # schedules, next runs, last results, 30-day cost
 *   npm run operator:auto -- run <id>      # run one now
 *   npm run operator:auto -- pause <id> | resume <id> | remove <id>
 *   npm run operator:auto -- serve         # run due automations (without chat approvals)
 *
 * The channel gateway (npm run operator:gateway) also runs due automations,
 * and there calls that need a person are asked in their chat. `--deliver log`
 * keeps results in the run log only. Prices for the cost column:
 * QUICKSILVER_PRICE_INPUT_PER_M and QUICKSILVER_PRICE_OUTPUT_PER_M (USD per
 * million tokens).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadRepoEnv } from '@quicksilver/agent/decision-predictor'
import { modelForRole } from '@quicksilver/agent/models'

import { aiSdkDriver } from './ai-driver.ts'
import { FileAuditSink } from './audit.ts'
import { AutomationStore, automationPreamble, costSummary, nextRunTime, previewRuns, tickAutomations, type Automation, type AutomationRunOutcome, type Prices } from './automations.ts'
import { adaptersFromEnv, PairingRegistry, type ChannelAdapter } from './channels/index.ts'
import { FileCheckpointStore } from './checkpoints.ts'
import { denyAll, type Approver } from './gate.ts'
import { LocalSandbox } from './sandbox/local.ts'
import { runForPerson, type OperatorEnvironment } from './setup.ts'
import { SkillLibrary } from './skills.ts'
import { ensureWorkspace } from './tools/files.ts'

/** Everything an automation run needs; shared with the gateway. */
export function automationRunner(envr: OperatorEnvironment, approverFor: (a: Automation) => Promise<Approver>, now: () => number = Date.now) {
  return async (a: Automation): Promise<AutomationRunOutcome> => {
    const r = await runForPerson(envr, {
      goal: a.instructions,
      personId: a.personId,
      mode: 'guarded',
      approver: await approverFor(a),
      preamble: automationPreamble(a, now()),
      options: { maxSteps: 30, ...(a.verify?.length ? { verify: a.verify } : {}) },
    })
    return { status: r.status, summary: r.summary, runId: r.runId, tokens: r.usage.inputTokens + r.usage.outputTokens }
  }
}

/** Send to a paired person through an adapter (send-only; no listening needed). */
export function senderFor(adapters: ChannelAdapter[], pairing: PairingRegistry) {
  return async (a: Automation, text: string): Promise<boolean> => {
    const to = await pairing.address(a.personId, a.deliver)
    const adapter = adapters.find((x) => x.id === to?.channel)
    if (!to || !adapter) return false
    await adapter.send(to.replyTo, text)
    return true
  }
}

export function pricesFromEnv(env: Readonly<Record<string, string | undefined>>): Prices {
  const i = Number(env.QUICKSILVER_PRICE_INPUT_PER_M)
  const o = Number(env.QUICKSILVER_PRICE_OUTPUT_PER_M)
  return Number.isFinite(i) && Number.isFinite(o) && env.QUICKSILVER_PRICE_INPUT_PER_M && env.QUICKSILVER_PRICE_OUTPUT_PER_M ? { inputPerMillion: i, outputPerMillion: o } : {}
}

async function main() {
  loadRepoEnv()
  const env = process.env
  const root = env.INIT_CWD ?? process.cwd()
  const workspace = await ensureWorkspace(join(root, env.QUICKSILVER_GATEWAY_WORKSPACE ?? 'operator-workspace'))
  const store = new AutomationStore(join(workspace, '.qs-automations', 'automations.json'))
  const pairing = new PairingRegistry(join(workspace, '.qs-gateway', 'pairing.json'))
  const argv = process.argv.slice(2)
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
  const verify: string[] = []
  for (let v = flag('verify'); v !== undefined; v = flag('verify')) verify.push(v)
  const name = flag('name')
  const personId = flag('for') ?? env.NQC_SUPERVISOR_ID ?? 'local-human'
  const deliver = flag('deliver') ?? 'log'
  const tz = flag('tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const [cmd, ...rest] = argv

  const envr = (): OperatorEnvironment => ({
    workspace,
    sandbox: new LocalSandbox({ workspace }),
    checkpoints: new FileCheckpointStore(workspace),
    audit: new FileAuditSink(join(workspace, '.qs-audit', 'automations.jsonl')),
    skills: new SkillLibrary(env.QUICKSILVER_SKILLS_DIR || join(homedir(), '.quicksilver', 'skills'), workspace),
    model: aiSdkDriver(modelForRole('executor')),
  })

  switch (cmd) {
    case 'add': {
      const [schedule, instructions] = rest
      if (!schedule || !instructions) throw new Error('Usage: add "<schedule>" "<what to do>" [--name n] [--for personId] [--deliver channel|log] [--tz Zone] [--verify cmd]')
      const a = await store.add({ name: name ?? instructions.slice(0, 40), instructions, schedule, timeZone: tz, personId, deliver, verify })
      console.log(`Added ${a.id}: "${a.name}" — ${a.schedule.phrase} (cron ${a.schedule.cron}, ${tz}).\nNext runs: ${previewRuns(a.schedule.cron, tz, Date.now()).join(' · ')}\nResults go to: ${deliver === 'log' ? 'the run log' : `${a.personId} on ${deliver}`}`)
      if (deliver !== 'log' && !(await pairing.address(personId, deliver))) console.log(`Note: ${personId} has not messaged the bot on ${deliver} yet, so there is no address to deliver to. Send it any message once.`)
      return
    }
    case 'list': {
      const all = await store.list()
      if (!all.length) { console.log('No automations.'); return }
      const prices = pricesFromEnv(env)
      for (const a of all) {
        const next = a.enabled ? nextRunTime(a.schedule.cron, a.schedule.timeZone, Date.now()) : null
        const c = costSummary(a, Date.now(), prices)
        console.log(`${a.id}  ${a.enabled ? 'on ' : 'OFF'}  "${a.name}" — ${a.schedule.phrase} (${a.schedule.timeZone})`)
        console.log(`   next: ${next ? new Date(next).toLocaleString('en-US', { timeZone: a.schedule.timeZone }) : '—'}   30 days: ${c.runs} runs, ${c.tokens.toLocaleString()} tokens${c.usd !== undefined ? `, $${c.usd}` : ''}`)
        if (a.pausedReason) console.log(`   paused: ${a.pausedReason}`)
        if (a.lastResult) console.log(`   last (${a.lastResult.status}): ${a.lastResult.summary.split('\n')[0]!.slice(0, 120)}`)
      }
      return
    }
    case 'pause': case 'resume': case 'remove': {
      const id = rest[0] ?? ''
      const ok = cmd === 'remove' ? await store.remove(id) : await store.setEnabled(id, cmd === 'resume', cmd === 'pause' ? 'Paused by hand.' : undefined)
      console.log(ok ? `${cmd === 'remove' ? 'Removed' : cmd === 'pause' ? 'Paused' : 'Resumed'} ${id}.` : `No automation "${id}".`)
      return
    }
    case 'run': {
      const a = await store.get(rest[0] ?? '')
      if (!a) throw new Error(`No automation "${rest[0]}".`)
      const { adapters } = adaptersFromEnv(env)
      const out = await automationRunner(envr(), async () => denyAll)(a)
      console.log(`${out.status.toUpperCase()} — ${out.summary}`)
      if (a.deliver !== 'log') console.log((await senderFor(adapters, pairing)(a, `${a.name}:\n${out.summary}`)) ? `Delivered on ${a.deliver}.` : `Could not deliver on ${a.deliver}.`)
      return
    }
    case 'serve': {
      const { adapters } = adaptersFromEnv(env)
      const e = envr()
      const tick = () => tickAutomations({ store, execute: automationRunner(e, async () => denyAll), deliver: senderFor(adapters, pairing), log: (l) => console.log(l) }).catch((err) => console.error(err))
      console.log('Running due automations every 30 s (approvals are denied here; run the gateway for approvals in chat). Ctrl+C to stop.')
      await tick()
      setInterval(tick, 30_000)
      return
    }
    default:
      console.log('Commands: add, list, run <id>, pause <id>, resume <id>, remove <id>, serve. See the top of packages/operator/src/automations-cli.ts.')
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('automations-cli.ts')) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1) })
}
