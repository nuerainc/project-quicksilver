/**
 * Model role registry — configuration, not architecture.
 *
 * Roles (planner / reviewer / router / executor) are stable; the model behind
 * each role is configuration. Resolution, in priority order:
 *   1. Per-role env override      QUICKSILVER_PLANNER_MODEL=<id or deployment>
 *   2. Mode registry              azure | cloud | local
 *   3. Mode auto-detection        see getMode()
 *
 * Modes:
 *   - 'azure' → Azure OpenAI / Foundry via `@ai-sdk/azure`. The "model id" is
 *               your *deployment name*, not the model name. Defaults are
 *               qs-planner / qs-reviewer / qs-router / qs-executor; set
 *               AZURE_DEPLOYMENT to route every role to one deployment, or
 *               QUICKSILVER_<ROLE>_MODEL to override a single role.
 *   - 'cloud' → direct provider APIs (OpenAI, Anthropic, Google), dispatched
 *               by model-id prefix.
 *   - 'local' → Ollama through its OpenAI-compatible endpoint.
 *
 * Force a mode with `QUICKSILVER_MODEL_MODE=azure|cloud|local`. Otherwise:
 * azure if AZURE_API_KEY + AZURE_RESOURCE_NAME are set, else cloud if any
 * other provider key is set, else local.
 *
 * Azure env:
 *   AZURE_RESOURCE_NAME    resource name (the part before .openai.azure.com)
 *   AZURE_API_KEY          Key 1 from Keys and Endpoint in the portal
 *   AZURE_API_VERSION      optional; defaults to the v1 API ("v1")
 *   AZURE_API_MODE         optional; "responses" (default) or "chat"
 *
 * The kernel still authorizes. Models only propose.
 */

import { createAzure } from '@ai-sdk/azure'
import { openai } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { selectRoute, type ModelPerformanceProfile, type RoutingDecision, type RoutingRequest } from '@quicksilver/kernel'

export type QuicksilverModelRole = 'planner' | 'reviewer' | 'router' | 'executor'
export type InferenceMode = 'azure' | 'cloud' | 'local'

/** Optional measured routing config supplied by the host at process startup. */
type RoleRoutingPolicy = Partial<Omit<RoutingRequest, 'candidates' | 'taskType'>>
export interface MeasuredRoutingConfig {
  profiles: ModelPerformanceProfile[]
  requests?: Partial<Record<QuicksilverModelRole, RoleRoutingPolicy>>
}

const ROLE_TASK: Record<QuicksilverModelRole, RoutingRequest['taskType']> = {
  planner: 'planning', reviewer: 'evaluation', router: 'routing', executor: 'code',
}

/**
 * Resolve the measured route for a role. Hosts may inject a config directly or
 * set QUICKSILVER_ROUTING_CONFIG to JSON. Configured routing fails closed when
 * no measured profile satisfies the request; silently reverting to an
 * unmeasured model would defeat the caller's routing policy.
 */
export function routeForRole(
  role: QuicksilverModelRole,
  config = readMeasuredRoutingConfig(),
): RoutingDecision | null {
  if (!config) return null
  const policy = config.requests?.[role] ?? {}
  return selectRoute({
    taskType: ROLE_TASK[role],
    estimatedTokens: 1000,
    ...policy,
    candidates: config.profiles,
  })
}

/** Estimated blended cost from an explicitly configured measured model profile. */
export function estimateModelCostUsd(modelId: string, totalTokens: number | null): number | null {
  if (totalTokens === null || !Number.isFinite(totalTokens) || totalTokens < 0) return null
  const profile = readMeasuredRoutingConfig()?.profiles.find((item) => item.modelId === modelId)
  if (!profile || !Number.isFinite(profile.averageCostPer1kTokens) || profile.averageCostPer1kTokens < 0) return null
  return Number((profile.averageCostPer1kTokens * totalTokens / 1000).toFixed(6))
}

/** Parse and minimally validate the host-provided measured model profiles. */
export function readMeasuredRoutingConfig(): MeasuredRoutingConfig | null {
  const raw = process.env.QUICKSILVER_ROUTING_CONFIG
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('QUICKSILVER_ROUTING_CONFIG must be valid JSON.') }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { profiles?: unknown }).profiles)) {
    throw new Error('QUICKSILVER_ROUTING_CONFIG must be an object with a profiles array.')
  }
  const profiles = (value as { profiles: unknown[] }).profiles
  if (!profiles.every(isModelPerformanceProfile)) {
    throw new Error('QUICKSILVER_ROUTING_CONFIG contains an invalid model performance profile.')
  }
  const requests = (value as { requests?: unknown }).requests
  if (requests !== undefined && (!requests || typeof requests !== 'object' || Array.isArray(requests))) {
    throw new Error('QUICKSILVER_ROUTING_CONFIG requests must be an object keyed by agent role.')
  }
  const normalizedRequests: MeasuredRoutingConfig['requests'] = {}
  if (requests) {
    for (const [role, request] of Object.entries(requests)) {
      if (!(['planner', 'reviewer', 'router', 'executor'] as string[]).includes(role)
        || !request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error(`QUICKSILVER_ROUTING_CONFIG has an invalid request for role "${role}".`)
      }
      const r = request as Record<string, unknown>
      const numericKeys = ['estimatedTokens', 'budget', 'maxLatencyMs', 'minimumAccuracy', 'maximumRateLimitRate']
      if (Object.keys(r).some((key) => ![...numericKeys, 'domain', 'recentFailureModelIds'].includes(key))
        || numericKeys.some((key) => r[key] !== undefined && (typeof r[key] !== 'number' || !Number.isFinite(r[key])))
        || (r.domain !== undefined && typeof r.domain !== 'string')
        || (r.recentFailureModelIds !== undefined && (!Array.isArray(r.recentFailureModelIds) || !r.recentFailureModelIds.every((id) => typeof id === 'string')))) {
        throw new Error(`QUICKSILVER_ROUTING_CONFIG has invalid policy fields for role "${role}".`)
      }
      normalizedRequests[role as QuicksilverModelRole] = r as RoleRoutingPolicy
    }
  }
  return { profiles: profiles as ModelPerformanceProfile[], ...(requests ? { requests: normalizedRequests } : {}) }
}

function isModelPerformanceProfile(value: unknown): value is ModelPerformanceProfile {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<ModelPerformanceProfile>
  return typeof p.modelId === 'string' && Boolean(p.modelId.trim())
    && Array.isArray(p.supportedTasks) && p.supportedTasks.every((x) => typeof x === 'string')
    && Boolean(p.taskAccuracy) && typeof p.taskAccuracy === 'object'
    && typeof p.successRate === 'number' && typeof p.averageCostPer1kTokens === 'number'
    && typeof p.p95LatencyMs === 'number' && typeof p.available === 'boolean'
}

type Registry = Record<QuicksilverModelRole, string>

/** Azure deployment names, one per role. Create deployments with these names, or override via env. */
export const AZURE_DEPLOYMENTS: Registry = {
  planner: 'qs-planner',
  reviewer: 'qs-reviewer',
  router: 'qs-router',
  executor: 'qs-executor',
}

export const CLOUD_MODELS: Registry = {
  planner: 'gpt-5.6-sol',
  reviewer: 'claude-sonnet-5',
  router: 'gpt-5.6-luna',
  executor: 'gemini-3.8-flash',
}

export const LOCAL_MODELS: Registry = {
  planner: process.env.QUICKSILVER_LOCAL_PLANNER ?? 'qwen2.5:7b',
  reviewer: process.env.QUICKSILVER_LOCAL_REVIEWER ?? 'qwen2.5:7b',
  router: process.env.QUICKSILVER_LOCAL_ROUTER ?? 'qwen2.5:7b',
  executor: process.env.QUICKSILVER_LOCAL_EXECUTOR ?? 'qwen2.5:7b',
}

export const MODELS = CLOUD_MODELS

/** True when Azure credentials are present in the environment. */
export function hasAzureCredentials(): boolean {
  return Boolean(process.env.AZURE_API_KEY && process.env.AZURE_RESOURCE_NAME)
}

function hasDirectProviderKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  )
}

/**
 * Whether the agent has *some* way to reach a model: Azure, a direct provider
 * key, or an explicit opt-in to local inference.
 */
export function isLlmConfigured(): boolean {
  return hasAzureCredentials() || hasDirectProviderKey() || process.env.QUICKSILVER_MODEL_MODE === 'local'
}

/** Resolve the active inference mode (see file header). */
export function getMode(): InferenceMode {
  const forced = process.env.QUICKSILVER_MODEL_MODE
  if (forced === 'azure' || forced === 'cloud' || forced === 'local') return forced
  if (hasAzureCredentials()) return 'azure'
  return hasDirectProviderKey() ? 'cloud' : 'local'
}

/**
 * Resolve which id backs a role for the active mode. In azure mode the id is a
 * deployment name. Per-role env overrides always win.
 */
export function resolveId(role: QuicksilverModelRole, mode: InferenceMode): string {
  const override = process.env[`QUICKSILVER_${role.toUpperCase()}_MODEL`]
  if (override) return override

  if (mode === 'azure') return process.env.AZURE_DEPLOYMENT || AZURE_DEPLOYMENTS[role]
  return (mode === 'local' ? LOCAL_MODELS : CLOUD_MODELS)[role]
}

function azureModel(deployment: string): LanguageModel {
  if (!hasAzureCredentials()) {
    throw new Error(
      'Azure mode needs AZURE_API_KEY and AZURE_RESOURCE_NAME (Key 1 and the resource name from the Azure portal). Set them in .env.',
    )
  }
  const azure = createAzure({
    resourceName: process.env.AZURE_RESOURCE_NAME,
    apiKey: process.env.AZURE_API_KEY,
    apiVersion: process.env.AZURE_API_VERSION || undefined,
  })
  // Responses API by default; AZURE_API_MODE=chat for deployments that only support Chat Completions.
  return process.env.AZURE_API_MODE === 'chat' ? azure.chat(deployment) : azure(deployment)
}

/**
 * Resolve an id → provider model.
 *  - azure: every id is an Azure deployment name (no prefix dispatch).
 *  - cloud: dispatch by prefix (gpt-/o* → OpenAI, claude- → Anthropic, gemini- → Google).
 *  - local: Ollama via its OpenAI-compatible endpoint (OLLAMA_BASE_URL, default localhost:11434).
 */
export function languageModelForId(id: string, mode: InferenceMode = getMode()): LanguageModel {
  if (mode === 'azure') return azureModel(id)

  if (mode === 'local') {
    const ollama = createOpenAICompatible({
      name: 'ollama',
      baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    })
    return ollama(id)
  }

  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) {
    return openai(id)
  }
  if (id.startsWith('claude-')) return anthropic(id)
  if (id.startsWith('gemini-')) return google(id)
  throw new Error(
    `Unrecognized model id "${id}" in cloud mode. Use a gpt-*/o*, claude-*, or gemini-* id, or switch to azure/local mode.`,
  )
}

/**
 * Build a LanguageModel for a role.
 *
 * `modelForRole('planner')` → the active planner model.
 * `modelForRole('reviewer', 'local')` → forces the local reviewer model.
 */
export function modelForRole(role: QuicksilverModelRole, mode?: InferenceMode, routingConfig?: MeasuredRoutingConfig | null): LanguageModel {
  const m: InferenceMode = mode ?? getMode()
  // An explicit role override is an operator decision and retains precedence.
  const override = process.env[`QUICKSILVER_${role.toUpperCase()}_MODEL`]
  const route = override ? null : routeForRole(role, routingConfig === undefined ? readMeasuredRoutingConfig() : routingConfig)
  if (route && !route.selectedModelId) {
    throw new Error(`Measured model routing refused ${role} dispatch: ${route.reason}`)
  }
  return languageModelForId(route?.selectedModelId ?? resolveId(role, m), m)
}
