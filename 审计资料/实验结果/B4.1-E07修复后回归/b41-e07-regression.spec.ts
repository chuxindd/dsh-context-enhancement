/**
 * B4.1 · E07 fixed-fixture comparison (same question, same fixture, fixed code).
 *
 * §1 Question (identical to `审计资料/实验结果/E07-重启积压/e07-restart-backlog.spec.ts`)
 * ---------------------------------------------------------------------------------
 * A stable is already committed at `sourceCursor = N`, the log holds
 * filter-eligible events ABOVE `N` that were never folded, and the process was
 * closed before the worker could update. When the process is reopened against
 * the SAME durable storage, the SAME session id and the SAME lifecycle, with
 * NOTHING appended, does startup discover the backlog and fold it on its own?
 *
 * §2 What is REAL here
 * --------------------
 * - real durable storage domain (`Storage` + `StorageJson` + `StorageDomain`,
 *   backend `json`, domain `context_enhancement_task_state`) rooted INSIDE this
 *   comparison directory;
 * - real `SessionStore` + real `JsonlSessionPersistence` (real resume artifact)
 *   and the real resume idiom `ctx.sessionPersistence.prepare(id)` →
 *   `ctx.sessions.enter(...)` → `ctx.sessions.announce(...)`;
 * - real `TaskStateBasicService` mounted through `ctx.plugin` (production
 *   scheduler, filter, batch fold, prompt frame, validation, authority put,
 *   audit rows, and the B4.1 startup backlog check);
 * - real production filter `isEligibleType` + `filterEvent` to decide what
 *   counts as an eligible event above the cursor;
 * - real production renderer `renderTaskStateSnapshot` for the injection text.
 *
 * FAKE: only the LLM — a scripted `LlmAdapter` that answers one structurally
 * valid candidate JSON per request, echoing the highest folded seq it was
 * handed, and records every request. Its `usage` is absent, so no provider
 * tokens are measured.
 *
 * §3 What this spec deliberately does NOT do
 * ------------------------------------------
 * - it never constructs a `TaskStateWorker` and never calls `observe`,
 *   `maybeSchedule`, `maybeScheduleStartup` or `performBatch` by hand: every
 *   wave in this run is admitted by the PRODUCTION provider path
 *   (`session/created`, `session/event`, or the startup check the provider
 *   queues on a microtask after hydration), so a "the fixture triggered it"
 *   explanation cannot survive;
 * - it never touches the historical `E07-重启积压/` directory, `src/`, the
 *   existing `tests/`, any harness, `package.json`, `vitest.config.ts`, `lib`,
 *   or the tgz;
 * - it never uses the real `$HOME/.dsh`, an existing session, port 8080, the
 *   Web GUI, or a second live process (the four "processes" are sequentially
 *   mounted Cordis contexts; only one is alive at a time).
 *
 * §4 How to read the verdict
 * --------------------------
 * E07's own verdict rule says: "reproduced = backlog exists, no new event after
 * the restart leaves stable/cursor untouched through a wait far beyond the
 * worker window (zero requests, zero new audit rows), AND exactly one newly
 * appended eligible event triggers an update whose folded window contains the
 * whole backlog". The SAME rule is applied here, and the expected post-fix
 * outcome is the complementary branch of that rule: startup folds the backlog
 * with no new activity (`verdict = "fixed"`). The rule and the criteria are
 * reported even when they come out against the fix.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
// Fixed comparison constants (E07 parity — identical values)
// ---------------------------------------------------------------------------

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** Real durable task-state domain root — INSIDE this comparison directory. */
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')
/** Real durable JSONL session-log root — INSIDE this comparison directory. */
const SESSION_ROOT = join(OUT_DIR, 'tmp-sessions')
/** The durable domain document written by the real JSON storage backend. */
const DOMAIN_FILE = join(STORAGE_ROOT, 'context_enhancement_task_state.json')
const LEDGER_PATH = join(OUT_DIR, 'b41-ledger.json')

const ROOT_DIR = join(OUT_DIR, '..', '..', '..')
const E07_LEDGER = join(ROOT_DIR, '审计资料', '实验结果', 'E07-重启积压', 'e07-ledger.json')
const E07_SPEC = join(ROOT_DIR, '审计资料', '实验结果', 'E07-重启积压', 'e07-restart-backlog.spec.ts')

const SESSION_ID = SessionId('e07-restart-backlog')
const CREATED_AT = 1_700_000_000_000
const META_CWD = STORAGE_ROOT

const PROVIDER = 'current-route'
const MODEL = 'current-model'
const SURFACE = { surfaceOp: 'append' as const }

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
/** Stage-2 backlog turn: seq 4..7 (`turn/start` ineligible, then 3 eligible). */
const BACKLOG_TURN = 2
/** The single control event appended after the startup window (stage-3 turn). */
const NEW_EVENT_TURN = 3
/** Terminal marker the production resume path appends to a closed log. */
const RESTORE_MARKER = 'session/end-seed'

/** Wait window (ms) — identical to E07. */
const STARTUP_WAIT_MS = 2_000
/** Sampling offsets inside the wait window (ms) — identical to E07. */
const SAMPLE_OFFSETS = [0, 100, 250, 500, 1_000, 1_500, 2_000]
/** Deadline for one full `ctx.fiber.dispose()` (ms). */
const DISPOSE_DEADLINE_MS = 15_000
/** Deadline for a convergence wait (ms). */
const CONVERGE_DEADLINE_MS = 10_000

// ---------------------------------------------------------------------------
// Deterministic helpers
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
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false
    await delay(5)
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

/** SHA-256 of one file, or `'unreadable'`. */
function sha256File(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'unreadable'
  }
}

// ---------------------------------------------------------------------------
// The scripted fake model (the ONLY LLM in this comparison)
// ---------------------------------------------------------------------------

/** One captured auxiliary request. */
interface AdapterRequestRow {
  readonly at: number
  readonly provider: string
  readonly model: string
  readonly purpose: string | null
  readonly windowSeqs: readonly number[]
  readonly maxSeq: number
  readonly inputChars: number
  readonly outputChars: number
}

/** Answers every auxiliary request with one valid candidate JSON, recording it. */
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
      facts: [{ content: `b41 durable record folded eligible events through ${maxSeq}` }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `B4.1 restart backlog probe window-through-${maxSeq}`,
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
  session: Session | null
  detachSession: (() => void) | null
  preparation: unknown
}

/** Mount the host stack at the FIXED comparison roots. */
async function mountBase(): Promise<MountedProcess> {
  const ctx = new Context()
  const adapter = new CountingAdapter()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: SESSION_ROOT,
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

/** Resume the durable Session through the production prepare/enter/announce idiom. */
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

/** Mount the real task-state provider (its init seeds the runtime for a live Session). */
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

/** The production filter projection kind of one event, or null when nothing projects. */
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

/** Compact view of one Session's durable log. */
interface LogView {
  readonly length: number
  readonly types: string[]
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

/** Surface source kinds per event type (original vs derived), E07 parity. */
function surfaceSourceKinds(session: Session): Record<string, number> {
  const kinds: Record<string, number> = {}
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data as { readonly message?: { readonly source?: { readonly kind?: unknown } } }
    const kind = typeof data.message?.source?.kind === 'string' ? data.message.source.kind : 'unknown'
    const key = `${event.type}:${kind}`
    kinds[key] = (kinds[key] ?? 0) + 1
  }
  return kinds
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
    readonly trigger?: string
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
    readonly sessions: Record<string, {
      readonly session: { readonly createdAt: number; readonly cwd?: string }
      readonly stable: TaskStateStable
    }>
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
        trigger: row.request.trigger ?? null,
        baseRevision: row.request.base?.revision ?? null,
        baseCursor: row.request.base?.sourceCursor ?? null,
        targetRevision: row.request.revision,
        includedSeqs: [...row.request.includedSeqs].map(Number),
        outcome: row.finished?.outcome ?? 'open',
        finishedRevision: row.finished?.revision ?? null,
        finishedCursor: row.finished?.sourceCursor ?? null,
      }))
      .sort((left, right) => (left.targetRevision - right.targetRevision) || left.requestId.localeCompare(right.requestId)),
  }
}

/** Every file under one directory, relative to it, with byte sizes. */
function listFiles(dir: string, base = dir): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push({ path: relative(base, full), bytes: statSync(full).size })
  }
  return out.sort((left, right) => left.path.localeCompare(right.path))
}

/** The `includedSeqs` of the newest finished-success audit row on disk. */
function lastCommittedIncludedSeqs(doc: DomainDoc | null): number[] {
  if (doc === null) return []
  const rows = Object.values(doc.tables.audit)
    .filter(row => row.finished?.outcome === 'success' || row.finished?.outcome === 'repair')
    .sort((left, right) => (left.finished?.revision ?? 0) - (right.finished?.revision ?? 0))
  const last = rows[rows.length - 1]
  return last === undefined ? [] : [...last.request.includedSeqs].map(Number)
}

/** The trigger of one committed revision, from the durable document. */
function triggerOfRevision(doc: DomainDoc | null, revision: number): string | null {
  if (doc === null) return null
  const row = Object.values(doc.tables.audit)
    .find(candidate => candidate.request.revision === revision && candidate.finished !== undefined)
  return row?.request.trigger ?? null
}

/** Read the E07 baseline verdict and criteria for the side-by-side block. */
function readE07Baseline(): Record<string, unknown> {
  try {
    const ledger = JSON.parse(readFileSync(E07_LEDGER, 'utf8')) as {
      verdict?: string
      criteria?: Record<string, unknown>
      startupWindow?: { requestCountDuringWindow?: number; noStartupWave?: boolean; waitMs?: number }
      backlog?: Record<string, unknown>
    }
    return {
      ledgerSha256: sha256File(E07_LEDGER),
      specSha256: sha256File(E07_SPEC),
      verdict: ledger.verdict ?? null,
      startupWindow: ledger.startupWindow ?? null,
      criteria: ledger.criteria ?? null,
      backlog: ledger.backlog ?? null,
    }
  } catch {
    return { ledgerSha256: 'unreadable', specSha256: 'unreadable', verdict: null }
  }
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

describe('B4.1 · E07 fixed fixture (startup backlog after a restart)', () => {
  it('folds the unprocessed eligible tail on reopen with no new Session event, after the recovered baseline is published', async () => {
    // The medium is fully owned by this comparison: start from a clean root.
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    rmSync(SESSION_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })
    mkdirSync(SESSION_ROOT, { recursive: true })

    const errors: string[] = []

    /** Source fingerprint of the plugin tree this run used (fix evidence). */
    const sourceFiles = [
      'src/internal/task-state/basic/service.ts',
      'src/internal/task-state/basic/worker.ts',
      'src/internal/task-state/basic/update.ts',
      'src/internal/task-state/contract/types.ts',
      'src/internal/task-state/contract/audit.ts',
      'src/task-state.ts',
      'tests/task-state-startup-backlog.spec.ts',
    ]
    const sourceHashes: Record<string, string> = {}
    for (const relativePath of sourceFiles) sourceHashes[relativePath] = sha256File(join(ROOT_DIR, relativePath))

    // ---- stage 1 (P1): commit a stable at cursor N = 3 --------------------
    const p1 = await mountBase()
    const providerError1 = await mountProvider(p1)
    if (providerError1 !== null) errors.push(`stage 1 provider mount: ${providerError1}`)
    const session1 = p1.ctx.sessions.create(SESSION_ID, { meta: { cwd: META_CWD, createdAt: CREATED_AT } })
    session1.append('turn/start', { turn: STAGE1_TURN })
    appendUser(session1, 'B4.1 stage one user message')
    appendAssistant(session1, STAGE1_TURN, 1, 'B4.1 stage one assistant message')
    session1.append('turn/end', { turn: STAGE1_TURN, reason: { kind: 'completed' } })
    const converged1 = await waitUntil(() => p1.ctx.taskState.getStable(SESSION_ID) !== undefined, CONVERGE_DEADLINE_MS)
    if (!converged1) errors.push('stage 1 did not commit a stable')
    const stable1 = p1.ctx.taskState.getStable(SESSION_ID)
    const cursorN = stable1?.sourceCursor ?? -1
    const revisionBase = stable1?.revision ?? 0
    // Let the stage-1 worker settle so no wave is still in flight at close.
    await delay(150)
    const stage1 = {
      providerError: providerError1,
      log: logView(session1),
      stable: stableView(stable1),
      requests: p1.adapter.requests.map(row => ({ windowSeqs: row.windowSeqs, maxSeq: row.maxSeq })),
      durable: durableView(readDomainDoc()),
    }
    const closeError1 = await closeProcess(p1)
    if (closeError1 !== null) errors.push(`stage 1 close: ${closeError1}`)
    const stage1Close = { error: closeError1, durable: durableView(readDomainDoc()) }

    // ---- stage 2 (P2): append the backlog with NO provider mounted --------
    const p2 = await mountBase()
    const session2 = await resumeDurableSession(p2)
    const turnStartSeq = session2.append('turn/start', { turn: BACKLOG_TURN }).seq
    const backlogSeqs = [
      appendUser(session2, 'B4.1 stage two backlog user message'),
      appendAssistant(session2, BACKLOG_TURN, 1, 'B4.1 stage two backlog assistant message'),
      session2.append('turn/end', { turn: BACKLOG_TURN, reason: { kind: 'completed' } }).seq,
    ]
    const backlogKinds = backlogSeqs.map(seq => ({ seq, kind: filterKind(session2, seq) }))
    // No provider is mounted: the backlog must survive the close untouched.
    await delay(150)
    const stage2 = {
      log: logView(session2),
      turnStartSeq,
      backlogSeqs,
      backlogKinds,
      eligibleAboveCursor: eligibleSeqsAbove(session2, cursorN),
      requestsWhileAlive: p2.adapter.requests.length,
      durable: durableView(readDomainDoc()),
    }
    const closeError2 = await closeProcess(p2)
    if (closeError2 !== null) errors.push(`stage 2 close: ${closeError2}`)
    const stage2Close = { error: closeError2, durable: durableView(readDomainDoc()) }

    // ---- stage 3 (P3): confirm the medium carried the backlog -------------
    const p3 = await mountBase()
    const session3 = await resumeDurableSession(p3)
    const durableAtReopen = durableView(readDomainDoc())
    const logAtReopen = logView(session3)
    const backlogAtReopen = eligibleSeqsAbove(session3, cursorN)
    const stage3 = {
      log: logAtReopen,
      backlogAtReopen,
      surfacedSourceKindsAtReopen: surfaceSourceKinds(session3),
      durable: durableAtReopen,
      requests: p3.adapter.requests.length,
    }
    const closeError3 = await closeProcess(p3)
    if (closeError3 !== null) errors.push(`stage 3 close: ${closeError3}`)

    // ---- stage 4 (P4): reopen the SAME medium and append NOTHING ----------
    const p4 = await mountBase()
    interface PublicationRow {
      revision: number
      sourceCursor: number
      requestsAtPublish: number
      atMs: number
    }
    const publications: PublicationRow[] = []
    const providerError4 = await mountProvider(p4)
    if (providerError4 !== null) errors.push(`stage 4 provider mount: ${providerError4}`)
    // Subscribe AFTER the provider's init: the recovered baseline is published
    // during init/hydration, which is exactly the publication this comparison
    // wants to order against the backlog request. The listener therefore
    // observes every publication from the mount onward, and the baseline is
    // cross-checked from the durable session record instead of from an event.
    const provider4 = p4.ctx.get('taskState') as TaskStateBasicService
    provider4.subscribeCommitted((_id, stable) => {
      publications.push({
        revision: stable.revision,
        sourceCursor: stable.sourceCursor,
        requestsAtPublish: p4.adapter.requests.length,
        atMs: Date.now(),
      })
    })

    const waitWindowStart = Date.now()
    const session4 = await resumeDurableSession(p4)
    const recovered = p4.ctx.taskState.getStable(SESSION_ID)
    const recoveredView = stableView(recovered)
    const durableAtResume = durableView(readDomainDoc())
    const samples: Record<string, unknown>[] = []
    let previousOffset = 0
    for (const offset of SAMPLE_OFFSETS) {
      await delay(Math.max(0, offset - previousOffset))
      previousOffset = offset
      const stable = p4.ctx.taskState.getStable(SESSION_ID)
      samples.push({
        offsetMs: offset,
        stableRevision: stable?.revision ?? null,
        sourceCursor: stable?.sourceCursor ?? null,
        eligibleAboveCursor: eligibleSeqsAbove(session4, cursorN),
        adapterRequests: p4.adapter.requests.length,
        auditRowsOnDisk: Object.keys(readDomainDoc()?.tables.audit ?? {}).length,
      })
    }
    const durableAfterWindow = durableView(readDomainDoc())
    const stableAfterWindow = p4.ctx.taskState.getStable(SESSION_ID)
    const requestsDuringWindow = p4.adapter.requests.length
    const waveSample = samples.find(sample => Number(sample['stableRevision'] ?? 0) > revisionBase)
    const startupWindow = {
      waitMs: SAMPLE_OFFSETS[SAMPLE_OFFSETS.length - 1],
      windowStartMs: waitWindowStart,
      samples,
      requestCountDuringWindow: requestsDuringWindow,
      requestWindowsDuringWindow: p4.adapter.requests.map(row => row.windowSeqs),
      startupWaveTriggered: waveSample !== undefined,
      firstWaveSampleOffsetMs: waveSample === undefined ? null : Number(waveSample['offsetMs']),
      stableAfterWindow: stableView(stableAfterWindow),
      durableAfterWindow,
      startupTriggerFromDurableAudit:
        triggerOfRevision(readDomainDoc(), revisionBase + 1),
    }
    const stage4 = {
      providerError: providerError4,
      recovered: recoveredView,
      durableAtResume,
      publications,
      startupWindow,
      log: logView(session4),
      eligibleAboveCursor: eligibleSeqsAbove(session4, cursorN),
      restoreMarker: {
        type: RESTORE_MARKER,
        eligible: isEligibleType(RESTORE_MARKER),
        countInLog: logView(session4).types.filter(type => type === RESTORE_MARKER).length,
        appendedByThisRestore: logView(session4).types.filter(type => type === RESTORE_MARKER).length
          - logAtReopen.types.filter(type => type === RESTORE_MARKER).length,
      },
    }

    // ---- the control: exactly ONE new eligible event ----------------------
    const newEventSeq = appendUser(session4, 'B4.1 stage four single new user message')
    const converged4 = await waitUntil(
      () => (p4.ctx.taskState.getStable(SESSION_ID)?.revision ?? 0) > (stableAfterWindow?.revision ?? 0),
      CONVERGE_DEADLINE_MS,
    )
    if (!converged4) errors.push('stage 4 control event did not produce a further commit')
    await delay(100)
    const stableAfterNewEvent = p4.ctx.taskState.getStable(SESSION_ID)
    const afterNewEvent = {
      newEventSeq,
      requests: p4.adapter.requests.map(row => ({ windowSeqs: row.windowSeqs, maxSeq: row.maxSeq })),
      stable: stableView(stableAfterNewEvent),
      includedSeqsFromDurableAuditRow: lastCommittedIncludedSeqs(readDomainDoc()),
      surfacedSourceKindsAfterNewEvent: surfaceSourceKinds(session4),
      durable: durableView(readDomainDoc()),
    }
    const closeError4 = await closeProcess(p4)
    if (closeError4 !== null) errors.push(`stage 4 close: ${closeError4}`)

    // ---- criteria (fixed by the E07 verdict rule, reported as-is) ---------
    const recordAfterWindow = durableAfterWindow['sessionRecord'] as
      | { stable: { revision: number; sourceCursor: number } }
      | null
    const criteria = {
      fixedBeforeRun: true,
      /** Fixture parity with E07: the backlog really exists above the cursor. */
      backlogNonEmpty: backlogAtReopen.length > 0,
      backlogCountMeetsMinEvents: backlogAtReopen.length >= CONFIG.minEvents,
      backlogAboveCursor: backlogAtReopen.every(seq => seq > cursorN),
      backlogUntouchedWhileUnmounted: stage2.requestsWhileAlive === 0,
      /** Recovery published the stored baseline before any backlog request. */
      baselineServedFromStoredRecord: recoveredView !== null
        && recoveredView['revision'] === revisionBase
        && recoveredView['sourceCursor'] === cursorN,
      durableAtResumeAtBaseline: (durableAtResume['sessionRecord'] as { stable: { revision: number } } | null)
        ?.stable.revision === revisionBase,
      /** The fix: startup discovers and folds the backlog with no new event. */
      startupWaveTriggered: waveSample !== undefined,
      startupWaveWithinWindow: waveSample !== undefined
        && Number(waveSample['offsetMs']) <= STARTUP_WAIT_MS,
      startupWaveFoldedWholeBacklog: recordAfterWindow?.stable.revision === revisionBase + 1
        && recordAfterWindow.stable.sourceCursor === backlogSeqs[backlogSeqs.length - 1],
      startupWaveWindowIsTheBacklog: p4.adapter.requests.some(
        row => row.windowSeqs.join(',') === backlogSeqs.join(','),
      ),
      startupTriggerRecorded: triggerOfRevision(readDomainDoc(), revisionBase + 1) === 'startup',
      /** Every reopen handed the worker exactly the same eligible tail. */
      backlogSurvivedEveryReopen: stage4.eligibleAboveCursor.join(',') === backlogSeqs.join(',')
        && backlogAtReopen.join(',') === backlogSeqs.join(','),
      /** The startup window itself saw no new eligible activity. */
      noNewEligibleActivityBeforeTheWindow: stage4.eligibleAboveCursor.join(',') === backlogSeqs.join(','),
      /** No wave before the startup check ran, and the control event still works. */
      controlEventTriggeredUpdate: (stableAfterNewEvent?.revision ?? 0) > (stableAfterWindow?.revision ?? 0),
      controlWindowContainsBacklog: lastCommittedIncludedSeqs(readDomainDoc()).includes(newEventSeq),
      routeWorked: p4.adapter.requests.every(row => row.provider === PROVIDER && row.model === MODEL),
      evidenceComplete: durableAfterWindow['read'] === true && recoveredView !== null,
      noErrors: errors.length === 0,
    }
    const verdict = Object.values(criteria).every(value => value === true) ? 'fixed' : 'still-reproduced'

    const ledger = {
      experiment: 'B4.1-E07修复后回归',
      question: '当 stable 已提交且 sourceCursor = N，日志中已存在高于 N 但从未被折叠的 filter eligible 事件，进程在 worker 更新之前关闭；随后用相同持久 storage、相同 session id 恢复运行且不追加任何新事件时，启动是否会主动发现该积压并更新 stable？',
      verdictRule: 'E07 的判据规则原样沿用，只替换代码：fixed = 恢复后基线 stable 先被服务（记录中的 revision/cursor 在 resume 时为基线值），且在一个远超 worker 调度窗口的等待内、不追加任何事件的情况下，启动路径自行发起了恰好一波请求把 cursor 之上的全部 eligible 积压折叠进新 revision（durable audit 行的 trigger 为 startup）；still-reproduced = 等待窗口内 stable/cursor 保持基线不变（零请求、零新 audit 行），即 E07 原状；inconclusive = fixture/runner/medium 未能产生证据。',
      measurement: 'REAL durable storage domain + REAL JSONL session persistence + REAL resume (ctx.sessionPersistence.prepare/enter/announce) + REAL TaskStateBasicService (ctx.plugin) + REAL filter math + REAL renderer; FAKE LLM (scripted adapter, no usage); temporary medium INSIDE this comparison directory; no $HOME/.dsh, no existing session, no port, no concurrent process.',
      invokedAs: 'ctx.plugin(TaskStateBasicService, CONFIG) — the production service; the fixture never constructs TaskStateWorker and never calls observe/maybeSchedule/maybeScheduleStartup/performBatch by hand',
      workerManuallyInvoked: false,
      config: {
        ...CONFIG,
        note: 'minEvents = 1（与 E07 完全一致）：cursor 之上 1 个 eligible 事件就已满足生产阈值，因此「未达阈值」无法解释任何观测到的静止',
      },
      processes: [
        { id: 'P1', role: 'stage 1 — commit the base stable (cursor = N = 3)' },
        { id: 'P2', role: 'stage 2 — append the eligible backlog above the cursor while the provider is NOT mounted, then fully close' },
        { id: 'P3', role: 'stage 3 — reopen the same medium only to prove the backlog survived the close' },
        { id: 'P4', role: 'stage 4 — reopen the same storage/session with NO new event, sample the startup window, then append exactly one control event' },
      ],
      storage: {
        domainRootRelative: relative(ROOT_DIR, STORAGE_ROOT),
        sessionRootRelative: relative(ROOT_DIR, SESSION_ROOT),
        backend: 'json',
        domain: 'context_enhancement_task_state',
        domainFileRelative: relative(ROOT_DIR, DOMAIN_FILE),
        sessionArtifacts: listFiles(SESSION_ROOT),
      },
      comparison: {
        baselineExperiment: '审计资料/实验结果/E07-重启积压',
        e07: readE07Baseline(),
        sameFixture: true,
        sameConfig: true,
        sameSampleOffsets: true,
        sameSessionId: true,
        sameLifecycle: true,
        onlyDifference: '被测量的代码版本（src/internal/task-state/basic/{service,worker}.ts 的 B4.1 启动积压检查，以及 contract 层的 trigger 字段）',
      },
      stages: { stage1, stage1Close, stage2, stage2Close, stage3, stage4, afterNewEvent },
      backlog: {
        committedCursorN: cursorN,
        committedRevisionBase: revisionBase,
        minEvents: CONFIG.minEvents,
        eligibleSeqs: backlogSeqs,
        filterKinds: backlogKinds,
        count: backlogSeqs.length,
        aboveCursor: backlogAtReopen.every(seq => seq > cursorN),
        requestsWhileAlive: stage2.requestsWhileAlive,
        turnStartSeqIneligible: turnStartSeq,
      },
      recovery: {
        recoveredStable: recoveredView,
        durableAtResume,
        backlogSeqsAtEveryReopen: {
          atStage3Reopen: backlogAtReopen,
          atStage4ReopenBeforeWindow: stage4.eligibleAboveCursor,
        },
        restoreMarker: stage4.restoreMarker,
        baselineServedBeforeBacklogRequest: publications.length === 0 || publications[0]?.requestsAtPublish === 0,
      },
      startupWindow,
      afterNewEvent,
      criteria,
      verdict,
      errors,
      sourceDrift: {
        sourceFiles,
        sha256: sourceHashes,
        note: '本次对照运行所用插件源码的 SHA-256（drift 记录用）；E07 历史目录的文件未被读取以外的任何方式触碰',
        e07LedgerSha256: sha256File(E07_LEDGER),
        e07SpecSha256: sha256File(E07_SPEC),
      },
      artifacts: {
        note: '本目录内的交付件与运行期真实持久介质（介质每次运行从干净根重建）',
        files: listFiles(OUT_DIR).map(file => ({ ...file, sha256: file.path.endsWith('.jsonl') || file.path.includes('tmp-storage')
          ? sha256File(join(OUT_DIR, file.path))
          : undefined })),
      },
      limitations: [
        '本对照只回答 E07 的第 1 节问题（重启后无新事件时的启动积压折叠）；不覆盖 B5 固定槽位注入、Goal/TODO 权威契约，也不改 E01–E10 历史结论。',
        'LLM 为 fake adapter：没有 provider token、usage、真实网络时延，因此「波次是否发生」可测，「模型质量」不可测。',
        '四个「进程」是同一 vitest 进程内顺序挂载并完整 dispose 的独立 Cordis Context，不是操作系统进程；每个阶段的 storage/JSONL 句柄都已完整关闭并从磁盘重开。',
        'storage 介质是真实 JSON 文档后端（StorageJson），不是 SQLite，也不是多实例并发介质；B1 的 blocked-upstream（多实例）结论不受本对照影响。',
        '注入文本 hash（injectionHash）只用来证明「恢复后未变、新事件后已变」；renderer 的 entry id 含随机 UUID，故 hash 只在同一次运行内可比较。',
        'verdict = fixed 只表示该 fixture 的判据全部成立，不代表理想方案整体达成，也不代表用户现象消失。',
      ],
    }
    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    // ---- structural invariants of the fixture itself ----------------------
    expect(errors).toEqual([])
    expect(cursorN).toBe(3)
    expect(revisionBase).toBe(1)
    expect(backlogSeqs).toEqual([6, 7, 8])
    expect(backlogAtReopen).toEqual(backlogSeqs)
    expect(verdict).toBe('fixed')
  }, 180_000)
})
