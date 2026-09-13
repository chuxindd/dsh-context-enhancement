import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { DEFAULT_FILTER_FIELD_LIMITS as DEFAULT_LIMITS, filterEvent, isEligibleType, jsonBytes } from '../src/internal/task-state/basic/filter.ts'

describe('task-state-basic event-type eligibility', () => {
  it('accepts the durable event types the filter folds', () => {
    expect(isEligibleType('user/message')).toBe(true)
    expect(isEligibleType('assistant/message')).toBe(true)
    expect(isEligibleType('tool/call')).toBe(true)
    expect(isEligibleType('tool/result')).toBe(true)
    expect(isEligibleType('turn/end')).toBe(true)
    expect(isEligibleType('goal/change')).toBe(true)
    expect(isEligibleType('todo/write')).toBe(true)
    expect(isEligibleType('plan/mode')).toBe(true)
    expect(isEligibleType('command/run')).toBe(true)
    expect(isEligibleType('request/header')).toBe(true)
    expect(isEligibleType('agent-preset/selected')).toBe(true)
    expect(isEligibleType('compaction/start')).toBe(true)
    expect(isEligibleType('compaction/end')).toBe(true)
  })

  it('rejects the reserved audit names, chunks, compaction/summary, and unknown types', () => {
    expect(isEligibleType('task-state/update-request')).toBe(false)
    expect(isEligibleType('task-state/update-finished')).toBe(false)
    expect(isEligibleType('assistant/chunk')).toBe(false)
    expect(isEligibleType('turn/start')).toBe(false)
    expect(isEligibleType('session/end-seed')).toBe(false)
    expect(isEligibleType('compaction/summary')).toBe(false)
    expect(isEligibleType('compaction/prune')).toBe(false)
    expect(isEligibleType('mystery/event')).toBe(false)
  })
})

describe('task-state-basic filter projections', () => {
  it('projects a direct human user/message with bounded text', () => {
    const result = filterEvent({
      seq: 3,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'Please refactor the provider' }],
        source: { kind: 'user' },
      },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toEqual({
      kind: 'user',
      text: 'Please refactor the provider',
    })
  })

  it('drops a synthetic plugin user/message that is not direct human input', () => {
    expect(filterEvent({
      seq: 4,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'file changed' }],
        source: { kind: 'plugin', plugin: 'dsh-watch', form: 'synthetic', summary: 'x' },
      },
    })).toBeNull()
  })

  it('drops an interrupted assistant/message prefix', () => {
    expect(filterEvent({
      seq: 5,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        interrupted: true,
        message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'partial' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      },
    })).toBeNull()
  })

  it('projects final assistant text without reasoning blocks', () => {
    const result = filterEvent({
      seq: 6,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm-2',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'hidden chain-of-thought' },
            { type: 'text', text: 'The refactor is complete.' },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toEqual({ kind: 'assistant', text: 'The refactor is complete.' })
  })

  it('projects tool-call arguments as bounded JSON leaves', () => {
    const result = filterEvent({
      seq: 7,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'read',
        arguments: JSON.stringify({ file: 'packages/task-state/task-state-basic/src/index.ts', offset: 10 }),
      },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toMatchObject({
      kind: 'tool/call',
      name: 'read',
      callId: 'call-1',
    })
    const args = (result?.event.fields as { arguments: string }).arguments
    expect(JSON.parse(args)).toMatchObject({ file: 'packages/task-state/task-state-basic/src/index.ts', offset: '10' })
  })

  it('degrades malformed tool-call arguments to the raw bounded string', () => {
    const result = filterEvent({
      seq: 8,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-2', name: 'bash', arguments: '{oops' },
    })
    expect(result).not.toBeNull()
    expect((result?.event.fields as { arguments: string }).arguments).toContain('{oops')
  })

  it('projects the durable text and error facts of a tool-result', () => {
    const result = filterEvent({
      seq: 9,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm-3',
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'the file has 220 lines' }],
          }],
          source: { kind: 'tool', toolCallId: 'call-1' },
        },
        error: { name: 'EACCES', code: 'EPERM' },
      },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toMatchObject({
      kind: 'tool/result',
      callId: 'call-1',
      isError: false,
      text: 'the file has 220 lines',
      error: { name: 'EACCES', code: 'EPERM' },
    })
  })

  it('projects a turn-end reason', () => {
    const result = filterEvent({
      seq: 10,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toEqual({ kind: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  })

  it('projects durable goal state on a goal/change snapshot', () => {
    const result = filterEvent({
      seq: 11,
      type: 'goal/change',
      data: {
        operation: 'create',
        goal: {
          id: 'goal-1',
          revision: 3,
          phase: 'active',
          objective: 'land the task-state provider',
          maxGoalRounds: 5,
        },
        roundsStarted: 0,
      },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toMatchObject({
      kind: 'goal/change',
      operation: 'create',
      goal: {
        id: 'goal-1',
        revision: 3,
        phase: 'active',
        objective: 'land the task-state provider',
        maxGoalRounds: 5,
      },
    })
  })

  it('projects a whole todo list with bounded content', () => {
    const result = filterEvent({
      seq: 12,
      type: 'todo/write',
      data: { todos: [{ content: 'open the domain', status: 'in_progress' }] },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toEqual({
      kind: 'todo/write',
      status: 'current',
      todos: [{ content: 'open the domain', status: 'in_progress' }],
    })
  })

  it('selects lifecycle-relevant command/run events and drops others', () => {
    const goal = filterEvent({
      seq: 13,
      type: 'command/run',
      data: { commandId: 'cmd-1', name: 'goal', args: 'create the state', source: { kind: 'user' } },
    })
    expect(goal).not.toBeNull()
    expect(goal?.event.fields).toMatchObject({ kind: 'command/run', name: 'goal', args: 'create the state' })

    const irrelevant = filterEvent({
      seq: 14,
      type: 'command/run',
      data: { commandId: 'cmd-2', name: 'feedback', args: '', source: { kind: 'user' } },
    })
    expect(irrelevant).toBeNull()
  })

  it('projects an empty todo/write as an explicit current-state clear and plan-off', () => {
    // The whole-list replacement invariant makes `{ todos: [] }` the legal
    // way to clear the list: it is an authoritative fact, not an empty payload
    // to drop, so the projection says so explicitly.
    const cleared = filterEvent({ seq: 15, type: 'todo/write', data: { todos: [] } })
    expect(cleared).not.toBeNull()
    expect(cleared?.event.fields).toEqual({ kind: 'todo/write', status: 'cleared', todos: [] })
    const plan = filterEvent({ seq: 16, type: 'plan/mode', data: { active: false } })
    expect(plan).not.toBeNull()
    expect(plan?.event.fields).toEqual({ kind: 'plan/mode', active: false })
  })

  it('projects the durable goal-round progress on a goal/change snapshot', () => {
    const result = filterEvent({
      seq: 17,
      type: 'goal/change',
      data: {
        operation: 'resume',
        goal: { id: 'goal-1', revision: 4, phase: 'active', objective: 'land the task-state provider', maxGoalRounds: 8 },
        roundsStarted: 3,
      },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toMatchObject({
      kind: 'goal/change',
      operation: 'resume',
      goal: { id: 'goal-1', phase: 'active', objective: 'land the task-state provider', maxGoalRounds: 8, roundsStarted: 3 },
    })
  })

  it('projects a selected-model request/header but skips identical series headers', () => {
    const initial = filterEvent({
      seq: 18,
      type: 'request/header',
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } }, reason: 'initial' },
    })
    expect(initial).not.toBeNull()
    expect(initial?.event.fields).toMatchObject({
      kind: 'request/header',
      reason: 'initial',
      provider: 'deepseek',
      model: 'deepseek-v4',
      reasoningEffort: 'high',
    })

    const series = filterEvent({
      seq: 19,
      type: 'request/header',
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4' } }, reason: 'series' },
    })
    expect(series).toBeNull()

    const changed = filterEvent({
      seq: 20,
      type: 'request/header',
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-v5' } }, reason: 'change' },
    })
    expect(changed).not.toBeNull()
    expect(changed?.event.fields).toMatchObject({ kind: 'request/header', reason: 'change', model: 'deepseek-v5' })

    expect(filterEvent({ seq: 21, type: 'request/header', data: { header: { system: 'x' }, reason: 'initial' } })).toBeNull()
  })

  it('projects the durable agent-preset selection', () => {
    const result = filterEvent({
      seq: 22,
      type: 'agent-preset/selected',
      data: { agentPreset: 'standard' },
    })
    expect(result).not.toBeNull()
    expect(result?.event.fields).toEqual({ kind: 'agent-preset/selected', preset: 'standard' })
    expect(filterEvent({ seq: 23, type: 'agent-preset/selected', data: { agentPreset: '' } })).toBeNull()
  })

  it('projects compaction bracket markers but never the summary', () => {
    const start = filterEvent({
      seq: 24,
      type: 'compaction/start',
      data: { compactionId: 'compaction-1', turn: 3 },
    })
    expect(start).not.toBeNull()
    expect(start?.event.fields).toMatchObject({ kind: 'compaction/start', compactionId: 'compaction-1', turn: 3 })

    const failed = filterEvent({
      seq: 25,
      type: 'compaction/end',
      data: { compactionId: 'compaction-1', turn: 3, error: 'provider failed' },
    })
    expect(failed).not.toBeNull()
    expect(failed?.event.fields).toMatchObject({ kind: 'compaction/end', compactionId: 'compaction-1', error: 'provider failed' })
  })

  it('whole-bounds the legal JSON tool-argument branch', () => {
    const manyLeaves = Array.from({ length: 40 }, (_, i) => [i, 'leaf-value'])
    const args = JSON.stringify({ entries: manyLeaves })
    const tinyResult = filterEvent(
      {
        seq: 26,
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-2', name: 'read', arguments: args },
      },
      { ...DEFAULT_LIMITS, toolArgumentsBytes: 120 },
    )
    expect(tinyResult).not.toBeNull()
    const rendered = (tinyResult?.event.fields as { arguments: string }).arguments
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(120)
  })

  it('records deterministic array-cut and depth-cut metadata leaves', () => {
    const nested = {
      top: { a: 1, b: { c: { d: { e: { f: { g: 'too deep' } } } } } },
      items: ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9'],
    }
    const result = filterEvent({
      seq: 27,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-3', name: 'write', arguments: JSON.stringify(nested) },
    })
    expect(result).not.toBeNull()
    const args = (result?.event.fields as { arguments: string }).arguments
    const parsed = JSON.parse(args) as Record<string, string>
    expect(Object.values(parsed).some(value => value === '…')).toBe(true)
    expect(Object.keys(parsed).some(path => /items\[8…\]/.test(path))).toBe(true)
  })
})

describe('task-state-basic filter hostile payloads', () => {
  it('drops non-record or non-human user messages', () => {
    expect(filterEvent({ seq: 40, type: 'user/message', data: 'not-a-record' })).toBeNull()
    expect(filterEvent({
      seq: 41,
      type: 'user/message',
      data: { content: 'not-blocks', source: { kind: 'plugin', plugin: 'x' } },
    })).toBeNull()
  })

  it('drops assistant messages that are non-record or carry no message text', () => {
    expect(filterEvent({ seq: 42, type: 'assistant/message', data: null })).toBeNull()
    expect(filterEvent({
      seq: 43,
      type: 'assistant/message',
      data: { message: { id: 'm', role: 'assistant', content: [] } },
    })).toBeNull()
  })

  it('drops a tool/call with no meaningful name or arguments', () => {
    expect(filterEvent({ seq: 44, type: 'tool/call', data: 7 })).toBeNull()
    const empty = filterEvent({
      seq: 45,
      type: 'tool/call',
      data: { callId: 'c', name: '', arguments: '' },
    })
    expect(empty).not.toBeNull()
    expect(empty?.event.fields).toMatchObject({ kind: 'tool/call', name: '', callId: 'c' })
    expect((empty?.event.fields as { arguments?: string }).arguments).toBeUndefined()
  })

  it('drops tool results with no text, meta, or error and hostile shapes', () => {
    expect(filterEvent({ seq: 46, type: 'tool/result', data: 'x' })).toBeNull()
    expect(filterEvent({
      seq: 47,
      type: 'tool/result',
      data: { message: 'not-record', error: null },
    })).toBeNull()
    const errorOnly = filterEvent({
      seq: 48,
      type: 'tool/result',
      data: { message: {}, error: { name: 'EACCES' } },
    })
    expect(errorOnly).not.toBeNull()
    expect(errorOnly?.event.fields).toMatchObject({ kind: 'tool/result', error: { name: 'EACCES' } })
    const metaOnly = filterEvent({
      seq: 49,
      type: 'tool/result',
      data: { message: {}, meta: { path: 'packages/a.ts' } },
    })
    expect(metaOnly).not.toBeNull()
    const metaText = (metaOnly?.event.fields as { meta?: string }).meta ?? ''
    expect(metaText).toContain('packages/a.ts')
  })

  it('handles an interrupted-or-foreign turn-end reason and non-record turn/end', () => {
    expect(filterEvent({ seq: 50, type: 'turn/end', data: null })).toBeNull()
    const aborted = filterEvent({
      seq: 51,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user-interrupt' } } },
    })
    expect(aborted?.event.fields).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user-interrupt' } } })
    const errorReason = filterEvent({
      seq: 52,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'error', error: { code: 'BUDGET' } } },
    })
    expect(errorReason?.event.fields).toMatchObject({ reason: { kind: 'error', code: 'BUDGET' } })
    const completed = filterEvent({ seq: 53, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    expect(completed?.event.fields).toMatchObject({ reason: { kind: 'completed' } })
  })

  it('drops malformed goal/change snapshots and foreign todo lists', () => {
    expect(filterEvent({ seq: 54, type: 'goal/change', data: 'no' })).toBeNull()
    expect(filterEvent({ seq: 55, type: 'goal/change', data: { operation: 'resume' } })).toBeNull()
    expect(filterEvent({ seq: 56, type: 'goal/change', data: { operation: 'clear' } })).not.toBeNull()
    const blocked = filterEvent({
      seq: 57,
      type: 'goal/change',
      data: { operation: 'resume', goal: { objective: 'finish', blockedReason: { code: 'ROUNDS' } } },
    })
    expect(blocked?.event.fields).toMatchObject({ goal: { objective: 'finish', blockedReason: 'ROUNDS' } })

    expect(filterEvent({ seq: 58, type: 'todo/write', data: { todos: 'no' } })).toBeNull()
    const hostileTodo = filterEvent({
      seq: 59,
      type: 'todo/write',
      data: { todos: [7, { content: 'real', status: 'in_progress' }] },
    })
    expect(hostileTodo).not.toBeNull()
    expect(hostileTodo?.event.fields).toEqual({
      kind: 'todo/write',
      status: 'current',
      todos: [{ content: '', status: '' }, { content: 'real', status: 'in_progress' }],
    })
  })

  it('drops foreign request/header, preset, compaction, plan, and command payloads', () => {
    expect(filterEvent({ seq: 60, type: 'request/header', data: null })).toBeNull()
    expect(filterEvent({ seq: 61, type: 'request/header', data: { header: null, reason: 'initial' } })).toBeNull()
    expect(filterEvent({ seq: 62, type: 'request/header', data: { header: { config: {} }, reason: 'initial' } })).toBeNull()
    expect(filterEvent({ seq: 63, type: 'agent-preset/selected', data: null })).toBeNull()
    expect(filterEvent({ seq: 64, type: 'compaction/start', data: 0 })).toBeNull()
    expect(filterEvent({ seq: 65, type: 'compaction/end', data: null })).toBeNull()
    expect(filterEvent({ seq: 66, type: 'plan/mode', data: 'x' })).toBeNull()
    expect(filterEvent({ seq: 67, type: 'command/run', data: null })).toBeNull()
    expect(filterEvent({ seq: 68, type: 'command/run', data: { name: 'feedback' } })).toBeNull()
  })

  it('keeps a compaction/start with an absent owner turn and a preset without effort', () => {
    const start = filterEvent({
      seq: 69,
      type: 'compaction/start',
      data: { compactionId: 'compaction-2' },
    })
    expect(start?.event.fields).toEqual({ kind: 'compaction/start', compactionId: 'compaction-2' })
    const end = filterEvent({
      seq: 70,
      type: 'compaction/end',
      data: { compactionId: 'compaction-2' },
    })
    expect(end?.event.fields).toEqual({ kind: 'compaction/end', compactionId: 'compaction-2' })
  })

  it('reports the jsonBytes helper', () => {
    expect(jsonBytes({ a: [1, 'two'] })).toBe(Buffer.byteLength(JSON.stringify({ a: [1, 'two'] }), 'utf8'))
    expect(jsonBytes('')).toBe(2)
  })

  it('handles goal-kind user messages and empty-user-message text', () => {
    const goalKind = filterEvent({
      seq: 71,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'continue the goal' }],
        source: { kind: 'goal' },
      },
    })
    expect(goalKind).not.toBeNull()
    expect(goalKind?.event.fields).toMatchObject({ kind: 'goal-continuation', text: 'continue the goal' })

    expect(filterEvent({
      seq: 72,
      type: 'user/message',
      data: { content: 'not-blocks', source: { kind: 'user' } },
    })).toBeNull()
  })

  it('drops an error record with neither name nor code and a code-only error', () => {
    const none = filterEvent({
      seq: 73,
      type: 'tool/result',
      data: { message: {}, error: { unrelated: 'x' } },
    })
    expect(none).toBeNull()
    const codeOnly = filterEvent({
      seq: 74,
      type: 'tool/result',
      data: { message: {}, error: { code: 'EPERM' } },
    })
    expect(codeOnly).not.toBeNull()
    expect(codeOnly?.event.fields).toMatchObject({ error: { code: 'EPERM' } })
  })

  it('drops a meta object whose only leaves are binary or empty', () => {
    const result = filterEvent({
      seq: 75,
      type: 'tool/result',
      data: { message: {}, meta: { payload: 'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=' } },
    })
    expect(result).toBeNull()
  })

  it('handles a turn/end reason with a non-record inner body', () => {
    const unknownInner = filterEvent({
      seq: 76,
      type: 'turn/end',
      data: { turn: 4, reason: { kind: 'aborted', reason: 'just-a-string' } },
    })
    expect(unknownInner?.event.fields).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'unknown' } } })
    const stringError = filterEvent({
      seq: 77,
      type: 'turn/end',
      data: { turn: 5, reason: { kind: 'error', error: 'nope' } },
    })
    expect(stringError?.event.fields).toMatchObject({ reason: { kind: 'error' } })
    const bare = filterEvent({ seq: 78, type: 'turn/end', data: { turn: 6, reason: null } })
    expect(bare?.event.fields).toMatchObject({ reason: null })
  })

  it('drops tool-result text with a non-array content list and non-tool-result first block', () => {
    const notArray = filterEvent({
      seq: 79,
      type: 'tool/result',
      data: { message: { content: 'nope' } },
    })
    expect(notArray).toBeNull()
    const textBlock = filterEvent({
      seq: 80,
      type: 'tool/result',
      data: {
        message: { content: [{ type: 'text', text: 'not a tool result' }] },
      },
    })
    expect(textBlock).toBeNull()
  })

  it('skips blank and non-string text blocks and binary JSON leaves', () => {
    const blankBlock = filterEvent({
      seq: 81,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '   ' }, { type: 'text', text: 42 as never }],
        source: { kind: 'user' },
      },
    })
    expect(blankBlock).toBeNull()
    const binary = filterEvent({
      seq: 82,
      type: 'tool/call',
      data: {
        callId: 'c-bin',
        name: 'write',
        arguments: JSON.stringify({ payload: 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZw==' }),
      },
    })
    expect(binary).not.toBeNull()
    expect((binary?.event.fields as { arguments?: string }).arguments).toBeUndefined()
  })

  it('treats a tool/call with non-string arguments as empty', () => {
    const numeric = filterEvent({
      seq: 83,
      type: 'tool/call',
      data: { callId: 'c-num', name: 'read', arguments: 5 },
    })
    expect(numeric).not.toBeNull()
    expect((numeric?.event.fields as { arguments?: string }).arguments).toBeUndefined()
  })

  it('drops non-record plan/todo and command payloads', () => {
    expect(filterEvent({ seq: 84, type: 'todo/write', data: 3 })).toBeNull()
    expect(filterEvent({ seq: 85, type: 'plan/mode', data: 'off' })).toBeNull()
  })

  it('drops a user message whose source is not a record and a scalar JSON-null leaf', () => {
    expect(filterEvent({
      seq: 86,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }], source: 'user' },
    })).toBeNull()
    const nullArgs = filterEvent({
      seq: 87,
      type: 'tool/call',
      data: { callId: 'c-null', name: 'read', arguments: 'null' },
    })
    expect(nullArgs).not.toBeNull()
    expect((nullArgs?.event.fields as { arguments?: string }).arguments).toBeUndefined()
  })

  it('projects a command/run carrying a record source and drops an absent one', () => {
    const withSource = filterEvent({
      seq: 88,
      type: 'command/run',
      data: { commandId: 'cmd-3', name: 'plan', args: 'design', source: { kind: 'plugin', plugin: 'x' } },
    })
    expect(withSource?.event.fields).toMatchObject({
      kind: 'command/run',
      name: 'plan',
      args: 'design',
      source: 'plugin',
    })
    const withoutSource = filterEvent({
      seq: 89,
      type: 'command/run',
      data: { commandId: 'cmd-4', name: 'compact' },
    })
    expect(withoutSource?.event.fields).toEqual({
      kind: 'command/run',
      commandId: 'cmd-4',
      name: 'compact',
    })
  })

  it('drops tool-result content whose inner text block list is not an array', () => {
    const result = filterEvent({
      seq: 90,
      type: 'tool/result',
      data: {
        message: { content: [{ type: 'tool-result', toolCallId: 'c-1', content: 'not-array' }] },
      },
    })
    expect(result).toBeNull()
  })

  it('drops empty-string and whitespace JSON leaves in tool arguments', () => {
    const result = filterEvent({
      seq: 91,
      type: 'tool/call',
      data: { callId: 'c-empty', name: 'read', arguments: JSON.stringify({ empty: '', blank: '   ' }) },
    })
    expect(result).not.toBeNull()
    expect((result?.event.fields as { arguments?: string }).arguments).toBeUndefined()
  })
})
