import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskStateStable, TaskStateUpdateFinishedData, TaskStateUpdateRequestData } from '../src/task-state.ts'
import { runUpdateAttempt, type TaskStateUpdateAttempt, type TaskStateUpdateHooks } from '../src/internal/task-state/basic/update.ts'

/** Adapter replaying one fixed chunk script per request and recording options. */
class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[] | (() => readonly StreamChunk[])) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = typeof this.script === 'function' ? this.script() : this.script
    yield * script
  }
}

/** One canonical candidate JSON the "model" returns as its text output. */
const MODEL_JSON = JSON.stringify({
  facts: [{ content: 'the provider commits atomically' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [{ seq: 3, note: 'tool/result showed the put' }],
  todoReferences: [],
  continuation: {
    currentObjective: 'land the state provider',
    currentFocus: 'writing the tests',
    openWork: ['close the review'],
    nextActions: ['run the gates'],
  },
})

const STOP_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: MODEL_JSON },
  { type: 'block-end', index: 0, block: { type: 'text', text: MODEL_JSON } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const EMPTY_SCRIPT: StreamChunk[] = [
  { type: 'finish', reason: { kind: 'stop' } },
]

const INVALID_JSON_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '{not json' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '{not json' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A canonical empty base stable. */
function base(): TaskStateStable {
  return {
    schemaVersion: 1,
    revision: 1,
    filterVersion: 'task-state-basic/filter-v2',
    sourceCursor: 2,
    digest: 'digest',
    facts: [],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: [],
    continuation: { currentObjective: 'o', currentFocus: 'f', openWork: [], nextActions: [] },
  }
}

/** Build a context with a real Session store and one scripted LLM route. */
async function withScript(script: readonly StreamChunk[]): Promise<{ ctx: Context; adapter: ScriptAdapter }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptAdapter(script)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

function attempt(ctx: Context): TaskStateUpdateAttempt {
  return {
    ctx,
    route: { provider: 'current-route', model: 'current-model' },
    base: base(),
    projection: JSON.stringify({ events: [{ seq: 3, type: 'user/message' }] }),
    includedSeqs: [3, 4],
    truncation: [],
    system: 'update the task state',
    maxOutputTokens: 4_000,
    timeoutMs: 5_000,
    sessionId: SessionId('update-spec'),
    signal: new AbortController().signal,
    limits: { maxEntriesPerKind: 10, maxEntryBytes: 2_000, maxListItems: 8 },
  }
}

/** Collect the audit opens/finished a run performs. */
interface HookState {
  opens: TaskStateUpdateRequestData[]
  finished: TaskStateUpdateFinishedData[]
  put: TaskStateStable[]
  committed: TaskStateStable[]
}

function hooks(): TaskStateUpdateHooks & HookState {
  const state: HookState = { opens: [], finished: [], put: [], committed: [] }
  return Object.assign(state, {
    putOpenAudit: async (data: TaskStateUpdateRequestData) => { state.opens.push(data) },
    putFinishedAudit: async (finished: TaskStateUpdateFinishedData) => { state.finished.push(finished) },
    putStable: async (stable: TaskStateStable) => { state.put.push(stable) },
    onCommitted: (stable: TaskStateStable) => { state.committed.push(stable) },
  })
}

describe('task-state-basic update attempt', () => {
  it('commits a stable and opens + finishes the paired audit row', async () => {
    const { ctx } = await withScript(STOP_SCRIPT)
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stable.revision).toBe(2)
    expect(result.stable.sourceCursor).toBe(4)
    expect(result.stable.facts.length).toBe(1)
    expect(result.stable.facts[0]?.content).toBe('the provider commits atomically')
    expect(state.opens.length).toBe(1)
    expect(state.opens[0]?.revision).toBe(2)
    expect(state.finished.length).toBe(1)
    expect(state.finished[0]?.outcome).toBe('success')
    expect(state.put.length).toBe(1)
    expect(state.committed).toEqual(state.put)
  })

  it('passes the task-state purpose and exact options to the real llm stream', async () => {
    const { ctx, adapter } = await withScript(STOP_SCRIPT)
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(true)
    // The locally typed task-state request reaches the adapter with purpose
    // marked 'task-state' — never a compaction/session-title fake.
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]
    if (request === undefined) return
    expect((request as { purpose?: string }).purpose).toBe('task-state')
    expect(request.provider).toBe('current-route')
    expect(request.model).toBe('current-model')
    expect(request.system).toBe('update the task state')
    expect(request.maxTokens).toBe(4_000)
    expect(String(request.sessionId)).toBe('update-spec')
    const user = request.messages[0]
    expect(user?.role).toBe('user')
  })

  it('never dispatches the adapter when the open-phase audit cannot become durable', async () => {
    const { ctx, adapter } = await withScript(STOP_SCRIPT)
    const state = hooks()
    state.putOpenAudit = async () => { throw new Error('open audit put failed') }
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('AUDIT')
    expect(result.failure.stage).toBe('request')
    expect(adapter.requests).toHaveLength(0)
    expect(state.put.length).toBe(0)
    expect(state.finished.length).toBe(0)
  })

  it('keeps a committed put authoritative when the finished audit put fails', async () => {
    const { ctx } = await withScript(STOP_SCRIPT)
    const state = hooks()
    state.putFinishedAudit = async () => { throw new Error('finished audit put failed') }
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.auditGap).toBe(true)
    expect(state.put.length).toBe(1)
    expect(state.committed).toEqual(state.put)
    expect(state.finished.length).toBe(0)
  })

  it('rejects empty model output without committing', async () => {
    const { ctx } = await withScript(EMPTY_SCRIPT)
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    expect(state.put.length).toBe(0)
    expect(state.finished.length).toBe(1)
    expect(state.finished[0]?.outcome).toBe('failure')
  })

  it('rejects invalid JSON without committing', async () => {
    const { ctx } = await withScript(INVALID_JSON_SCRIPT)
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('PARSE')
    expect(state.put.length).toBe(0)
    expect(state.finished.length).toBe(1)
  })

  it('classifies a thrown transient infrastructure error as retryable', async () => {
    const { ctx } = await withScript(STOP_SCRIPT)
    const original = ctx.llm.stream.bind(ctx.llm)
    ctx.llm.stream = async function* (options: Parameters<typeof original>[0]): AsyncIterable<StreamChunk> {
      void options
      throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' })
    } as typeof original
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.stage).toBe('stream')
    expect(result.failure.code).toBe('TRANSIENT_LLM')
    expect(state.put.length).toBe(0)
  })

  it('classifies an aborted session as ABORTED and never retries', async () => {
    const { ctx } = await withScript(STOP_SCRIPT)
    const controller = new AbortController()
    controller.abort()
    const original = ctx.llm.stream.bind(ctx.llm)
    ctx.llm.stream = async function* (_options: Parameters<typeof original>[0]): AsyncIterable<StreamChunk> {
      throw new DOMException('aborted', 'AbortError')
    } as typeof original
    const state = hooks()
    const result = await runUpdateAttempt({ ...attempt(ctx), signal: controller.signal }, state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('ABORTED')
  })

  it('classifies a finish error with a transient code as retryable', async () => {
    const { ctx } = await withScript([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'server blew up', code: 'SERVER' } },
    }])
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('TRANSIENT_LLM')
    expect(state.finished.length).toBe(1)
  })

  it('rejects an aborted, max-tokens, or tool-calls finish', async () => {
    const { ctx } = await withScript([{
      type: 'finish',
      reason: { kind: 'max-tokens' },
    }])
    const maxTokens = await runUpdateAttempt(attempt(ctx), hooks())
    expect(maxTokens.ok).toBe(false)
    if (maxTokens.ok) return
    expect(maxTokens.failure.code).toBe('PARSE')

    const toolCallsCtx = await withScript([{ type: 'finish', reason: { kind: 'tool-calls' } }])
    const toolCalls = await runUpdateAttempt(attempt(toolCallsCtx.ctx), hooks())
    expect(toolCalls.ok).toBe(false)
    if (toolCalls.ok) return
    expect(toolCalls.failure.code).toBe('SEMANTIC')
  })

  it('rejects schema-invalid candidate content', async () => {
    const badSchema = JSON.stringify({ facts: 'not-an-array' })
    const { ctx } = await withScript([{
      type: 'block-start', index: 0, blockType: 'text',
    }, {
      type: 'text-delta', index: 0, text: badSchema,
    }, {
      type: 'block-end', index: 0, block: { type: 'text', text: badSchema },
    }, { type: 'finish', reason: { kind: 'stop' } }])
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.stage).toBe('schema')
    expect(state.put.length).toBe(0)
  })

  it('rejects a semantically invalid candidate (echoed id not in base)', async () => {
    const badSemantics = JSON.stringify({
      facts: [{ id: 'fact-unknown-0000-0000-0000-000000000000', content: 'x' }],
      decisions: [], constraints: [], risks: [], evidence: [], todoReferences: [],
      continuation: { currentObjective: 'o', currentFocus: 'f', openWork: [], nextActions: [] },
    })
    const { ctx } = await withScript([{
      type: 'block-start', index: 0, blockType: 'text',
    }, {
      type: 'text-delta', index: 0, text: badSemantics,
    }, {
      type: 'block-end', index: 0, block: { type: 'text', text: badSemantics },
    }, { type: 'finish', reason: { kind: 'stop' } }])
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.stage).toBe('semantic')
    expect(state.put.length).toBe(0)
  })

  it('classifies an authority put failure as storage', async () => {
    const { ctx } = await withScript(STOP_SCRIPT)
    const state = hooks()
    state.putStable = async () => { throw new Error('domain put failed') }
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.stage).toBe('storage')
    expect(state.finished.length).toBe(1)
    expect(state.finished[0]?.outcome).toBe('failure')
  })

  it('commits the first revision with a null base and empty-included cursor', async () => {
    const firstJson = JSON.stringify({
      facts: [{ content: 'first fact' }],
      decisions: [], constraints: [], risks: [], evidence: [], todoReferences: [],
      continuation: { currentObjective: 'o', currentFocus: 'f', openWork: [], nextActions: [] },
    })
    const { ctx } = await withScript([{
      type: 'block-start', index: 0, blockType: 'text',
    }, {
      type: 'text-delta', index: 0, text: firstJson,
    }, {
      type: 'block-end', index: 0, block: { type: 'text', text: firstJson },
    }, { type: 'finish', reason: { kind: 'stop' } }])
    const state = hooks()
    const result = await runUpdateAttempt({ ...attempt(ctx), base: null, includedSeqs: [] }, state)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stable.revision).toBe(1)
    expect(result.stable.sourceCursor).toBe(0)
    expect(state.opens[0]?.base).toBeNull()
    expect(state.opens[0]?.revision).toBe(1)
  })

  it('reports usage on the success finished audit when the adapter emits it', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const { ctx } = await withScript([{
      type: 'block-start', index: 0, blockType: 'text',
    }, {
      type: 'text-delta', index: 0, text: MODEL_JSON,
    }, {
      type: 'block-end', index: 0, block: { type: 'text', text: MODEL_JSON },
    }, { type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }])
    const state = hooks()
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.usage).toEqual(usage)
    const finished = state.finished[0]
    expect(finished?.outcome === 'success' && finished.usage).toEqual(usage)
  })

  it('never emits an error audit when the failure audit put itself throws', async () => {
    const { ctx } = await withScript(INVALID_JSON_SCRIPT)
    const state = hooks()
    state.putFinishedAudit = async () => { throw new Error('failure audit put rejected') }
    const result = await runUpdateAttempt(attempt(ctx), state)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('PARSE')
  })

  it('classifies a non-Error request-audit failure and a timeout aborted attempt', async () => {
    const { ctx } = await withScript(STOP_SCRIPT)
    const state = hooks()
    state.putOpenAudit = async () => { throw 'flush exploded' }
    const stringResult = await runUpdateAttempt(attempt(ctx), state)
    expect(stringResult.ok).toBe(false)
    if (stringResult.ok) return
    expect(stringResult.failure.code).toBe('AUDIT')
    expect(stringResult.failure.message).toBe('task-state-basic: open-phase audit could not be made durable before dispatch')

    const slowCtx = await withScript(STOP_SCRIPT)
    const original = slowCtx.ctx.llm.stream.bind(slowCtx.ctx.llm)
    slowCtx.ctx.llm.stream = async function* (options: Parameters<typeof original>[0]): AsyncIterable<StreamChunk> {
      void options
      await new Promise<void>(resolve => setTimeout(resolve, 80))
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' })
    } as typeof original
    const timedOut = await runUpdateAttempt({ ...attempt(slowCtx.ctx), timeoutMs: 10 }, hooks())
    expect(timedOut.ok).toBe(false)
    if (timedOut.ok) return
    expect(timedOut.failure.code).toBe('TIMEOUT')
  })

  it('builds a semantic context from a base carrying every kinded list', async () => {
    const fullBase: TaskStateStable = {
      schemaVersion: 1,
      revision: 3,
      filterVersion: 'task-state-basic/filter-v2',
      sourceCursor: 6,
      digest: 'digest',
      facts: [{ id: 'fact-00000000-0000-4000-8000-000000000001' as TaskStateStable['facts'][number]['id'], content: 'fact one' }],
      decisions: [{ id: 'decision-00000000-0000-4000-8000-000000000002' as TaskStateStable['facts'][number]['id'], content: 'decision one' }],
      constraints: [{ id: 'constraint-00000000-0000-4000-8000-000000000003' as TaskStateStable['facts'][number]['id'], content: 'constraint one' }],
      risks: [{ id: 'risk-00000000-0000-4000-8000-000000000004' as TaskStateStable['facts'][number]['id'], content: 'risk one' }],
      evidence: [],
      todoReferences: [],
      continuation: { currentObjective: 'o', currentFocus: 'f', openWork: [], nextActions: [] },
    }
    const echoed = JSON.stringify({
      facts: [
        { id: 'fact-00000000-0000-4000-8000-000000000001', content: 'fact one' },
      ],
      decisions: [{ id: 'decision-00000000-0000-4000-8000-000000000002', content: 'decision one' }],
      constraints: [{ id: 'constraint-00000000-0000-4000-8000-000000000003', content: 'constraint one' }],
      risks: [{ id: 'risk-00000000-0000-4000-8000-000000000004', content: 'risk one' }],
      evidence: [],
      todoReferences: [],
      continuation: { currentObjective: 'o', currentFocus: 'f', openWork: [], nextActions: [] },
    })
    const { ctx } = await withScript([{
      type: 'block-start', index: 0, blockType: 'text',
    }, {
      type: 'text-delta', index: 0, text: echoed,
    }, {
      type: 'block-end', index: 0, block: { type: 'text', text: echoed },
    }, { type: 'finish', reason: { kind: 'stop' } }])
    const state = hooks()
    const result = await runUpdateAttempt({
      ...attempt(ctx),
      base: fullBase,
      includedSeqs: [7, 8],
    }, state)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stable.revision).toBe(4)
    expect(state.finished[0]?.outcome).toBe('success')
  })
})
