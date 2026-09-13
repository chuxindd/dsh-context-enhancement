/**
 * B4.3 · infeasible-window progress, quarantine provenance and fail-closed
 * corners.
 *
 * The questions this spec answers, one test each:
 *  1. is an infeasible window quarantined as ONE measured culprit sequence, with
 *     durable terminal provenance on the SAME authoritative record, and is the
 *     whole window never skipped?
 *  2. does a restart refuse to re-attempt (and therefore never re-pays for) a
 *     window that is already durably quarantined, while NEW facts still open a
 *     new generation of processing?
 *  3. is an authority fact (`todo/write`, `goal/change`) NEVER quarantined, and
 *     is the committed authoritative view left intact instead of being cleared
 *     or replaced by a fabricated empty one?
 *  4. is a transient infrastructure failure recorded as a retryable failure that
 *     writes no terminal verdict and advances no cursor?
 *  5. when the committed stable — not the log — is what cannot fit the budget,
 *     does the provider refuse to grind the log into quarantined events, keep the
 *     cursor exactly where it was, and blame no sequence at all?
 *  6. is an infeasible window BEFORE the first commit quarantined durably on the
 *     record's own identity — never "fixed" by manufacturing an empty authority
 *     stable?
 *
 * B4.4 note: this spec was written against the B4.3 contract, where an
 * infeasible window before the first commit recorded NOTHING and the two
 * non-event causes were silent fail-closed corners. B4.4 gives them an
 * independent durable home, so the assertions below were adapted — the
 * invariants this spec owns (no fabricated stable, no blamed authority fact, no
 * cursor advance for a non-event cause, no lost pending tail) are unchanged and
 * still asserted exactly. The typed blocked provenance itself is pinned by
 * `task-state-terminal-generation.spec.ts`.
 *
 * Composition: real `SessionStore`, real JSONL session persistence, real
 * `Storage` + `StorageJson` + `StorageDomain`, real `LlmRuntime`, and the REAL
 * `TaskStateBasicService`. The only fake is the scripted LLM adapter. No test
 * constructs a `TaskStateWorker` or calls `observe`: every wave below is
 * admitted by the production provider path, and every assertion about durable
 * state reads the real JSON domain document.
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
import { classifyAuditRow } from '../src/task-state.ts'
import type { TaskStateQuarantinedVerdict, TaskStateStable, TaskStateTerminalRecord } from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import { filterEvent, isEligibleType } from '../src/internal/task-state/basic/filter.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'

/**
 * Deployment-shaped config. `maxInputBytes` is deliberately the budget the
 * infeasible tests move: the empty frame is 201 bytes, so a 1 500-byte budget
 * admits a small ordinary window and rejects one oversized event on its own.
 */
const BASE_CONFIG: TaskStateBasicConfig = {
  provider: 'current-route',
  model: 'current-model',
  minEvents: 1,
  maxEvents: 200,
  maxInputBytes: 1_500,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 500,
  maxListItems: 8,
}

const PROVIDER = 'current-route'
const CREATED_AT = 1_700_000_000_000
const DOMAIN_FILE = 'context_enhancement_task_state_v2.json'

/** One oversized ordinary fact: its own frame (3 275 bytes) exceeds the budget. */
const OVERSIZED_TEXT = 'x'.repeat(3_000)

/** A small candidate whose committed stable keeps the NEXT base frame feasible. */
const SMALL_CANDIDATE = JSON.stringify({
  facts: [{ content: 'baseline fact' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [],
  continuation: {
    currentObjective: 'keep the baseline',
    currentFocus: 'bootstrapping',
    openWork: [],
    nextActions: [],
  },
})

/** One scripted answer for a single adapter call. */
type Script =
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'finish-error'; readonly code: string; readonly message: string }

/** Adapter that replays one script entry per request and records every frame. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: { readonly includedSeqs: readonly number[] }[] = []

  constructor(private readonly script: Script[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script[Math.min(this.requests.length, this.script.length - 1)]
    this.requests.push({ includedSeqs: readFrameSeqs(options) })
    if (entry !== undefined && entry.kind === 'finish-error') {
      // A streamed provider failure: the finish reason is what the update layer
      // classifies, so this is the real TRANSIENT_LLM path (a thrown adapter
      // error is wrapped by the runtime and loses its code).
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: entry.code, message: entry.message } } }
      return
    }
    const body = entry === undefined ? SMALL_CANDIDATE : entry.text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The eligible sequences of the frame one request received. */
function readFrameSeqs(options: GenerateOptions): number[] {
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
      const parsed = JSON.parse(text) as { readonly events?: readonly { readonly seq: number }[] }
      if (Array.isArray(parsed.events)) return parsed.events.map(event => Number(event.seq))
    } catch {
      // Not the frame: keep looking.
    }
  }
  throw new Error('task-state-infeasible-progress: no framed projection was delivered to the adapter')
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
  readonly adapter: ScriptedAdapter
  readonly storageRoot: string
  readonly held: { preparation: unknown; detach: () => void }[]
}

/** Mount sessions + real storage/domain + llm, WITHOUT the task-state provider. */
async function mountBase(scratch: string, adapter: ScriptedAdapter): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = join(scratch, 'storage')
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(scratch, 'sessions'),
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
  scratch: string,
  overrides: Partial<TaskStateBasicConfig> = {},
  script: Script[] = [{ kind: 'output', text: SMALL_CANDIDATE }],
): Promise<Mounted> {
  const adapter = new ScriptedAdapter(script)
  const mounted = await mountBase(scratch, adapter)
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

/** Append one whole-list `todo/write` (LOG-ONLY: no `surfaceOp`) and return its seq. */
function appendTodo(session: Session, todos: readonly { readonly content: string; readonly status: string }[]): number {
  const live = session as unknown as { append(type: string, data: unknown): { seq: number } }
  return Number(live.append('todo/write', { todos: [...todos] }).seq)
}

/** Append one `goal/change` snapshot (LOG-ONLY: no `surfaceOp`) and return its seq. */
function appendGoal(session: Session, objective: string): number {
  const live = session as unknown as { append(type: string, data: unknown): { seq: number } }
  return Number(live.append('goal/change', {
    operation: 'change',
    goal: { id: 'goal-a', revision: 1, phase: 'active', objective },
    roundsStarted: 1,
  }).seq)
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
  const index = contexts.indexOf(mounted.ctx)
  if (index >= 0) contexts.splice(index, 1)
}

/** Poll one predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`task-state-infeasible-progress: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Let the ONE startup backlog check of a fresh runtime run and be consumed over
 * an empty backlog, so a later wave is admitted by the threshold path.
 */
async function settleStartupCheck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 30))
}

/** Settle asynchronous scheduler work that must NOT produce anything. */
async function settleQuiet(ms = 250): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

/** The concrete provider behind `ctx.taskState` (test seam, same as B4.1/B4.2). */
function providerOf(ctx: Context): TaskStateBasicService {
  return ctx.get('taskState') as TaskStateBasicService
}

/** Every durable audit row of the live domain. */
function auditRows(ctx: Context): TaskStateAuditRecord[] {
  const table = (providerOf(ctx) as unknown as {
    auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
  }).auditTable
  if (table === undefined) return []
  return [...table.entries()].map(entry => entry[1])
}

/** The durable terminal verdict the provider serves for one Session. */
function terminalOf(ctx: Context, id: SessionId): TaskStateTerminalRecord | undefined {
  return providerOf(ctx).getTerminal(id)
}

/**
 * The provider's served verdict ASSERTED to be a quarantine — the only variant
 * that advances the effective cursor. A `block…` verdict is never a quarantine,
 * so this fails loudly instead of silently accepting one.
 * @param ctx - the mounted Context whose provider owns the verdict.
 * @param id - the Session id.
 * @returns the quarantined verdict.
 */
function quarantinedOf(ctx: Context, id: SessionId): TaskStateQuarantinedVerdict {
  const terminal = terminalOf(ctx, id)
  expect(terminal?.kind).toBe('quarantined')
  return terminal as TaskStateQuarantinedVerdict
}

/** The raw durable domain document on disk. */
interface DomainDoc {
  readonly unit?: { readonly name: string; readonly version: number }
  readonly tables: {
    readonly sessions: Record<string, {
      readonly stable?: { readonly revision: number; readonly sourceCursor: number }
      readonly terminal?: TaskStateTerminalRecord
    }>
    readonly audit: Record<string, { readonly finished?: { readonly outcome: string; readonly error?: { readonly code: string } } }>
  }
}

/** Read the durable domain document a stage left on disk, or `null`. */
async function readDomain(storageRoot: string): Promise<DomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, DOMAIN_FILE), 'utf8')) as DomainDoc
  } catch {
    return null
  }
}

/** The machine code of one row that settled as a PLAIN failure, or `undefined`. */
function failureCodeOf(row: TaskStateAuditRecord | undefined): string | undefined {
  const finished = row?.finished
  return finished !== undefined && finished.outcome === 'failure' ? finished.error.code : undefined
}

/**
 * Wait a bounded time for the DIAGNOSTIC ledger to show a settled phase.
 *
 * The audit rows are diagnostic only (B1: they are never authority), and they
 * are republished one whole document at a time: `dsh-storage-json` writes a
 * temp file and `rename()`s it over the unit, and Windows refuses that rename
 * transiently with `EPERM` when a scanner or indexer holds the target (measured
 * on this host). The provider must then treat the write as a diagnostic GAP —
 * the authoritative record is already durable — so this wait returns instead of
 * throwing and {@link expectLedger} decides what a missing row may mean.
 * @param ctx - the mounted Context whose provider owns the ledger.
 * @param predicate - whether the settled reading is visible yet.
 */
async function waitForLedger(
  ctx: Context,
  predicate: (rows: readonly TaskStateAuditRecord[]) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate(auditRows(ctx))) {
    if (Date.now() - start > timeoutMs) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Assert one DIAGNOSTIC-ledger reading without ever accepting a wrong verdict.
 *
 * A settled row that landed must satisfy `assertSettled` exactly; a completely
 * empty settled set is the documented diagnostic gap above (every remaining row
 * must then still be OPEN). Any other outcome — a row that settled with an
 * unexpected classification — fails.
 * @param rows - the live audit rows.
 * @param assertSettled - assertions that must hold for the settled rows.
 */
function expectLedger(
  rows: readonly TaskStateAuditRecord[],
  assertSettled: (settled: readonly TaskStateAuditRecord[]) => void,
): void {
  const settled = rows.filter(row => row.finished !== undefined)
  if (settled.length === 0) {
    expect(rows.every(row => row.finished === undefined)).toBe(true)
    return
  }
  assertSettled(settled)
}

/** The committed stable of one Session. */
function stableOf(ctx: Context, id: SessionId): TaskStateStable | undefined {
  return ctx.taskState.getStable(id)
}

describe('task-state infeasible progress (B4.3)', () => {
  it('quarantines exactly the measured culprit sequence with durable terminal provenance', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-quarantine-'))
    const mounted = await mountComposition(root)
    const sessionId = SessionId('infeasible-quarantine')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      // Wave 1: an ordinary, FEASIBLE window commits the baseline stable. A
      // terminal verdict needs a committed stable to be carried on.
      await settleStartupCheck()
      appendUser(session, 'baseline')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'baseline commit')
      expect(mounted.adapter.requests.length).toBe(1)
      // Let wave 1 SETTLE before the next fact arrives, so the infeasible wave is
      // admitted by its own observed event (`threshold`) rather than racing
      // into wave 1's single legal follow-up (`trailing`). Both are legal; the
      // spec pins the deterministic one.
      await settleQuiet(200)
      expect(mounted.adapter.requests.length).toBe(1)

      // Wave 2: ONE oversized ordinary fact. Its own single-event frame exceeds
      // the whole input budget, so the fold is infeasible on that measured
      // sequence — the quantifiable cause, and nothing else.
      const oversizedSeq = appendUser(session, OVERSIZED_TEXT)
      await waitUntil(() => terminalOf(mounted.ctx, session.id) !== undefined, 5_000, 'terminal quarantine')

      const terminal = quarantinedOf(mounted.ctx, session.id)
      expect(terminal.cursor).toBe(oversizedSeq)
      expect(terminal.includedSeqs).toEqual([oversizedSeq])
      expect(terminal.code).toBe('BUDGET')
      expect(terminal.trigger).toBe('threshold')
      expect(terminal.requestId.length).toBeGreaterThan(0)

      // The quarantine is not a model call: the provider never paid for the
      // impossible window.
      expect(mounted.adapter.requests.length).toBe(1)

      // The committed stable is preserved untouched and is still what the
      // provider serves; only the effective cursor moved.
      const stable = stableOf(mounted.ctx, session.id)!
      expect(stable.revision).toBe(1)
      expect(stable.facts.map(fact => fact.content)).toEqual(['baseline fact'])

      // Durable evidence: the verdict lives on the SAME authoritative sessions
      // record as the stable (one domain, one record schema).
      const doc = await readDomain(mounted.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record).toBeDefined()
      expect(record!.terminal?.kind).toBe('quarantined')
      expect(record!.terminal?.cursor).toBe(oversizedSeq)
      expect(record!.terminal!.kind === 'quarantined' ? record!.terminal!.includedSeqs : []).toEqual([oversizedSeq])
      expect(record!.stable?.revision).toBe(1)

      // The diagnostic ledger distinguishes a terminal quarantine from a commit
      // and from a retryable failure. The authority record is written FIRST, so
      // the audit pair is awaited here rather than assumed.
      await waitForLedger(mounted.ctx, rows => rows.some(row => row.finished?.outcome === 'terminal-infeasible'))
      expectLedger(auditRows(mounted.ctx), (settled) => {
        const terminalRows = settled.filter(row => row.finished?.outcome === 'terminal-infeasible')
        if (terminalRows.length === 0) {
          // Diagnostic gap: the terminal row's publish was refused, so the only
          // settled row has to be the one legitimate baseline commit.
          expect(settled.every(row => row.finished?.outcome === 'success')).toBe(true)
          return
        }
        expect(terminalRows.length).toBe(1)
        expect(classifyAuditRow(terminalRows[0]!)).toBe('terminal-infeasible')
        expect(terminalRows[0]!.request.includedSeqs).toEqual([oversizedSeq])
      })

      // Nothing re-attempts the same window: no repeat wave, no second verdict.
      await settleQuiet()
      expect(mounted.adapter.requests.length).toBe(1)
      expect(
        auditRows(mounted.ctx).filter(row => row.finished?.outcome === 'terminal-infeasible').length,
      ).toBeLessThanOrEqual(1)
      expect(terminalOf(mounted.ctx, session.id)!.requestId).toBe(terminal.requestId)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('restores the verdict across a restart without re-paying, and new facts open a new generation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-restart-'))
    const sessionId = SessionId('infeasible-restart')
    const first = await mountComposition(root)
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    await settleStartupCheck()
    appendUser(session, 'baseline')
    await waitUntil(() => stableOf(first.ctx, session.id)?.revision === 1, 5_000, 'baseline commit')
    const oversizedSeq = appendUser(session, OVERSIZED_TEXT)
    await waitUntil(() => terminalOf(first.ctx, session.id) !== undefined, 5_000, 'terminal quarantine')
    const requestId = terminalOf(first.ctx, session.id)!.requestId
    expect(first.adapter.requests.length).toBe(1)
    await closeProcess(first)

    // Stage 2: the SAME durable domain, a fresh process. The inherited tail is
    // already covered by the verdict, so the startup check must find NO backlog
    // and the provider must not re-attempt (or re-pay for) the quarantined seq.
    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await settleQuiet(400)
      expect(second.adapter.requests.length).toBe(0)

      const restored = terminalOf(second.ctx, resumed.id)
      expect(restored?.cursor).toBe(oversizedSeq)
      expect(restored?.requestId).toBe(requestId)
      expect(stableOf(second.ctx, resumed.id)?.revision).toBe(1)

      // NEW facts open a new generation: a later legal wave folds from the
      // recovered effective cursor and commits the next revision.
      const freshSeq = appendUser(resumed, 'a later legal fact')
      await waitUntil(() => stableOf(second.ctx, resumed.id)?.revision === 2, 5_000, 'new generation commit')
      expect(second.adapter.requests.length).toBe(1)
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([freshSeq])
      const committed = stableOf(second.ctx, resumed.id)!
      expect(committed.sourceCursor).toBe(freshSeq)
      expect(committed.facts.map(fact => fact.content)).toEqual(['baseline fact'])

      // The commit carries the verdict forward: the durable record keeps its
      // provenance and the effective cursor is still the newest of the two.
      const doc = await readDomain(second.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record?.terminal?.requestId).toBe(requestId)
      expect(record?.terminal?.kind).toBe('quarantined')
      expect(record?.terminal?.cursor).toBe(oversizedSeq)
      expect(record?.stable?.revision).toBe(2)
      expect(record?.stable?.sourceCursor).toBe(freshSeq)
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('never quarantines an oversized todo/write and leaves the committed TODO view intact', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-todo-'))
    const mounted = await mountComposition(root)
    const sessionId = SessionId('infeasible-todo')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      appendTodo(session, [{ content: 'keep the authoritative list', status: 'pending' }])
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'baseline commit')
      const before = stableOf(mounted.ctx, session.id)!
      expect(before.todoView.status).toBe('current')
      const requestsBefore = mounted.adapter.requests.length

      // An authority fact too large to frame: an authority fact may never be
      // skipped, so the provider must fail closed — no quarantine, no advance.
      // Since B4.4 that corner also records typed blocked provenance (see
      // `task-state-terminal-generation.spec.ts`); what must NEVER change is
      // that the fact is not skipped and the cursor does not move.
      const oversizedAuthoritySeq = appendTodo(session, [{ content: 'y'.repeat(3_000), status: 'pending' }])
      await settleQuiet(400)

      expect(mounted.adapter.requests.length).toBe(requestsBefore)
      const verdict = terminalOf(mounted.ctx, session.id)
      if (verdict !== undefined) {
        expect(verdict.kind).toBe('blockAuthorityFact')
        expect(verdict.kind === 'quarantined' ? [] : verdict.blockSeq).toBe(oversizedAuthoritySeq)
        expect(verdict.cursor).toBe(before.sourceCursor)
      }
      const rows = auditRows(mounted.ctx)
      expect(rows.some(row => row.finished?.outcome === 'terminal-infeasible'
        && row.request.includedSeqs.length > 0)).toBe(false)

      // The committed view is exactly what it was: the pending authority fact
      // did not clear it, replace it, or fabricate an empty view.
      const after = stableOf(mounted.ctx, session.id)!
      expect(after.revision).toBe(1)
      expect(after.todoView).toEqual(before.todoView)
      expect(after.sourceCursor).toBe(before.sourceCursor)

      const doc = await readDomain(mounted.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record?.stable?.sourceCursor).toBe(before.sourceCursor)
      if (record?.terminal !== undefined) {
        // B4.4: the blocked reason is durable, typed, and advances nothing.
        expect(record.terminal.kind).toBe('blockAuthorityFact')
        expect(record.terminal.cursor).toBe(before.sourceCursor)
      }

      // The authority fact is still PENDING (never folded, never skipped): a
      // later ordinary fact cannot be folded past it either, so the session
      // keeps failing closed instead of pretending progress.
      expect(eligibleSeqsAbove(session, before.sourceCursor)).toEqual([oversizedAuthoritySeq])
      appendUser(session, 'an ordinary fact behind the authority fact')
      await settleQuiet(400)
      expect(mounted.adapter.requests.length).toBe(requestsBefore)
      expect(stableOf(mounted.ctx, session.id)?.revision).toBe(1)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('never quarantines an oversized goal/change and keeps the committed Goal view', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-goal-'))
    const mounted = await mountComposition(root)
    const sessionId = SessionId('infeasible-goal')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      appendGoal(session, 'Ship the authoritative goal.')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'baseline commit')
      const before = stableOf(mounted.ctx, session.id)!
      expect(before.goalView.status).toBe('current')
      const requestsBefore = mounted.adapter.requests.length

      appendGoal(session, 'z'.repeat(3_000))
      await settleQuiet(400)

      expect(mounted.adapter.requests.length).toBe(requestsBefore)
      const after = stableOf(mounted.ctx, session.id)!
      expect(after.revision).toBe(1)
      expect(after.goalView).toEqual(before.goalView)
      const doc = await readDomain(mounted.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      if (record?.terminal !== undefined) {
        expect(record.terminal.kind).toBe('blockAuthorityFact')
        expect(record.terminal.cursor).toBe(before.sourceCursor)
      }
      expect(auditRows(mounted.ctx).some(row => row.finished?.outcome === 'terminal-infeasible'
        && row.request.includedSeqs.length > 0)).toBe(false)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('records a transient infrastructure failure as retryable and never as a terminal verdict', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-transient-'))
    const mounted = await mountComposition(root, {}, [
      { kind: 'finish-error', code: 'SERVER', message: 'provider is temporarily unavailable' },
      { kind: 'output', text: SMALL_CANDIDATE },
    ])
    const sessionId = SessionId('infeasible-transient')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const firstSeq = appendUser(session, 'first fact')
      await waitUntil(() => mounted.adapter.requests.length === 1, 5_000, 'transient attempt')
      await settleQuiet(200)

      // The failed attempt advances nothing and quarantines nothing.
      expect(stableOf(mounted.ctx, session.id)).toBeUndefined()
      expect(terminalOf(mounted.ctx, session.id)).toBeUndefined()
      await waitForLedger(mounted.ctx, rows => rows.some(row => row.finished?.outcome === 'failure'))
      expectLedger(auditRows(mounted.ctx), (settled) => {
        const failureRows = settled.filter(row => row.finished?.outcome === 'failure')
        expect(failureRows.length).toBe(1)
        expect(failureCodeOf(failureRows[0])).toBe('TRANSIENT_LLM')
        expect(classifyAuditRow(failureRows[0]!)).toBe('transient-failure')
      })
      expect(auditRows(mounted.ctx).some(row => row.finished?.outcome === 'terminal-infeasible')).toBe(false)
      const doc = await readDomain(mounted.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]).toBeUndefined()

      // A later legal wave re-folds the SAME tail from the same cursor — the
      // failed window was preserved, not skipped.
      const secondSeq = appendUser(session, 'second fact')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'retry commit')
      expect(mounted.adapter.requests.length).toBe(2)
      expect(mounted.adapter.requests[1]!.includedSeqs).toEqual([firstSeq, secondSeq])
      expect(stableOf(mounted.ctx, session.id)!.sourceCursor).toBe(secondSeq)
      expect(auditRows(mounted.ctx).some(row => row.finished?.outcome === 'terminal-infeasible')).toBe(false)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('fails closed when the committed stable itself exceeds the input budget', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-base-'))
    const sessionId = SessionId('infeasible-base')
    const bigFacts = JSON.stringify({
      facts: Array.from({ length: 8 }, (_, index) => ({ content: `fact ${index} `.padEnd(400, 'p') })),
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      continuation: {
        currentObjective: 'grow the base stable',
        currentFocus: 'making the base exceed the budget',
        openWork: [],
        nextActions: [],
      },
    })
    const first = await mountComposition(root, { maxInputBytes: 100_000 }, [{ kind: 'output', text: bigFacts }])
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    await settleStartupCheck()
    appendUser(session, 'grow the base')
    await waitUntil(() => stableOf(first.ctx, session.id)?.revision === 1, 5_000, 'baseline commit')
    const baseline = stableOf(first.ctx, session.id)!
    expect(baseline.facts.length).toBe(8)
    await closeProcess(first)

    // Stage 2 mounts the SAME durable record with a budget the committed stable
    // can never fit. The base — not the log — is the cause, so quarantining
    // eligible events would discard facts without making progress.
    const second = await mountComposition(root, { maxInputBytes: 1_000 })
    let tailSeqs: number[] = []
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      tailSeqs = [appendUser(resumed, 'ordinary tail one'), appendUser(resumed, 'ordinary tail two')]
      await settleQuiet(500)

      expect(second.adapter.requests.length).toBe(0)
      const blocked = terminalOf(second.ctx, resumed.id)
      if (blocked !== undefined) {
        // B4.4: the measured non-event cause is durable and typed, and it blames
        // no sequence at all.
        expect(blocked.kind).toBe('blockBaseOverBudget')
        expect(blocked.cursor).toBe(baseline.sourceCursor)
      }
      expect(auditRows(second.ctx).some(row => row.finished?.outcome === 'terminal-infeasible'
        && row.request.includedSeqs.length > 0)).toBe(false)

      // Durable state is unchanged in the parts that matter: no cursor advance,
      // no fabricated stable, no blamed event, and the pending tail is pending.
      const doc = await readDomain(second.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      if (record?.terminal !== undefined) {
        expect(record.terminal.kind).toBe('blockBaseOverBudget')
        expect(record.terminal.cursor).toBe(baseline.sourceCursor)
        expect('includedSeqs' in record.terminal).toBe(false)
      }
      expect(record?.stable?.revision).toBe(baseline.revision)
      expect(record?.stable?.sourceCursor).toBe(baseline.sourceCursor)
      expect(stableOf(second.ctx, resumed.id)?.sourceCursor).toBe(baseline.sourceCursor)
      expect(eligibleSeqsAbove(resumed, baseline.sourceCursor)).toEqual(tailSeqs)
    } finally {
      await closeProcess(second)
    }

    // A/B discriminator: with a budget that the SAME committed stable fits, the
    // SAME pending tail commits normally — proving the base stable, and not the
    // log, was what could not be framed, and that nothing was lost meanwhile.
    const third = await mountComposition(root, { maxInputBytes: 100_000 })
    try {
      const resumed = await resume(third.ctx, sessionId, third)
      await waitUntil(() => stableOf(third.ctx, resumed.id)?.revision === 2, 5_000, 'wide-budget commit')
      expect(third.adapter.requests.length).toBe(1)
      expect(third.adapter.requests[0]!.includedSeqs).toEqual(tailSeqs)
      // The wider budget is a DIFFERENT generation, so the block was lifted: the
      // window was admissible again and the tail it never blamed committed.
      // The stored verdict is superseded, not erased — and crucially it must not
      // suppress anything under the new generation.
      expect(providerOf(third.ctx).getActiveTerminalBlock(resumed.id)).toBeUndefined()
      await settleQuiet(200)
      expect(third.adapter.requests.length).toBe(1)
      const doc = await readDomain(third.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]?.stable?.sourceCursor).toBe(tailSeqs[tailSeqs.length - 1])
    } finally {
      await closeProcess(third)
    }
  }, 60_000)

  it('continues through several measured culprits and stops when the backlog is clean', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-chain-'))
    const mounted = await mountComposition(root)
    const sessionId = SessionId('infeasible-chain')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      appendUser(session, 'baseline')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'baseline commit')
      await settleQuiet(200)
      const requestsBefore = mounted.adapter.requests.length

      // Two independently impossible ordinary facts. Each is a MEASURED culprit
      // of its own window, so each may be quarantined — and the schedule must
      // continue by itself after the first advance instead of stalling until an
      // unrelated event happens to arrive.
      const firstCulprit = appendUser(session, OVERSIZED_TEXT)
      const secondCulprit = appendUser(session, `${OVERSIZED_TEXT}y`)
      await waitUntil(
        () => terminalOf(mounted.ctx, session.id)?.cursor === secondCulprit,
        5_000,
        'second quarantine',
      )
      await settleQuiet(200)

      // Both quarantines are durable, neither cost a model call, and the
      // effective cursor covers exactly the two measured sequences.
      expect(mounted.adapter.requests.length).toBe(requestsBefore)
      await waitForLedger(mounted.ctx, rows => rows.some(row => row.finished?.outcome === 'terminal-infeasible'))
      expectLedger(auditRows(mounted.ctx), (settled) => {
        const terminalRows = settled.filter(row => row.finished?.outcome === 'terminal-infeasible')
        if (terminalRows.length === 0) {
          // Diagnostic gap: no terminal row landed, so the only settled row has
          // to be the one legitimate baseline commit.
          expect(settled.every(row => row.finished?.outcome === 'success')).toBe(true)
          return
        }
        // Every terminal row names one of the two measured culprits, no window
        // was quarantined twice, and the only other settled row is the commit.
        expect(settled.filter(row => row.finished?.outcome !== 'terminal-infeasible')
          .every(row => row.finished?.outcome === 'success')).toBe(true)
        expect(terminalRows.length).toBeLessThanOrEqual(2)
        const culprits = terminalRows.map(row => row.request.includedSeqs[0])
        expect(new Set(culprits).size).toBe(culprits.length)
        for (const seq of culprits) expect([firstCulprit, secondCulprit]).toContain(seq)
      })
      const doc = await readDomain(mounted.storageRoot)
      const record = doc!.tables.sessions[String(sessionId)]!
      expect(record.terminal?.kind).toBe('quarantined')
      expect(record.terminal?.cursor).toBe(secondCulprit)
      expect(record.terminal!.kind === 'quarantined' ? record.terminal!.includedSeqs : []).toEqual([secondCulprit])
      expect(record.stable?.revision).toBe(1)
      expect(stableOf(mounted.ctx, session.id)?.revision).toBe(1)

      // A clean fact then opens a new generation from the advanced cursor.
      const freshSeq = appendUser(session, 'a clean fact after the two culprits')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 2, 5_000, 'clean generation commit')
      expect(mounted.adapter.requests.length).toBe(requestsBefore + 1)
      expect(mounted.adapter.requests[mounted.adapter.requests.length - 1]!.includedSeqs).toEqual([freshSeq])
      expect(stableOf(mounted.ctx, session.id)!.sourceCursor).toBe(freshSeq)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)

  it('records a quarantine for an infeasible window before the first commit without inventing a stable', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-infeasible-nobase-'))
    const mounted = await mountComposition(root)
    const sessionId = SessionId('infeasible-nobase')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const oversizedSeq = appendUser(session, OVERSIZED_TEXT)
      await waitUntil(
        () => terminalOf(mounted.ctx, session.id) !== undefined,
        5_000,
        'first-commit quarantine',
      )

      // The measured culprit is quarantined durably even though no stable was
      // ever committed, and no authority record is fabricated to carry it: the
      // record holds the identity and the verdict and NOTHING else.
      expect(mounted.adapter.requests.length).toBe(0)
      expect(stableOf(mounted.ctx, session.id)).toBeUndefined()
      const verdict = quarantinedOf(mounted.ctx, session.id)
      expect(verdict.cursor).toBe(oversizedSeq)
      expect(verdict.includedSeqs).toEqual([oversizedSeq])
      const doc = await readDomain(mounted.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record).toBeDefined()
      expect(record?.stable).toBeUndefined()
      expect(record?.terminal?.kind).toBe('quarantined')
      expect(record?.terminal?.cursor).toBe(oversizedSeq)

      // The quarantine covers exactly the one measured sequence: a later legal
      // fact folds normally and commits the FIRST revision from that cursor.
      const laterSeq = appendUser(session, 'a later fact behind the impossible one')
      await waitUntil(() => stableOf(mounted.ctx, session.id)?.revision === 1, 5_000, 'first commit')
      expect(mounted.adapter.requests.length).toBe(1)
      expect(mounted.adapter.requests[0]!.includedSeqs).toEqual([laterSeq])
      const committed = stableOf(mounted.ctx, session.id)!
      expect(committed.sourceCursor).toBe(laterSeq)
      // The committed stable carries the verdict forward, and the effective
      // cursor stays consistent with both.
      await settleQuiet(200)
      const after = await readDomain(mounted.storageRoot)
      const afterRecord = after?.tables.sessions[String(sessionId)]
      expect(afterRecord?.stable?.revision).toBe(1)
      expect(afterRecord?.terminal?.cursor).toBe(oversizedSeq)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)
})

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
