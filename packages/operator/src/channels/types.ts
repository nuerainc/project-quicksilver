/**
 * Channels (M8 part 4): one gateway, many messaging platforms. An adapter
 * turns a platform's events into `InboundMessage`s and sends text back; the
 * gateway (gateway.ts) decides who may talk to the operator, keeps one
 * conversation and one memory per person across every channel, and handles
 * approvals in the chat itself.
 */
export type ChannelKind = 'telegram' | 'slack' | 'discord' | 'sms' | 'email' | 'test'

export interface InboundMessage {
  channel: string
  kind: ChannelKind
  /** The platform's id for the sender (Telegram user id, phone number, email address…). */
  senderId: string
  senderName?: string
  /** Where to reply (chat, channel, thread, phone number, address). */
  replyTo: string
  text: string
  /** The platform's message id, for de-duplication. */
  messageId?: string
  /** True for a direct message; group messages are answered only when addressed. */
  direct: boolean
}

export interface ChannelAdapter {
  readonly id: string
  readonly kind: ChannelKind
  start(onMessage: (m: InboundMessage) => void): Promise<void>
  send(replyTo: string, text: string): Promise<void>
  stop(): Promise<void>
}

/** Split long text for platforms with message limits, on paragraph or line breaks when possible. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>
