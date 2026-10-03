'use client'

import { useEffect, useSyncExternalStore } from 'react'

import { authFailureMessage, consoleHeaders, resolveConsoleAccess } from '@/lib/console-auth'
import { createInboxStore, type InboxLoad, type InboxState, type InboxStore } from '@/lib/inbox-store'

const load: InboxLoad = async () => {
  const access = await resolveConsoleAccess()
  if (!access.signedIn) return { kind: 'signed-out' }
  const response = await fetch('/api/inbox', { headers: consoleHeaders('/api/inbox', access.token), cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) return { kind: 'error', signedOut: response.status === 401, message: authFailureMessage(response.status, 'inbox', body.error) ?? body.error ?? 'Could not check what needs you.' }
  return { kind: 'ok', inbox: body }
}

let store: InboxStore | undefined
export const inboxStore = (): InboxStore => (store ??= createInboxStore(load))

const SERVER_STATE: InboxState = { inbox: null, error: null, needsSignIn: false, loading: false, checkedAt: null }

/** The shared "what needs me" state. Checks when the tab regains focus as well as once a minute. */
export function useInbox(): InboxState & { refresh: () => Promise<void> } {
  const shared = inboxStore()
  const state = useSyncExternalStore(shared.subscribe, shared.getState, () => SERVER_STATE)
  useEffect(() => {
    const onFocus = () => void shared.refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [shared])
  return { ...state, refresh: shared.refresh }
}
