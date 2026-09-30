/**
 * The Docker sandbox: each command runs in a fresh container with the
 * workspace mounted at /work, no network by default, all Linux capabilities
 * dropped, no privilege escalation, and CPU, memory and process limits.
 * The container is removed afterwards. This is the backend for untrusted
 * work (code an agent wrote, downloads, customer files).
 */
import { resolve } from 'node:path'

import { sandboxEnv } from '../policy.ts'
import type { Sandbox, SandboxRunOptions, SandboxRunResult } from '../types.ts'
import { runProcess } from './local.ts'

export interface DockerSandboxOptions {
  workspace: string
  /** Default `node:22-bookworm` (bash, Node, Python 3). */
  image?: string
  /** Default false: no network inside the container. */
  network?: boolean
  cpus?: number
  memoryMb?: number
  pidsLimit?: number
  timeoutMs?: number
  maxOutputBytes?: number
  /** The docker binary; default `docker`. */
  docker?: string
}

export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const
  private readonly o: Required<Omit<DockerSandboxOptions, 'workspace'>> & { workspace: string }

  constructor(options: DockerSandboxOptions) {
    this.o = {
      workspace: resolve(options.workspace),
      image: options.image ?? 'node:22-bookworm',
      network: options.network ?? false,
      cpus: options.cpus ?? 1,
      memoryMb: options.memoryMb ?? 1024,
      pidsLimit: options.pidsLimit ?? 256,
      timeoutMs: options.timeoutMs ?? 120_000,
      maxOutputBytes: options.maxOutputBytes ?? 200_000,
      docker: options.docker ?? 'docker',
    }
  }

  describe(): string {
    return `docker ${this.o.image} (${this.o.network ? 'network on' : 'no network'}, ${this.o.cpus} CPU, ${this.o.memoryMb} MB, all capabilities dropped)`
  }

  /** The `docker run` arguments for a command. Pure; exported for tests. */
  args(command: string, cwd = '.'): string[] {
    const workdir = `/work/${cwd.replace(/^\.?\/*/, '')}`.replace(/\/+$/, '') || '/work'
    // Docker Desktop accepts drive-qualified forward-slash paths. Native
    // backslashes are treated as escape characters by parts of its CLI.
    const mount = this.o.workspace.replace(/\\/g, '/')
    return [
      'run', '--rm', '-i',
      '--network', this.o.network ? 'bridge' : 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(this.o.pidsLimit),
      '--cpus', String(this.o.cpus),
      '--memory', `${this.o.memoryMb}m`,
      '--read-only', '--tmpfs', '/tmp:rw,size=256m',
      '-v', `${mount}:/work`,
      '-w', workdir,
      '-e', 'HOME=/tmp', '-e', 'PYTHONUNBUFFERED=1', '-e', 'PYTHONDONTWRITEBYTECODE=1',
      this.o.image, 'bash', '-c', command,
    ]
  }

  run(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    return runProcess(this.o.docker, this.args(command, options.cwd), {
      cwd: this.o.workspace,
      env: sandboxEnv(process.env),
      timeoutMs: options.timeoutMs ?? this.o.timeoutMs,
      maxOutput: this.o.maxOutputBytes,
      stdin: options.stdin,
      signal: options.signal,
    })
  }
}
