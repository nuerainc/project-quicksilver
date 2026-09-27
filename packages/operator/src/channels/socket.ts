/** The minimal WebSocket surface the Slack and Discord adapters use (Node 22's global WebSocket, or a fake in tests). */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type SocketFactory = (url: string) => SocketLike

export const defaultSocket: SocketFactory = (url) => {
  const WS = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket
  if (!WS) throw new Error('This Node.js has no WebSocket; use Node 22 or newer.')
  return new WS(url)
}
