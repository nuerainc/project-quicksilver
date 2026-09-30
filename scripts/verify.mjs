import { spawnSync } from 'node:child_process'

const commands = [
  ['kernel:test', 'Kernel regression suite'],
  ['agent:test', 'Agent regression suite'],
  ['host:test', 'Host regression suite'],
  ['operator:test', 'Operator regression suite'],
  ['aura:test', 'Aura regression suite'],
  ['seed:test', 'Seed and web security suite'],
  ['sdk:test', 'TypeScript SDK contract suite'],
  ['typecheck', 'TypeScript checks'],
]

let totalTests = 0
let totalPassed = 0
let failedStage = null

for (const [script, label] of commands) {
  process.stdout.write(`\n==> ${label} (npm run ${script})\n`)
  const result = spawnSync('npm', ['run', script], {
    encoding: 'utf8',
    // On Windows `npm` is a .cmd shim, which spawnSync cannot exec without a
    // shell; without this the spawn fails with ENOENT and `status` stays null.
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')

  if (result.error) {
    console.error(`\nVERIFY FAILED: ${script} could not be started (${result.error.code ?? result.error.message})`)
    process.exit(1)
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  for (const match of output.matchAll(/(?:ℹ|#) tests (\d+)/g)) totalTests += Number(match[1])
  for (const match of output.matchAll(/(?:ℹ|#) pass (\d+)/g)) totalPassed += Number(match[1])

  if (result.status !== 0) {
    failedStage = script
    break
  }
}

if (failedStage) {
  console.error(`\nVERIFY FAILED: ${failedStage}`)
  process.exit(1)
}

console.log(`\nVERIFY PASSED: ${totalPassed}/${totalTests} tests passed; type checks passed.`)
