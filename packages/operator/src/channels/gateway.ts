/**
 * The channel gateway: every adapter's messages come here.
 *
 * - Deny by default: only paired people are heard (pairing.ts). An unpaired
 *   sender can only send a pairing code; anything else gets one short
 *   instruction per hour, then silence.
 * - Direct messages only; group chats are ignored (a group is not a person).
 * - One conversation per person across every channel: the history and the
 *   memory follow the person, not the platform.
 * - Approvals in the chat: when a run needs a person, the gateway sends the
 *   call's summary and a short code; "approve CODE" or "deny CODE" from a
 *   person allowed to approve decides it. The code is bound to the call's
 *   hash; no answer in time means no.
 * - One run per person at a time; messages that arrive meanwhile wait.
 * - Messages are de-duplicated by platform id, and rate-limited per person.
 */
import { randomInt } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TokenBucketLimiter } from '@quicksilver/kernel/rate-limit'

import type { ApprovalAnswer, ApprovalRequest, Approver } from '../gate.ts'
import type { PairingRegistry, Person } from './pairing.ts'
import type { ChannelAdapter, InboundMessage } from './types.ts'

export interface ConversationTurn { at: string; channel: string; text: string; reply: string; status?: string }

export interface TurnRequest {
  person: Person
  message: InboundMessage
  /** Recent turns with this person on every channel, oldest first. */
  history: ConversationTurn[]
  /** Asks the person in the chat. */
  approver: Approver
}

export interface TurnResult { reply: string; status?: string }

export interface GatewayOptions {
  adapters: ChannelAdapter[]
  pairing: PairingRegistry
  /** Runs the operator for one message. */
  turn: (req: TurnRequest) => Promise<TurnResult>
  /** Where conversations are kept. */
  dir: string
  /** How long an approval waits in the chat; default 15 minutes. */
  approvalTimeoutMs?: number
  historyTurns?: number
  log?: (line: string) => void
  now?: () => Date
}

interface PendingApproval { code: string; request: ApprovalRequest; personId: string; resolve: (a: ApprovalAnswer) => void; timer: ReturnType<typeof setTimeout> }

const APPROVAL_REPLY = /^\s*(approve|yes|deny|no)\s+([A-Z2-9]{4})\s*$/i

export class Gateway {
  private readonly o: Required<Omit<GatewayOptions, 'log' | 'now'>> & Pick<GatewayOptions, 'log'> & { now: () => Date }
  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly seen = new Map<string, number>()
  private readonly busy = new Set<string>()
  private readonly queued = new Map<string, InboundMessage[]>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly nudged = new Map<string, number>()
  private readonly limiter = new TokenBucketLimiter({ burst: 10, perMinute: 20 })
  /** Settles when every in-flight message has been handled (tests). */
  private inflight: Promise<unknown> = Promise.resolve()

  constructor(options: GatewayOptions) {
    this.o = { approvalTimeoutMs: 15 * 60_000, historyTurns: 12, now: () => new Date(), ...options } as typeof this.o
    for (const a of options.adapters) this.adapters.set(a.id, a)
  }

  async start(): Promise<void> {
    for (const a of this.adapters.values()) {
      await a.start((m) => { this.inflight = this.inflight.then(() => this.handle(m)).catch((e) => this.o.log?.(`! ${(e as Error).message}`)) })
      this.o.log?.(`listening on ${a.id} (${a.kind})`)
    }
  }

  async stop(): Promise<void> {
    for (const p of this.approvals.values()) { clearTimeout(p.timer); p.resolve({ approved: false, by: 'gateway:stopping', callHash: p.request.callHash }) }
    for (const a of this.adapters.values()) await a.stop()
  }

  /** Wait for queued handling (tests). */
  idle(): Promise<unknown> { return this.inflight }

  private async reply(m: InboundMessage, text: string): Promise<void> {
    await this.adapters.get(m.channel)?.send(m.replyTo, text)
  }

  async handle(m: InboundMessage): Promise<void> {
    if (!m.direct || !m.text.trim()) return
    if (m.messageId) {
      const key = `${m.channel}:${m.messageId}`
      if (this.seen.has(key)) return
      this.seen.set(key, Date.now())
      if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value!)
    }
    const person = await this.o.pairing.who(m.channel, m.senderId)
    if (!person) {
      const r = await this.o.pairing.tryPair(m.channel, m.senderId, m.text)
      if (r.paired) { await this.reply(m, `Paired. Hello ${r.paired.name}: this chat now talks to your Quicksilver Operator.`); return }
      if (r.reason === 'rate-limited') return
      if (r.reason === 'invalid') { await this.reply(m, 'That code is not valid or has expired.'); return }
      const key = `${m.channel}:${m.senderId}`
      const last = this.nudged.get(key) ?? 0
      if (Date.now() - last > 3_600_000) { this.nudged.set(key, Date.now()); await this.reply(m, 'This is a private assistant. If you were given a pairing code, send it here.') }
      return
    }

    await this.o.pairing.recordAddress(person.id, m.channel, m.replyTo)

    const a = APPROVAL_REPLY.exec(m.text)
    if (a) {
      const pending = this.approvals.get(a[2]!.toUpperCase())
      if (!pending) { await this.reply(m, 'There is no approval waiting with that code.'); return }
      if (!person.canApprove) { await this.reply(m, 'You are not allowed to approve this.'); return }
      clearTimeout(pending.timer)
      this.approvals.delete(pending.code)
      const approved = /^(approve|yes)$/i.test(a[1]!)
      pending.resolve({ approved, by: person.id, callHash: pending.request.callHash, note: `${approved ? 'Approved' : 'Denied'} in ${m.channel}` })
      await this.reply(m, approved ? 'Approved. Continuing.' : 'Denied. I will not do that.')
      return
    }

    if (!this.limiter.take(person.id).ok) { await this.reply(m, 'Too many messages; give me a minute.'); return }
    if (this.busy.has(person.id)) {
      const q = this.queued.get(person.id) ?? []
      q.push(m)
      this.queued.set(person.id, q)
      await this.reply(m, 'Still working on your last request; this one is next.')
      return
    }
    // Run without blocking the adapter's delivery of approval replies.
    void this.run(person, m)
  }

  private async run(person: Person, first: InboundMessage): Promise<void> {
    this.busy.add(person.id)
    let m: InboundMessage | undefined = first
    try {
      while (m) {
        const history = await this.history(person.id)
        let result: TurnResult
        try {
          const target = { channel: m.channel, replyTo: m.replyTo }
          result = await this.o.turn({ person, message: m, history, approver: (r) => this.ask(person, target, r) })
        } catch (e) {
          result = { reply: `Something went wrong: ${(e as Error).message}`, status: 'error' }
        }
        await this.reply(m, result.reply)
        await this.remember(person.id, { at: this.o.now().toISOString(), channel: m.channel, text: m.text, reply: result.reply, status: result.status })
        m = this.queued.get(person.id)?.shift()
      }
    } finally {
      this.busy.delete(person.id)
      this.queued.delete(person.id)
    }
  }

  /** Send a message to a paired person where they were last seen (scheduled deliveries). */
  async deliver(personId: string, text: string, channel?: string): Promise<boolean> {
    const to = await this.o.pairing.address(personId, channel)
    const adapter = to && this.adapters.get(to.channel)
    if (!to || !adapter) return false
    await adapter.send(to.replyTo, text)
    return true
  }

  /** An approver that asks a person in their chat (for scheduled runs); undefined if they cannot be reached. */
  async approverFor(personId: string, channel?: string): Promise<Approver | undefined> {
    const to = await this.o.pairing.address(personId, channel)
    const people = (await this.o.pairing.list()).people
    const person = people.find((p) => p.id === personId)
    if (!to || !person || !this.adapters.has(to.channel)) return undefined
    return (r) => this.ask(person, to, r)
  }

  /** Ask in a chat; resolves on a reply or the timeout. */
  private ask(person: Person, to: { channel: string; replyTo: string }, request: ApprovalRequest): Promise<ApprovalAnswer> {
    return new Promise((resolve) => {
      let code: string
      do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('') } while (this.approvals.has(code))
      const timer = setTimeout(() => {
        this.approvals.delete(code)
        resolve({ approved: false, by: 'gateway:timeout', callHash: request.callHash, note: 'No answer in time.' })
      }, this.o.approvalTimeoutMs)
      this.approvals.set(code, { code, request, personId: person.id, resolve, timer })
      void this.adapters.get(to.channel)?.send(to.replyTo, `Approval needed: ${request.summary}\n${request.reasons.map((r) => `• ${r}`).join('\n')}\nReply "approve ${code}" or "deny ${code}".`)
    })
  }

  private file(personId: string): string {
    return join(this.o.dir, 'conversations', `${personId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  async history(personId: string): Promise<ConversationTurn[]> {
    try { return (JSON.parse(await readFile(this.file(personId), 'utf8')) as ConversationTurn[]).slice(-this.o.historyTurns) } catch { return [] }
  }

  private async remember(personId: string, turn: ConversationTurn): Promise<void> {
    const all = [...(await this.history(personId)), turn].slice(-200)
    await mkdir(join(this.o.dir, 'conversations'), { recursive: true, mode: 0o700 })
    const f = this.file(personId)
    await writeFile(`${f}.tmp`, JSON.stringify(all), { mode: 0o600 })
    await rename(`${f}.tmp`, f)
  }
}

/** The conversation as context for the next run. */
export function historyAsContext(history: readonly ConversationTurn[]): string {
  if (!history.length) return ''
  return `Recent conversation with this person (all channels, oldest first):\n${history.map((t) => `[${t.at.slice(0, 16)} via ${t.channel}] They said: ${t.text}\nYou replied: ${t.reply}`).join('\n')}`
}
