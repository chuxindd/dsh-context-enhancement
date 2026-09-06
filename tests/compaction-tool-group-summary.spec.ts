import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildToolGroupSummaryInput, parseToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'

const SURFACE = { surfaceOp: 'append' as const }

function makeGroup(): { session: Session; group: ReturnType<typeof selectToolGroups>[number] } {
  const session = Session.create(SessionId('summary-protocol'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
  for (const [step, id] of [[1, 'a'], [2, 'b']] as const) {
    session.append('assistant/message', {
      turn: 1,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: `--file ${id}.ts` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, SURFACE)
    session.append('tool/result', {
      turn: 1,
      step,
      message: createToolResultMessage({
        callId: ToolCallId(id),
        content: [{ type: 'text', text: `updated ${id}.ts; error none` }],
        isError: false,
      }),
    }, SURFACE)
  }
  const group = selectToolGroups(session, {
    minGroupResults: 1,
    minGroupChars: 1,
    minGroupTokens: 1,
    maxGroupTokens: 100,
    estimateTokens: () => 1,
  })[0]
  if (group === undefined) throw new Error('test group missing')
  return { session, group }
}

function validOutput(input: ReturnType<typeof buildToolGroupSummaryInput>): unknown {
  return {
    version: 1,
    groupSummary: 'updated files',
    items: input.items.map(item => ({
      sourceSeq: item.sourceSeq,
      ...(item.callId === undefined ? {} : { callId: item.callId }),
      summary: String(item.content),
      facts: item.role === 'tool-result' ? [String(item.content).split(';')[0]!] : [],
      files: item.role === 'tool-result' ? [`${item.callId}.ts`] : [],
      identifiers: [],
      errors: item.role === 'tool-result' ? ['error none'] : [],
      unresolved: [],
    })),
    groupErrors: [],
    unresolved: [],
  }
}

describe('tool group summary protocol', () => {
  it('builds an input snapshot and accepts source-grounded output', () => {
    const { session, group } = makeGroup()
    const input = buildToolGroupSummaryInput(session, group)
    expect(parseToolGroupSummary(validOutput(input), input).items).toHaveLength(input.items.length)
  })

  it('rejects missing, duplicate, or foreign source seqs', () => {
    const { session, group } = makeGroup()
    const input = buildToolGroupSummaryInput(session, group)
    const output = validOutput(input) as { items: Array<Record<string, unknown>> }
    output.items = [output.items[0]!, output.items[0]!]
    expect(() => parseToolGroupSummary(output, input)).toThrow(/duplicated|missing/)
    output.items = [{ ...output.items[0]!, sourceSeq: 999 }, ...input.items.slice(1).map(item => ({
      sourceSeq: item.sourceSeq, summary: String(item.content), facts: [], files: [], identifiers: [], errors: [], unresolved: [],
    }))]
    expect(() => parseToolGroupSummary(output, input)).toThrow(/not in the input group/)
  })

  it('rejects claims that are not present in the corresponding source', () => {
    const { session, group } = makeGroup()
    const input = buildToolGroupSummaryInput(session, group)
    const output = validOutput(input) as { items: Array<Record<string, unknown>> }
    output.items[0] = { ...output.items[0]!, facts: ['invented fact'] }
    expect(() => parseToolGroupSummary(output, input)).toThrow(/not present in source/)
  })
})
