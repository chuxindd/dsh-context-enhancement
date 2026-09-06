import { describe, expect, it } from 'vitest'
import {
  TaskStateEntryId,
  type TaskStateStable,
} from '../src/task-state.ts'
import {
  TASK_STATE_TRUNCATION_MARKER,
  renderTaskStateSnapshot,
} from '../src/task-state-prompt.ts'

const encoder = new TextEncoder()

/** One committed stable whose lists carry deterministic, distinct content. */
function canonical(): TaskStateStable {
  return {
    schemaVersion: 1,
    revision: 3,
    filterVersion: 'filter-v1',
    sourceCursor: 7,
    digest: 'digest-3',
    facts: [
      { id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'), content: 'root cause fixed' },
    ],
    decisions: [
      { id: TaskStateEntryId('decision-22222222-2222-4222-8222-222222222222'), content: 'adopt whole-line truncation' },
    ],
    constraints: [],
    risks: [
      { id: TaskStateEntryId('risk-33333333-3333-4333-8333-333333333333'), content: 'noisy stables add surface bytes' },
    ],
    evidence: [
      { seq: 5, note: 'user message described the failure' },
      { seq: 7, note: 'tool/result confirmed the fix' },
    ],
    todoReferences: [{ seq: 4, content: 'read the design docs' }],
    continuation: {
      currentObjective: 'ship the durable task-state consumer',
      currentFocus: 'rendering the bounded snapshot',
      openWork: ['cover the CJK boundary'],
      nextActions: ['run the focused gate'],
    },
  }
}

/** An otherwise-empty stable carrying only a continuation objective. */
function continuationOnly(): TaskStateStable {
  return {
    schemaVersion: 1,
    revision: 1,
    filterVersion: 'filter-v1',
    sourceCursor: 0,
    digest: 'digest-1',
    facts: [],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: [],
    continuation: { currentObjective: 'objective only', currentFocus: '', openWork: [], nextActions: [] },
  }
}

describe('renderTaskStateSnapshot', () => {
  it('renders the header, continuation state, and every non-empty list in fixed order', () => {
    const text = renderTaskStateSnapshot(canonical(), 1 << 20)
    expect(text).toBe([
      'Durable task state (revision 3, source event 7, digest digest-3).',
      'Current objective: ship the durable task-state consumer',
      'Current focus: rendering the bounded snapshot',
      'Open work:',
      '- cover the CJK boundary',
      'Next actions:',
      '- run the focused gate',
      '',
      'Facts:',
      '- root cause fixed',
      'Decisions:',
      '- adopt whole-line truncation',
      'Risks:',
      '- noisy stables add surface bytes',
      'Evidence:',
      '- user message described the failure (session event 5)',
      '- tool/result confirmed the fix (session event 7)',
      'TODO references:',
      '- read the design docs (session event 4)',
    ].join('\n'))
  })

  it('renders a committed-but-empty stable as its header alone', () => {
    const stable: TaskStateStable = {
      schemaVersion: 1,
      revision: 1,
      filterVersion: 'filter-v1',
      sourceCursor: 0,
      digest: 'digest-1',
      facts: [],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: { currentObjective: '', currentFocus: '', openWork: [], nextActions: [] },
    }
    expect(renderTaskStateSnapshot(stable, 1 << 20))
      .toBe('Durable task state (revision 1, source event 0, digest digest-1).')
  })

  it('renders list sections without continuation content directly after the header', () => {
    const stable: TaskStateStable = {
      schemaVersion: 1,
      revision: 2,
      filterVersion: 'filter-v1',
      sourceCursor: 4,
      digest: 'digest-2',
      facts: [{
        id: TaskStateEntryId('fact-66666666-6666-4666-8666-666666666666'),
        content: 'list only',
      }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: { currentObjective: '', currentFocus: '', openWork: [], nextActions: [] },
    }
    expect(renderTaskStateSnapshot(stable, 1 << 20)).toBe([
      'Durable task state (revision 2, source event 4, digest digest-2).',
      '',
      'Facts:',
      '- list only',
    ].join('\n'))
  })

  it('renders an openWork list without an objective or focus', () => {
    const stable: TaskStateStable = {
      schemaVersion: 1,
      revision: 4,
      filterVersion: 'filter-v1',
      sourceCursor: 9,
      digest: 'digest-4',
      facts: [],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: { currentObjective: '', currentFocus: '', openWork: ['finish the renderer'], nextActions: [] },
    }
    expect(renderTaskStateSnapshot(stable, 1 << 20)).toBe([
      'Durable task state (revision 4, source event 9, digest digest-4).',
      'Open work:',
      '- finish the renderer',
    ].join('\n'))
  })

  it('is deterministic for one stable and budget', () => {
    const budget = 200
    expect(renderTaskStateSnapshot(canonical(), budget))
      .toBe(renderTaskStateSnapshot(canonical(), budget))
  })

  it('never exceeds the budget, never splits a codepoint, and keeps whole lines', () => {
    const stable: TaskStateStable = {
      ...continuationOnly(),
      facts: [{
        id: TaskStateEntryId('fact-44444444-4444-4444-8444-444444444444'),
        content: '修复中文边界 🧭 完整路径 C:\\src\\任务状态 快照边界',
      }],
    }
    for (let budget = 1; budget < 600; budget += 1) {
      const text = renderTaskStateSnapshot(stable, budget)
      expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(budget)
      expect(text).not.toContain('\uFFFD')
      if (text !== '' && text !== TASK_STATE_TRUNCATION_MARKER) {
        expect(text.startsWith('Durable task state')).toBe(true)
      }
    }
  })

  it('appends the truncation marker when a later line was dropped', () => {
    const full = renderTaskStateSnapshot(canonical(), 1 << 20)
    const budget = encoder.encode(full).byteLength - 40
    const text = renderTaskStateSnapshot(canonical(), budget)
    expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(budget)
    expect(text.endsWith(TASK_STATE_TRUNCATION_MARKER)).toBe(true)
    expect(text).not.toContain('- read the design docs (session event 4)')
    expect(text).toContain('revision 3')
  })

  it('returns an empty string when no whole line can fit beside the marker', () => {
    const firstLineBytes = encoder.encode('Durable task state (revision 1, source event 0, digest digest-1).').byteLength
    expect(renderTaskStateSnapshot(continuationOnly(), firstLineBytes - 1)).toBe('')
    const markerBytes = encoder.encode(TASK_STATE_TRUNCATION_MARKER).byteLength
    expect(renderTaskStateSnapshot(canonical(), markerBytes - 1)).toBe('')
  })

  it('returns the whole render unchanged when it fits the budget', () => {
    const full = renderTaskStateSnapshot(canonical(), 1 << 20)
    expect(renderTaskStateSnapshot(canonical(), encoder.encode(full).byteLength)).toBe(full)
    expect(full).not.toContain(TASK_STATE_TRUNCATION_MARKER)
  })

  it('preserves literal double braces and CJK bytes inside entry content', () => {
    const stable: TaskStateStable = {
      ...continuationOnly(),
      facts: [{
        id: TaskStateEntryId('fact-55555555-5555-4555-8555-555555555555'),
        content: 'keep {{task_state_snapshot}} verbatim and 中文 intact',
      }],
      todoReferences: [{ seq: 4, content: '模板 {{literal}} 不展开' }],
    }
    const text = renderTaskStateSnapshot(stable, 1 << 20)
    expect(text).toContain('- keep {{task_state_snapshot}} verbatim and 中文 intact')
    expect(text).toContain('- 模板 {{literal}} 不展开 (session event 4)')
  })
})
