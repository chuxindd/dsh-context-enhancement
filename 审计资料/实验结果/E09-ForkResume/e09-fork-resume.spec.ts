/**
 * E09 · Fork/Resume (L2: REAL JSONL persistence + REAL resume/fork + REAL
 * TaskStateBasicService + REAL system-prompt injection consumer + fake LLM)
 *
 * EXPERIMENT QUESTION (the only one)
 * ----------------------------------
 * Under the two Session lifecycles — (1) RESUME of the same durable SessionId
 * and (2) a FORKED child seeded from a parent prefix — does Stable Task State
 * correctly distinguish identity / stable / cursor / inherited prefix?
 * Specifically:
 *   - does a forked child wrongly SHARE (inherit) the parent's live stable,
 *   - does a resume LOSE an already committed stable,
 *   - is the inherited prefix / cursor confused with `firstLiveSeq`, or with
 *     `inheritedEventCount`?
 *
 * FIXED VERDICT RULE (recorded BEFORE the run; 审计资料/32 §5 E09)
 * ---------------------------------------------------------------
 *   reproduced      = a wrong identity, cursor, or stable cross-reference is
 *                     PRODUCED by the real route, i.e. at least one of:
 *                       R1 resume did not restore the same-lifecycle stable
 *                          (missing, reset, or rebound to another lifecycle);
 *                       R2 the child exposed the parent's committed stable as
 *                          its OWN committed stable (same digest/revision/cursor
 *                          as the parent's record, no child rebuild);
 *                       R3 a stable/cursor/audit row of one Session was read or
 *                          written for the other Session;
 *                       R4 the inherited-prefix boundary (cursor or first-commit
 *                          window) was computed from `firstLiveSeq` instead of
 *                          the durable `inheritedEventCount`/`ownEvents()` cut,
 *                          so the boundary differs from the own-events cut.
 *   not-reproduced  = every lifecycle distinction held on the real route (R1-R4
 *                     all false);
 *   inconclusive    = the fixture / runner / durable medium could not produce
 *                     the evidence (mount failure, resume or fork rejection,
 *                     deadline, runner error). SessionIds, heredity fields and
 *                     inherited counts are NEVER hand-forged to force a result;
 *   design-confirmed = static-design evidence only, for the parts of the
 *                     contract this route cannot exercise (e.g. 理想化落地方案
 *                     §3.13's "parent stable as a one-shot `inherited` bootstrap
 *                     candidate", which the implementation does not have).
 *
 * The bug question strictly is "was a wrong identity / cursor / stable
 * cross-reference PRODUCED?", so `reproduced` requires R1-R4 to be observed. A
 * merely INCOMPLETE contract (no `inherited` bootstrap marker, no own-events
 * cursor origin, no isSeeded/inheritedEventCount in the record fence) is
 * recorded as a design deviation against 理想化落地方案 §5.5 / 审计资料 22 A3 and
 * 审计资料 23 D10 — it is NOT a reproduced runtime bug.
 *
 * FOUR STAGES ACROSS FIVE MOUNTED PROCESSES (the three the E09 protocol
 * requires, plus two extra resume rows)
 * ---------------------------------------------------------------------
 *   stage A  process P1 — a real composition creates the parent Session through
 *            `ctx.sessions.create`, appends one complete user turn, and the real
 *            task-state provider commits stable revision 1 at cursor 5 (the last
 *            appended event). The turn also carries one FILTER-INELIGIBLE
 *            plugin-sourced `user/message` surface node — the exact shape DSH's
 *            runtime-context snapshot uses — so the forked prefix provably
 *            contains a model-visible but non-projectable event.
 *   stage B  process P2 — the SAME durable Session is RESUME-reopened through the
 *            REAL production resume idiom (`sessionPersistence.prepare` →
 *            `sessions.enter` → `sessions.announce`). The recovered stable MUST
 *            be the same-lifecycle stable (revision 1, cursor 5) with no new
 *            model call and with the identity unchanged.
 *   stage B2 process P5 — the parent is resumed through the REAL loaded-DSH
 *            `ctx.agents.resume` path (the only resume in that process, because
 *            a Session already entered by the idiom above cannot be prepared a
 *            second time while live) and ONE real agent step runs
 *            (`agent.followup` → pre-step assemble → model request), so the
 *            committed stable's INJECTED TEXT is captured from a real request.
 *   stage C  process P6 — resume the parent through the idiom, append the
 *            parent's second complete turn (revision 2, cursor 9), then FORK:
 *            `ctx.sessions.fork(parent, SessionSeq(lastSeq), childId)` — the
 *            documented production Session fork primitive (new SessionId, seeded
 *            header with `parentSession`/`isSeeded`, exact
 *            `inheritedEventCount` = boundary + 1, deep-copied prefix). The
 *            child's identity / inherited prefix / first-live marker / LIVE and
 *            durable stable pointers are read while the parent is still alive and
 *            committed; the child then appends its OWN complete turn, so the
 *            inherited prefix is sealed and the child's first update runs.
 *   stage D  process P7 — resume the parent AND the forked child again, so the
 *            `firstLiveSeq` ≠ `inheritedEventCount` divergence after a resume of
 *            a seeded Session is observed directly; the durable domain is then
 *            read back from disk after every process closed (stage E, inlined).
 *
 * REAL in this spec (production code only; nothing in the workspace is modified)
 * -----------------------------------------------------------------------------
 * - `Storage` + `StorageJson` + `StorageDomain` (real durable domain
 *   `context_enhancement_task_state`) rooted INSIDE this E09 directory;
 * - real `SessionStore` + real `JsonlSessionPersistence` (real on-disk JSONL
 *   session log) + the REAL resume idiom;
 * - real loaded DSH `AgentLoop` (`ctx.agents.resume`) from the audited DSH
 *   checkout (HEAD a66e4702) built lib, imported by absolute file URL;
 * - real `TaskStateBasicService` (`ctx.plugin`): scheduler, single-flight wave,
 *   filter, batch fold, prompt frame, candidate validation, authority put, audit
 *   rows, committed pointer, lifecycle fence;
 * - real `dsh-context-enhancement/task-state-prompt` consumer + real
 *   `renderTaskStateSnapshot` (the exact text the consumer hands to the runtime
 *   context) + real `ctx.systemPrompt` assembly;
 * - real DSH fork primitive `ctx.sessions.fork`.
 *
 * FAKE in this spec (the ONLY model)
 * ----------------------------------
 * - a scripted `LlmAdapter` registered for the deployment route. Task-state
 *   auxiliary requests (`purpose: 'task-state'`) get one structurally valid
 *   candidate JSON; agent requests get one text block (no tool call → one step
 *   per turn). It emits NO `usage`, so no provider token number is measured.
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * - it never hand-forges a `SessionId`, an `inheritedEventCount`, an `isSeeded`
 *   flag or a lifecycle identity to reach a conclusion: every Session and every
 *   heredity field in this run comes from the real store/fork/resume APIs;
 * - it never constructs a `TaskStateWorker` nor calls `observe`,
 *   `maybeSchedule`, `performBatch`, or any worker method by hand: every wave is
 *   scheduled by the production `session/event` observer path;
 * - it never touches `src/`, `tests/`, `package.json`, `vitest.config.ts`,
 *   `lib`, the tgz, the shared harness, or any other experiment directory;
 * - it never uses the real `$HOME/.dsh`, an existing session, port 8080, the Web
 *   GUI, or a second live process (the "processes" are sequentially mounted
 *   Cordis contexts; only one is alive at a time).
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../../../src/task-state-basic.ts'
import type { TaskStateBasicConfig, TaskStateStable } from '../../../src/task-state.ts'
import * as TaskStatePrompt from '../../../src/task-state-prompt.ts'
import { filterEvent, isEligibleType } from '../../../src/internal/task-state/basic/filter.ts'

// ---------------------------------------------------------------------------
// Fixed experiment constants
// ---------------------------------------------------------------------------

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** Real durable task-state domain root — INSIDE this E09 directory. */
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')
/** Real durable JSONL session-log root — INSIDE this E09 directory. */
const SESSION_ROOT = join(OUT_DIR, 'tmp-sessions')
/** The durable domain document written by the real JSON storage backend. */
const DOMAIN_FILE = join(STORAGE_ROOT, 'context_enhancement_task_state.json')
const LEDGER_PATH = join(OUT_DIR, 'e09-ledger.json')

const PARENT_ID = SessionId('e09-parent')
const CHILD_ID = SessionId('e09-parent-fork-child')
/** The parent's cwd (a fixed lifecycle-identity component). */
const META_CWD = SESSION_ROOT

/** Deployment route (presets/contextual + cordis.patch.yml). */
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

/**
 * Deployment `task-state-basic` config, EXCEPT `minEvents = 1`: 1 is the
 * production minimum, and the deployment value 20 could never commit a single
 * complete turn (3 projectable eligible events) while `minEvents` stays the only
 * trigger — E07 already showed there is no startup/resume wave — so a larger
 * value would confound "resume lost the stable" with "the threshold was not
 * reached". The threshold takes no part in any fork/resume identity decision.
 */
const CONFIG: TaskStateBasicConfig = {
  provider: PROVIDER,
  model: MODEL,
  minEvents: 1,
  maxEvents: 200,
  maxInputBytes: 60_000,
  maxOutputTokens: 4_000,
  timeoutMs: 120_000,
  maxInfraRetries: 2,
  maxEntriesPerKind: 50,
  maxEntryBytes: 4_000,
  maxListItems: 40,
}

/** Deployment `task-state-prompt` byte budget (presets/contextual). */
const PROMPT_MAX_BYTES = 8_000

/** Surface operation of every fixture append (plain append). */
const SURFACE = { surfaceOp: 'append' as const }
/** Source marker DSH puts on every materialized runtime-context snapshot. */
const SNAPSHOT_SOURCE_PLUGIN = '@deepseek-ai/dsh-system-prompt'
/** Header line the plugin renderer writes for every revision. */
const HEADER_RE = /Durable task state \(revision (\d+), source event (\d+), digest ([0-9a-f]+)\)/u

/** The audited DSH checkout (fixed baseline: HEAD a66e4702). */
const DSH_ROOT = 'C:\\Users\\chuxi\\Documents\\trae_projects\\code\\deepseek-harness'
const AGENT_LOOP_LIB = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'lib', 'index.js')
const AGENT_LOOP_SRC_DIR = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'src')

/** Deadline for one production commit (ms). */
const COMMIT_DEADLINE_MS = 30_000
/** Deadline for one real agent step (ms). */
const STEP_DEADLINE_MS = 30_000
/** Deadline for one resume (ms). */
const RESUME_DEADLINE_MS = 30_000
/** Deadline for one `ctx.fiber.dispose()` (ms). */
const DISPOSE_DEADLINE_MS = 20_000
/** Full test deadline (ms). */
const TEST_TIMEOUT_MS = 300_000

/** Marker of the filter-INELIGIBLE (plugin-sourced) surface node. */
const HIDDEN_MARKER = 'E09-HIDDEN-SNAPSHOT-NODE'

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

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

/** FNV-1a 32-bit hash of a string, hex encoded (ledger compactness only). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** SHA-256 of one string, hex encoded. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** UTF-8 byte length of one string. */
function bytesOf(text: string): number {
  return encoder.encode(text).byteLength
}

/** SHA-256 of one file, hex encoded, or null when unreadable. */
function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** Resolve the DSH checkout HEAD from its git files (read-only), or null. */
function dshHead(): string | null {
  try {
    const head = readFileSync(join(DSH_ROOT, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return head
    const ref = head.slice(4).trim()
    return readFileSync(join(DSH_ROOT, '.git', ref), 'utf8').trim()
  } catch {
    return null
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
// The scripted fake model (the ONLY LLM in this spec)
// ---------------------------------------------------------------------------

/** One captured request. */
interface RecordedRequest {
  readonly index: number
  readonly kind: 'task-state' | 'agent'
  readonly purpose: string | null
  readonly messageCount: number
  /** `Durable task state (revision N, …)` revisions found in the request. */
  readonly revisionHeaders: readonly number[]
  /** Text of every runtime-context snapshot message in the request. */
  readonly snapshotTexts: readonly string[]
  readonly snapshotCount: number
}

/**
 * Answers every request with a scripted response and records it. Produces no
 * `usage` chunk, so no provider token number enters any baseline.
 */
class RecordingAdapter extends LlmAdapter {
  readonly requests: RecordedRequest[] = []
  private taskStateCalls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = (options as { readonly purpose?: unknown }).purpose
    const kind: RecordedRequest['kind'] = purpose === 'task-state' ? 'task-state' : 'agent'
    const messages = (options.messages ?? []) as readonly unknown[]
    const revisionHeaders: number[] = []
    const snapshotTexts: string[] = []
    for (const message of messages) {
      const text = messageText(message)
      const header = HEADER_RE.exec(text)
      if (header !== null) revisionHeaders.push(Number(header[1]))
      if (isSnapshotMessage(message)) snapshotTexts.push(text)
    }
    const text = kind === 'task-state' ? this.candidateFor(messages) : this.agentReply()
    this.requests.push({
      index: this.requests.length,
      kind,
      purpose: purpose === undefined ? null : String(purpose),
      messageCount: messages.length,
      revisionHeaders,
      snapshotTexts,
      snapshotCount: snapshotTexts.length,
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** One structurally valid candidate naming the highest folded seq it saw. */
  private candidateFor(messages: readonly unknown[]): string {
    const input = messages.map(messageText).join('')
    const seqs = [...input.matchAll(/"seq":\s*(\d+)/gu)].map(match => Number(match[1]))
    const maxSeq = seqs.length === 0 ? -1 : Math.max(...seqs)
    this.taskStateCalls += 1
    const marker = `E09-CALL-${this.taskStateCalls}-THROUGH-SEQ-${maxSeq}`
    return JSON.stringify({
      facts: [{ content: `E09 durable marker ${marker} (folded window ended at session event ${maxSeq}).` }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `E09 objective ${marker}`,
        currentFocus: `E09 focus ${marker}`,
        openWork: [],
        nextActions: [],
      },
    })
  }

  /** One text block, no tool call: the turn ends after a single step. */
  private agentReply(): string {
    const steps = this.requests.filter(row => row.kind === 'agent').length + 1
    return `E09 agent reply ${steps}: no tool call, the turn ends after one step.`
  }

  taskStateRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'task-state')
  }

  agentRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'agent')
  }
}

// ---------------------------------------------------------------------------
// Message / session observation helpers
// ---------------------------------------------------------------------------

/** Text of one model-visible message (text blocks joined). */
function messageText(message: unknown): string {
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { readonly type: string; readonly text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/** Whether one model-visible message is a DSH runtime-context snapshot. */
function isSnapshotMessage(message: unknown): boolean {
  const source = (message as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  const record = source as { readonly kind?: unknown; readonly plugin?: unknown }
  return record.kind === 'plugin' && record.plugin === SNAPSHOT_SOURCE_PLUGIN
}

/** Append one direct human user/message on the surface; returns its seq. */
function appendUser(session: Session, text: string): number {
  return Number(session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), SURFACE).seq)
}

/** Append one model assistant/message on the surface; returns its seq. */
function appendAssistant(session: Session, turn: number, step: number, text: string): number {
  return Number(session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, SURFACE).seq)
}

/**
 * Append one plugin-sourced `user/message` surface node — the exact shape DSH's
 * runtime-context projection writes for a stable-injection snapshot. The
 * production task-state filter projects NOTHING for it (`directHumanKind`
 * accepts only `user`/`goal`), so it is a model-visible but fold-ineligible
 * event: the fixture's proof that the inherited prefix carries non-projectable
 * surface content. The message carries the `id` every replayed user/message
 * needs (`Session`'s seed/replay validator requires it), so forking over the
 * prefix is legal.
 */
function appendSnapshotShapedNode(session: Session, turn: number, step: number, id: string, text: string): number {
  return Number(session.append('user/message', {
    id,
    role: 'user',
    turn,
    step,
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: SNAPSHOT_SOURCE_PLUGIN,
      form: 'snapshot',
      sections: [{ name: 'task-state:snapshot' }],
    },
  } as never, SURFACE).seq)
}

/** One complete balanced turn: turn/start + user + assistant + turn/end. */
function appendClosedTurn(session: Session, turn: number, userText: string, assistantText: string): {
  turnStart: number
  user: number
  assistant: number
  turnEnd: number
} {
  const turnStart = Number(session.append('turn/start', { turn }).seq)
  const user = appendUser(session, userText)
  const assistant = appendAssistant(session, turn, 1, assistantText)
  const turnEnd = Number(session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq)
  return { turnStart, user, assistant, turnEnd }
}

/** The filter projection kind of one event, or null when it projects nothing. */
function filterKind(session: Session, seq: number): string | null {
  const event = session.eventAt(seq as never)
  if (event === undefined) return null
  const filtered = filterEvent({ type: event.type, seq: event.seq, data: event.data })
  if (filtered === null) return null
  const fields = filtered.event.fields as { readonly kind?: unknown }
  return typeof fields.kind === 'string' ? fields.kind : null
}

/** The filter projection of every event of one Session, compacted. */
function filterKinds(session: Session): Record<string, unknown>[] {
  return session.snapshotEvents().map(event => ({
    seq: Number(event.seq),
    type: event.type,
    eligible: isEligibleType(event.type),
    projection: filterKind(session, Number(event.seq)),
  }))
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

/** Compact view of one Session's current log. */
interface LogView {
  readonly length: number
  readonly types: string[]
  readonly lastSeq: number
}

/** Compact view of one Session's current log. */
function logView(session: Session): LogView {
  const events = session.snapshotEvents()
  return {
    length: events.length,
    types: events.map(event => event.type),
    lastSeq: events.length === 0 ? -1 : Number(events[events.length - 1]!.seq),
  }
}

/** The complete session-identity view this experiment must record. */
function identityView(session: Session): Record<string, unknown> {
  return {
    sessionId: String(session.id),
    header: {
      version: session.header.version,
      id: String(session.header.id),
      createdAt: session.header.createdAt,
      cwd: session.header.cwd ?? null,
      parentSession: session.header.parentSession ?? null,
      isSeeded: session.header.isSeeded,
      origin: session.header.origin ?? null,
      delegationDepth: session.header.delegationDepth ?? null,
      agentPreset: session.header.agentPreset ?? null,
    },
    /** The lifecycle identity the provider fences records with (service.ts lifecycleOf). */
    providerLifecycleIdentity: {
      createdAt: session.header.createdAt,
      cwd: session.header.cwd ?? null,
    },
    /** Durable fork-inherited prefix length. */
    inheritedEventCount: Number(session.inheritedEventCount),
    /** In-process construction fact (constructor seed length of THIS lifecycle). */
    firstLiveSeq: Number(session.firstLiveSeq),
    /** Log length at observation time. */
    logLength: session.snapshotEvents().length,
    /** Own events = events at or after the fork-inherited cut. */
    ownEvents: session.ownEvents().map(event => Number(event.seq)),
    firstLiveSeqEqualsInheritedCount: Number(session.firstLiveSeq) === Number(session.inheritedEventCount),
    firstLiveSeqEqualsLogLength: Number(session.firstLiveSeq) === session.snapshotEvents().length,
  }
}

/** Render one stable through the REAL production injection renderer. */
function renderInjection(stable: TaskStateStable): string {
  return TaskStatePrompt.renderTaskStateSnapshot(stable, PROMPT_MAX_BYTES)
}

/** Compact view of one committed/recovered stable, including its injected text. */
function stableView(stable: TaskStateStable | undefined): Record<string, unknown> | null {
  if (stable === undefined) return null
  const injection = renderInjection(stable)
  const header = HEADER_RE.exec(injection)
  return {
    revision: stable.revision,
    sourceCursor: stable.sourceCursor,
    filterVersion: stable.filterVersion,
    schemaVersion: stable.schemaVersion,
    digest: stable.digest,
    objective: stable.continuation.currentObjective,
    facts: stable.facts.map(fact => fact.content),
    injectionChars: injection.length,
    injectionBytes: bytesOf(injection),
    injectionHashFnv1a: fnv1a(injection),
    injectionHashSha256_16: sha256(injection).slice(0, 16),
    injectionHeader: header === null
      ? null
      : { revision: Number(header[1]), sourceCursor: Number(header[2]), digest: header[3] },
  }
}

/** Read one Session's `request/header` projection (the auxiliary route source). */
function requestHeaderOf(session: Session): unknown {
  try {
    return session.requestHeader() ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Durable medium helpers (real domain document read back from disk)
// ---------------------------------------------------------------------------

/** One audit row as the real domain facility stores it. */
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

/** Durable Session records (stable pointers) keyed by SessionId, compacted. */
function durableRecords(doc: DomainDoc | null): Record<string, unknown> {
  if (doc === null) return { read: false }
  const records: Record<string, unknown> = {}
  for (const [key, record] of Object.entries(doc.tables.sessions)) {
    records[key] = {
      lifecycle: record.session,
      stable: {
        revision: record.stable.revision,
        sourceCursor: record.stable.sourceCursor,
        digest: record.stable.digest,
        objective: record.stable.continuation.currentObjective,
      },
      injectedTextHashFnv1a: fnv1a(renderInjection(record.stable)),
    }
  }
  return { read: true, unit: doc.unit, sessionRecords: records }
}

/** Every audit row, compacted, with its lifecycle identity and folded window. */
function durableAuditRows(doc: DomainDoc | null): Record<string, unknown>[] {
  if (doc === null) return []
  return Object.values(doc.tables.audit)
    .map(row => ({
      requestId: String(row.requestId),
      lifecycleCreatedAt: row.session.createdAt,
      lifecycleCwd: row.session.cwd ?? null,
      baseRevision: row.request.base?.revision ?? null,
      baseCursor: row.request.base?.sourceCursor ?? null,
      targetRevision: row.request.revision,
      includedSeqs: [...row.request.includedSeqs].map(Number),
      outcome: row.finished?.outcome ?? 'open',
      finishedRevision: row.finished?.revision ?? null,
      finishedCursor: row.finished?.sourceCursor ?? null,
    }))
    .sort((left, right) => left.requestId.localeCompare(right.requestId))
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** One mounted experiment process. */
interface Composition {
  readonly ctx: Context
  readonly adapter: RecordingAdapter
  /** Live sessions this process published, by id. */
  readonly live: Map<string, Session>
  disposeError: string | null
}

/**
 * Mount the host stack with the real durable medium rooted INSIDE this E09
 * directory. `AgentLoop` is mounted only when its module loaded from the
 * audited DSH checkout.
 */
async function mountComposition(AgentLoop: unknown): Promise<Composition> {
  const ctx = new Context()
  const adapter = new RecordingAdapter()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: SESSION_ROOT, compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  await ctx.plugin(TaskStateBasicService, CONFIG)
  await ctx.plugin(TaskStatePrompt, { maxBytes: PROMPT_MAX_BYTES })
  if (AgentLoop !== null) await ctx.plugin(AgentLoop as never, { agents: [] })
  return { ctx, adapter, live: new Map(), disposeError: null }
}

/** Hooks kept alive for the life of one resumed stage. */
const resumedOwnership = new WeakMap<Composition, (() => void)[]>()

/**
 * The REAL production resume idiom (identical to the DSH persistence-contract
 * tests and to E07): the persistence service prepares the stored Session — its
 * header and its complete contiguous log — and the store enters/announces it.
 */
async function resumeThroughIdiom(process: Composition, id: SessionId): Promise<Session> {
  const persistence = (process.ctx as unknown as {
    sessionPersistence: { prepare: (sessionId: SessionId) => Promise<unknown> }
  }).sessionPersistence
  const preparation = await persistence.prepare(id)
  const session = (preparation as { readonly session: Session }).session
  const detach = process.ctx.sessions.enter(session)
  process.ctx.sessions.announce(session)
  process.live.set(String(id), session)
  // Hold the detach + preparation for the life of the stage: releasing the
  // preparation would drop the durability ownership this resume created.
  const held = resumedOwnership.get(process) ?? []
  held.push(detach, () => { (preparation as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.() })
  resumedOwnership.set(process, held)
  return session
}

/** Close one process: release resumed ownership, then dispose the fiber. */
async function closeComposition(process: Composition): Promise<string | null> {
  const error = await withDeadline(process.ctx.fiber.dispose() as Promise<unknown>, DISPOSE_DEADLINE_MS, 'ctx.fiber.dispose()')
  process.disposeError = error
  return error
}

/** Poll the agent's status until it is `idle`, or throw at the deadline. */
function waitForIdle(ctx: Context, agent: { readonly status: string }, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      dispose()
      reject(new Error(`agent did not reach idle within ${timeoutMs} ms`))
    }, timeoutMs)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(deadline)
      dispose()
      resolve()
    })
  })
}

/** One `ctx.agents.resume` + one real step, for the process that owns that resume. */
async function resumeWithRealAgentPathAndRunOneStep(
  process: Composition,
  id: SessionId,
  stepText: string,
): Promise<{ view: Record<string, unknown>; error: string | null }> {
  if (!process.ctx.get('agents')) return { view: { attempted: false, reason: 'AgentLoop not mounted' }, error: null }
  try {
    const handle = await Promise.race([
      process.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: PROVIDER, model: MODEL } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('agent resume deadline exceeded')), RESUME_DEADLINE_MS)),
    ])
    const agent = handle.agent as unknown as {
      readonly session: Session
      readonly status: string
      followup: (message: unknown) => void
    }
    const identity = identityView(agent.session)
    const logBefore = logView(agent.session)
    const requestsBefore = process.adapter.agentRequests().length
    const idle = waitForIdle(process.ctx, agent as never, STEP_DEADLINE_MS)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: stepText }], source: { kind: 'user' } }))
    let stepError: string | null = null
    try {
      await idle
    } catch (error: unknown) {
      stepError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    const agentRequests = process.adapter.agentRequests()
    const request = agentRequests[agentRequests.length - 1]
    let assemblyView: Record<string, unknown> | null = null
    try {
      const assembly = await process.ctx.systemPrompt.assemble(
        assembleContextFor(agent as never, new AbortController().signal),
      )
      const rendered = renderContextSnapshot(assembly)
      const header = HEADER_RE.exec(rendered)
      assemblyView = {
        contributionEntriesNamedTaskStateSnapshot: assembly.contexts.filter(entry => entry.name === 'task-state:snapshot').length,
        renderedChars: rendered.length,
        renderedBytes: bytesOf(rendered),
        renderedRevision: header === null ? null : Number(header[1]),
        renderedSourceCursor: header === null ? null : Number(header[2]),
        renderedHashFnv1a: fnv1a(rendered),
      }
    } catch (error: unknown) {
      stepError = stepError ?? (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    }
    const view: Record<string, unknown> = {
      attempted: true,
      api: 'ctx.agents.resume({ resumeSessionId, agentOptions }) — the REAL loaded-DSH resume path (persistence.prepare → session lifecycle → first prompt assembly)',
      error: stepError,
      identityAfterResume: identity,
      logAfterResume: logBefore,
      agentStatusAfterStep: agent.status,
      agentRequestsThisStep: agentRequests.length - requestsBefore,
      requestRevisionHeaders: request === undefined ? null : request.revisionHeaders,
      requestSnapshotCount: request === undefined ? null : request.snapshotCount,
      requestSnapshotTexts: request === undefined ? null : request.snapshotTexts,
      requestSnapshotHashFnv1a: request === undefined ? null : request.snapshotTexts.map(text => fnv1a(text)),
      assemblyLayer: assemblyView,
      sessionLogAfterStep: logView(agent.session),
      stableAfterStep: stableView(process.ctx.taskState.getStable(id)),
      taskStateModelCallsThisProcess: process.adapter.taskStateRequests().length,
    }
    await handle.dispose()
    return { view, error: stepError }
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { view: { attempted: true, error: message }, error: message }
  }
}

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

describe('E09 · fork/resume lifecycle identity, stable, cursor and inherited prefix', () => {
  it('resumes the same-lifecycle stable and gives a forked child its own stable, cursor and inherited prefix', async () => {
    // ---- fresh experiment-local medium ------------------------------------
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    rmSync(SESSION_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })
    mkdirSync(SESSION_ROOT, { recursive: true })

    const errors: { stage: string; message: string }[] = []
    const recordError = (stage: string, error: unknown): void => {
      errors.push({ stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    }

    // ---- phase 0: the DSH agent loop (the only non-dependency module) -----
    const agentLoopModule = {
      path: AGENT_LOOP_LIB,
      sha256: sha256File(AGENT_LOOP_LIB),
      srcDir: AGENT_LOOP_SRC_DIR,
      srcHashes: { 'index.ts': sha256File(join(AGENT_LOOP_SRC_DIR, 'index.ts')) },
      dshHead: dshHead(),
      imported: false,
      mountError: null as string | null,
    }
    let AgentLoop: unknown = null
    try {
      const loaded = await import(/* @vite-ignore */ pathToFileURL(AGENT_LOOP_LIB).href) as { default?: unknown }
      AgentLoop = loaded.default ?? null
      agentLoopModule.imported = AgentLoop !== null
    } catch (error: unknown) {
      agentLoopModule.mountError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    const hiddenNodeText = (suffix: string): string =>
      `E09 hidden node ${HIDDEN_MARKER}${suffix}: a plugin-sourced runtime-context snapshot shape for session ${String(PARENT_ID)}.`

    // =====================================================================
    // Stage A — process P1: the parent forms stable at cursor 3
    // =====================================================================
    const stageA: Record<string, unknown> = {
      process: 'P1',
      role: 'parent Session forms its stable (revision 1, cursor 3)',
      openedAt: new Date().toISOString(),
    }
    const p1 = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    let parentRevisionA = -1
    let parentCursorA = -1
    let parentCreatedAt: number | null = null
    try {
      const parent = p1.ctx.sessions.create(PARENT_ID, { meta: { cwd: META_CWD } })
      p1.live.set(String(PARENT_ID), parent)
      parentCreatedAt = parent.header.createdAt
      const turn1 = appendClosedTurn(
        parent,
        1,
        'E09 parent turn 1: establish the durable task state.',
        'E09 parent reply 1: durable state established.',
      )
      const hiddenSeq = appendSnapshotShapedNode(parent, 1, 1, 'e09-hidden-node-turn1', hiddenNodeText(''))
      const outerTurnEnd = Number(parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } }).seq)

      const converged = await waitUntil(
        () => p1.ctx.taskState.getStable(PARENT_ID)?.sourceCursor === outerTurnEnd,
        COMMIT_DEADLINE_MS,
      )
      if (!converged) recordError('stageA.converge', new Error('stage-A stable did not reach the last appended seq'))
      const stableA = p1.ctx.taskState.getStable(PARENT_ID)
      parentRevisionA = stableA?.revision ?? -1
      parentCursorA = stableA?.sourceCursor ?? -1

      // Durable flush: the resume in stage B must read the complete log.
      await p1.ctx.sessions.flush(parent)

      Object.assign(stageA, {
        identity: identityView(parent),
        appendedSeqs: { turn1, hiddenSnapshotShapedSeq: hiddenSeq, outerTurnEnd },
        requestHeader: requestHeaderOf(parent),
        logAtClose: logView(parent),
        surfaceNodes: parent.surface.nodes.map(node => Number(node)),
        stable: stableView(stableA),
        stableFactsContainHiddenMarker: stableA?.facts.some(fact => fact.content.includes(HIDDEN_MARKER)) ?? null,
        eligibleAboveCursorAtClose: eligibleSeqsAbove(parent, parentCursorA),
        filterKinds: filterKinds(parent),
        taskStateModelCalls: p1.adapter.taskStateRequests().length,
      })
    } catch (error: unknown) {
      recordError('stageA', error)
    }
    const stageAClose = await closeComposition(p1)
    if (stageAClose !== null) recordError('stageA.dispose', stageAClose)
    stageA['disposeError'] = stageAClose
    stageA['closedAt'] = new Date().toISOString()
    stageA['durableAfterClose'] = durableRecords(readDomainDoc())
    const sessionArtifactsAfterA = listFiles(SESSION_ROOT)

    // =====================================================================
    // Stage B — process P2: RESUME the same durable Session (no new event)
    // =====================================================================
    const stageB: Record<string, unknown> = {
      process: 'P2',
      role: 'resume the SAME SessionId + lifecycle and check the same-lifecycle stable survives',
      openedAt: new Date().toISOString(),
    }
    const p2 = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    try {
      const parent = await resumeThroughIdiom(p2, PARENT_ID)
      // First identity snapshot: immediately after the resume, before the store's
      // `session/end-seed` marker for this lifecycle has been appended (the
      // marker occupies `firstLiveSeq` on the first append below).
      const identityAtResume = identityView(parent)
      const logAtResume = logView(parent)
      const recovered = await waitUntil(
        () => p2.ctx.taskState.getStable(PARENT_ID) !== undefined,
        COMMIT_DEADLINE_MS,
      )
      if (!recovered) recordError('stageB.recover', new Error('stage-B provider did not publish the durable stable'))
      const stable = p2.ctx.taskState.getStable(PARENT_ID)
      // `Session` appends this lifecycle's `session/end-seed` marker in its
      // constructor (`firstLiveSeq` is set to the seed length just before that
      // append), so the marker is already part of the log here. No further
      // production call is needed before the second snapshot.
      const identityAfterResumeMarker = identityView(parent)
      Object.assign(stageB, {
        restore: { identity: identityAtResume, log: logAtResume, requestHeader: requestHeaderOf(parent) },
        identityAfterResumeMarker,
        logAfterResumeMarker: logView(parent),
        recoveredStable: stableView(stable),
        recoveredStableIsSameLifecycle: stable !== undefined
          && stable.revision === parentRevisionA
          && stable.sourceCursor === parentCursorA,
        modelRequestsWhileReopened: p2.adapter.requests.length,
        taskStateModelCallsWhileReopened: p2.adapter.taskStateRequests().length,
        eligibleAboveCursor: eligibleSeqsAbove(parent, parentCursorA),
        resumeSeedIsWholeStoredLog: identityAfterResumeMarker['firstLiveSeqEqualsLogLength'],
        resumeInheritedCountIsZero: identityAfterResumeMarker['inheritedEventCount'] === 0,
        /**
         * The documented fact: after a resume the in-process cut is the whole
         * stored log (seed length of this lifecycle), while the durable heredity
         * cut of an unseeded Session stays 0 — the two are different facts.
         */
        firstLiveSeqVsInheritedCountAtResume: {
          firstLiveSeq: identityAtResume['firstLiveSeq'],
          inheritedEventCount: identityAtResume['inheritedEventCount'],
          logLength: identityAtResume['logLength'],
          equal: identityAtResume['firstLiveSeqEqualsInheritedCount'],
        },
        firstLiveSeqVsInheritedCountAfterMarker: {
          firstLiveSeq: identityAfterResumeMarker['firstLiveSeq'],
          inheritedEventCount: identityAfterResumeMarker['inheritedEventCount'],
          logLength: identityAfterResumeMarker['logLength'],
          equal: identityAfterResumeMarker['firstLiveSeqEqualsInheritedCount'],
        },
      })
    } catch (error: unknown) {
      recordError('stageB', error)
    }
    const stageBClose = await closeComposition(p2)
    if (stageBClose !== null) recordError('stageB.dispose', stageBClose)
    stageB['disposeError'] = stageBClose
    stageB['closedAt'] = new Date().toISOString()
    stageB['durableAfterClose'] = durableRecords(readDomainDoc())

    // =====================================================================
    // Process P5 (its own resume row): the REAL `ctx.agents.resume` path plus
    // ONE real agent step, so the injected text of the committed stable is
    // captured from a real assembly / model request. The parent Session is NOT
    // entered by the idiom in this process, so the agent factory's own
    // `persistence.prepare` is the only resume here.
    // =====================================================================
    const p5 = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    let realAgentStep: { view: Record<string, unknown>; error: string | null } = {
      view: { attempted: false, reason: 'P5 did not open' },
      error: null,
    }
    try {
      realAgentStep = await resumeWithRealAgentPathAndRunOneStep(
        p5,
        PARENT_ID,
        'E09 step: one real assembly/step on the resumed parent Session.',
      )
      if (realAgentStep.error !== null) recordError('stageB2.agentStep', realAgentStep.error)
      p5.ctx.logger.info('E09 P5 step finished')
    } catch (error: unknown) {
      recordError('stageB2', error)
    }
    const stageB2: Record<string, unknown> = {
      process: 'P5',
      role: 'resume through the REAL ctx.agents.resume path and run ONE real step (the only real assembly/request row)',
      openedAt: new Date().toISOString(),
      step: realAgentStep.view,
      modelRequests: p5.adapter.requests.map(row => ({
        index: row.index,
        kind: row.kind,
        purpose: row.purpose,
        revisionHeaders: row.revisionHeaders,
        snapshotCount: row.snapshotCount,
      })),
      taskStateModelCalls: p5.adapter.taskStateRequests().length,
      durableAtClose: durableRecords(readDomainDoc()),
    }
    const stageB2Close = await closeComposition(p5)
    if (stageB2Close !== null) recordError('stageB2.dispose', stageB2Close)
    stageB2['disposeError'] = stageB2Close
    stageB2['closedAt'] = new Date().toISOString()

    // =====================================================================
    // Stage C — process P6: resume the parent through the idiom, seal its
    // prefix with a second complete turn, then FORK the child from that prefix
    // and let the child commit its own stable.
    // =====================================================================
    const stageC: Record<string, unknown> = {
      process: 'P6',
      role: 'seal the parent prefix (cursor 9), then FORK a child from it and let the child commit',
      openedAt: new Date().toISOString(),
    }
    const p3 = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    let parentCursorAfterAppend = -1
    let parentRevisionAfterAppend = -1
    let childInherited = -1
    let childOwnCursor = -1
    let childCreatedAt: number | null = null
    let childCommitIncludedSeqs: number[] = []
    try {
      // --- C1: resume the parent AGAIN (same lifecycle, same stable) --------
      const parent = await resumeThroughIdiom(p3, PARENT_ID)
      const resumeIdentity = identityView(parent)
      const recovered = await waitUntil(
        () => p3.ctx.taskState.getStable(PARENT_ID) !== undefined,
        COMMIT_DEADLINE_MS,
      )
      if (!recovered) recordError('stageC.recover', new Error('stage-C provider did not publish the durable stable'))
      const stableAfterSecondResume = p3.ctx.taskState.getStable(PARENT_ID)

      // --- C2: the parent's second complete turn + one hidden snapshot node --
      const turn2 = appendClosedTurn(
        parent,
        2,
        'E09 parent turn 2: extend the durable record before forking.',
        'E09 parent reply 2: prefix sealed for the fork.',
      )
      const hiddenSeq2 = appendSnapshotShapedNode(parent, 2, 1, 'e09-hidden-node-turn2', hiddenNodeText(' (second node)'))
      const outerTurnEnd2 = Number(parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } }).seq)
      const converged = await waitUntil(
        () => p3.ctx.taskState.getStable(PARENT_ID)?.sourceCursor === outerTurnEnd2,
        COMMIT_DEADLINE_MS,
      )
      if (!converged) recordError('stageC.converge', new Error('stage-C parent stable did not reach the last appended seq'))
      const stableBeforeFork = p3.ctx.taskState.getStable(PARENT_ID)
      parentRevisionAfterAppend = stableBeforeFork?.revision ?? -1
      parentCursorAfterAppend = stableBeforeFork?.sourceCursor ?? -1

      // --- C3: ONE real agent step (assemble → project → model request) -----
      // It runs in its OWN process (P5), resumed ONLY through the real
      // `ctx.agents.resume` path: a Session already entered by the resume idiom
      // above cannot be prepared a second time while live, so the two resume
      // mechanisms are kept in separate processes instead of being mixed.
      const stepView: Record<string, unknown> = realAgentStep.view

      // --- C4: THE FORK — real production primitive, sealed prefix boundary --
      const prefixBoundary = logView(parent).lastSeq
      if (prefixBoundary < 0) throw new Error('the parent log has no fork boundary')
      const child = p3.ctx.sessions.fork(parent, SessionSeq(prefixBoundary), CHILD_ID)
      p3.live.set(String(CHILD_ID), child)
      childInherited = Number(child.inheritedEventCount)
      childCreatedAt = child.header.createdAt
      const childIdentity = identityView(child)
      const inheritedPrefix = child.snapshotEvents(SessionLogOffset(0), child.inheritedEventCount)

      // Live pointers immediately after the fork, BEFORE any child event:
      const childStableBeforeOwnEvents = p3.ctx.taskState.getStable(CHILD_ID)
      const parentStableBeforeOwnEvents = p3.ctx.taskState.getStable(PARENT_ID)

      // --- C5: the child's OWN complete turn, so the prefix is sealed --------
      const childTurn = appendClosedTurn(
        child,
        1,
        'E09 child turn 1: the forked child writes its own durable record.',
        'E09 child reply 1: the child has its own record.',
      )
      const childConverged = await waitUntil(
        () => p3.ctx.taskState.getStable(CHILD_ID) !== undefined,
        COMMIT_DEADLINE_MS,
      )
      if (!childConverged) recordError('stageC.childCommit', new Error('the forked child never committed a stable within the deadline'))
      const childStable = p3.ctx.taskState.getStable(CHILD_ID)
      childOwnCursor = childStable?.sourceCursor ?? -1
      const parentStableAfterChildCommit = p3.ctx.taskState.getStable(PARENT_ID)
      // Durability: the child must reach disk, because stage D resumes it.
      await p3.ctx.sessions.flush(child)

      Object.assign(stageC, {
        resumeIdentity,
        recoveredStable: stableView(stableAfterSecondResume),
        recoveredStableIsSameLifecycle: stableAfterSecondResume?.revision === parentRevisionA
          && stableAfterSecondResume?.sourceCursor === parentCursorA,
        parentTurn2: { turn2, hiddenSnapshotShapedSeq2: hiddenSeq2, outerTurnEnd2 },
        stableBeforeFork: stableView(stableBeforeFork),
        realStep: stepView,
        fork: {
          api: 'ctx.sessions.fork(source, SessionSeq(boundary), childSessionId) — the documented production Session fork primitive (SessionStore.fork)',
          prefixBoundary,
          parentId: String(PARENT_ID),
          childId: String(child.id),
          childIdentity,
          childLogAfterFork: logView(child),
          childInheritedPrefixSeqs: inheritedPrefix.map(event => Number(event.seq)),
          childInheritedPrefixTypes: inheritedPrefix.map(event => event.type),
          childInheritedCount: childInherited,
          childFirstLiveSeq: Number(child.firstLiveSeq),
          childFirstLiveSeqEqualsInheritedCount: Number(child.firstLiveSeq) === childInherited,
          childOwnEventsAfterFork: child.ownEvents().map(event => Number(event.seq)),
          childEligibleAboveMinusOne: eligibleSeqsAbove(child, -1),
          childEligibleAboveInheritedCut: eligibleSeqsAbove(child, childInherited),
          childStableBeforeOwnEvents: stableView(childStableBeforeOwnEvents),
          parentStableBeforeOwnEvents: stableView(parentStableBeforeOwnEvents),
          parentStableSharedWithChild: childStableBeforeOwnEvents !== undefined,
          hiddenMarkerInChildStableAfterCommit: childStable === undefined
            ? null
            : childStable.facts.some(fact => fact.content.includes(HIDDEN_MARKER)),
          forkSeenByStoreAsLive: p3.ctx.sessions.get(CHILD_ID) === child,
        },
        childCommit: {
          appendedSeqs: childTurn,
          stable: stableView(childStable),
          publishedForChild: childStable !== undefined,
          parentStableUnchangedByChildCommit:
            stableView(parentStableAfterChildCommit)?.['revision'] === stableView(stableBeforeFork)?.['revision']
            && stableView(parentStableAfterChildCommit)?.['sourceCursor'] === stableView(stableBeforeFork)?.['sourceCursor'],
          parentStableAfterChildCommit: stableView(parentStableAfterChildCommit),
          childCursorVsInheritedCut: {
            childOwnCursor: childStable?.sourceCursor ?? null,
            childInheritedCount: childInherited,
            cursorInsideInheritedPrefix: (childStable?.sourceCursor ?? -1) < childInherited,
            cursorAtOrAboveInheritedCut: (childStable?.sourceCursor ?? -1) >= childInherited,
            cursorDistanceFromInheritedCut: (childStable?.sourceCursor ?? -1) - childInherited,
          },
        },
        childLogAfterCommit: logView(child),
        taskStateModelCallsTotal: p3.adapter.taskStateRequests().length,
        modelRequests: p3.adapter.requests.map(row => ({
          index: row.index,
          kind: row.kind,
          purpose: row.purpose,
          revisionHeaders: row.revisionHeaders,
          snapshotCount: row.snapshotCount,
        })),
        parentFilterKinds: filterKinds(parent),
      })
    } catch (error: unknown) {
      recordError('stageC', error)
    }
    const durableAtStageCClose = readDomainDoc()
    const stageCClose = await closeComposition(p3)
    if (stageCClose !== null) recordError('stageC.dispose', stageCClose)
    stageC['disposeError'] = stageCClose
    stageC['closedAt'] = new Date().toISOString()
    stageC['durableAfterClose'] = durableRecords(durableAtStageCClose)

    // =====================================================================
    // Stage D — process P7: resume the parent AND the forked child, then read
    // the durable medium back from disk (stage E).
    // =====================================================================
    const stageD: Record<string, unknown> = {
      process: 'P7',
      role: 'resume the parent and the forked child: firstLiveSeq vs inheritedEventCount after a resume',
      openedAt: new Date().toISOString(),
    }
    const p4 = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    try {
      const parent = await resumeThroughIdiom(p4, PARENT_ID)
      const child = await resumeThroughIdiom(p4, CHILD_ID)
      const recovered = await waitUntil(
        () => p4.ctx.taskState.getStable(PARENT_ID) !== undefined
          && p4.ctx.taskState.getStable(CHILD_ID) !== undefined,
        COMMIT_DEADLINE_MS,
      )
      if (!recovered) recordError('stageD.recover', new Error('stage-D provider did not publish both durable stables'))
      const parentStable = p4.ctx.taskState.getStable(PARENT_ID)
      const childStable = p4.ctx.taskState.getStable(CHILD_ID)
      const childIdentity = identityView(child)
      Object.assign(stageD, {
        parentResume: { identity: identityView(parent), log: logView(parent), stable: stableView(parentStable) },
        childResume: {
          identity: childIdentity,
          stable: stableView(childStable),
          log: logView(child),
          /** The documented divergence: a resumed seeded Session seeds its WHOLE stored log. */
          firstLiveSeqVsInheritedCount: {
            firstLiveSeq: childIdentity['firstLiveSeq'],
            inheritedEventCount: childIdentity['inheritedEventCount'],
            logLength: childIdentity['logLength'],
            firstLiveSeqEqualsLogLength: childIdentity['firstLiveSeqEqualsLogLength'],
            equal: childIdentity['firstLiveSeqEqualsInheritedCount'],
          },
          ownEvents: childIdentity['ownEvents'],
          /** `isOwnSeq` on the inherited prefix: the authoritative own/foreign boundary. */
          isOwnSeqOnInheritedPrefix: child.snapshotEvents()
            .slice(0, Number(child.inheritedEventCount))
            .map(event => ({ seq: Number(event.seq), own: child.isOwnSeq(event.seq) })),
        },
        modelRequests: p4.adapter.requests.map(row => ({ index: row.index, kind: row.kind, purpose: row.purpose })),
      })
    } catch (error: unknown) {
      recordError('stageD', error)
    }
    const stageDClose = await closeComposition(p4)
    if (stageDClose !== null) recordError('stageD.dispose', stageDClose)
    stageD['disposeError'] = stageDClose
    stageD['closedAt'] = new Date().toISOString()

    // =====================================================================
    // Stage E — the durable medium, read back from disk after everything closed
    // =====================================================================
    const durableFinal = readDomainDoc()
    const auditRowsFinal = durableAuditRows(durableFinal)
    const childRows = childCreatedAt === null
      ? []
      : auditRowsFinal.filter(row => row['lifecycleCreatedAt'] === childCreatedAt)
    const parentRows = parentCreatedAt === null
      ? []
      : auditRowsFinal.filter(row => row['lifecycleCreatedAt'] === parentCreatedAt)
    const durableParentRecord = durableFinal?.tables.sessions[String(PARENT_ID)]
    const durableChildRecord = durableFinal?.tables.sessions[String(CHILD_ID)]
    const stageE: Record<string, unknown> = {
      process: 'closed',
      role: 'durable medium read back from disk after every process closed',
      domainFileRelative: relative(process.cwd(), DOMAIN_FILE),
      domainFileBytes: (() => {
        try {
          return statSync(DOMAIN_FILE).size
        } catch {
          return null
        }
      })(),
      sessionArtifacts: listFiles(SESSION_ROOT),
      sessionArtifactsAfterStageA: sessionArtifactsAfterA,
      durableParentRecord: durableParentRecord === undefined
        ? null
        : {
          lifecycle: durableParentRecord.session,
          stable: {
            revision: durableParentRecord.stable.revision,
            sourceCursor: durableParentRecord.stable.sourceCursor,
            digest: durableParentRecord.stable.digest,
          },
        },
      durableChildRecord: durableChildRecord === undefined
        ? null
        : {
          lifecycle: durableChildRecord.session,
          stable: {
            revision: durableChildRecord.stable.revision,
            sourceCursor: durableChildRecord.stable.sourceCursor,
            digest: durableChildRecord.stable.digest,
          },
        },
      auditRowCount: auditRowsFinal.length,
      parentAuditRows: parentRows,
      childAuditRows: childRows,
      childFirstCommitIncludedSeqs: childRows.length === 0 ? null : childRows[0]!['includedSeqs'],
      childFirstCommitFoldedInheritedPrefix: childRows.length === 0 || childCreatedAt === null
        ? null
        : (childRows[0]!['includedSeqs'] as number[]).some(seq => seq < childInherited),
    }

    // =====================================================================
    // Criteria (fixed before the run) and the verdict
    // =====================================================================
    const parentIdentityA = stageA['identity'] as Record<string, unknown>
    const parentIdentityStageC = stageC['resumeIdentity'] as Record<string, unknown>
    const fork = (stageC['fork'] ?? {}) as Record<string, unknown>
    const childCommit = (stageC['childCommit'] ?? {}) as Record<string, unknown>
    const childCursorVsCut = (childCommit['childCursorVsInheritedCut'] ?? {}) as Record<string, unknown>
    const childResume = (stageD['childResume'] ?? {}) as Record<string, unknown>
    const stageBIdentity = (stageB['restore'] as Record<string, unknown> | undefined)?.['identity'] as Record<string, unknown> | undefined
    const stageBParentStable = stageB['recoveredStable']
    const stageCParentStable = stageC['recoveredStable']
    const stableBeforeForkView = (stageC['stableBeforeFork'] ?? {}) as Record<string, unknown>
    const realStepView = (stageB2['step'] ?? {}) as Record<string, unknown>
    const assemblyLayer = (realStepView['assemblyLayer'] ?? {}) as Record<string, unknown>

    /** Header field of one recorded identity view, or null when the stage did not record it. */
    const headerField = (identity: Record<string, unknown> | undefined, field: string): unknown => {
      const header = identity?.['header'] as Record<string, unknown> | undefined
      return header?.[field] ?? null
    }

    // R1 — resume restores the same-lifecycle stable (no loss, no reset, no rebound).
    const resumeRecoveredSameStable = stageB['recoveredStableIsSameLifecycle'] === true
      && stageC['recoveredStableIsSameLifecycle'] === true
      && (stageD['parentResume'] as Record<string, unknown> | undefined)?.['stable'] !== null
      && (stageD['parentResume'] as Record<string, unknown> | undefined)?.['stable'] !== undefined
    const resumeLifecycleIdentityStable = stageBIdentity !== undefined
      && headerField(stageBIdentity, 'createdAt') === headerField(parentIdentityA, 'createdAt')
      && headerField(parentIdentityStageC, 'createdAt') === headerField(parentIdentityA, 'createdAt')
      && headerField(stageBIdentity, 'createdAt') !== null
    const noModelCallOnResume = stageB['taskStateModelCallsWhileReopened'] === 0
    const r1ResumeKeptStable = resumeRecoveredSameStable && resumeLifecycleIdentityStable && noModelCallOnResume

    // R2 — the child must not expose the parent's committed stable as its own.
    const childHadNoStableAtFork = fork['childStableBeforeOwnEvents'] === null
    const childPublishedOwnStable = childCommit['publishedForChild'] === true
    const childStableDiffersFromParent = childCommit['stable'] !== null
      && childCommit['stable'] !== undefined
      && (childCommit['stable'] as Record<string, unknown>)['digest'] !== stableBeforeForkView['digest']
    const parentStableUntouchedByChild = childCommit['parentStableUnchangedByChildCommit'] === true
    const r2ChildOwnStable = childHadNoStableAtFork && childPublishedOwnStable
      && childStableDiffersFromParent && parentStableUntouchedByChild

    // R3 — no cross-Session stable/cursor/audit reference.
    const rowsSeparatedByLifecycle = parentRows.length >= 3 && childRows.length === 1
      && parentRows.every(row => row['lifecycleCreatedAt'] === parentCreatedAt)
      && childRows.every(row => row['lifecycleCreatedAt'] === childCreatedAt)
    const recordsSeparated = durableParentRecord !== undefined && durableChildRecord !== undefined
      && durableParentRecord.session.createdAt !== durableChildRecord.session.createdAt
      && durableParentRecord.stable.sourceCursor !== durableChildRecord.stable.sourceCursor
      && durableParentRecord.stable.digest !== durableChildRecord.stable.digest
    const r3NoCrossReference = rowsSeparatedByLifecycle && recordsSeparated

    // R4 — the inherited boundary must come from the durable fork cut, not `firstLiveSeq`.
    const forkIdentity = (fork['childIdentity'] ?? {}) as Record<string, unknown>
    const ownEventsAtFork = (fork['childOwnEventsAfterFork'] ?? []) as number[]
    const prefixSeqs = (fork['childInheritedPrefixSeqs'] ?? []) as number[]
    const cutIsDurableCount = fork['childInheritedCount'] !== undefined
      && fork['childInheritedCount'] === (fork['prefixBoundary'] as number | undefined ?? -2) + 1
    const ownEventsStartAtCut = ownEventsAtFork.length === 0 || ownEventsAtFork[0] === childInherited
    const prefixSeqsAreBelowCut = prefixSeqs.length > 0 && prefixSeqs.every(seq => seq < childInherited)
    const cursorAboveCut = childCursorVsCut['cursorAtOrAboveInheritedCut'] === true
    const r4BoundaryFromDurableCut = cutIsDurableCount && ownEventsStartAtCut
      && prefixSeqsAreBelowCut && cursorAboveCut && forkIdentity['inheritedEventCount'] === childInherited

    const routeWorked = errors.length === 0
    const parentFormed = parentRevisionA === 1 && parentCursorA === 5
    const resumeRouteAvailable = stageBParentStable !== undefined && stageCParentStable !== undefined
    const realAgentStepWorked = realStepView['attempted'] === true
      && typeof realStepView['requestSnapshotCount'] === 'number'
      && (realStepView['requestSnapshotCount'] as number) >= 1
    const forkRouteAvailable = fork['childId'] !== undefined && childPublishedOwnStable
    const evidenceComplete = routeWorked && parentFormed && resumeRouteAvailable && realAgentStepWorked
      && forkRouteAvailable
      && childCommit['childCursorVsInheritedCut'] !== undefined
      && childResume['firstLiveSeqVsInheritedCount'] !== undefined
      && childRows.length === 1
      && stageC['stableBeforeFork'] !== undefined
      && assemblyLayer['renderedRevision'] !== undefined

    const reproducedCriteria = {
      R1_resume_lost_or_rebound_stable: !r1ResumeKeptStable,
      R2_child_shared_parent_stable: !r2ChildOwnStable,
      R3_cross_session_reference: !r3NoCrossReference,
      R4_boundary_from_firstLiveSeq_not_inherited_cut: !r4BoundaryFromDurableCut,
    }
    const anyReproduced = Object.values(reproducedCriteria).some(value => value === true)
    const verdict = !evidenceComplete
      ? 'inconclusive'
      : anyReproduced
        ? 'reproduced'
        : 'not-reproduced'

    const ledger = {
      experiment: 'E09-fork-resume',
      question: 'Under resume (same SessionId) and fork (child seeded from a parent prefix), does Stable Task State correctly distinguish identity, stable, cursor and the inherited prefix — does the child wrongly share the parent stable, does resume lose the existing stable, and is firstLiveSeq misused for the inherited event count?',
      verdictRule: 'reproduced = a wrong identity/cursor/stable cross-reference is PRODUCED (R1 resume did not restore the same-lifecycle stable, R2 the child exposed the parent stable as its own committed stable, R3 a stable/cursor/audit row crossed Sessions, R4 the inherited boundary came from firstLiveSeq instead of the durable inheritedEventCount/ownEvents cut); not-reproduced = R1-R4 all false on the real route; inconclusive = the fixture/runner/medium could not produce the evidence (no SessionId, heredity field or count is ever hand-forged); design-confirmed = static-design evidence only.',
      measurement: 'REAL JSONL session persistence + REAL resume (sessionPersistence.prepare → sessions.enter → sessions.announce) + REAL loaded-DSH ctx.agents.resume + REAL fork primitive ctx.sessions.fork + REAL TaskStateBasicService (ctx.plugin) + REAL task-state-prompt consumer/assembly + REAL durable JSON storage domain; FAKE LLM (scripted adapter, no usage); medium INSIDE this E09 directory; no $HOME/.dsh, no existing session, no port, no concurrent process.',
      invokedAs: 'ctx.plugin(TaskStateBasicService, CONFIG); the fixture never constructs TaskStateWorker and never calls observe/maybeSchedule/performBatch by hand',
      workerManuallyInvoked: false,
      config: { ...CONFIG, note: 'minEvents=1 is the production minimum; the deployment value 20 could never commit a single turn and E07 already showed no startup wave, so 1 isolates the fork/resume question from the threshold' },
      sessionIds: { parent: String(PARENT_ID), child: String(CHILD_ID) },
      sessionIdOrigin: {
        parent: 'ctx.sessions.create(PARENT_ID, { meta: { cwd } }) — the id is supplied by the fixture exactly as the DSH agent factory supplies it; lifecycle createdAt/cwd are minted by the store',
        child: 'returned by the real ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)',
        handForgedIdentityFields: false,
      },
      lifecycleIdentities: {
        parent: { createdAt: parentCreatedAt, cwd: META_CWD, isSeeded: false, inheritedEventCount: 0 },
        child: {
          createdAt: childCreatedAt,
          cwd: META_CWD,
          isSeeded: true,
          inheritedEventCount: childInherited,
          parentSession: String(PARENT_ID),
        },
        providerFenceFields: '(createdAt, cwd) only — service.ts lifecycleOf / recordFor; isSeeded and inheritedEventCount are NOT part of the plugin record key (审计资料 22 A3)',
      },
      processes: [
        { id: 'P1', role: 'stage A — parent forms stable revision 1 at cursor 5 (durable commit)' },
        { id: 'P2', role: 'stage B — resume the same SessionId/lifecycle through the production idiom and verify the same stable survives with no model call' },
        { id: 'P5', role: 'stage B2 — resume through the REAL ctx.agents.resume path and run ONE real step (the only real assembly/model-request row for the committed stable)' },
        { id: 'P6', role: 'stage C — resume through the idiom, extend the parent prefix (cursor 9), FORK the child, let the child commit its own stable' },
        { id: 'P7', role: 'stage D — resume the parent and the forked child; observe firstLiveSeq vs inheritedEventCount' },
      ],
      components: {
        agentLoop: agentLoopModule,
        persistence: { plugin: '@deepseek-ai/dsh-session-persistence-jsonl', root: SESSION_ROOT, compression: 'none' },
        storage: { domainRoot: STORAGE_ROOT, backend: 'json', domain: 'context_enhancement_task_state' },
        promptConsumer: {
          plugin: 'dsh-context-enhancement/task-state-prompt',
          maxBytes: PROMPT_MAX_BYTES,
          template: '{{task_state_snapshot}}',
        },
        renderer: 'src/internal/task-state/prompt/render.ts renderTaskStateSnapshot(stable, 8000) — the exact text the consumer hands to ctx.systemPrompt',
      },
      stages: { stageA, stageB, stageB2, stageC, stageD, stageE },
      criteria: {
        fixedBeforeRun: true,
        parentFormed,
        routeWorked,
        resumeRouteAvailable,
        realAgentStepWorked,
        forkRouteAvailable,
        parentRevisionA,
        parentCursorA,
        parentAuditRowCount: parentRows.length,
        childAuditRowCount: childRows.length,
        parentRevisionAfterAppend,
        parentCursorAfterAppend,
        childInheritedCount: childInherited,
        childOwnCursor,
        R1_resumeKeptSameLifecycleStable: r1ResumeKeptStable,
        R2_childHasOwnStableAndParentUntouched: r2ChildOwnStable,
        R3_noCrossSessionReference: r3NoCrossReference,
        R4_boundaryFromDurableInheritedCut: r4BoundaryFromDurableCut,
        reproducedCriteria,
        anyReproduced,
        evidenceComplete,
        verdict,
      },
      /** The `firstLiveSeq` vs `inheritedEventCount` facts this experiment had to record. */
      firstLiveVsInherited: {
        unseededParentResumed: {
          atResume: stageB['firstLiveSeqVsInheritedCountAtResume'] ?? null,
          afterSeedMarker: stageB['firstLiveSeqVsInheritedCountAfterMarker'] ?? null,
          note: 'an unseeded Session keeps inheritedEventCount = 0 in every lifecycle; after a resume firstLiveSeq is this lifecycle\'s constructor seed length — the length of the WHOLE stored log (the marker event is appended right after firstLiveSeq is fixed, which is why logLength is one higher here)',
        },
        forkedChildAtFork: {
          inheritedEventCount: childInherited,
          firstLiveSeq: fork['childFirstLiveSeq'] ?? null,
          equal: fork['childFirstLiveSeqEqualsInheritedCount'] ?? null,
          note: 'at fork time the child log is exactly the seed (prefix + one session/end-seed marker), so the two coincide by construction — the fork case cannot distinguish them',
        },
        forkedChildAfterResume: childResume['firstLiveSeqVsInheritedCount'] ?? null,
        misuseCheck: 'neither field is read by the plugin: src has 0 hits for inheritedEventCount|firstLiveSeq|isSeeded, and the fold only compares seq against the committed cursor — so no firstLiveSeq-as-inherited-boundary misuse is possible in this code, and the recorded boundary came from the durable count instead',
      },
      matchedStaticFindings: [
        {
          id: 'D10',
          source: '审计资料/23-长期状态Worker与注入差异.md D10（§2 "D10 fork bootstrap"）+ 理想化落地方案 §3.13/§5.5',
          staticClaim: 'no fork/inheritance code at all: inheritedEventCount/firstLiveSeq/isSeeded have 0 hits in src; committedCursor is -1 without a record, so the batch fold starts at seq 0 over the whole log; no inherited marker, no one-shot parent-stable bootstrap, no own-events boundary',
          dynamicEvidence: `child has no stable before its own events (childStableBeforeOwnEvents = null), then rebuilds its own stable revision 1 whose folded window starts at seq 0 and whose cursor (${childOwnCursor}) lands inside the inherited prefix (inheritedEventCount ${childInherited})`,
          agreement: 'confirmed-for-default-branch',
        },
        {
          id: 'E-17',
          source: '审计资料/23 §3 表 E-17（resume 同 id 新 lifecycle 不覆盖旧记录）',
          staticClaim: 'resume keeps the same lifecycle by matching (createdAt, cwd); a mismatched lifecycle is rejected and the runtime rebuilt',
          dynamicEvidence: 'three resumes of the same SessionId restored the same-lifecycle stable with an unchanged createdAt, zero extra model calls, and no reset of the revision',
          agreement: 'confirmed',
        },
        {
          id: 'A3',
          source: '审计资料/22-长期状态存储恢复与多实例差异.md A3（lifecycle identity 缺 isSeeded/inheritedEventCount）',
          staticClaim: 'the plugin record key is (createdAt, cwd) only; the DSH identity is four fields (createdAt, cwd, isSeeded, inheritedEventCount)',
          dynamicEvidence: 'the fork child of this run has a different SessionId AND a different createdAt, so no cross-reference occurred; a same-id, same-cwd, different-isSeeded collision was NOT constructed (that would require hand-forging a header)',
          agreement: 'confirmed-untested-collision',
        },
        {
          id: 'X2',
          source: '审计资料/23 §4 表 X2（fork 子首批是否把继承前缀中已被遮蔽的原始事件一并折叠）',
          staticClaim: 'cannot be decided statically: snapshotEvents() returns the whole log and the fold only filters by seq > cursor',
          dynamicEvidence: 'the sealed child folded inherited prefix events (its first audit row contains seqs below the inherited cut). The prefix carried one plugin-sourced, filter-INELIGIBLE surface node, which was correctly dropped (never appears in any stable fact); the shadowed-ORIGINAL variant (a filter-ELIGIBLE event covered by a replacement) was not constructed, so X2 is only partially answered here',
          agreement: 'partially-answered',
        },
        {
          id: 'D10-own-events-cut',
          source: '理想化落地方案 §5.5 第 2-3 条（Fork：cursor 起点为子 own events 边界；子第一批读取继承前缀 + own events，形成自己的 revision 1）',
          staticClaim: 'the plan fixes the child cursor origin at the child\'s own-events boundary and its first revision at 1 over inherited + own events',
          dynamicEvidence: `the child\'s cursor origin is 0 (cursor = -1 without a record ⇒ the whole inherited prefix folds), and the child\'s first stable is revision 1 at cursor ${childOwnCursor} — so the "own-events boundary" origin is NOT implemented while the "own revision 1" and "inherited + own events" parts are. The inherited-prefix fold is not merely a bookkeeping detail: the child\'s first window contains the parent\'s ENTIRE committed revision-2 content (the parent audit row for revision 2 lists the same inherited seqs)`,
          agreement: 'deviation-incomplete-contract',
        },
      ],
      errors,
      limitations: [
        'fake LLM：唯一模型是脚本化 adapter（task-state 辅助请求返回固定结构候选 JSON，agent 请求返回一段文本、无 tool call）。adapter 刻意不产出 usage，故 provider token、计费量与真实摘要语义均未测量。',
        'route 被替换：部署 route（deepseek-official/deepseek-v4-flash）下注册的是 fake adapter，不是真实 provider。',
        'AgentLoop 的载入方式与 E08 相同：以原生 import() 读入被审计 DSH checkout（HEAD a66e4702）的 packages/core/agent-loop/lib/index.js（sha256 记入 ledger）；本工作区未新增/复制该包的任何文件。若该 sha256 与审计基线不符，step/surface 层证据不成立。',
        'minEvents=1 是生产允许的最小阈值。部署值 20 下单个完整 turn（3 个可投影 eligible 事件）永远不能触发提交，且 E07 已证明 resume 不开 startup 波，故 1 才能把「resume 丢失 stable」与「未达阈值」分开；阈值不参与任何 fork/resume identity 判定。',
        'fork 走的是 Session 级生产原语 ctx.sessions.fork（新 id、seeded header、精确 inheritedEventCount、深拷贝前缀），不是 Web/CLI 的 ctx.agents.create({seed, inheritedEventCount, meta}) 包装。本实验未走该包装；包装层差异不影响本实验记录的 Session/TaskState 读取语义。',
        '四个 resume/fork 阶段（A/B/B2/C/D）是同一 vitest 进程内顺序挂载/销毁的 Cordis Context，不是操作系统进程；但每阶段的 JSONL/存储句柄都完整 dispose 并从磁盘重新打开，且任一时刻只有一个 Context 存活。',
        '两种 resume 机制必须分属不同 Context：同一 Context 内 resume 习语（sessionPersistence.prepare → enter → announce）已使 Session 处于 live，再调 ctx.agents.resume 会以 "cannot prepare session … while it is live" 拒绝（本次首轮运行已实测到该错误，故拆成 P2/P6 与 P5）。这不是产品缺陷，而是生产对同一 Context 双重复活的显式拒绝。',
        'step 层的 snapshot 文本只与同一渲染文本做 hash 比对（request.snapshotTexts 来自真实模型请求中的 runtime-context 消息），不测量真实 prompt 的完整节点数或 token 归因。',
        '本实验不挂压缩插件：candidate 的 replacement 语义与「fork 子折叠被 replacement 遮蔽的原始事件」这条未测（X2 只得到「filter 不可投影的继承事件被正确丢弃」这半边）。',
        'fixture 没有伪造「同 id、同 createdAt/cwd、但 isSeeded/inheritedEventCount 不同」的碰撞生命周期：那只能靠手工构造 header 才能触发，按纪律不以伪造身份字段得出结论，故 A3 的碰撞分支记为未测。',
        'renderTaskStateSnapshot 的注入 hash 只证明「该 lifecycle 读到的是哪一份 stable」，不测量真实 prompt 的可见节点数或 token 归因；step 层的 snapshot 文本对比也只是与同一渲染文本做 hash 比对。',
        '本实验「通过」只表示 fixture 与结构断言通过；verdict 只回答本文件开头那一个问题，不代表理想方案通过。',
      ],
      sourceKinds: {
        note: 'Session surface source kinds and the filter projection of each involved event',
        parentFilterKindsStageA: stageA['filterKinds'] ?? null,
        parentFilterKindsStageC: stageC['parentFilterKinds'] ?? null,
        hiddenNodeShape: 'user/message with source {kind:plugin, plugin:@deepseek-ai/dsh-system-prompt, form:snapshot} — model-visible on the surface, projectable = null for the task-state filter',
      },
      /** Side observations recorded for the parent agent, NOT part of the E09 verdict. */
      sideObservations: {
        parentOpenAuditRow: {
          rows: parentRows.filter(row => row['outcome'] === 'open'),
          note: 'one parent audit row stayed `open` (target revision 2, base revision 1, one folded seq) while a later row committed revision 2 from the SAME base. This is the worker\'s failed/abandoned attempt path, not a fork/resume identity fact; recorded only because the durable medium was read whole. It is NOT an E09 reproduced criterion.',
        },
        childRevisionNumbering: {
          parentRevisions: parentRows.map(row => row['targetRevision']),
          childFirstRevision: childRows[0]?.['finishedRevision'] ?? null,
          note: 'the child starts a NEW revision-1 series in its own lifecycle instead of continuing the parent\'s revision sequence. That matches 理想化落地方案 §5.5 ("子第一批…形成自己的 revision 1") and is therefore the designed behaviour, not a defect.',
        },
        childFoldedWindowEqualsParentWindow: {
          parentCommittedSeqs: (parentRows.find(row => row['outcome'] === 'success' && row['finishedRevision'] === 2)?.['includedSeqs'] ?? null),
          childOwnAddedSeqs: childRows[0]?.['includedSeqs'] ?? null,
          note: 'every inherited seq the child folded is also in the parent\'s committed revision-2 window; the child\'s window additionally contains its own turn (and the parent\'s window contains none of the child\'s seqs)',
        },
      },
    }

    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    // Print the captured stage errors before any assertion can mask them.
    if (errors.length > 0) console.error('[E09] stage errors:', JSON.stringify(errors, null, 2))

    // ---- structural invariants (the fixture ran as designed) --------------
    expect(errors).toEqual([])
    expect(parentRevisionA).toBe(1)
    expect(parentCursorA).toBe(5)
    // The real step saw the committed stable's injected text in a real request.
    expect(realStepView['requestSnapshotCount']).toBeGreaterThanOrEqual(1)
    expect((realStepView['requestSnapshotTexts'] as string[]) ?? [])
      .toContainEqual(expect.stringContaining(`revision ${parentRevisionA}, source event ${parentCursorA}`))
    expect(assemblyLayer['renderedRevision']).toBe(parentRevisionA)
    expect(assemblyLayer['renderedSourceCursor']).toBe(parentCursorA)
    // A resumed UNSEEDED session seeds its whole stored log: the in-process cut
    // is that seed length and the durable heredity count stays 0, so the two
    // facts are demonstrably different (and the plugin reads neither).
    expect(stageBIdentity?.['firstLiveSeq']).toBe(6)
    expect(stageBIdentity?.['logLength']).toBe(7)
    expect(stageBIdentity?.['inheritedEventCount']).toBe(0)
    expect(stageBIdentity?.['firstLiveSeqEqualsInheritedCount']).toBe(false)
    expect(stageBIdentity?.['firstLiveSeqEqualsLogLength']).toBe(false)
    // The parent's second turn committed revision 2 at exactly its last appended
    // event; the fork boundary is that sealed prefix.
    expect(parentRevisionAfterAppend).toBe(2)
    expect(parentCursorAfterAppend).toBe((stageC['parentTurn2'] as Record<string, unknown>)['outerTurnEnd2'])
    // The fork cut is the durable prefix length, not the in-process marker.
    expect(fork['childInheritedCount']).toBe((fork['prefixBoundary'] as number | undefined ?? -2) + 1)
    expect(fork['prefixBoundary']).toBe(parentCursorAfterAppend)
    expect(parentCursorAfterAppend).toBeGreaterThan(parentCursorA)
    expect(fork['childFirstLiveSeqEqualsInheritedCount']).toBe(true)
    expect(fork['childStableBeforeOwnEvents']).toBeNull()
    expect(childCommit['publishedForChild']).toBe(true)
    expect(childCursorVsCut['cursorAtOrAboveInheritedCut']).toBe(true)
    // The child's FIRST committed cursor lands inside its own appended turn
    // (beyond the inherited cut, not on it): the distance is exactly how far the
    // child's own turn reached past the durable fork cut.
    expect(childCursorVsCut['cursorDistanceFromInheritedCut'])
      .toBe((childCommit['appendedSeqs'] as Record<string, number>)['turnEnd']! - childInherited)
    expect((stageA['stableFactsContainHiddenMarker'])).toBe(false)
    expect(fork['hiddenMarkerInChildStableAfterCommit']).toBe(false)
    expect(stageE['childFirstCommitFoldedInheritedPrefix']).toBe(true)
    // The resumed seeded child: the in-process construction cut and the DURABLE
    // heredity cut are different facts (the marker event sits one above the cut).
    const childResumeCuts = childResume['firstLiveSeqVsInheritedCount'] as Record<string, number | boolean>
    expect(childResumeCuts['inheritedEventCount']).toBe(childInherited)
    expect(childResumeCuts['firstLiveSeq']).toBe((childResumeCuts['logLength'] as number) - 1)
    expect(childResumeCuts['equal']).toBe(false)
    expect(childResumeCuts['firstLiveSeq']).not.toBe(childResumeCuts['inheritedEventCount'])
    expect(childResumeCuts['firstLiveSeq']).toBeGreaterThan(childResumeCuts['inheritedEventCount'] as number)
    expect(parentRows.length).toBeGreaterThanOrEqual(3)
    expect(childRows.length).toBe(1)
    expect(durableParentRecord?.stable.sourceCursor ?? -1).toBeGreaterThanOrEqual(parentCursorAfterAppend)
    expect(durableChildRecord?.stable.sourceCursor ?? -1).toBe(childOwnCursor)
    expect(r1ResumeKeptStable).toBe(true)
    expect(r2ChildOwnStable).toBe(true)
    expect(r3NoCrossReference).toBe(true)
    expect(r4BoundaryFromDurableCut).toBe(true)
    expect(verdict).toBe('not-reproduced')
  }, TEST_TIMEOUT_MS)
})
