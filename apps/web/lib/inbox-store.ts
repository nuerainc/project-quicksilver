import type { AttentionItem, SourceStatus } from './attention.ts'

export interface Inbox {
  observedAt: string
  items: AttentionItem[]
  sources: SourceStatus[]
  counts: { actionable: number; other: number; complete: boolean }
}

export type InboxLoad = () => Promise<
  | { kind: 'ok'; inbox: Inbox }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string; signedOut?: boolean }
>

export interface InboxState {
  inbox: Inbox | null
  /** The last problem, shown beside the last good list (not instead of it). */
  error: string | null
  needsSignIn: boolean
  loading: boolean
  /** When the list shown was last checked, in ms. */
  checkedAt: number | null
}

export interface InboxStore {
  getState(): InboxState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
}

const INITIAL: InboxState = { inbox: null, error: null, needsSignIn: false, loading: false, checkedAt: null }

/**
 * One shared copy of "what needs me" for everything on the page that shows it (the bell, the
 * overview card, the chat), so the page asks the server once a minute rather than once a minute
 * per place. Polling runs only while something is subscribed. A failed check keeps the last good
 * list and says so; it never replaces it with an empty one.
 */
export function createInboxStore(load: InboxLoad, options: { pollMs?: number; now?: () => number } = {}): InboxStore {
  const pollMs = options.pollMs ?? 60_000
  const now = options.now ?? Date.now
  let state: InboxState = INITIAL
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | undefined
  const listeners = new Set<() => void>()

  const set = (next: InboxState) => { state = next; for (const listener of [...listeners]) listener() }

  function refresh(): Promise<void> {
    if (inFlight) return inFlight
    set({ ...state, loading: true })
    inFlight = (async () => {
      try {
        const result = await load()
        if (result.kind === 'ok') set({ inbox: result.inbox, error: null, needsSignIn: false, loading: false, checkedAt: now() })
        else if (result.kind === 'signed-out') set({ inbox: null, error: null, needsSignIn: true, loading: false, checkedAt: null })
        else set({ ...state, error: result.message, needsSignIn: result.signedOut === true, loading: false })
      } catch {
        set({ ...state, error: 'Could not reach the server to check what needs you.', loading: false })
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  return {
    getState: () => state,
    refresh,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        void refresh()
        timer = setInterval(() => void refresh(), pollMs)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) { clearInterval(timer); timer = undefined }
      }
    },
  }
}
