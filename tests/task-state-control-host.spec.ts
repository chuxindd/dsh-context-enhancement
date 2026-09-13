import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskStateStable } from '../src/internal/task-state/contract/types.ts'
import type { TaskStateCommittedListener } from '../src/internal/task-state/basic/types.ts'
import { TaskStateControlService } from '../src/internal/task-state/control/service.ts'
import type { TaskStateEditRequest } from '../src/internal/task-state/control/types.ts'

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
    goalView: { status: 'none' },
    todoView: { status: 'none', items: [] },
  }
}

function createMockHost() {
  const ctx = new Context()

  const liveSessions = [
    { id: 'session-alpha' as SessionId },
    { id: 'session-beta' as SessionId },
  ]
  const stables = new Map<SessionId, TaskStateStable>([
    ['session-alpha' as SessionId, mockStable(1)],
  ])

  const committedListeners = new Set<TaskStateCommittedListener>()
  const editRequests: TaskStateEditRequest[] = []

  ctx.sessions = {
    list: () => liveSessions,
    get: (id: SessionId) => liveSessions.find(s => s.id === id),
  } as never

  ctx.taskState = {
    getStable: (id: SessionId) => stables.get(id),
    subscribeCommitted: (listener: TaskStateCommittedListener) => {
      committedListeners.add(listener)
      return () => { committedListeners.delete(listener) }
    },
    editStable: (request: TaskStateEditRequest) => {
      editRequests.push(request)
      return Promise.resolve({ ok: true as const, stable: mockStable(request.expectedRevision + 1) })
    },
  } as never

  return {
    ctx,
    liveSessions,
    stables,
    editRequests,
    notifyCommitted: (id: SessionId, stable: TaskStateStable) => {
      stables.set(id, stable)
      for (const listener of committedListeners) {
        listener(id, stable)
      }
    },
  }
}

describe('TaskStateControlService', () => {
  it('exposes a valid TypertRemote binding and stream marker', () => {
    const { ctx } = createMockHost()
    const service = new TaskStateControlService(ctx)

    expect(service.typertRemote).toBeDefined()
    expect(service.typertRemote.namespace).toBe('taskState')
    expect(service.typertRemote.serviceKey).toBe('taskStateControl')

    const markers = remoteMethods(service)
    const controlMarker = markers.find(m => m.method === 'control')
    const editMarker = markers.find(m => m.method === 'edit')
    expect(controlMarker).toBeDefined()
    expect(controlMarker?.mode).toBe('stream')
    expect(editMarker).toEqual({ method: 'edit', invocation: { kind: 'direct' } })
  })

  it('forwards edits to the provider-owned mutation seam', async () => {
    const host = createMockHost()
    const service = new TaskStateControlService(host.ctx)
    const request: TaskStateEditRequest = {
      sessionId: 'session-alpha' as SessionId,
      expectedRevision: 1,
      value: {
        currentObjective: 'Edited objective',
        currentFocus: 'Edited focus',
        openWork: [],
        nextActions: [],
        facts: ['Edited fact'],
        decisions: [],
        constraints: [],
        risks: [],
      },
    }

    await expect(service.edit(request)).resolves.toMatchObject({ ok: true, stable: { revision: 2 } })
    expect(host.editRequests).toEqual([request])
  })

  it('yields baseline and then updates on commit for multiple concurrent consumers', async () => {
    const host = createMockHost()
    const service = new TaskStateControlService(host.ctx)

    const abortController1 = new AbortController()
    const abortController2 = new AbortController()

    const stream1 = service.control(abortController1.signal)
    const stream2 = service.control(abortController2.signal)

    const iter1 = stream1[Symbol.asyncIterator]()
    const iter2 = stream2[Symbol.asyncIterator]()

    // First frame must be baseline with live sessions
    const frame1 = await iter1.next()
    const frame2 = await iter2.next()

    expect(frame1.done).toBe(false)
    expect(frame1.value.type).toBe('baseline')
    expect(frame1.value.value.items['session-alpha']?.revision).toBe(1)
    expect(frame1.value.value.items['session-beta']).toBeNull()

    expect(frame2.done).toBe(false)
    expect(frame2.value.type).toBe('baseline')
    expect(frame2.value.value.items['session-alpha']?.revision).toBe(1)

    // Notify committed update
    const updatedStable = mockStable(2)
    host.notifyCommitted('session-beta' as SessionId, updatedStable)

    const update1 = await iter1.next()
    const update2 = await iter2.next()

    expect(update1.done).toBe(false)
    expect(update1.value.type).toBe('update')
    expect(update1.value.value.sessionId).toBe('session-beta')
    expect(update1.value.value.stable?.revision).toBe(2)

    expect(update2.done).toBe(false)
    expect(update2.value.type).toBe('update')
    expect(update2.value.value.sessionId).toBe('session-beta')

    // Abort stream 1
    abortController1.abort()
    const closed1 = await iter1.next()
    expect(closed1.done).toBe(true)

    // Stream 2 should still be alive
    const thirdStable = mockStable(3)
    host.notifyCommitted('session-alpha' as SessionId, thirdStable)

    const update3 = await iter2.next()
    expect(update3.done).toBe(false)
    expect(update3.value.type).toBe('update')
    expect(update3.value.value.sessionId).toBe('session-alpha')
    expect(update3.value.value.stable?.revision).toBe(3)

    abortController2.abort()
    const closed2 = await iter2.next()
    expect(closed2.done).toBe(true)
  })

  it('exits cleanly on early abort before baseline consumption', async () => {
    const host = createMockHost()
    const service = new TaskStateControlService(host.ctx)

    const abortController = new AbortController()
    abortController.abort()

    const stream = service.control(abortController.signal)
    const iter = stream[Symbol.asyncIterator]()

    const result = await iter.next()
    expect(result.done).toBe(true)
  })
})
