/** The conversation survives closing the panel and a reload, in this tab only. Storage can be missing or full; the chat works without it. */
const KEY = 'qs-chat-v1'
const MAX_MESSAGES = 20

export function loadChat<T>(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): T[] {
  try {
    const raw = storage?.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed.slice(-MAX_MESSAGES) as T[]) : []
  } catch { return [] }
}

export function saveChat<T>(messages: T[], storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()): void {
  try {
    if (!messages.length) storage?.removeItem(KEY)
    else storage?.setItem(KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)))
  } catch { /* private window, quota or blocked storage: keep going without it */ }
}

function safeStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage } catch { return undefined }
}
