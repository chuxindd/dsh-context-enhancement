import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskStateStable } from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import { TaskStateWorker } from '../src/internal/task-state/basic/worker.ts'
import type { WorkerEnvironment } from '../src/internal/task-state/basic/worker.ts'
import { filterEvent, isEligibleType } from '../src/internal/task-state/basic/filter.ts'

/** The model's stable-producing JSON output (no evidence: seqs are batch-specific). */
const MODEL_JSON = JSON.stringify({
  facts: [{ content: 'the provider commits atomically' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [],
  todoReferences: [],
  continuation: {
    currentObjective: 'land the state provider',
    currentFocus: 'running the worker tests',
    openWork: ['close the review'],
    nextActions: ['run the gates'],
  },
})

/** Adapter replaying one valid task-state JSON text block per request. */
class TaskStateAdapter extends LlmAdapter {
  constructor(private readonly delayMs = 0) {
    super()
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, this.delayMs))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: MODEL_JSON }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: MODEL_JSON } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Adapter that always fails every stream with a non-infrastructure error. */
class FailingAdapter extends LlmAdapter {
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '{"broken":' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"broken":' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const CONFIG = {
  provider: 'current-route',
  model: 'current-model',
  minEvents: 1,
  maxEvents: 10,
  maxInputBytes: 100_000,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 2_000,
  maxListItems: 8,
} satisfies TaskStateBasicConfig

/** In-memory environment backed by a real Session store and scripted LLM. */
interface FakeWorkerEnv extends WorkerEnvironment {
  stored: TaskStateStable[]
  requests: number
  finished: number
  repairs: number
  dead: boolean
  failFinished: boolean
}

function fakeEnv(ctx: Context): FakeWorkerEnv {
  const state: FakeWorkerEnv = {
    stored: [],
    requests: 0,
    finished: 0,
    repairs: 0,
    dead: false,
    failFinished: false,
    system: 'update the task state',
    resolveRoute: () => ({ provider: 'current-route', model: 'current-model' }),
    liveSession: (id: SessionId) => (state.dead ? undefined : ctx.sessions.get(id)),
    committedCursor: () => state.stored.length === 0 ? -1 : state.stored[state.stored.length - 1]!.sourceCursor,
    readBase: () => state.stored.length === 0 ? null : state.stored[state.stored.length - 1]!,
    eligibleCount: (id: SessionId) => {
      const live = ctx.sessions.get(id)
      if (live === undefined) return 0
      const cursor = state.stored.length === 0 ? -1 : state.stored[state.stored.length - 1]!.sourceCursor
      let count = 0
      for (const event of live.snapshotEvents()) {
        if (event.seq <= cursor) continue
        if (!isEligibleType(event.type)) continue
        if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) continue
        count += 1
      }
      return count
    },
    frame: (_id, base, window) => JSON.stringify({ base, events: window.events }),
    putOpenAudit: async (_id: SessionId, _data: Parameters<WorkerEnvironment['putOpenAudit']>[1]) => { state.requests += 1 },
    putFinishedAudit: async (_id: SessionId, _finished: Parameters<WorkerEnvironment['putFinishedAudit']>[1]) => {
      if (state.failFinished) throw new Error('finished audit put rejected')
      state.finished += 1
    },
    putStable: async (_id, stable) => { state.stored.push(stable) },
    // This fake owns no durable record, so it reports the terminal write as
    // REFUSED. That is the honest answer a provider without a durable record
    // must give, and the worker's infeasible path must handle it without
    // claiming a verdict it does not have.
    putTerminal: async (_id, _terminal) => false,
    // A fake without durable records holds no verdict cursor and no block: the
    // committed cursor is the in-memory stable's, and nothing is ever blocked.
    cursorFloor: () => state.stored.length === 0 ? -1 : state.stored[state.stored.length - 1]!.sourceCursor,
    activeBlock: () => undefined,
    onCommitted: () => { /* pointer is the same in-memory row in this fake */ },
    scheduleAuditRepair: async () => { state.repairs += 1 },
  }
  state.repairs = 0
  return state
}

async function setup(adapterDelayMs = 0): Promise<{
  ctx: Context
  session: Session
  env: FakeWorkerEnv
  worker: TaskStateWorker
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], new TaskStateAdapter(adapterDelayMs))
  const session = ctx.sessions.create(SessionId(`worker-spec-${Math.random().toString(16).slice(2)}`))
  const env = fakeEnv(ctx)
  const worker = new TaskStateWorker(ctx, session, CONFIG, env)
  return { ctx, session, env, worker }
}

/** Setup with one arbitrary adapter instance. */
async function setupWith(adapter: LlmAdapter): Promise<{
  ctx: Context
  session: Session
  env: FakeWorkerEnv
  worker: TaskStateWorker
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], adapter)
  const session = ctx.sessions.create(SessionId(`worker-spec-${Math.random().toString(16).slice(2)}`))
  const env = fakeEnv(ctx)
  const worker = new TaskStateWorker(ctx, session, CONFIG, env)
  return { ctx, session, env, worker }
}

/** Append a direct human user/message and return its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

describe('task-state-basic worker', () => {
  it('serializes an external mutation behind the admitted batch', async () => {
    const { session, env, worker } = await setup(60)
    const seq = appendUser(session, 'batch before edit')
    worker.observe(seq)
    worker.maybeSchedule()
    const order: string[] = []
    const mutation = worker.enqueueMutation(async () => { order.push('edit') })
    await waitUntil(() => env.stored.length === 1, 2_000)
    order.unshift('batch')
    await mutation
    expect(order).toEqual(['batch', 'edit'])
    await worker.dispose()
    await expect(worker.enqueueMutation(async () => {})).rejects.toThrow('task-state-basic/session-disposed')
  })

  it('commits a batch when the eligible watermark passes the threshold', async () => {
    const { session, env, worker } = await setup()
    const seq = appendUser(session, 'first prompt')
    worker.observe(seq)
    worker.maybeSchedule()
    await waitUntil(() => env.stored.length === 1, 2_000)
    expect(env.stored.length).toBe(1)
    expect(env.stored[0]!.revision).toBe(1)
    expect(env.stored[0]!.sourceCursor).toBe(seq)
    expect(env.requests).toBe(1)
    expect(env.finished).toBe(1)
    await worker.dispose()
  })

  it('runs one trailing batch for events arriving after a commit', async () => {
    const { session, env, worker } = await setup()
    const seq1 = appendUser(session, 'first')
    worker.observe(seq1)
    worker.maybeSchedule()
    await waitUntil(() => env.stored.length === 1, 2_000)
    const seq2 = appendUser(session, 'second')
    worker.observe(seq2)
    worker.maybeSchedule()
    await waitUntil(() => env.stored.length === 2, 2_000)
    expect(env.stored[1]!.revision).toBe(2)
    expect(env.stored[1]!.sourceCursor).toBe(seq2)
    await worker.dispose()
  })

  it('runs one trailing batch for events arriving during a request, then stops', async () => {
    const { session, env, worker } = await setup(60)
    const seq1 = appendUser(session, 'first')
    worker.observe(seq1)
    worker.maybeSchedule()
    const seq2 = appendUser(session, 'second')
    worker.observe(seq2)
    worker.maybeSchedule()
    const seq3 = appendUser(session, 'third')
    worker.observe(seq3)
    worker.maybeSchedule()
    await waitUntil(() => env.stored.length === 2, 3_000)
    expect(env.stored[0]!.revision).toBe(1)
    expect(env.stored[1]!.revision).toBe(2)
    await delay(150)
    expect(env.stored.length).toBe(2)
    await worker.dispose()
  })

  it('stops scheduling after disposal and never commits late', async () => {
    const { session, env, worker } = await setup()
    env.dead = true
    await worker.dispose()
    const seq = appendUser(session, 'late')
    worker.observe(seq)
    worker.maybeSchedule()
    await delay(80)
    expect(env.stored.length).toBe(0)
  })

  it('never auto-runs a second attempt of the same window after a failure', async () => {
    const { session, env, worker } = await setupWith(new FailingAdapter())
    const seq = appendUser(session, 'deterministic failure')
    worker.observe(seq)
    worker.maybeSchedule()
    await waitUntil(() => env.requests >= 1, 2_000)
    await delay(150)
    expect(env.requests).toBe(1)
    expect(env.stored.length).toBe(0)
    const seq2 = appendUser(session, 'second')
    worker.observe(seq2)
    worker.maybeSchedule()
    await waitUntil(() => env.requests >= 2, 2_000)
    expect(env.stored.length).toBe(0)
    await worker.dispose()
  })

  it('converges to the live eligible tail under sustained arrival', async () => {
    const adapter = new TaskStateAdapter(25)
    const { session, env, worker } = await setupWith(adapter)
    for (let i = 0; i < 6; i += 1) {
      const seq = appendUser(session, `sustained ${i}`)
      worker.observe(seq)
      worker.maybeSchedule()
      await delay(15)
    }
    await waitUntil(() => {
      const stored = env.stored
      const events = session.snapshotEvents()
      const tail = events[events.length - 1]
      return stored.length > 0 && tail !== undefined && stored[stored.length - 1]!.sourceCursor === tail.seq
    }, 6_000)
    const events = session.snapshotEvents()
    const tail = events[events.length - 1]
    expect(env.stored[env.stored.length - 1]!.sourceCursor).toBe(tail?.seq)
    await worker.dispose()
  })

  it('arranges an audit repair when a successful put leaves an audit gap', async () => {
    const { session, env, worker } = await setupWith(new TaskStateAdapter(0))
    env.failFinished = true
    const seq = appendUser(session, 'commit but no audit')
    worker.observe(seq)
    worker.maybeSchedule()
    await waitUntil(() => env.stored.length === 1, 2_000)
    await waitUntil(() => env.repairs >= 1, 2_000)
    expect(env.stored.length).toBe(1)
    expect(env.stored[0]!.sourceCursor).toBe(seq)
    expect(env.repairs).toBe(1)
    env.failFinished = false
    await worker.dispose()
  })
})

/** Poll one predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('worker did not settle in time')
    await delay(5)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
