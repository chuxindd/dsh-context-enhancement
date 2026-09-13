/**
 * E05 / E06 experiment fixture: a Stable Task State harness with full ledger
 * capture and NO production-code change.
 *
 * Composition
 * -----------
 * - REAL `Context` + `SessionStore` + `LlmRuntime` (the same plugin set the
 *   workspace's own `tests/task-state-worker.spec.ts` uses);
 * - REAL `TaskStateWorker` (production scheduler: threshold, single-flight,
 *   trailing, retry) and the REAL update/filter/host/render code paths;
 * - FAKE LLM: a scripted `LlmAdapter` that replays one fixed candidate JSON per
 *   request and records every request;
 * - FAKE worker environment: an in-memory stable store plus the exact
 *   `WorkerEnvironment` contract, so the harness can read the committed stable,
 *   the audit request/finished rows, and the counted eligible watermark;
 * - a TEMPORARY session only: no `$HOME/.dsh`, no storage backend, no DSH
 *   process, no port.
 *
 * Every ledger field required by 实验方案 §4.2 is captured here:
 * trigger, baseRevision, targetRevision, cursorBefore, windowEnd, includedSeqs,
 * goalRevision, todoSeq, candidateResult, stableRevisionAfter, cursorAfter,
 * injectedText (+hash), visibleInjectionNodes, staleByEligibleEvents.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  TaskStateStable,
  TaskStateUpdateFinishedData,
  TaskStateUpdateRequestData,
} from '../../../src/task-state.ts'
import { TaskStateWorker } from '../../../src/internal/task-state/basic/worker.ts'
import type { WorkerEnvironment } from '../../../src/internal/task-state/basic/worker.ts'
import type { TaskStateBasicConfig } from '../../../src/internal/task-state/basic/types.ts'
import { filterEvent, isEligibleType } from '../../../src/internal/task-state/basic/filter.ts'
import { renderTaskStateSnapshot } from '../../../src/internal/task-state/prompt/render.ts'

/** Surface operation used by every fixture append: plain append. */
export const SURFACE = { surfaceOp: 'append' as const }

/** Deployment-shaped config: the workspace baseline values (审计资料 20 §3 B7). */
export const BASELINE_CONFIG = {
  provider: 'current-route',
  model: 'current-model',
  minEvents: 20,
  maxEvents: 200,
  maxInputBytes: 60_000,
  maxOutputTokens: 4_000,
  timeoutMs: 120_000,
  maxInfraRetries: 2,
  maxEntriesPerKind: 16,
  maxEntryBytes: 2_000,
  maxListItems: 8,
} satisfies TaskStateBasicConfig

/** Adapter replaying one scripted candidate JSON text block per request. */
export class ScriptedAdapter extends LlmAdapter {
  /** Every `ctx.llm.stream()` call this adapter served, in order. */
  readonly requests: GenerateOptions[] = []
  private output: string

  constructor(output: string) {
    super()
    this.output = output
  }

  /** Replace the scripted output for every later request. */
  setOutput(output: string): void {
    this.output = output
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.output
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One captured worker cycle: everything 实验方案 §4.2 asks for. */
export interface CycleLedgerEntry {
  /** Monotonic index of this capture within the experiment. */
  readonly index: number
  /** Why the cycle ran: `threshold` (minEvents reached) or the harness's reason. */
  readonly trigger: string
  /** Base stable revision the request was built on (0 when there was no base). */
  readonly baseRevision: number
  /** Stable revision the request aimed to commit. */
  readonly targetRevision: number
  /** Committed cursor before the request. */
  readonly cursorBefore: number
  /** Sequence of the last event the worker had observed at launch. */
  readonly windowEnd: number
  /** Exact eligible sequences folded into this request. */
  readonly includedSeqs: readonly number[]
  /** Goal revision visible in the folded window, when a goal/change was folded. */
  readonly goalRevision: number | null
  /** Sequence of the folded `todo/write` event, when one was folded. */
  readonly todoSeq: number | null
  /** Sequence of the folded `todo/write` event with an EMPTY list, if any. */
  readonly todoClearSeq: number | null
  /** Outcome of the attempt as recorded in the finished audit row. */
  readonly candidateResult: string
  /** Committed stable revision after the cycle, or null when nothing committed. */
  readonly stableRevisionAfter: number | null
  /** Committed cursor after the cycle, or null when nothing committed. */
  readonly cursorAfter: number | null
  /** `todoReferences` carried by the committed stable after the cycle. */
  readonly todoReferencesAfter: readonly { readonly seq: number; readonly content: string }[]
  /** `currentObjective` carried by the committed stable after the cycle. */
  readonly objectiveAfter: string | null
  /** Rendered injection text of the committed stable (production renderer). */
  readonly injectedText: string | null
  /** FNV-1a hash of `injectedText`, for compact comparison. */
  readonly injectedTextHash: string | null
  /** Whether the injection text still contains the given marker strings. */
  readonly injectionContains: readonly string[]
  /** Eligible events above the committed cursor AFTER the cycle settled. */
  readonly staleByEligibleEvents: number
}

/** Mutable ledger holder the fixture writes and the spec reads. */
export interface TaskStateLedger {
  readonly cycles: CycleLedgerEntry[]
  /** Threshold schedules requested through `maybeSchedule()`. */
  thresholdRequests: number
  /** Times `maybeSchedule()` actually launched a batch. */
  launches: number
  /** Concatenated rendered injection texts, in commit order. */
  injectedTexts: string[]
}

/** Everything the spec needs to drive and inspect one fixture. */
export interface TaskStateFixture {
  readonly ctx: Context
  readonly session: Session
  readonly worker: TaskStateWorker
  readonly adapter: ScriptedAdapter
  readonly ledger: TaskStateLedger
  /** Latest committed stable, or null. */
  latest(): TaskStateStable | null
  /** Every committed stable, in commit order. */
  stables(): readonly TaskStateStable[]
  /** Eligible events above the committed cursor right now (real filter math). */
  eligibleAboveCursor(): number
  /** Render the latest stable exactly as the production injection does. */
  renderInjection(maxBytes?: number): string | null
  /** Append a direct human user/message and observe it, returning its seq. */
  appendUser(text: string): number
  /** Append a durable goal/change and observe it, returning its seq. */
  appendGoal(goal: {
    readonly id: string
    readonly revision: number
    readonly phase?: string
    readonly objective: string
  }): number
  /** Append a durable goal/change clear tombstone and observe it. */
  appendGoalClear(): number
  /** Append a durable todo/write and observe it, returning its seq. */
  appendTodo(todos: readonly { readonly content: string; readonly status: string }[]): number
  /** Ask the worker to schedule (production `maybeSchedule`). */
  schedule(): void
  /** Recompute + return the eligible count the worker would see. */
  pendingEligible(): number
  /** Wait until `predicate` holds or the timeout elapses. */
  waitUntil(predicate: () => boolean, timeoutMs?: number): Promise<void>
  /** Dispose the worker (closes admission, aborts, drains). */
  dispose(): Promise<void>
}

/** FNV-1a 32-bit hash of a string, hex encoded. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Marker strings the injection assertions look for. */
export interface InjectionMarkers {
  readonly mustContain: readonly string[]
}

/**
 * Build one isolated fixture. The session id is randomized so the in-memory
 * session store never collides between cases in one file.
 */
export async function createTaskStateFixture(options: {
  /** Scripted candidate JSON the fake model returns. */
  readonly output: string
  /** Config overrides; defaults are the deployment baseline. */
  readonly config?: Partial<TaskStateBasicConfig>
}): Promise<TaskStateFixture> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter(options.output)
  ctx.llm.registerAdapter(['current-route'], adapter)
  const session = ctx.sessions.create(SessionId(`experiment-${Math.random().toString(16).slice(2)}`))
  const config: TaskStateBasicConfig = { ...BASELINE_CONFIG, ...options.config }

  const stables: TaskStateStable[] = []
  const ledger: TaskStateLedger = { cycles: [], thresholdRequests: 0, launches: 0, injectedTexts: [] }
  /** Open audit rows by request id, so a finished row can be paired. */
  const open = new Map<string, TaskStateUpdateRequestData>()
  /** Marker strings that were true for the window folded by an open request. */
  const injectionMarkers = new Map<string, readonly string[]>()

  const committedCursor = (): number =>
    stables.length === 0 ? -1 : stables[stables.length - 1]!.sourceCursor

  const eligibleAboveCursor = (target: SessionId): number => {
    const live = ctx.sessions.get(target)
    if (live === undefined) return 0
    const cursor = committedCursor()
    let count = 0
    for (const event of live.snapshotEvents()) {
      if (event.seq <= cursor) continue
      if (!isEligibleType(event.type)) continue
      if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) continue
      count += 1
    }
    return count
  }

  const env: WorkerEnvironment = {
    system: 'update the task state',
    resolveRoute: () => ({ provider: 'current-route', model: 'current-model' }),
    liveSession: (id: SessionId) => ctx.sessions.get(id),
    committedCursor: (id: SessionId) => {
      void id
      return committedCursor()
    },
    readBase: (id: SessionId) => {
      void id
      return stables.length === 0 ? null : stables[stables.length - 1]!
    },
    eligibleCount: (id: SessionId) => eligibleAboveCursor(id),
    frame: (_id: SessionId, base: TaskStateStable | null, window: { readonly events: readonly unknown[] }) =>
      JSON.stringify({ base, events: window.events }),
    putOpenAudit: async (id: SessionId, data: TaskStateUpdateRequestData) => {
      void id
      open.set(data.requestId, data)
      ledger.launches += 1
    },
    putFinishedAudit: async (id: SessionId, finished: TaskStateUpdateFinishedData) => {
      void id
      const request = open.get(finished.requestId)
      open.delete(finished.requestId)
      const latest = stables.length === 0 ? null : stables[stables.length - 1]!
      const committed = finished.outcome === 'success'
        && latest !== null
        && latest.revision === finished.revision
        ? latest
        : null
      const injection = committed === null
        ? null
        : renderTaskStateSnapshot(committed, 8_000)
      if (injection !== null) ledger.injectedTexts.push(injection)
      const markers = injectionMarkers.get(finished.requestId) ?? []
      const includedSeqs = request?.includedSeqs ?? []
      ledger.cycles.push({
        index: ledger.cycles.length,
        trigger: 'threshold',
        baseRevision: request?.base?.revision ?? 0,
        targetRevision: finished.revision,
        cursorBefore: request?.base?.sourceCursor ?? -1,
        windowEnd: includedSeqs.length === 0 ? -1 : includedSeqs[includedSeqs.length - 1]!,
        includedSeqs: [...includedSeqs],
        goalRevision: goalRevisionOf(session, includedSeqs),
        todoSeq: todoSeqOf(session, includedSeqs, false),
        todoClearSeq: todoSeqOf(session, includedSeqs, true),
        candidateResult: finished.outcome,
        stableRevisionAfter: committed?.revision ?? null,
        cursorAfter: committed?.sourceCursor ?? null,
        todoReferencesAfter: committed === null ? [] : [...committed.todoReferences],
        objectiveAfter: committed === null ? null : committed.continuation.currentObjective,
        injectedText: injection,
        injectedTextHash: injection === null ? null : fnv1a(injection),
        injectionContains: markers.filter(marker => injection !== null && injection.includes(marker)),
        staleByEligibleEvents: eligibleAboveCursor(session.id),
      })
    },
    putStable: async (id: SessionId, stable: TaskStateStable) => {
      void id
      stables.push(stable)
    },
    onCommitted: () => { /* the in-memory row IS the pointer in this fixture */ },
    scheduleAuditRepair: async () => { /* audit repair is not exercised here */ },
  }

  const worker = new TaskStateWorker(ctx, session, config, env)

  const fixture: TaskStateFixture = {
    ctx,
    session,
    worker,
    adapter,
    ledger,
    latest: () => (stables.length === 0 ? null : stables[stables.length - 1]!),
    stables: () => [...stables],
    eligibleAboveCursor: () => eligibleAboveCursor(session.id),
    renderInjection: (maxBytes = 8_000) => {
      const stable = stables.length === 0 ? null : stables[stables.length - 1]!
      return stable === null ? null : renderTaskStateSnapshot(stable, maxBytes)
    },
    appendUser: (text: string) => {
      const seq = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }), SURFACE).seq
      worker.observe(seq)
      return seq
    },
    appendGoal: goal => {
      // `goal/change` is a LOG-ONLY event: it is surface-ineligible, so
      // `session.append` forbids a `surfaceOp` (SurfaceIntent is required on
      // message-producing events and forbidden on log-only events).
      const seq = session.append('goal/change', {
        operation: 'change',
        goal: {
          id: goal.id,
          revision: goal.revision,
          ...(goal.phase === undefined ? {} : { phase: goal.phase }),
          objective: goal.objective,
        },
        roundsStarted: 1,
      } as never).seq
      worker.observe(seq)
      return seq
    },
    appendGoalClear: () => {
      const seq = session.append('goal/change', { operation: 'clear' } as never).seq
      worker.observe(seq)
      return seq
    },
    appendTodo: todos => {
      const seq = session.append('todo/write', { todos: [...todos] } as never).seq
      worker.observe(seq)
      return seq
    },
    schedule: () => {
      ledger.thresholdRequests += 1
      worker.maybeSchedule()
    },
    pendingEligible: () => eligibleAboveCursor(session.id),
    waitUntil: (predicate: () => boolean, timeoutMs = 5_000) => waitUntil(predicate, timeoutMs),
    dispose: () => worker.dispose(),
  }

  return fixture
}

/** Goal revision visible in the folded window (null when no goal/change folded). */
function goalRevisionOf(session: Session, includedSeqs: readonly number[]): number | null {
  let revision: number | null = null
  for (const seq of includedSeqs) {
    const event = session.eventAt(seq as never)
    if (event?.type !== 'goal/change') continue
    const data = event.data as { goal?: { revision?: unknown } }
    const value = data.goal?.revision
    if (typeof value === 'number') revision = value
  }
  return revision
}

/** Sequence of the folded todo/write, optionally restricted to the EMPTY list. */
function todoSeqOf(
  session: Session,
  includedSeqs: readonly number[],
  emptyOnly: boolean,
): number | null {
  let found: number | null = null
  for (const seq of includedSeqs) {
    const event = session.eventAt(seq as never)
    if (event?.type !== 'todo/write') continue
    const data = event.data as { todos?: unknown }
    const isEmpty = Array.isArray(data.todos) && data.todos.length === 0
    if (emptyOnly !== isEmpty) continue
    found = seq
  }
  return found
}

/** Poll one predicate until it holds or the timeout elapses. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('fixture did not settle in time')
    await delay(5)
  }
}

/** Sleep helper. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One projected field bag read straight out of the production filter. */
export function projectedFields(
  session: Session,
  seq: number,
): Record<string, unknown> | null {
  const event = session.eventAt(seq as never)
  if (event === undefined) return null
  const filtered = filterEvent({ type: event.type, seq: event.seq, data: event.data })
  if (filtered === null) return null
  return filtered.event.fields as Record<string, unknown>
}

/** Sequence of the FIRST `todo/write` in a folded projection, or null. */
export function firstTodoWriteSeq(session: Session, seqs: readonly number[]): number | null {
  for (const seq of seqs) {
    if (session.eventAt(seq as never)?.type === 'todo/write') return seq
  }
  return null
}

/** Sequence of the LAST `todo/write` in a folded projection, or null. */
export function lastTodoWriteSeq(session: Session, seqs: readonly number[]): number | null {
  let found: number | null = null
  for (const seq of seqs) {
    if (session.eventAt(seq as never)?.type === 'todo/write') found = seq
  }
  return found
}

/**
 * Candidate JSON whose continuation names `objective` and which echoes exactly
 * the given todo reference (owner-of-the-list behaviour stays with the model).
 */
export function candidateEchoing(options: {
  readonly objective: string
  readonly focus?: string
  readonly todoSeq?: number | null
  readonly todoText?: string
  readonly facts?: readonly string[]
}): string {
  return JSON.stringify({
    facts: (options.facts ?? ['the harness echoed a durable window']).map(content => ({ content })),
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: options.todoSeq === undefined || options.todoSeq === null
      ? []
      : [{ seq: options.todoSeq, content: options.todoText ?? 'durable todo list' }],
    continuation: {
      currentObjective: options.objective,
      currentFocus: options.focus ?? 'observing the worker',
      openWork: [],
      nextActions: [],
    },
  })
}
