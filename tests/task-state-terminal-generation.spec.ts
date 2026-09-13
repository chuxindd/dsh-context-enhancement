/**
 * B4.4 · terminal-generation: the two infeasible verdicts whose measured cause is
 * NOT a log event, and the generation rule that decides when they re-open.
 *
 * B4.3 left both corners fail-closed and SILENT: an oversized authority fact and
 * an oversized committed base were logged, nothing durable was recorded, and the
 * window stalled. Two consequences were explicitly open:
 *
 *  - an authority fact's own sequence could not be recorded durably, so every
 *    restart re-measured (and re-paid for) the very same impossible window;
 *  - a base-only overflow was indistinguishable, in durable state, from a tail
 *    event that could not be framed — so no reader could tell that the base, and
 *    not the log, was the cause.
 *
 * The questions this spec answers, one test each:
 *  1. does an oversized authority fact stay UNSKIPPED and UN-ADVANCED, with typed
 *     durable provenance naming that exact sequence and event type — and does a
 *     restart stop re-measuring a window whose generation has not changed (no
 *     second verdict, no second ledger row, no model call)?
 *  2. does a changed generation re-open that same blocked window for a FRESH
 *     measurement — with a wider byte budget, and with a REPLACED authority fact
 *     — so the pending fact is folded instead of being permanently banned?
 *  3. is a base-only overflow recorded as its own typed non-event cause that
 *     blames NO sequence, survives the arrival of tail events without swallowing
 *     them, and re-opens when the generation changes?
 *  4. does an ordinary measured culprit still quarantine exactly one safe prefix
 *     sequence and advance — with its provenance durable in the SAME record put
 *     and never ahead of it?
 *
 * Composition: real `SessionStore`, real JSONL session persistence, real
 * `Storage` + `StorageJson` + `StorageDomain`, real `LlmRuntime`, and the REAL
 * `TaskStateBasicService`. The only fake is the scripted LLM adapter. Every
 * durable assertion reads the real JSON domain document, and every "was not
 * re-paid" assertion counts real adapter requests.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
import { sameTerminalGeneration, terminalGeneration } from '../src/task-state.ts'
import type {
  TaskStateBlockedVerdict,
  TaskStateQuarantinedVerdict,
  TaskStateTerminalRecord,
} from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'
import { filterEvent, isEligibleType } from '../src/internal/task-state/basic/filter.ts'

/**
 * Deployment-shaped config with a deliberately small `maxInputBytes`. Measured
 * against the REAL framing function: an empty frame is 225 bytes, a small
 * committed stable frames to 547 bytes, and the "large" stable used below frames
 * to 1 003 bytes — so 1 500 bytes leaves room for several ordinary events but not
 * for a 3 000-character authority fact.
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

/** One oversized ordinary fact whose own frame exceeds the small budget. */
const OVERSIZED_TEXT = 'x'.repeat(3_000)

/** One oversized authority list: its own frame exceeds the small budget. */
const OVERSIZED_TODO = 'y'.repeat(3_000)

/** The candidate the adapter answers with when a test wants an ordinary commit. */
function candidate(fact: string, objective: string, openWork: readonly string[] = []): string {
  return JSON.stringify({
    facts: [{ content: fact }],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    continuation: {
      currentObjective: objective,
      currentFocus: 'generation bookkeeping',
      openWork: [...openWork],
      nextActions: [],
    },
  })
}

const SMALL_CANDIDATE = candidate('baseline fact', 'keep the baseline')

/** Eight within-`maxEntryBytes` items: a committed stable a narrow budget cannot frame. */
const LARGE_OPEN_WORK = Array.from(
  { length: 8 },
  (_, index) => `open work item number ${index} padded to add real bytes here`,
)

/**
 * A deliberately LARGE but admissible candidate. Its committed stable alone
 * frames to 1 003 bytes, which a 900-byte budget can no longer fit at all —
 * while the same window frames fine under the ordinary 1 500-byte budget.
 */
const LARGE_CANDIDATE = candidate('a large editable fact', 'the long objective', LARGE_OPEN_WORK)

/**
 * Measured against the REAL framing function: `LARGE_CANDIDATE`'s committed
 * stable alone frames to 1 003 bytes, and adding one ordinary user event costs
 * roughly another 130. So 900 bytes cannot frame the base AT ALL (the base-only
 * cause), while 1 500 bytes frames the base and every ordinary event below.
 */
const NARROW_BUDGET = 900

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
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: entry.code, message: entry.message } } }
      return
    }
    const body = entry === undefined || entry.kind !== 'output' ? SMALL_CANDIDATE : entry.text
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
  throw new Error('task-state-terminal-generation: no framed projection was delivered to the adapter')
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
  await mkdir(storageRoot, { recursive: true })
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
    if (Date.now() - start > timeoutMs) throw new Error(`task-state-terminal-generation: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Let the ONE startup backlog check of a fresh runtime run over an empty backlog. */
async function settleStartupCheck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 30))
}

/** Settle asynchronous scheduler work that must NOT produce anything. */
async function settleQuiet(ms = 300): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

/** The concrete provider behind `ctx.taskState` (test seam, same as B4.1–B4.3). */
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

/** Settled `terminal-infeasible` ledger rows of the live domain. */
function terminalRows(ctx: Context): TaskStateAuditRecord[] {
  return auditRows(ctx).filter(row => row.finished?.outcome === 'terminal-infeasible')
}

/** The provider's durable terminal verdict, or `undefined`. */
function terminalOf(ctx: Context, id: SessionId): TaskStateTerminalRecord | undefined {
  return providerOf(ctx).getTerminal(id)
}

/** The served verdict ASSERTED to be a typed block. */
function blockedOf(ctx: Context, id: SessionId): TaskStateBlockedVerdict {
  const terminal = terminalOf(ctx, id)
  expect(terminal?.kind === 'blockBaseOverBudget' || terminal?.kind === 'blockAuthorityFact').toBe(true)
  return terminal as TaskStateBlockedVerdict
}

/** The served verdict ASSERTED to be a quarantine. */
function quarantinedOf(ctx: Context, id: SessionId): TaskStateQuarantinedVerdict {
  const terminal = terminalOf(ctx, id)
  expect(terminal?.kind).toBe('quarantined')
  return terminal as TaskStateQuarantinedVerdict
}

/** The durable document shape this spec reads (deliberately loose, JSON-level). */
interface RawDomainDoc {
  readonly tables: {
    readonly sessions: Record<string, {
      readonly stable?: { readonly revision: number; readonly sourceCursor: number }
      readonly terminal?: {
        readonly kind?: string
        readonly cursor: number
        readonly requestId?: string
        readonly includedSeqs?: readonly number[]
        readonly blockSeq?: number
        readonly blockType?: string
        readonly generation?: {
          readonly baseSourceCursor: number
          readonly baseFilterVersion: string
          readonly baseDigest: string
          readonly maxInputBytes: number
        }
      }
    }>
    readonly audit: Record<string, { readonly finished?: { readonly outcome: string } }>
  }
}

async function readDomain(storageRoot: string): Promise<RawDomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, DOMAIN_FILE), 'utf8')) as RawDomainDoc
  } catch {
    return null
  }
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

describe('task-state terminal generation (B4.4)', () => {
  it('blocks an oversized authority fact without skipping it, and does not re-measure an unchanged generation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-gen-authority-'))
    const sessionId = SessionId('gen-authority')
    const first = await mountComposition(root)
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    let oversizedSeq: number
    let blockedCursor: number
    let blockedRequest: string
    try {
      await settleStartupCheck()
      appendUser(session, 'baseline fact')
      await waitUntil(() => first.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'baseline commit')
      const baseline = first.ctx.taskState.getStable(session.id)!
      const requestsBefore = first.adapter.requests.length

      // The authority fact is far too large to frame. It may NEVER be skipped,
      // and it may not be blamed on any sequence either.
      oversizedSeq = appendTodo(session, [{ content: OVERSIZED_TODO, status: 'pending' }])
      await waitUntil(() => terminalOf(first.ctx, session.id) !== undefined, 5_000, 'authority block')

      const blocked = blockedOf(first.ctx, session.id)
      expect(blocked.kind).toBe('blockAuthorityFact')
      expect(blocked.blockSeq).toBe(oversizedSeq)
      expect(blocked.blockType).toBe('todo/write')
      expect(blocked.cursor).toBe(baseline.sourceCursor)
      expect('includedSeqs' in blocked).toBe(false)
      expect(blocked.code).toBe('BUDGET')
      expect(blocked.generation.baseSourceCursor).toBe(baseline.sourceCursor)
      expect(blocked.generation.baseFilterVersion).toBe(baseline.filterVersion)
      expect(blocked.generation.baseDigest).toBe(baseline.digest)
      expect(blocked.generation.maxInputBytes).toBe(BASE_CONFIG.maxInputBytes)
      blockedCursor = blocked.cursor
      blockedRequest = String(blocked.requestId)

      // No model call, and the authority sequence is STILL eligible and pending:
      // the block is provenance, not a skip licence.
      expect(first.adapter.requests.length).toBe(requestsBefore)
      expect(eligibleSeqsAbove(session, baseline.sourceCursor)).toContain(oversizedSeq)
      const doc = await readDomain(first.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record?.stable?.sourceCursor).toBe(baseline.sourceCursor)
      expect(record?.terminal?.kind).toBe('blockAuthorityFact')
      expect(record?.terminal?.cursor).toBe(baseline.sourceCursor)
      expect(record?.terminal?.blockSeq).toBe(oversizedSeq)
      expect(record?.terminal?.blockType).toBe('todo/write')
      expect(record?.terminal?.includedSeqs).toBeUndefined()
      expect(record?.terminal?.generation?.maxInputBytes).toBe(BASE_CONFIG.maxInputBytes)
      await settleQuiet(200)
    } finally {
      await closeProcess(first)
    }

    // Restart with the SAME generation: the block is recovered, the worker skips
    // the window, and NOTHING is re-measured, re-written, or re-paid.
    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await settleQuiet(400)
      expect(second.adapter.requests.length).toBe(0)
      const restored = blockedOf(second.ctx, resumed.id)
      expect(String(restored.requestId)).toBe(blockedRequest)
      expect(restored.kind).toBe('blockAuthorityFact')
      expect(restored.blockSeq).toBe(oversizedSeq)
      expect(restored.cursor).toBe(blockedCursor)
      // No second verdict and no second ledger row for the same generation.
      expect(terminalRows(second.ctx).length).toBeLessThanOrEqual(1)
      expect(second.ctx.taskState.getActiveTerminalBlock(resumed.id)?.kind).toBe('blockAuthorityFact')
      const doc = await readDomain(second.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]?.stable?.sourceCursor).toBe(blockedCursor)
      expect(doc?.tables.sessions[String(sessionId)]?.terminal?.requestId).toBe(blockedRequest)
    } finally {
      await closeProcess(second)
    }

    // A WIDER budget is a DIFFERENT generation: the same still-pending authority
    // fact is re-measured, now fits, and the window folds normally.
    const third = await mountComposition(root, { maxInputBytes: 100_000 })
    try {
      const resumed = await resume(third.ctx, sessionId, third)
      await waitUntil(() => third.ctx.taskState.getStable(resumed.id)?.revision === 2, 5_000, 'wide-budget commit')
      const committed = third.ctx.taskState.getStable(resumed.id)!
      expect(committed.sourceCursor).toBe(oversizedSeq)
      expect(committed.todoView.status).toBe('current')
      expect(committed.todoView.items).toHaveLength(1)
      // The committed view is the authoritative list the window carried, so the
      // oversized fact was folded rather than skipped. Its text is the same
      // bounded value the deterministic framing applied (a marked truncation),
      // never an empty or fabricated list.
      expect(committed.todoView.items[0]!.content.startsWith('y')).toBe(true)
      expect(committed.todoView.items[0]!.content.length).toBeGreaterThan(400)
      expect(third.adapter.requests.length).toBe(1)
      expect(third.adapter.requests[0]!.includedSeqs).toEqual([oversizedSeq])
      expect(third.ctx.taskState.getActiveTerminalBlock(resumed.id)).toBeUndefined()
    } finally {
      await closeProcess(third)
    }
  }, 90_000)

  it('re-opens a blocked authority window when the authority fact is REPLACED, folding both pending facts', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-gen-authority-replaced-'))
    const sessionId = SessionId('gen-authority-replaced')
    const first = await mountComposition(root)
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    let oversizedSeq: number
    let replacementSeq: number
    let baselineCursor: number
    try {
      await settleStartupCheck()
      appendUser(session, 'baseline fact')
      await waitUntil(() => first.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'baseline commit')
      baselineCursor = first.ctx.taskState.getStable(session.id)!.sourceCursor

      oversizedSeq = appendTodo(session, [{ content: OVERSIZED_TODO, status: 'pending' }])
      await waitUntil(() => terminalOf(first.ctx, session.id) !== undefined, 5_000, 'authority block')
      expect(blockedOf(first.ctx, session.id).blockSeq).toBe(oversizedSeq)

      // The whole list is REPLACED by a small one: `todo/write` is authority, so
      // the newest fact wins. Both sequences stay pending, and the block must not
      // move the cursor past either of them.
      replacementSeq = appendTodo(session, [{ content: 'the authoritative small list', status: 'pending' }])
      await settleQuiet(400)
      // The generation is unchanged (no base, filter, or budget change), so the
      // block still suppresses the fold with no model call...
      expect(first.ctx.taskState.getActiveTerminalBlock(session.id)?.blockSeq).toBe(oversizedSeq)
      expect(first.adapter.requests.length).toBe(1)
      // ...and BOTH facts are still eligible: nothing was swallowed.
      expect(eligibleSeqsAbove(session, baselineCursor)).toEqual([oversizedSeq, replacementSeq])
      const doc = await readDomain(first.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]?.stable?.sourceCursor).toBe(baselineCursor)
    } finally {
      await closeProcess(first)
    }

    // A changed generation re-opens the window for a FRESH measurement, and the
    // fold now reaches both pending sequences instead of skipping either.
    const second = await mountComposition(root, { maxInputBytes: 100_000 })
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await waitUntil(() => second.ctx.taskState.getStable(resumed.id)?.revision === 2, 5_000, 'replacement commit')
      const committed = second.ctx.taskState.getStable(resumed.id)!
      expect(second.adapter.requests.length).toBe(1)
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([oversizedSeq, replacementSeq])
      expect(committed.sourceCursor).toBe(replacementSeq)
      expect(committed.todoView.status).toBe('current')
      expect(committed.todoView.items.map(item => item.content)).toEqual(['the authoritative small list'])
      expect(second.ctx.taskState.getActiveTerminalBlock(resumed.id)).toBeUndefined()
      const doc = await readDomain(second.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]?.stable?.sourceCursor).toBe(replacementSeq)
    } finally {
      await closeProcess(second)
    }
  }, 90_000)

  it('records a base-only overflow as its own typed non-event cause that blames no sequence, and re-opens when the base content changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-gen-base-'))
    const sessionId = SessionId('gen-base')
    const first = await mountComposition(root, { maxInputBytes: 100_000 }, [
      { kind: 'output', text: LARGE_CANDIDATE },
    ])
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    let baselineRevision: number
    let baselineCursor: number
    let baselineDigest: string
    try {
      await settleStartupCheck()
      appendUser(session, 'baseline fact')
      await waitUntil(() => first.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'large baseline commit')
      const baseline = first.ctx.taskState.getStable(session.id)!
      baselineRevision = baseline.revision
      baselineCursor = baseline.sourceCursor
      baselineDigest = baseline.digest
      await settleQuiet(200)
    } finally {
      await closeProcess(first)
    }

    // A budget the SAME committed stable can no longer frame AT ALL. The base,
    // not the log, is the measured cause: nothing may be blamed, skipped,
    // quarantined, or advanced.
    let tailSeqs: number[]
    const second = await mountComposition(root, { maxInputBytes: NARROW_BUDGET })
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      tailSeqs = [appendUser(resumed, 'ordinary tail one'), appendUser(resumed, 'ordinary tail two')]
      await waitUntil(() => terminalOf(second.ctx, resumed.id) !== undefined, 5_000, 'base block')

      const blocked = blockedOf(second.ctx, resumed.id)
      expect(blocked.kind).toBe('blockBaseOverBudget')
      expect(blocked.cursor).toBe(baselineCursor)
      expect(blocked.blockSeq).toBeUndefined()
      expect('includedSeqs' in blocked).toBe(false)
      expect(blocked.generation.baseSourceCursor).toBe(baselineCursor)
      expect(blocked.generation.baseDigest).toBe(baselineDigest)
      expect(blocked.generation.maxInputBytes).toBe(NARROW_BUDGET)
      expect(blocked.reason).toContain('maxInputBytes')

      // No model call, no cursor move, and the tail is neither blamed nor lost.
      expect(second.adapter.requests.length).toBe(0)
      expect(eligibleSeqsAbove(resumed, baselineCursor)).toEqual(tailSeqs)
      const doc = await readDomain(second.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record?.stable?.revision).toBe(baselineRevision)
      expect(record?.stable?.sourceCursor).toBe(baselineCursor)
      expect(record?.terminal?.kind).toBe('blockBaseOverBudget')
      expect(record?.terminal?.cursor).toBe(baselineCursor)
      expect(record?.terminal?.includedSeqs).toBeUndefined()
      expect(record?.terminal?.blockSeq).toBeUndefined()
      // No ledger row claims a quarantined sequence.
      expect(terminalRows(second.ctx).every(row => row.request.includedSeqs.length === 0)).toBe(true)

      // The block outlives new events AND a restart of the same generation: a
      // third ordinary fact neither lifts it nor gets swallowed by it.
      const extraSeq = appendUser(resumed, 'a third ordinary fact while blocked')
      await settleQuiet(400)
      expect(second.adapter.requests.length).toBe(0)
      expect(blockedOf(second.ctx, resumed.id).kind).toBe('blockBaseOverBudget')
      expect(eligibleSeqsAbove(resumed, baselineCursor)).toEqual([...tailSeqs, extraSeq])
      expect(second.ctx.taskState.getActiveTerminalBlock(resumed.id)?.kind).toBe('blockBaseOverBudget')

      // Only a GENERATION change lifts it — here the user manually replaces the
      // committed base with a small one, so nothing about the LOG changed.
      const stalled = second.ctx.taskState.getStable(resumed.id)!
      const edited = await providerOf(second.ctx).editStable({
        sessionId: resumed.id,
        expectedRevision: stalled.revision,
        value: {
          currentObjective: 'a small replacement base',
          currentFocus: '',
          openWork: [],
          nextActions: [],
          facts: [],
          decisions: [],
          constraints: [],
          risks: [],
        },
      })
      expect(edited.ok).toBe(true)
      if (!edited.ok) throw new Error(edited.message)
      expect(edited.stable.revision).toBe(baselineRevision + 1)
      expect(edited.stable.sourceCursor).toBe(baselineCursor)
      expect(edited.stable.digest).not.toBe(baselineDigest)
      await waitUntil(
        () => second.ctx.taskState.getActiveTerminalBlock(resumed.id) === undefined,
        5_000,
        'block lifted by the new base content',
      )

      // The pending tail was never lost: the very next ordinary fact folds the
      // whole pending window under the SAME narrow budget.
      const afterEditSeq = appendUser(resumed, 'a legal fact after the shrink')
      await waitUntil(
        () => second.ctx.taskState.getStable(resumed.id)?.revision === baselineRevision + 2,
        5_000,
        'post-shrink commit',
      )
      expect(second.adapter.requests.length).toBe(1)
      // The fold spans the WHOLE pending window: both facts that were pending
      // while the base could not be framed, plus the fact that triggered it.
      expect(second.adapter.requests[0]!.includedSeqs).toEqual(expect.arrayContaining([...tailSeqs, afterEditSeq]))
      const committed = second.ctx.taskState.getStable(resumed.id)!
      expect(committed.sourceCursor).toBe(afterEditSeq)
      expect(second.ctx.taskState.getActiveTerminalBlock(resumed.id)).toBeUndefined()
    } finally {
      await closeProcess(second)
    }
  }, 90_000)

  it('quarantines an ordinary culprit as one safe prefix and records its provenance in the same put', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-gen-prefix-'))
    const sessionId = SessionId('gen-prefix')
    const mounted = await mountComposition(root)
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      appendUser(session, 'baseline fact')
      await waitUntil(() => mounted.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'baseline commit')
      const baseline = mounted.ctx.taskState.getStable(session.id)!
      const requestsBefore = mounted.adapter.requests.length

      const culpritSeq = appendUser(session, OVERSIZED_TEXT)
      await waitUntil(() => terminalOf(mounted.ctx, session.id) !== undefined, 5_000, 'quarantine')

      const verdict = quarantinedOf(mounted.ctx, session.id)
      expect(verdict.cursor).toBe(culpritSeq)
      expect(verdict.includedSeqs).toEqual([culpritSeq])
      expect(verdict.generation.baseSourceCursor).toBe(baseline.sourceCursor)
      expect(verdict.generation.baseDigest).toBe(baseline.digest)
      expect(mounted.adapter.requests.length).toBe(requestsBefore)

      // Provenance is IN the same record put as the committed state it advances:
      // one sessions record carries identity + stable + verdict, so the effective
      // cursor can never advance without its provenance.
      const doc = await readDomain(mounted.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record?.stable?.revision).toBe(baseline.revision)
      expect(record?.stable?.sourceCursor).toBe(baseline.sourceCursor)
      expect(record?.terminal?.kind).toBe('quarantined')
      expect(record?.terminal?.cursor).toBe(culpritSeq)
      expect(record?.terminal?.includedSeqs).toEqual([culpritSeq])
      expect(record?.terminal?.generation?.baseSourceCursor).toBe(baseline.sourceCursor)
      expect(record?.terminal?.generation?.baseDigest).toBe(baseline.digest)
      // A quarantine never blocks: the effective cursor simply moved on.
      expect(mounted.ctx.taskState.getActiveTerminalBlock(session.id)).toBeUndefined()

      // The effective cursor now admits the NEXT ordinary fact, and the commit
      // keeps the quarantine provenance alongside the new stable.
      const nextSeq = appendUser(session, 'a legal fact after the culprit')
      await waitUntil(
        () => mounted.ctx.taskState.getStable(session.id)?.revision === baseline.revision + 1,
        5_000,
        'next commit',
      )
      const lastRequest = mounted.adapter.requests[mounted.adapter.requests.length - 1]!
      expect(lastRequest.includedSeqs).toEqual([nextSeq])
      await settleQuiet(200)
      const after = await readDomain(mounted.storageRoot)
      const afterRecord = after?.tables.sessions[String(sessionId)]
      expect(afterRecord?.stable?.sourceCursor).toBe(nextSeq)
      expect(afterRecord?.terminal?.cursor).toBe(culpritSeq)
      expect(afterRecord?.terminal?.requestId).toBe(String(verdict.requestId))
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)
})

/**
 * The generation predicate itself: the rule that decides whether a durable
 * verdict still applies. A changed base revision, cursor, digest, filter
 * version, or byte budget is a new generation; nothing else is.
 */
describe('task-state terminal generation predicate (B4.4)', () => {
  it('treats only a base/filter/budget change as a new generation', () => {
    const base = {
      revision: 1,
      sourceCursor: 7,
      filterVersion: 'task-state-basic/filter-v3',
      digest: 'digest-a',
    }
    const current = terminalGeneration(base, 1_500)
    expect(current).toEqual({
      baseSourceCursor: 7,
      baseFilterVersion: 'task-state-basic/filter-v3',
      baseDigest: 'digest-a',
      maxInputBytes: 1_500,
    })
    expect(sameTerminalGeneration(current, terminalGeneration({ ...base }, 1_500))).toBe(true)
    expect(sameTerminalGeneration(current, terminalGeneration({ ...base, sourceCursor: 8 }, 1_500))).toBe(false)
    expect(sameTerminalGeneration(current, terminalGeneration({ ...base, digest: 'digest-b' }, 1_500))).toBe(false)
    expect(sameTerminalGeneration(current, terminalGeneration({ ...base, filterVersion: 'filter-v4' }, 1_500))).toBe(false)
    expect(sameTerminalGeneration(current, terminalGeneration(base, 2_000))).toBe(false)
    // The pre-first-commit generation is a real, comparable generation: a block
    // recorded before the first commit stays in force until a base, a filter
    // version, or a budget actually changes.
    const noBase = terminalGeneration(null, 1_500)
    expect(noBase).toEqual({
      baseSourceCursor: -1,
      baseFilterVersion: 'none',
      baseDigest: 'none',
      maxInputBytes: 1_500,
    })
    expect(sameTerminalGeneration(noBase, terminalGeneration(null, 1_500))).toBe(true)
    expect(sameTerminalGeneration(noBase, current)).toBe(false)
  })
})
