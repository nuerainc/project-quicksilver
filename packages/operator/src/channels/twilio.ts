/**
 * SMS through Twilio. Inbound messages arrive as webhooks (form-encoded) at
 * the gateway's HTTP server and are checked against Twilio's signature
 * (HMAC-SHA1 of the full URL and the sorted form fields with the auth
 * token); outbound messages use the REST API.
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (your number),
 * and the public URL of the webhook (QUICKSILVER_GATEWAY_PUBLIC_URL).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

import { chunkText, type ChannelAdapter, type FetchLike, type InboundMessage } from './types.ts'

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!signature) return false
  const a = Buffer.from(twilioSignature(authToken, url, params))
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class TwilioSmsAdapter implements ChannelAdapter {
  readonly kind = 'sms' as const
  readonly id: string
  private readonly o: { accountSid: string; authToken: string; from: string; webhookUrl: string; fetch: FetchLike }
  private onMessage?: (m: InboundMessage) => void

  constructor(options: { accountSid: string; authToken: string; from: string; webhookUrl: string; id?: string; fetch?: FetchLike }) {
    if (!/^AC[0-9a-f]{32}$/i.test(options.accountSid)) throw new Error('TWILIO_ACCOUNT_SID must start with AC.')
    this.id = options.id ?? 'sms'
    this.o = { ...options, fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike) }
  }

  /** The path the gateway's HTTP server routes to this adapter. */
  get path(): string { return new URL(this.o.webhookUrl).pathname }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> { this.onMessage = onMessage }

  /** Handle one webhook: 403 on a bad signature, else 200 with empty TwiML. */
  receive(rawBody: string, signature: string | null): { status: number; body: string } {
    const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>
    if (!verifyTwilio(this.o.authToken, this.o.webhookUrl, params, signature)) return { status: 403, body: 'invalid signature' }
    if (params.From && typeof params.Body === 'string') {
      this.onMessage?.({ channel: this.id, kind: 'sms', senderId: params.From, replyTo: params.From, text: params.Body, messageId: params.MessageSid, direct: true })
    }
    return { status: 200, body: '<Response></Response>' }
  }

  async send(to: string, text: string): Promise<void> {
    const auth = Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64')
    for (const part of chunkText(text, 1500)) {
      await this.o.fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.o.accountSid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: this.o.from, Body: part }).toString(),
      })
    }
  }

  async stop(): Promise<void> { this.onMessage = undefined }
}
