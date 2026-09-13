import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskStateStable } from '../src/internal/task-state/contract/types.ts'
import {
  applyTaskStateStableForSession,
  isTaskStateControlBaseline,
  isTaskStateControlUpdate,
  parseTaskStateControlFrame,
  type TaskStateControlFrame,
} from '../src/client/task-state-control.ts'
import {
  createTaskStateControlInitialState,
  reduceTaskStateControlBaseline,
  reduceTaskStateControlFailure,
  reduceTaskStateControlUpdate,
} from '../src/client/task-state-control-store.ts'

function mockStable(revision = 1, sourceCursor = 10): TaskStateStable {
  return {
    schemaVersion: 1,
    revision,
    filterVersion: 'task-state-basic/filter-v2',
    sourceCursor,
    digest: `digest-rev-${revision}`,
    facts: [{ id: 'fact-1' as never, content: 'Fact 1' }],
    decisions: [{ id: 'decision-1' as never, content: 'Decision 1' }],
    constraints: [{ id: 'constraint-1' as never, content: 'Constraint 1' }],
    risks: [{ id: 'risk-1' as never, content: 'Risk 1' }],
    continuation: {
      currentObjective: 'Objective',
      currentFocus: 'Focus',
      openWork: ['Task 1'],
      nextActions: ['Action 1'],
    },
    evidence: [{ seq: 5, note: 'evidence note' }],
    todoReferences: [{ seq: 6, content: 'todo content' }],
    goalView: { status: 'none' },
    todoView: { status: 'none', items: [] },
  }
}

describe('task-state-control protocol parsing', () => {
  it('identifies and validates a valid baseline frame', () => {
    const frame: TaskStateControlFrame = {
      type: 'baseline',
      value: {
        items: {
          ['session-1' as SessionId]: null,
          ['session-2' as SessionId]: mockStable(1),
        },
      },
    }
    const result = parseTaskStateControlFrame(frame)
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'baseline') {
      expect(isTaskStateControlBaseline(result.frame)).toBe(true)
      expect(isTaskStateControlUpdate(result.frame)).toBe(false)
      expect(result.frame.value.items['session-2' as SessionId]?.revision).toBe(1)
    }
  })

  it('identifies and validates a valid update frame', () => {
    const frame: TaskStateControlFrame = {
      type: 'update',
      value: {
        sessionId: 'session-1' as SessionId,
        stable: mockStable(2),
      },
    }
    const result = parseTaskStateControlFrame(frame)
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'update') {
      expect(isTaskStateControlUpdate(result.frame)).toBe(true)
      expect(isTaskStateControlBaseline(result.frame)).toBe(false)
      expect(result.frame.value.sessionId).toBe('session-1')
      expect(result.frame.value.stable?.revision).toBe(2)
    }
  })

  it('unwraps wrapped RemoteStreamItem containers', () => {
    const wrapped = {
      generation: 1,
      value: {
        type: 'baseline',
        value: { items: {} },
      },
      accept: () => {},
    }
    const result = parseTaskStateControlFrame(wrapped)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.frame.type).toBe('baseline')
    }
  })

  it('rejects invalid or malformed frames', () => {
    expect(parseTaskStateControlFrame(null).ok).toBe(false)
    expect(parseTaskStateControlFrame('string').ok).toBe(false)
    expect(parseTaskStateControlFrame({ type: 'unknown' }).ok).toBe(false)
    expect(parseTaskStateControlFrame({ type: 'baseline' }).ok).toBe(false)
    expect(parseTaskStateControlFrame({ type: 'baseline', value: {} }).ok).toBe(false)
    expect(parseTaskStateControlFrame({ type: 'update', value: {} }).ok).toBe(false)
    expect(parseTaskStateControlFrame({ type: 'update', value: { sessionId: '' } }).ok).toBe(false)
  })
})

describe('task-state-control session monotonic merge', () => {
  it('applies newer stable over undefined or null', () => {
    const s1 = mockStable(1)
    expect(applyTaskStateStableForSession(undefined, s1)).toBe(s1)
    expect(applyTaskStateStableForSession(null, s1)).toBe(s1)
  })

  it('clears session when incoming stable is null', () => {
    const s1 = mockStable(1)
    expect(applyTaskStateStableForSession(s1, null)).toBeNull()
  })

  it('advances revision monotonically and ignores stale/identical revisions', () => {
    const s1 = mockStable(1)
    const s2 = mockStable(2)
    expect(applyTaskStateStableForSession(s1, s2)).toBe(s2)
    expect(applyTaskStateStableForSession(s2, s1)).toBe(s2)
    const s2Clone = mockStable(2)
    expect(applyTaskStateStableForSession(s2, s2Clone)).toBe(s2)
  })
})

describe('task-state-control store reducers', () => {
  it('folds baseline and transitions connection to live', () => {
    const initial = createTaskStateControlInitialState()
    expect(initial.connection).toBe('connecting')
    expect(initial.generation).toBe(0)

    const s1 = mockStable(1)
    const baselineState = reduceTaskStateControlBaseline(initial, {
      items: {
        ['session-1' as SessionId]: s1,
        ['session-2' as SessionId]: null,
      },
    })
    expect(baselineState.connection).toBe('live')
    expect(baselineState.generation).toBe(1)
    expect(baselineState.items['session-1' as SessionId]).toBe(s1)
    expect(baselineState.items['session-2' as SessionId]).toBeNull()
  })

  it('folds updates with monotonic revision de-dup', () => {
    const initial = createTaskStateControlInitialState()
    const s1 = mockStable(1)
    const live = reduceTaskStateControlBaseline(initial, {
      items: { ['session-1' as SessionId]: s1 },
    })

    const s2 = mockStable(2)
    const updated = reduceTaskStateControlUpdate(live, {
      sessionId: 'session-1' as SessionId,
      stable: s2,
    })
    expect(updated.items['session-1' as SessionId]).toBe(s2)

    // Stale update is no-op, preserving reference
    const stale = reduceTaskStateControlUpdate(updated, {
      sessionId: 'session-1' as SessionId,
      stable: s1,
    })
    expect(stale).toBe(updated)
  })

  it('records terminal failure while preserving last known snapshot', () => {
    const initial = createTaskStateControlInitialState()
    const s1 = mockStable(1)
    const live = reduceTaskStateControlBaseline(initial, {
      items: { ['session-1' as SessionId]: s1 },
    })

    const failed = reduceTaskStateControlFailure(live, new Error('connection severed'))
    expect(failed.connection).toBe('error')
    expect(failed.error).toBe('connection severed')
    expect(failed.items['session-1' as SessionId]).toBe(s1)
  })
})
