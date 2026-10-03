import type { BusinessAgentKey } from '@quicksilver/agent'

export type ChatMode = 'ask' | 'plan' | 'agent'

export interface ChatTurn { question: string; answer: string }

/** Maps chat modes to existing governed APIs; specialist work returns proposals and never executes them. */
export function chatRequest(mode: ChatMode, text: string, agentKey: BusinessAgentKey | 'auto' = 'auto', context: string[] = [], history: ChatTurn[] = []):
  { path: '/api/chat'; body: { message: string; history?: ChatTurn[] } }
  | { path: '/api/plan'; body: { objective: string } }
  | { path: '/api/agents/run'; body: { objective: string; agentKey: BusinessAgentKey | 'auto'; context?: string[] } } {
  if (mode === 'plan') return { path: '/api/plan', body: { objective: text } }
  if (mode === 'agent') return { path: '/api/agents/run', body: { objective: text, agentKey, ...(context.length ? { context } : {}) } }
  return { path: '/api/chat', body: { message: text, ...(history.length ? { history: history.slice(-6) } : {}) } }
}
