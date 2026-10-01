import type { BusinessAgentKey } from '@quicksilver/agent'

export type ChatMode = 'ask' | 'plan' | 'agent'

/** Maps chat modes to existing governed APIs; specialist work returns proposals and never executes them. */
export function chatRequest(mode: ChatMode, text: string, agentKey: BusinessAgentKey | 'auto' = 'auto', context: string[] = []):
  { path: '/api/query'; body: { question: string } }
  | { path: '/api/plan'; body: { objective: string } }
  | { path: '/api/agents/run'; body: { objective: string; agentKey: BusinessAgentKey | 'auto'; context?: string[] } } {
  if (mode === 'plan') return { path: '/api/plan', body: { objective: text } }
  if (mode === 'agent') return { path: '/api/agents/run', body: { objective: text, agentKey, ...(context.length ? { context } : {}) } }
  return { path: '/api/query', body: { question: text } }
}
