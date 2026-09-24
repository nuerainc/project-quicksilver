import type { NqcEvaluationResponse, WorkflowGraph } from '@quicksilver/kernel'

export interface WorkflowValidationResponse {
  schemaVersion: 1
  valid: boolean
  errors: string[]
  topologicalOrder: string[]
}

export type WorkflowRunStatus = 'completed' | 'blocked' | 'failed' | 'cancelled'

export interface WorkflowStepResponse {
  nodeId: string
  status: 'completed' | 'skipped' | 'blocked' | 'failed' | 'cancelled'
  safetyDecision?: 'ALLOW' | 'BLOCK' | 'ESCALATE' | 'SKIPPED'
  detail?: string
  retryAfterMs?: number
}

export interface WorkflowSimulationResponse {
  mode: 'simulation'
  externalEffectsEnabled: false
  status: WorkflowRunStatus
  outputs: Record<string, unknown>
  steps: WorkflowStepResponse[]
  error?: string
}

export type WorkflowEvaluationResponse = NqcEvaluationResponse

export interface ReadOnlyWorkflowRunResponse {
  mode: 'live-read-only'
  externalEffectsEnabled: false
  status: WorkflowRunStatus
  outputs: Record<string, unknown>
  steps: WorkflowStepResponse[]
  evaluations: Record<string, WorkflowEvaluationResponse>
  error?: string
}

export interface QuicksilverClientOptions {
  /** Base URL of the Nuera Quicksilver web API, for example https://qs.example.com. */
  baseUrl: string
  fetch?: typeof fetch
}

export class QuicksilverApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message)
    this.name = 'QuicksilverApiError'
  }
}

/** Small dependency-free TypeScript client for the Nuera Quicksilver API. */
export class QuicksilverClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(options: QuicksilverClientOptions) {
    const parsed = new URL(options.baseUrl)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('Quicksilver API URLs must use HTTPS outside localhost.')
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '')
    this.fetcher = options.fetch ?? globalThis.fetch
    if (!this.fetcher) throw new Error('This runtime does not provide fetch; supply a fetch implementation.')
  }

  async validateWorkflow(graph: WorkflowGraph, options: { signal?: AbortSignal } = {}): Promise<WorkflowValidationResponse> {
    const response = await this.fetcher(`${this.baseUrl}/api/workflows/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph }),
      signal: options.signal,
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Quicksilver API request failed with status ${response.status}.`
      throw new QuicksilverApiError(message, response.status, body)
    }
    if (!isWorkflowValidationResponse(body)) {
      throw new QuicksilverApiError('Quicksilver returned an invalid workflow validation response.', response.status, body)
    }
    return body
  }

  async previewWorkflow(graph: WorkflowGraph, options: { signal?: AbortSignal } = {}): Promise<WorkflowSimulationResponse> {
    return this.post('/api/workflows/simulate', { graph }, options.signal, isWorkflowSimulationResponse, 'workflow simulation')
  }

  async runReadOnlyWorkflow(
    graph: WorkflowGraph,
    input: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReadOnlyWorkflowRunResponse> {
    return this.post('/api/workflows/run', { graph, input }, options.signal, isReadOnlyWorkflowRunResponse, 'read-only workflow run')
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    validate: (value: unknown) => value is T,
    label: string,
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const result = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Quicksilver API request failed with status ${response.status}.`
      throw new QuicksilverApiError(message, response.status, result)
    }
    if (!validate(result)) throw new QuicksilverApiError(`Quicksilver returned an invalid ${label} response.`, response.status, result)
    return result
  }
}

export function createQuicksilverClient(options: QuicksilverClientOptions): QuicksilverClient {
  return new QuicksilverClient(options)
}

function isWorkflowValidationResponse(value: unknown): value is WorkflowValidationResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Record<string, unknown>
  return response.schemaVersion === 1
    && typeof response.valid === 'boolean'
    && Array.isArray(response.errors)
    && response.errors.every((error) => typeof error === 'string')
    && Array.isArray(response.topologicalOrder)
    && response.topologicalOrder.every((id) => typeof id === 'string')
}

function isWorkflowSimulationResponse(value: unknown): value is WorkflowSimulationResponse {
  return isExecutionResponse(value, 'simulation')
}

function isReadOnlyWorkflowRunResponse(value: unknown): value is ReadOnlyWorkflowRunResponse {
  if (!isExecutionResponse(value, 'live-read-only') || !('evaluations' in value) || !value.evaluations || typeof value.evaluations !== 'object') return false
  return Object.values(value.evaluations).every((item) => {
    if (!item || typeof item !== 'object') return false
    const evaluation = item as unknown as Record<string, unknown>
    return typeof evaluation.reasoningScore === 'number'
      && ['low', 'med', 'high'].includes(String(evaluation.hallucinationRisk))
      && ['low', 'med', 'high'].includes(String(evaluation.brittleness))
      && ['ALLOW', 'BLOCK', 'ESCALATE'].includes(String(evaluation.safetyDecision))
      && Array.isArray(evaluation.issues) && evaluation.issues.every((issue) => typeof issue === 'string')
      && Array.isArray(evaluation.corrections) && evaluation.corrections.every((correction) => typeof correction === 'string')
  })
}

function isExecutionResponse(value: unknown, mode: 'simulation' | 'live-read-only'): value is WorkflowSimulationResponse | ReadOnlyWorkflowRunResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Record<string, unknown>
  return response.mode === mode
    && response.externalEffectsEnabled === false
    && ['completed', 'blocked', 'failed', 'cancelled'].includes(String(response.status))
    && !!response.outputs && typeof response.outputs === 'object' && !Array.isArray(response.outputs)
    && Array.isArray(response.steps) && response.steps.every((step) => {
      if (!step || typeof step !== 'object') return false
      const item = step as Record<string, unknown>
      return typeof item.nodeId === 'string'
        && ['completed', 'skipped', 'blocked', 'failed', 'cancelled'].includes(String(item.status))
        && (item.safetyDecision === undefined || ['ALLOW', 'BLOCK', 'ESCALATE', 'SKIPPED'].includes(String(item.safetyDecision)))
        && (item.detail === undefined || typeof item.detail === 'string')
    })
}
