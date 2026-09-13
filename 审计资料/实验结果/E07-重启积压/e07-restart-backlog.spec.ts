/**
 * E07 · 重启积压 / restart backlog (L2: REAL durable storage + REAL JSONL session
 * persistence + REAL resume/reopen + REAL TaskStateBasicService + fake LLM)
 *
 * EXPERIMENT QUESTION (the only one)
 * ----------------------------------
 * When a committed stable sits at cursor = N and eligible Session events exist
 * ABOVE N that no update ever folded, and the process is closed, then a NEW
 * process reopens the SAME durable storage and resumes the SAME session id
 * WITHOUT appending any new event — does startup actively discover that backlog
 * and update the stable inside the normal worker scheduling window?
 *
 * FIXED VERDICT RULE (recorded before the run; 审计资料/32 §5 E07)
 * ---------------------------------------------------------------
 *   reproduced      = the backlog exists (eligible events above the committed
 *                     cursor, count >= minEvents), after the restart with NO new
 *                     event the stable/cursor stay untouched through a wait far
 *                     longer than the worker's scheduling window (zero model
 *                     requests, zero new audit rows), AND appending exactly ONE
 *                     new eligible event does trigger an update whose folded
 *                     window contains the whole pre-restart backlog;
 *   not-reproduced  = startup did process / update the backlog without new
 *                     activity, or the new event did not fold the backlog;
 *   inconclusive    = the fixture/runner/durable medium could not produce the
 *                     evidence (restore failed, storage unwritable, dispose or
 *                     deadline failure, runner error);
 *   design-confirmed = static-design evidence only (not used unless the dynamic
 *                     route is impossible).
 *
 * WHY minEvents = 1 (the confound killer)
 * ---------------------------------------
 * With `minEvents = 1` ANY backlog of >= 1 eligible event already meets the
 * production threshold, so "the backlog is below the trigger threshold" can
 * never explain inactivity: the only reason nothing happens after the restart is
 * that startup never schedules the per-Session worker. The reopened worker
 * recomputes its eligible count from the restored log (`eligibleCount` above the
 * committed cursor) and really sees 3 >= 1 — it simply is never asked to run.
 *
 * FOUR STAGES (exactly as fixed by the E07 protocol)
 * --------------------------------------------------
 *   stage 1 (process P1): a real composition commits a stable; cursor = N.
 *   stage 2 (process P2): the SAME durable session is restored and one complete
 *           user turn (3 eligible events) is appended ABOVE N. The task-state
 *           provider is mounted only AFTER those appends — the production
 *           "domain open / mount order" window the provider's own init accounts
 *           for (`createdDuringOpen`) — so no worker ever observes them: zero
 *           model requests are made for the backlog. The provider then creates
 *           the Session runtime with a recomputed above-threshold count and still
 *           schedules nothing. Backlog confirmed above the cursor, unprocessed.
 *   stage 3 (end of P2): complete `ctx.fiber.dispose()` close; the medium is
 *           quiesced and read from disk.
 *   stage 4 (process P3): NEW process, SAME temporary storage, SAME session id,
 *           SAME lifecycle identity, log restored from the SAME JSONL artifact.
 *           No new event is appended; the stable is sampled for 2 000 ms (the
 *           worker schedules on a microtask, i.e. sub-millisecond, so this is
 *           ~three orders of magnitude beyond its normal window). Then exactly
 *           ONE new eligible event is appended and the resulting commit is read
 *           back from the durable audit row.
 *
 * REAL in this spec (production code only; no harness is modified or imported)
 * ---------------------------------------------------------------------------
 * - `Storage` + `StorageJson` + `StorageDomain` (real durable domain
 *   `context_enhancement_task_state`) rooted INSIDE this E07 directory;
 * - real `SessionStore` + real `JsonlSessionPersistence` (real resume artifact)
 *   and the REAL resume idiom `ctx.sessionPersistence.prepare(id)` →
 *   `ctx.sessions.enter(...)` → `ctx.sessions.announce(...)` (the same primitives
 *   the DSH stack's own persistence-contract tests use);
 * - real `TaskStateBasicService` (production scheduler, filter, batch fold,
 *   prompt frame, validation, authority put, audit rows) mounted through
 *   `ctx.plugin`;
 * - real production filter math (`isEligibleType` + `filterEvent`) to decide what
 *   counts as an eligible event above the cursor;
 * - real production renderer (`renderTaskStateSnapshot`) for the injection text.
 *
 * FAKE in this spec
 * -----------------
 * - the LLM: a scripted `LlmAdapter` that answers one structurally valid
 *   candidate JSON per request, echoing the highest folded seq it was handed, and
 *   records every request (count, folded seqs, sizes, time). Its `usage` is
 *   absent, so no provider tokens are measured.
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * - it never constructs a `TaskStateWorker` and never calls `observe`,
 *   `maybeSchedule`, `performBatch`, or any worker method by hand: every wave in
 *   this run is triggered by the production `session/event` observer path, so a
 *   "startup trigger" question cannot be confused with a fixture-side call;
 * - it never touches `src/`, `tests/`, `package.json`, `vitest.config.ts`, `lib`,
 *   the tgz, the shared harness, or any other experiment directory;
 * - it never uses the real `$HOME/.dsh`, an existing session, port 8080, the Web
 *   GUI, or a second live process (the three "processes" are three sequentially
 *   mounted Cordis contexts, and only one is alive at a time).
 */

import { mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../../../src/task-state-basic.ts'
import type { TaskStateBasicConfig, TaskStateStable } from '../../../src/task-state.ts'
import { filterEvent, isEligibleType } from '../../../src/internal/task-state/basic/filter.ts'
import { renderTaskStateSnapshot } from '../../../src/internal/task-state/prompt/render.ts'

// ---------------------------------------------------------------------------
// Fixed experiment constants
// ---------------------------------------------------------------------------

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** Real durable task-state domain root — INSIDE this E07 directory. */
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')
/** Real durable JSONL session-log root — INSIDE this E07 directory. */
const SESSION_ROOT = join(OUT_DIR, 'tmp-sessions')
/** The durable domain document written by the real JSON storage backend. */
const DOMAIN_FILE = join(STORAGE_ROOT, 'context_enhancement_task_state.json')
const LEDGER_PATH = join(OUT_DIR, 'e07-ledger.json')
/** Raw artifact directory of the JSONL backend (kept as durability evidence). */
const SESSION_ARTIFACT_ROOT = SESSION_ROOT

const SESSION_ID = SessionId('e07-restart-backlog')
const CREATED_AT = 1_700_000_000_000
/** Lifecycle `cwd` handed to the Session header; identical in every process. */
const META_CWD = STORAGE_ROOT

const PROVIDER = 'current-route'
const MODEL = 'current-model'
const SURFACE = { surfaceOp: 'append' as const }

/**
 * Deployment-shaped auxiliary policy, EXCEPT `minEvents = 1`: one eligible event
 * above the committed cursor already meets the production trigger threshold (see
 * the header — this removes the "below threshold" explanation entirely).
 */
const CONFIG: TaskStateBasicConfig = {
  provider: PROVIDER,
  model: MODEL,
  minEvents: 1,
  maxEvents: 20,
  maxInputBytes: 100_000,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 2_000,
  maxListItems: 8,
}

/** Stage-1 turn: seq 0..3 (`turn/start` 0, user 1, assistant 2, `turn/end` 3). */
const STAGE1_TURN = 1
/** Event types of the P1 log as closed (one complete, balanced turn). */
const LOG_AFTER_STAGE1 = ['turn/start', 'user/message', 'assistant/message', 'turn/end']
/**
 * Terminal marker the production resume path appends to a closed log
 * (`SessionPersistence.load` closes the log durably). Measured in this run as
 * NOT eligible for the task-state filter, so it can never itself schedule a wave.
 */
const RESTORE_MARKER = 'session/end-seed'
/** Stage-2 backlog turn: seq 4..7 (`turn/start` ineligible, then 3 eligible). */
const BACKLOG_TURN = 2
/** The single new event appended in stage 4 (stage-3 turn). */
const NEW_EVENT_TURN = 3

/** Wait window in stage 4 (ms). The worker's own scheduling is a microtask. */
const STARTUP_WAIT_MS = 2_000
/** Sampling offsets inside the stage-4 wait window (ms). */
const SAMPLE_OFFSETS = [0, 100, 250, 500, 1_000, 1_500, 2_000]
/** Shorter settle window used right after the provider mounts in stage 2 (ms). */
const STAGE2_SETTLE_MS = 1_200
/** Deadline for one full `ctx.fiber.dispose()` (ms). */
const DISPOSE_DEADLINE_MS = 15_000
/** Deadline for a convergence wait (ms). */
const CONVERGE_DEADLINE_MS = 10_000

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string, hex encoded (ledger compactness only). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll one predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 5): Promise<boolean> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false
    await delay(stepMs)
  }
  return true
}

/** Await one promise under a deadline; resolves to the error message or null. */
async function withDeadline(operation: Promise<unknown>, timeoutMs: number, label: string): Promise<string | null> {
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs)),
    ])
    return null
  } catch (error: unknown) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/** Release a `SessionPreparation` through its `Symbol.dispose` protocol. */
function releasePreparation(preparation: unknown): void {
  const dispose = (preparation as Record<PropertyKey, unknown>)[Symbol.dispose as unknown as PropertyKey]
  if (typeof dispose === 'function') (dispose as () => void).call(preparation)
}

// ---------------------------------------------------------------------------
// The scripted fake model (the ONLY LLM in this spec)
// ---------------------------------------------------------------------------

/** One captured auxiliary request. */
interface AdapterRequestRow {
  /** Wall-clock time the request reached the fake adapter. */
  readonly at: number
  /** Requested provider/model. */
  readonly provider: string
  readonly model: string
  /** `purpose` carried by the request, when present. */
  readonly purpose: string | null
  /** Every `"seq":N` found in the framed projection, in order. */
  readonly windowSeqs: readonly number[]
  /** Highest folded seq visible in the framed projection (-1 when none). */
  readonly maxSeq: number
  /** Characters of model-visible input. */
  readonly inputChars: number
  /** Characters of scripted output. */
  readonly outputChars: number
}

/**
 * Answers every auxiliary request with one structurally valid candidate JSON
 * whose content names the highest folded seq it was handed, and records the
 * request. No usage is produced (this is a fake adapter, not a provider).
 */
class CountingAdapter extends LlmAdapter {
  readonly requests: AdapterRequestRow[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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
      facts: [{ content: `e07 durable record folded eligible events through ${maxSeq}` }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `E07 restart backlog probe window-through-${maxSeq}`,
        currentFocus: 'observing whether startup folds an unprocessed tail',
        openWork: [],
        nextActions: [],
      },
    })
    this.requests.push({
      at: Date.now(),
      provider: String(options.provider),
      model: String(options.model),
      purpose: options.purpose === undefined ? null : String(options.purpose),
      windowSeqs,
      maxSeq,
      inputChars: text.length,
      outputChars: body.length,
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// ---------------------------------------------------------------------------
// Composition mounting (the tests/task-state-restart-recovery.spec.ts pattern)
// ---------------------------------------------------------------------------

/** One mounted process: the live context plus its session teardown hooks. */
interface MountedProcess {
  readonly ctx: Context
  readonly adapter: CountingAdapter
  /** Set once a session has been entered/announced by hand in this process. */
  session: Session | null
  detachSession: (() => void) | null
  preparation: unknown
}

/**
 * Mount the host stack the restart-recovery composition uses — real session
 * store, real JSONL session persistence, real storage hub + JSON backend + domain
 * facility, real LLM runtime — at the FIXED E07 roots.
 */
async function mountBase(): Promise<MountedProcess> {
  const ctx = new Context()
  const adapter = new CountingAdapter()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: SESSION_ARTIFACT_ROOT,
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter, session: null, detachSession: null, preparation: null }
}

/**
 * Resume the durable session with the REAL production resume idiom: the
 * persistence service prepares the stored Session (its header and its complete
 * contiguous event log), the store enters and announces it.
 */
async function resumeDurableSession(process: MountedProcess): Promise<Session> {
  const persistence = (process.ctx as unknown as {
    sessionPersistence: { prepare: (id: SessionId) => Promise<unknown> }
  }).sessionPersistence
  const preparation = await persistence.prepare(SESSION_ID)
  const session = (preparation as { readonly session: Session }).session
  process.preparation = preparation
  process.session = session
  process.detachSession = process.ctx.sessions.enter(session)
  process.ctx.sessions.announce(session)
  return session
}

/** Mount the real task-state provider (its init seeds the runtime for the live Session). */
async function mountProvider(process: MountedProcess): Promise<string | null> {
  try {
    await process.ctx.plugin(TaskStateBasicService, CONFIG)
    return null
  } catch (error: unknown) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/** Tear one process down completely: detach the Session, release, dispose the fiber. */
async function closeProcess(process: MountedProcess): Promise<string | null> {
  try {
    process.detachSession?.()
    process.detachSession = null
    if (process.preparation !== null) releasePreparation(process.preparation)
    process.preparation = null
  } catch (error: unknown) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  return withDeadline(process.ctx.fiber.dispose(), DISPOSE_DEADLINE_MS, 'ctx.fiber.dispose()')
}

// ---------------------------------------------------------------------------
// Session-log helpers (production APIs only)
// ---------------------------------------------------------------------------

/** Append one direct human user/message on the surface; returns its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), SURFACE).seq
}

/** Append one model assistant/message on the surface; returns its seq. */
function appendAssistant(session: Session, turn: number, step: number, text: string): number {
  return session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, SURFACE).seq
}

/** The production filter projection kind of one event, or null when it projects nothing. */
function filterKind(session: Session, seq: number): string | null {
  const event = session.eventAt(seq as never)
  if (event === undefined) return null
  const filtered = filterEvent({ type: event.type, seq: event.seq, data: event.data })
  if (filtered === null) return null
  const fields = filtered.event.fields as { readonly kind?: unknown }
  return typeof fields.kind === 'string' ? fields.kind : null
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

/** Compact view of one Session's current durable log. */
interface LogView {
  /** Number of events in the log. */
  readonly length: number
  /** Event types in log order. */
  readonly types: string[]
  /** Highest seq in the log (-1 when empty). */
  readonly lastSeq: number
}

/** Compact view of one Session's current durable log. */
function logView(session: Session): LogView {
  const events = session.snapshotEvents()
  return {
    length: events.length,
    types: events.map(event => event.type),
    lastSeq: events.length === 0 ? -1 : Number(events[events.length - 1]!.seq),
  }
}

/** Whether a log ends with the production close marker. */
function endsWithCloseMarker(view: LogView): boolean {
  return view.types[view.types.length - 1] === RESTORE_MARKER
}

/** How many close markers a log carries (one per restore of a closed log). */
function closeMarkerCount(view: LogView): number {
  return view.types.filter(type => type === RESTORE_MARKER).length
}

/** Source kinds of every surface node: original log event vs a derived replacement. */
function surfaceSourceKinds(session: Session): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of session.surface.nodes) {
    const event = session.eventAt(node) as { type?: unknown; surfaceOp?: unknown } | undefined
    if (event === undefined) continue
    const op = event.surfaceOp
    const kind = op === undefined || op === 'append' ? 'original' : `replacement:${String((op as { op?: unknown }).op ?? 'unknown')}`
    const key = `${String(event.type)}:${kind}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** Compact view of one committed/recovered stable. */
function stableView(stable: TaskStateStable | undefined): Record<string, unknown> | null {
  if (stable === undefined) return null
  const injection = renderTaskStateSnapshot(stable, 8_000)
  return {
    revision: stable.revision,
    sourceCursor: stable.sourceCursor,
    filterVersion: stable.filterVersion,
    schemaVersion: stable.schemaVersion,
    digest: stable.digest,
    objective: stable.continuation.currentObjective,
    facts: stable.facts.map(fact => fact.content),
    injectionChars: injection.length,
    injectionHash: fnv1a(injection),
  }
}

// ---------------------------------------------------------------------------
// Durable-medium helpers
// ---------------------------------------------------------------------------

/** One audit row as stored by the real domain facility. */
interface AuditRow {
  readonly requestId: string
  readonly session: { readonly createdAt: number; readonly cwd?: string }
  readonly request: {
    readonly revision: number
    readonly includedSeqs: readonly number[]
    readonly base: { readonly revision: number; readonly sourceCursor: number } | null
  }
  readonly finished?: {
    readonly outcome: string
    readonly revision: number
    readonly sourceCursor: number
  }
}

interface DomainDoc {
  readonly unit: { readonly name: string; readonly version: number }
  readonly tables: {
    readonly sessions: Record<string, { readonly session: { readonly createdAt: number; readonly cwd?: string }; readonly stable: TaskStateStable }>
    readonly audit: Record<string, AuditRow>
  }
}

/** Read the durable domain document from disk (null when absent/unreadable). */
function readDomainDoc(): DomainDoc | null {
  try {
    return JSON.parse(readFileSync(DOMAIN_FILE, 'utf8')) as DomainDoc
  } catch {
    return null
  }
}

/** Durable session record + audit rows for one document, compacted for the ledger. */
function durableView(doc: DomainDoc | null): Record<string, unknown> {
  if (doc === null) return { read: false }
  const record = doc.tables.sessions[String(SESSION_ID)]
  const rows = Object.values(doc.tables.audit)
  return {
    read: true,
    unit: doc.unit,
    sessionRecord: record === undefined ? null : {
      lifecycle: record.session,
      stable: {
        revision: record.stable.revision,
        sourceCursor: record.stable.sourceCursor,
        digest: record.stable.digest,
      },
    },
    auditRowCount: rows.length,
    auditRows: rows
      .map(row => ({
        requestId: String(row.requestId),
        lifecycle: row.session,
        baseRevision: row.request.base?.revision ?? null,
        baseCursor: row.request.base?.sourceCursor ?? null,
        targetRevision: row.request.revision,
        includedSeqs: [...row.request.includedSeqs].map(Number),
        outcome: row.finished?.outcome ?? 'open',
        finishedRevision: row.finished?.revision ?? null,
        finishedCursor: row.finished?.sourceCursor ?? null,
      }))
      .sort((left, right) => left.requestId.localeCompare(right.requestId)),
  }
}

/** Every file under one directory, relative to it, with byte sizes. */
function listFiles(dir: string, base = dir): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...listFiles(full, base))
    else out.push({ path: relative(base, full), bytes: info.size })
  }
  return out
}

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

describe('E07 · restart backlog (does startup discover an unprocessed tail?)', () => {
  it('reopens the same durable storage and session with an unprocessed eligible tail and never folds it until a new event arrives', async () => {
    // ---- fresh experiment-local medium -----------------------------------
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    rmSync(SESSION_ARTIFACT_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })
    mkdirSync(SESSION_ARTIFACT_ROOT, { recursive: true })

    const errors: { stage: string; message: string }[] = []
    const recordError = (stage: string, error: unknown): void => {
      errors.push({ stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    }

    // =====================================================================
    // Stage 1 — process P1: commit a stable; cursor = N
    // =====================================================================
    const stage1: Record<string, unknown> = { process: 'P1', role: 'commit the base stable (stage 1)', openedAt: new Date().toISOString() }
    const p1 = await mountBase()
    let cursorN = -1
    let revisionBase = -1
    try {
      const mountError = await mountProvider(p1)
      if (mountError !== null) recordError('stage1.mountProvider', mountError)
      const session = p1.ctx.sessions.create(SESSION_ID, { meta: { cwd: META_CWD, createdAt: CREATED_AT } })
      p1.session = session

      // One complete, balanced turn: turn/start (log-only) + user + assistant +
      // turn/end, so the durable log needs NO crash repair on restore.
      session.append('turn/start', { turn: STAGE1_TURN })
      const seqUser1 = appendUser(session, 'stage 1: establish the durable record')
      const seqAssistant1 = appendAssistant(session, STAGE1_TURN, 1, 'stage 1: durable record established')
      const seqTurnEnd1 = session.append('turn/end', { turn: STAGE1_TURN, reason: { kind: 'completed' } }).seq
      const lastSeq1 = seqTurnEnd1

      const converged = await waitUntil(
        () => p1.ctx.taskState.getStable(SESSION_ID)?.sourceCursor === lastSeq1,
        CONVERGE_DEADLINE_MS,
      )
      if (!converged) recordError('stage1.converge', new Error('stage-1 stable did not reach the last appended seq'))

      const stable1 = p1.ctx.taskState.getStable(SESSION_ID)
      cursorN = stable1?.sourceCursor ?? -1
      revisionBase = stable1?.revision ?? -1
      const requests1 = p1.adapter.requests.map(row => ({ at: row.at, windowSeqs: row.windowSeqs, inputChars: row.inputChars }))

      Object.assign(stage1, {
        sessionId: String(SESSION_ID),
        lifecycle: { createdAt: CREATED_AT, cwd: META_CWD },
        appendedSeqs: {
          turnStart: 0,
          user: seqUser1,
          assistant: seqAssistant1,
          turnEnd: seqTurnEnd1,
        },
        lastAppendedSeq: lastSeq1,
        logBeforeClose: logView(session),
        stableBeforeClose: stableView(stable1),
        eligibleAboveCursorBeforeClose: eligibleSeqsAbove(session, cursorN),
        surfaceSourceKinds: surfaceSourceKinds(session),
        requests: requests1,
        requestCount: requests1.length,
      })
    } catch (error: unknown) {
      recordError('stage1', error)
    }
    const stage1Close = await closeProcess(p1)
    if (stage1Close !== null) recordError('stage1.dispose', stage1Close)
    const durableAfterP1 = readDomainDoc()
    stage1['disposeError'] = stage1Close
    stage1['closedAt'] = new Date().toISOString()
    stage1['durableAfterClose'] = durableView(durableAfterP1)

    // =====================================================================
    // Stage 2 — process P2: append the backlog ABOVE the cursor, unprocessed
    // =====================================================================
    const stage2: Record<string, unknown> = { process: 'P2', role: 'append the eligible backlog above the cursor (stage 2)', openedAt: new Date().toISOString() }
    const p2 = await mountBase()
    let backlogEligibleSeqs: number[] = []
    let backlogFilterKinds: { seq: number; kind: string | null }[] = []
    let restoredP2Log: LogView | null = null
    let p2LogAfterAppends: LogView | null = null
    try {
      const session = await resumeDurableSession(p2)
      const restored = logView(session)
      restoredP2Log = restored
      Object.assign(stage2, {
        restore: {
          header: {
            id: String(session.header.id),
            createdAt: session.header.createdAt,
            cwd: session.header.cwd ?? null,
            isSeeded: session.header.isSeeded,
          },
          log: restored,
          closeMarkerCount: closeMarkerCount(restored),
          closeMarkerEligible: isEligibleType(RESTORE_MARKER),
        },
        recoveredStableBeforeAppends: stableView(p2.ctx.taskState?.getStable?.(SESSION_ID)),
      })
      // The task-state provider is deliberately NOT mounted yet: this is the
      // production mount-order window in which a resumed Session can receive
      // events before the provider's domain is open and its runtime exists.
      const turnStartSeq = session.append('turn/start', { turn: BACKLOG_TURN }).seq
      const backlogSeqs = [
        appendUser(session, 'backlog A: a complete user turn appended after the committed cursor'),
        appendAssistant(session, BACKLOG_TURN, 1, 'backlog B: the assistant reply of that same turn'),
        session.append('turn/end', { turn: BACKLOG_TURN, reason: { kind: 'completed' } }).seq,
      ]
      backlogFilterKinds = backlogSeqs.map(seq => ({ seq: Number(seq), kind: filterKind(session, Number(seq)) }))
      // Only events the PRODUCTION filter really projects count as eligible tail.
      backlogEligibleSeqs = backlogFilterKinds.filter(row => row.kind !== null).map(row => row.seq)
      const requestsBeforeMount = p2.adapter.requests.length
      p2LogAfterAppends = logView(session)

      Object.assign(stage2, {
        backlogAppended: {
          turnStart: turnStartSeq,
          turnStartEligible: isEligibleType('turn/start'),
          eligibleSeqs: backlogSeqs.map(Number),
          filterKinds: backlogFilterKinds,
          count: backlogEligibleSeqs.length,
        },
        requestsAtAppendTime: requestsBeforeMount,
        eligibleAboveCursorAfterAppends: eligibleSeqsAbove(session, cursorN),
        logAfterAppends: p2LogAfterAppends,
        surfaceSourceKinds: surfaceSourceKinds(session),
      })

      // Mount the provider NOW: its init creates the runtime for the live
      // Session and recomputes the eligible count from the restored log.
      const mountError = await mountProvider(p2)
      if (mountError !== null) recordError('stage2.mountProvider', mountError)
      const recovered2 = await waitUntil(() => p2.ctx.taskState.getStable(SESSION_ID) !== undefined, CONVERGE_DEADLINE_MS)
      if (!recovered2) recordError('stage2.recover', new Error('stage-2 provider did not publish the durable stable'))
      const stable2 = p2.ctx.taskState.getStable(SESSION_ID)
      const eligible2 = eligibleSeqsAbove(session, cursorN)

      await delay(STAGE2_SETTLE_MS)
      Object.assign(stage2, {
        providerMounted: true,
        recoveredStable: stableView(stable2),
        eligibleAboveCursorAtClose: eligibleSeqsAbove(session, cursorN),
        requestsAfterSettle: p2.adapter.requests.length,
        requestsAfterSettleRows: p2.adapter.requests.map(row => ({ at: row.at, windowSeqs: row.windowSeqs })),
        staleByEligibleEvents: eligible2.length,
        backlogStillUnprocessed: p2.ctx.taskState.getStable(SESSION_ID)?.sourceCursor === cursorN,
        settleMs: STAGE2_SETTLE_MS,
      })
    } catch (error: unknown) {
      recordError('stage2', error)
    }
    // =====================================================================
    // Stage 3 — complete close of P2
    // =====================================================================
    const stage3Close = await closeProcess(p2)
    if (stage3Close !== null) recordError('stage3.dispose', stage3Close)
    const durableAfterP2 = readDomainDoc()
    const stage3 = {
      process: 'P2 (close)',
      role: 'complete dispose of the process that created the backlog (stage 3)',
      closedAt: new Date().toISOString(),
      disposeError: stage3Close,
      durableAfterClose: durableView(durableAfterP2),
      sessionArtifacts: listFiles(SESSION_ARTIFACT_ROOT),
      domainArtifactBytes: statSync(DOMAIN_FILE).size,
    }

    // =====================================================================
    // Stage 4 — process P3: reopen the SAME storage and session; NO new event
    // =====================================================================
    const stage4: Record<string, unknown> = { process: 'P3', role: 'reopen with an unprocessed backlog and no new event (stage 4)', openedAt: new Date().toISOString() }
    const p3 = await mountBase()
    let newEventSeq = -1
    let stableAfterNewEvent: TaskStateStable | undefined
    const samples: Record<string, unknown>[] = []
    let includedSeqsFromAudit: number[] = []
    let restoredP3: LogView | null = null
    let recoveredStableP3: TaskStateStable | undefined
    try {
      const session = await resumeDurableSession(p3)
      restoredP3 = logView(session)
      const backlogAtReopen = eligibleSeqsAbove(session, cursorN)
      Object.assign(stage4, {
        restore: {
          header: {
            id: String(session.header.id),
            createdAt: session.header.createdAt,
            cwd: session.header.cwd ?? null,
            isSeeded: session.header.isSeeded,
          },
          log: restoredP3,
          closeMarkerCount: closeMarkerCount(restoredP3),
          closeMarkerEligible: isEligibleType(RESTORE_MARKER),
          identicalToClosedLog: comparesLogs(restoredP3, p2LogAfterAppends),
        },
        backlogAtReopen: {
          eligibleSeqs: backlogAtReopen,
          count: backlogAtReopen.length,
          filterKinds: backlogAtReopen.map(seq => ({ seq, kind: filterKind(session, seq) })),
          sameSeqsAsBeforeClose: backlogAtReopen.join(',') === backlogEligibleSeqs.join(','),
        },
        surfaceSourceKindsAtReopen: surfaceSourceKinds(session),
      })

      // Mount the provider AFTER the session has been restored (the init seed
      // path: runtimeFor() during [Service.init]).
      const mountError = await mountProvider(p3)
      if (mountError !== null) recordError('stage4.mountProvider', mountError)
      const recovered = await waitUntil(() => p3.ctx.taskState.getStable(SESSION_ID) !== undefined, CONVERGE_DEADLINE_MS)
      if (!recovered) recordError('stage4.recover', new Error('stage-4 provider did not publish the durable stable'))
      recoveredStableP3 = p3.ctx.taskState.getStable(SESSION_ID)
      const audienceDocBefore = readDomainDoc()
      const auditRowsBefore = Object.keys(audienceDocBefore?.tables.audit ?? {}).length

      const waitStart = Date.now()
      for (const offset of SAMPLE_OFFSETS) {
        const elapsed = Date.now() - waitStart
        if (elapsed < offset) await delay(offset - elapsed)
        const stable = p3.ctx.taskState.getStable(SESSION_ID)
        const doc = readDomainDoc()
        samples.push({
          tMs: Date.now() - waitStart,
          stableRevision: stable?.revision ?? null,
          sourceCursor: stable?.sourceCursor ?? null,
          eligibleAboveCursor: eligibleSeqsAbove(session, cursorN).length,
          adapterRequests: p3.adapter.requests.length,
          auditRowsOnDisk: doc === null ? null : Object.keys(doc.tables.audit).length,
        })
      }
      const waitMs = Date.now() - waitStart
      const requestsDuringWindow = p3.adapter.requests.map(row => ({ at: row.at, windowSeqs: row.windowSeqs }))

      Object.assign(stage4, {
        startupWaitMs: waitMs,
        samples,
        requestsDuringWindow,
        requestCountDuringWindow: requestsDuringWindow.length,
        startupWaveTriggered: requestsDuringWindow.length > 0,
        stableAfterWindow: stableView(p3.ctx.taskState.getStable(SESSION_ID)),
        auditRowsOnDiskBeforeWindow: auditRowsBefore,
        auditRowsOnDiskAfterWindow: readDomainDoc() === null ? null : Object.keys((readDomainDoc() as DomainDoc).tables.audit).length,
      })

      // ---- exactly ONE new eligible event -------------------------------
      newEventSeq = appendUser(session, 'stage 4: one new eligible event arrives after the restart')
      const converged = await waitUntil(
        () => p3.ctx.taskState.getStable(SESSION_ID)?.sourceCursor === newEventSeq,
        CONVERGE_DEADLINE_MS,
      )
      if (!converged) recordError('stage4.newEvent', new Error('the new event did not cause a commit covering the tail'))
      stableAfterNewEvent = p3.ctx.taskState.getStable(SESSION_ID)
      Object.assign(stage4, {
        newEvent: {
          seq: newEventSeq,
          filterKind: filterKind(session, newEventSeq),
          appendedAtMsAfterReopen: Date.now() - waitStart,
        },
        requestsAfterNewEvent: p3.adapter.requests.map(row => ({ at: row.at, windowSeqs: row.windowSeqs, maxSeq: row.maxSeq })),
        stableAfterNewEvent: stableView(stableAfterNewEvent),
        eligibleAboveCursorAfterNewEvent: eligibleSeqsAbove(session, stableAfterNewEvent?.sourceCursor ?? cursorN),
        surfaceSourceKindsAfterNewEvent: surfaceSourceKinds(session),
        logAfterNewEvent: logView(session),
      })
    } catch (error: unknown) {
      recordError('stage4', error)
    }
    const stage4Close = await closeProcess(p3)
    if (stage4Close !== null) recordError('stage4.dispose', stage4Close)
    const durableAfterP3 = readDomainDoc()
    stage4['disposeError'] = stage4Close
    stage4['closedAt'] = new Date().toISOString()
    stage4['durableAfterClose'] = durableView(durableAfterP3)
    includedSeqsFromAudit = lastCommittedIncludedSeqs(durableAfterP3)

    // =====================================================================
    // Criteria (fixed before the run) and the verdict
    // =====================================================================
    const backlogCount = backlogEligibleSeqs.length
    const backlogAboveCursor = backlogCount >= CONFIG.minEvents
      && backlogEligibleSeqs.length > 0
      && backlogEligibleSeqs.every(seq => seq > cursorN)
    const backlogPresentAtClose = backlogAboveCursor
      && stage2['backlogStillUnprocessed'] === true
      && (durableAfterP2?.tables.sessions[String(SESSION_ID)]?.stable.sourceCursor ?? -1) === cursorN
    // The durable log must come back EXACTLY as it was closed, plus the single
    // non-eligible `session/end-seed` close marker the production resume path
    // appends per restore (verified non-eligible, so it can never itself act as
    // the "new activity" that folds the backlog; markers accumulate one per
    // restore, and the previous restore's marker is part of the closed log).
    const logRestoredExactly = restoredP2Log !== null
      && p2LogAfterAppends !== null
      && restoredP3 !== null
      && restoredP2Log.types.join(',') === [...LOG_AFTER_STAGE1, RESTORE_MARKER].join(',')
      && restoredP2Log.lastSeq === LOG_AFTER_STAGE1.length
      && closeMarkerCount(restoredP2Log) === 1
      && restoredP3.types.join(',') === [...p2LogAfterAppends.types, RESTORE_MARKER].join(',')
      && restoredP3.lastSeq === p2LogAfterAppends.lastSeq + 1
      && closeMarkerCount(restoredP3) === closeMarkerCount(p2LogAfterAppends) + 1
      && endsWithCloseMarker(restoredP2Log)
      && endsWithCloseMarker(restoredP3)
    const backlogSeqsSurvived = (stage4['backlogAtReopen'] as { sameSeqsAsBeforeClose?: boolean } | undefined)
      ?.sameSeqsAsBeforeClose === true
    const stableRecovered = recoveredStableP3 !== undefined
      && recoveredStableP3.revision === revisionBase
      && recoveredStableP3.sourceCursor === cursorN
    const noStartupWave = samples.length > 0
      && samples.every(sample => sample['adapterRequests'] === 0
        && sample['stableRevision'] === revisionBase
        && sample['sourceCursor'] === cursorN
        && sample['eligibleAboveCursor'] === backlogCount)
    const newEventTriggeredUpdate = stableAfterNewEvent !== undefined
      && stableAfterNewEvent.revision === revisionBase + 1
      && stableAfterNewEvent.sourceCursor === newEventSeq
    const foldedWindowContainsBacklog = backlogEligibleSeqs.every(seq => includedSeqsFromAudit.includes(seq))
      && includedSeqsFromAudit.includes(newEventSeq)

    const routeWorked = errors.length === 0
    const evidenceComplete = routeWorked && logRestoredExactly && backlogSeqsSurvived && stableRecovered && backlogPresentAtClose
    const verdict = !evidenceComplete
      ? 'inconclusive'
      : noStartupWave && newEventTriggeredUpdate && foldedWindowContainsBacklog
        ? 'reproduced'
        : 'not-reproduced'

    const ledger = {
      experiment: 'E07-restart-backlog',
      question: 'When a committed stable sits at cursor = N and eligible events exist above N that no update folded, and the process is closed, does a NEW process reopening the SAME durable storage and resuming the SAME session — with NO new event — actively discover that backlog and update the stable inside the normal worker scheduling window?',
      verdictRule: 'reproduced = backlog exists (count >= minEvents above the committed cursor), no new event after the restart leaves stable/cursor untouched through a wait far beyond the worker window (zero requests, zero new audit rows), AND exactly one newly appended eligible event triggers an update whose folded window contains the whole backlog; not-reproduced = startup updated it without new activity, or the new event failed to fold the backlog; inconclusive = the fixture/runner/medium could not produce the evidence.',
      measurement: 'REAL durable storage domain + REAL JSONL session persistence + REAL resume (ctx.sessionPersistence.prepare/enter/announce) + REAL TaskStateBasicService (ctx.plugin) + REAL filter math + REAL renderer; FAKE LLM (scripted adapter, no usage); temporary medium INSIDE this E07 directory; no $HOME/.dsh, no existing session, no port, no concurrent process.',
      invokedAs: 'ctx.plugin(TaskStateBasicService, CONFIG) — the production service; the fixture never constructs TaskStateWorker and never calls observe/maybeSchedule/performBatch by hand',
      workerManuallyInvoked: false,
      config: { ...CONFIG, note: 'minEvents = 1: one eligible event above the committed cursor already meets the production trigger threshold, so "below threshold" cannot explain inactivity' },
      processes: [
        { id: 'P1', role: 'stage 1 — commit the base stable (cursor = N)' },
        { id: 'P2', role: 'stage 2 — append the eligible backlog above the cursor while the provider is not yet mounted; then mount the provider and settle' },
        { id: 'P3', role: 'stage 4 — reopen the same storage/session, no new event, wait, then append exactly one new event' },
        { id: 'P2-close', role: 'stage 3 — complete dispose/close of P2' },
      ],
      storage: {
        domainRootRelative: relative(process.cwd(), STORAGE_ROOT),
        sessionRootRelative: relative(process.cwd(), SESSION_ARTIFACT_ROOT),
        backend: 'json',
        domain: 'context_enhancement_task_state',
        domainFileRelative: relative(process.cwd(), DOMAIN_FILE),
        sessionArtifacts: listFiles(SESSION_ARTIFACT_ROOT),
      },
      stages: { stage1, stage2, stage3, stage4 },
      backlog: {
        committedCursorN: cursorN,
        committedRevisionBase: revisionBase,
        minEvents: CONFIG.minEvents,
        eligibleSeqs: backlogEligibleSeqs,
        filterKinds: backlogFilterKinds,
        count: backlogCount,
        aboveCursor: backlogAboveCursor,
        requestsWhileAlive: stage2['requestsAfterSettle'] ?? null,
      },
      recovery: {
        restoredLog: restoredP3,
        logRestoredExactly,
        closeMarker: {
          type: RESTORE_MARKER,
          eligible: isEligibleType(RESTORE_MARKER),
          countInLogBeforeClose: p2LogAfterAppends === null ? null : closeMarkerCount(p2LogAfterAppends),
          countInLogAfterReopen: restoredP3 === null ? null : closeMarkerCount(restoredP3),
          appendedByThisRestore: restoredP3 === null || p2LogAfterAppends === null
            ? null
            : closeMarkerCount(restoredP3) - closeMarkerCount(p2LogAfterAppends),
          note: 'the resume path closes a log durably by appending exactly one session/end-seed marker, which the production filter does NOT treat as eligible: the reopened log therefore holds strictly the same eligible tail and no new eligible activity',
        },
        backlogSeqsSurvived,
        recoveredStable: stableView(recoveredStableP3),
        stableRecovered,
      },
      startupWindow: {
        waitMs: stage4['startupWaitMs'] ?? null,
        samples,
        requestCountDuringWindow: stage4['requestCountDuringWindow'] ?? null,
        startupWaveTriggered: stage4['startupWaveTriggered'] ?? null,
        noStartupWave,
      },
      afterNewEvent: {
        newEventSeq,
        requests: stage4['requestsAfterNewEvent'] ?? null,
        stable: stage4['stableAfterNewEvent'] ?? null,
        includedSeqsFromDurableAuditRow: includedSeqsFromAudit,
        newEventTriggeredUpdate,
        foldedWindowContainsBacklog,
      },
      criteria: {
        fixedBeforeRun: true,
        backlogCount,
        backlogAboveCursor,
        backlogPresentAtClose,
        logRestoredExactly,
        backlogSeqsSurvived,
        stableRecovered,
        noStartupWave,
        newEventTriggeredUpdate,
        foldedWindowContainsBacklog,
        routeWorked,
        evidenceComplete,
        verdict,
      },
      verdict,
      errors,
      limitations: [
        'token/字符量是 fake adapter 观测到的输入输出字符数，不是 provider token；fake adapter 不产生 usage，故 provider token、计费量与真实摘要语义均未测量。',
        'backlog 的产生方式：第二阶段在 provider 挂载之前（生产 domain open / 挂载次序窗口，provider 自身 init 用 createdDuringOpen 覆盖该窗口）向已恢复的 Session 追加一个完整 turn，因此没有任何 worker 观测到这些事件（0 次模型请求）。真实断电场景还可能是「波次在飞行中进程退出」或「波次失败留下尾巴」；本实验未覆盖后两种 provenance（会在同一条重启路径上产生相同的存储状态，但语义上属于未测变体）。',
        '三个阶段是同一 vitest 进程内顺序挂载/销毁的三个 Cordis Context，不是三个操作系统进程；但每个阶段的 storage/JSONL 句柄都已完整 close 并从磁盘重新打开，且任一时刻只有一个 Context 存活。',
        'minEvents = 1 是生产允许的最小阈值（tests/task-state-restart-recovery.spec.ts 与 task-state-long-session.spec.ts 的 restart 用例同样用 1）；真实部署取值是否 ≥ 本实验未测量，但更大的 minEvents 只会让「startup 不处理 backlog」更容易成立。',
        '单个 Session、单个 lifecycle、单次重启：未测多 Session、多实例、fork/resume、审计修复路径或真实 DSH 进程的退出竞态。',
        '等待窗口 2 000 ms 远大于 worker 的微任务调度窗口，但仍是有限窗口：本实验证明的是「窗口内不发生」，不是「永不发生」。',
        'renderTaskStateSnapshot 的注入文本 hash 只用于证明恢复后 stable 未变、以及新事件后 stable 已变；它不测量真实 prompt assembly 的可见节点数或 token 归因。',
        '本实验「通过」只表示 fixture 断言通过，不代表理想方案通过或用户现象不存在；它只回答本文件开头的那一个问题。',
      ],
      sourceKinds: {
        note: 'source kinds of the events involved: the task-state filter projection kind per backlog seq, and the Session surface source kind (original user/assistant log event vs a derived replacement) at the close, at the reopen and after the new event',
        backlogFilterKinds,
        surfaceSourceKindsAtStage2Close: stage2['surfaceSourceKinds'] ?? null,
        surfaceSourceKindsAtReopen: stage4['surfaceSourceKindsAtReopen'] ?? null,
        surfaceSourceKindsAfterNewEvent: stage4['surfaceSourceKindsAfterNewEvent'] ?? null,
      },
    }

    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    // ---- structural invariants (the fixture ran as designed) -------------
    expect(errors).toEqual([])
    expect(revisionBase).toBeGreaterThanOrEqual(1)
    expect(cursorN).toBe(3)
    expect(backlogEligibleSeqs.length).toBe(3)
    expect(backlogEligibleSeqs.every(seq => seq > cursorN)).toBe(true)
    expect(backlogAboveCursor).toBe(true)
    expect(stage2['requestsAfterSettle']).toBe(0)
    expect(logRestoredExactly).toBe(true)
    expect(backlogSeqsSurvived).toBe(true)
    expect(isEligibleType(RESTORE_MARKER)).toBe(false)
    expect(stableRecovered).toBe(true)
    expect(samples.length).toBe(SAMPLE_OFFSETS.length)
    expect(noStartupWave).toBe(true)
    expect(newEventTriggeredUpdate).toBe(true)
    expect(foldedWindowContainsBacklog).toBe(true)
    expect(includedSeqsFromAudit).toEqual([...backlogEligibleSeqs, newEventSeq])
    expect(verdict).toBe('reproduced')
  }, 180_000)
})

/** Compare two compact log views. */
function comparesLogs(
  left: LogView | null,
  right: LogView | undefined,
): boolean {
  if (left === null || right === undefined) return false
  return left.length === right.length && left.lastSeq === right.lastSeq && left.types.join(',') === right.types.join(',')
}

/** The `includedSeqs` of the newest finished/committed audit row on disk. */
function lastCommittedIncludedSeqs(doc: DomainDoc | null): number[] {
  if (doc === null) return []
  const rows = Object.values(doc.tables.audit)
    .filter(row => row.finished?.outcome === 'success' || row.finished?.outcome === 'repair')
    .sort((left, right) => (left.finished?.revision ?? 0) - (right.finished?.revision ?? 0))
  const last = rows[rows.length - 1]
  return last === undefined ? [] : [...last.request.includedSeqs].map(Number)
}
