/**
 * Task commands (M7 part 4), run on the founder's computer or the host.
 *
 *   npm run tasks -- submit "<objective>" [--capability <id>] [--department <d>] [--key <idempotencyKey>]
 *   npm run tasks -- list [--status <status>]
 *   npm run tasks -- show <taskId>
 *   npm run tasks -- cancel <taskId> ["reason"]
 *   npm run tasks -- approve <taskId> ["justification"]      a human founder only
 *   npm run tasks -- deny <taskId> ["reason"]                 a human founder only
 *   npm run tasks -- capabilities
 *   npm run tasks -- client add <name>       prints the new client's token ONCE
 *   npm run tasks -- client list
 *   npm run tasks -- client revoke <name>
 *
 * The CLI uses the same intake as the host (TaskService.submit, source "cli")
 * and the same files: <data>/tasks/ next to the file run store of
 * QUICKSILVER_HOST_CONFIG (default quicksilver.host.json; data/ when there is
 * no config file), or QUICKSILVER_TASKS_DIR. Whoever holds these files runs
 * the business, so the CLI acts as QUICKSILVER_TASKS_ACTOR (default
 * entity-founder), a human with the founder's intent-provider role; every
 * change is attributed to that id in the task's audit trail.
 *
 * Approving your own submission is a separation-of-duties conflict. With
 * QUICKSILVER_SOLE_OPERATOR_ID set to your id, you may, with a written
 * justification of at least 20 characters.
 *
 * The CLI has no run queue: a task the kernel would let run is queued for a
 * human here. Submit through the running host to have a configured workflow run.
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { AccessController, type Principal } from '@quicksilver/kernel/identity'

import { loadHostConfig, parseHostConfig, type HostConfig } from './config.ts'
import { createSanityStoreClient } from './sanity-client.ts'
import { FileShadowStore, MemoryShadowStore, type ShadowStore } from './shadow-api.ts'
import { SanityShadowStore } from './shadow-store-sanity.ts'
import { TaskError, TaskService, taskView, TASK_STATUSES, type Task } from './tasks.ts'
import { taskSetup } from './tasks-setup.ts'

const root = process.env.INIT_CWD ?? process.cwd()
const [cmd, ...args] = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const VALUE_FLAGS = ['--capability', '--department', '--key', '--status']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1]!)))

function fail(message: string): never { console.error(message); process.exit(1) }

async function hostConfig(): Promise<HostConfig> {
  const tenantId = process.env.QUICKSILVER_TENANT_ID?.trim() || 'default'
  const name = process.env.QUICKSILVER_HOST_CONFIG ?? 'quicksilver.host.json'
  const path = isAbsolute(name) ? name : resolve(root, name)
  if (existsSync(path)) return loadHostConfig(path, { tenantId })
  return parseHostConfig({ tenantId, store: { kind: 'file', path: resolve(root, 'data/runs.jsonl') } })
}

async function shadowStore(config: HostConfig): Promise<ShadowStore> {
  if ((process.env.QUICKSILVER_SHADOW_STORE ?? '').trim() === 'sanity') {
    const client = await createSanityStoreClient()
    if (!client) fail('QUICKSILVER_SHADOW_STORE=sanity needs NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_AUTH_TOKEN.')
    return new SanityShadowStore(client)
  }
  return config.store.kind === 'file' ? new FileShadowStore(join(dirname(config.store.path), 'intent', 'onboard')) : new MemoryShadowStore()
}

function line(t: Task): string {
  const reason = t.decision?.reasons[0] ? ` — ${t.decision.reasons[0]}` : ''
  return `${t.id}  ${t.status.padEnd(17)} ${t.source.padEnd(7)} ${t.submittedBy.padEnd(24)} ${t.capabilityId ?? '(triage)'}  "${t.objective.slice(0, 60)}${t.objective.length > 60 ? '…' : ''}"${reason}`
}

async function main(): Promise<void> {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('Commands: submit, list, show, cancel, approve, deny, capabilities, client add|list|revoke. See the header of packages/host/src/tasks-cli.ts.')
    return
  }
  const config = await hostConfig()
  const setup = taskSetup(config, { baseDir: root })
  const actorId = process.env.QUICKSILVER_TASKS_ACTOR?.trim() || 'entity-founder'
  const actor: Principal = { id: actorId, kind: 'human', tenantId: config.tenantId, roles: ['intent-provider'] }

  if (cmd === 'client') {
    const [op, name] = positional
    if (op === 'add' && name) {
      const { client, token } = await setup.clients.add(name, actorId)
      console.log(`Added client ${client.name} (${client.principalId}, role task-client: submit tasks and read its own).`)
      console.log('Its token is shown ONCE. Put it in the client\'s config (for MCP: QUICKSILVER_TASK_TOKEN); it is not stored anywhere readable:')
      console.log(token)
      return
    }
    if (op === 'list') {
      const clients = await setup.clients.list()
      if (!clients.length) console.log('No task clients. Add one with: npm run tasks -- client add <name>')
      for (const c of clients) console.log(`${c.name.padEnd(24)} ${c.principalId.padEnd(32)} ${c.active ? 'active ' : 'revoked'}  added ${c.createdAt.slice(0, 10)} by ${c.createdBy}${c.revokedAt ? `, revoked ${c.revokedAt.slice(0, 10)} by ${c.revokedBy}` : ''}`)
      return
    }
    if (op === 'revoke' && name) {
      const c = await setup.clients.revoke(name, actorId)
      console.log(`Revoked ${c.name}: its token no longer works (a running host notices within one request).`)
      return
    }
    fail('Usage: client add <name> | client list | client revoke <name>')
  }

  const service = new TaskService({
    tenantId: config.tenantId,
    access: new AccessController(),
    store: setup.store,
    catalog: setup.catalog,
    boundaries: setup.boundaries,
    autonomy: setup.autonomy,
    shadow: { store: await shadowStore(config), intentId: config.tasks.shadowIntentId },
    rateLimit: config.tasks.rateLimit,
    soleOperatorId: setup.soleOperatorId,
  })

  switch (cmd) {
    case 'submit': {
      const objective = positional[0]
      if (!objective) fail('Usage: submit "<objective>" [--capability <id>] [--department <d>] [--key <idempotencyKey>]')
      const { task, deduplicated } = await service.submit({
        source: 'cli',
        principal: actor,
        objective,
        ...(flag('--capability') ? { capabilityId: flag('--capability') } : {}),
        ...(flag('--department') ? { department: flag('--department') } : {}),
        ...(flag('--key') ? { idempotencyKey: flag('--key') } : {}),
      })
      console.log(`${deduplicated ? 'Existing task (same key)' : 'Submitted'}: ${line(task)}`)
      for (const r of task.decision?.reasons.slice(1) ?? []) console.log(`  - ${r}`)
      if (task.execution) console.log(`  ${task.execution.note}`)
      return
    }
    case 'list': {
      const status = flag('--status')
      if (status && !TASK_STATUSES.includes(status as Task['status'])) fail(`--status must be one of ${TASK_STATUSES.join(', ')}.`)
      const tasks = await service.list(actor, status ? { status } : {})
      if (!tasks.length) console.log('No tasks.')
      for (const t of tasks) console.log(line(t))
      return
    }
    case 'show': {
      const id = positional[0] ?? fail('Usage: show <taskId>')
      console.log(JSON.stringify(taskView(await service.get(actor, id), true), null, 2))
      return
    }
    case 'cancel':
    case 'approve':
    case 'deny': {
      const [id, reason] = positional
      if (!id) fail(`Usage: ${cmd} <taskId> ["reason"]`)
      const task = cmd === 'cancel' ? await service.cancel(actor, id, reason) : cmd === 'approve' ? await service.approve(actor, id, reason) : await service.deny(actor, id, reason)
      console.log(`${cmd === 'cancel' ? 'Cancelled' : cmd === 'approve' ? 'Approved' : 'Denied'}: ${line(task)}`)
      if (cmd === 'approve' && task.execution) console.log(`  ${task.execution.note}`)
      return
    }
    case 'capabilities': {
      for (const c of service.capabilities(actor)) console.log(`${c.id.padEnd(28)} ${c.department.padEnd(12)} ${c.description}${c.default ? ' (default)' : ''}`)
      return
    }
    default:
      fail(`Unknown command "${cmd}". Commands: submit, list, show, cancel, approve, deny, capabilities, client add|list|revoke.`)
  }
}

main().catch((error) => {
  if (error instanceof TaskError) fail(`${error.message} (${error.code})`)
  fail((error as Error).message)
})
