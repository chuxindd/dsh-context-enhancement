/**
 * B4.1 · startup backlog (does establishing a runtime fold an inherited tail?).
 *
 * The single question this spec answers: when a Session is created, resumed, or
 * hydrated from a stored record and its log ALREADY holds projectable filter
 * eligible events above the committed `sourceCursor` (at least `minEvents` of
 * them), does the provider admit ONE `startup` wave without any new Session
 * event — and does it do so without letting startup work touch the synchronous
 * creation/open/hydration stack?
 *
 * Composition: real `SessionStore`, real JSONL session persistence (durable
 * resume through `sessionPersistence.prepare` → `sessions.enter` →
 * `sessions.announce`), real `Storage` + `StorageJson` + `StorageDomain`, real
 * `LlmRuntime`, and the REAL `TaskStateBasicService`. The only fake is the
 * scripted LLM adapter, which records every request (folded seqs) and can be
 * observed.
 *
 * This file never calls `observe`, `maybeSchedule`, or `maybeScheduleStartup`
 * on its own initiative and never constructs a `TaskStateWorker` directly:
 * every wave below is admitted by the production provider path
 * (`session/created`, `session/event`, or the startup check it queues on a
 * microtask after establishing a runtime).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../src/task-state-basic.ts'
import type { TaskStateStable } from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import { filterEvent, isEligibleType } from '../src/internal/task-state/basic/filter.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'

/** Provider-owned deployment policy; `minEvents` is overridden per test. */
const BASE_CONFIG: TaskStateBasicConfig = {
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

const PROVIDER = 'current-route'
const MODEL = 'current-model'
const CREATED_AT = 1_700_000_000_000
const DOMAIN_FILE = 'context_enhancement_task_state_v2.json'

/** One recorded auxiliary request. */
interface RequestRow {
  /** `"seq":N` occurrences in the framed projection, in order. */
  readonly windowSeqs: number[]
  /** Highest folded seq visible in the projection (-1 when none). */
  readonly maxSeq: number
}

/**
 * Scripted adapter answering every request with one structurally valid
 * candidate JSON that echoes the highest folded seq, recording each request.
 * No `usage` is produced, so no provider-token claim is made here.
 */
class RecordingAdapter extends LlmAdapter {
  readonly requests: RequestRow[] = []
  /** Test hook fired synchronously inside `stream`, before any yield. */
  onStream: (() => void) | undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onStream?.()
    const messages = (options.messages ?? []) as readonly { readonly content?: unknown }[]
    const text = messages
      .flatMap(message => Array.isArray(message.content) ? message.content as readonly unknown[] : [])
      .filter((block): block is { readonly type: string; readonly text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join('')
    const windowSeqs = [...text.matchAll(/"seq":\s*(\d+)/gu)].map(match => Number(match[1]))
    const maxSeq = windowSeqs.length === 0 ? -1 : Math.max(...windowSeqs)
    const body = JSON.stringify({
      facts: [{ content: `task state folded eligible events through ${maxSeq}` }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `probe window-through-${maxSeq}`,
        currentFocus: 'observing the startup backlog wave',
        openWork: [],
        nextActions: [],
      },
    })
    this.requests.push({ windowSeqs, maxSeq })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
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

/** One mounted host stack with a real storage root and real session logs. */
interface Mounted {
  readonly ctx: Context
  readonly adapter: RecordingAdapter
  /** Durably persisted session-log root (survives a disposal). */
  readonly sessionRoot: string
  /** Durable task-state domain root (survives a disposal). */
  readonly storageRoot: string
  /** Session preparations and detachers held by resumed Sessions. */
  readonly held: { preparation: unknown; detach: () => void }[]
}

/** Mount sessions + real storage/domain + llm, WITHOUT the task-state provider. */
async function mountBase(
  sessionRootName: string,
  storageRootName: string,
  scratch: string,
): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const sessionRoot = join(scratch, sessionRootName)
  const storageRoot = join(scratch, storageRootName)
  const adapter = new RecordingAdapter()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: sessionRoot,
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter, sessionRoot, storageRoot, held: [] }
}

/** Mount the base stack plus the real task-state provider, and await its init. */
async function mountComposition(
  sessionRootName: string,
  storageRootName: string,
  scratch: string,
  overrides: Partial<TaskStateBasicConfig> = {},
): Promise<Mounted> {
  const mounted = await mountBase(sessionRootName, storageRootName, scratch)
  await mounted.ctx.plugin(TaskStateBasicService, { ...BASE_CONFIG, ...overrides })
  return mounted
}

/** Append one direct human user/message and return its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append one model assistant/message and return its seq. */
function appendAssistant(session: Session, turn: number, step: number, text: string): number {
  return session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' }).seq
}

/** Append one complete turn; every appended seq in order. */
function appendTurn(session: Session, turn: number, text: string): number[] {
  return [
    session.append('turn/start', { turn }).seq,
    appendUser(session, text),
    appendAssistant(session, turn, 1, `${text} (assistant)`),
    session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq,
  ]
}

/** Eligible, projectable event seqs strictly above `cursor` (real filter math). */
function eligibleSeqsAbove(session: Session, cursor: number): number[] {
  const seqs: number[] = []
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= cursor) continue
    if (!isEligibleType(event.type)) continue
    if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) continue
    seqs.push(Number(event.seq))
  }
  return seqs
}

/** Resume one durable Session through the production persistence idiom. */
async function resume(ctx: Context, id: SessionId, mounted?: Mounted): Promise<Session> {
  const persistence = (ctx as unknown as {
    sessionPersistence: { prepare: (id: SessionId) => Promise<unknown> }
  }).sessionPersistence
  const preparation = await persistence.prepare(id)
  const session = (preparation as { readonly session: Session }).session
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  mounted?.held.push({ preparation, detach })
  return session
}

/** Release one held preparation through its `Symbol.dispose` protocol. */
function releasePreparation(preparation: unknown): void {
  const dispose = (preparation as Record<PropertyKey, unknown> | undefined)?.[Symbol.dispose as unknown as PropertyKey]
  if (typeof dispose === 'function') (dispose as () => void).call(preparation)
}

/**
 * Close one mounted stage completely: let the JSONL writer drain, detach and
 * release every resumed Session, then dispose the whole Context so the durable
 * session log and the durable task-state domain are what the next stage reads.
 */
async function closeProcess(mounted: Mounted): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  for (const handle of mounted.held.splice(0)) {
    handle.detach()
    releasePreparation(handle.preparation)
  }
  await mounted.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(mounted.ctx), 1)
}

/** Poll one predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`startup-backlog spec: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** The raw durable domain document on disk, or `null` when absent/unreadable. */
interface DomainDoc {
  readonly tables: {
    readonly sessions: Record<string, {
      readonly session: { readonly createdAt: number; readonly cwd?: string }
      readonly stable: { readonly revision: number; readonly sourceCursor: number; readonly digest: string }
    }>
    readonly audit: Record<string, {
      readonly request: { readonly revision: number; readonly trigger?: string; readonly includedSeqs: readonly number[] }
      readonly finished?: { readonly outcome: string }
    }>
  }
}

/** Read the durable domain document a closed stage left on disk. */
async function readDomain(storageRoot: string): Promise<DomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, DOMAIN_FILE), 'utf8')) as DomainDoc
  } catch {
    return null
  }
}

/** Read every durable audit row of the live domain. */
function auditRows(ctx: Context): TaskStateAuditRecord[] {
  const provider = ctx.get('taskState') as TaskStateBasicService
  const table = (provider as unknown as {
    auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
  }).auditTable
  if (table === undefined) return []
  return [...table.entries()].map(entry => entry[1])
}

/** The commit trigger recorded on the open audit row of one committed revision. */
function triggerOfRevision(ctx: Context, revision: number): string | undefined {
  return auditRows(ctx)
    .find(row => row.request.revision === revision && row.finished !== undefined)
    ?.request.trigger
}

/** The included sequences recorded for one committed revision. */
function includedSeqsOfRevision(ctx: Context, revision: number): number[] {
  const row = auditRows(ctx)
    .find(candidate => candidate.request.revision === revision && candidate.finished !== undefined)
  return row === undefined ? [] : [...row.request.includedSeqs].map(Number)
}

/**
 * Wait for the FINISHED audit phase of one committed revision. A commit
 * publishes its stable as soon as the authority put resolves, so the row that
 * carries the wave's trigger may still be open for a moment after the pointer
 * advanced.
 */
async function waitForFinishedAudit(ctx: Context, revision: number): Promise<void> {
  await waitUntil(
    () => auditRows(ctx).some(row => row.request.revision === revision && row.finished !== undefined),
    2_000,
    `finished audit row for revision ${revision}`,
  )
}

/**
 * The shared three-stage restart fixture. Stage 1 commits a stable and closes;
 * stage 2 resumes the SAME durable medium with NO provider mounted and appends
 * `turn two` there, so the eligible tail above the committed cursor is inherited
 * rather than observed; stage 3 reopens the medium (no new Session event) and
 * mounts the provider.
 */
async function stageOne(sessionId: SessionId): Promise<{ mounted: Mounted; stable: TaskStateStable }> {
  const first = await mountComposition('sessions', 'storage', root as string)
  const session = first.ctx.sessions.create(sessionId, {
    meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
  })
  appendTurn(session, 1, 'turn one')
  await waitUntil(() => first.ctx.taskState.getStable(session.id) !== undefined, 3_000, 'first commit')
  const stable = first.ctx.taskState.getStable(session.id) as TaskStateStable
  expect(first.adapter.requests.length).toBe(1)
  await closeProcess(first)
  return { mounted: first, stable }
}

/** Stage 2: resume with no provider mounted and append one backlog turn. */
async function stageTwoBacklog(sessionId: SessionId): Promise<{ mounted: Mounted; backlog: number[]; cursor: number }> {
  const second = await mountBase('sessions', 'storage', root as string)
  const session = await resume(second.ctx, sessionId, second)
  const durable = await readDomain(second.storageRoot)
  const cursor = durable?.tables.sessions[String(sessionId)]?.stable.sourceCursor
  expect(cursor).toBeDefined()
  const appended = appendTurn(session, 2, 'turn two')
  const backlog = eligibleSeqsAbove(session, cursor as number)
  // `turn/start` is not eligible: the inherited tail is user, assistant, turn/end.
  expect(backlog).toEqual(appended.filter(seq => seq !== appended[0]))
  expect(second.adapter.requests.length).toBe(0)
  await closeProcess(second)
  return { mounted: second, backlog, cursor: cursor as number }
}

describe('task-state startup backlog (creation, resume, and hydration)', () => {
  it('folds an inherited eligible tail after a restart with no new Session event', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-'))
    const sessionId = SessionId('startup-restart')
    const { stable: before } = await stageOne(sessionId)
    const expectedCursor = before.sourceCursor
    await stageTwoBacklog(sessionId)

    // The durable record still holds the stage-1 commit: nothing folded the
    // inherited tail while no provider was mounted.
    const closed = await readDomain(join(root, 'storage'))
    expect(closed?.tables.sessions[String(sessionId)]?.stable.revision).toBe(before.revision)

    const third = await mountComposition('sessions', 'storage', root)
    const published: { revision: number; requestsAtPublish: number }[] = []
    const provider = third.ctx.get('taskState') as TaskStateBasicService
    provider.subscribeCommitted((_id, stable) => {
      published.push({ revision: stable.revision, requestsAtPublish: third.adapter.requests.length })
    })
    const session = await resume(third.ctx, sessionId, third)

    // The recovered stable is published synchronously, before any backlog work:
    // the durable baseline is served first and no model call happened on the
    // hydration stack that published it.
    const recovered = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(recovered.revision).toBe(before.revision)
    expect(recovered.sourceCursor).toBe(expectedCursor)
    expect(recovered.digest).toBe(before.digest)
    expect(third.adapter.requests.length).toBe(0)
    expect(published).toEqual([{ revision: before.revision, requestsAtPublish: 0 }])

    // No new Session event: the startup check on its own must fold the tail.
    await waitUntil(
      () => (third.ctx.taskState.getStable(session.id)?.revision ?? 0) > before.revision,
      5_000,
      'startup backlog commit',
    )
    const committed = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(third.adapter.requests.length).toBe(1)
    expect(third.adapter.requests[0]!.windowSeqs).toEqual([6, 7, 8])
    expect(committed.revision).toBe(before.revision + 1)
    expect(committed.sourceCursor).toBe(8)
    // The wave is recorded as `startup`, not as a threshold or trailing wave,
    // and the baseline publication preceded the backlog request.
    await waitForFinishedAudit(third.ctx, committed.revision)
    expect(triggerOfRevision(third.ctx, committed.revision)).toBe('startup')
    expect(includedSeqsOfRevision(third.ctx, committed.revision)).toEqual([6, 7, 8])
    expect(published[1]).toEqual({ revision: committed.revision, requestsAtPublish: 1 })
    // Exactly one wave: no trailing cascade over the same backlog.
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    expect(third.adapter.requests.length).toBe(1)
  }, 60_000)

  it('never starts a model call on the synchronous hydration stack', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-async-'))
    const sessionId = SessionId('startup-async')
    await stageOne(sessionId)
    await stageTwoBacklog(sessionId)

    // Observe the two arbitration points. The startup check must be OFFERED
    // with ZERO requests already dispatched (a synchronous fold would have
    // dispatched one first), and no request may exist at the end of the tick
    // that resumed the Session — the wave is only launched from a microtask
    // after that stack unwound.
    const third = await mountComposition('sessions', 'storage', root)
    const provider = third.ctx.get('taskState') as TaskStateBasicService
    const checks: number[] = []
    const patchedRuntimeFor = (provider as unknown as {
      runtimeFor: (session: Session) => { worker: { maybeScheduleStartup: () => void } } | undefined
    }).runtimeFor.bind(provider)
    ;(provider as unknown as { runtimeFor: (session: Session) => unknown }).runtimeFor = (session: Session) => {
      const runtime = patchedRuntimeFor(session)
      const worker = runtime?.worker
      if (worker !== undefined && !(worker as unknown as { __wrapped?: boolean }).__wrapped) {
        ;(worker as unknown as { __wrapped?: boolean }).__wrapped = true
        const original = worker.maybeScheduleStartup.bind(worker)
        worker.maybeScheduleStartup = () => {
          checks.push(third.adapter.requests.length)
          original()
        }
      }
      return runtime
    }

    const session = await resume(third.ctx, sessionId, third)
    const requestsAtResumeEnd = third.adapter.requests.length
    const recovered = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(checks).toEqual([0])
    expect(requestsAtResumeEnd).toBe(0)
    expect(recovered.revision).toBe(1)
    expect(recovered.sourceCursor).toBe(3)

    await waitUntil(() => (third.ctx.taskState.getStable(session.id)?.revision ?? 0) >= 2, 5_000, 'startup commit')
    // The wave ran strictly after the hydration stack: one offer, one request.
    expect(checks).toEqual([0])
    expect(third.adapter.requests.length).toBe(1)
    expect(third.adapter.requests[0]!.windowSeqs).toEqual([6, 7, 8])
  }, 60_000)

  it('admits one startup wave per runtime when hydration is offered repeatedly', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-dedup-'))
    const sessionId = SessionId('startup-dedup')
    const { stable: before } = await stageOne(sessionId)
    await stageTwoBacklog(sessionId)

    // Patch the arbitration point BEFORE the Session is resumed so the
    // provider's own offer is observed, then re-offer the check repeatedly:
    // the same backlog must never start a second startup wave.
    const third = await mountComposition('sessions', 'storage', root)
    const provider = third.ctx.get('taskState') as TaskStateBasicService
    const offers: number[] = []
    const patchedRuntimeFor = (provider as unknown as {
      runtimeFor: (session: Session) => { worker: { maybeScheduleStartup: () => void } } | undefined
    }).runtimeFor.bind(provider)
    ;(provider as unknown as { runtimeFor: (session: Session) => unknown }).runtimeFor = (session: Session) => {
      const runtime = patchedRuntimeFor(session)
      const worker = runtime?.worker
      if (worker !== undefined && !(worker as unknown as { __wrapped?: boolean }).__wrapped) {
        ;(worker as unknown as { __wrapped?: boolean }).__wrapped = true
        const original = worker.maybeScheduleStartup.bind(worker)
        worker.maybeScheduleStartup = () => {
          offers.push(third.adapter.requests.length)
          original()
        }
      }
      return runtime
    }
    const session = await resume(third.ctx, sessionId, third)
    const runtime = (provider as unknown as { runtimes: Map<SessionId, { worker: { maybeScheduleStartup: () => void } }> })
      .runtimes.get(session.id)
    expect(runtime).toBeDefined()
    runtime!.worker.maybeScheduleStartup()
    runtime!.worker.maybeScheduleStartup()

    await waitUntil(() => (third.ctx.taskState.getStable(session.id)?.revision ?? 0) > before.revision, 5_000, 'startup commit')
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    const committed = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(offers).toEqual([0, 0, 0])
    expect(committed.revision).toBe(before.revision + 1)
    expect(third.adapter.requests.length).toBe(1)
    await waitForFinishedAudit(third.ctx, committed.revision)
    expect(triggerOfRevision(third.ctx, committed.revision)).toBe('startup')
  }, 60_000)

  it('folds an inherited tail that is exactly at minEvents', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-at-'))
    const sessionId = SessionId('startup-at')
    const { stable: before } = await stageOne(sessionId)
    const { backlog } = await stageTwoBacklog(sessionId)
    expect(backlog.length).toBe(3)
    // The durable baseline this stage must recover, read from disk BEFORE the
    // provider that may fold the tail is mounted.
    const durable = await readDomain(join(root, 'storage'))
    const baseline = durable?.tables.sessions[String(sessionId)]?.stable
    expect(baseline?.revision).toBe(before.revision)
    expect(baseline?.sourceCursor).toBe(before.sourceCursor)

    // minEvents = 3 over an inherited tail of exactly 3: the startup check must
    // admit one wave and fold the whole tail, with no new Session event.
    const third = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = await resume(third.ctx, sessionId, third)
    const recovered = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(recovered.revision).toBe(baseline?.revision)
    expect(recovered.digest).toBe(baseline?.digest)
    await waitUntil(() => (third.ctx.taskState.getStable(session.id)?.revision ?? 0) > before.revision, 5_000, 'startup commit')
    const committed = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(third.adapter.requests.length).toBe(1)
    expect(third.adapter.requests[0]!.windowSeqs).toEqual(backlog)
    expect(committed.revision).toBe((baseline?.revision ?? 0) + 1)
    expect(committed.sourceCursor).toBe(8)
    await waitForFinishedAudit(third.ctx, committed.revision)
    expect(triggerOfRevision(third.ctx, committed.revision)).toBe('startup')
  }, 60_000)

  it('starts nothing for a sub-threshold backlog, and an arriving event crosses the threshold instead', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-sub-'))
    const sessionId = SessionId('startup-sub')
    const { stable: before } = await stageOne(sessionId)
    const { backlog } = await stageTwoBacklog(sessionId)
    expect(backlog.length).toBe(3)
    const durable = await readDomain(join(root, 'storage'))
    const baseline = durable?.tables.sessions[String(sessionId)]?.stable
    expect(baseline?.revision).toBe(before.revision)
    expect(baseline?.sourceCursor).toBe(before.sourceCursor)

    // minEvents = 4 over an inherited tail of exactly 3: the startup check must
    // admit NOTHING, so the recovered pointer stays exactly at the durable
    // baseline and no request is dispatched. The next eligible event then folds
    // the whole tail as a THRESHOLD wave (so "no startup wave" is not "the
    // backlog is stuck").
    const third = await mountComposition('sessions', 'storage', root, { minEvents: 4 })
    const session = await resume(third.ctx, sessionId, third)
    const recovered = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(recovered.revision).toBe(baseline?.revision)
    expect(recovered.sourceCursor).toBe(baseline?.sourceCursor)
    expect(recovered.digest).toBe(baseline?.digest)
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(third.adapter.requests.length).toBe(0)
    expect(third.ctx.taskState.getStable(session.id)?.revision).toBe(baseline?.revision)

    const newSeq = appendUser(session, 'turn three user event')
    expect(eligibleSeqsAbove(session, before.sourceCursor)).toEqual([...backlog, newSeq])
    await waitUntil(() => (third.ctx.taskState.getStable(session.id)?.revision ?? 0) > before.revision, 5_000, 'threshold commit')
    const committed = third.ctx.taskState.getStable(session.id) as TaskStateStable
    expect(third.adapter.requests.length).toBe(1)
    expect(third.adapter.requests[0]!.windowSeqs).toEqual([...backlog, newSeq])
    // The wave is a THRESHOLD wave, not a startup wave: the startup reason is
    // reserved for the no-new-event backlog fold.
    await waitForFinishedAudit(third.ctx, committed.revision)
    expect(triggerOfRevision(third.ctx, committed.revision)).toBe('threshold')
    expect(committed.sourceCursor).toBe(newSeq)
  }, 60_000)

  it('starts nothing for a hydrated Session whose backlog is empty', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-empty-'))
    const sessionId = SessionId('startup-empty')
    const { stable: before } = await stageOne(sessionId)

    // Two mounts on the SAME durable medium with no event appended in between:
    // the resumed Session inherits an EMPTY tail above its committed cursor, so
    // the startup check admits nothing and the recovered pointer stays exact.
    const second = await mountComposition('sessions', 'storage', root)
    const session = await resume(second.ctx, sessionId, second)
    expect(eligibleSeqsAbove(session, before.sourceCursor)).toEqual([])
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(second.adapter.requests.length).toBe(0)
    expect(second.ctx.taskState.getStable(session.id)).toEqual(before)
  }, 60_000)
  it('starts nothing for a Session whose lifecycle does not match the stored record', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-lifecycle-'))
    const sessionId = SessionId('startup-lifecycle')
    await stageOne(sessionId)

    // A different lifecycle identity (same id, different `createdAt`) is fenced
    // off from the stored record: no cursor may be hydrated from it and no
    // startup wave may be admitted on the back of someone else's record. The
    // log also carries its own eligible event, which proves the check is
    // disabled rather than merely never reached.
    const second = await mountComposition('sessions', 'storage', root)
    const session = second.ctx.sessions.create(sessionId, {
      meta: { cwd: second.storageRoot, createdAt: CREATED_AT + 1 },
    })
    appendUser(session, 'unrelated lifecycle event')
    expect(second.ctx.taskState.getStable(session.id)).toBeUndefined()
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(second.ctx.taskState.getStable(session.id)).toBeUndefined()
  }, 60_000)

  it('starts nothing when the authoritative domain fails to open', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-startup-disabled-'))
    const sessionId = SessionId('startup-disabled')
    await stageOne(sessionId)

    // Damage the durable domain document: opening it must fail LOUDLY, which
    // disables the provider for the whole overlay. A disabled provider publishes
    // no stable and must never schedule a startup wave, even though the resumed
    // Session log holds a projectable eligible tail.
    await writeFile(
      join(root, 'storage', DOMAIN_FILE),
      '{"unit":{"name":"context_enhancement_task_state_v2","version":',
      'utf8',
    )

    const second = await mountComposition('sessions', 'storage', root)
    const session = await resume(second.ctx, sessionId, second)
    appendUser(session, 'unrelated event while the domain is unavailable')
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(second.ctx.taskState.getStable(session.id)).toBeUndefined()
    expect(second.adapter.requests.length).toBe(0)
  }, 60_000)
})
