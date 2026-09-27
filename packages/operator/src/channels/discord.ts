/**
 * Discord adapter over the Gateway (no public address needed). Create a bot
 * in the Discord developer portal with the Message Content intent, and give
 * its token as DISCORD_BOT_TOKEN. Direct messages only.
 */
import { defaultSocket, type SocketFactory, type SocketLike } from './socket.ts'
import { chunkText, type ChannelAdapter, type FetchLike, type InboundMessage } from './types.ts'

const INTENTS = (1 << 12) | (1 << 15) // DIRECT_MESSAGES | MESSAGE_CONTENT

export class DiscordAdapter implements ChannelAdapter {
  readonly kind = 'discord' as const
  readonly id: string
  private readonly o: { token: string; fetch: FetchLike; socket: SocketFactory; gatewayUrl: string }
  private ws?: SocketLike
  private heartbeat?: ReturnType<typeof setInterval>
  private seq: number | null = null
  private running = false

  constructor(options: { token: string; id?: string; fetch?: FetchLike; socket?: SocketFactory; gatewayUrl?: string }) {
    if (options.token.length < 50) throw new Error('DISCORD_BOT_TOKEN does not look like a bot token.')
    this.id = options.id ?? 'discord'
    this.o = { token: options.token, fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike), socket: options.socket ?? defaultSocket, gatewayUrl: options.gatewayUrl ?? 'wss://gateway.discord.gg/?v=10&encoding=json' }
  }

  /** Map one MESSAGE_CREATE payload to a message (pure; exported for tests). */
  static toMessage(d: any, id = 'discord'): InboundMessage | null {
    if (!d || typeof d.content !== 'string' || !d.author || d.author.bot) return null
    return { channel: id, kind: 'discord', senderId: String(d.author.id), senderName: d.author.username, replyTo: String(d.channel_id), text: d.content, messageId: String(d.id), direct: !d.guild_id }
  }

  private connect(onMessage: (m: InboundMessage) => void): void {
    const ws = this.o.socket(this.o.gatewayUrl)
    this.ws = ws
    ws.onmessage = (ev) => {
      let p: any
      try { p = JSON.parse(String(ev.data)) } catch { return }
      if (typeof p.s === 'number') this.seq = p.s
      if (p.op === 10) {
        clearInterval(this.heartbeat)
        this.heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: this.seq })), p.d.heartbeat_interval)
        ws.send(JSON.stringify({ op: 2, d: { token: this.o.token, intents: INTENTS, properties: { os: 'linux', browser: 'quicksilver', device: 'quicksilver' } } }))
      } else if (p.op === 1) {
        ws.send(JSON.stringify({ op: 1, d: this.seq }))
      } else if (p.op === 7 || p.op === 9) {
        ws.close()
      } else if (p.op === 0 && p.t === 'MESSAGE_CREATE') {
        const m = DiscordAdapter.toMessage(p.d, this.id)
        if (m) onMessage(m)
      }
    }
    ws.onclose = () => {
      clearInterval(this.heartbeat)
      if (this.running) setTimeout(() => this.connect(onMessage), 3000)
    }
    ws.onerror = () => undefined
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.running = true
    this.connect(onMessage)
  }

  async send(channelId: string, text: string): Promise<void> {
    for (const part of chunkText(text, 1900)) {
      await this.o.fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { authorization: `Bot ${this.o.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: part }) })
    }
  }

  async stop(): Promise<void> { this.running = false; clearInterval(this.heartbeat); this.ws?.close() }
}
