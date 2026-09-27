/**
 * Builds the task interface's parts from the host config, for both the host
 * (main.ts) and the CLI (tasks-cli.ts), so they read and write the same files:
 *
 *   <data>/tasks/<taskId>.json   one file per task (append-only, mode 0600)
 *   <data>/tasks/clients.json    task clients: names and token digests (mode 0600)
 *
 * <data> is the directory of a file run store; QUICKSILVER_TASKS_DIR moves the
 * tasks directory. Without either, tasks are held in memory.
 *
 * Department autonomy is read the way `npm run operate -- status` reads it:
 * the provider's grants in the intent ledger of QUICKSILVER_COMPANY_ID and the
 * shadow evidence in <data>/intent/onboard/*. Without a company id every
 * department is `advise`, so nothing runs on its own.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { departmentAutonomy, type DepartmentAutonomy } from '@quicksilver/kernel/playbooks/operate'
import { DEFAULT_HAND_OVER } from '@quicksilver/kernel/playbooks/shadow'

import type { HostConfig } from './config.ts'
import { departmentStatus } from './operate-store.ts'
import { DEFAULT_TASK_BOUNDARIES, mergeBoundaries, type TaskBoundaryConfig } from './task-boundaries.ts'
import { readLabBoundaries } from './lab-boundaries.ts'
import { FileTaskClientPersistence, MemoryTaskClientPersistence, TaskClientRegistry } from './task-clients.ts'
import { FileTaskStore, MemoryTaskStore, validateCatalog, type TaskCatalog, type TaskStore } from './tasks.ts'

/** Used only when no catalog file exists: every task goes to a human. */
export const FALLBACK_TASK_CATALOG: TaskCatalog = {
  defaultCapabilityId: 'task.triage',
  capabilities: [{
    id: 'task.triage',
    name: 'Triage a request',
    description: 'A free-text request for a person to read and decide what to do. It always goes to a human.',
    department: 'operations',
    baseRiskLevel: 4,
    reversible: true,
    operationalImpact: 1,
    uncertainty: 3,
  }],
  policies: [],
}

export interface TaskSetup {
  dir: string | undefined
  store: TaskStore
  clients: TaskClientRegistry
  catalog: TaskCatalog
  catalogPath: string | undefined
  boundaries: TaskBoundaryConfig
  autonomy: (department: string) => Promise<DepartmentAutonomy>
  soleOperatorId: string | null
  notes: string[]
}

export function taskSetup(config: HostConfig, options: { baseDir: string; env?: Record<string, string | undefined> }): TaskSetup {
  const env = options.env ?? process.env
  const notes: string[] = []
  const dataDir = config.store.kind === 'file' ? dirname(config.store.path) : undefined
  const dir = env.QUICKSILVER_TASKS_DIR ? resolve(options.baseDir, env.QUICKSILVER_TASKS_DIR) : dataDir ? join(dataDir, 'tasks') : undefined
  if (!dir) notes.push('Tasks and task clients are kept in memory; use a file store or QUICKSILVER_TASKS_DIR to keep them.')

  const catalogPath = config.tasks.catalog ?? resolve(options.baseDir, 'deploy/tasks/catalog.json')
  let catalog = FALLBACK_TASK_CATALOG
  let usedPath: string | undefined
  if (existsSync(catalogPath)) {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as TaskCatalog
    const errors = validateCatalog(catalog)
    if (errors.length) throw new Error(`The task catalog ${catalogPath} is invalid: ${errors.join(' ')}`)
    usedPath = catalogPath
  } else notes.push(`No task catalog at ${catalogPath}: every task goes to a human for triage.`)

  // Built-in generic rules, then the lab's own (deploy/boundaries/lab.json),
  // then any file named in the host config: each can only add.
  const lab = readLabBoundaries(options.baseDir)
  const withLab = lab ? mergeBoundaries(DEFAULT_TASK_BOUNDARIES, lab) : DEFAULT_TASK_BOUNDARIES
  const boundaries = config.tasks.boundaries
    ? mergeBoundaries(withLab, JSON.parse(readFileSync(config.tasks.boundaries, 'utf8')) as Partial<TaskBoundaryConfig>)
    : withLab

  const companyId = env.QUICKSILVER_COMPANY_ID?.trim()
  const intentDir = dataDir ? join(dataDir, 'intent') : undefined
  if (!companyId || !intentDir) notes.push('QUICKSILVER_COMPANY_ID or a file store is not set: every department is advise-only, so tasks are recommendations and nothing runs on its own.')
  const autonomy = async (department: string): Promise<DepartmentAutonomy> => {
    if (!companyId || !intentDir) return departmentAutonomy(undefined, undefined, department)
    const status = await departmentStatus(intentDir, companyId, DEFAULT_HAND_OVER)
    return status.departments.find((d) => d.department === department) ?? departmentAutonomy(undefined, undefined, department)
  }

  return {
    dir,
    store: dir ? new FileTaskStore(dir) : new MemoryTaskStore(),
    clients: new TaskClientRegistry({ persistence: dir ? new FileTaskClientPersistence(join(dir, 'clients.json')) : new MemoryTaskClientPersistence(), tenantId: config.tenantId }),
    catalog,
    catalogPath: usedPath,
    boundaries,
    autonomy,
    soleOperatorId: env.QUICKSILVER_SOLE_OPERATOR_ID?.trim() || null,
    notes,
  }
}
