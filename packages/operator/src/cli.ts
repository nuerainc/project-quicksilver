/**
 * Run the Operator from a terminal.
 *
 *   npm run operator -- "Add a /health route and a test for it" \
 *     --workspace ./sandbox --verify "npm test" --mode guarded --sandbox local
 *
 * Options:
 *   --workspace <dir>   where the agent works (created if missing); default ./operator-workspace
 *   --verify <cmd>      a command the runtime runs after the agent finishes (repeatable)
 *   --mode <m>          manual | guarded (default) | trusted
 *   --sandbox <s>       local (default) | docker
 *   --network           docker only: allow network access
 *   --max-steps <n>     model steps (default 40)
 *   --rollback <runId>  undo every file change a run made, then exit
 *
 * Calls that need a person are asked here (y/n). Who approves is
 * NQC_SUPERVISOR_ID (or QUICKSILVER_OPERATOR_APPROVER). The model is the
 * agent package's `executor` role (see packages/agent/src/models.ts).
 * The audit log is <workspace>/.qs-audit/operator.jsonl.
 */
import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'

import { loadRepoEnv } from '@quicksilver/agent/decision-predictor'
import { modelForRole } from '@quicksilver/agent/models'

import { aiSdkDriver } from './ai-driver.ts'
import { FileAuditSink, verifyAudit } from './audit.ts'
import { FileCheckpointStore } from './checkpoints.ts'
import { Gate, type Approver } from './gate.ts'
import { runOperator } from './loop.ts'
import { DockerSandbox } from './sandbox/docker.ts'
import { LocalSandbox } from './sandbox/local.ts'
import { EXEC_TOOLS } from './tools/exec.ts'
import { ensureWorkspace, FILE_TOOLS } from './tools/files.ts'
import type { ApprovalMode, Sandbox } from './types.ts'

loadRepoEnv()

function args(argv: string[]) {
  const out: { goal: string[]; verify: string[]; [k: string]: string | string[] | boolean | undefined } = { goal: [], verify: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--verify') out.verify.push(argv[++i] ?? '')
    else if (a === '--network') out.network = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
    else out.goal.push(a)
  }
  return out
}

const o = args(process.argv.slice(2))
const root = process.env.INIT_CWD ?? process.cwd()
const workspace = await ensureWorkspace(join(root, String(o.workspace ?? 'operator-workspace')))
const checkpoints = new FileCheckpointStore(workspace)

if (o.rollback) {
  const restored = await checkpoints.rollback(String(o.rollback))
  console.log(restored.length ? `Restored ${restored.length} file(s):\n  ${restored.join('\n  ')}` : 'Nothing to restore for that run.')
  process.exit(0)
}

const goal = o.goal.join(' ').trim()
if (!goal) {
  console.error('Usage: npm run operator -- "<goal>" [--workspace dir] [--verify cmd] [--mode manual|guarded|trusted] [--sandbox local|docker]')
  process.exit(1)
}
const mode = (String(o.mode ?? 'guarded')) as ApprovalMode
if (!['manual', 'guarded', 'trusted'].includes(mode)) { console.error('--mode must be manual, guarded or trusted.'); process.exit(1) }
const sandbox: Sandbox = o.sandbox === 'docker' ? new DockerSandbox({ workspace, network: o.network === true }) : new LocalSandbox({ workspace })
const audit = new FileAuditSink(join(workspace, '.qs-audit', 'operator.jsonl'))
const approverId = process.env.QUICKSILVER_OPERATOR_APPROVER || process.env.NQC_SUPERVISOR_ID || 'local-human'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const approver: Approver = async (r) => {
  console.log(`\n  ? Approval needed: ${r.summary}\n    ${r.reasons.join('\n    ')}`)
  const a = (await rl.question('    Run it? (y/N) ')).trim().toLowerCase()
  return { approved: a === 'y' || a === 'yes', by: approverId, callHash: r.callHash }
}

console.log(`Operator — ${mode} mode, ${sandbox.describe()}\nWorkspace: ${workspace}\n`)
const result = await runOperator({
  gate: new Gate([...FILE_TOOLS, ...EXEC_TOOLS], { mode, workspace, audit }),
  sandbox,
  checkpoints,
  audit,
  workspace,
  model: aiSdkDriver(modelForRole('executor')),
  approver,
}, {
  goal,
  verify: o.verify.filter(Boolean),
  maxSteps: o['max-steps'] ? Number(o['max-steps']) : undefined,
  onEvent: (e) => {
    if (e.type === 'model' && e.text.trim()) console.log(`\n${e.text.trim()}`)
    if (e.type === 'gate' && e.verdict === 'refuse') console.log(`  ✗ refused: ${e.summary} — ${(e.reasons ?? []).join(' ')}`)
    if (e.type === 'tool') console.log(`  ${e.ok ? '✓' : '!'} ${e.tool}: ${e.output.split('\n')[0]}`)
    if (e.type === 'verify') console.log(`  ${e.ok ? '✓' : '✗'} verify: ${e.command}`)
  },
})
rl.close()

const chain = verifyAudit(await audit.read())
console.log(`\n${result.status.toUpperCase()} — ${result.summary}`)
for (const n of result.notes) console.log(`  · ${n}`)
console.log(`\nRun ${result.runId}: ${result.steps} steps, ${result.toolCalls} tool calls, ${result.usage.inputTokens + result.usage.outputTokens} tokens. Audit chain ${chain.valid ? 'intact' : 'BROKEN'}.`)
console.log(`Undo every file change: npm run operator -- --workspace ${String(o.workspace ?? 'operator-workspace')} --rollback ${result.runId}`)
process.exit(result.status === 'verified' || result.status === 'done-unverified' ? 0 : 2)
