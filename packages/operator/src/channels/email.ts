/**
 * Email. Inbound mail arrives as a signed JSON webhook from your mail
 * provider's inbound route (fields: from, to, subject, text, messageId),
 * verified with the kernel's webhook signature scheme
 * (x-quicksilver-timestamp and x-quicksilver-signature over the raw body).
 * Outbound mail goes through an HTTP mail API (Resend-compatible:
 * POST {from, to, subject, text}).
 * Env: QUICKSILVER_EMAIL_FROM, QUICKSILVER_EMAIL_API_KEY,
 * QUICKSILVER_EMAIL_INBOUND_SECRET (32+ characters).
 */
import { timingSafeEqual } from 'node:crypto'

import { signWebhook } from '@quicksilver/kernel/triggers'

import type { ChannelAdapter, FetchLike, InboundMessage } from './types.ts'

export class EmailAdapter implements ChannelAdapter {
  readonly kind = 'email' as const
  readonly id: string
  private readonly o: { from: string; apiKey: string; inboundSecret: string; apiUrl: string; path: string; fetch: FetchLike; maxSkewSeconds: number }
  private onMessage?: (m: InboundMessage) => void
  private readonly subjects = new Map<string, string>()

  constructor(options: { from: string; apiKey: string; inboundSecret: string; apiUrl?: string; path?: string; id?: string; fetch?: FetchLike }) {
    if (options.inboundSecret.length < 32) throw new Error('QUICKSILVER_EMAIL_INBOUND_SECRET must be at least 32 characters.')
    this.id = options.id ?? 'email'
    this.o = { apiUrl: 'https://api.resend.com/emails', path: '/inbound/email', maxSkewSeconds: 300, fetch: globalThis.fetch as unknown as FetchLike, ...options }
  }

  get path(): string { return this.o.path }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> { this.onMessage = onMessage }

  receive(rawBody: string, timestamp: string | null, signature: string | null, now = Date.now()): { status: number; body: string } {
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > this.o.maxSkewSeconds || !signature) return { status: 403, body: 'invalid signature' }
    const expected = Buffer.from(signWebhook(this.o.inboundSecret, ts, rawBody))
    const got = Buffer.from(signature)
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { status: 403, body: 'invalid signature' }
    let mail: { from?: string; subject?: string; text?: string; messageId?: string }
    try { mail = JSON.parse(rawBody) } catch { return { status: 400, body: 'invalid json' } }
    const from = /<([^>]+)>/.exec(mail.from ?? '')?.[1] ?? mail.from ?? ''
    if (!from.includes('@') || !mail.text) return { status: 200, body: 'ignored' }
    this.subjects.set(from.toLowerCase(), mail.subject ?? '')
    // Keep only the new text, not the quoted thread below it.
    const text = mail.text.split(/\n(?:On .+wrote:|-{2,} ?Original Message|>)/)[0]!.trim()
    this.onMessage?.({ channel: this.id, kind: 'email', senderId: from.toLowerCase(), replyTo: from.toLowerCase(), text, messageId: mail.messageId, direct: true })
    return { status: 200, body: 'ok' }
  }

  async send(to: string, text: string): Promise<void> {
    const subject = this.subjects.get(to) ?? ''
    await this.o.fetch(this.o.apiUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.o.from, to, subject: subject ? (subject.startsWith('Re:') ? subject : `Re: ${subject}`) : 'Quicksilver', text }),
    })
  }

  async stop(): Promise<void> { this.onMessage = undefined }
}
