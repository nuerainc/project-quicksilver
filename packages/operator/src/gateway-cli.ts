/**
 * Run the channel gateway: the operator answers you on Telegram, Slack,
 * Discord, SMS and email, with one conversation and one memory per person.
 *
 *   npm run operator:gateway -- people add entity-founder "Brodi"
 *   npm run operator:gateway -- code entity-founder      # one-time pairing code (1 hour)
 *   npm run operator:gateway -- people                   # who is paired where
 *   npm run operator:gateway                             # start
 *
 * Channels start when their settings are present (.env):
 *   Telegram  TELEGRAM_BOT_TOKEN
 *   Slack     SLACK_APP_TOKEN, SLACK_BOT_TOKEN
 *   Discord   DISCORD_BOT_TOKEN
 *   SMS       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *   Email     QUICKSILVER_EMAIL_FROM, QUICKSILVER_EMAIL_API_KEY, QUICKSILVER_EMAIL_INBOUND_SECRET
 * SMS and email receive webhooks on QUICKSILVER_GATEWAY_PORT (default 8788)
 * at /inbound/sms and /inbound/email; QUICKSILVER_GATEWAY_PUBLIC_URL is the
 * public address of that server (for Twilio's signature).
 *
 * Every message runs the operator in QUICKSILVER_GATEWAY_WORKSPACE (default
 * ./operator-workspace) in guarded mode; calls that need a person are asked
 * in the chat.
 */
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadRepoEnv } from '@quicksilver/agent/decision-predictor'
import { modelForRole } from '@quicksilver/agent/models'

import { aiSdkDriver } from './ai-driver.ts'
import { FileAuditSink } from './audit.ts'
import { adaptersFromEnv, Gateway, historyAsContext, PairingRegistry } from './channels/index.ts'
import { FileCheckpointStore } from './checkpoints.ts'
import { LocalSandbox } from './sandbox/local.ts'
import { runForPerson } from './setup.ts'
import { AutomationStore, tickAutomations } from './automations.ts'
import { automationRunner } from './automations-cli.ts'
import { denyAll } from './gate.ts'
import { SkillLibrary } from './skills.ts'
import { ensureWorkspace } from './tools/files.ts'

loadRepoEnv()
const env = process.env
const root = env.INIT_CWD ?? process.cwd()
const workspace = await ensureWorkspace(join(root, env.QUICKSILVER_GATEWAY_WORKSPACE ?? 'operator-workspace'))
const dir = join(workspace, '.qs-gateway')
const pairing = new PairingRegistry(join(dir, 'pairing.json'))
const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'people' && rest[0] === 'add') {
  const [, id, ...name] = rest
  if (!id || !name.length) { console.error('Usage: people add <principalId> "<name>" [--no-approve]'); process.exit(1) }
  const noApprove = name.includes('--no-approve')
  await pairing.addPerson({ id, name: name.filter((n) => n !== '--no-approve').join(' '), canApprove: !noApprove })
  console.log(`Added ${id}.`)
  process.exit(0)
}
if (cmd === 'code') {
  if (!rest[0]) { console.error('Usage: code <principalId>'); process.exit(1) }
  console.log(`Pairing code for ${rest[0]}: ${await pairing.createCode(rest[0])}\nSend it to the bot from the account to pair, within an hour. It works once.`)
  process.exit(0)
}
if (cmd === 'people') {
  const s = await pairing.list()
  for (const p of s.people) {
    const ids = Object.entries(s.identities).filter(([, v]) => v === p.id).map(([k]) => k)
    console.log(`${p.id} (${p.name})${p.canApprove ? ' — can approve' : ''}\n  ${ids.length ? ids.join('\n  ') : 'not paired yet'}`)
  }
  process.exit(0)
}
if (cmd === 'unpair') {
  const [channel, sender] = rest
  console.log((await pairing.unpair(channel ?? '', sender ?? '')) ? 'Unpaired.' : 'No such pairing.')
  process.exit(0)
}

const { adapters, sms, email } = adaptersFromEnv(env)
const publicUrl = env.QUICKSILVER_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '')
if (!adapters.length) { console.error('No channel is configured. See the list at the top of packages/operator/src/gateway-cli.ts.'); process.exit(1) }

const sandbox = new LocalSandbox({ workspace })
const checkpoints = new FileCheckpointStore(workspace)
const audit = new FileAuditSink(join(workspace, '.qs-audit', 'gateway.jsonl'))
const skills = new SkillLibrary(env.QUICKSILVER_SKILLS_DIR || join(homedir(), '.quicksilver', 'skills'), workspace)
const model = aiSdkDriver(modelForRole('executor'))

const envr = { workspace, sandbox, checkpoints, audit, skills, model }

const gateway = new Gateway({
  adapters,
  pairing,
  dir,
  log: (l) => console.log(l),
  turn: async ({ person, message, history, approver }) => {
    const result = await runForPerson(envr, {
      goal: message.text,
      personId: person.id,
      mode: 'guarded',
      approver,
      preamble: [
        `You are talking with ${person.name} on ${message.kind}. Reply in plain text suited to a chat: short, no tables. Your finish summary is sent to them as the reply.`,
        historyAsContext(history),
      ],
      options: { maxSteps: 30 },
    })
    const tag = result.status === 'failed' ? '\n\n(I could not verify this worked.)' : result.status === 'stopped' ? '\n\n(I ran out of steps before finishing.)' : ''
    return { reply: `${result.summary}${tag}`, status: result.status }
  },
})

if (sms || email) {
  const port = Number(env.QUICKSILVER_GATEWAY_PORT ?? 8788)
  createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > 1_000_000) req.destroy(); else chunks.push(c) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = new URL(req.url ?? '/', 'http://x').pathname
      let out = { status: 404, body: 'not found' }
      if (req.method === 'POST' && sms && path === sms.path) out = sms.receive(raw, (req.headers['x-twilio-signature'] as string) ?? null)
      else if (req.method === 'POST' && email && path === email.path) out = email.receive(raw, (req.headers['x-quicksilver-timestamp'] as string) ?? null, (req.headers['x-quicksilver-signature'] as string) ?? null)
      res.writeHead(out.status, { 'content-type': out.body.startsWith('<') ? 'text/xml' : 'text/plain' }).end(out.body)
    })
  }).listen(port, '127.0.0.1', () => console.log(`webhooks on 127.0.0.1:${port} (put a tunnel or proxy in front for ${publicUrl ?? 'the public URL'})`))
}

await gateway.start()

// Scheduled automations run here too, with approvals asked in the person's chat.
const automations = new AutomationStore(join(workspace, '.qs-automations', 'automations.json'))
const runAutomation = automationRunner(envr, async (a) => (await gateway.approverFor(a.personId, a.deliver === 'log' ? undefined : a.deliver)) ?? denyAll)
let ticking = false
const tick = async () => {
  if (ticking) return
  ticking = true
  try { await tickAutomations({ store: automations, execute: runAutomation, deliver: (a, text) => gateway.deliver(a.personId, text, a.deliver), log: (l) => console.log(l) }) } catch (e) { console.error(e) } finally { ticking = false }
}
setInterval(() => void tick(), 30_000)
void tick()

console.log(`Gateway running for ${workspace} (automations checked every 30 s). Ctrl+C to stop.`)
process.on('SIGINT', async () => { await gateway.stop(); process.exit(0) })
