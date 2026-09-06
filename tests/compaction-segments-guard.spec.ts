import { describe, expect, it } from 'vitest'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import { isIsolatedOldSummaryRange } from '../src/internal/compaction/selection-guard.ts'
import { toolSegments, toolSegmentAt } from '../src/internal/compaction/tool-segments.ts'
import type { ToolSegment } from '../src/internal/compaction/tool-segments.ts'

const SURFACE = { surfaceOp: 'append' as const }

function userPrompt(session: Session, text = 'hello'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), SURFACE).seq
}

/** One closed assistant tool-call + result pair; returns both node seqs. */
function toolStep(session: Session, turn: number, step: number, call: string): [SessionSeqType, SessionSeqType] {
  const assistantSeq = session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(call), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE).seq
  const resultSeq = session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(call),
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    }),
  }, SURFACE).seq
  return [assistantSeq, resultSeq]
}

/** Land one compaction checkpoint over an inclusive surface range; returns the checkpoint node seq. */
function compactRange(session: Session, start: SessionSeqType, end: SessionSeqType, compactionId = CompactionId('c')): SessionSeqType {
  const nodes = [...session.surface.nodes]
  const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
  const startEvent = session.append('compaction/start', { compactionId, turn: null })
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text' as const, text: 'summary' }],
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: 0,
    provider: 'mock',
    model: 'mock',
  })
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId },
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  }).seq
}

function nodeAt(session: Session, position: number): SessionSeqType {
  const seq = session.surface.nodes[position]
  if (seq === undefined) throw new Error(`no surface node at position ${position}`)
  return seq
}

describe('tool segments (internal pure helper)', () => {
  it('emits one complete closed tool step as a balanced segment', () => {
    const session = Session.create(SessionId('one-segment'))
    userPrompt(session)
    const [assistant, result] = toolStep(session, 1, 1, 'c1')
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ turn: 1, startSeq: assistant, endSeq: result })
    expect(segments[0]!.seqs).toEqual([assistant, result])
    expect(toolSegmentAt(session, assistant)?.seqs).toEqual([assistant, result])
  })

  it('groups consecutive same-turn closed steps into one segment', () => {
    const session = Session.create(SessionId('consecutive'))
    userPrompt(session)
    toolStep(session, 1, 1, 'c1')
    toolStep(session, 1, 2, 'c2')
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.seqs).toHaveLength(4)
  })

  it('interrupts on an ordinary user message and never merges across turns', () => {
    const session = Session.create(SessionId('interrupted'))
    userPrompt(session, 'first')
    toolStep(session, 1, 1, 'c1')
    userPrompt(session, 'again')
    toolStep(session, 2, 1, 'c2')
    const segments = toolSegments(session)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.turn).toBe(1)
    expect(segments[1]!.turn).toBe(2)
  })

  it('excludes an open trailing tool call (no result)', () => {
    const session = Session.create(SessionId('open-tail'))
    userPrompt(session)
    toolStep(session, 1, 1, 'c1')
    // An unanswered assistant tool call.
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('open'), name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.seqs).toHaveLength(2)
    // The open call belongs to no segment.
    expect(toolSegmentAt(session, nodeAt(session, 3))).toBeNull()
  })

  it('keeps the emitted segment typed and Cordis-free', () => {
    const session = Session.create(SessionId('typed'))
    userPrompt(session)
    const [, result] = toolStep(session, 1, 1, 'c1')
    const segments = toolSegments(session)
    const first: ToolSegment | undefined = segments[0]
    expect(first?.endSeq).toBe(result)
  })
})

describe('isolated-old-summary empty-benefit guard (internal pure helper)', () => {
  it('accepts an empty candidate range as not isolated', () => {
    const session = Session.create(SessionId('empty'))
    userPrompt(session)
    expect(isIsolatedOldSummaryRange(session, [])).toBe(false)
  })

  it('rejects an isolated single old compaction checkpoint', () => {
    const session = Session.create(SessionId('single'))
    const original = userPrompt(session, 'work')
    const checkpoint = compactRange(session, original, original)
    expect(isIsolatedOldSummaryRange(session, [checkpoint])).toBe(true)
  })

  it('allows an old summary combined with newer ordinary content', () => {
    const session = Session.create(SessionId('mixed'))
    const original = userPrompt(session, 'work')
    const checkpoint = compactRange(session, original, original)
    const resumed = userPrompt(session, 'new work')
    expect(isIsolatedOldSummaryRange(session, [checkpoint, resumed])).toBe(false)
  })

  it('requires the candidate to be a contiguous in-surface span in surface order', () => {
    const session = Session.create(SessionId('invalid'))
    const first = userPrompt(session, 'one')
    userPrompt(session, 'two')
    const third = userPrompt(session, 'three')
    // Sparse: skips a current surface node.
    expect(() => isIsolatedOldSummaryRange(session, [first, third])).toThrow(/contiguous span/)
    // Out of surface order.
    expect(() => isIsolatedOldSummaryRange(session, [third, first])).toThrow(/contiguous span/)
    // Duplicate.
    expect(() => isIsolatedOldSummaryRange(session, [first, first])).toThrow(/must not repeat/)
  })

  it('throws for a seq that is no longer on the current surface', () => {
    const session = Session.create(SessionId('shadowed'))
    const original = userPrompt(session, 'work')
    const checkpoint = compactRange(session, original, original)
    // The shadowed prompt remains in the log but is not a current surface node.
    expect(() => isIsolatedOldSummaryRange(session, [original])).toThrow(/not a current surface node/)
    expect(isIsolatedOldSummaryRange(session, [checkpoint])).toBe(true)
  })
})
