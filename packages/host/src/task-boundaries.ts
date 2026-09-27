/**
 * Task boundaries (M7 part 4): the lab's standing boundaries, expressed as data.
 *
 * Every task passes these checks before the kernel sees it, whatever channel
 * it came through. They only refuse; they never allow anything the kernel
 * would refuse.
 *
 * - Restricted material: text or inputs that look like AMP patent material are
 *   refused, with the same patterns the Onboard CSV connector uses
 *   (`BLOCKED_SOURCE_PATTERNS` in @quicksilver/aura), until the provisional
 *   application is filed. A config may add patterns; it can never remove the
 *   connector's.
 * - Frozen projects: a frozen project is read-only. A task whose capability
 *   belongs to a frozen project and is not one of its read-only capabilities is
 *   refused, and so is a task whose text or inputs name the project together
 *   with a word that asks for a change.
 *
 * To change a boundary, change the data (DEFAULT_TASK_BOUNDARIES, or a
 * boundaries file passed to the host), not the code.
 */
import { BLOCKED_SOURCE_PATTERNS } from '@quicksilver/aura'

export interface RestrictedMaterialRule {
  id: string
  /** Case-insensitive regular expression sources. */
  patterns: string[]
  reason: string
}

export interface FrozenProjectRule {
  id: string
  /** Names that identify the project in text (whole words, case-insensitive). */
  names: string[]
  /** Capability ids under these prefixes belong to the project. */
  capabilityPrefixes: string[]
  /** Capabilities of the project that only read, and so stay allowed. */
  readOnlyCapabilities: string[]
  reason: string
}

export interface TaskBoundaryConfig {
  restrictedMaterial: RestrictedMaterialRule[]
  frozenProjects: FrozenProjectRule[]
  /** Words that ask for a change (whole words, case-insensitive). */
  writeWords: string[]
}

export const DEFAULT_TASK_BOUNDARIES: TaskBoundaryConfig = Object.freeze({
  restrictedMaterial: [
    {
      id: 'amp-patent-material',
      patterns: BLOCKED_SOURCE_PATTERNS.map((p) => p.source),
      reason: 'This looks like AMP patent material. It stays out of Quicksilver until the provisional application is filed.',
    },
  ],
  frozenProjects: [
    {
      id: 'forkling',
      names: ['forkling'],
      capabilityPrefixes: ['forkling.', 'forkling:'],
      readOnlyCapabilities: ['forkling.read'],
      reason: 'Forkling is frozen after deployment and read-only. No task may change it.',
    },
  ],
  writeWords: [
    'write', 'rewrite', 'update', 'change', 'edit', 'modify', 'delete', 'remove', 'deploy', 'redeploy', 'release',
    'push', 'commit', 'merge', 'publish', 'rename', 'migrate', 'patch', 'fix', 'refactor', 'add', 'create',
    'retrain', 'train', 'tune', 'upgrade', 'unfreeze', 'overwrite', 'replace', 'reset', 'revert', 'rollback',
    'configure', 'install', 'uninstall', 'append', 'insert', 'drop', 'truncate', 'upload',
  ],
}) as TaskBoundaryConfig

export interface BoundaryCheck {
  passed: boolean
  /** Rule ids that refused the task. */
  rules: string[]
  reasons: string[]
}

export interface BoundaryInput {
  objective: string
  capabilityId?: string
  department?: string
  inputs?: unknown
}

/**
 * Merge an extra boundary file over the defaults. Restricted patterns and
 * frozen projects are added to, never removed; write words are added to.
 */
export function mergeBoundaries(base: TaskBoundaryConfig, extra: Partial<TaskBoundaryConfig> | undefined): TaskBoundaryConfig {
  if (!extra) return base
  const errors = validateBoundaries({ restrictedMaterial: extra.restrictedMaterial ?? [], frozenProjects: extra.frozenProjects ?? [], writeWords: extra.writeWords ?? [] })
  if (errors.length) throw new Error(`Invalid task boundaries: ${errors.join(' ')}`)
  const material = new Map(base.restrictedMaterial.map((r) => [r.id, { ...r, patterns: [...r.patterns] }]))
  for (const r of extra.restrictedMaterial ?? []) {
    const existing = material.get(r.id)
    if (existing) existing.patterns = [...new Set([...existing.patterns, ...r.patterns])]
    else material.set(r.id, { ...r, patterns: [...r.patterns] })
  }
  const frozen = new Map(base.frozenProjects.map((f) => [f.id, { ...f }]))
  for (const f of extra.frozenProjects ?? []) {
    const existing = frozen.get(f.id)
    frozen.set(f.id, existing
      ? {
        ...existing,
        names: [...new Set([...existing.names, ...f.names])],
        capabilityPrefixes: [...new Set([...existing.capabilityPrefixes, ...f.capabilityPrefixes])],
        // A read-only list can only shrink when merged: a capability stays read-only only if both say so.
        readOnlyCapabilities: existing.readOnlyCapabilities.filter((c) => f.readOnlyCapabilities.includes(c)),
      }
      : { ...f })
  }
  return {
    restrictedMaterial: [...material.values()],
    frozenProjects: [...frozen.values()],
    writeWords: [...new Set([...base.writeWords, ...(extra.writeWords ?? [])])],
  }
}

export function validateBoundaries(c: TaskBoundaryConfig): string[] {
  const errors: string[] = []
  for (const r of c.restrictedMaterial ?? []) {
    if (typeof r?.id !== 'string' || !r.id) errors.push('Each restricted-material rule needs an id.')
    for (const p of r?.patterns ?? []) {
      try { new RegExp(p, 'i') } catch { errors.push(`Rule ${r.id}: "${p}" is not a valid pattern.`) }
    }
  }
  for (const f of c.frozenProjects ?? []) {
    if (typeof f?.id !== 'string' || !f.id) errors.push('Each frozen project needs an id.')
    if (!Array.isArray(f?.names) || !Array.isArray(f?.capabilityPrefixes) || !Array.isArray(f?.readOnlyCapabilities)) errors.push(`Frozen project ${f?.id}: names, capabilityPrefixes and readOnlyCapabilities must be lists.`)
  }
  if (!Array.isArray(c.writeWords) || c.writeWords.some((w) => typeof w !== 'string' || !/^[a-z-]+$/i.test(w))) errors.push('writeWords must be plain words.')
  return errors
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (words: string[]) => new RegExp(`\\b(?:${words.map(escape).join('|')})\\b`, 'i')

/** Every string in a small JSON value (keys too), for scanning. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out, depth + 1) }
  return out
}

/** Check one task against the boundaries. Pure. */
export function checkTaskBoundaries(input: BoundaryInput, config: TaskBoundaryConfig = DEFAULT_TASK_BOUNDARIES): BoundaryCheck {
  const rules: string[] = []
  const reasons: string[] = []
  const texts = [input.objective, ...(input.capabilityId ? [input.capabilityId] : []), ...(input.department ? [input.department] : []), ...strings(input.inputs)]
  const refuse = (id: string, reason: string) => { if (!rules.includes(id)) { rules.push(id); reasons.push(reason) } }

  for (const rule of config.restrictedMaterial) {
    const patterns = rule.patterns.map((p) => new RegExp(p, 'i'))
    if (texts.some((t) => patterns.some((p) => p.test(t)))) refuse(rule.id, rule.reason)
  }

  const writes = wordRe(config.writeWords)
  for (const project of config.frozenProjects) {
    const cap = input.capabilityId?.toLowerCase()
    if (cap && project.capabilityPrefixes.some((prefix) => cap.startsWith(prefix.toLowerCase())) && !project.readOnlyCapabilities.map((c) => c.toLowerCase()).includes(cap)) {
      refuse(`frozen:${project.id}`, `${project.reason} Capability "${input.capabilityId}" is not one of its read-only capabilities.`)
      continue
    }
    const named = wordRe(project.names)
    const freeText = [input.objective, ...strings(input.inputs)]
    const mentionsProject = freeText.some((t) => named.test(t)) || (input.department ? named.test(input.department) : false)
    if (mentionsProject && freeText.some((t) => writes.test(t))) refuse(`frozen:${project.id}`, `${project.reason} The request names it and asks for a change.`)
  }
  return { passed: rules.length === 0, rules, reasons }
}
