/**
 * B4.2 · Goal authority (R-P1-6): an authoritative named view, replaced by a
 * newer revision, folded by an `urgent` wave, and never re-injected once
 * superseded or cleared.
 *
 * The questions this spec answers, one test each:
 *  1. does a `goal/change` project an identity a view can be built from, and
 *     does its clear tombstone project the identity it cleared?
 *  2. is a Goal REPLACEMENT folded below `minEvents`, and is that wave recorded
 *     as `urgent` on its durable audit row?
 *  3. is ZERO model/storage work performed on the synchronous append stack?
 *  4. does the delivered model frame state which views the window changed or
 *     cleared, while an ordinary window stays a plain fact delta?
 *  5. does an authority fact that arrives DURING a running wave earn exactly one
 *     `urgent` follow-up instead of waiting for the threshold?
 *  6. are `startup`/`threshold`/`urgent`/`trailing`/`manual` distinguishable in
 *     the durable audit?
 *  7. is one eligible authority sequence folded at most once, however many times
 *     its urgent request is repeated?
 *  8. do two authority facts observed in one tick collapse into ONE urgent wave?
 *  9. does a failed urgent wave commit nothing (no ghost revision) and leave the
 *     authority fact for a later legal wave?
 * 10. does a cleared Goal render as an explicit clear, and can the superseded
 *     objective come back through the model narrative?
 * 11. does a durable record WITHOUT the authoritative views fail closed?
 * 12. does a startup wave fold an inherited Goal change as `startup`?
 *
 * Composition: real `SessionStore`, real JSONL session persistence, real
 * `Storage` + `StorageJson` + `StorageDomain`, real `LlmRuntime`, and the REAL
 * `TaskStateBasicService`. The only fake is the scripted LLM adapter, which
 * records every request (the framed projection it received) and can be hooked
 * mid-stream. No test ever constructs a `TaskStateWorker` or calls `observe`:
 * every wave below is admitted by the production provider path.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const GOAL_A = { id: 'goal-a', revision: 1, phase: 'active', objective: 'Ship the font-rendering pipeline for the web client.' }
const GOAL_B = { id: 'goal-b', revision: 3, phase: 'active', objective: 'Abandon the font work and migrate billing to Postgres.' }
const GOAL_C = { id: 'goal-c', revision: 7, phase: 'active', objective: 'Freeze the billing migration and fix the login outage.' }

/** The authority block of one delivered frame, as this spec reads it. */
interface FrameAuthority {
  readonly goal: { readonly status: string; readonly objective?: string; readonly goalId?: string; readonly goalRevision?: number; readonly phase?: string }
  readonly todo: { readonly status: string; readonly sourceSeq?: number; readonly items: readonly { readonly content: string; readonly status: string }[] }
  readonly changed: readonly string[]
  readonly cleared: readonly string[]
}

/** The framed projection one request received. */
interface Frame {
  readonly previousStable: { readonly goalView?: unknown; readonly todoView?: unknown; readonly todoReferences?: unknown } | null
  readonly authorityViews: FrameAuthority
  readonly filterVersion: string
  readonly inputSchemaVersion: number
  readonly events: readonly { readonly seq: number; readonly type: string }[]
}

/** One recorded auxiliary request. */
interface RequestRow {
  readonly frame: Frame
  readonly includedSeqs: readonly number[]
}

/** Candidate JSON for one attempt, with an optional echoing model narrative. */
function candidate(options: {
  readonly objective: string
  readonly focus?: string
  readonly facts?: readonly string[]
}): string {
  return JSON.stringify({
    facts: (options.facts ?? [`folded the window: ${options.objective}`]).map(content => ({ content })),
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    continuation: {
      currentObjective: options.objective,
      currentFocus: options.focus ?? 'observing the authority wave',
      openWork: [],
      nextActions: [],
    },
  })
}

/**
 * Scripted adapter that records the frame it received and can be hooked
 * synchronously inside `stream` (before any yield), which is how this spec
 * appends an authority fact WHILE a wave is running.
 */
class FrameRecordingAdapter extends LlmAdapter {
  readonly requests: RequestRow[] = []
  /** Output for every later request. */
  output: string
  /** Test hook fired synchronously inside `stream`, before any yield. */
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
  throw new Error('task-state-goal-authority: no framed projection was delivered to the adapter')
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
async function mountBase(sessionRootName: string, storageRootName: string, scratch: string, adapter: FrameRecordingAdapter): Promise<Mounted> {
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

/** Mount the base stack plus the real task-state provider, and await its init. */
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
 * Append one durable `goal/change` snapshot and return its seq. `goal/change`
 * is a LOG-ONLY event: it is surface-ineligible, so no `surfaceOp` may be
 * passed. This workspace does not depend on the goal plugin, so the session
 * event map is widened for the call and the payload stays the real DSH
 * contract.
 */
function appendGoal(session: Session, goal: {
  readonly id: string
  readonly revision: number
  readonly phase?: string
  readonly objective: string
}): number {
  const live = session as unknown as { append(type: string, data: unknown): { seq: number } }
  return Number(live.append('goal/change', {
    operation: 'change',
    goal: {
      id: goal.id,
      revision: goal.revision,
      ...(goal.phase === undefined ? {} : { phase: goal.phase }),
      objective: goal.objective,
    },
    roundsStarted: 1,
  }).seq)
}

/** Append one durable `goal/change` clear tombstone and return its seq. */
function appendGoalClear(session: Session): number {
  const live = session as unknown as { append(type: string, data: unknown): { seq: number } }
  return Number(live.append('goal/change', { operation: 'clear' }).seq)
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
    if (Date.now() - start > timeoutMs) throw new Error(`task-state-goal-authority: ${label} did not settle in time`)
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

/** The finished audit rows of one Session, ordered by committed revision. */
function finishedRows(ctx: Context): TaskStateAuditRecord[] {
  return auditRows(ctx)
    .filter(row => row.finished !== undefined)
    .sort((left, right) => left.request.revision - right.request.revision)
}

/**
 * The commit trigger recorded for one COMMITTED revision. A failed attempt
 * records the same target revision, so a finished failure row is never read as
 * the reason that revision was committed.
 */
function triggerOfRevision(ctx: Context, revision: number): TaskStateUpdateTrigger | undefined {
  return finishedRows(ctx)
    .find(row => row.request.revision === revision && row.finished?.outcome !== 'failure')
    ?.request.trigger
}

/** The durable audit row that committed one revision (never the failed attempt). */
function committedRow(ctx: Context, revision: number): TaskStateAuditRecord {
  const row = finishedRows(ctx)
    .find(candidate => candidate.request.revision === revision && candidate.finished?.outcome !== 'failure')
  if (row === undefined) throw new Error(`task-state-goal-authority: no committed audit row for revision ${revision}`)
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
 * an empty backlog. A Session is created before its first events arrive, so this
 * is the production order; without it the runtime-creation startup check can win
 * the race against the events appended in the same tick and legitimately record
 * the first wave as `startup` instead of `threshold`.
 */
async function settleStartupCheck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 30))
}

/**
 * The CONCRETE provider behind `ctx.taskState`. The published service type is
 * the read-only consumer surface, so the two production seams this spec drives
 * (the committed-stable subscription and the manual edit path) are reached the
 * same way `tests/task-state-startup-backlog.spec.ts` reaches the audit table.
 */
function providerOf(ctx: Context): TaskStateBasicService {
  return ctx.get('taskState') as TaskStateBasicService
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
  const runtimes = (provider as unknown as { runtimes: Map<SessionId, { worker: { maybeScheduleUrgent: (seq: number) => void } }> }).runtimes
  const runtime = runtimes.get(id)
  if (runtime === undefined) throw new Error('task-state-goal-authority: no runtime for the session')
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

describe('task-state Goal authority (B4.2)', () => {
  it('projects a goal/change identity and the identity its clear tombstone removed', () => {
    const change = filterEvent({
      type: 'goal/change',
      seq: 21,
      data: { operation: 'change', goal: GOAL_B, roundsStarted: 2 },
    })
    expect(change).not.toBeNull()
    expect(change!.event.fields).toMatchObject({
      kind: 'goal/change',
      operation: 'change',
      goal: {
        id: GOAL_B.id,
        revision: GOAL_B.revision,
        phase: GOAL_B.phase,
        objective: GOAL_B.objective,
        roundsStarted: 2,
      },
    })

    // The clear tombstone carries the identity it cleared, flattened onto the
    // projected fields: without that identity a view could not tell WHICH goal
    // was removed.
    const cleared = filterEvent({
      type: 'goal/change',
      seq: 22,
      data: {
        kind: 'goal/change',
        version: 1,
        operation: 'clear',
        cleared: { id: GOAL_B.id, revision: GOAL_B.revision },
        clearedAt: 1_700_000_000_500,
      },
    })
    expect(cleared).not.toBeNull()
    expect(cleared!.event.fields).toMatchObject({
      kind: 'goal/change',
      operation: 'clear',
      clearedId: GOAL_B.id,
      clearedRevision: GOAL_B.revision,
    })

    // A malformed snapshot still projects nothing at all.
    expect(filterEvent({ type: 'goal/change', seq: 23, data: { operation: 'change' } })).toBeNull()
  })

  it('folds a Goal replacement below minEvents and records the wave as urgent', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-urgent-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'bootstrap' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-urgent'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      // Wave 1: the ordinary threshold path, with no goal fact in the log yet.
      await settleStartupCheck()
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      expect(triggerOfRevision(mounted.ctx, 1)).toBe('threshold')
      expect(adapter.requests.length).toBe(1)
      expect(stableOf(mounted.ctx, session.id)!.goalView).toEqual({ status: 'none' })

      // Goal A arrives: ONE eligible event, far below minEvents = 5.
      const goalSeqA = appendGoal(session, GOAL_A)
      expect(eligibleSeqsAbove(session, stableOf(mounted.ctx, session.id)!.sourceCursor)).toEqual([goalSeqA])
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent wave for goal A')
      await waitForFinishedAudit(mounted.ctx, 2, 'urgent audit for A')
      const afterA = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('urgent')
      expect(committedRow(mounted.ctx, 2).request.includedSeqs.map(Number)).toEqual([goalSeqA])
      expect(afterA.goalView).toEqual({
        status: 'current',
        goalId: GOAL_A.id,
        goalRevision: GOAL_A.revision,
        phase: GOAL_A.phase,
        objective: GOAL_A.objective,
      })
      const injectedA = renderTaskStateSnapshot(afterA, 8_000)
      expect(injectedA).toContain(`Current goal: ${GOAL_A.objective}`)
      expect(injectedA).toContain(`Goal identity: goal ${GOAL_A.id}, revision ${GOAL_A.revision}, phase ${GOAL_A.phase}`)

      // Goal A is REPLACED by the unrelated Goal B: still one event, still
      // below the threshold, and the committed view must now be B alone.
      const goalSeqB = appendGoal(session, GOAL_B)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 3, 5_000, 'urgent wave for goal B')
      await waitForFinishedAudit(mounted.ctx, 3, 'urgent audit for B')
      const afterB = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, 3)).toBe('urgent')
      expect(afterB.goalView.goalId).toBe(GOAL_B.id)
      expect(afterB.goalView.goalRevision).toBe(GOAL_B.revision)
      expect(afterB.goalView.objective).toBe(GOAL_B.objective)
      const injectedB = renderTaskStateSnapshot(afterB, 8_000)
      expect(injectedB).toContain(GOAL_B.objective)
      expect(injectedB).not.toContain(GOAL_A.objective)
      expect(injectedB).not.toContain(GOAL_A.id)
      expect(afterB.sourceCursor).toBe(goalSeqB)
      // Two authority facts, two waves, two requests: no threshold wave ran.
      expect(adapter.requests.length).toBe(3)
      expect(finishedRows(mounted.ctx).map(row => row.request.trigger)).toEqual(['threshold', 'urgent', 'urgent'])
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('performs no model or storage work on the synchronous append stack', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-sync-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 })
    const session = mounted.ctx.sessions.create(SessionId('goal-sync'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')

      const requestsBefore = mounted.adapter.requests.length
      const auditBefore = auditRows(mounted.ctx).length
      const stableBefore = stableOf(mounted.ctx, session.id)!
      const published: number[] = []
      providerOf(mounted.ctx).subscribeCommitted((_id: SessionId, stable: TaskStateStable) => { published.push(stable.revision) })

      // The append itself must put NOTHING on the wire: the urgent request is
      // only queued on a microtask, so at the end of the synchronous stack the
      // pointer, the durable audit, and the model request count are untouched.
      const goalSeq = appendGoal(session, GOAL_A)
      expect(Number(session.eventAt(goalSeq as never)?.seq)).toBe(goalSeq)
      expect(mounted.adapter.requests.length).toBe(requestsBefore)
      expect(auditRows(mounted.ctx).length).toBe(auditBefore)
      expect(stableOf(mounted.ctx, session.id)).toEqual(stableBefore)
      expect(published).toEqual([])

      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent wave after the stack')
      expect(published).toEqual([2])
      expect(mounted.adapter.requests.length).toBe(requestsBefore + 1)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('states in the delivered frame which views the window changed or cleared', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-frame-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 })
    const session = mounted.ctx.sessions.create(SessionId('goal-frame'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      // An ordinary window is a plain fact delta: nothing was replaced, nothing
      // was cleared, and the stable carries no authority at all.
      const ordinary = mounted.adapter.requests[0]!.frame
      expect(ordinary.authorityViews.changed).toEqual([])
      expect(ordinary.authorityViews.cleared).toEqual([])
      expect(ordinary.authorityViews.goal.status).toBe('none')
      expect(ordinary.previousStable).toBeNull()
      expect(ordinary.inputSchemaVersion).toBe(2)
      expect(ordinary.filterVersion).toBe('task-state-basic/filter-v3')

      appendGoal(session, GOAL_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent wave')
      const replacing = mounted.adapter.requests[1]!.frame
      expect(replacing.authorityViews.changed).toEqual(['goal'])
      expect(replacing.authorityViews.cleared).toEqual([])
      expect(replacing.authorityViews.goal).toMatchObject({
        status: 'current',
        goalId: GOAL_A.id,
        goalRevision: GOAL_A.revision,
        objective: GOAL_A.objective,
      })
      // The frame shows the model the committed views it must not contradict.
      expect(replacing.previousStable).toMatchObject({ goalView: { status: 'none' } })

      appendGoalClear(session)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 3, 5_000, 'urgent wave for the clear')
      const clearing = mounted.adapter.requests[2]!.frame
      // A clear IS a change of the committed view, so it appears in `changed`;
      // `cleared` is the precise subset marker that says the view was emptied
      // rather than merely replaced by another current value.
      expect(clearing.authorityViews.changed).toEqual(['goal'])
      expect(clearing.authorityViews.cleared).toEqual(['goal'])
      expect(clearing.authorityViews.goal).toEqual({ status: 'cleared' })
      expect(clearing.previousStable).toMatchObject({ goalView: { status: 'current' } })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('gives an authority fact that arrives during a running wave one urgent follow-up', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-inflight-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'first wave' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-inflight'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      let goalSeq = -1
      // The goal change lands INSIDE the first wave, while the worker is active
      // and its own window is already snapped.
      adapter.onStream = () => {
        adapter.onStream = undefined
        adapter.output = candidate({ objective: 'second wave' })
        goalSeq = appendGoal(session, GOAL_C)
      }
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'first wave')
      expect(goalSeq).toBeGreaterThan(0)
      await waitForFinishedAudit(mounted.ctx, 1, 'first wave audit')
      expect(triggerOfRevision(mounted.ctx, 1)).toBe('threshold')

      // The deferred authority fact must NOT wait for the threshold: the one
      // legal follow-up of the running wave is itself urgent.
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent follow-up')
      await waitForFinishedAudit(mounted.ctx, 2, 'follow-up audit')
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('urgent')
      expect(committedRow(mounted.ctx, 2).request.includedSeqs.map(Number)).toEqual([goalSeq])
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.goalView).toMatchObject({ status: 'current', goalId: GOAL_C.id, objective: GOAL_C.objective })
      expect(committed.sourceCursor).toBe(goalSeq)
      // Exactly two waves: the follow-up is not repeated over an empty tail.
      await new Promise<void>(resolve => setTimeout(resolve, 200))
      expect(adapter.requests.length).toBe(2)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('distinguishes startup, threshold, urgent, trailing, and manual in the durable audit', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-triggers-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'threshold wave' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-triggers'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      // threshold: the ordinary path.
      await settleStartupCheck()
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      expect(triggerOfRevision(mounted.ctx, 1)).toBe('threshold')

      // urgent: ONE authority fact, far below the threshold, folds on its own.
      const goalSeq = appendGoal(session, GOAL_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'urgent wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'urgent audit')
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('urgent')
      expect(committedRow(mounted.ctx, 2).request.includedSeqs.map(Number)).toEqual([goalSeq])

      // trailing: an ORDINARY event appended while a THRESHOLD wave runs, below
      // the threshold — it waits for that wave's single follow-up, which is
      // trailing.
      let extraSeq = -1
      adapter.onStream = () => {
        adapter.onStream = undefined
        extraSeq = appendUser(session, 'ordinary event during the wave')
      }
      fill(session, 3, 'catch-up')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 3, 5_000, 'threshold wave with a tail')
      await waitForFinishedAudit(mounted.ctx, 3, 'threshold audit with a tail')
      expect(triggerOfRevision(mounted.ctx, 3)).toBe('threshold')
      expect(extraSeq).toBeGreaterThan(0)
      await waitUntil(
        () => finishedRows(mounted.ctx).some(row => row.request.trigger === 'trailing'),
        5_000,
        'trailing tail wave',
      )
      const urgentRow = committedRow(mounted.ctx, 2)
      const trailingRow = finishedRows(mounted.ctx).find(row => row.request.trigger === 'trailing')!
      expect(urgentRow.request.includedSeqs.map(Number)).not.toContain(extraSeq)
      expect(trailingRow.request.includedSeqs.map(Number)).toEqual([extraSeq])
      expect(trailingRow.request.revision).toBe(4)
      // The ordinary tail is NOT relabelled urgent: the trigger says why the
      // wave ran, and no authority fact was outstanding for it.
      expect(finishedRows(mounted.ctx).filter(row => row.request.trigger === 'urgent').length).toBe(1)

      // manual: a user-authored edit is its own trigger, and it carries the
      // authoritative views forward untouched.
      const current = stableOf(mounted.ctx, session.id)!
      const edited = await providerOf(mounted.ctx).editStable({
        sessionId: session.id,
        expectedRevision: current.revision,
        value: {
          currentObjective: 'user-authored objective',
          currentFocus: 'a manual edit',
          openWork: [],
          nextActions: [],
          facts: ['a manual fact'],
          decisions: [],
          constraints: [],
          risks: [],
        },
      })
      expect(edited.ok).toBe(true)
      if (!edited.ok) return
      await waitForFinishedAudit(mounted.ctx, edited.stable.revision, 'manual audit')
      expect(triggerOfRevision(mounted.ctx, edited.stable.revision)).toBe('manual')
      expect(edited.stable.goalView).toEqual(current.goalView)
      expect(edited.stable.todoView).toEqual(current.todoView)
      expect(edited.stable.todoReferences).toEqual(current.todoReferences)

      // Every committed revision carries a distinguishable reason.
      expect(finishedRows(mounted.ctx).map(row => row.request.trigger))
        .toEqual(['threshold', 'urgent', 'threshold', 'trailing', 'manual'])
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('folds one eligible authority sequence at most once, however often its urgent request repeats', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-dedupe-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 })
    const session = mounted.ctx.sessions.create(SessionId('goal-dedupe'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      const requestsBefore = mounted.adapter.requests.length

      // One authority fact, replayed requests: the same eligible sequence may
      // never be folded by a second wave.
      const goalSeq = appendGoal(session, GOAL_A)
      const runtime = runtimeOf(mounted.ctx, session.id)
      runtime.worker.maybeScheduleUrgent(goalSeq)
      runtime.worker.maybeScheduleUrgent(goalSeq)
      runtime.worker.maybeScheduleUrgent(goalSeq - 1)

      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'single urgent wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'urgent audit')
      await new Promise<void>(resolve => setTimeout(resolve, 250))
      expect(mounted.adapter.requests.length).toBe(requestsBefore + 1)
      expect(finishedRows(mounted.ctx).filter(row => row.request.trigger === 'urgent').length).toBe(1)
      expect(stableOf(mounted.ctx, session.id)!.goalView).toMatchObject({ status: 'current', goalId: GOAL_A.id })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('collapses two authority facts observed in one tick into one urgent wave', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-coalesce-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 })
    const session = mounted.ctx.sessions.create(SessionId('goal-coalesce'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      const requestsBefore = mounted.adapter.requests.length

      // Two replacements in one synchronous tick, then one microtask batch: the
      // newest fact wins the view and the older one is never folded on its own.
      const firstSeq = appendGoal(session, GOAL_A)
      const secondSeq = appendGoal(session, GOAL_B)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'coalesced urgent wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'coalesced audit')
      await new Promise<void>(resolve => setTimeout(resolve, 250))

      expect(mounted.adapter.requests.length).toBe(requestsBefore + 1)
      const row = finishedRows(mounted.ctx).find(item => item.request.revision === 2)!
      expect(row.request.trigger).toBe('urgent')
      expect(row.request.includedSeqs.map(Number)).toEqual([firstSeq, secondSeq])
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.goalView).toMatchObject({ status: 'current', goalId: GOAL_B.id, goalRevision: GOAL_B.revision })
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).toContain(GOAL_B.objective)
      expect(injected).not.toContain(GOAL_A.objective)
      expect(committed.sourceCursor).toBe(secondSeq)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('commits nothing for a failed urgent wave and folds the fact in a later legal wave', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-failure-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'threshold wave' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 5 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-failure'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 5, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      await waitForFinishedAudit(mounted.ctx, 1, 'threshold audit')
      const base = stableOf(mounted.ctx, session.id)!

      // The urgent wave's candidate is unusable: the commit must fail closed
      // with no ghost revision and no partially applied view.
      adapter.output = 'not json at all'
      const goalSeq = appendGoal(session, GOAL_A)
      await waitUntil(
        () => finishedRows(mounted.ctx).some(row => row.finished?.outcome === 'failure'),
        5_000,
        'failed urgent wave',
      )
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      const failed = finishedRows(mounted.ctx).find(row => row.finished?.outcome === 'failure')!
      expect(failed.request.trigger).toBe('urgent')
      expect(failed.request.revision).toBe(base.revision + 1)
      expect(stableOf(mounted.ctx, session.id)).toEqual(base)
      expect(auditRows(mounted.ctx).some(row => row.finished === undefined)).toBe(false)
      // A failed cycle never auto-schedules, so the authority fact is still
      // above the cursor and no second attempt was dispatched.
      expect(adapter.requests.length).toBe(2)

      // A later legal wave (the threshold path) folds the retained fact.
      adapter.output = candidate({ objective: 'caught up' })
      fill(session, 4, 'after the failure')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === base.revision + 1, 5_000, 'later legal wave')
      await waitForFinishedAudit(mounted.ctx, base.revision + 1, 'later audit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, committed.revision)).toBe('threshold')
      expect(finishedRows(mounted.ctx).find(row => row.request.revision === committed.revision)!
        .request.includedSeqs.map(Number)).toContain(goalSeq)
      expect(committed.goalView).toMatchObject({ status: 'current', goalId: GOAL_A.id, objective: GOAL_A.objective })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('renders a cleared Goal as an explicit clear and never revives the superseded objective', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-clear-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'bootstrap' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-clear'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      appendGoal(session, GOAL_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'goal wave')

      // From here the model keeps writing the OLD objective into the narrative,
      // and nothing else in its candidate mentions the removed goal.
      adapter.output = candidate({
        objective: GOAL_A.objective,
        focus: 'still thinking about goal A',
        facts: ['observed the goal being cleared'],
      })
      const clearSeq = appendGoalClear(session)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 3, 5_000, 'clear wave')
      await waitForFinishedAudit(mounted.ctx, 3, 'clear audit')
      const cleared = stableOf(mounted.ctx, session.id)!
      expect(triggerOfRevision(mounted.ctx, 3)).toBe('urgent')
      expect(cleared.goalView).toEqual({ status: 'cleared' })
      expect(cleared.sourceCursor).toBe(clearSeq)
      // The model DID restate the removed objective, and the committed narrative
      // still carries it — the renderer is what refuses to present it as a goal.
      expect(cleared.continuation.currentObjective).toBe(GOAL_A.objective)
      const injected = renderTaskStateSnapshot(cleared, 8_000)
      expect(injected).toContain('Current goal: cleared (no authoritative goal is set).')
      expect(injected).toContain('- observed the goal being cleared')
      expect(injected).not.toContain(GOAL_A.objective)
      expect(injected).not.toContain('Current objective:')
      expect(injected).not.toContain(`goal ${GOAL_A.id}`)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('fails closed on a durable record that carries no authoritative views', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-cleanbreak-'))
    const sessionId = SessionId('goal-cleanbreak')
    const first = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    fill(session, 3, 'progress')
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 1, 5_000, 'first commit')
    await closeProcess(first)

    // Strip the authoritative views out of the durable record: this is exactly
    // the pre-B4.2 shape, and there is NO migration, fallback, or reading of it.
    const path = join(root, 'storage', DOMAIN_FILE)
    const doc = JSON.parse(await readFile(path, 'utf8')) as DomainDoc
    const record = doc.tables.sessions[String(sessionId)]!
    expect(record.stable['goalView']).toBeDefined()
    delete record.stable['goalView']
    delete record.stable['todoView']
    await writeFile(path, JSON.stringify(doc), 'utf8')

    const second = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const resumed = await resume(second.ctx, sessionId, second)
    appendGoal(resumed, GOAL_B)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    // The provider cannot serve or repair such a record: no stable is published
    // and no model call is attempted, instead of silently falling back.
    expect(second.ctx.taskState.getStable(resumed.id)).toBeUndefined()
    expect(second.adapter.requests.length).toBe(0)
    await closeProcess(second)
  }, 60_000)

  it('folds an inherited Goal change as a startup wave', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-startup-'))
    const sessionId = SessionId('goal-startup')
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'bootstrap' }))
    const first = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    fill(session, 3, 'progress')
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 1, 5_000, 'first commit')
    const baseline = first.ctx.taskState.getStable(session.id)!
    await closeProcess(first)

    // Append an inherited backlog (two ordinary events plus the Goal change)
    // while NO provider is mounted, so every fact is inherited rather than
    // observed, and the backlog itself crosses minEvents.
    const unarmed = await mountBase('sessions', 'storage', root, new FrameRecordingAdapter(candidate({ objective: 'unarmed' })))
    const resumedUnarmed = await resume(unarmed.ctx, sessionId, unarmed)
    const inheritedUsers = [appendUser(resumedUnarmed, 'inherited one'), appendUser(resumedUnarmed, 'inherited two')]
    const goalSeq = appendGoal(resumedUnarmed, GOAL_B)
    expect(unarmed.adapter.requests.length).toBe(0)
    await closeProcess(unarmed)

    const third = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    // Observe the publication order instead of guessing a timing: the recovered
    // durable baseline must be published FIRST and with ZERO model requests, and
    // only the startup wave after it may dispatch one.
    const published: { revision: number; requestsAtPublish: number }[] = []
    providerOf(third.ctx).subscribeCommitted((_id: SessionId, stable: TaskStateStable) => {
      published.push({ revision: stable.revision, requestsAtPublish: third.adapter.requests.length })
    })
    const resumed = await resume(third.ctx, sessionId, third)
    expect(published[0]).toEqual({ revision: baseline.revision, requestsAtPublish: 0 })
    await waitUntil(() => third.ctx.taskState.getStable(resumed.id)?.revision === baseline.revision + 1, 5_000, 'startup wave')
    await waitForFinishedAudit(third.ctx, baseline.revision + 1, 'startup audit')
    const committed = third.ctx.taskState.getStable(resumed.id)!
    expect(triggerOfRevision(third.ctx, baseline.revision + 1)).toBe('startup')
    expect(committedRow(third.ctx, baseline.revision + 1).request.includedSeqs.map(Number))
      .toEqual([...inheritedUsers, goalSeq])
    expect(committed.goalView).toMatchObject({ status: 'current', goalId: GOAL_B.id, objective: GOAL_B.objective })
    expect(published[1]).toEqual({ revision: baseline.revision + 1, requestsAtPublish: 1 })
    // One startup wave, no urgent duplicate over the same sequence. (The table
    // also holds the durable stage-1 row, which is why the count is scoped to
    // the revisions this stage committed.)
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(third.adapter.requests.length).toBe(1)
    expect(finishedRows(third.ctx).filter(row => row.request.revision > baseline.revision).length).toBe(1)
    await closeProcess(third)
  }, 60_000)

  it('carries the authoritative Goal view across a durable restart without refolding it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-restart-'))
    const sessionId = SessionId('goal-restart')
    const first = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    fill(session, 3, 'progress')
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 1, 5_000, 'first commit')
    appendGoal(session, GOAL_A)
    await waitUntil(() => first.ctx.taskState.getStable(session.id)?.revision === 2, 5_000, 'goal wave')
    const committed = first.ctx.taskState.getStable(session.id)!
    await closeProcess(first)

    const durable = await readDomain(join(root, 'storage'))
    const stored = durable?.tables.sessions[String(sessionId)]!.stable as unknown as TaskStateStable
    expect(stored.goalView).toEqual(committed.goalView)
    expect(stored.digest).toBe(committed.digest)

    const second = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const resumed = await resume(second.ctx, sessionId, second)
    // The recovered baseline already carries the authoritative view, so no
    // deferred backlog wave exists and nothing is refolded.
    expect(second.ctx.taskState.getStable(resumed.id)?.goalView).toEqual(committed.goalView)
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect(second.adapter.requests.length).toBe(0)
    expect(second.ctx.taskState.getStable(resumed.id)).toEqual(committed)
    await closeProcess(second)
  }, 60_000)

  it('keeps the assistant-visible narrative when no authoritative Goal exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-none-'))
    const adapter = new FrameRecordingAdapter(candidate({ objective: 'no goal plugin here' }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-none'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.goalView).toEqual({ status: 'none' })
      // With no authority fact in the log, the model-authored objective is the
      // only objective there is and it still renders (B4.2 does not remove the
      // continuation narrative for Sessions that have no Goal at all).
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).toContain('Current objective: no goal plugin here')
      expect(injected).not.toContain('Current goal:')
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('records no authority change for an unchanged Goal snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-idempotent-'))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 })
    const session = mounted.ctx.sessions.create(SessionId('goal-idempotent'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      const goalSeq = appendGoal(session, GOAL_A)
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'first goal wave')
      await waitForFinishedAudit(mounted.ctx, 1, 'first goal audit')
      expect(finishedRows(mounted.ctx)[0]!.request.includedSeqs.map(Number)).toEqual([goalSeq])

      // A re-emitted identical snapshot (same id, revision, objective) resolves
      // to the SAME view as the committed one: it is not a material change, so
      // it must not admit an urgent wave of its own.
      const sameSeq = appendGoal(session, GOAL_A)
      await new Promise<void>(resolve => setTimeout(resolve, 300))
      expect(mounted.adapter.requests.length).toBe(1)
      expect(stableOf(mounted.ctx, session.id)!.revision).toBe(1)
      expect(eligibleSeqsAbove(session, stableOf(mounted.ctx, session.id)!.sourceCursor)).toEqual([sameSeq])

      // The retained event is folded by the next legal threshold wave, so
      // "not urgent" is never "never folded".
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)!.revision === 2, 5_000, 'later threshold wave')
      await waitForFinishedAudit(mounted.ctx, 2, 'later audit')
      expect(triggerOfRevision(mounted.ctx, 2)).toBe('threshold')
      expect(stableOf(mounted.ctx, session.id)!.goalView).toMatchObject({ status: 'current', goalId: GOAL_A.id })
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('keeps the committed Goal view out of model-authored candidate fields', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-goal-hostile-'))
    const adapter = new FrameRecordingAdapter(JSON.stringify({
      facts: [],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      // A hostile/confused model proposes views and references of its own.
      goalView: { status: 'current', goalId: 'goal-forged', goalRevision: 99, objective: 'forged objective' },
      todoView: { status: 'current', sourceSeq: 1, items: [{ content: 'forged item', status: 'pending' }] },
      todoReferences: [{ seq: 1, content: 'forged reference' }],
      continuation: { currentObjective: 'forged', currentFocus: '', openWork: [], nextActions: [] },
    }))
    const mounted = await mountComposition('sessions', 'storage', root, { minEvents: 3 }, adapter)
    const session = mounted.ctx.sessions.create(SessionId('goal-hostile'), {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      fill(session, 3, 'progress')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'threshold commit')
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.goalView).toEqual({ status: 'none' })
      expect(committed.todoView).toEqual({ status: 'none', items: [] })
      expect(committed.todoReferences).toEqual([])
      const injected = renderTaskStateSnapshot(committed, 8_000)
      expect(injected).not.toContain('forged objective')
      expect(injected).not.toContain('forged item')
      expect(injected).not.toContain('forged reference')
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)
})
