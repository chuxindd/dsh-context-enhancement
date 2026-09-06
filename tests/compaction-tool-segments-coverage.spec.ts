import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import { toolSegmentAt, toolSegments } from '../src/internal/compaction/tool-segments.ts'

const SURFACE = { surfaceOp: 'append' as const }
const SYSTEM_PROMPT_SOURCE = '@deepseek-ai/dsh-system-prompt'

type ToolCallSpec = ReturnType<typeof call>
const call = (id: string, name = 'bash', argumentsText = '{}') => (
  { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: argumentsText }
)

/** Append one model-ordered tool step whose assistant message asks for `calls`. */
function toolStep(session: Session, turn: number, step: number, calls: ToolCallSpec[]): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: calls,
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  for (const c of calls) {
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({
        callId: c.id,
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      }),
    }, SURFACE)
  }
}

/** Append an ordinary (non-tool) assistant response on the given turn/step. */
function assistantReply(session: Session, turn: number, step: number, text = 'done'): SessionSeqType {
  return session.append('assistant/message', {
    turn, step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, SURFACE).seq
}

/** Append an ordinary direct-human user prompt. */
function userPrompt(session: Session, text = 'hello'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), SURFACE).seq
}

/** Append a plugin-owned non-snapshot injected notice (another non-tool surface node). */
function injectedContext(session: Session, plugin: string, text = 'notice'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }), SURFACE).seq
}

/** Append the durable runtime-context snapshot the system-prompt projection emits. */
function runtimeContext(session: Session, text = 'Current runtime context: ...'): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: SYSTEM_PROMPT_SOURCE, form: 'snapshot', sections: [] },
  }), SURFACE).seq
}

/** Surface node seq at `position` in the current surface. */
function nodeAt(session: Session, position: number): SessionSeqType {
  const seq = session.surface.nodes[position]
  if (seq === undefined) throw new Error(`no surface node at position ${position}`)
  return seq
}

/** All surface node seqs of one surface event type, in surface order. */
function surfaceSeqsOfType(session: Session, type: SessionEvent['type']): SessionSeqType[] {
  return [...session.surface.nodes].filter(seq => session.snapshotEvents()[seq]?.type === type)
}

/** Replace the inclusive current surface range `[start, end]` with one compaction checkpoint; returns its node seq. */
function compactRange(session: Session, start: SessionSeqType, end: SessionSeqType, compactionId = CompactionId('c')): SessionSeqType {
  const nodes = [...session.surface.nodes]
  const startIndex = nodes.indexOf(start)
  const endIndex = nodes.indexOf(end)
  const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)
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
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  }).seq
}

describe('tool segment emission (ported coverage)', () => {
  it('emits a head-anchored closed pair when the surface starts with tool activity', () => {
    const session = Session.create(SessionId('ported-head-anchored'))
    toolStep(session, 1, 1, [call('c1')])
    expect(toolSegments(session)).toHaveLength(1)
    expect(toolSegments(session)[0]!.seqs).toEqual([nodeAt(session, 0), nodeAt(session, 1)])
  })

  it('emits nothing for a fully open tool call', () => {
    const session = Session.create(SessionId('ported-fully-open'))
    userPrompt(session)
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [call('open')],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
    expect(toolSegments(session)).toEqual([])
  })

  it('conservatively excludes a later closed pair when an earlier call stays stranded open', () => {
    const session = Session.create(SessionId('ported-stranded-then-closed'))
    userPrompt(session)
    // A closed tool step first, so the surface has a certifiable balanced prefix.
    toolStep(session, 1, 1, [call('c1')])
    // A stranded assistant tool call whose result never lands.
    session.append('assistant/message', {
      turn: 1, step: 2,
      message: createMessage({
        role: 'assistant',
        content: [call('stranded')],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
    // A later closed pair would be balanced on its own, but the unanswered
    // call keeps the burst-run balance open; the segmenter must not emit it as
    // if pairing were certified.
    toolStep(session, 1, 3, [call('c2')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.seqs).toEqual([nodeAt(session, 1), nodeAt(session, 2)])
    // The stranded call and the closed pair behind it stay unsegmented.
    expect(toolSegmentAt(session, nodeAt(session, 3))).toBeNull()
    expect(toolSegmentAt(session, nodeAt(session, 5))).toBeNull()
  })

  it('keeps an open tail whose result is not part of any balanced run unsegmented', () => {
    const session = Session.create(SessionId('ported-result-without-closed-run'))
    userPrompt(session)
    // A tool call answered only after an ordinary assistant response interrupts.
    const callSeq = session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [call('late')],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE).seq
    assistantReply(session, 1, 2, 'ordinary text between call and result')
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('late'),
        content: [],
        isError: false,
      }),
    }, SURFACE)
    expect(toolSegments(session)).toEqual([])
    expect(toolSegmentAt(session, callSeq)).toBeNull()
  })

  it('groups all parallel calls of one assistant message into one segment', () => {
    const session = Session.create(SessionId('ported-parallel'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('p1'), call('p2'), call('p3')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    // Whole assistant node plus its three complete results.
    expect(segments[0]!.seqs).toHaveLength(4)
    expect(segments[0]!.seqs[0]).toBe(nodeAt(session, 1))
  })

  it('keeps a parallel burst and a following closed step together when nothing interrupts', () => {
    const session = Session.create(SessionId('ported-parallel-then-exclusive'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('p1'), call('p2')])
    toolStep(session, 1, 2, [call('x1')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.seqs).toHaveLength(5)
  })
})

describe('tool segment interrupts (ported coverage)', () => {
  it('interrupts on an ordinary assistant response', () => {
    const session = Session.create(SessionId('ported-assistant-interrupt'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    assistantReply(session, 1, 2)
    toolStep(session, 1, 3, [call('c2')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.seqs).toHaveLength(2)
    expect(segments[1]!.seqs).toHaveLength(2)
  })

  it('interrupts on a runtime-context snapshot', () => {
    const session = Session.create(SessionId('ported-snapshot-interrupt'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    runtimeContext(session, 'context changed')
    toolStep(session, 1, 2, [call('c2')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(2)
  })

  it('interrupts on an injected plugin notice (other non-tool surface node)', () => {
    const session = Session.create(SessionId('ported-inject-interrupt'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    injectedContext(session, 'some-plugin', 'background update')
    toolStep(session, 1, 2, [call('c2')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(2)
  })

  it('interrupts on a compaction replacement checkpoint', () => {
    const session = Session.create(SessionId('ported-compaction-interrupt'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    // Compact the head (user prompt + closed tool step), landing a checkpoint.
    compactRange(session, nodeAt(session, 0), nodeAt(session, 2), CompactionId('c1'))
    toolStep(session, 1, 2, [call('c2')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.seqs).toEqual([
      ...surfaceSeqsOfType(session, 'assistant/message'),
      ...surfaceSeqsOfType(session, 'tool/result'),
    ])
  })
})

describe('tool segments across turns (ported coverage)', () => {
  it('never merges tool activity from different turns', () => {
    const session = Session.create(SessionId('ported-cross-turn'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    userPrompt(session, 'next turn')
    toolStep(session, 2, 1, [call('c2')])
    toolStep(session, 2, 2, [call('c3')])
    const segments = toolSegments(session)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.turn).toBe(1)
    expect(segments[1]!.turn).toBe(2)
    expect(segments[1]!.seqs).toHaveLength(4)
  })
})

describe('tool segment surface membership (ported coverage)', () => {
  it('finds the segment owning one current surface node for boundary snapping', () => {
    const session = Session.create(SessionId('ported-owning-segment'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    const assistantSeq = nodeAt(session, 1)
    const resultSeq = nodeAt(session, 2)
    const owned = toolSegmentAt(session, assistantSeq)
    expect(owned).not.toBeNull()
    expect(owned!.seqs).toEqual([assistantSeq, resultSeq])
    expect(toolSegmentAt(session, resultSeq)).toEqual(owned)
  })

  it('emits nothing when a compaction replacement shadowed the whole tool run', () => {
    const session = Session.create(SessionId('ported-replaced-surface'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    const shadowed = [...session.surface.nodes]
    const replacement = compactRange(session, nodeAt(session, 0), nodeAt(session, 2), CompactionId('whole'))
    expect(session.surface.nodes).toEqual([replacement])
    expect(toolSegments(session)).toEqual([])
    expect(toolSegmentAt(session, replacement)).toBeNull()
    // A shadowed seq is no longer a current surface node.
    expect(() => toolSegmentAt(session, shadowed[1]!)).toThrow(/surface seq .* not found/)
  })

  it('keeps surface-order scanning correct when a pruner rewrite makes surface seqs non-monotonic', () => {
    const session = Session.create(SessionId('ported-pruner-mid-surface'))
    userPrompt(session, 'first')
    toolStep(session, 1, 1, [call('old')])
    // A second adjacent closed step already sits on the surface.
    toolStep(session, 1, 2, [call('next')])
    const before = [...session.surface.nodes]
    expect(before).toEqual([SessionSeq(0), SessionSeq(1), SessionSeq(2), SessionSeq(3), SessionSeq(4)])
    // The tool-result pruner rewrites ONE mid-surface tool result in place:
    // the replacement is appended at the log tail (highest seq) but lands at
    // the shadowed node's surface position, so lower-seq current nodes follow
    // it and visible seqs are no longer monotonically increasing.
    const originalResultSeq = surfaceSeqsOfType(session, 'tool/result')[0]!
    const originalResult = session.snapshotEvents()[originalResultSeq]!
    if (originalResult.type !== 'tool/result') throw new Error('expected a tool/result')
    const block = originalResult.data.message.content[0]
    const rewritten = freezeMessage<ToolResultMessage>({
      ...originalResult.data.message,
      content: [{
        ...block,
        content: [{ type: 'text' as const, text: 'shorter' }],
      }] as [typeof block],
    })
    session.append('tool/result', {
      ...originalResult.data,
      message: rewritten,
    }, {
      surfaceOp: { op: 'replace', start: originalResultSeq, end: originalResultSeq },
      sourceEventSeqs: [originalResultSeq],
    })
    const nodes = [...session.surface.nodes]
    // The fresh rewrite (seq 5) sits at position 2; seqs 3 and 4 follow it.
    expect(nodes).toEqual([SessionSeq(0), SessionSeq(1), SessionSeq(5), SessionSeq(3), SessionSeq(4)])
    expect(nodes[2]!).toBeGreaterThan(nodes[3]!)
    const segments = toolSegments(session)
    expect(segments).toHaveLength(1)
    // Nodes are reported in SURFACE order, not sorted by seq value.
    expect(segments[0]!.seqs).toEqual([SessionSeq(1), SessionSeq(5), SessionSeq(3), SessionSeq(4)])
    expect(segments[0]!.startSeq).toBe(SessionSeq(1))
    expect(segments[0]!.endSeq).toBe(SessionSeq(4))
    expect(toolSegmentAt(session, nodes[2]!)).toEqual(segments[0])
  })

  it('rejects a seq absent from the current surface', () => {
    const session = Session.create(SessionId('ported-missing-membership'))
    userPrompt(session)
    toolStep(session, 1, 1, [call('c1')])
    expect(() => toolSegmentAt(session, SessionSeq(999))).toThrow(/surface seq 999 not found/)
  })

  it('throws when a current surface seq has no matching log event', () => {
    // A fabricated session whose surface names an event that the log does not
    // hold at that seq exercises the leaf's corrupt-surface guard directly.
    const missingSeq = SessionSeq(5)
    const session = {
      eventAt: () => undefined,
      surface: { nodes: [missingSeq], replaceGeneration: 0 },
    } as unknown as Session
    expect(() => toolSegments(session)).toThrow(/surface seq 5 has no matching session event/)
  })
})
