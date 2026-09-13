/**
 * E08 · Stable 注入累积 / stable injection accumulation (L2)
 *
 * EXPERIMENT QUESTION (the only one)
 * ----------------------------------
 * When several content-different Stable Task State revisions are committed one
 * after another, and ONE prompt assembly / agent step runs after each revision,
 * does the OLD Stable snapshot keep accumulating through the runtime context, or
 * is it replaced by a fixed slot / a surface replacement?
 *
 * VERDICT RULE (recorded before the run; 审计资料/32 §5 E08)
 * ---------------------------------------------------------
 *   reproduced      = after >= 10 content-different revisions, each followed by
 *                     exactly one real step, the OLD snapshots (a) stay visible
 *                     on the Session surface, (b) are still present in the
 *                     model-visible request of every later step, and (c) the
 *                     injected node count / bytes / token-meter attribution grow
 *                     with the revision count, while NO replacement operation
 *                     ever covers a previous snapshot and the durable stable
 *                     store still holds exactly ONE (latest) record;
 *   not-reproduced  = every step sees only the newest snapshot (old ones are
 *                     replaced/absent), so the injection cost stays flat;
 *   inconclusive    = the runner / fixture / route could not produce the
 *                     evidence (mount failure, no revision, deadline, runner
 *                     error) — old snapshots are then NOT claimed to be visible;
 *   design-confirmed = static-design evidence only.
 *
 * TWO LAYERS, MEASURED SEPARATELY (the distinction the question turns on)
 * ----------------------------------------------------------------------
 * 1. ASSEMBLY layer — `ctx.systemPrompt.assemble()` + `renderContextSnapshot()`
 *    with the REAL `dsh-context-enhancement/task-state-prompt` consumer mounted.
 *    The consumer registers ONE fixed dynamic-context slot (`task-state:snapshot`,
 *    order 125) whose variable renders `ctx.taskState.getStable(session)`.
 * 2. RUNTIME-CONTEXT / SURFACE layer — the REAL DSH `AgentLoop` (a66e4702) turns
 *    each CHANGED assembled snapshot into a `user/message` surface node
 *    (`session.append(..., { surfaceOp: 'append' })`) and the next request is
 *    built from `session.deriveMessages()`. This layer is where accumulation
 *    would happen, so it is measured on the real model request handed to the
 *    adapter and on `session.surface.nodes`, never inferred from the renderer.
 *
 * REAL in this spec (production code only; nothing is modified)
 * -------------------------------------------------------------
 * - REAL `TaskStateBasicService` (`ctx.plugin`, deployment config): scheduler,
 *   filter, batch fold, prompt frame, candidate validation, authority put,
 *   audit rows, committed pointer;
 * - REAL `dsh-context-enhancement/task-state-prompt` consumer (`ctx.plugin`) and
 *   REAL `renderTaskStateSnapshot` / `renderContextSnapshot` / `assemble()`;
 * - REAL durable storage domain `context_enhancement_task_state`
 *   (`Storage` + `StorageJson` + `StorageDomain`, rooted INSIDE this E08
 *   directory) so the STORE can be read back from disk and compared with the
 *   surface;
 * - REAL `LlmRuntime`, `SessionStore`, `SessionProjectionRegistry`,
 *   `SystemPrompt`, `ToolRuntime`, `AgentRegistry`, `TokenMeter`;
 * - REAL DSH `AgentLoop` @0.1.2-rc.1, imported from the audited DSH checkout
 *   (`deepseek-harness`, HEAD a66e4702) built lib. Its SHA-256 is recorded in
 *   the ledger. The import is a native ESM `import()` of an absolute file URL
 *   (vite-ignored), so the module graph of this workspace is untouched.
 * - REAL token metering for the injection attribution (`ctx.tokenMeter.measure`).
 *
 * FAKE in this spec
 * -----------------
 * - the ONLY LLM is a scripted `LlmAdapter` registered for the deployment route
 *   (`deepseek-official` / `deepseek-v4-flash`). It answers task-state auxiliary
 *   requests (`purpose: 'task-state'`) with a structurally valid candidate JSON
 *   whose content carries a unique per-call marker, and agent-loop requests with
 *   a short text block. It records EVERY request verbatim (messages, sizes,
 *   snapshot texts). It produces no provider usage, so provider tokens are not
 *   measured — only the meter's fixed heuristic.
 * - no provider, no network, no `$HOME/.dsh`, no existing session, no port 8080,
 *   no Web GUI, no second process.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
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

// ---------------------------------------------------------------------------
// Fixed experiment constants
// ---------------------------------------------------------------------------

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** Real durable task-state domain root — INSIDE this E08 directory. */
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')
/** The durable domain document written by the real JSON storage backend. */
const DOMAIN_FILE = join(STORAGE_ROOT, 'context_enhancement_task_state.json')
const LEDGER_PATH = join(OUT_DIR, 'e08-ledger.json')

const SESSION_ID = SessionId('e08-stable-injection')

/** Deployment route (presets/contextual + cordis.patch.yml). */
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

/** Deployment `task-state-basic` config (cordis.patch.yml, host plane). */
const CONFIG: TaskStateBasicConfig = {
  provider: PROVIDER,
  model: MODEL,
  minEvents: 20,
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

/** Content-different Stable revisions to commit, one real step each. */
const REVISION_COUNT = 12
/**
 * Eligible human events appended per revision. The deployment threshold is
 * `minEvents = 20`, so a batch of 20 fresh eligible events crosses it exactly
 * once and the production observer commits exactly one new revision per
 * iteration (the step's own traffic adds only 3 eligible events).
 */
const SEEDS_PER_REVISION = 20

/** The audited DSH checkout (fixed baseline: HEAD a66e4702). */
const DSH_ROOT = 'C:\\Users\\chuxi\\Documents\\trae_projects\\code\\deepseek-harness'
const AGENT_LOOP_LIB = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'lib', 'index.js')
const AGENT_LOOP_SRC_DIR = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'src')

/** Source marker DSH puts on every materialized runtime-context snapshot. */
const SNAPSHOT_SOURCE_PLUGIN = '@deepseek-ai/dsh-system-prompt'
/** Header line the plugin renderer writes for every revision. */
const HEADER_RE = /Durable task state \(revision (\d+), source event (\d+), digest ([0-9a-f]+)\)/u
/** Per-iteration deadline for one production commit (ms). */
const COMMIT_DEADLINE_MS = 20_000
/** Per-iteration deadline for one real step (ms). */
const STEP_DEADLINE_MS = 30_000
/** Full test deadline (ms). */
const TEST_TIMEOUT_MS = 300_000

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

/** UTF-8 byte length of one string. */
function bytesOf(text: string): number {
  return encoder.encode(text).byteLength
}

/** SHA-256 of one string, hex encoded. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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

/** Text of one model-visible message (user/assistant text blocks joined). */
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

/** Compact view of one model-visible message. */
function messageView(message: unknown, index: number): Record<string, unknown> {
  const text = messageText(message)
  const source = (message as { readonly source?: unknown }).source as
    | { readonly kind?: unknown; readonly plugin?: unknown; readonly form?: unknown; readonly sections?: unknown }
    | undefined
  const header = HEADER_RE.exec(text)
  return {
    index,
    role: String((message as { readonly role?: unknown }).role ?? 'unknown'),
    sourceKind: source?.kind === undefined ? null : String(source.kind),
    sourcePlugin: source?.plugin === undefined ? null : String(source.plugin),
    sourceForm: source?.form === undefined ? null : String(source.form),
    sourceSectionNames: Array.isArray(source?.sections)
      ? (source.sections as readonly { readonly name?: unknown }[]).map(section => String(section?.name ?? ''))
      : null,
    isRuntimeContextSnapshot: isSnapshotMessage(message),
    chars: text.length,
    bytes: bytesOf(text),
    revisionHeader: header === null ? null : Number(header[1]),
    sourceCursorHeader: header === null ? null : Number(header[2]),
    digestHeader: header === null ? null : header[3],
    textHash: sha256(text).slice(0, 16),
  }
}

/** Revision headers (revision, sourceCursor, digest) found in one text. */
function revisionHeaders(text: string): { revision: number; sourceCursor: number; digest: string }[] {
  const out: { revision: number; sourceCursor: number; digest: string }[] = []
  for (const match of text.matchAll(new RegExp(HEADER_RE.source, 'gu'))) {
    out.push({ revision: Number(match[1]), sourceCursor: Number(match[2]), digest: match[3]! })
  }
  return out
}

/** Revision numbers present in one text, in order. */
function revisionNumbers(text: string): number[] {
  return revisionHeaders(text).map(header => header.revision)
}

// ---------------------------------------------------------------------------
// The scripted fake model (the ONLY LLM in this spec)
// ---------------------------------------------------------------------------

/** One captured auxiliary or agent-loop request. */
interface RecordedRequest {
  readonly index: number
  readonly at: number
  readonly kind: 'task-state' | 'agent-loop'
  readonly purpose: string | null
  readonly provider: string
  readonly model: string
  readonly messageCount: number
  readonly messages: readonly Record<string, unknown>[]
  readonly snapshotMessageCount: number
  readonly snapshotBytes: number
  readonly revisionHeaders: readonly number[]
  readonly totalTextBytes: number
  readonly systemBytes: number
  readonly inputChars: number
  readonly outputChars: number
}

/**
 * Answers every request with a scripted response and records it verbatim.
 *
 * `purpose === 'task-state'` marks the REAL provider's auxiliary call (the
 * plugin casts its own purpose at the `ctx.llm.stream` boundary); every other
 * request is the REAL agent loop's. The task-state answer is a structurally
 * valid candidate JSON whose content carries a unique per-call marker, so each
 * committed revision differs in content; the agent-loop answer is a short text
 * block that ends the turn after one step.
 */
class RecordingAdapter extends LlmAdapter {
  readonly requests: RecordedRequest[] = []
  private taskStateCalls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = (options as { readonly purpose?: unknown }).purpose
    const kind: RecordedRequest['kind'] = purpose === 'task-state' ? 'task-state' : 'agent-loop'
    const messages = (options.messages ?? []) as readonly unknown[]
    const views = messages.map((message, index) => messageView(message, index))
    const snapshotViews = views.filter(view => view['isRuntimeContextSnapshot'] === true)
    const headers = views.flatMap(view =>
      view['revisionHeader'] === null ? [] : [Number(view['revisionHeader'])])
    const inputText = messages.map(messageText).join('')
    const systemText = typeof (options as { readonly system?: unknown }).system === 'string'
      ? String((options as { readonly system?: unknown }).system)
      : ''
    const text = kind === 'task-state'
      ? this.candidateFor(inputText)
      : `E08 assistant reply ${this.requests.filter(row => row.kind === 'agent-loop').length + 1}: no tool call, the turn ends after one step.`
    const row: RecordedRequest = {
      index: this.requests.length,
      at: Date.now(),
      kind,
      purpose: purpose === undefined ? null : String(purpose),
      provider: String(options.provider),
      model: String(options.model),
      messageCount: messages.length,
      messages: views,
      snapshotMessageCount: snapshotViews.length,
      snapshotBytes: snapshotViews.reduce((sum, view) => sum + Number(view['bytes']), 0),
      revisionHeaders: headers,
      totalTextBytes: bytesOf(inputText),
      systemBytes: bytesOf(systemText),
      inputChars: inputText.length,
      outputChars: text.length,
    }
    this.requests.push(row)
    // Block layout mirrors the DSH test mock adapter: one text block + finish.
    // NO `usage` chunk is produced on purpose: this adapter is not a provider,
    // so no provider token number may enter the meter's baseline anchor.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** One structurally valid candidate carrying a unique per-call marker. */
  private candidateFor(inputText: string): string {
    const seqs = [...inputText.matchAll(/"seq":\s*(\d+)/gu)].map(match => Number(match[1]))
    const maxSeq = seqs.length === 0 ? -1 : Math.max(...seqs)
    this.taskStateCalls += 1
    const marker = `E08-CALL-${this.taskStateCalls}-THROUGH-SEQ-${maxSeq}`
    const encoderBody = JSON.stringify({
      facts: [
        { content: `E08 durable marker ${marker}: the folded window ended at session event ${maxSeq}.` },
        { content: `E08 padding ${marker}: ${'p'.repeat(160)}` },
      ],
      decisions: [{ content: `E08 decision ${marker}` }],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `E08 objective ${marker}`,
        currentFocus: `E08 focus ${marker}`,
        openWork: [],
        nextActions: [],
      },
    })
    return encoderBody
  }

  /** Every recorded agent-loop request (the model-visible steps). */
  agentRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'agent-loop')
  }

  /** Every recorded task-state auxiliary request. */
  taskStateRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'task-state')
  }
}

// ---------------------------------------------------------------------------
// Session / surface observation helpers
// ---------------------------------------------------------------------------

/** Append one direct human user/message on the surface; returns its seq. */
function appendUser(session: Session, text: string): number {
  return Number(session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq)
}

/** Compact view of one committed stable. */
function stableView(stable: TaskStateStable | undefined): Record<string, unknown> | null {
  if (stable === undefined) return null
  const snapshot = renderTaskStateSnapshotOf(stable)
  return {
    revision: stable.revision,
    sourceCursor: stable.sourceCursor,
    filterVersion: stable.filterVersion,
    schemaVersion: stable.schemaVersion,
    digest: stable.digest,
    objective: stable.continuation.currentObjective,
    facts: stable.facts.map(fact => fact.content),
    renderedChars: snapshot.length,
    renderedBytes: bytesOf(snapshot),
    renderedHash: sha256(snapshot).slice(0, 16),
    renderedHeader: revisionHeaders(snapshot)[0] ?? null,
  }
}

/** Render one stable through the REAL production renderer at the deployment budget. */
function renderTaskStateSnapshotOf(stable: TaskStateStable): string {
  // The renderer is re-exported by the plugin's prompt subpath; using it keeps the
  // spec on the production code path (no local re-implementation).
  return TaskStatePrompt.renderTaskStateSnapshot(stable, PROMPT_MAX_BYTES)
}

/** One runtime-context snapshot node as it exists in the log and on the surface. */
interface SnapshotNodeView {
  readonly seq: number
  readonly visibleOnSurface: boolean
  readonly surfaceOp: string
  readonly revision: number | null
  readonly sourceCursor: number | null
  readonly sourceKind: string | null
  readonly sourcePlugin: string | null
  readonly sourceForm: string | null
  readonly chars: number
  readonly bytes: number
  readonly textHash: string
}

/** Every runtime-context snapshot node, with its surface visibility and source kind. */
function snapshotNodes(session: Session): SnapshotNodeView[] {
  const onSurface = new Set(session.surface.nodes.map(node => Number(node)))
  const out: SnapshotNodeView[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const data = event.data as { readonly content?: unknown; readonly source?: unknown }
    const source = data.source as
      | { readonly kind?: unknown; readonly plugin?: unknown; readonly form?: unknown }
      | undefined
    if (source?.kind !== 'plugin' || source.plugin !== SNAPSHOT_SOURCE_PLUGIN) continue
    const text = messageText({ content: data.content })
    const header = revisionHeaders(text)[0]
    const op = (event as { readonly surfaceOp?: unknown }).surfaceOp
    out.push({
      seq: Number(event.seq),
      visibleOnSurface: onSurface.has(Number(event.seq)),
      surfaceOp: op === undefined ? 'undefined' : typeof op === 'string' ? op : String((op as { op?: unknown }).op ?? 'unknown'),
      revision: header?.revision ?? null,
      sourceCursor: header?.sourceCursor ?? null,
      sourceKind: source.kind === undefined ? null : String(source.kind),
      sourcePlugin: source.plugin === undefined ? null : String(source.plugin),
      sourceForm: source.form === undefined ? null : String(source.form),
      chars: text.length,
      bytes: bytesOf(text),
      textHash: sha256(text).slice(0, 16),
    })
  }
  return out
}

/** Every replacement surface event in the log, with its covered seqs. */
function replacementEvents(session: Session): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const event of session.snapshotEvents()) {
    const op = (event as { readonly surfaceOp?: unknown }).surfaceOp
    if (op === undefined || typeof op === 'string') continue
    const record = op as { readonly op?: unknown; readonly start?: unknown; readonly end?: unknown }
    if (record.op !== 'replace') continue
    out.push({
      seq: Number(event.seq),
      type: String(event.type),
      operation: String(record.op),
      start: record.start === undefined ? null : Number(record.start),
      end: record.end === undefined ? null : Number(record.end),
      sourceEventSeqs: ((event as { readonly sourceEventSeqs?: readonly unknown[] }).sourceEventSeqs ?? []).map(Number),
      sourcePlugin: String(((event.data as { readonly source?: { readonly plugin?: unknown } }).source?.plugin) ?? ''),
    })
  }
  return out
}

/** Source kinds of the current surface nodes (original log event vs derived replacement). */
function surfaceSourceKinds(session: Session): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const node of session.surface.nodes) {
    const event = session.eventAt(node) as { readonly type?: unknown; readonly surfaceOp?: unknown } | undefined
    if (event === undefined) continue
    const op = event.surfaceOp
    const kind = op === undefined || op === 'append'
      ? 'original'
      : `replacement:${String((op as { readonly op?: unknown }).op ?? 'unknown')}`
    const key = `${String(event.type)}:${kind}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** Compact view of the durable store document on disk. */
interface StoreView {
  readonly read: boolean
  readonly domainFile: string | null
  readonly domainFileBytes: number | null
  readonly sessionRecordCount: number | null
  readonly stableRecordCountForSession: number | null
  readonly stableRevision: number | null
  readonly stableSourceCursor: number | null
  readonly auditRowCount: number | null
}

/** Read the real durable domain document and describe the stable it holds. */
function readStore(): StoreView {
  let raw: string
  try {
    raw = readFileSync(DOMAIN_FILE, 'utf8')
  } catch {
    return {
      read: false,
      domainFile: relative(process.cwd(), DOMAIN_FILE),
      domainFileBytes: null,
      sessionRecordCount: null,
      stableRecordCountForSession: null,
      stableRevision: null,
      stableSourceCursor: null,
      auditRowCount: null,
    }
  }
  const doc = JSON.parse(raw) as {
    readonly tables?: {
      readonly sessions?: Record<string, { readonly stable?: { readonly revision?: number; readonly sourceCursor?: number } }>
      readonly audit?: Record<string, unknown>
    }
  }
  const sessions = doc.tables?.sessions ?? {}
  const record = sessions[String(SESSION_ID)] as { readonly stable?: unknown } | undefined
  const stable = Array.isArray(record?.stable) ? undefined : record?.stable as { readonly revision?: number; readonly sourceCursor?: number } | undefined
  const stableRecords = Object.values(sessions).filter(entry =>
    (entry as { readonly stable?: unknown }).stable !== undefined).length
  return {
    read: true,
    domainFile: relative(process.cwd(), DOMAIN_FILE),
    domainFileBytes: statSync(DOMAIN_FILE).size,
    sessionRecordCount: Object.keys(sessions).length,
    stableRecordCountForSession: stable === undefined ? 0 : stableRecords,
    stableRevision: stable?.revision === undefined ? null : Number(stable.revision),
    stableSourceCursor: stable?.sourceCursor === undefined ? null : Number(stable.sourceCursor),
    auditRowCount: Object.keys(doc.tables?.audit ?? {}).length,
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** One mounted experiment context. */
interface Composition {
  readonly ctx: Context
  readonly adapter: RecordingAdapter
  readonly session: Session
}

/** Mount the REAL services; `AgentLoop` is mounted only when its module loaded. */
async function mountComposition(AgentLoop: unknown): Promise<Composition> {
  const ctx = new Context()
  const adapter = new RecordingAdapter()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  // REAL durable domain, rooted inside this E08 directory.
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  // REAL provider + REAL prompt consumer (the plugin's own subpath entries).
  await ctx.plugin(TaskStateBasicService, CONFIG)
  await ctx.plugin(TaskStatePrompt, { maxBytes: PROMPT_MAX_BYTES })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  if (AgentLoop !== null) {
    await ctx.plugin(AgentLoop as never, { agents: [] })
  }
  return { ctx, adapter, session: undefined as unknown as Session }
}

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

describe('E08 · stable injection accumulation (append vs fixed slot/replacement)', () => {
  it('commits 12 content-different revisions with one real step each and reports whether old snapshots stay model-visible', async () => {
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })

    const errors: { stage: string; message: string }[] = []
    const recordError = (stage: string, error: unknown): void => {
      errors.push({ stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    }

    // ---- phase 0: the DSH agent loop (the only non-dependency module) -----
    const agentLoopModule = {
      path: AGENT_LOOP_LIB,
      sha256: sha256File(AGENT_LOOP_LIB),
      srcDir: AGENT_LOOP_SRC_DIR,
      srcHashes: {
        'agent.ts': sha256File(join(AGENT_LOOP_SRC_DIR, 'agent.ts')),
        'runtime-context.ts': sha256File(join(AGENT_LOOP_SRC_DIR, 'runtime-context.ts')),
      },
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

    // ---- phase 1: mount the composition ----------------------------------
    let composition: Composition | null = null
    try {
      composition = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    } catch (error: unknown) {
      recordError('mount', error)
    }

    const iterations: Record<string, unknown>[] = []
    let surfaceRoute = {
      available: false,
      reason: 'not attempted',
      agentId: String(SESSION_ID),
    }
    let finalStable: TaskStateStable | undefined
    let session: Session | undefined
    let ctx: Context | undefined
    let adapter: RecordingAdapter | undefined

    if (composition !== null) {
      ctx = composition.ctx
      adapter = composition.adapter
      try {
        if (agentLoopModule.imported) {
          // REAL agent loop: it creates the Session through ctx.sessions, so the
          // REAL task-state provider observes `session/created` and attaches a worker.
          const loop = (ctx as unknown as {
            readonly agentLoop: { create: (id: SessionId, options: Record<string, unknown>) => unknown }
          }).agentLoop
          const agent = loop.create(SESSION_ID, { provider: PROVIDER, model: MODEL }) as {
            readonly session: Session
            readonly status: string
            followup: (message: unknown) => void
          }
          session = agent.session
          surfaceRoute = { available: true, reason: 'AgentLoop mounted', agentId: String(SESSION_ID) }

          for (let k = 1; k <= REVISION_COUNT; k += 1) {
            const record: Record<string, unknown> = {
              iteration: k,
              seeds: null,
              commit: null,
              step: null,
              assemblyLayer: null,
              runtimeContextLayer: null,
              modelRequest: null,
              tokenMeter: null,
              store: null,
              cumulative: null,
            }
            const previous = iterations[iterations.length - 1] as Record<string, unknown> | undefined
            const previousRevision = previous === undefined
              ? 0
              : Number(((previous['commit'] as Record<string, unknown>)['revisionAfter']) ?? 0)

            // ---- 1. seeds: 20 fresh eligible human events -------------------
            const before = adapter.taskStateRequests().length
            const seedSeqs: number[] = []
            let seedBytes = 0
            for (let j = 1; j <= SEEDS_PER_REVISION; j += 1) {
              const text = `E08 seed ${k}.${j}: durable-window content marker E08-K${k}-J${j} (revision ${k} batch ${j}).`
              seedBytes += bytesOf(text)
              seedSeqs.push(appendUser(session, text))
            }
            record['seeds'] = {
              count: seedSeqs.length,
              firstSeq: seedSeqs[0],
              lastSeq: seedSeqs[seedSeqs.length - 1],
              utf8Bytes: seedBytes,
            }

            // ---- 2. the REAL worker commits one content-different revision --
            const committed = await waitUntil(
              () => (ctx!.taskState.getStable(SESSION_ID)?.revision ?? 0) > previousRevision,
              COMMIT_DEADLINE_MS,
            )
            const stableBeforeStep = ctx.taskState.getStable(SESSION_ID)
            const taskStateCallsThisIteration = adapter.taskStateRequests().length - before
            if (!committed) recordError(`iteration${k}.commit`, new Error('no new stable revision within the deadline'))
            record['commit'] = {
              trigger: 'session/event observer → worker.maybeSchedule (production)',
              revisionBefore: previousRevision,
              revisionAfter: stableBeforeStep?.revision ?? null,
              sourceCursor: stableBeforeStep?.sourceCursor ?? null,
              digest: stableBeforeStep?.digest ?? null,
              taskStateModelCalls: taskStateCallsThisIteration,
              stableView: stableView(stableBeforeStep),
            }

            // ---- 3. ONE real step: assemble → project → request -------------
            const agentRequestBefore = adapter.agentRequests().length
            const idle = waitForIdle(ctx, agent, STEP_DEADLINE_MS)
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: `E08 step ${k} trigger: one assembly/step after revision ${stableBeforeStep?.revision ?? '?'}.` }],
              source: { kind: 'user' },
            }))
            let stepError: string | null = null
            try {
              await idle
            } catch (error: unknown) {
              stepError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
              recordError(`iteration${k}.step`, error)
            }
            const agentRequests = adapter.agentRequests()
            const request = agentRequests[agentRequests.length - 1]
            const stepRequests = agentRequests.length - agentRequestBefore

            // ---- 4. ASSEMBLY layer: the fixed contribution slot -------------
            let assemblyView: Record<string, unknown> | null = null
            try {
              const assembly = await ctx.systemPrompt.assemble(
                assembleContextFor(agent as never, new AbortController().signal),
              )
              const snapshotValue = renderContextSnapshot(assembly)
              const entries = assembly.contexts.filter(entry => entry.name === 'task-state:snapshot')
              assemblyView = {
                contributionEntriesNamedTaskStateSnapshot: entries.length,
                contributionCount: assembly.contexts.length,
                contributionOrder: entries.length === 0
                  ? null
                  : (entries[0] as { readonly order?: unknown }).order ?? null,
                contributionFieldsExposedByAssembly: entries.length === 0 ? [] : Object.keys(entries[0]!),
                contributionTemplate: entries.length === 0 ? null : entries[0]!.text,
                renderedChars: snapshotValue.length,
                renderedBytes: bytesOf(snapshotValue),
                renderedHash: sha256(snapshotValue).slice(0, 16),
                renderedRevisionHeaders: revisionHeaders(snapshotValue),
                renderedRevisionCount: revisionNumbers(snapshotValue).length,
              }
            } catch (error: unknown) {
              recordError(`iteration${k}.assemble`, error)
            }
            record['assemblyLayer'] = assemblyView

            // ---- 5. RUNTIME-CONTEXT / SURFACE layer -------------------------
            const nodes = snapshotNodes(session)
            const replacements = replacementEvents(session)
            const visible = nodes.filter(node => node.visibleOnSurface)
            const previousSnapshot = nodes[nodes.length - 2]
            record['runtimeContextLayer'] = {
              snapshotNodesInLog: nodes.length,
              snapshotNodesVisibleOnSurface: visible.length,
              visibleSnapshotRevisions: visible.map(node => node.revision),
              visibleSnapshotSeqs: visible.map(node => node.seq),
              snapshotNodesWithAppendOp: nodes.filter(node => node.surfaceOp === 'append').length,
              previousSnapshotSeqStillVisible: previousSnapshot === undefined
                ? null
                : previousSnapshot.visibleOnSurface,
              surfaceNodes: session.surface.nodes.length,
              logEvents: session.snapshotEvents().length,
              surfaceReplaceGeneration: (session.surface as { readonly replaceGeneration?: unknown }).replaceGeneration ?? null,
              replacementEvents: replacements.length,
              replacementDetails: replacements,
              surfaceSourceKinds: surfaceSourceKinds(session),
              snapshotNodeDetails: nodes,
            }

            // ---- 6. the model-visible request of THIS step ------------------
            const messages = (request?.messages ?? []) as readonly Record<string, unknown>[]
            const snapshotMessages = messages.filter(message => message['isRuntimeContextSnapshot'] === true)
            const headersInRequest = messages.flatMap(message =>
              message['revisionHeader'] === null ? [] : [Number(message['revisionHeader'])])
            const expectedRevisions = Array.from({ length: k }, (_, index) => index + 1)
            record['modelRequest'] = {
              requestIndex: request?.index ?? null,
              kind: request?.kind ?? null,
              messageCount: request?.messageCount ?? null,
              snapshotMessageCount: request?.snapshotMessageCount ?? null,
              snapshotBytes: request?.snapshotBytes ?? null,
              revisionHeaders: headersInRequest,
              containsEveryEarlierRevisionHeader: expectedRevisions.every(revision => headersInRequest.includes(revision)),
              totalTextBytes: request?.totalTextBytes ?? null,
              systemBytes: request?.systemBytes ?? null,
              messages: messages,
              snapshotTextHashes: snapshotMessages.map(message => message['textHash']),
              visibleSnapshotTextHashes: visible.map(node => node.textHash),
              modelSnapshotHashesMatchVisibleNodes: snapshotMessages.length === visible.length
                && snapshotMessages.map(message => String(message['textHash'])).sort().join(',')
                  === visible.map(node => node.textHash).sort().join(','),
              stepAgentRequests: stepRequests,
            }

            // ---- 7. REAL token-meter attribution ----------------------------
            let meterView: Record<string, unknown> | null = null
            try {
              const measurement = ctx.tokenMeter.measure(session)
              const visibleSeqs = new Set(visible.map(node => Number(node.seq)))
              const injectionNodes = measurement.nodes.filter(node => visibleSeqs.has(Number(node.seq)))
              meterView = {
                logRevision: Number(measurement.logRevision),
                baselineKind: measurement.baseline.kind,
                baselineTokens: measurement.baseline.tokens,
                surfaceTokens: measurement.surfaceTokens,
                totalTokens: measurement.totalTokens,
                surfaceDeltaTokens: measurement.surfaceDeltaTokens,
                nodeCount: measurement.nodes.length,
                injectionNodeCount: injectionNodes.length,
                injectionTokens: injectionNodes.reduce((sum, node) => sum + node.tokens, 0),
                injectionHeuristicTokens: injectionNodes.reduce((sum, node) => sum + node.heuristicTokens, 0),
                allNodeTokens: measurement.nodes.map(node => ({ seq: Number(node.seq), tokens: node.tokens })),
              }
            } catch (error: unknown) {
              recordError(`iteration${k}.tokenMeter`, error)
            }
            record['tokenMeter'] = meterView

            // ---- 8. the durable STORE (must still hold only the latest) -----
            record['store'] = readStore()

            // ---- 9. cumulative ---------------------------------------------
            const visibleBytes = visible.reduce((sum, node) => sum + node.bytes, 0)
            record['cumulative'] = {
              visibleSnapshotNodes: visible.length,
              visibleSnapshotBytes: visibleBytes,
              modelVisibleSnapshotMessages: request?.snapshotMessageCount ?? null,
              modelVisibleSnapshotBytes: request?.snapshotBytes ?? null,
              meterInjectionTokens: meterView === null ? null : meterView['injectionTokens'],
              meterSurfaceTokens: meterView === null ? null : meterView['surfaceTokens'],
            }
            record['step'] = {
              trigger: 'agent.followup → one preStep (assemble + project) → one model request → turn completed',
              error: stepError,
              agentStatus: agent.status,
            }
            iterations.push(record)
            finalStable = ctx.taskState.getStable(SESSION_ID)
          }
        } else {
          // Fallback route: no AgentLoop module → assembly-layer evidence only.
          session = ctx.sessions.create(SESSION_ID)
          surfaceRoute = {
            available: false,
            reason: agentLoopModule.mountError ?? 'AgentLoop module did not load',
            agentId: String(SESSION_ID),
          }
          const stubAgent = { session: { id: SESSION_ID } }
          for (let k = 1; k <= REVISION_COUNT; k += 1) {
            const record: Record<string, unknown> = { iteration: k, seeds: null, commit: null, assemblyLayer: null }
            const previous = iterations[iterations.length - 1] as Record<string, unknown> | undefined
            const previousRevision = previous === undefined
              ? 0
              : Number(((previous['commit'] as Record<string, unknown>)['revisionAfter']) ?? 0)
            const seedSeqs: number[] = []
            for (let j = 1; j <= SEEDS_PER_REVISION; j += 1) {
              seedSeqs.push(appendUser(session, `E08 seed ${k}.${j}: fallback-route content marker E08-K${k}-J${j}.`))
            }
            const committed = await waitUntil(
              () => (ctx!.taskState.getStable(SESSION_ID)?.revision ?? 0) > previousRevision,
              COMMIT_DEADLINE_MS,
            )
            if (!committed) recordError(`fallback${k}.commit`, new Error('no new stable revision within the deadline'))
            const stable = ctx.taskState.getStable(SESSION_ID)
            record['seeds'] = { count: seedSeqs.length, firstSeq: seedSeqs[0], lastSeq: seedSeqs[seedSeqs.length - 1] }
            record['commit'] = { revisionBefore: previousRevision, revisionAfter: stable?.revision ?? null, stableView: stableView(stable) }
            try {
              const assembly = await ctx.systemPrompt.assemble(assembleContextFor(stubAgent as never, new AbortController().signal))
              const snapshotValue = renderContextSnapshot(assembly)
              record['assemblyLayer'] = {
                contributionEntriesNamedTaskStateSnapshot: assembly.contexts.filter(entry => entry.name === 'task-state:snapshot').length,
                renderedChars: snapshotValue.length,
                renderedBytes: bytesOf(snapshotValue),
                renderedHash: sha256(snapshotValue).slice(0, 16),
                renderedRevisionHeaders: revisionHeaders(snapshotValue),
              }
            } catch (error: unknown) {
              recordError(`fallback${k}.assemble`, error)
            }
            record['store'] = readStore()
            iterations.push(record)
            finalStable = stable
          }
        }
      } catch (error: unknown) {
        recordError('drive', error)
      }
    }

    // ---- criteria (fixed before the run) and the verdict -------------------
    const surfaceIterations = iterations.filter(record => record['modelRequest'] !== null && record['runtimeContextLayer'] !== null)
    const revisions = surfaceIterations.map(record =>
      Number(((record['commit'] as Record<string, unknown>)['revisionAfter']) ?? -1))
    const distinctRevisions = [...new Set(revisions)]
    const growth = surfaceIterations.map(record => ({
      iteration: Number(record['iteration']),
      revision: Number(((record['commit'] as Record<string, unknown>)['revisionAfter']) ?? -1),
      visibleSnapshotNodes: Number(((record['runtimeContextLayer'] as Record<string, unknown>)['snapshotNodesVisibleOnSurface']) ?? -1),
      modelVisibleSnapshots: Number(((record['modelRequest'] as Record<string, unknown>)['snapshotMessageCount']) ?? -1),
      modelVisibleBytes: Number(((record['modelRequest'] as Record<string, unknown>)['snapshotBytes']) ?? -1),
      meterInjectionTokens: record['tokenMeter'] === null
        ? null
        : Number((record['tokenMeter'] as Record<string, unknown>)['injectionTokens']),
      storeStableRevision: record['store'] === null
        ? null
        : Number((record['store'] as Record<string, unknown>)['stableRevision']),
    }))
    const allPreviousSnapshotsRemainVisible = surfaceIterations.every((record, index) =>
      (record['modelRequest'] as Record<string, unknown>)['containsEveryEarlierRevisionHeader'] === true
      && Number(((record['runtimeContextLayer'] as Record<string, unknown>)['snapshotNodesVisibleOnSurface'])) === index + 1)
    const noReplacementAnywhere = surfaceIterations.every(record =>
      Number(((record['runtimeContextLayer'] as Record<string, unknown>)['replacementEvents'])) === 0)
    const modelRequestHashesMatchVisibleNodes = surfaceIterations.every(record =>
      ((record['modelRequest'] as Record<string, unknown>)['modelSnapshotHashesMatchVisibleNodes']) === true)
    const storeHoldsOneLatest = surfaceIterations.length > 0 && surfaceIterations.every((record, index) => {
      const store = record['store'] as Record<string, unknown>
      const commit = record['commit'] as Record<string, unknown>
      return store['read'] === true
        && Number(store['stableRecordCountForSession']) === 1
        && Number(store['stableRevision']) === Number(commit['revisionAfter'])
        && index >= 0
    })
    const growthIsMonotone = growth.length >= 2 && growth.every((row, index) => index === 0
      ? true
      : row.modelVisibleSnapshots > growth[index - 1]!.modelVisibleSnapshots
        && row.visibleSnapshotNodes > growth[index - 1]!.visibleSnapshotNodes
        && row.modelVisibleBytes > growth[index - 1]!.modelVisibleBytes)
    const earlierRevisionHeadersLiterallyInRequest = surfaceIterations.map(record => {
      const request = record['modelRequest'] as Record<string, unknown>
      const headers = (request['revisionHeaders'] as readonly number[]) ?? []
      const revision = Number(((record['commit'] as Record<string, unknown>)['revisionAfter']) ?? -1)
      return {
        revision,
        headers: [...headers],
        earlierStillPresent: headers.filter(header => header < revision),
      }
    })
    const routeWorked = errors.length === 0
    const evidenceComplete = routeWorked
      && surfaceRoute.available
      && surfaceIterations.length >= 10
      && distinctRevisions.length >= 10
      && allPreviousSnapshotsRemainVisible
      && modelRequestHashesMatchVisibleNodes
      && storeHoldsOneLatest
    const verdict = !evidenceComplete
      ? 'inconclusive'
      : growthIsMonotone && noReplacementAnywhere
        ? 'reproduced'
        : 'not-reproduced'

    const ledger = {
      experiment: 'E08-stable-injection-accumulation',
      question: 'When several content-different Stable Task State revisions are committed one after another, and one prompt assembly/step runs after each revision, do the OLD Stable snapshots keep accumulating through the runtime context, or are they replaced by a fixed slot / a surface replacement?',
      verdictRule: 'reproduced = after >= 10 content-different revisions (each followed by exactly one real step) the old snapshots stay visible on the Session surface AND are still present in every later model-visible request, while the injected node count / bytes / token-meter attribution grow with the revision count, no replacement event ever covers a previous snapshot, and the durable store still holds exactly one (latest) stable record. not-reproduced = every step sees only the newest snapshot (flat injection cost). inconclusive = the route could not produce the evidence (old snapshots are then NOT claimed visible). design-confirmed = static evidence only.',
      measurement: 'REAL TaskStateBasicService (ctx.plugin, deployment config), REAL task-state-prompt consumer, REAL renderTaskStateSnapshot/renderContextSnapshot/systemPrompt.assemble, REAL durable storage domain (Storage+StorageJson+StorageDomain under this E08 dir), REAL SessionStore/SystemPrompt/ToolRuntime/AgentRegistry/SessionProjectionRegistry/LlmRuntime/TokenMeter, REAL DSH AgentLoop 0.1.2-rc.1 imported from the audited DSH checkout (HEAD a66e4702). FAKE: the only LLM is a scripted adapter that answers task-state requests with candidate JSON and agent requests with text; it produces no provider usage, so provider tokens are NOT measured (only the meter heuristic).',
      baseline: {
        pluginCommit: 'cf034b4bce6141bb95b590f5ed7fa66f8727daa2',
        dshCommit: 'a66e4702',
        source: 'workspace-src',
      },
      command: 'pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E08-Stable注入累积/e08-stable-injection.spec.ts --reporter=verbose',
      components: {
        agentLoop: agentLoopModule,
        promptConsumer: {
          module: 'src/task-state-prompt.ts (ctx.plugin)',
          contributionName: 'task-state:snapshot',
          contributionOrder: 125,
          template: '{{task_state_snapshot}}',
          maxBytes: PROMPT_MAX_BYTES,
        },
        provider: { module: 'src/task-state-basic.ts (ctx.plugin)', config: CONFIG },
      },
      config: {
        ...CONFIG,
        promptMaxBytes: PROMPT_MAX_BYTES,
        revisionCount: REVISION_COUNT,
        seedsPerRevision: SEEDS_PER_REVISION,
        route: { provider: PROVIDER, model: MODEL, adapter: 'scripted fake (no provider usage)' },
        sessionId: String(SESSION_ID),
      },
      surfaceRoute,
      iterations,
      growth,
      earlierRevisionHeadersLiterallyInRequest,
      criteria: {
        fixedBeforeRun: true,
        routeWorked,
        surfaceIterations: surfaceIterations.length,
        distinctStableRevisions: distinctRevisions.length,
        revisions,
        allPreviousSnapshotsRemainVisible,
        modelRequestHashesMatchVisibleNodes,
        growthIsMonotone,
        noReplacementAnywhere,
        storeHoldsOneLatest,
        evidenceComplete,
        verdict,
      },
      finalStable: stableView(finalStable),
      storeFinal: readStore(),
      verdict,
      errors,
      limitations: [
        'fake LLM：唯一模型是脚本化 adapter，task-state 请求得到固定结构候选 JSON（内容含每次调用唯一标记），agent 请求得到一段文本；adapter 刻意不产出 `usage` 块，因此没有任何 provider token 数字进入 token-meter 的 baseline 锚点（ledger 记录 baselineKind）。真实摘要语义、真实上下文包络与真实计费量均未测量；token 数字来自真实 dsh-token-meter 的固定启发式定价。',
        '模型路由被替换：部署 route（deepseek-official/deepseek-v4-flash）下注册的是 fake adapter，不是真实 provider。',
        'DSH AgentLoop 0.1.2-rc.1 从被审计的 DSH checkout（HEAD a66e4702）构建产物 lib/index.js 以原生 ESM import() 载入；其依赖由该 checkout 自身解析。若该声明与 ledger.components.agentLoop.sha256 不一致，本实验的 surface 层证据不成立。',
        'steady-state：只测 12 个连续 revision、单 Session、单 route、单 provider 实例；未测真实用户会话的 revision 频率，也未测压缩（compaction）介入后的旧快照回收。',
        '未挂载任何压缩插件（DSH 官方 compaction / 本 bundle compaction-basic），因此本实验测到的是“注入累积在无压缩介入时的稳态成本”，不是“压缩后仍残留多少”。',
        '原始 seed 事件由 fixture 直接 append（20 个/轮）以跨过 minEvents=20 阈值；真实会话中这些事件来自人类与模型，数量与节奏不同。',
        '“通过”只表示 fixture 断言通过，不代表理想方案通过，也不代表用户现象存在或不存在；本实验只回答第 1 节那一个问题，且只覆盖 runtime-context 注入链路的单一分支。',
      ],
    }

    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    // ---- structural invariants (fixture ran as designed) ------------------
    expect(agentLoopModule.imported, agentLoopModule.mountError ?? 'AgentLoop import failed').toBe(true)
    expect(errors).toEqual([])
    expect(iterations.length).toBe(REVISION_COUNT)
    expect(surfaceIterations.length).toBe(REVISION_COUNT)
    expect(distinctRevisions.length).toBeGreaterThanOrEqual(10)
    expect(allPreviousSnapshotsRemainVisible).toBe(true)
    expect(modelRequestHashesMatchVisibleNodes).toBe(true)
    expect(noReplacementAnywhere).toBe(true)
    expect(storeHoldsOneLatest).toBe(true)
    expect(growthIsMonotone).toBe(true)
    expect(verdict).toBe('reproduced')
  }, TEST_TIMEOUT_MS)
})

/** Wait for the agent's next transition to idle. */
function waitForIdle(
  ctx: Context,
  agent: { readonly status: string },
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`agent did not return to idle within ${timeoutMs} ms (status ${agent.status})`))
    }, timeoutMs)
    const dispose = ctx.on('agent/status', (payload: { readonly agent?: unknown; readonly status?: unknown }) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })
}
