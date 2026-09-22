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

export type QuicksilverModelRole = 'planner' | 'reviewer' | 'router' | 'executor'
export type InferenceMode = 'azure' | 'cloud' | 'local'

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
export function modelForRole(role: QuicksilverModelRole, mode?: InferenceMode): LanguageModel {
  const m: InferenceMode = mode ?? getMode()
  return languageModelForId(resolveId(role, m), m)
}
