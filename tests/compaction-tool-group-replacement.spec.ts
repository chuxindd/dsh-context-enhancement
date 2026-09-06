import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'

const SURFACE = { surfaceOp: 'append' as const }

describe('tool group replacement', () => {
  it('validates every target before appending replacements', () => {
    const session = Session.create(SessionId('group-replacement-preflight'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    session.append('assistant/message', { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId('a'), name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, SURFACE)
    const resultSeq = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('a'), content: [{ type: 'text', text: 'result' }], isError: false }) }, SURFACE).seq
    const group = selectToolGroups(session, { minGroupResults: 1, minGroupChars: 1, minGroupTokens: 1, maxGroupTokens: 100, estimateTokens: () => 1 })[0]!
    const before = session.seq
    expect(() => replaceToolGroup(session, { ...group, toolResultSeqs: [resultSeq, 999 as never] }, { version: 1, groupSummary: 'x', items: [{ sourceSeq: resultSeq, callId: 'a', summary: 'x', facts: [], files: [], identifiers: [], errors: [], unresolved: [] }], groupErrors: [], unresolved: [] })).toThrow(/no longer a tool result/)
    expect(session.seq).toBe(before)
  })

  it('replaces each result while preserving pairing and source events', () => {
    const session = Session.create(SessionId('group-replacement'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    const sourceSeqs: SessionSeq[] = []
    for (const [step, id] of [[1, 'a'], [2, 'b']] as const) {
      session.append('assistant/message', { turn: 1, step, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, SURFACE)
      sourceSeqs.push(session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: `large ${id}` }], isError: false }) }, SURFACE).seq)
    }
    const group = selectToolGroups(session, { minGroupResults: 1, minGroupChars: 1, minGroupTokens: 1, maxGroupTokens: 100, estimateTokens: () => 1 })[0]!
    const summary: ToolGroupSummary = {
      version: 1,
      groupSummary: 'done',
      items: group.sourceSeqs.map(seq => ({ sourceSeq: seq, ...(sourceSeqs.includes(seq) ? { callId: String((session.eventAt(seq) as { data: { message: { source: { callId: string } } } }).data.message.source.callId) } : {}), summary: 'done', facts: [], files: [], identifiers: [], errors: [], unresolved: [] })),
      groupErrors: [],
      unresolved: [],
    }
    const result = replaceToolGroup(session, group, summary)
    expect(result.replacementSeqs).toHaveLength(2)
    expect(session.surface.nodes.some(seq => result.replacementSeqs.includes(seq))).toBe(true)
    expect(session.eventAt(sourceSeqs[0]!)?.type).toBe('tool/result')
    expect(session.eventAt(result.replacementSeqs[0]!)?.type).toBe('tool/result')
    expect(session.surface.replaceGeneration).toBeGreaterThan(0)
  })
})
