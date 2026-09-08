import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskStateStable } from '../src/internal/task-state/contract/types.ts'
import type { TaskStateControlFrame } from '../src/client/task-state-control.ts'
import {
  TaskStateControlMirror,
  createTaskStateControlSessionSource,
} from '../src/client/task-state-control-store.ts'

function mockStable(revision = 1): TaskStateStable {
  return {
    schemaVersion: 1,
    revision,
    filterVersion: 'task-state-basic/filter-v2',
    sourceCursor: 10,
    digest: `digest-rev-${revision}`,
    facts: [{ id: 'fact-1' as never, content: 'Fact 1' }],
    decisions: [],
    constraints: [],
    risks: [],
    continuation: {
      currentObjective: 'Objective',
      currentFocus: 'Focus',
      openWork: [],
      nextActions: [],
    },
    evidence: [],
    todoReferences: [],
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('TaskStateControlMirror', () => {
  it('connects, consumes baseline, and applies live updates', async () => {
    let pushFrame!: (frame: TaskStateControlFrame) => void
    const opener = (signal: AbortSignal) => (async function* () {
      yield {
        type: 'baseline' as const,
        value: {
          items: {
            ['session-1' as SessionId]: mockStable(1),
            ['session-2' as SessionId]: null,
          },
        },
      }
      while (!signal.aborted) {
        try {
          const frame = await new Promise<TaskStateControlFrame>((resolve, reject) => {
            pushFrame = resolve
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          yield frame
        } catch {
          if (signal.aborted) break
        }
      }
    })()

    const mirror = new TaskStateControlMirror({
      open: opener,
    })

    const listener = vi.fn()
    mirror.subscribe(listener)

    expect(mirror.getSnapshot().connection).toBe('connecting')
    mirror.start()

    await waitFor(() => mirror.getSnapshot().connection === 'live')

    expect(mirror.getSnapshot().items['session-1' as SessionId]?.revision).toBe(1)
    expect(mirror.getSnapshot().items['session-2' as SessionId]).toBeNull()
    expect(listener).toHaveBeenCalled()

    // Push an update
    pushFrame({
      type: 'update',
      value: {
        sessionId: 'session-1' as SessionId,
        stable: mockStable(2),
      },
    })

    await waitFor(() => mirror.getSnapshot().items['session-1' as SessionId]?.revision === 2)

    await mirror.dispose()
  })

  it('unwraps RemoteStreamItem and invokes accept() on baseline', async () => {
    let acceptCalled = false
    const wrappedStream = (async function* () {
      yield {
        generation: 1,
        value: {
          type: 'baseline' as const,
          value: { items: { ['s-1' as SessionId]: mockStable(1) } },
        },
        signal: new AbortController().signal,
        accept: () => { acceptCalled = true },
      }
    })()

    const mirror = new TaskStateControlMirror({
      open: () => wrappedStream,
    })
    mirror.start()

    await waitFor(() => mirror.getSnapshot().connection === 'live')
    expect(acceptCalled).toBe(true)

    await mirror.dispose()
  })

  it('transitions to error on protocol violation and recovers on retry', async () => {
    let callCount = 0
    const opener = () => {
      callCount += 1
      if (callCount === 1) {
        // First generation emits update before baseline and then ends
        return (async function* () {
          yield {
            type: 'update' as const,
            value: { sessionId: 's-1' as SessionId, stable: mockStable(1) },
          }
        })()
      }
      return (async function* () {
        yield {
          type: 'baseline' as const,
          value: { items: { ['s-1' as SessionId]: mockStable(2) } },
        }
      })()
    }

    const mirror = new TaskStateControlMirror({ open: opener, retryDelayMs: 50 })
    mirror.start()

    await waitFor(() => mirror.getSnapshot().connection === 'error')
    expect(mirror.getSnapshot().error).toMatch(/before its opening baseline/)

    // User clicks retry
    mirror.retry()

    await waitFor(() => mirror.getSnapshot().connection === 'live')
    expect(mirror.getSnapshot().items['s-1' as SessionId]?.revision).toBe(2)

    await mirror.dispose()
  })
})

describe('createTaskStateControlSessionSource', () => {
  it('projects per-session view and caches unchanged references', async () => {
    let pushFrame!: (frame: TaskStateControlFrame) => void
    const opener = (signal: AbortSignal) => (async function* () {
      yield {
        type: 'baseline' as const,
        value: {
          items: {
            ['session-1' as SessionId]: mockStable(1),
            ['session-2' as SessionId]: mockStable(1),
          },
        },
      }
      while (!signal.aborted) {
        try {
          const frame = await new Promise<TaskStateControlFrame>((resolve, reject) => {
            pushFrame = resolve
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          yield frame
        } catch {
          if (signal.aborted) break
        }
      }
    })()

    const mirror = new TaskStateControlMirror({ open: opener })
    const source1 = createTaskStateControlSessionSource(mirror, 'session-1' as SessionId)
    const source2 = createTaskStateControlSessionSource(mirror, 'session-2' as SessionId)

    mirror.start()
    await waitFor(() => mirror.getSnapshot().connection === 'live')

    const snap1 = source1.getSnapshot()
    const snap2 = source2.getSnapshot()

    expect(snap1.stable?.revision).toBe(1)
    expect(snap2.stable?.revision).toBe(1)

    // Update only session-2
    pushFrame({
      type: 'update',
      value: {
        sessionId: 'session-2' as SessionId,
        stable: mockStable(2),
      },
    })
    await waitFor(() => source2.getSnapshot().stable?.revision === 2)

    // snap1 must retain the exact cached object reference because session-1 was unaffected
    expect(source1.getSnapshot()).toBe(snap1)
    // snap2 should update to revision 2
    expect(source2.getSnapshot().stable?.revision).toBe(2)

    await mirror.dispose()
  })
})
