import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { ContextEnhancementView } from './ContextEnhancementView.tsx'
import { TaskStateControlMirror, createTaskStateControlSessionSource } from './task-state-control-store.ts'
import { taskStateRemoteContribution } from './task-state-remote.ts'
import { en, NS, zh, type ContextEnhancementKey } from './locales.ts'
import type { TaskStateEditRequest, TaskStateEditResult } from '../internal/task-state/control/types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { contextEnhancement: ContextEnhancementKey }
}

export const inject = ['locale', 'slots', 'remote']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-enhancement: dictionaries')

  let mounted = false
  let taskStateRemote: {
    control: (sig?: AbortSignal) => AsyncIterable<unknown>
    edit: (request: TaskStateEditRequest) => Promise<TaskStateEditResult>
  } | undefined
  const mirror = new TaskStateControlMirror({
    open: signal => {
      const remote = taskStateRemote
      if (!mounted || remote === undefined) {
        return undefined
      }
      if (typeof ctx.remote.$stream === 'function') {
        return ctx.remote.$stream({
          name: 'dsh-context-enhancement/task-state-control',
          open: s => remote.control(s),
          ended: accepted => new Error(accepted ? 'task-state control stream ended' : 'task-state control baseline missing'),
        })
      }
      return remote.control(signal)
    },
  })

  const sources = new Map<SessionId, ReturnType<typeof createTaskStateControlSessionSource>>()
  const getSessionSource = (sessionId: SessionId) => {
    let source = sources.get(sessionId)
    if (source === undefined) {
      source = createTaskStateControlSessionSource(mirror, sessionId)
      sources.set(sessionId, source)
    }
    return source
  }

  ctx.effect(() => {
    let disposeMount: (() => void) | undefined
    let taskStateScope: { dispose: () => Promise<void> } | undefined
    let cancelled = false
    const start = async (): Promise<void> => {
      try {
        disposeMount = await ctx.remote.$mount(taskStateRemoteContribution)
        if (cancelled) {
          disposeMount?.()
          return
        }
        taskStateScope = ctx.inject(['remote.taskState'], (remoteCtx) => {
          taskStateRemote = (remoteCtx.remote as typeof remoteCtx.remote & {
            taskState: {
              control: (sig?: AbortSignal) => AsyncIterable<unknown>
              edit: (request: TaskStateEditRequest) => Promise<TaskStateEditResult>
            }
          }).taskState
        })
        await taskStateScope
        if (cancelled) {
          await taskStateScope.dispose()
          disposeMount?.()
          return
        }
        mounted = true
        mirror.start()
      } catch (error) {
        ctx.logger?.warn?.(`context-enhancement: remote mount failed: ${String(error)}`)
      }
    }
    void start()
    return async () => {
      cancelled = true
      mounted = false
      taskStateRemote = undefined
      await mirror.dispose()
      await taskStateScope?.dispose()
      await disposeMount?.()
      sources.clear()
    }
  }, 'context-enhancement: task-state mirror')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'contextEnhancement',
    order: 5,
    locale: NS,
    label: () => ctx.locale.bind(NS)('view.contextEnhancement'),
    inject: (sessionId: SessionId) => ({
      useTaskState: () => getSessionSource(sessionId),
      retryTaskState: () => { mirror.retry() },
      editTaskState: (request: TaskStateEditRequest) => {
        const remote = taskStateRemote
        if (!mounted || remote === undefined) {
          return Promise.resolve({ ok: false, code: 'unavailable', message: 'Task-state connection is unavailable.' })
        }
        return remote.edit(request)
      },
    }),
  }, ContextEnhancementView))
}
