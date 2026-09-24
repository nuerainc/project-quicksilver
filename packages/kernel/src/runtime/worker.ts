import { executeWorkflowGraph, type WorkflowExecutionOptions, type WorkflowExecutionResult, type WorkflowRuntimeHandlers } from '../workflows/runtime.ts'
import type { WorkflowRunQueue } from './queue.ts'
import type { WorkflowRunRecord } from './store.ts'

export interface WorkflowRunWorkerOptions {
  queue: WorkflowRunQueue
  workerId: string
  /**
   * Resolve handlers per run so credentials and tool registries can be scoped
   * to the run's tenant. Throwing here fails the attempt without running a step.
   */
  resolveHandlers(run: Readonly<WorkflowRunRecord>): WorkflowRuntimeHandlers | Promise<WorkflowRuntimeHandlers>
  /** Runs executed at once by this worker (1–32, default 1). */
  concurrency?: number
  /** Heartbeat cadence; defaults to a third of the queue lease. */
  heartbeatMs?: number
  /** Idle poll interval for `start()` (default 1 s). */
  pollIntervalMs?: number
  /** Passed through to the graph runner (`signal` is managed by the worker). */
  execution?: Omit<WorkflowExecutionOptions, 'signal'>
  /** Observability hook; errors thrown here are ignored. */
  onRunFinished?(run: WorkflowRunRecord): void
}

/**
 * Pulls runs from a `WorkflowRunQueue`, executes them with the governed graph
 * runner, heartbeats the lease, and propagates cancellation into handlers.
 */
export class WorkflowRunWorker {
  private readonly concurrency: number
  private readonly heartbeatMs: number
  private readonly pollIntervalMs: number
  private readonly inFlight = new Set<Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private loop?: Promise<void>
  private stopping = false
  private wake?: () => void

  private readonly options: WorkflowRunWorkerOptions

  constructor(options: WorkflowRunWorkerOptions) {
    this.options = options
    const concurrency = options.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Worker concurrency must be an integer from 1 to 32.')
    this.concurrency = concurrency
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(options.queue.leaseMs / 3))
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
  }

  /** Claim and execute at most one run. Returns the final record, or undefined when nothing is claimable. */
  async runOnce(): Promise<WorkflowRunRecord | undefined> {
    const run = await this.options.queue.claim(this.options.workerId)
    if (!run) return undefined
    return this.execute(run)
  }

  /** Process claimable runs until none remain, honouring `concurrency`. */
  async drain(): Promise<WorkflowRunRecord[]> {
    const finished: WorkflowRunRecord[] = []
    const lanes = Array.from({ length: this.concurrency }, async () => {
      for (;;) {
        const record = await this.runOnce()
        if (!record) return
        finished.push(record)
      }
    })
    await Promise.all(lanes)
    return finished
  }

  /** Start a background poll loop. Call `stop()` for a graceful shutdown. */
  start(): void {
    if (this.loop) return
    this.stopping = false
    this.loop = this.poll()
  }

  /** Stop claiming new runs and wait for in-flight runs. `abort: true` cancels them first. */
  async stop(options: { abort?: boolean } = {}): Promise<void> {
    this.stopping = true
    this.wake?.()
    if (options.abort) for (const controller of this.controllers.values()) controller.abort(new Error('Worker is shutting down.'))
    await this.loop
    await Promise.all(this.inFlight)
    this.loop = undefined
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      await this.options.queue.recoverExpiredLeases().catch(() => undefined)
      let claimed = false
      while (!this.stopping && this.inFlight.size < this.concurrency) {
        const run = await this.options.queue.claim(this.options.workerId).catch(() => undefined)
        if (!run) break
        claimed = true
        const task = this.execute(run).then(() => undefined, () => undefined)
        this.inFlight.add(task)
        void task.finally(() => {
          this.inFlight.delete(task)
          this.wake?.()
        })
      }
      if (this.stopping) break
      if (!claimed || this.inFlight.size >= this.concurrency) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollIntervalMs)
          this.wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        this.wake = undefined
      }
    }
  }

  private async execute(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    const { queue, workerId } = this.options
    const controller = new AbortController()
    this.controllers.set(run.runId, controller)
    let leaseLost = false
    const heartbeat = setInterval(() => {
      void queue.heartbeat(run.runId, workerId).then(async (fresh) => {
        if (!fresh) {
          leaseLost = true
          controller.abort(new Error('Worker lost the run lease.'))
          return
        }
        if (fresh.cancelRequest) controller.abort(new Error(fresh.cancelRequest.reason))
      }).catch(() => undefined)
    }, this.heartbeatMs)

    let result: WorkflowExecutionResult
    try {
      const handlers = await this.options.resolveHandlers(run)
      result = await executeWorkflowGraph(run.graph, run.input, handlers, { ...this.options.execution, signal: controller.signal })
    } catch (error) {
      result = { status: 'failed', outputs: {}, steps: [], error: `Run setup failed: ${(error as Error)?.message ?? 'unknown error'}` }
    } finally {
      clearInterval(heartbeat)
      this.controllers.delete(run.runId)
    }

    if (leaseLost) {
      // Another process now owns recovery for this run; never overwrite it.
      const current = await queue.get(run.runId)
      return current ?? run
    }
    let finished: WorkflowRunRecord
    try {
      finished = await queue.complete(run.runId, workerId, result)
    } catch {
      // The lease was recovered or the record changed underneath us; the stored
      // record is authoritative and this attempt's outcome is not applied.
      return (await queue.get(run.runId)) ?? run
    }
    try {
      this.options.onRunFinished?.(finished)
    } catch {
      // Observability hooks must not change run outcomes.
    }
    return finished
  }
}
