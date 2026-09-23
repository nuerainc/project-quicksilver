/**
 * Live end-to-end test of the two process-engine paths that normal use
 * rarely reaches, run against the deployed app and the real dataset:
 *
 *   A. RESUME         A plan made while the Decision Lifecycle definition is
 *                     invalid is held in `proposed` (fail closed). After the
 *                     definition is restored, POST /resume moves each held
 *                     decision on through the kernel's automatic step.
 *   B. RETRY ROLLBACK A change makes the metric worse, a rollback is proposed
 *                     and approved, the rollback's own execution FAILS, the
 *                     original decision is retried through `retry-rollback`,
 *                     the second rollback succeeds, and the original ends
 *                     `rolled-back`.
 *
 * Usage (repo root):
 *   npm run e2e:live                 # run both scenarios, keep the decisions it creates
 *   npm run e2e:live -- --cleanup    # ...then delete everything it created
 *
 * Needs: SANITY_AUTH_TOKEN (write) in the root .env, and on the deployment
 * QUICKSILVER_PROCESS_ENGINE=on plus QUICKSILVER_ALLOW_FAULT_INJECTION=on
 * (scenario B forces execution outcomes; every forced run is stamped
 * `faultInjection` on the decision and its metric).
 * Base URL: QUICKSILVER_E2E_BASE_URL, default https://quicksilver-seven.vercel.app
 *
 * Safety: scenario A breaks the live definition for about a minute (while one
 * plan runs). The exact original is backed up first and restored in a
 * `finally`, on Ctrl+C, and on any error; the restore is verified.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SanityDocument } from '@sanity/client'
import { processFromSanity, type SanityProcessDocument } from '../../../packages/kernel/src/process-document.ts'
import { validateProcessDefinition } from '../../../packages/kernel/src/process.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
function findEnvFiles(startDir: string, maxDepth = 6): string[] {
  const found: string[] = []
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) found.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}
for (const envPath of findEnvFiles(__dirname)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s][^=\s]*)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const BASE = (process.env.QUICKSILVER_E2E_BASE_URL || 'https://quicksilver-seven.vercel.app').replace(/\/$/, '')
const CLEANUP = process.argv.includes('--cleanup')
const LIFECYCLE_ID = 'workflow-decision-lifecycle'
const OBJECTIVE = '[E2E] Schedule preventive maintenance and a diagnostic check on CNC Machine 3 in the next maintenance window.'

const token = process.env.SANITY_AUTH_TOKEN
if (!token) {
  console.error('SANITY_AUTH_TOKEN (write scope) is required in the root .env.')
  process.exit(1)
}
const sanity = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || 'd280bqjc',
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: '2024-10-01',
  token,
  useCdn: false,
})

// ── Tiny assertion + reporting harness ────────────────────────────────────

type Row = { scenario: string; check: string; ok: boolean; detail: string }
const rows: Row[] = []
function check(scenario: string, name: string, ok: boolean, detail = ''): boolean {
  rows.push({ scenario, check: name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}
class Abort extends Error {}
function must(scenario: string, name: string, ok: boolean, detail = '') {
  if (!check(scenario, name, ok, detail)) throw new Abort(`${scenario}: ${name}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function post(path: string, body: unknown = {}, timeoutMs = 60_000): Promise<{ status: number; json: Json }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  } finally {
    clearTimeout(t)
  }
}
const lastTransition = async (id: string) =>
  sanity.fetch<string | null>(`*[_id == $id][0].processHistory[-1].transitionId`, { id })

// ── Definition backup / break / restore ───────────────────────────────────

let backup: SanityDocument | null = null
let broken = false
async function restoreDefinition(): Promise<void> {
  if (!backup || !broken) return
  const { _rev, _updatedAt, _createdAt, ...doc } = backup as SanityDocument & Record<string, unknown>
  void _rev; void _updatedAt; void _createdAt
  await sanity.createOrReplace(doc as SanityDocument)
  broken = false
  console.log('  ↺ Decision Lifecycle restored from backup')
}
process.on('SIGINT', async () => {
  console.log('\nInterrupted — restoring the definition before exiting…')
  await restoreDefinition().catch((e) => console.error('RESTORE FAILED — run "npm run seed:processes" now:', e))
  process.exit(130)
})

const created = { decisions: new Set<string>() }

// ── Scenario A: Resume ────────────────────────────────────────────────────

async function scenarioResume(): Promise<string[]> {
  const S = 'A. Resume'
  console.log(`\n── ${S} ─────────────────────────────────────────────`)
  backup = await sanity.getDocument(LIFECYCLE_ID) as SanityDocument | null
  must(S, 'definition exists and is valid before the test', !!backup && validateProcessDefinition(processFromSanity(backup as unknown as SanityProcessDocument)).valid)

  let held: string[] = []
  try {
    await sanity.patch(LIFECYCLE_ID).set({ 'transitions[_key=="approve"].to': 'e2e-nonexistent-state' }).commit()
    broken = true
    console.log('  ⚠ definition deliberately broken (approve → e2e-nonexistent-state)')

    const refused = await post('/api/decisions/decision-cnc2-param/action', { action: 'request-evidence' })
    check(S, 'while broken, the kernel refuses every transition (409)', refused.status === 409 && /invalid/i.test(refused.json?.error ?? ''), `${refused.status}`)

    console.log('  … planning while broken (about a minute)')
    const plan = await post('/api/plan', { objective: OBJECTIVE }, 240_000)
    must(S, 'plan succeeds while the definition is broken', plan.status === 200, `${plan.status} ${plan.json?.error ?? ''}`)
    const persisted = (plan.json.decisions as Json[]).filter((d) => d.decisionDocId)
    persisted.forEach((d) => created.decisions.add(d.decisionDocId))
    must(S, 'the plan persisted at least one decision', persisted.length > 0, `${persisted.length}`)
    check(S, 'every persisted decision is held in "proposed" (fail closed)', persisted.every((d) => d.status === 'proposed'), persisted.map((d) => d.status).join(', '))
    check(S, 'the UI is told the definition is invalid', persisted.every((d) => d.process?.engine === 'invalid'))
    held = persisted.filter((d) => d.status === 'proposed').map((d) => d.decisionDocId)
  } finally {
    await restoreDefinition()
  }

  const after = await sanity.getDocument(LIFECYCLE_ID)
  must(S, 'definition restored and valid again', !!after && validateProcessDefinition(processFromSanity(after as unknown as SanityProcessDocument)).valid)

  const resumed: string[] = []
  for (const id of held) {
    const r = await post(`/api/decisions/${id}/resume`)
    const moved = r.status === 200 && ['awaiting-approval', 'approved', 'rejected'].includes(r.json?.status)
    check(S, `resume ${id}`, moved, `${r.status} → ${r.json?.status ?? r.json?.error} via ${r.json?.process?.transitionId ?? '—'}`)
    if (moved) resumed.push(id)
    const again = await post(`/api/decisions/${id}/resume`)
    check(S, `resume ${id} a second time is refused`, again.status === 409, `${again.status}`)
  }
  must(S, 'every held decision resumed', resumed.length === held.length && held.length > 0, `${resumed.length}/${held.length}`)
  return resumed
}

// ── Scenario B: Retry rollback ────────────────────────────────────────────

async function scenarioRetryRollback(candidates: string[]) {
  const S = 'B. Retry rollback'
  console.log(`\n── ${S} ─────────────────────────────────────`)
  const docs = await sanity.fetch<Array<{ _id: string; status: string }>>(`*[_id in $ids]{ _id, status }`, { ids: candidates })
  const pick = docs.find((d) => d.status === 'awaiting-approval') ?? docs.find((d) => d.status === 'approved')
  must(S, 'a non-rejected decision is available to execute', !!pick, docs.map((d) => `${d._id}:${d.status}`).join(', '))
  const id = pick!._id

  if (pick!.status === 'awaiting-approval') {
    const a = await post(`/api/decisions/${id}/action`, { action: 'approve' })
    must(S, 'human approves', a.status === 200 && a.json.status === 'approved', `${a.status} ${a.json?.error ?? ''}`)
  }
  const ex = await post(`/api/decisions/${id}/execute`, { inject: 'deviation' })
  if (ex.status === 403) throw new Abort('Fault injection is disabled on the deployment: set QUICKSILVER_ALLOW_FAULT_INJECTION=on in Vercel and redeploy.')
  must(S, 'executes (metric forced to move the wrong way)', ex.status === 200 && ex.json.status === 'executed', `${ex.status} ${ex.json?.error ?? ''}`)
  must(S, 'fault injection applied (deviation)', ex.json.faultInjection === 'deviation', `faultInjection=${JSON.stringify(ex.json.faultInjection)}`)

  const ob = await post(`/api/decisions/${id}/observe`)
  must(S, 'observe detects the deviation', ob.status === 200 && ob.json.deviationDetected === true, `${ob.json?.observed?.pctChange ?? '?'}%`)

  const rb1 = await post(`/api/decisions/${id}/rollback`)
  must(S, 'human proposes rollback #1', rb1.status === 200 && rb1.json.parentStatus === 'rollback-proposed', `${rb1.status} ${rb1.json?.error ?? ''}`)
  created.decisions.add(rb1.json.rollbackDecisionId)
  check(S, 'rollback #1 routed to a human', rb1.json.process?.state === 'awaiting-approval', rb1.json.process?.transitionId)

  const dup = await post(`/api/decisions/${id}/rollback`)
  check(S, 'a second rollback while #1 is pending is refused', dup.status === 409, `${dup.status}`)

  const a1 = await post(`/api/decisions/${rb1.json.rollbackDecisionId}/action`, { action: 'approve' })
  must(S, 'human approves rollback #1', a1.status === 200 && a1.json.status === 'approved')
  const e1 = await post(`/api/decisions/${rb1.json.rollbackDecisionId}/execute`, { inject: 'failure' })
  must(S, 'fault injection applied (failure)', e1.json?.faultInjection === 'failure', `faultInjection=${JSON.stringify(e1.json?.faultInjection)}`)
  must(S, 'rollback #1 execution FAILS',e1.status === 200 && e1.json.status === 'failed' && !e1.json.rolledBackParent, `${e1.status} ${e1.json?.status}`)
  check(S, 'original stays "rollback-proposed" after the failed attempt', (await sanity.fetch(`*[_id == $id][0].status`, { id })) === 'rollback-proposed')

  const rrb = await post(`/api/decisions/${rb1.json.rollbackDecisionId}/rollback`)
  check(S, 'the failed rollback itself cannot be rolled back', rrb.status === 409, `${rrb.status}`)

  const rb2 = await post(`/api/decisions/${id}/rollback`)
  must(S, 'human retries: rollback #2 created', rb2.status === 200, `${rb2.status} ${rb2.json?.error ?? ''}`)
  created.decisions.add(rb2.json.rollbackDecisionId)
  must(S, 'the retry went through the retry-rollback transition', (await lastTransition(id)) === 'retry-rollback')

  const a2 = await post(`/api/decisions/${rb2.json.rollbackDecisionId}/action`, { action: 'approve' })
  must(S, 'human approves rollback #2', a2.status === 200 && a2.json.status === 'approved')
  const e2 = await post(`/api/decisions/${rb2.json.rollbackDecisionId}/execute`, { inject: 'success' })
  must(S, 'rollback #2 executes successfully', e2.status === 200 && e2.json.status === 'executed')
  check(S, 'original decision ends "rolled-back"', e2.json.rolledBackParent?.status === 'rolled-back', JSON.stringify(e2.json.rolledBackParent))
  check(S, 'history ends with complete-rollback', (await lastTransition(id)) === 'complete-rollback')

  const late = await post(`/api/decisions/${id}/rollback`)
  check(S, 'nothing can leave "rolled-back" (terminal)', late.status === 409, `${late.status}`)
}

// ── Cleanup ───────────────────────────────────────────────────────────────

async function cleanup() {
  const ids = [...created.decisions]
  const metrics = await sanity.fetch<string[]>(`*[_type == "metric" && relatedDecision._ref in $ids]._id`, { ids })
  const rollbacks = ids.filter((i) => i.startsWith('decision-rollback-'))
  const plans = ids.filter((i) => !i.startsWith('decision-rollback-'))
  const tx = sanity.transaction()
  for (const id of [...metrics, ...rollbacks, ...plans]) tx.delete(id)
  await tx.commit()
  console.log(`\nCleanup: deleted ${plans.length + rollbacks.length} decisions and ${metrics.length} metrics.`)
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Quicksilver live e2e — ${BASE}`)
  // Probe 1: is the fault-injection code deployed at all? New code validates
  // `inject` and returns 400 for an unknown kind; older code ignores the body
  // and returns 404 for the missing decision.
  const codeProbe = await post('/api/decisions/e2e-probe-does-not-exist/execute', { inject: 'not-a-kind' })
  const deployed = codeProbe.status === 400
  check('Preflight', 'fault-injection code is deployed', deployed, deployed ? '' : `got ${codeProbe.status}: the deployment predates fault injection; push and wait for Vercel to finish`)
  if (!deployed) throw new Abort('fault-injection code not deployed')
  // Probe 2: is it switched on? 403 = off, 404 = on (the decision doesn't exist).
  const probe = await post('/api/decisions/e2e-probe-does-not-exist/execute', { inject: 'failure' })
  check('Preflight', 'fault injection enabled on the deployment', probe.status === 404, probe.status === 403 ? 'disabled — set QUICKSILVER_ALLOW_FAULT_INJECTION=on in Vercel and redeploy' : `${probe.status}`)
  if (probe.status !== 404) throw new Abort('fault injection not enabled')

  let resumed: string[] = []
  try {
    resumed = await scenarioResume()
  } catch (e) {
    if (!(e instanceof Abort)) throw e
  }
  try {
    if (resumed.length) await scenarioRetryRollback(resumed)
    else check('B. Retry rollback', 'skipped (scenario A produced no resumable decision)', false)
  } catch (e) {
    if (!(e instanceof Abort)) throw e
  }
  if (CLEANUP) await cleanup()
}

main()
  .catch(async (e) => {
    if (!(e instanceof Abort)) {
      console.error(e)
      check('Run', 'finished without an unexpected error', false, (e as Error).message)
    }
    await restoreDefinition().catch((err) => console.error('RESTORE FAILED — run "npm run seed:processes" now:', err))
  })
  .finally(() => {
    if (rows.length === 0) check('Run', 'at least one check ran', false)
    const failed = rows.filter((r) => !r.ok)
    console.log(`\n${failed.length === 0 ? '✓ PASS' : '✗ FAIL'}: ${rows.length - failed.length}/${rows.length} checks passed.`)
    for (const f of failed) console.log(`  ✗ [${f.scenario}] ${f.check}${f.detail ? ` — ${f.detail}` : ''}`)
    if (!CLEANUP && created.decisions.size) console.log(`Kept ${created.decisions.size} decisions in the dataset (Decision log). Re-run with -- --cleanup to remove test data instead.`)
    process.exitCode = failed.length === 0 ? 0 : 1
  })
