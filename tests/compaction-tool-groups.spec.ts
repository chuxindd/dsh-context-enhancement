import { describe, expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'

const SURFACE = { surfaceOp: 'append' as const }

function toolStep(session: Session, turn: number, step: number, id: string, text: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(id),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, SURFACE)
}

function userPrompt(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
}

function assistantReply(session: Session, turn: number, step: number): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'interruption' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
}

describe('tool group selection', () => {
  it('selects only complete groups inside the older surface range', () => {
    const session = Session.create(SessionId('groups-older-range'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'a'.repeat(7_000))
    assistantReply(session, 1, 2)
    toolStep(session, 1, 3, 'b', 'b'.repeat(7_000))
    const nodes = [...session.surface.nodes]
    const groups = selectToolGroups(session, {
      olderRange: { start: nodes[0]!, end: nodes[2]! },
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      estimateTokens: () => 1_500,
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.toolResultSeqs).toHaveLength(1)
    expect(groups[0]!.endSeq).toBe(nodes[2])
  })

  it('uses surface positions rather than numeric seq ordering', () => {
    const session = Session.create(SessionId('groups-non-monotonic'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'a'.repeat(7_000))
    const firstRange = [...session.surface.nodes]
    assistantReply(session, 1, 2)
    toolStep(session, 1, 3, 'b', 'b'.repeat(7_000))
    const nodes = [...session.surface.nodes]
    const groups = selectToolGroups(session, {
      olderRange: { start: firstRange[1]!, end: firstRange[2]! },
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      estimateTokens: () => 1_500,
    })
    expect(groups[0]!.startPosition).toBe(1)
    expect(groups[0]!.endPosition).toBe(2)
    expect(nodes.indexOf(groups[0]!.startSeq)).toBe(1)
  })

  it('does not select a small group or a group above the token cap', () => {
    const session = Session.create(SessionId('groups-thresholds'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', 'small')
    toolStep(session, 1, 2, 'b', 'small')
    expect(selectToolGroups(session, { minGroupChars: 100, minGroupTokens: 1, maxGroupTokens: 10, estimateTokens: () => 6 })).toEqual([])
  })
})
