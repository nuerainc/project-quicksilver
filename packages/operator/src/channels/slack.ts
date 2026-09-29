/**
 * Slack adapter over Socket Mode (no public address needed). Create a Slack
 * app with Socket Mode on, the `message.im` event, and the chat:write and
 * im:history scopes. Env: SLACK_APP_TOKEN (xapp-…, connections:write) and
 * SLACK_BOT_TOKEN (xoxb-…).
 */
import { defaultSocket, type SocketFactory, type SocketLike } from './socket.ts'
import { chunkText, type ChannelAdapter, type FetchLike, type InboundMessage } from './types.ts'

export class SlackAdapter implements ChannelAdapter {
  readonly kind = 'slack' as const
  readonly id: string
  private readonly o: { appToken: string; botToken: string; fetch: FetchLike; socket: SocketFactory }
  private ws?: SocketLike
  private running = false

  constructor(options: { appToken: string; botToken: string; id?: string; fetch?: FetchLike; socket?: SocketFactory }) {
    if (!options.appToken.startsWith('xapp-')) throw new Error('SLACK_APP_TOKEN must be an app-level token (xapp-…).')
    if (!options.botToken.startsWith('xoxb-')) throw new Error('SLACK_BOT_TOKEN must be a bot token (xoxb-…).')
    this.id = options.id ?? 'slack'
    this.o = { appToken: options.appToken, botToken: options.botToken, fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike), socket: options.socket ?? defaultSocket }
  }

  /** Map one Socket Mode envelope to a message (pure; exported for tests). */
  static toMessage(envelope: any, id = 'slack'): InboundMessage | null {
    const e = envelope?.payload?.event
    if (envelope?.type !== 'events_api' || e?.type !== 'message' || e.subtype || e.bot_id || typeof e.text !== 'string' || !e.user) return null
    return { channel: id, kind: 'slack', senderId: e.user, replyTo: e.channel, text: e.text, messageId: e.client_msg_id ?? e.ts, direct: e.channel_type === 'im' }
  }

  private async connect(onMessage: (m: InboundMessage) => void): Promise<void> {
    const r = await this.o.fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { authorization: `Bearer ${this.o.appToken}` } })
    const body = await r.json()
    if (!body.ok || !body.url) throw new Error(`Slack connection failed: ${body.error ?? r.status}`)
    const ws = this.o.socket(body.url)
    this.ws = ws
    ws.onmessage = (ev) => {
      let env: any
      try { env = JSON.parse(String(ev.data)) } catch { return }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
      if (env.type === 'disconnect') { ws.close(); return }
      const m = SlackAdapter.toMessage(env, this.id)
      if (m) onMessage(m)
    }
    ws.onclose = () => { if (this.running) setTimeout(() => void this.connect(onMessage).catch(() => undefined), 2000) }
    ws.onerror = () => undefined
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.running = true
    await this.connect(onMessage)
  }

  async send(channel: string, text: string): Promise<void> {
    for (const part of chunkText(text, 3900)) {
      await this.o.fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { authorization: `Bearer ${this.o.botToken}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, text: part }) })
    }
  }

  async stop(): Promise<void> { this.running = false; this.ws?.close() }
}
