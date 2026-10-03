import type { AppFetch } from '@quicksilver/agent'

import { GET as inbox } from '@/app/api/inbox/route'
import { appFetchFor as readFetchFor, appHandlerFor as readHandlerFor } from '@/lib/app-read-routes'

/**
 * The chat assistant's window onto the app: the read routes of `app-read-routes.ts` plus the
 * attention list. The inbox route reads the others through `app-read-routes.ts` directly, which is
 * why it is added here and not there (it would be a cycle).
 */
const EXTRA = Object.freeze({ '/api/inbox': inbox })

export const appHandlerFor = (pathname: string) => readHandlerFor(pathname, EXTRA)
export const appFetchFor = (request: Request): AppFetch => readFetchFor(request, EXTRA)
