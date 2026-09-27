/**
 * The local sandbox: runs commands as child processes of the operator, in the
 * workspace, with an allowlisted environment (no API keys or tokens), a time
 * limit, an output cap, and its own process group so a timeout kills the
 * whole tree. It confines by policy, not by the kernel: use the Docker
 * sandbox for untrusted work.
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { sandboxEnv } from '../policy.ts'
import type { Sandbox, SandboxRunOptions, SandboxRunResult } from '../types.ts'

export interface LocalSandboxOptions {
  workspace: string
  /** Default 120 s. */
  timeoutMs?: number
  /** Bytes kept per stream; default 200 kB. */
  maxOutputBytes?: number
  env?: Readonly<Record<string, string | undefined>>
}

export class LocalSandbox implements Sandbox {
  readonly kind = 'local' as const
  private readonly workspace: string
  private readonly timeoutMs: number
  private readonly maxOutput: number
  private readonly env: Record<string, string>

  constructor(options: LocalSandboxOptions) {
    this.workspace = resolve(options.workspace)
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxOutput = options.maxOutputBytes ?? 200_000
    this.env = sandboxEnv(options.env ?? process.env, { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' })
  }

  describe(): string {
    return `local process in ${this.workspace} (allowlisted environment, ${Math.round(this.timeoutMs / 1000)} s limit)`
  }

  run(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    return runProcess(process.platform === 'win32' ? 'cmd.exe' : 'bash', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: options.cwd ? resolve(this.workspace, options.cwd) : this.workspace,
      env: this.env,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxOutput: this.maxOutput,
      stdin: options.stdin,
      signal: options.signal,
    })
  }
}

export interface ProcessOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutput: number
  stdin?: string
  signal?: AbortSignal
}

/** Spawn, collect capped output, enforce the time limit on the whole process group. */
export function runProcess(file: string, args: string[], o: ProcessOptions): Promise<SandboxRunResult> {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const take = (cur: string, chunk: Buffer): string => {
      if (cur.length >= o.maxOutput) { truncated = true; return cur }
      const next = cur + chunk.toString('utf8')
      if (next.length > o.maxOutput) { truncated = true; return next.slice(0, o.maxOutput) }
      return next
    }
    child.stdout.on('data', (c: Buffer) => { stdout = take(stdout, c) })
    child.stderr.on('data', (c: Buffer) => { stderr = take(stderr, c) })
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* already gone */ }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, o.timeoutMs)
    const onAbort = () => { timedOut = true; kill() }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { stderr += `\n${e.message}` })
    child.on('close', (code) => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      done({ exitCode: timedOut ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - started, truncated })
    })
    if (o.stdin !== undefined) child.stdin.end(o.stdin)
    else child.stdin.end()
  })
}
