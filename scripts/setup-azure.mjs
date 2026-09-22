#!/usr/bin/env node
/**
 * Azure setup — creates (or reuses) an Azure OpenAI resource, deploys one model
 * per Quicksilver role, and writes AZURE_RESOURCE_NAME + AZURE_API_KEY into the
 * repo-root .env. The key is never printed.
 *
 *   az login
 *   npm run setup:azure
 *
 * Deployments created (names are what packages/agent/src/models.ts expects):
 *   qs-planner   qs-reviewer   qs-router   qs-executor
 *
 * Flags (all optional; anything omitted is asked interactively):
 *   --location=eastus2  --resource-group=rg-quicksilver  --name=<resource>
 *   --planner=<model[@version]>  --reviewer=...  --router=...  --executor=...
 *   --yes            skip confirmation prompts
 *
 * Nothing billable is created until you confirm. Deployments are pay-as-you-go
 * per token (charged to your subscription / credits); the resource itself is free.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = join(ROOT, '.env')
const IS_WIN = process.platform === 'win32'

const ROLES = [
  { role: 'planner', deployment: 'qs-planner', hint: 'most capable reasoning model', capacity: 100 },
  { role: 'reviewer', deployment: 'qs-reviewer', hint: 'strong; a different model than the planner if possible', capacity: 100 },
  { role: 'router', deployment: 'qs-router', hint: 'smallest / cheapest', capacity: 50 },
  { role: 'executor', deployment: 'qs-executor', hint: 'fast mid-tier', capacity: 50 },
]

// ── args ──────────────────────────────────────────────────────────────────
const flags = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
  }),
)
const YES = flags.yes === 'true'

// ── input (works for a TTY and for piped stdin, which makes it testable) ──
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const queue = []
const waiting = []
let closed = false
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queue.push(line)))
rl.on('close', () => {
  closed = true
  while (waiting.length) waiting.shift()('')
})
function ask(question, def = '') {
  process.stdout.write(`${question}${def ? ` [${def}]` : ''}: `)
  const next = queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve('') : new Promise((r) => waiting.push(r))
  return next.then((ans) => {
    if (!process.stdin.isTTY) process.stdout.write(`${ans}\n`)
    return ans.trim() || def
  })
}
async function confirm(question) {
  if (YES) return true
  const a = (await ask(`${question} (y/N)`)).toLowerCase()
  return a === 'y' || a === 'yes'
}

// ── az wrapper ────────────────────────────────────────────────────────────
function az(args, { json = true, allowFail = false } = {}) {
  const full = [...args, '--only-show-errors', ...(json ? ['-o', 'json'] : [])]
  const r = spawnSync('az', full, { encoding: 'utf8', shell: IS_WIN, maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`Could not run the Azure CLI: ${r.error.message}`)
  if (r.status !== 0) {
    if (allowFail) return null
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 6).join('\n')
    // Some tenants (e.g. school/enterprise ones) require MFA for management-plane
    // calls even after a normal `az login` succeeds. Give a targeted fix instead
    // of a raw AADSTS error, since the default remedy (re-login) isn't obvious
    // from the error text alone.
    if (/AADSTS50076|interaction_required/i.test(msg)) {
      throw new Error(
        'Azure requires multi-factor authentication for this account, and the ' +
          'current login session doesn\'t have it. Run:\n' +
          '  az logout\n' +
          '  az login --scope https://management.core.windows.net//.default\n' +
          'complete the MFA prompt in the browser, then re-run this script.\n\n' +
          msg,
      )
    }
    // Full command (minus the -o json / --only-show-errors this wrapper adds) so
    // the failing values are visible, not just the first word or two of the verb.
    throw new Error(`az ${args.join(' ')} failed:\n${msg}`)
  }
  if (!json) return r.stdout
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
}

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}
const hr = () => console.log('─'.repeat(72))

// ── .env upsert (no backup file: a stray .env.bak would not be gitignored) ─
function upsertEnv(pairs) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const [key, value] of Object.entries(pairs)) {
    const re = new RegExp(`^\\s*${key}\\s*=`)
    const i = lines.findIndex((l) => re.test(l))
    if (i >= 0) lines[i] = `${key}=${value}`
    else lines.push(`${key}=${value}`)
  }
  // UTF-8 without BOM: a BOM would corrupt the first key for the repo's .env loaders.
  writeFileSync(ENV_FILE, lines.join(eol) + eol, { encoding: 'utf8' })
}

function envIsGitignored() {
  const gi = join(ROOT, '.gitignore')
  return existsSync(gi) && /^\.env\s*$/m.test(readFileSync(gi, 'utf8'))
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nQuicksilver — Azure OpenAI setup\n')

  // 1. Azure CLI + login
  const version = spawnSync('az', ['--version'], { encoding: 'utf8', shell: IS_WIN })
  if (version.error || version.status !== 0) {
    die('Azure CLI not found. Install it (Windows: `winget install Microsoft.AzureCLI`), then run `az login` and retry.')
  }
  const account = az(['account', 'show'], { allowFail: true })
  if (!account) die('Not logged in. Run `az login`, then re-run this script.')
  console.log(`Subscription: ${account.name}  (${account.id})`)
  console.log(`Signed in as: ${account.user?.name ?? '?'}`)
  if (!(await confirm('Use this subscription?'))) die('Cancelled. Run `az account set --subscription <id>` to switch, then re-run.')

  // 2. Resource: reuse or create
  const existing = (az(['cognitiveservices', 'account', 'list'], { allowFail: true }) ?? []).filter(
    (a) => a.kind === 'OpenAI' || a.kind === 'AIServices',
  )
  let res = null // { name, group, location, subdomain }
  if (existing.length && !flags.name) {
    console.log('\nExisting Azure OpenAI / Foundry resources:')
    existing.forEach((a, i) => console.log(`  ${i + 1}) ${a.name}  (${a.location}, group ${a.resourceGroup}, ${a.kind})`))
    console.log('  n) create a new resource')
    const pick = await ask('Reuse one?', 'n')
    const idx = Number(pick) - 1
    if (Number.isInteger(idx) && existing[idx]) {
      const a = existing[idx]
      const sub = a.properties?.customSubDomainName || (a.properties?.endpoint ?? '').match(/^https:\/\/([^./]+)\./)?.[1]
      if (!sub) die(`"${a.name}" has no custom subdomain, which the SDK needs. Create a new resource instead.`)
      res = { name: a.name, group: a.resourceGroup, location: a.location, subdomain: sub, reused: true }
    }
  }
  if (!res) {
    const location = flags.location || (await ask('Azure region', 'eastus2'))
    const group = flags['resource-group'] || (await ask('Resource group', 'rg-quicksilver'))
    const suggested = `quicksilver-openai-${Math.random().toString(36).slice(2, 6)}`
    const name = flags.name || (await ask('Resource name (globally unique)', suggested))
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,63}$/.test(name)) die('Resource name must be 2–64 letters, digits, or hyphens.')
    if (!(await confirm(`Create resource "${name}" in ${location} (group ${group})?`))) die('Cancelled.')
    az(['group', 'create', '-n', group, '-l', location])
    az(['provider', 'register', '--namespace', 'Microsoft.CognitiveServices'], { allowFail: true, json: false })
    console.log('Creating resource (1–2 minutes)…')
    const created = az([
      'cognitiveservices', 'account', 'create',
      '-n', name, '-g', group, '-l', location,
      '--kind', 'OpenAI', '--sku', 'S0', '--custom-domain', name, '--yes',
    ])
    res = { name, group, location, subdomain: created?.properties?.customSubDomainName || name, reused: false }
    console.log(`✓ Resource created: ${res.subdomain}.openai.azure.com`)
  }

  // 3. Models available in this region
  console.log(`\nLooking up chat models deployable in ${res.location}…`)
  const raw = az(['cognitiveservices', 'model', 'list', '-l', res.location], { allowFail: true }) ?? []
  const byName = new Map()
  for (const item of raw) {
    const m = item.model
    if (!m || String(m.capabilities?.chatCompletion) !== 'true') continue
    if (/deprecat/i.test(String(m.lifecycleStatus ?? '')) && !/^GenerallyAvailable$/i.test(m.lifecycleStatus)) continue
    const skus = (m.skus ?? []).filter((s) => ['GlobalStandard', 'Standard', 'DataZoneStandard'].includes(s.name))
    if (!skus.length) continue
    const sku = skus.find((s) => s.name === 'GlobalStandard') ?? skus[0]
    const entry = {
      name: m.name,
      version: m.version,
      format: m.format ?? 'OpenAI',
      sku: sku.name,
      maxCapacity: Number(sku.capacity?.maximum) || null,
      status: m.lifecycleStatus ?? '',
    }
    const prev = byName.get(m.name)
    if (!prev || String(entry.version) > String(prev.version)) byName.set(m.name, entry) // latest version per model
  }
  const models = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (models.length) {
    console.log('\nChat models available (latest version of each):')
    models.forEach((m, i) =>
      console.log(`  ${String(i + 1).padStart(2)}) ${m.name.padEnd(28)} ${String(m.version).padEnd(12)} ${m.sku.padEnd(15)} ${m.status}`),
    )
  } else {
    console.log('  (Could not list models automatically — enter model names manually, as name@version.)')
  }

  const resolveModel = (input) => {
    const n = Number(input)
    if (Number.isInteger(n) && models[n - 1]) return models[n - 1]
    const [name, version] = input.split('@')
    const found = models.find((m) => m.name === name)
    if (found) return version ? { ...found, version } : found
    if (!version) return null // unknown model and no version → can't deploy blind
    return { name, version, format: 'OpenAI', sku: 'GlobalStandard', maxCapacity: null, status: '' }
  }

  // 4. Pick a model per role
  console.log('\nPick a model for each role (number from the list, or name[@version]).')
  const chosen = []
  let previous = ''
  for (const r of ROLES) {
    let model = null
    while (!model) {
      const input = flags[r.role] || (await ask(`  ${r.deployment.padEnd(12)} — ${r.hint}`, previous))
      if (!input) {
        if (closed && !queue.length) die(`No model given for ${r.deployment}.`)
        continue
      }
      model = resolveModel(input)
      if (!model) {
        console.log(`    "${input}" is not in the list; give it as name@version or pick a number.`)
        if (flags[r.role]) die(`Unknown model for --${r.role}.`)
      }
    }
    previous = model.name + (byName.has(model.name) && byName.get(model.name).version === model.version ? '' : `@${model.version}`)
    const capacity = Math.min(r.capacity, model.maxCapacity ?? r.capacity)
    chosen.push({ ...r, model, capacity })
  }

  // 5. Confirm, then create sequentially (parallel creates on one account conflict)
  console.log()
  hr()
  console.log(`Resource: ${res.subdomain}.openai.azure.com  (${res.reused ? 'existing' : 'new'})`)
  for (const c of chosen) {
    console.log(`  ${c.deployment.padEnd(12)} ${c.model.name}@${c.model.version}  ${c.model.sku}  ${c.capacity}K TPM`)
  }
  hr()
  if (!(await confirm('Create these deployments? (pay-as-you-go tokens, billed to your subscription/credits)'))) die('Cancelled.')

  const have = new Set(
    (az(['cognitiveservices', 'account', 'deployment', 'list', '-g', res.group, '-n', res.name], { allowFail: true }) ?? []).map((d) => d.name),
  )
  const results = []
  for (const c of chosen) {
    if (have.has(c.deployment)) {
      console.log(`- ${c.deployment}: already exists, skipped`)
      results.push({ ...c, ok: true, skipped: true })
      continue
    }
    process.stdout.write(`- ${c.deployment}: creating… `)
    try {
      az([
        'cognitiveservices', 'account', 'deployment', 'create',
        '-g', res.group, '-n', res.name, '--deployment-name', c.deployment,
        '--model-name', c.model.name, '--model-version', String(c.model.version), '--model-format', c.model.format,
        '--sku-name', c.model.sku, '--sku-capacity', String(c.capacity),
      ])
      console.log('✓')
      results.push({ ...c, ok: true })
    } catch (err) {
      console.log('✗')
      console.log(String(err.message).split('\n').map((l) => `    ${l}`).join('\n'))
      console.log('    (Common causes: not enough quota for that model/region — retry with a lower capacity or another region.)')
      results.push({ ...c, ok: false })
    }
  }

  // 6. Key → .env (never printed)
  const keys = az(['cognitiveservices', 'account', 'keys', 'list', '-g', res.group, '-n', res.name], { allowFail: true })
  if (!keys?.key1) die('Could not read the API key. Check that you have permission on the resource (Cognitive Services Contributor or higher).')
  upsertEnv({ AZURE_RESOURCE_NAME: res.subdomain, AZURE_API_KEY: keys.key1 })
  console.log(`\n✓ Wrote AZURE_RESOURCE_NAME and AZURE_API_KEY to ${ENV_FILE} (key not shown).`)
  if (!envIsGitignored()) console.log('⚠ .env is NOT listed in .gitignore — add it before committing.')

  const failed = results.filter((r) => !r.ok)
  console.log(`\nEndpoint: https://${res.subdomain}.openai.azure.com`)
  console.log(`Deployments ready: ${results.filter((r) => r.ok).map((r) => r.deployment).join(', ') || 'none'}`)
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.deployment).join(', ')} — fix quota/region and re-run (finished deployments are skipped).`)
  }
  console.log('\nNext:  npm run verify:llm\n')
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => die(err.message))
