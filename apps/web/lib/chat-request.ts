export type ChatMode = 'ask' | 'plan'

/** Maps conversational modes to the existing governed APIs; no chat path executes actions. */
export function chatRequest(mode: ChatMode, text: string): { path: '/api/query' | '/api/plan'; body: { question: string } | { objective: string } } {
  return mode === 'plan'
    ? { path: '/api/plan', body: { objective: text } }
    : { path: '/api/query', body: { question: text } }
}
