import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '../src/internal/compaction/tool-pairing.ts'
import type { SessionRead } from '../src/internal/compaction/tool-pairing.ts'

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
  session.append('tool/call', {
    turn,
    step,
    callId: ToolCallId(call),
    name: 'bash',
    arguments: '{}',
  })
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

describe('tool pairing balance (internal pure helpers)', () => {
  it('reports balanced cuts only outside a completed tool-call/result pair', () => {
    const session = Session.create(SessionId('pairing'))
    userPrompt(session)
    const [assistant, result] = toolStep(session, 1, 1, 'c1')
    expect(toolPairingBalancedBefore(session, assistant)).toBe(true)
    expect(toolPairingBalancedAfter(session, result)).toBe(true)
    // A cut between the call and its result would split the pair.
    expect(toolPairingBalancedAfter(session, assistant)).toBe(false)
    expect(toolPairingBalancedBefore(session, result)).toBe(false)
  })

  it('accepts a structural SessionRead (detached session) so the leaf stays Cordis-free', () => {
    const session = Session.create(SessionId('structural'))
    userPrompt(session)
    toolStep(session, 1, 1, 'c1')
    const read: SessionRead = {
      eventAt: seq => session.eventAt(seq),
      surface: session.surface,
    }
    const nodes = [...read.surface.nodes]
    expect(toolPairingBalancedBefore(read, nodes[1]!)).toBe(true)
    expect(toolPairingBalancedAfter(read, nodes[2]!)).toBe(true)
  })

  it('throws for a seq absent from the current surface', () => {
    const session = Session.create(SessionId('missing'))
    userPrompt(session)
    expect(() => toolPairingBalancedBefore(session, 999 as SessionSeqType)).toThrow(/not found/)
  })

  it('throws for an orphan tool result (corrupt surface)', () => {
    const session = Session.create(SessionId('orphan'))
    userPrompt(session)
    // A tool result whose assistant call is not on the surface is corrupt.
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('orphan'),
        content: [],
        isError: false,
      }),
    }, SURFACE)
    const nodes = [...session.surface.nodes]
    expect(() => toolPairingBalancedAfter(session, nodes.at(-1)!)).toThrow(/no matching tool-call/)
  })
})
