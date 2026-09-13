/**
 * B4.2 · TODO authority (R-P1-7): the whole-list `todo/write` fact is an
 * authoritative named view, so a mutation REPLACES the previous list and a legal
 * empty write CLEARS it — both folded by an `urgent` wave and both visible to
 * the model as the state the Session is committed to.
 *
 * The questions this spec answers, one test each:
 *  1. does the filter project an empty whole-list write as an explicit clear
 *     instead of dropping it?
 *  2. is a non-empty write below `minEvents` folded by an `urgent` wave, with
 *     the bounded reference DERIVED by the Host?
 *  3. does a legal clear below `minEvents` remove the list from the committed
 *     state, the derived reference, and the injection?
 *  4. can a model-authored `todoReferences` resurrect a cleared list?
 *  5. does a later write REPLACE the list (new `sourceSeq`, no stale item)?
 *  6. does a failed urgent wave commit nothing, leaving the clear for a later
 *     legal wave?
 *  7. is one eligible write sequence never folded twice?
 *  8. is zero model/storage work performed on the synchronous append stack?
 *  9. do two writes observed in one tick collapse into one urgent wave (newest
 *     wins), and does a write+clear in one tick end cleared?
 * 10. does a clear appended DURING a running wave earn one urgent follow-up?
 * 11. does a startup wave fold an inherited clear?
 * 12. does an ordinary window carry the previous list forward without claiming
 *     a change?
 * 13. does the clear survive a durable restart with the distinct digest?
 *
 * Composition: real `SessionStore`, real JSONL session persistence, real
 * `Storage` + `StorageJson` + `StorageDomain`, real `LlmRuntime`, and the REAL
 * `TaskStateBasicService`. The only fake is the scripted LLM adapter, which
 * records the frame it received and can be hooked mid-stream. No test ever
 * constructs a `TaskStateWorker` or calls `observe`.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../src/task-state-basic.ts'
import type { TaskStateStable, TaskStateUpdateTrigger } from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import { filterEvent, isEligibleType } from '../src/internal/task-state/basic/filter.ts'
import { renderTaskStateSnapshot } from '../src/internal/task-state/prompt/render.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'

/** Deployment-shaped config; `minEvents` is overridden per test. */
const BASE_CONFIG: TaskStateBasicConfig = {
  provider: 'current-route',
  model: 'current-model',
  minEvents: 20,
  maxEvents: 200,
  maxInputBytes: 100_000,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 2_000,
  maxListItems: 8,
}

const PROVIDER = 'current-route'
const CREATED_AT = 1_700_000_000_000
const DOMAIN_FILE = 'context_enhancement_task_state_v2.json'

const LIST_A = [
  { content: 'first durable item', status: 'pending' },
  { content: 'second durable item', status: 'in_progress' },
] as const
const LIST_B = [{ content: 'replacement item', status: 'completed' }] as const

/** The TODO part of one delivered frame. */
interface FrameTodo {
  readonly status: string
  readonly sourceSeq?: number
  readonly items: readonly { readonly content: string; readonly status: string }[]
}

/** The framed projection one request received. */
interface Frame {
  readonly previousStable: { readonly todoView?: unknown; readonly todoReferences?: unknown } | null
  readonly authorityViews: {
    readonly goal: { readonly status: string }
    readonly todo: FrameTodo
    readonly changed: readonly string[]
    readonly cleared: readonly string[]
  }
  readonly events: readonly { readonly seq: number; readonly type: string }[]
}

/** One recorded auxiliary request. */
interface RequestRow {
  readonly frame: Frame
  readonly includedSeqs: readonly number[]
}

/** Candidate JSON for one attempt, optionally echoing a model-made reference. */
function candidate(options: {
  readonly objective: string
  readonly facts?: readonly string[]
  readonly todoReference?: { readonly seq: number; readonly content: string }
}): string {
  return JSON.stringify({
    facts: (options.facts ?? [`folded: ${options.objective}`]).map(content => ({ content })),
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: options.todoReference === undefined ? [] : [options.todoReference],
    continuation: {
      currentObjective: options.objective,
      currentFocus: 'observing the todo authority wave',
      openWork: [],
      nextActions: [],
    },
  })
}

/** Scripted adapter recording the frame it received and hookable mid-stream. */
class FrameRecordingAdapter extends LlmAdapter {
  readonly requests: RequestRow[] = []
  output: string
  onStream: (() => void) | undefined

  constructor(output: string) {
    super()
    this.output = output
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onStream?.()
    const frame = readFrame(options)
    this.requests.push({ frame, includedSeqs: frame.events.map(event => event.seq) })
    const body = this.output
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Extract the framed projection out of one request's user message. */
function readFrame(options: GenerateOptions): Frame {
  const messages = (options.messages ?? []) as readonly { readonly content?: unknown }[]
  const texts = messages
    .flatMap(message => Array.isArray(message.content) ? message.content as readonly unknown[] : [])
    .filter((block): block is { readonly type: string; readonly text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as Frame
      if (typeof parsed === 'object' && parsed !== null && 'authorityViews' in parsed) return parsed
    } catch {
      // Not the frame: keep looking.
    }
  }
  throw new Error('task-state-todo-authority: no framed projection was delivered to the adapter')
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
  readonly adapter: FrameRecordingAdapter
  readonly storageRoot: string
  readonly held: { preparation: unknown; detach: () => void }[]
}

/** Mount sessions + real storage/domain + llm, WITHOUT the task-state provider. */
async function mountBase(
  sessionRootName: string,
  storageRootName: string,
  scratch: string,
  adapter: FrameRecordingAdapter,
): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = join(scratch, storageRootName)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(scratch, sessionRootName),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter, storageRoot, held: [] }
}

/** Mount the base stack plus the real task-state provider. */
async function mountComposition(
  sessionRootName: string,
  storageRootName: string,
  scratch: string,
  overrides: Partial<TaskStateBasicConfig> = {},
  adapter = new FrameRecordingAdapter(candidate({ objective: 'boot' })),
): Promise<Mounted> {
  const mounted = await mountBase(sessionRootName, storageRootName, scratch, adapter)
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

/**
 * Append one whole-list `todo/write` and return its seq. `todo/write` is a
 * LOG-ONLY event (no `surfaceOp`), and this workspace does not depend on the
 * todo plugin, so the session event map is widened for the call.
 */
function appendTodo(session: Session, todos: readonly { readonly content: string; readonly status: string }[]): number {
  const live = session as unknown as { append(type: string, data: unknown): { seq: number } }
  return Number(live.append('todo/write', { todos: [...todos] }).seq)
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

/** Close one mounted stage completely, draining the durable writers first. */
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
    if (Date.now() - start > timeoutMs) throw new Error(`task-state-todo-authority: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Every durable audit row of the live domain. */
function auditRows(ctx: Context): TaskStateAuditRecord[] {
  const provider = ctx.get('taskState') as TaskStateBasicService
  const table = (provider as unknown as {
    auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
  }).auditTable
  if (table === undefined) return []
  return [...table.entries()].map(entry => entry[1])
}

/** The finished audit rows, ordered by committed revision. */
function finishedRows(ctx: Context): TaskStateAuditRecord[] {
  return auditRows(ctx)
    .filter(row => row.finished !== undefined)
    .sort((left, right) => left.request.revision - right.request.revision)
}

/**
 * The commit trigger of one COMMITTED revision. A failed attempt records the
 * same target revision, so a failure row is never read as its reason.
 */
function triggerOfRevision(ctx: Context, revision: number): TaskStateUpdateTrigger | undefined {
  return finishedRows(ctx)
    .find(row => row.request.revision === revision && row.finished?.outcome !== 'failure')
    ?.request.trigger
}

/** The durable audit row that committed one revision. */
function committedRow(ctx: Context, revision: number): TaskStateAuditRecord {
  const row = finishedRows(ctx)
    .find(candidate => candidate.request.revision === revision && candidate.finished?.outcome !== 'failure')
  if (row === undefined) throw new Error(`task-state-todo-authority: no committed audit row for revision ${revision}`)
  return row
}

/** Wait for the FINISHED audit phase of one committed revision. */
async function waitForFinishedAudit(ctx: Context, revision: number, label: string): Promise<void> {
  await waitUntil(
    () => finishedRows(ctx).some(row => row.request.revision === revision && row.finished?.outcome !== 'failure'),
    3_000,
    label,
  )
}

/**
 * Let the ONE startup backlog check of a fresh runtime run and be consumed over
 * an empty backlog, so a bootstrap wave is a threshold wave rather than the
 * runtime-creation check winning a same-tick race.
 */
async function settleStartupCheck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 30))
}

/** The committed stable of one Session, or undefined. */
function stableOf(ctx: Context, id: SessionId): TaskStateStable | undefined {
  return ctx.taskState.getStable(id)
}

/** Append `count` direct human messages, filling a threshold window. */
function fill(session: Session, count: number, label: string): number[] {
  return Array.from({ length: count }, (_, index) => appendUser(session, `${label} ${index}`))
}

/** The runtime entry the provider holds for one Session (test seam). */
function runtimeOf(ctx: Context, id: SessionId): { worker: { maybeScheduleUrgent: (seq: number) => void } } {
  const provider = ctx.get('taskState') as TaskStateBasicService
  const runtimes = (provider as unknown as {
    runtimes: Map<SessionId, { worker: { maybeScheduleUrgent: (seq: number) => void } }>
  }).runtimes
  const runtime = runtimes.get(id)
  if (runtime === undefined) throw new Error('task-state-todo-authority: no runtime for the session')
  return runtime
}

/** The raw durable domain document on disk, or `null`. */
interface DomainDoc {
  readonly tables: {
    readonly sessions: Record<string, { readonly session: unknown; readonly stable: Record<string, unknown> }>
    readonly audit: Record<string, unknown>
  }
}

/** Read the durable domain document a stage left on disk. */
async function readDomain(storageRoot: string): Promise<DomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, DOMAIN_FILE), 'utf8')) as DomainDoc
  } catch {
    return null
  }
}

describe('task-state TODO authority (B4.2)', () => {
  it('projects an empty whole-list write as an explicit clear instead of dropping it', () => {
    const cleared = filterEvent({ type: 'todo/write', seq: 7, data: { todos: [] } })
    expect(cleared).not.toBeNull()
    expect(cleared!.event.fields).toEqual({ kind: 'todo/write', status: 'cleared', todos: [] })

    const current = filterEvent({
      type: 'todo/write',
      seq: 8,
      data: { todos: [{ content: 'ship the experiment', status: 'pending' }] },
    })
    expect(current).not.toBeNull()
    expect(current!.event.fields).toEqual({
      kind: 'todo/write',
      status: 'current',
      todos: [{ content: 'ship the experiment', status: 'pending' }],
    })

    // A foreign payload is still not a TODO fact at all.
    expect(filterEvent({ type: 'todo/write', seq: 9, data: { todos: 'no' } })).toBeNull()
  })

  it('folds a non-empty write below minEvents as an urgent wave with a Host-derived reference', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-urgent-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 })
    const session = mounted.ctx.sessions.create(SessionId('todo-urgent'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      expect(stableOf(mounted.ctx, session.id)!.todoView).toEqual({ status: 'none', items: [] })
      expect(stableOf(mounted.ctx, session.id)!.todoReferences).toEqual([])

      // ONE whole-list write, far below minEvents = 5.
      const todoSeq = appendTodo(session, LIST_A)
      expect(eligibleSeqsAbove(session, stableOf(mounted.ctx, session.id)!.sourceCursor)).toEqual([todoSeq])
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent todo wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'urgent todo audit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('urgent')
      expect(committedRow(mounted.ctx, 2).request.includedSeqs.map(Number)).toEqual([todoSeq])
      expect(committed.todoView).toEqual({
        status: 'current',
        sourceSeq: todoSeq,
        items: [
          { content: 'first durable item', status: 'pending' },
          { content: 'second durable item', status: 'in_progress' },
        ],
      })
      // Exactly ONE bounded reference, derived by the Host from the view.
      expect(committed.todoReferences).toEqual([
        { seq: todoSeq, content: 'first durable item [pending]; second durable item [in_progress]' },
      ])
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).toContain(`TODO list (session event ${todoSeq}):`)
      expect(injected).toContain('- [pending] first durable item')
      expect(injected).toContain('- [in_progress] second durable item')
      // The frame told the model the list was REPLACED, and showed it the list.
      const frame = mounted.adapter.requests[1]!.frame
      expect(frame.authorityViews.changed).toEqual(['todo'])
      expect(frame.authorityViews.cleared).toEqual([])
      expect(frame.authorityViews.todo).toEqual({
        status: 'current',
        sourceSeq: todoSeq,
        items: [
          { content: 'first durable item', status: 'pending' },
          { content: 'second durable item', status: 'in_progress' },
        ],
      })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('clears the committed list, the derived reference, and the injection below minEvents', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-clear-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = mounted.ctx.sessions.create(SessionId('todo-clear'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      const todoSeq = appendTodo(session, LIST_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'todo wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'todo audit')
      expect(stableOf(mounted.ctx, session.id)!.todoReferences.length).toBe(1)

      // The user clears the whole list: a legal empty write, ONE eligible event.
      const clearSeq = appendTodo(session, [])
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 3, 5_000, 'clear wave')
      await waitForFinishedAudit(mounted.ctx, 3, 'clear audit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, 3)).toBe('urgent')
      expect(committedRow(mounted.ctx, 3).request.includedSeqs.map(Number)).toEqual([clearSeq])
      // The clear is a state, not an absence: the view still says WHICH write
      // cleared the list, and the cleared list leaves no reference behind.
      expect(committed.todoView).toEqual({ status: 'cleared', sourceSeq: clearSeq, items: [] })
      expect(committed.todoReferences).toEqual([])
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).toContain('TODO list: cleared (the authoritative list is empty).')
      expect(injected).not.toContain('first durable item')
      expect(injected).not.toContain('second durable item')
      expect(injected).not.toContain('TODO references:')
      expect(injected).not.toContain(`TODO list (session event ${todoSeq})`)
      const frame = mounted.adapter.requests[2]!.frame
      expect(frame.authorityViews.changed).toEqual(['todo'])
      expect(frame.authorityViews.cleared).toEqual(['todo'])
      expect(frame.authorityViews.todo).toEqual({ status: 'cleared', sourceSeq: clearSeq, items: [] })
      expect(frame.previousStable).toMatchObject({ todoView: { status: 'current', sourceSeq: todoSeq } })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('cannot resurrect a cleared list through a model-authored todo reference', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-forged-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'boot' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('todo-forged'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      const todoSeq = appendTodo(session, LIST_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'todo wave')

      // The model keeps claiming the old list after the clear, with a reference
      // it wrote itself.
      adapter.output = candidate({
        objective: 'the list is still there',
        facts: ['observed the user clearing the list'],
        todoReference: { seq: todoSeq, content: 'first durable item [pending]; second durable item [in_progress]' },
      })
      appendTodo(session, [])
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 3, 5_000, 'clear wave')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.todoView.status).toBe('cleared')
      expect(committed.todoReferences).toEqual([])
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).toContain('TODO list: cleared (the authoritative list is empty).')
      expect(injected).not.toContain('first durable item')
      expect(injected).toContain('- observed the user clearing the list')
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('replaces the list and its sourceSeq on a later write, with no stale item left', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-replace-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = mounted.ctx.sessions.create(SessionId('todo-replace'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const firstSeq = appendTodo(session, LIST_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'first todo wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'first todo audit')
      expect(stableOf(mounted.ctx, session.id)!.todoView).toMatchObject({ status: 'current', sourceSeq: firstSeq })

      const secondSeq = appendTodo(session, LIST_B)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'replacement wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'replacement audit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('urgent')
      expect(committed.todoView).toEqual({
        status: 'current',
        sourceSeq: secondSeq,
        items: [{ content: 'replacement item', status: 'completed' }],
      })
      expect(committed.todoReferences).toEqual([
        { seq: secondSeq, content: 'replacement item [completed]' },
      ])
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).toContain(`TODO list (session event ${secondSeq}):`)
      expect(injected).toContain('- [completed] replacement item')
      expect(injected).not.toContain('first durable item')
      expect(injected).not.toContain('second durable item')
      expect(injected).not.toContain(`session event ${firstSeq}`)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('commits nothing for a failed clear wave and folds the clear in a later legal wave', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-failure-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'boot' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 4 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('todo-failure'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const todoSeq = appendTodo(session, LIST_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'todo wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'todo audit')
      const base = stableOf(mounted.ctx, session.id)!
      expect(base.todoReferences.length).toBe(1)

      // The clear's candidate is unusable: the list must survive intact.
      adapter.output = '{ not json'
      const clearSeq = appendTodo(session, [])
      await waitUntil(
        () => finishedRows(mounted.ctx).some(row => row.finished?.outcome === 'failure'),
        5_000,
        'failed clear wave',
      )
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      const failed = finishedRows(mounted.ctx).find(row => row.finished?.outcome === 'failure')!
      expect(failed.request.trigger).toBe('urgent')
      expect(stableOf(mounted.ctx, session.id)).toEqual(base)
      expect(adapter.requests.length).toBe(2)

      // A later legal wave (the threshold path) folds the retained clear.
      adapter.output = candidate({ objective: 'caught up' })
      fill(session, 3, 'after the failure')
      await waitUntil(() => stableOf(mounted.ctx, session.id)!.revision === base.revision + 1, 5_000, 'later legal wave')
      await waitForFinishedAudit(mounted.ctx, base.revision + 1, 'later audit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, committed.revision)).toBe('threshold')
      expect(committedRow(mounted.ctx, committed.revision).request.includedSeqs.map(Number)).toContain(clearSeq)
      expect(committed.todoView.status).toBe('cleared')
      expect(committed.todoReferences).toEqual([])
      expect(renderTaskStateSnapshot(committed, 8_000)).not.toContain('first durable item')
      expect(todoSeq).toBeLessThan(clearSeq)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('folds one write sequence at most once, however often its urgent request repeats', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-dedupe-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = mounted.ctx.sessions.create(SessionId('todo-dedupe'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const todoSeq = appendTodo(session, LIST_A)
      const runtime = runtimeOf(mounted.ctx, session.id)
      runtime.worker.maybeScheduleUrgent(todoSeq)
      runtime.worker.maybeScheduleUrgent(todoSeq)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'single todo wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'todo audit')
      await new Promise<void>(resolve => setTimeout(resolve, 250))
      expect(mounted.adapter.requests.length).toBe(1)
      expect(finishedRows(mounted.ctx).filter(row => row.request.trigger === 'urgent').length).toBe(1)
      expect(stableOf(mounted.ctx, session.id)!.todoView).toMatchObject({ status: 'current', sourceSeq: todoSeq })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('performs no model or storage work on the synchronous append stack', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-sync-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = mounted.ctx.sessions.create(SessionId('todo-sync'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      const requestsBefore = mounted.adapter.requests.length
      const auditBefore = auditRows(mounted.ctx).length
      const stableBefore = stableOf(mounted.ctx, session.id)!

      const clearSeq = appendTodo(session, [])
      expect(mounted.adapter.requests.length).toBe(requestsBefore)
      expect(auditRows(mounted.ctx).length).toBe(auditBefore)
      expect(stableOf(mounted.ctx, session.id)).toEqual(stableBefore)

      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent clear after the stack')
      expect(mounted.adapter.requests.length).toBe(requestsBefore + 1)
      expect(stableOf(mounted.ctx, session.id)!.todoView).toEqual({ status: 'cleared', sourceSeq: clearSeq, items: [] })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('collapses two writes observed in one tick into one urgent wave, and a write+clear ends cleared', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-coalesce-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 })
    const session = mounted.ctx.sessions.create(SessionId('todo-coalesce'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const firstSeq = appendTodo(session, LIST_A)
      const secondSeq = appendTodo(session, LIST_B)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'coalesced todo wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'coalesced audit')
      await new Promise<void>(resolve => setTimeout(resolve, 250))
      expect(mounted.adapter.requests.length).toBe(1)
      const row = committedRow(mounted.ctx, 1)
      expect(row.request.trigger).toBe('urgent')
      expect(row.request.includedSeqs.map(Number)).toEqual([firstSeq, secondSeq])
      // The newest fact wins: no item of the superseded list survives.
      expect(stableOf(mounted.ctx, session.id)!.todoView).toEqual({
        status: 'current',
        sourceSeq: secondSeq,
        items: [{ content: 'replacement item', status: 'completed' }],
      })

      // A write followed by a clear in the same tick ends CLEARED, not current.
      const thirdSeq = appendTodo(session, LIST_A)
      const fourthSeq = appendTodo(session, [])
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'coalesced clear wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'coalesced clear audit')
      await new Promise<void>(resolve => setTimeout(resolve, 250))
      expect(mounted.adapter.requests.length).toBe(2)
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.todoView).toEqual({ status: 'cleared', sourceSeq: fourthSeq, items: [] })
      expect(committed.todoReferences).toEqual([])
      expect(renderTaskStateSnapshot(committed, 8_000)).not.toContain('first durable item')
      expect(thirdSeq).toBeLessThan(fourthSeq)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('gives a clear appended during a running wave one urgent follow-up', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-inflight-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'first wave' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('todo-inflight'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      let clearSeq = -1
      // The clear lands while the write's own wave is running.
      adapter.onStream = () => {
        adapter.onStream = undefined
        adapter.output = candidate({ objective: 'second wave' })
        clearSeq = appendTodo(session, [])
      }
      appendTodo(session, LIST_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'first todo wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'first todo audit')
      expect(clearSeq).toBeGreaterThan(0)
      expect(stableOf(mounted.ctx, session.id)!.todoView.status).toBe('current')

      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent clear follow-up')
      await waitForFinishedAudit(mounted.ctx, 2, 'clear follow-up audit')
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('urgent')
      expect(committedRow(mounted.ctx, 2).request.includedSeqs.map(Number)).toEqual([clearSeq])
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.todoView).toEqual({ status: 'cleared', sourceSeq: clearSeq, items: [] })
      expect(committed.todoReferences).toEqual([])
      await new Promise<void>(resolve => setTimeout(resolve, 200))
      expect(adapter.requests.length).toBe(2)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('folds an inherited clear as a startup wave', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-startup-'))
    const sessionId = SessionId('todo-startup')
    const first = await mountComposition('sessions', 'storage', root, { minEvents: 1 })
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    const todoSeq = appendTodo(session, LIST_A)
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 1, 5_000, 'first commit')
    const baseline = first.ctx.taskState.getStable(session.id)!
    expect(baseline.todoView).toMatchObject({ status: 'current', sourceSeq: todoSeq })
    await closeProcess(first)

    // The clear is appended with NO provider mounted: it is inherited.
    const unarmed = await mountBase('sessions', 'storage', root, new FrameRecordingAdapter(candidate({ objective: 'unarmed' })))
    const resumedUnarmed = await resume(unarmed.ctx, sessionId, unarmed)
    const clearSeq = appendTodo(resumedUnarmed, [])
    expect(unarmed.adapter.requests.length).toBe(0)
    await closeProcess(unarmed)

    const third = await mountComposition('sessions', 'storage', root, { minEvents: 1 })
    const resumed = await resume(third.ctx, sessionId, third)
    await waitUntil(() => third.ctx.taskState.getStable(resumed.id)?.revision === baseline.revision + 1, 5_000, 'startup wave')
    await waitForFinishedAudit(third.ctx, baseline.revision + 1, 'startup audit')
    const committed = third.ctx.taskState.getStable(resumed.id)!
    expect(triggerOfRevision(third.ctx, baseline.revision + 1)).toBe('startup')
    expect(committedRow(third.ctx, baseline.revision + 1).request.includedSeqs.map(Number)).toEqual([clearSeq])
    expect(committed.todoView).toEqual({ status: 'cleared', sourceSeq: clearSeq, items: [] })
    expect(committed.todoReferences).toEqual([])
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(third.adapter.requests.length).toBe(1)
    await closeProcess(third)
  }, 60_000)

  it('carries the previous list forward across an ordinary window without claiming a change', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-carry-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = mounted.ctx.sessions.create(SessionId('todo-carry'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const todoSeq = appendTodo(session, LIST_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'todo wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'todo audit')
      const before = stableOf(mounted.ctx, session.id)!

      // Three ORDINARY events: no authority fact in the window at all.
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)!.revision === before.revision + 1, 5_000, 'ordinary wave')
      await waitForFinishedAudit(mounted.ctx, before.revision + 1, 'ordinary audit')
      const after = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, before.revision + 1)).toBe('threshold')
      expect(after.todoView).toEqual(before.todoView)
      expect(after.todoReferences).toEqual(before.todoReferences)
      const frame = mounted.adapter.requests[1]!.frame
      expect(frame.authorityViews.changed).toEqual([])
      expect(frame.authorityViews.cleared).toEqual([])
      expect(frame.authorityViews.todo).toEqual(before.todoView)
      expect(frame.previousStable).toMatchObject({ todoView: before.todoView })
      const injected = renderTaskStateSnapshot(after, 8_000)
      expect(injected).toContain('- [pending] first durable item')
      expect(injected).toContain(`TODO list (session event ${todoSeq}):`)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('keeps the cleared list durable across a restart with its own digest', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-todo-restart-'))
    const sessionId = SessionId('todo-restart')
    const first = await mountComposition('sessions', 'storage', root, { minEvents: 2 })
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    const todoSeq = appendTodo(session, LIST_A)
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 1, 5_000, 'todo wave')
    await waitForFinishedAudit(first.ctx, 1, 'todo audit')
    const withList = first.ctx.taskState.getStable(session.id)!
    const clearSeq = appendTodo(session, [])
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 2, 5_000, 'clear wave')
    await waitForFinishedAudit(first.ctx, 2, 'clear audit')
    const cleared = first.ctx.taskState.getStable(session.id)!
    // Clearing is a real content change: the digest moves.
    expect(cleared.digest).not.toBe(withList.digest)
    await closeProcess(first)

    const durable = await readDomain(join(root, 'storage'))
    const stored = durable?.tables.sessions[String(sessionId)]!.stable as unknown as TaskStateStable
    expect(stored.todoView).toEqual({ status: 'cleared', sourceSeq: clearSeq, items: [] })
    expect(stored.todoReferences).toEqual([])
    expect(stored.digest).toBe(cleared.digest)
    expect(todoSeq).toBeLessThan(clearSeq)

    const second = await mountComposition('sessions', 'storage', root, { minEvents: 2 })
    const resumed = await resume(second.ctx, sessionId, second)
    expect(second.ctx.taskState.getStable(resumed.id)?.todoView).toEqual(cleared.todoView)
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(second.adapter.requests.length).toBe(0)
    await closeProcess(second)
  }, 60_000)
})
