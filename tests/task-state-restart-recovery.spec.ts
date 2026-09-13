import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../src/task-state-basic.ts'
import TaskStateControlService from '../src/task-state-control.ts'
import type { TaskStateStable } from '../src/task-state.ts'

/**
 * Restart-recovery composition: a REAL storage hub + JSON backend + domain
 * facility and a REAL session store, driving the exact baseline/hydration
 * contract the Context Enhancement view depends on. The persisted stable must
 * appear in the first control baseline of a live Session, and a stream whose
 * baseline was read before the provider seeded its runtime (the restart race)
 * must be hydrated by the recovered-stable publication instead of staying
 * empty forever.
 */

/** Deterministic model JSON the scripted adapter replays as its text output. */
const MODEL_JSON = JSON.stringify({
  facts: [{ content: 'the recovered record serves the summary view again' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [],
  todoReferences: [],
  continuation: {
    currentObjective: 'survive the restart',
    currentFocus: 'proving baseline hydration',
    openWork: [],
    nextActions: [],
  },
})

/** Scripted adapter returning one fixed valid task-state JSON text block. */
class TaskStateAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: MODEL_JSON }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: MODEL_JSON } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const BASIC_CONFIG = {
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
}

/**
 * JSON backend holding the task-state domain's `kv.open` at a gate so a test
 * can open a control stream while TaskStateBasicService init is still parked
 * inside the domain open — the exact restart-race window.
 */
class GatedTaskStateBackend implements StorageBackend {
  private readonly inner: JsonStorageBackend
  private hold = true
  private releaseGate: (() => void) | undefined
  private enteredResolve!: () => void
  private readonly enteredPromise: Promise<void>

  constructor(storageRoot: string) {
    this.inner = new JsonStorageBackend(storageRoot)
    this.enteredPromise = new Promise<void>(resolve => {
      this.enteredResolve = resolve
    })
  }

  /** Resolves once the task-state domain open is parked on the gate. */
  get entered(): Promise<void> {
    return this.enteredPromise
  }

  readonly kv = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (descriptor.name === 'context_enhancement_task_state_v2' && this.hold) {
        this.enteredResolve()
        await new Promise<void>(resolve => { this.releaseGate = resolve })
      }
      return this.inner.kv.open(descriptor)
    },
  }

  release(): void {
    this.hold = false
    this.releaseGate?.()
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

const contexts: Context[] = []

let root: string | undefined

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch(() => {})
  }
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

/** Mount sessions + real storage (optionally gated) + llm, without task-state. */
async function mountBase(
  sessionSubroot: string,
  gate?: GatedTaskStateBackend,
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root as string, sessionSubroot),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  if (gate === undefined) {
    await ctx.plugin(StorageJson, { root: join(root as string, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  } else {
    await ctx.plugin(StorageJson, { root: join(root as string, 'storage') })
    const key = storageBackendServiceKey('gated-json')
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register('gated-json', gate)
      return async () => {
        unregister()
        await gate.close()
      }
    })
    ctx.provide(key, gate)
    await ctx.plugin(StorageDomain, { backend: 'gated-json' })
  }
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['current-route'], new TaskStateAdapter())
  return ctx
}

/** Mount the full composition: base plugins plus the awaited task-state provider. */
async function mountComposition(sessionSubroot = 'sessions'): Promise<Context> {
  const ctx = await mountBase(sessionSubroot)
  await ctx.plugin(TaskStateBasicService, BASIC_CONFIG)
  return ctx
}

/** Append one direct human user/message and return its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Poll one predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('restart-recovery composition did not settle in time')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Open one control-stream generation and return its iterator. */
function openStream(control: TaskStateControlService): {
  iterator: AsyncIterator<unknown, unknown, unknown>
  abort: () => void
} {
  const controller = new AbortController()
  const stream = control.control(controller.signal)
  return {
    iterator: stream[Symbol.asyncIterator](),
    abort: () => controller.abort(),
  }
}

/** Read the opening baseline frame of one generation. */
async function readBaseline(iterator: AsyncIterator<unknown, unknown, unknown>): Promise<Record<string, TaskStateStable | null>> {
  const frame = await iterator.next() as {
    done: false
    value: { type: 'baseline'; value: { items: Record<string, TaskStateStable | null> } }
  }
  expect(frame.done).toBe(false)
  expect(frame.value.type).toBe('baseline')
  return frame.value.value.items
}

describe('task-state restart recovery (baseline/hydration contract)', () => {
  it('serves a persisted lifecycle-matching stable in the first control baseline after restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-baseline-'))
    const createdAtThree = 1_700_000_000_000
    const createdAtFour = 1_700_000_060_000
    const first = await mountComposition('restart-sessions-1')
    const three = first.sessions.create(SessionId('restart-three'), { meta: { cwd: root, createdAt: createdAtThree } })
    const seqThree = appendUser(three, 'the (3) session summary')
    await waitUntil(() => first.taskState.getStable(three.id) !== undefined, 3_000)
    const four = first.sessions.create(SessionId('restart-four'), { meta: { cwd: root, createdAt: createdAtFour } })
    appendUser(four, 'the (4) session summary, first event')
    const seqFour = appendUser(four, 'the (4) session summary, second event')
    await waitUntil(() => first.taskState.getStable(four.id) !== undefined, 3_000)
    const storedThree = first.taskState.getStable(three.id)
    const storedFour = first.taskState.getStable(four.id)
    expect(storedThree).toBeDefined()
    expect(storedFour).toBeDefined()
    // Session seq spaces are per-session, so give (4) a higher committed
    // cursor than (3): the two stables must be distinguishable for the
    // strict-mapping assertions below.
    expect(storedThree?.sourceCursor).toBe(seqThree)
    expect(storedFour?.sourceCursor).toBe(seqFour)
    expect(storedThree).not.toEqual(storedFour)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // Restart: both sessions resume with their own identity; the control
    // baseline must map each Session id to ITS OWN durable stable — never
    // another session's — without any model call.
    const second = await mountComposition('restart-sessions-2')
    const resumedThree = second.sessions.create(SessionId('restart-three'), { meta: { cwd: root, createdAt: createdAtThree } })
    const resumedFour = second.sessions.create(SessionId('restart-four'), { meta: { cwd: root, createdAt: createdAtFour } })
    expect(second.taskState.getStable(resumedThree.id)).toEqual(storedThree)
    expect(second.taskState.getStable(resumedFour.id)).toEqual(storedFour)

    const control = new TaskStateControlService(second)
    const firstGeneration = openStream(control)
    const items = await readBaseline(firstGeneration.iterator)
    expect(items[String(resumedThree.id)]).toEqual(storedThree)
    expect(items[String(resumedThree.id)]).not.toEqual(storedFour)
    expect(items[String(resumedFour.id)]).toEqual(storedFour)
    expect(items[String(resumedThree.id)]?.sourceCursor).toBe(seqThree)
    expect(items[String(resumedFour.id)]?.sourceCursor).toBe(seqFour)
    firstGeneration.abort()
    expect(await firstGeneration.iterator.next()).toMatchObject({ done: true })

    // A reconnect (fresh generation) re-serves the same recovered stables, so
    // a client retry reconciles instead of losing the summary.
    const secondGeneration = openStream(control)
    const reconnected = await readBaseline(secondGeneration.iterator)
    expect(reconnected[String(resumedThree.id)]).toEqual(storedThree)
    expect(reconnected[String(resumedFour.id)]).toEqual(storedFour)
    secondGeneration.abort()
    expect(await secondGeneration.iterator.next()).toMatchObject({ done: true })
  })

  it('hydrates an already-open control stream when the persisted stable is seeded after its baseline', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-race-'))
    const createdAt = 1_700_000_000_000
    const first = await mountComposition('race-sessions-1')
    const original = first.sessions.create(SessionId('race-recovery'), { meta: { cwd: root, createdAt } })
    appendUser(original, 'create the durable record before the restart')
    await waitUntil(() => first.taskState.getStable(original.id) !== undefined, 3_000)
    const stored = first.taskState.getStable(original.id)
    expect(stored).toBeDefined()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // Second mount with the domain open held at a gate: the provider is
    // constructed (ctx.taskState resolves) while its init is still parked, so
    // a control stream opened NOW reads its baseline before the seed — the
    // restart race the Context Enhancement view lost to.
    const gate = new GatedTaskStateBackend(join(root, 'storage'))
    const second = await mountBase('race-sessions-2', gate)
    const pending = second.plugin(TaskStateBasicService, BASIC_CONFIG)
    await gate.entered
    const resumed = second.sessions.create(SessionId('race-recovery'), { meta: { cwd: root, createdAt } })
    expect(second.taskState.getStable(resumed.id)).toBeUndefined()

    const control = new TaskStateControlService(second)
    const generation = openStream(control)
    const items = await readBaseline(generation.iterator)
    // The provider has not seeded yet: the live Session is reported with none.
    expect(items[String(resumed.id)]).toBeNull()

    gate.release()
    await pending
    // The recovered stable must reach the already-open stream as an update.
    const update = await generation.iterator.next() as {
      done: false
      value: { type: 'update'; value: { sessionId: SessionId; stable: TaskStateStable | null } }
    }
    expect(update.done).toBe(false)
    expect(update.value.type).toBe('update')
    expect(update.value.value.sessionId).toBe(resumed.id)
    expect(update.value.value.stable).toEqual(stored)
    // And the synchronous read now serves the recovered stable too.
    expect(second.taskState.getStable(resumed.id)).toEqual(stored)
    generation.abort()
    expect(await generation.iterator.next()).toMatchObject({ done: true })
  })

  it('never serves a stored stable to a different lifecycle or session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-strict-'))
    const createdAt = 1_700_000_000_000
    const first = await mountComposition('strict-sessions-1')
    const original = first.sessions.create(SessionId('strict-session'), { meta: { cwd: root, createdAt } })
    appendUser(original, 'durable record for exactly one lifecycle')
    await waitUntil(() => first.taskState.getStable(original.id) !== undefined, 3_000)
    const stored = first.taskState.getStable(original.id)
    expect(stored).toBeDefined()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // A resumed session whose lifecycle identity does NOT match the stored
    // record never receives it: same id, different createdAt.
    const second = await mountComposition('strict-sessions-2')
    const otherLifecycle = second.sessions.create(SessionId('strict-session'), {
      meta: { cwd: root, createdAt: createdAt + 1 },
    })
    expect(second.taskState.getStable(otherLifecycle.id)).toBeUndefined()
    // A different session id with the SAME lifecycle identity also never
    // receives another session's summary.
    const otherSession = second.sessions.create(SessionId('strict-other'), { meta: { cwd: root, createdAt } })
    expect(second.taskState.getStable(otherSession.id)).toBeUndefined()

    const control = new TaskStateControlService(second)
    const generation = openStream(control)
    const items = await readBaseline(generation.iterator)
    expect(items[String(otherLifecycle.id)]).toBeNull()
    expect(items[String(otherSession.id)]).toBeNull()
    expect(items[String(SessionId('strict-session'))]).toBeNull()
    expect(Object.values(items).some(value => value !== null)).toBe(false)

    // No recovered-stable publication ever fires for a mismatched lifecycle.
    const committed: SessionId[] = []
    const provider = second.get('taskState') as TaskStateBasicService
    const dispose = provider.subscribeCommitted((id) => { committed.push(id) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(committed).toEqual([])
    dispose()
    generation.abort()
    expect(await generation.iterator.next()).toMatchObject({ done: true })
  })

  it('does not publish or create runtime for a session disposed before domain open completes', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-disposed-during-open-'))
    const createdAtDisposed = 1_700_000_000_000
    const createdAtLive = 1_700_000_060_000
    const first = await mountComposition('disposed-open-sessions-1')
    const disposedOriginal = first.sessions.create(SessionId('disposed-race'), {
      meta: { cwd: root, createdAt: createdAtDisposed },
    })
    appendUser(disposedOriginal, 'persisted stable for session disposed during open')
    await waitUntil(() => first.taskState.getStable(disposedOriginal.id) !== undefined, 3_000)
    const storedDisposed = first.taskState.getStable(disposedOriginal.id)
    expect(storedDisposed).toBeDefined()

    const liveOriginal = first.sessions.create(SessionId('live-surviving'), {
      meta: { cwd: root, createdAt: createdAtLive },
    })
    appendUser(liveOriginal, 'persisted stable for surviving session')
    await waitUntil(() => first.taskState.getStable(liveOriginal.id) !== undefined, 3_000)
    const storedLive = first.taskState.getStable(liveOriginal.id)
    expect(storedLive).toBeDefined()

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // Mount second instance with the domain open held at a gate
    const gate = new GatedTaskStateBackend(join(root, 'storage'))
    const second = await mountBase('disposed-open-sessions-2', gate)

    let providerInstance: TaskStateBasicService | undefined
    class TrackedTaskStateBasicService extends TaskStateBasicService {
      constructor(ctx: Context, config: typeof BASIC_CONFIG) {
        super(ctx, config)
        providerInstance = this
      }
    }

    const pending = second.plugin(TrackedTaskStateBasicService, BASIC_CONFIG)
    await gate.entered

    try {
      // Provider instance is constructed; subscribe before domain open and startup seeding run
      const committed: { id: SessionId; stable: TaskStateStable }[] = []
      expect(providerInstance).toBeDefined()
      const disposeCommitted = providerInstance!.subscribeCommitted((id, stable) => {
        committed.push({ id, stable })
      })

      // Prepare and enter the session that will be disposed during open
      const resumedDisposed = second.sessions.prepare(SessionId('disposed-race'), {
        meta: { cwd: root, createdAt: createdAtDisposed },
      })
      const detachDisposed = second.sessions.enter(resumedDisposed)
      second.sessions.announce(resumedDisposed)

      // Also prepare and enter the surviving session
      const resumedLive = second.sessions.create(SessionId('live-surviving'), {
        meta: { cwd: root, createdAt: createdAtLive },
      })

      // Open control stream while domain is still parked
      const control = new TaskStateControlService(second)
      const generation = openStream(control)
      const baseline = await readBaseline(generation.iterator)
      expect(baseline[String(resumedDisposed.id)]).toBeNull()
      expect(baseline[String(resumedLive.id)]).toBeNull()

      // Dispose resumedDisposed before domain open completes
      detachDisposed()
      expect(second.sessions.get(resumedDisposed.id)).toBeUndefined()
      expect(second.sessions.get(resumedLive.id)).toBe(resumedLive)

      // Release the gate so domain open finishes and startup seeding runs
      gate.release()
      await pending

      // The surviving live session recovers its persisted stable exactly once
      const update = await generation.iterator.next() as {
        done: false
        value: { type: 'update'; value: { sessionId: SessionId; stable: TaskStateStable | null } }
      }
      expect(update.done).toBe(false)
      expect(update.value.type).toBe('update')
      expect(update.value.value.sessionId).toBe(resumedLive.id)
      expect(update.value.value.stable).toEqual(storedLive)

      // Assert no stable publication occurred for the disposed session
      expect(committed.map(item => item.id)).toEqual([resumedLive.id])
      expect(second.taskState.getStable(resumedDisposed.id)).toBeUndefined()
      expect(second.taskState.getStable(resumedLive.id)).toEqual(storedLive)

      // Assert no surviving runtime behavior / ghost worker for the disposed session
      const runtimes = (providerInstance as unknown as { runtimes: Map<SessionId, unknown> }).runtimes
      expect(runtimes.has(resumedDisposed.id)).toBe(false)
      expect(runtimes.has(resumedLive.id)).toBe(true)

      // Assert no subsequent control-stream update for the disposed session
      const raceNext = await Promise.race([
        generation.iterator.next(),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 50)),
      ])
      expect(raceNext).toBe('timeout')

      disposeCommitted()
      generation.abort()
      expect(await generation.iterator.next()).toMatchObject({ done: true })
    } finally {
      gate.release()
      try {
        await pending
      } catch {}
    }
  })

  it('same-id replacement while old runtime disposal is pending: new lifecycle does not receive old stable/runtime and old cleanup does not delete new runtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-same-id-'))
    const ctx = await mountComposition('same-id-sessions')

    const session1 = ctx.sessions.prepare(SessionId('same-id-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })
    const detach1 = ctx.sessions.enter(session1)
    ctx.sessions.announce(session1)

    appendUser(session1, 'first session content')
    await waitUntil(() => ctx.taskState.getStable(session1.id) !== undefined, 3_000)
    const stored1 = ctx.taskState.getStable(session1.id)
    expect(stored1).toBeDefined()

    const provider = ctx.get('taskState') as TaskStateBasicService
    const runtimes = (provider as unknown as {
      runtimes: Map<SessionId, { session: Session; worker: { isOpen: boolean; dispose: () => Promise<void> } }>
    }).runtimes
    const oldRuntime = runtimes.get(session1.id)
    expect(oldRuntime).toBeDefined()
    expect(oldRuntime?.session).toBe(session1)

    // Intercept old runtime worker.dispose with a gate so disposal stays pending
    let releaseDisposal!: () => void
    const disposalGate = new Promise<void>(resolve => { releaseDisposal = resolve })
    const origDispose = oldRuntime!.worker.dispose.bind(oldRuntime!.worker)
    oldRuntime!.worker.dispose = async () => {
      await disposalGate
      return origDispose()
    }

    // Detach session1 to trigger disposal
    detach1()
    expect(ctx.sessions.get(session1.id)).toBeUndefined()

    // Create session2 with the same id and different createdAt while old disposal is pending
    const session2 = ctx.sessions.prepare(SessionId('same-id-session'), {
      meta: { cwd: root, createdAt: 1_700_000_060_000 },
    })
    const detach2 = ctx.sessions.enter(session2)
    ctx.sessions.announce(session2)

    // New lifecycle must not receive old stable or old runtime
    expect(ctx.taskState.getStable(session2.id)).toBeUndefined()
    const newRuntime = runtimes.get(session2.id)
    expect(newRuntime).toBeDefined()
    expect(newRuntime?.session).toBe(session2)
    expect(newRuntime).not.toBe(oldRuntime)

    // Now release old disposal and let it settle
    releaseDisposal()
    await new Promise(resolve => setTimeout(resolve, 50))

    // Old cleanup must not delete new runtime
    expect(runtimes.get(session2.id)).toBe(newRuntime)
    expect(runtimes.has(session2.id)).toBe(true)

    // Old runtime is disposed, new runtime is open and bound to session2
    expect(oldRuntime?.worker.isOpen).toBe(false)
    expect(newRuntime?.worker.isOpen).toBe(true)
    expect(ctx.taskState.getStable(session2.id)).toBeUndefined()

    detach2()
  })

  it('manual edit disposed during awaited put: no ghost publication/update', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-manual-disposed-'))
    const ctx = await mountComposition('manual-disposed-sessions')

    const session = ctx.sessions.prepare(SessionId('manual-disposed-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)

    appendUser(session, 'seed initial stable')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)
    const initialStable = ctx.taskState.getStable(session.id)!
    expect(initialStable).toBeDefined()

    const provider = ctx.get('taskState') as TaskStateBasicService
    const control = new TaskStateControlService(ctx)
    const stream = openStream(control)
    await readBaseline(stream.iterator)

    const committedUpdates: { id: SessionId; stable: TaskStateStable }[] = []
    const unsubscribe = provider.subscribeCommitted((id, stable) => {
      committedUpdates.push({ id, stable })
    })

    // Gate putStable on sessionsTable
    const sessionsTable = (provider as unknown as {
      sessionsTable: { put: (key: string, val: unknown) => Promise<void>; get: (key: string) => { stable: TaskStateStable } }
    }).sessionsTable
    const origPut = sessionsTable.put.bind(sessionsTable)
    let releasePut!: () => void
    const putGate = new Promise<void>(resolve => { releasePut = resolve })
    let putEntered!: () => void
    const putEnteredPromise = new Promise<void>(resolve => { putEntered = resolve })

    sessionsTable.put = async (key: string, val: unknown) => {
      if (key === String(session.id)) {
        putEntered()
        await putGate
      }
      return origPut(key, val)
    }

    // Launch manual edit
    const editPromise = provider.editStable({
      sessionId: session.id,
      expectedRevision: initialStable.revision,
      value: {
        currentObjective: 'Manual edit objective',
        currentFocus: '',
        openWork: [],
        nextActions: [],
        facts: ['new fact'],
        decisions: [],
        constraints: [],
        risks: [],
      },
    })

    await putEnteredPromise

    // Dispose session while put is in flight
    detach()
    expect(ctx.sessions.get(session.id)).toBeUndefined()

    // Release put
    releasePut()

    // Edit result must indicate unavailable
    const editResult = await editPromise
    expect(editResult.ok).toBe(false)
    if (editResult.ok) return
    expect(editResult.code).toBe('unavailable')

    // No ghost committed publication
    expect(committedUpdates).toHaveLength(0)

    // No ghost control stream update
    const raceNext = await Promise.race([
      stream.iterator.next(),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(raceNext).toBe('timeout')

    // But durable write did commit in storage
    expect(sessionsTable.get(String(session.id)).stable.revision).toBe(initialStable.revision + 1)

    unsubscribe()
    stream.abort()
    expect(await stream.iterator.next()).toMatchObject({ done: true })
  })

  it('manual edit replaced during awaited put: returns conflict without ghost publication', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-manual-replaced-'))
    const ctx = await mountComposition('manual-replaced-sessions')

    const session1 = ctx.sessions.prepare(SessionId('manual-replaced-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })
    const detach1 = ctx.sessions.enter(session1)
    ctx.sessions.announce(session1)

    appendUser(session1, 'seed initial stable')
    await waitUntil(() => ctx.taskState.getStable(session1.id) !== undefined, 3_000)
    const initialStable = ctx.taskState.getStable(session1.id)!
    expect(initialStable).toBeDefined()

    const provider = ctx.get('taskState') as TaskStateBasicService
    const committedUpdates: { id: SessionId; stable: TaskStateStable }[] = []
    const unsubscribe = provider.subscribeCommitted((id, stable) => {
      committedUpdates.push({ id, stable })
    })

    // Gate putStable on sessionsTable
    const sessionsTable = (provider as unknown as {
      sessionsTable: { put: (key: string, val: unknown) => Promise<void> }
    }).sessionsTable
    const origPut = sessionsTable.put.bind(sessionsTable)
    let releasePut!: () => void
    const putGate = new Promise<void>(resolve => { releasePut = resolve })
    let putEntered!: () => void
    const putEnteredPromise = new Promise<void>(resolve => { putEntered = resolve })

    sessionsTable.put = async (key: string, val: unknown) => {
      if (key === String(session1.id)) {
        putEntered()
        await putGate
      }
      return origPut(key, val)
    }

    const editPromise = provider.editStable({
      sessionId: session1.id,
      expectedRevision: initialStable.revision,
      value: {
        currentObjective: 'Manual edit objective',
        currentFocus: '',
        openWork: [],
        nextActions: [],
        facts: [],
        decisions: [],
        constraints: [],
        risks: [],
      },
    })

    await putEnteredPromise

    // Detach session1 and create session2 with same id and different createdAt
    detach1()
    const session2 = ctx.sessions.prepare(SessionId('manual-replaced-session'), {
      meta: { cwd: root, createdAt: 1_700_000_060_000 },
    })
    const detach2 = ctx.sessions.enter(session2)
    ctx.sessions.announce(session2)

    releasePut()

    const editResult = await editPromise
    expect(editResult.ok).toBe(false)
    if (editResult.ok) return
    expect(editResult.code).toBe('conflict')
    expect(committedUpdates).toHaveLength(0)

    unsubscribe()
    detach2()
  })

  it('throwing manual audit diagnostic returns correct committed result, retains repair, and invokes logger', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-throwing-manual-audit-'))
    const ctx = await mountComposition('throwing-manual-audit')

    const session = ctx.sessions.create(SessionId('throwing-manual-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })
    appendUser(session, 'seed initial stable')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)
    const initialStable = ctx.taskState.getStable(session.id)!
    expect(initialStable).toBeDefined()

    const provider = ctx.get('taskState') as TaskStateBasicService

    // Cause finishOpenAudit to fail by sabotaging auditTable.update
    const auditTable = (provider as unknown as { auditTable: { update: () => Promise<void> } }).auditTable
    auditTable.update = async () => {
      throw new Error('auditTable update disk error')
    }

    // Intercept trackRepair to verify live repair is scheduled
    let repairScheduled = false
    const origTrackRepair = (provider as unknown as {
      trackRepair: (label: string, op: () => Promise<void>) => Promise<void>
    }).trackRepair.bind(provider)
    ;(provider as unknown as {
      trackRepair: (label: string, op: () => Promise<void>) => Promise<void>
    }).trackRepair = (label, op) => {
      repairScheduled = true
      return origTrackRepair(label, op)
    }

    // Set throwing error logger
    let errorCalls = 0
    ctx.logger.error = () => {
      errorCalls += 1
      throw new Error('logger.error exploded during manual audit finish')
    }

    const editResult = await provider.editStable({
      sessionId: session.id,
      expectedRevision: initialStable.revision,
      value: {
        currentObjective: 'Committed despite throwing logger',
        currentFocus: '',
        openWork: [],
        nextActions: [],
        facts: ['manually committed fact'],
        decisions: [],
        constraints: [],
        risks: [],
      },
    })

    // Returns correct committed result
    expect(editResult.ok).toBe(true)
    if (!editResult.ok) return
    expect(editResult.stable.revision).toBe(initialStable.revision + 1)
    expect(ctx.taskState.getStable(session.id)?.revision).toBe(initialStable.revision + 1)

    // Logger was genuinely called for both the manual finish failure and the repair attempt
    expect(errorCalls).toBe(2)

    // Retains and schedules repair behavior as designed
    expect(repairScheduled).toBe(true)
  })

  it('throwing disposal logger cannot break cleanup and increments count', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-throwing-disposal-'))
    const ctx = await mountComposition('throwing-disposal')

    const session = ctx.sessions.prepare(SessionId('disposal-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    appendUser(session, 'seed stable')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)

    const provider = ctx.get('taskState') as TaskStateBasicService
    const runtimes = (provider as unknown as { runtimes: Map<SessionId, { worker: { dispose: () => Promise<void> } }> }).runtimes
    const runtime = runtimes.get(session.id)!
    expect(runtime).toBeDefined()

    // Make worker.dispose reject to trigger disposal warning logger
    runtime.worker.dispose = async () => {
      throw new Error('worker disposal failure')
    }

    let warnCalls = 0
    ctx.logger.warn = () => {
      warnCalls += 1
      throw new Error('logger.warn exploded during worker disposal')
    }

    detach()
    await new Promise(resolve => setTimeout(resolve, 50))

    // Logger was genuinely called
    expect(warnCalls).toBe(1)
    // Cleanup was NOT broken: runtime was deleted from runtimes map
    expect(runtimes.has(session.id)).toBe(false)
  })

  it('throwing missing-repair-row and repair failure loggers do not break startup or cleanup', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-repair-loggers-'))
    const ctx = await mountComposition('repair-loggers-1')

    const session = ctx.sessions.create(SessionId('repair-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })
    appendUser(session, 'first event')
    await waitUntil(() => ctx.taskState.getStable(session.id) !== undefined, 3_000)
    const stored = ctx.taskState.getStable(session.id)!

    // In storage, delete the audit rows so it becomes uncertified with NO matching open row (missing repair row)
    const provider = ctx.get('taskState') as TaskStateBasicService
    const auditTable = (provider as unknown as {
      auditTable: { keys: () => IterableIterator<string>; delete: (k: string) => Promise<boolean> }
    }).auditTable
    for (const key of [...auditTable.keys()]) {
      await auditTable.delete(key)
    }

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    // Mount second composition with throwing logger.warn and logger.error
    let warnCalls = 0
    let errorCalls = 0
    const second = await mountBase('repair-loggers-2')
    second.logger.warn = () => {
      warnCalls += 1
      throw new Error('logger.warn exploded on missing repair row')
    }
    second.logger.error = () => {
      errorCalls += 1
      throw new Error('logger.error exploded on repair failure')
    }

    await second.plugin(TaskStateBasicService, BASIC_CONFIG)

    const resumed = second.sessions.create(SessionId('repair-session'), {
      meta: { cwd: root, createdAt: 1_700_000_000_000 },
    })

    // Missing repair row warning triggers logger.warn
    await waitUntil(() => warnCalls >= 1, 3_000)
    expect(warnCalls).toBe(1)

    // Stable remains authoritative despite throwing logger
    expect(second.taskState.getStable(resumed.id)).toEqual(stored)

    // Also trigger trackRepair failure with throwing logger.error
    const secondProvider = second.get('taskState') as TaskStateBasicService
    await (secondProvider as unknown as {
      trackRepair: (label: string, op: () => Promise<void>) => Promise<void>
    }).trackRepair('test-failure', async () => {
      throw new Error('repair operation rejected')
    })
    expect(errorCalls).toBe(1)

    // Cleanup still works on second fiber disposal
    await expect(second.fiber.dispose()).resolves.toBeUndefined()
    contexts.splice(contexts.indexOf(second), 1)
  })
})
