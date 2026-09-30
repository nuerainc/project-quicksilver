/** Coordinates two-stage process shutdown so signal handling is testable. */
export interface ShutdownDependencies {
  stop(options?: { abort?: boolean }): Promise<void>
  exit(code: number): void
  schedule(callback: () => void, delayMs: number): { unref?(): void }
  log: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void }
  timeoutMs?: number
}

export function createShutdownHandler(deps: ShutdownDependencies): (signal: string) => void {
  let stopping = false
  return (signal) => {
    if (stopping) {
      deps.log.warn('second signal; aborting in-flight runs', { signal })
      void deps.stop({ abort: true }).finally(() => deps.exit(1))
      return
    }
    stopping = true
    deps.log.info('shutdown requested', { signal })
    const timer = deps.schedule(() => {
      deps.log.error('graceful shutdown timed out; aborting in-flight runs')
      void deps.stop({ abort: true }).finally(() => deps.exit(1))
    }, deps.timeoutMs ?? 60_000)
    timer.unref?.()
    void deps.stop().then(() => deps.exit(0), () => deps.exit(1))
  }
}
