/**
 * Telegram adapter: the Bot API with long polling (no public address needed).
 * Create a bot with @BotFather and give the token as TELEGRAM_BOT_TOKEN.
 */
import { chunkText, type ChannelAdapter, type FetchLike, type InboundMessage } from './types.ts'

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const
  readonly id: string
  private readonly base: string
  private readonly fetch: FetchLike
  private offset = 0
  private running = false
  private abort?: AbortController

  constructor(options: { token: string; id?: string; fetch?: FetchLike; apiBase?: string }) {
    if (!/^\d+:[\w-]{30,}$/.test(options.token)) throw new Error('TELEGRAM_BOT_TOKEN does not look like a bot token.')
    this.id = options.id ?? 'telegram'
    this.base = `${options.apiBase ?? 'https://api.telegram.org'}/bot${options.token}`
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  }

  /** Map one update to a message (pure; exported for tests). */
  static toMessage(update: any, id = 'telegram'): InboundMessage | null {
    const msg = update?.message
    if (!msg || typeof msg.text !== 'string' || !msg.from || msg.from.is_bot) return null
    return {
      channel: id, kind: 'telegram', senderId: String(msg.from.id), senderName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
      replyTo: String(msg.chat.id), text: msg.text, messageId: String(update.update_id), direct: msg.chat.type === 'private',
    }
  }

  async pollOnce(onMessage: (m: InboundMessage) => void, timeoutSeconds = 25): Promise<void> {
    const r = await this.fetch(`${this.base}/getUpdates?timeout=${timeoutSeconds}&offset=${this.offset}&allowed_updates=%5B%22message%22%5D`, { signal: this.abort?.signal })
    if (!r.ok) throw new Error(`Telegram getUpdates failed (${r.status}).`)
    const body = await r.json()
    for (const u of body.result ?? []) {
      this.offset = Math.max(this.offset, Number(u.update_id) + 1)
      const m = TelegramAdapter.toMessage(u, this.id)
      if (m) onMessage(m)
    }
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.running = true
    this.abort = new AbortController()
    void (async () => {
      let backoff = 1000
      while (this.running) {
        try { await this.pollOnce(onMessage); backoff = 1000 } catch {
          if (!this.running) break
          await new Promise((r) => setTimeout(r, backoff))
          backoff = Math.min(backoff * 2, 60_000)
        }
      }
    })()
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunkText(text, 4000)) {
      await this.fetch(`${this.base}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: part }) })
    }
  }

  async stop(): Promise<void> { this.running = false; this.abort?.abort() }
}
