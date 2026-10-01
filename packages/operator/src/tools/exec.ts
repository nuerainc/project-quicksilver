/**
 * Execution tools: run a shell command, or a Python or Node script, in the
 * sandbox. Every command is classified by the policy (policy.ts) first.
 *
 * **The command policy is a tripwire, not a gate, and it is not a guarantee.**
 *
 * For `run_command` it sees the exact text that will run, so a refusal there is
 * real. For `run_code` it sees only the script *source*, and a program is not
 * statically classifiable: anything that builds its command at runtime gets
 * past a pattern match. Verified examples that classify as `ok` today:
 *
 *     subprocess.run(["rm","-rf","/"])     shutil.rmtree("/")
 *     os.system(base64.b64decode(...))    os.system("curl x" + ".sh | sh")
 *
 * The real containment boundary is the sandbox. The scan is kept because it
 * still catches naive and accidental destructive scripts with a useful reason
 * to show a person — but it must never be read as the thing standing between a
 * script and the machine.
 *
 * Because of that, `run_code` is marked `runsArbitraryCode`: `trusted` mode
 * refuses it, since no approver is shown the program and the mode has nobody to
 * ask. `run_command` is refused there too when it hides a program inside an
 * interpreter flag (`python3 -c '…'`, `node -e '…'`).
 *
 * **Residual risk in `guarded` mode.** A named script is still runnable there —
 * `python3 cleanup.py` executes whatever that file contains, including
 * something the agent wrote a moment earlier through the file tools, whose
 * *content* the write-path check never inspected. Refusing every script
 * execution would gut `guarded`, so this is accepted rather than solved. The
 * sandbox remains the boundary.
 */
import { z } from 'zod'

import type { OperatorTool, SandboxRunResult, ToolResult } from '../types.ts'

const MAX_SHOWN = 20_000

export function formatRun(r: SandboxRunResult): ToolResult {
  const cut = (s: string) => (s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN / 2)}\n[… ${s.length - MAX_SHOWN} characters cut …]\n${s.slice(-MAX_SHOWN / 2)}` : s)
  const parts = [
    r.timedOut ? `Timed out after ${Math.round(r.durationMs / 1000)} s.` : `Exit code ${r.exitCode}.`,
    r.stdout.trim() ? `stdout:\n${cut(r.stdout.trimEnd())}` : '',
    r.stderr.trim() ? `stderr:\n${cut(r.stderr.trimEnd())}` : '',
    r.truncated ? '[output was cut at the sandbox limit]' : '',
  ].filter(Boolean)
  return { ok: !r.timedOut && r.exitCode === 0, output: parts.join('\n'), facts: { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs } }
}

export const runCommandTool: OperatorTool<{ command: string; cwd?: string; timeoutSeconds?: number }> = {
  name: 'run_command',
  description: 'Run a shell command in the sandbox, in the workspace (or a subfolder). Returns the exit code and output. Dangerous commands wait for a person; destructive ones are refused.',
  tier: 'execute',
  input: z.object({ command: z.string().min(1).max(10_000), cwd: z.string().optional(), timeoutSeconds: z.number().int().min(1).max(1800).optional() }),
  summarize: (i) => `$ ${i.command.length > 160 ? `${i.command.slice(0, 160)}…` : i.command}`,
  commands: (i) => [i.command],
  async run(i, ctx) {
    return formatRun(await ctx.sandbox.run(i.command, { cwd: i.cwd, timeoutMs: (i.timeoutSeconds ?? 120) * 1000, signal: ctx.signal }))
  },
}

export const runCodeTool: OperatorTool<{ language: 'python' | 'node'; code: string; timeoutSeconds?: number }> = {
  name: 'run_code',
  description: 'Run a Python or Node.js script in the sandbox with the workspace as the working folder. Print what you need to see.',
  tier: 'execute',
  input: z.object({ language: z.enum(['python', 'node']), code: z.string().min(1).max(200_000), timeoutSeconds: z.number().int().min(1).max(1800).optional() }),
  summarize: (i) => `${i.language} script (${i.code.split('\n').length} lines)`,
  // The script is the program. Nothing an approver is shown reveals what it
  // will do, so `trusted` mode refuses it rather than auto-running it.
  runsArbitraryCode: true,
  // Classify the script text as commands too: a script that shells out to
  // something destructive is refused like the command itself. This is a
  // tripwire, not the control — see the note above.
  commands: (i) => [i.code],
  async run(i, ctx) {
    const bin = i.language === 'python' ? 'python3 -' : 'node -'
    return formatRun(await ctx.sandbox.run(bin, { stdin: i.code, timeoutMs: (i.timeoutSeconds ?? 120) * 1000, signal: ctx.signal }))
  },
}

export const EXEC_TOOLS = [runCommandTool, runCodeTool] as const
