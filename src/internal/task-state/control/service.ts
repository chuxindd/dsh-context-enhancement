import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TaskStateService } from '../contract/index.ts'
import type { TaskStateStable } from '../contract/types.ts'
import type {
  TaskStateControlFrame,
  TaskStateCommitSource,
  TaskStateEditRequest,
  TaskStateEditResult,
  TaskStateEditSource,
} from './types.ts'

interface Waiter {
  resolve: (result: IteratorResult<TaskStateControlFrame>) => void
  reject: (error: unknown) => void
}

class FrameQueue {
  private readonly frames: TaskStateControlFrame[] = []
  private readonly waiters: Waiter[] = []
  private closed = false

  push(frame: TaskStateControlFrame): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ value: frame, done: false })
    else this.frames.push(frame)
  }

  next(signal: AbortSignal): Promise<IteratorResult<TaskStateControlFrame>> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new Error('task-state stream aborted'))
    }
    if (this.frames.length > 0) return Promise.resolve({ value: this.frames.shift()!, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        this.remove(resolve, reject)
        reject(signal.reason ?? new Error('task-state stream aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.push({
        resolve: result => {
          signal.removeEventListener('abort', abort)
          resolve(result)
        },
        reject: error => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
      if (signal.aborted) abort()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
    this.frames.length = 0
  }

  private remove(resolve: Waiter['resolve'], reject: Waiter['reject']): void {
    const index = this.waiters.findIndex(waiter => waiter.resolve === resolve && waiter.reject === reject)
    if (index >= 0) this.waiters.splice(index, 1)
  }
}

export class TaskStateControlService extends TypertRemoteService {
  static inject = ['sessions', 'taskState']

  constructor(ctx: Context) {
    super(ctx, 'taskStateControl', { namespace: 'taskState' })
    ctx.effect(() => {
      const source = ctx.taskState as TaskStateService & Partial<TaskStateCommitSource>
      const dispose = source.subscribeCommitted?.((sessionId, stable) => {
        for (const queue of this.queues) queue.push({
          type: 'update',
          value: { sessionId, stable },
        })
      })
      return () => {
        dispose?.()
        for (const queue of this.queues) queue.close()
        this.queues.clear()
      }
    }, 'task-state-control.listeners')
  }

  private readonly queues = new Set<FrameQueue>()

  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<TaskStateControlFrame> {
    return this.openControlStream(signal)
  }

  /** Persist a user-authored replacement and return its committed revision. */
  @Remote('edit')
  edit(request: TaskStateEditRequest): Promise<TaskStateEditResult> {
    const source = this.ctx.taskState as TaskStateService & Partial<TaskStateEditSource>
    if (source.editStable === undefined) {
      return Promise.resolve({ ok: false, code: 'unavailable', message: 'This task-state provider does not support editing.' })
    }
    return source.editStable(request)
  }

  private async *openControlStream(signal: AbortSignal): AsyncIterable<TaskStateControlFrame> {
    if (signal.aborted) return
    const queue = new FrameQueue()
    this.queues.add(queue)
    try {
      const items: Record<string, TaskStateStable | null> = {}
      for (const session of this.ctx.sessions.list()) {
        items[session.id] = this.ctx.taskState.getStable(session.id) ?? null
      }
      if (signal.aborted) return
      yield { type: 'baseline', value: { items } }
      while (!signal.aborted) {
        try {
          const item = await queue.next(signal)
          if (item.done) break
          yield item.value
        } catch (error) {
          if (signal.aborted) break
          throw error
        }
      }
    } finally {
      this.queues.delete(queue)
      queue.close()
    }
  }
}

export default TaskStateControlService
