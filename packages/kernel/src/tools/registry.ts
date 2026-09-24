import {
  validateToolRequest,
  type ToolRequest,
  type ToolValidationResult,
} from '../engine/index.ts'

export type ToolAccessClass = 'read-only' | 'side-effect'

/** Stable, serializable contract for a tool registered with the NQC Kernel. */
export interface ToolManifest {
  id: string
  contractVersion: 1
  provider: string
  description?: string
  inputSchema?: unknown
  access: ToolAccessClass
  requiresApproval: boolean
  dependsOn?: readonly string[]
}

export interface RegisteredTool {
  manifest: Readonly<ToolManifest>
}

/** Per-runtime registry. Invalid or duplicate contracts fail closed. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(manifest: ToolManifest): RegisteredTool {
    const errors = validateManifest(manifest)
    if (errors.length) {
      const id = typeof manifest?.id === 'string' ? manifest.id : 'unknown'
      throw new Error(`Invalid tool manifest "${id}": ${errors.join(' ')}`)
    }
    if (this.tools.has(manifest.id)) throw new Error(`Tool "${manifest.id}" is already registered.`)

    const frozenManifest = Object.freeze({
      ...manifest,
      inputSchema: freezeJson(manifest.inputSchema),
      dependsOn: manifest.dependsOn ? Object.freeze([...manifest.dependsOn]) : undefined,
    })
    const registered = Object.freeze({ manifest: frozenManifest })
    this.tools.set(manifest.id, registered)
    return registered
  }

  get(id: string): RegisteredTool | undefined {
    return this.tools.get(id)
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  }

  validate(
    request: ToolRequest,
    expectedSequence?: number,
    completedTools: string[] = [],
    verifySupervisorApproval?: (approvalId: string, tool: ToolManifest) => boolean,
  ): ToolValidationResult {
    const registered = this.tools.get(request.name)
    if (!registered) {
      return { allowed: false, requiresApproval: false, reasons: [`Tool "${request.name}" is not registered.`] }
    }

    const { manifest } = registered
    return validateToolRequest(
      { ...request, approvalId: manifest.requiresApproval ? request.approvalId : undefined },
      [{
        name: manifest.id,
        parameters: manifest.inputSchema,
        requiresApproval: manifest.requiresApproval,
        dependsOn: manifest.dependsOn ? [...manifest.dependsOn] : undefined,
      }],
      expectedSequence,
      completedTools,
      verifySupervisorApproval
        ? (approvalId) => verifySupervisorApproval(approvalId, manifest)
        : undefined,
    )
  }
}

function validateManifest(manifest: ToolManifest): string[] {
  if (!manifest || typeof manifest !== 'object') return ['Manifest must be an object.']
  const errors: string[] = []
  if (typeof manifest.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(manifest.id)) {
    errors.push('id must be a stable tool identifier.')
  }
  if (manifest.contractVersion !== 1) errors.push('contractVersion must be 1.')
  if (typeof manifest.provider !== 'string' || !manifest.provider.trim()) errors.push('provider is required.')
  if (manifest.access !== 'read-only' && manifest.access !== 'side-effect') errors.push('access must be read-only or side-effect.')
  if (manifest.access === 'side-effect' && !manifest.requiresApproval) errors.push('side-effect tools must require approval.')
  if (typeof manifest.requiresApproval !== 'boolean') errors.push('requiresApproval must be boolean.')
  if (manifest.dependsOn !== undefined && (!Array.isArray(manifest.dependsOn) || manifest.dependsOn.some((dependency) => typeof dependency !== 'string'))) {
    errors.push('dependsOn must be a list of tool identifiers.')
  }
  if (Array.isArray(manifest.dependsOn) && manifest.dependsOn.includes(manifest.id)) errors.push('a tool cannot depend on itself.')
  return errors
}

function freezeJson(value: unknown): unknown {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Tool schema must be JSON-serializable.')
  return deepFreeze(JSON.parse(serialized) as unknown)
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}
