import type { ModelTokenUsage } from './contracts.ts'

export function normalizeModelTokenUsage(value: unknown): ModelTokenUsage {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const count = (key: string): number | null => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && (usage[key] as number) >= 0
    ? Math.floor(usage[key] as number)
    : null
  const inputTokens = count('inputTokens')
  const outputTokens = count('outputTokens')
  const totalTokens = count('totalTokens') ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  return { inputTokens, outputTokens, totalTokens }
}
