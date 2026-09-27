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
import { DiscordAdapter, EmailAdapter, Gateway, historyAsContext, PairingRegistry, SlackAdapter, TelegramAdapter, TwilioSmsAdapter, type ChannelAdapter } from './channels/index.ts'
import { FileCheckpointStore } from './checkpoints.ts'
import { Gate } from './gate.ts'
import { runOperator } from './loop.ts'
import { loadProjectContext, MemoryBook, memoryTools, SessionArchive } from './memory.ts'
import { LocalSandbox } from './sandbox/local.ts'
import { SkillLibrary, skillTools } from './skills.ts'
import { EXEC_TOOLS } from './tools/exec.ts'
import { ensureWorkspace, FILE_TOOLS } from './tools/files.ts'

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

const adapters: ChannelAdapter[] = []
const publicUrl = env.QUICKSILVER_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '')
if (env.TELEGRAM_BOT_TOKEN) adapters.push(new TelegramAdapter({ token: env.TELEGRAM_BOT_TOKEN }))
if (env.SLACK_APP_TOKEN && env.SLACK_BOT_TOKEN) adapters.push(new SlackAdapter({ appToken: env.SLACK_APP_TOKEN, botToken: env.SLACK_BOT_TOKEN }))
if (env.DISCORD_BOT_TOKEN) adapters.push(new DiscordAdapter({ token: env.DISCORD_BOT_TOKEN }))
const sms = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && publicUrl
  ? new TwilioSmsAdapter({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM, webhookUrl: `${publicUrl}/inbound/sms` })
  : undefined
if (sms) adapters.push(sms)
const email = env.QUICKSILVER_EMAIL_FROM && env.QUICKSILVER_EMAIL_API_KEY && env.QUICKSILVER_EMAIL_INBOUND_SECRET
  ? new EmailAdapter({ from: env.QUICKSILVER_EMAIL_FROM, apiKey: env.QUICKSILVER_EMAIL_API_KEY, inboundSecret: env.QUICKSILVER_EMAIL_INBOUND_SECRET })
  : undefined
if (email) adapters.push(email)
if (!adapters.length) { console.error('No channel is configured. See the list at the top of packages/operator/src/gateway-cli.ts.'); process.exit(1) }

const sandbox = new LocalSandbox({ workspace })
const checkpoints = new FileCheckpointStore(workspace)
const audit = new FileAuditSink(join(workspace, '.qs-audit', 'gateway.jsonl'))
const skills = new SkillLibrary(env.QUICKSILVER_SKILLS_DIR || join(homedir(), '.quicksilver', 'skills'), workspace)
const model = aiSdkDriver(modelForRole('executor'))

const gateway = new Gateway({
  adapters,
  pairing,
  dir,
  log: (l) => console.log(l),
  turn: async ({ person, message, history, approver }) => {
    // One memory per person, whatever the channel.
    const mdir = join(workspace, '.qs-memory', person.id.replace(/[^a-zA-Z0-9_-]/g, '_'))
    const book = new MemoryBook(join(mdir, 'memory.json'))
    const archive = new SessionArchive(mdir)
    const used: string[] = []
    const project = await loadProjectContext(workspace)
    try {
      const result = await runOperator({
        gate: new Gate([...FILE_TOOLS, ...EXEC_TOOLS, ...memoryTools(book, archive), ...skillTools(skills, used)], { mode: 'guarded', workspace, audit }),
        sandbox, checkpoints, audit, workspace, model, approver,
      }, {
        goal: message.text,
        instructions: [
          `You are talking with ${person.name} on ${message.kind}. Reply in plain text suited to a chat: short, no tables. Your finish summary is sent to them as the reply.`,
          await book.snapshot(), await skills.listing(), historyAsContext(history), project.text,
        ].filter(Boolean).join('\n\n'),
        maxSteps: 30,
      })
      await archive.save(message.text, result, result.messages)
      await skills.recordOutcome(used, result.status)
      const tag = result.status === 'failed' ? '\n\n(I could not verify this worked.)' : result.status === 'stopped' ? '\n\n(I ran out of steps before finishing.)' : ''
      return { reply: `${result.summary}${tag}`, status: result.status }
    } finally {
      archive.close()
    }
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
console.log(`Gateway running for ${workspace}. Ctrl+C to stop.`)
process.on('SIGINT', async () => { await gateway.stop(); process.exit(0) })
