/**
 * The lab's own standing boundaries, kept as data in
 * `deploy/boundaries/lab.json` so the code stays generic (and a public
 * edition can leave the file out). When the file exists, the task intake
 * merges its rules over the built-in ones (tasks-setup.ts) and the Onboard
 * CSV connector refuses sources matching its `connectorPatterns`
 * (onboard-cli.ts). Both can only add to the built-in rules.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TaskBoundaryConfig } from './task-boundaries.ts'

export const LAB_BOUNDARIES_PATH = join('deploy', 'boundaries', 'lab.json')

export interface LabBoundaryFile extends Partial<TaskBoundaryConfig> {
  /** Source-name patterns (case-insensitive regular expression sources) the Onboard connectors refuse. */
  connectorPatterns?: string[]
}

/** The lab boundaries file under `baseDir`, or undefined when there is none. Throws on a malformed file. */
export function readLabBoundaries(baseDir: string): LabBoundaryFile | undefined {
  const file = join(baseDir, LAB_BOUNDARIES_PATH)
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as LabBoundaryFile
  if (!parsed || typeof parsed !== 'object') throw new Error(`${file} must be a JSON object.`)
  if (parsed.connectorPatterns !== undefined && (!Array.isArray(parsed.connectorPatterns) || parsed.connectorPatterns.some((p) => typeof p !== 'string' || !p))) {
    throw new Error(`${file}: connectorPatterns must be a list of regular expression sources.`)
  }
  return parsed
}

/** The connector patterns of a lab boundaries file, compiled (case-insensitive). */
export function labConnectorPatterns(file: LabBoundaryFile | undefined): RegExp[] {
  return (file?.connectorPatterns ?? []).map((p) => new RegExp(p, 'i'))
}
