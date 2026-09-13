import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import {
  estimateToolGroupAuxiliaryRequestTokens,
  summarizeToolGroup,
  ToolGroupSummaryFallbackError,
} from '../src/internal/compaction/tool-group-summarizer.ts'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { resolveConfig } from '../src/internal/compaction/config.ts'

class MockLlmAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private responseText: string) {
    super()
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.responseText }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.responseText } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function createFixtureContext(responseText: string) {
  const ctx = new Context()
  const adapter = new MockLlmAdapter(responseText)
  await ctx.plugin(LlmRuntime)
  ctx.provide('tokenMeter', {
    estimateMessage: (msg: { content?: readonly { type?: string; text?: string }[] }) => {
      const text = (msg.content ?? [])
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('')
      return Math.ceil(text.length / 4) + 4
    },
  } as never)
  ctx.llm.registerAdapter(['mock-provider'], adapter)
  return { ctx, adapter }
}

function createToolSession(): Session {
  const session = Session.create(SessionId('tool-group-full-cap'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'run tool actions' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  for (const [step, id] of [[1, 'call-1'], [2, 'call-2']] as const) {
    session.append('assistant/message', {
      turn: 1,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId(id), name: 'exec', arguments: `{"cmd":"test-${id}"}` }],
        source: { kind: 'model', provider: 'mock-provider', model: 'mock-model' },
      }),
    }, { surfaceOp: 'append' })

    session.append('tool/result', {
      turn: 1,
      step,
      message: createToolResultMessage({
        callId: ToolCallId(id),
        content: [{ type: 'text', text: `result-content-${id}; status: ok; files: file-${id}.ts` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  return session
}

function validOutput(session: Session, group: ReturnType<typeof selectToolGroups>[number]): string {
  const items = group.sourceSeqs.map(seq => {
    const event = session.eventAt(seq)!
    if (event.type === 'tool/result') {
      return {
        sourceSeq: seq,
        callId: String(event.data.message.source.callId),
        summary: 'done',
        facts: ['ok'],
        files: [`file-${String(event.data.message.source.callId)}.ts`],
        identifiers: [],
        errors: [],
        unresolved: [],
      }
    }
    return { sourceSeq: seq, summary: 'call', facts: [], files: [], identifiers: [], errors: [], unresolved: [] }
  })
  return JSON.stringify({ version: 1, groupSummary: 'summarized tools', items, groupErrors: [], unresolved: [] })
}

describe('tool-group auxiliary request full input cap', () => {
  it('rejects candidate when source events fit alone but complete serialized request exceeds cap (0 provider calls)', async () => {
    const session = createToolSession()
    const { ctx, adapter } = await createFixtureContext('placeholder')

    // Find the candidate group using minimal token threshold
    const candidateGroups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 5_000,
      estimateTokens: () => 10, // Source events alone only price at ~40 tokens
    })
    expect(candidateGroups).toHaveLength(1)
    const group = candidateGroups[0]!

    // Calculate full request tokens: Instruction + JSON Input + Reserve (e.g. 500 maxTokens)
    const reserveTokens = 500
    const fullRequestTokens = estimateToolGroupAuxiliaryRequestTokens(
      session,
      group,
      reserveTokens,
      msg => ctx.tokenMeter.estimateMessage(msg),
    )

    // Full request tokens should be significantly larger than raw source tokens (~40)
    expect(fullRequestTokens).toBeGreaterThan(500)

    // Set input cap to less than fullRequestTokens, but greater than source tokens (~40)
    const tightInputCap = fullRequestTokens - 10

    // Direct summarizer call must reject before stream without making any provider calls
    await expect(summarizeToolGroup(
      ctx,
      session,
      group,
      { session } as never,
      { provider: 'mock-provider', model: 'mock-model', maxTokens: reserveTokens },
      undefined,
      tightInputCap,
    )).rejects.toThrowError(ToolGroupSummaryFallbackError)

    expect(adapter.requests).toHaveLength(0)

    // Selection with isGroupFittable predicate rejects the group
    const fittableGroups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 5_000,
      estimateTokens: () => 10,
      isGroupFittable: g => estimateToolGroupAuxiliaryRequestTokens(
        session,
        g,
        reserveTokens,
        msg => ctx.tokenMeter.estimateMessage(msg),
      ) <= tightInputCap,
    })
    expect(fittableGroups).toHaveLength(0)
  })

  it('allows auxiliary call at the exact boundary when complete serialized request fits within cap', async () => {
    const session = createToolSession()
    const { ctx, adapter } = await createFixtureContext('placeholder')
    const candidateGroups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 5_000,
      estimateTokens: () => 10,
    })
    const group = candidateGroups[0]!
    adapter['responseText'] = validOutput(session, group)

    const reserveTokens = 200
    const fullRequestTokens = estimateToolGroupAuxiliaryRequestTokens(
      session,
      group,
      reserveTokens,
      msg => ctx.tokenMeter.estimateMessage(msg),
    )

    // Set cap to EXACT boundary
    const exactInputCap = fullRequestTokens

    // Group is selected
    const fittableGroups = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 5_000,
      estimateTokens: () => 10,
      isGroupFittable: g => estimateToolGroupAuxiliaryRequestTokens(
        session,
        g,
        reserveTokens,
        msg => ctx.tokenMeter.estimateMessage(msg),
      ) <= exactInputCap,
    })
    expect(fittableGroups).toHaveLength(1)

    // Direct call succeeds and makes exactly 1 provider request
    const result = await summarizeToolGroup(
      ctx,
      session,
      group,
      { session } as never,
      { provider: 'mock-provider', model: 'mock-model', maxTokens: reserveTokens },
      undefined,
      exactInputCap,
    )
    expect(adapter.requests).toHaveLength(1)
    expect(result.summary.groupSummary).toBe('summarized tools')
  })

  it('shared budget prevents tool-stage-deferred deadlock when complete request is over budget', () => {
    const session = createToolSession()
    const config = resolveConfig({
      toolGroupSummarizer: {
        enabled: true,
        minGroupResults: 1,
        minGroupChars: 1,
        minGroupTokens: 1,
        maxSummaryTokens: 400,
      },
    })
    const fakeStore = {
      recordsForSession: () => [],
      open: async () => {},
      finish: async () => {},
    }

    const engine = {
      config,
      ctx: {
        tokenMeter: {
          estimateMessage: (msg: { content: readonly { text?: string }[] }) => {
            const text = msg.content?.[0]?.text ?? ''
            return Math.ceil(text.length / 4) + 4
          },
        },
      },
      toolGroupAuditStore: fakeStore,
    }

    const prototype = BasicCompactionEngine.prototype as unknown as {
      hasPendingToolIntermediateWork: (
        session: Session,
        start: number,
        end: number,
        prune: undefined,
        inputCapTokens?: number,
      ) => string
      toolGroupSelectionOptions: (...args: unknown[]) => unknown
      sourceIndex: (session: Session) => unknown
      toolGroupFingerprint: (session: Session, group: unknown) => string
      cappedMaxGroupTokens: (maxGroupTokens: number, inputCapTokens: number | undefined) => number
    }
    const seams = engine as unknown as Record<string, unknown>
    seams.sourceIndex = (s: Session) => prototype.sourceIndex.call(engine, s)
    seams.toolGroupFingerprint = (s: Session, g: unknown) => prototype.toolGroupFingerprint.call(engine, s, g)
    seams.cappedMaxGroupTokens = (m: number, c: number | undefined) => prototype.cappedMaxGroupTokens.call(engine, m, c)
    seams.toolGroupSelectionOptions = (...args: unknown[]) => prototype.toolGroupSelectionOptions.apply(engine, args)

    const nodes = session.surface.nodes
    const start = nodes[0]!
    const end = nodes.at(-1)!

    // Raw source events alone would fit within 300 tokens:
    // But instruction (~200 tokens) + JSON input (~200 tokens) + reserve (400 tokens) = ~800 tokens.
    // Under an input cap of 300 tokens, full request does NOT fit.
    // The probe MUST return 'none' (not 'actionable'), preventing tool-stage-deferred deadlock!
    const debt = prototype.hasPendingToolIntermediateWork.call(
      engine,
      session,
      start,
      end,
      undefined,
      300,
    )
    expect(debt).toBe('none')
  })
})
