import { describe, expect, it } from 'vitest'
import type { TaskStateStable } from '../src/task-state.ts'
import { foldBatchWindow } from '../src/internal/task-state/basic/batch.ts'

/** A minimal committed base stable with `factCount` large facts. */
function baseWithFacts(revision: number, sourceCursor: number, factCount: number): TaskStateStable | null {
  return {
    schemaVersion: 1,
    revision,
    filterVersion: 'task-state-basic/filter-v2',
    sourceCursor,
    digest: `digest-${revision}`,
    facts: Array.from({ length: factCount }, (_, i) => ({
      id: `fact-${i}` as never,
      content: 'x'.repeat(500),
    })),
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: [],
    goalView: { status: 'none' },
    todoView: { status: 'none', items: [] },
    continuation: { currentObjective: 'o', currentFocus: 'f', openWork: [], nextActions: [] },
  }
}

/** A minimal committed base stable. */
function base(revision: number, sourceCursor: number): TaskStateStable | null {
  return baseWithFacts(revision, sourceCursor, 0)
}

/** Eligible user events, one per seq from `start`. */
function events(start: number, count: number): { seq: number; type: string; data: unknown }[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: start + i,
    type: 'user/message',
    data: { content: [{ type: 'text', text: `prompt ${start + i}` }], source: { kind: 'user' } },
  }))
}

/** Assert one fold returned a window and return it. */
function expectWindow(folded: ReturnType<typeof foldBatchWindow>): NonNullable<Extract<ReturnType<typeof foldBatchWindow>, { kind: 'window' }>['window']> {
  expect(folded.kind).toBe('window')
  if (folded.kind !== 'window') throw new Error('expected a folded window')
  return folded.window
}

describe('task-state-basic batch window folding', () => {
  it('folds eligible events above the cursor up to the watermark', () => {
    const window = expectWindow(foldBatchWindow(events(0, 10), base(1, 3), 3, 9, {
      maxEvents: 100,
      maxInputBytes: 100_000,
    }))
    expect(window.includedSeqs).toEqual([4, 5, 6, 7, 8, 9])
    expect(window.sourceCursor).toBe(9)
    expect(window.events.length).toBe(6)
  })

  it('respects the maximum eligible-event count', () => {
    const window = expectWindow(foldBatchWindow(events(0, 10), null, -1, 9, {
      maxEvents: 3,
      maxInputBytes: 100_000,
    }))
    expect(window.includedSeqs).toEqual([0, 1, 2])
    expect(window.sourceCursor).toBe(2)
  })

  it('respects the maximum framed-input byte budget', () => {
    const bigEvents = events(0, 4).map(event => ({
      ...event,
      data: { content: [{ type: 'text', text: 'x'.repeat(10_000) }], source: { kind: 'user' } },
    }))
    const window = expectWindow(foldBatchWindow(bigEvents, null, -1, 3, {
      maxEvents: 100,
      maxInputBytes: 6_000,
    }))
    expect(window.events.length).toBe(1)
    expect(window.inputBytes).toBeLessThanOrEqual(6_000)
  })

  it('returns infeasible when even the first meaningful event exceeds the complete framed budget', () => {
    const huge = [{
      seq: 0,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'z'.repeat(50_000) }], source: { kind: 'user' } },
    }]
    const folded = foldBatchWindow(huge, null, -1, 0, {
      maxEvents: 100,
      maxInputBytes: 1_000,
    })
    expect(folded.kind).toBe('infeasible')
    if (folded.kind === 'infeasible') {
      expect(folded.frameBytes).toBeGreaterThan(folded.maxInputBytes)
    }
  })

  it('returns infeasible when the base stable alone already exceeds the budget', () => {
    const hugeBase = baseWithFacts(1, 0, 400)
    const folded = foldBatchWindow(events(1, 1), hugeBase, 0, 1, {
      maxEvents: 100,
      maxInputBytes: 1_000,
    })
    expect(folded.kind).toBe('infeasible')
  })

  it('counts CJK and wrapper bytes in the framed-input budget', () => {
    const cjk = [{
      seq: 0,
      type: 'user/message',
      data: { content: [{ type: 'text', text: '任务状态' }], source: { kind: 'user' } },
    }]
    // The v3 frame carries the authoritative Goal/TODO block beside the
    // projection, so the framed input of one CJK message is ~384 bytes; the
    // budget below is the smallest one that still fits it whole.
    const tiny = foldBatchWindow(cjk, null, -1, 0, { maxEvents: 100, maxInputBytes: 400 })
    expect(tiny.kind).toBe('window')
    if (tiny.kind === 'window') {
      expect(tiny.window.inputBytes).toBeLessThanOrEqual(400)
      expect(tiny.window.events.length).toBe(1)
    }
    const undersized = foldBatchWindow(cjk, null, -1, 0, { maxEvents: 100, maxInputBytes: 10 })
    expect(undersized.kind).toBe('infeasible')
  })

  it('returns empty when no eligible event projects meaningful content', () => {
    const folded = foldBatchWindow([
      { seq: 5, type: 'turn/start', data: { turn: 1 } },
      { seq: 6, type: 'session/end-seed', data: {} },
    ], null, -1, 6, { maxEvents: 100, maxInputBytes: 100_000 })
    expect(folded.kind).toBe('empty')
  })

  it('ignores events at or below the committed cursor', () => {
    const window = expectWindow(foldBatchWindow(events(0, 6), base(1, 4), 4, 8, {
      maxEvents: 100,
      maxInputBytes: 100_000,
    }))
    expect(window.includedSeqs).toEqual([5])
  })

  it('stops folding at the pending watermark even when later events exist', () => {
    const window = expectWindow(foldBatchWindow(events(0, 10), null, -1, 4, {
      maxEvents: 100,
      maxInputBytes: 100_000,
    }))
    expect(window.includedSeqs).toEqual([0, 1, 2, 3, 4])
    expect(window.sourceCursor).toBe(4)
  })
})
