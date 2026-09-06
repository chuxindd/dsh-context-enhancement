import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import { summarizeToolGroup } from '../src/internal/compaction/tool-group-summarizer.ts'

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private text: string) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(text: string): Promise<{ ctx: Context; adapter: ScriptAdapter; session: Session; group: ReturnType<typeof selectToolGroups>[number] }> {
  const ctx = new Context()
  const adapter = new ScriptAdapter(text)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['route'], adapter)
  const session = Session.create(SessionId('group-summarizer'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  for (const [step, id] of [[1, 'a'], [2, 'b']] as const) {
    session.append('assistant/message', { turn: 1, step, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId(id), name: 'bash', arguments: `--file ${id}.ts` }], source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: `updated ${id}.ts; error none` }], isError: false }) }, { surfaceOp: 'append' })
  }
  const group = selectToolGroups(session, { minGroupResults: 1, minGroupChars: 1, minGroupTokens: 1, maxGroupTokens: 100, estimateTokens: () => 1 })[0]
  if (group === undefined) throw new Error('missing test group')
  return { ctx, adapter, session, group }
}

function output(session: Session, group: ReturnType<typeof selectToolGroups>[number]): string {
  const items = group.sourceSeqs.map(seq => {
    const event = session.eventAt(seq)!
    if (event.type === 'tool/result') return { sourceSeq: seq, callId: String(event.data.message.source.callId), summary: 'updated', facts: ['updated'], files: [`${String(event.data.message.source.callId)}.ts`], identifiers: [], errors: ['error none'], unresolved: [] }
    return { sourceSeq: seq, summary: 'bash call', facts: [], files: [], identifiers: [], errors: [], unresolved: [] }
  })
  return JSON.stringify({ version: 1, groupSummary: 'updated files', items, groupErrors: [], unresolved: [] })
}

describe('tool group summarizer call', () => {
  it('makes exactly one structured call and returns parsed output', async () => {
    const state = await setup('placeholder')
    state.adapter['text'] = output(state.session, state.group)
    const result = await summarizeToolGroup(state.ctx, state.session, state.group, { session: state.session } as never, { provider: 'route', model: 'model', maxTokens: 100 })
    expect(state.adapter.requests).toHaveLength(1)
    expect(result.summary.items).toHaveLength(state.group.sourceSeqs.length)
    expect(state.adapter.requests[0]!.purpose).toBe('compaction')
  })

  it('classifies invalid JSON as a fallback error', async () => {
    const state = await setup('{not json')
    await expect(summarizeToolGroup(state.ctx, state.session, state.group, { session: state.session } as never, { provider: 'route', model: 'model', maxTokens: 100 })).rejects.toMatchObject({ reason: 'json' })
  })
})
