import type { AssistantOffer } from '@quicksilver/agent'

export interface ChatTurn { question: string; answer: string }

/** Pages the chat may be told the person has open; anything else is dropped, never sent. */
export const PAGE_HINT = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?(?:\?id=[A-Za-z0-9._:-]{1,128})?$/

export function pageHint(pathname: string, search = ''): string | undefined {
  const id = new URLSearchParams(search).get('id')
  const withId = id && pathname === '/decisions' ? `${pathname}?id=${id}` : pathname
  const candidate = PAGE_HINT.test(withId) ? withId : pathname
  return PAGE_HINT.test(candidate) && candidate.length <= 200 ? candidate : undefined
}

/** The one chat: every turn goes to the read-only assistant, which may offer cards but never acts. */
export function chatTurnRequest(text: string, history: ChatTurn[] = [], page?: string):
  { path: '/api/chat'; body: { message: string; history?: ChatTurn[]; page?: string } } {
  return { path: '/api/chat', body: { message: text, ...(history.length ? { history: history.slice(-6) } : {}), ...(page ? { page } : {}) } }
}

/** What pressing an offer card sends: the app's own route, as the person, with the text they saw and may have edited. */
export function offerRequest(offer: AssistantOffer, text: string):
  { path: '/api/plan'; body: { objective: string } }
  | { path: '/api/agents/run'; body: { objective: string; agentKey: string } }
  | { path: '/api/workflows/run'; body: { workflowId: string; input: string } } {
  if (offer.kind === 'plan') return { path: '/api/plan', body: { objective: text } }
  if (offer.kind === 'specialist') return { path: '/api/agents/run', body: { objective: text, agentKey: offer.agentKey } }
  return { path: '/api/workflows/run', body: { workflowId: offer.workflowId, input: text } }
}
