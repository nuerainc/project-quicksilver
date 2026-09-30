import {
  getMode,
  languageModelForId,
  modelForRole,
  resolveId,
  routeForRole,
  type QuicksilverModelRole,
} from './models.ts'
import type { LanguageModel } from 'ai'

/** Only retry errors that indicate a transient provider failure. Validation,
 * authorization, and malformed-request errors must not silently change models. */
export function isTransientProviderFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { isRetryable?: unknown; statusCode?: unknown; status?: unknown }
  if (value.isRetryable === true) return true
  const status = typeof value.statusCode === 'number' ? value.statusCode : value.status
  return typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599))
}

/**
 * Try the selected measured route, then its policy-ranked eligible fallbacks
 * on transient provider failures only. This does not alter routing policy or
 * fall back to unmeasured models. Explicit per-role operator overrides retain
 * their existing single-model behavior.
 */
export async function withMeasuredProviderFallback<T>(
  role: QuicksilverModelRole,
  invoke: (model: LanguageModel, selectedModelId: string) => Promise<T>,
): Promise<T> {
  const override = process.env[`QUICKSILVER_${role.toUpperCase()}_MODEL`]
  const route = override ? null : routeForRole(role)
  const modelIds = route?.selectedModelId
    ? [route.selectedModelId, ...route.fallbackModelIds]
    : [undefined]

  let lastError: unknown
  for (let index = 0; index < modelIds.length; index += 1) {
    const modelId = modelIds[index]
    try {
      const model = index === 0 ? modelForRole(role) : languageModelForId(modelId!, getMode())
      return await invoke(model, modelId ?? resolveId(role, getMode()))
    } catch (error) {
      lastError = error
      if (!isTransientProviderFailure(error) || index === modelIds.length - 1) throw error
    }
  }
  throw lastError
}
