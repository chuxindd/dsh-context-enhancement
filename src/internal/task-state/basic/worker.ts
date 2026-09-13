/**
 * Per-Session background worker state for task-state-basic. One worker owns a
 * Session's whole single-flight schedule: it admits batches only while the
 * Session is live, folds an immutable batch window at the pending watermark
 * observed WHEN A CYCLE IS LAUNCHED, runs the auxiliary update outside the
 * observer stack, and after a threshold-triggered COMMIT runs AT MOST ONE
 * trailing batch for events that arrived while the request ran. Audit puts
 * are serialized per Session (a single worker per Session), and disposal
 * closes admission, aborts the active request, and prevents late append,
 * flush, or publish.
 *
 * Scheduling model (the "wave"): a threshold schedule launches one batch
 * cycle whose window is snapped at launch — events that arrive after the
 * launch only raise the pending watermark and become the next wave's input.
 * While any cycle runs, further threshold requests only raise a follow-up
 * flag. When a threshold cycle COMMITS, one trailing cycle may run for the
 * remaining eligible tail; a trailing cycle never cascades into another
 * trailing. A FAILED cycle never schedules anything on its own (no immediate
 * no-backoff re-run of the same deterministic window): the pending watermark
 * survives and the next legal activity — a later observe whose recomputed
 * eligible count again crosses `minEvents` — starts a fresh threshold wave
 * that re-folds from the previous committed cursor, so the tail is never
 * lost. Events arriving during a trailing commit are likewise preserved.
 *
 * An INFINITE WINDOW is the third, separate outcome of a fold, and it has TWO
 * measured causes that are never confused with each other:
 *
 * - A NON-EVENT cause — the committed base stable alone already exceeds the
 *   input budget, or the first projectable event is an AUTHORITY fact
 *   (`goal/change`, `todo/write`) too large to frame. Nothing may be blamed or
 *   skipped either way, so the window stays PENDING and the measured cause is
 *   recorded as ONE durable typed `block…` verdict carrying the generation it
 *   was measured against. The block suppresses re-folding (and re-paying for)
 *   the very same situation on every later wave and on every restart, while a
 *   changed base/filter/budget generation re-opens the window for a fresh
 *   measurement.
 * - An EVENT cause — the single first projectable event above the cursor is an
 *   ordinary fact that cannot fit even as the only event of the window. That ONE
 *   measured culprit sequence is quarantined and recorded as one durable
 *   terminal verdict on the same Session record, so restart never re-attempts or
 *   re-pays for it. The schedule then continues while the remaining backlog
 *   still reaches the threshold, and terminates because every quarantine
 *   strictly advances the cursor.
 *
 * A terminal verdict is durable whether or not the Session has committed a
 * stable: the record carries the verdict on its own, and no empty authority
 * stable is ever fabricated to hold it.
 *
 * ONE startup wave is admitted outside that event-driven path: a Session
 * runtime established by creation, domain open, or stored-record hydration
 * offers a single startup check, and when the projectable eligible backlog
 * above the committed cursor already meets `minEvents` the inherited tail is
 * folded without waiting for a new Session event. An `urgent` wave is admitted
 * when an observed AUTHORITY fact (a `goal/change` that changes the Goal view,
 * or any `todo/write` whole-list fact including the empty clear) must be folded
 * without waiting for `minEvents`, because the injected Goal/TODO views are
 * authoritative state and a stale one must not survive a whole threshold
 * window. The check runs once per worker and never races a wave already in
 * flight; every wave records why it was admitted (`startup`, `threshold`,
 * `urgent`, `trailing`, or `manual`) on its durable open audit row.
 * @module dsh-context-enhancement/internal/task-state/basic/worker
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  type TaskStateBlockedVerdict,
  type TaskStateStable,
  type TaskStateTerminalRecord,
  type TaskStateTruncationRecord,
  type TaskStateUpdateTrigger,
} from '../contract/types.ts'
// The branded request id is re-exported by `types.ts` as a TYPE only, so the
// value constructor is imported from its own module.
import { TaskStateRequestId } from '../contract/brand.ts'
import { terminalGeneration } from '../contract/spec.ts'
import type {
  TaskStateUpdateFinishedData,
  TaskStateUpdateRequestData,
} from '../contract/types.ts'
import { foldBatchWindow, type FoldedBatch } from './batch.ts'
import { TASK_STATE_FILTER_VERSION, filterEvent, isEligibleType } from './filter.ts'
import { isAuthorityEventType } from './authority.ts'
import { TASK_STATE_INPUT_SCHEMA_VERSION } from './prompt.ts'
import { sessionInheritedPrefix } from './inherited.ts'
import { runUpdateAttempt, type TaskStateUpdateAttempt, type TaskStateUpdateAttemptResult, type TaskStateUpdateHooks } from './update.ts'
import type { TaskStateBasicConfig, TaskStateBatchFailure, TaskStateFilteredEvent } from './types.ts'

/** Stable code marking a Session-disposal cancellation. */
export const SESSION_DISPOSED_ABORT_CODE = 'task-state-basic/session-disposed'

/**
 * Why one batch cycle launched. Every reason is recorded verbatim on the
 * durable open audit row, so a replay distinguishes a startup backlog wave
 * from a threshold wave, an urgent authority wave, and the single trailing
 * follow-up.
 */
export type BatchTrigger = Exclude<TaskStateUpdateTrigger, 'manual'>

/** The settled outcome of one owned batch cycle. */
export type CycleOutcome =
  | { readonly kind: 'committed'; readonly stable: TaskStateStable }
  | { readonly kind: 'failed'; readonly failure: TaskStateBatchFailure }
  | { readonly kind: 'noop' }

/** One durable terminal verdict as decided by the fold, before its attempt identity. */
type TerminalVerdictSeed =
  | {
    readonly kind: 'quarantined'
    readonly generation: TaskStateTerminalRecord['generation']
    readonly cursor: number
    readonly includedSeqs: readonly number[]
    readonly reason: string
  }
  | {
    readonly kind: 'blockBaseOverBudget' | 'blockAuthorityFact'
    readonly generation: TaskStateTerminalRecord['generation']
    readonly cursor: number
    readonly blockSeq?: number
    readonly blockType?: string
    readonly reason: string
  }

/** One per-Session worker's complete owned state. */
export class TaskStateWorker {
  private readonly minEvents: number
  private readonly maxEvents: number
  private readonly maxInputBytes: number
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number
  private readonly maxInfraRetries: number
  private readonly limits: { readonly maxEntriesPerKind: number; readonly maxEntryBytes: number; readonly maxListItems: number }
  private readonly system: string

  /** Admission open only while the Session lifecycle is live and not disposing. */
  private open = true
  /** Pending eligible-event watermark observed (highest eligible seq seen). */
  private pending = 0
  /** Number of projectable eligible events observed above the committed cursor (incremental). */
  private pendingEligible = 0
  /** Whether a batch cycle is currently running (single-flight guard). */
  private active = false
  /** Whether another threshold was requested while one was already running. */
  private followUpRequested = false
  /** The in-flight batch cycle's cancellation controller, if one is running. */
  private controller: AbortController | undefined
  /** Serialized chain: every scheduled batch cycle runs after the previous one. */
  private chain: Promise<void> = Promise.resolve()
  /** Whether this worker was disposed (closes admission permanently). */
  private disposed = false
  /**
   * Whether the one startup backlog check of this worker's lifetime already
   * ran. Set when a startup request is admitted AND when it is deferred into
   * an already-running wave, so the same backlog never starts a second startup
   * wave from repeated hydration or creation notifications.
   */
  private startupScheduled = false
  /**
   * Highest AUTHORITY sequence already admitted (or deferred into a running
   * wave) as an urgent request. An urgent request is idempotent per eligible
   * sequence, so neither a replayed observation nor a second scheduling caller
   * can fold the same authority fact twice.
   */
  private urgentThrough = -1
  /**
   * Authority sequence whose urgent request was DEFERRED into a running wave,
   * or `-1`. Only a sequence still above the committed cursor at settle time
   * makes the wave's follow-up urgent.
   */
  private urgentDeferredSeq = -1
  /** Whether the pending follow-up wave was requested by an authority fact. */
  private followUpUrgent = false
  /** Id of the owning Session, for diagnostics. */
  private readonly sessionId: SessionId

  /**
   * Highest eligible sequence already counted by the initial snapshot count,
   * or `-1` when no eligible event was counted (Session sequence numbering
   * starts at 0, so `-1` is the only safe "nothing counted" sentinel).
   * Observations at or below it are replays of events the seed already counted
   * (a resumed Session can be announced to the observer seam a second time),
   * and counting them again would inflate the backlog past the real one.
   */
  private countedThrough = -1

  /**
   * The Session's still-ACTIVE terminal block as of the last launch decision,
   * or `undefined`. Read from the durable record at construction (so a restart
   * inherits it) and re-read before every launch, because the provider
   * re-computes it whenever a verdict is written or a stable commits.
   */
  private block: TaskStateBlockedVerdict | undefined

  constructor(
    private readonly ctx: Context,
    session: Session,
    config: TaskStateBasicConfig,
    private readonly env: WorkerEnvironment,
  ) {
    this.sessionId = session.id
    this.minEvents = config.minEvents
    this.maxEvents = config.maxEvents
    this.maxInputBytes = config.maxInputBytes
    this.maxOutputTokens = config.maxOutputTokens
    this.timeoutMs = config.timeoutMs
    this.maxInfraRetries = config.maxInfraRetries
    this.limits = {
      maxEntriesPerKind: config.maxEntriesPerKind,
      maxEntryBytes: config.maxEntryBytes,
      maxListItems: config.maxListItems,
    }
    this.system = this.env.system
    // A resumed or seeded Session may already hold a log tail above its
    // committed cursor; the watermark starts at the last event so a later
    // threshold schedule folds the whole existing tail.
    const events = session.snapshotEvents()
    const last = events[events.length - 1]
    this.pending = last === undefined ? 0 : Number(last.seq)
    // One initial count of projectable eligible events above the committed
    // cursor (the environment answers with the real filter projection). The
    // boundary remembers how far that snapshot reached so a replayed
    // observation of the same events is never counted twice.
    this.pendingEligible = this.env.eligibleCount(this.sessionId)
    this.countedThrough = lastEligibleSeq(session.snapshotEvents())
    // A durable block inherited from an earlier process suppresses the very
    // same un-measurable situation: the worker must not re-fold (and never
    // re-pay for) a window whose non-event cause has not changed.
    this.block = this.env.activeBlock(this.sessionId)
  }

  /** The Session identity this worker fences. */
  get id(): SessionId {
    return this.sessionId
  }

  /** Whether this worker still admits new batches. */
  get isOpen(): boolean {
    return this.open && !this.disposed
  }

  /** Serialize one external mutation behind any admitted batch cycle. */
  enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error(SESSION_DISPOSED_ABORT_CODE))
    const result = this.chain.then(async () => {
      if (!this.isOpen) throw new Error(SESSION_DISPOSED_ABORT_CODE)
      return operation()
    })
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Raise the pending eligible-event watermark and count one projectable
   * eligible event. Observer-only, synchronous. The provider forwards only
   * eligible events whose real filter projection is non-empty, so an event
   * that folds nothing never inflates the threshold. An event at or below the
   * boundary the initial snapshot count already covered is a replay of a
   * counted event (a resumed Session may be announced twice) and is ignored, so
   * one backlog can never be counted twice.
   * @param seq - sequence of one newly observed projectable eligible Session event.
   */
  observe(seq: number): void {
    if (seq > this.pending) this.pending = seq
    if (seq <= this.countedThrough) return
    this.countedThrough = seq
    this.pendingEligible += 1
  }

  /** Recompute the pending eligible count from the real log and cursor. */
  private recomputeEligible(): void {
    this.pendingEligible = this.env.eligibleCount(this.sessionId)
    this.countedThrough = lastEligibleSeq(this.env.liveSession(this.sessionId)?.snapshotEvents() ?? [])
  }

  /**
   * Schedule a background collect-and-merge when the pending watermark grew
   * past the configured minimum projectable eligible events. Called outside
   * the observer stack; never performs append, flush, storage, or model work
   * inline. The schedule is idempotent: at most one batch starts at a time,
   * and a request while one runs only marks a follow-up.
   */
  maybeSchedule(): void {
    if (!this.isOpen) return
    if (this.pendingEligible < this.minEvents) return
    if (this.active) {
      this.followUpRequested = true
      return
    }
    this.launch('threshold')
  }

  /**
   * Offer the ONE startup backlog check of this worker's lifetime: when the
   * projectable eligible backlog above the committed cursor already meets
   * `minEvents`, admit a `startup` wave without waiting for a new Session
   * event. A resumed, reopened, or freshly hydrated Session therefore folds
   * the tail it inherited instead of serving a stale stable until the next
   * eligible event arrives.
   *
   * The check is isolated from the threshold path: it is admitted exactly
   * once per worker (a second hydration or creation notification for the same
   * backlog never starts a concurrent or duplicated startup wave), it never
   * launches on an empty or sub-threshold backlog, and it runs on the worker's
   * serialized chain — never inline on the caller's stack. A startup request
   * that arrives while another wave already runs is folded into that wave's
   * single legal follow-up instead of racing it.
   * @returns nothing; the wave is observed through the worker's commit hooks.
   */
  maybeScheduleStartup(): void {
    if (!this.isOpen || this.startupScheduled) return
    this.startupScheduled = true
    if (this.pendingEligible < this.minEvents) return
    if (this.active) {
      // One wave is already in flight over a backlog that reaches the
      // threshold, so the tail is being folded: offer the starter as that
      // wave's follow-up rather than stacking a second cycle on the chain.
      this.followUpRequested = true
      return
    }
    this.launch('startup')
  }

  /**
   * Admit an `urgent` wave for one observed AUTHORITATIVE fact — a
   * `goal/change` that changes the Goal view, or any `todo/write` whole-list
   * fact including the empty clear. The authoritative Goal/TODO views are part
   * of what the main model is injected, so waiting for `minEvents` ordinary
   * events would keep a superseded objective or a cleared list injected for up
   * to a full threshold window; an authority fact is folded as soon as it is
   * observed instead.
   *
   * Idempotence is per eligible sequence: the exact authority sequence that
   * already admitted (or deferred) an urgent request can never request a second
   * one, so a replayed observation of the same fact — or a second scheduling
   * caller for the same event — never folds that sequence concurrently or
   * twice. The wave itself is a normal single-flight cycle, so an urgent
   * request while a cycle runs only marks that cycle's follow-up; that
   * follow-up is admitted with the `urgent` trigger, which is how an authority
   * fact that arrives during a running wave still skips the threshold.
   * @param seq - sequence of the observed authority event.
   */
  maybeScheduleUrgent(seq: number): void {
    if (!this.isOpen) return
    if (seq <= this.urgentThrough) return
    // Nothing projectable is outstanding: the authority fact is already folded
    // (its revision is committed) and there is no window left to admit.
    if (this.pendingEligible < 1) return
    this.urgentThrough = seq
    if (this.active) {
      // The running wave's window is already snapped, so this fact is NOT part
      // of it: it stays outstanding for the single legal follow-up, which is
      // admitted with the `urgent` trigger.
      this.urgentDeferredSeq = seq
      this.followUpRequested = true
      this.followUpUrgent = true
      return
    }
    this.urgentDeferredSeq = -1
    this.launch('urgent')
  }

  /**
   * Launch one batch cycle: snap the batch window at this instant, then
   * serialize the async request on the worker's single chain. The snapshot is
   * what makes events arriving during the request a LATER wave.
   */
  private launch(kind: BatchTrigger): void {
    if (!this.isOpen || this.active) return
    // A still-active terminal block means the situation was already MEASURED and
    // its cause is not an event of the log: the base stable alone does not fit
    // the budget, or the first projectable fact is an authority fact that may
    // never be skipped. Nothing may be folded, blamed, or advanced, and the
    // verdict is already durable — so this is a skip, not a retry: no fold, no
    // model, no storage write, no repeated startup cost. The block lifts only
    // when its generation changes (a new base revision/digest, a manual edit, or
    // a changed byte budget), which the provider recomputes on every commit.
    this.block = this.env.activeBlock(this.sessionId)
    if (this.block !== undefined) {
      this.recomputeEligible()
      return
    }
    const windowEnd = this.pending
    const cursor = this.env.committedCursor(this.sessionId)
    const base = this.env.readBase(this.sessionId)
    const session = this.env.liveSession(this.sessionId)
    if (session === undefined) return
    // Empty or infeasible windows never launch a request. An infeasible window
    // (even the smallest meaningful projection exceeds the whole framed-input
    // budget) is a terminal budget failure that is logged and never retried by
    // this worker on its own.
    const folded = foldBatchWindow(session.snapshotEvents(), base, cursor, windowEnd, {
      maxEvents: this.maxEvents,
      maxInputBytes: this.maxInputBytes,
    })
    if (folded.kind === 'empty') {
      // No meaningful projectable event actually lies in the window. Nothing
      // to do; recompute so the incremental counter cannot keep a stale
      // threshold alive, then stop.
      this.recomputeEligible()
      return
    }
    if (folded.kind === 'infeasible') {
      this.active = true
      this.chain = this.chain.then(async () => {
        let advanced = false
        try {
          advanced = await this.handleInfeasible(kind, session, base, cursor, folded)
        } finally {
          this.active = false
        }
        // An infeasible window is not a commit, so `settleCycle` never sees it.
        // The quarantine path runs its own settle: only a REAL, measured cursor
        // advance may continue the schedule (see `settleQuarantine`).
        if (advanced) this.settleQuarantine()
      }).catch((error: unknown) => {
        this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker infeasible handle failed: ${String(error)}`)
      })
      return
    }
    this.active = true
    this.chain = this.chain.then(async () => {
      let outcome: CycleOutcome
      try {
        outcome = await this.performBatch(kind, folded.window)
      } catch (error: unknown) {
        // The cycle body reports its own structured failure through the update
        // result; reaching here is an unexpected scheduler-level rejection. It
        // must never be swallowed silently: log a structured diagnostic and
        // treat the cycle as failed so the pending watermark survives.
        this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker cycle rejected unexpectedly: ${String(error)}`)
        outcome = {
          kind: 'failed',
          failure: { stage: 'request', code: 'UNEXPECTED', message: `worker cycle rejected: ${String(error)}` },
        }
      } finally {
        this.active = false
      }
      this.settleCycle(kind, outcome)
    }).catch((error: unknown) => {
      // A rejection inside settleCycle must not poison the chain.
      this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker settle failed: ${String(error)}`)
    })
  }

  /** Decide what may legally follow one settled cycle (never called on a disposed worker). */
  private settleCycle(kind: BatchTrigger, outcome: CycleOutcome): void {
    if (!this.isOpen) return
    // Only a successful commit may schedule further work. A failed cycle never
    // auto-schedules (no immediate no-backoff re-run of the same deterministic
    // window); the follow-up flag and watermark survive for a later legal wave.
    if (outcome.kind !== 'committed') return

    // Whether a DEFERRED authority fact is still outstanding after this commit.
    // A deferred request names an exact eligible sequence, and the wave that
    // just settled may have folded it; only a fact still above the committed
    // cursor earns an urgent wave, so an ORDINARY tail left behind by an urgent
    // wave is never mislabelled `urgent` on its durable audit row.
    const deferredUrgentOutstanding = this.urgentDeferredSeq > outcome.stable.sourceCursor
    const urgentOutstanding = this.followUpUrgent && deferredUrgentOutstanding
    if (deferredUrgentOutstanding) this.urgentDeferredSeq = -1

    // A committed trailing or urgent cycle never cascades into another trailing
    // cycle. Events that arrived during it remain above the committed cursor:
    // when the projectable eligible tail again crosses the threshold, a fresh
    // threshold wave folds it; below the threshold it waits for later
    // activity, exactly like any sub-threshold accumulation.
    this.recomputeEligible()
    if (kind === 'trailing' || kind === 'urgent') {
      // An authority fact observed while this follow-up wave ran is still
      // urgent and must not wait for the threshold either, so it earns ONE
      // more urgent wave; any other tail below the threshold waits exactly
      // like a trailing wave's tail. Each wave still advances the cursor, so
      // this can only continue while real authority facts keep arriving.
      this.followUpUrgent = false
      if (this.pendingEligible >= this.minEvents) {
        this.launch('threshold')
        return
      }
      if (urgentOutstanding && this.pendingEligible >= 1) this.launch('urgent')
      return
    }
    // A committed startup or threshold cycle may yield exactly one trailing
    // cycle when a follow-up was requested while it ran or the commit left an
    // eligible tail. A startup request that was deferred into a running wave
    // is replaced by that single follow-up, which the wave's own commit
    // guarantees: what the commit leaves behind is either folded by the
    // trailing cycle or below the threshold and waits, so one backlog never
    // starts two startup waves. A follow-up that must fold an OUTSTANDING
    // authority fact is admitted with the `urgent` trigger instead of
    // `trailing`, so the durable audit row still records why it ran.
    this.followUpUrgent = false
    const wantTrailing = this.followUpRequested || this.pendingEligible >= this.minEvents
    this.followUpRequested = false
    if (wantTrailing && this.pendingEligible >= 1) this.launch(urgentOutstanding ? 'urgent' : 'trailing')
  }

  /**
   * Handle an infeasible batch window — the fold proved that no meaningful
   * window can be framed inside `maxInputBytes`. The caller must prove WHICH
   * cause applies before anything durable is written, because the two causes
   * have opposite consequences for the cursor:
   *
   * 1. The base stable ALONE already exceeds the budget. The previously
   *    committed stable — not the log — is the cause, so quarantining eligible
   *    events would discard facts and would not make progress either. A durable
   *    `blockBaseOverBudget` verdict is recorded: typed provenance naming the
   *    measured base bytes and the exact generation (base cursor/digest/filter
   *    version plus the byte budget) it was measured against. The cursor does
   *    NOT move, nothing is skipped, and the SAME situation is never re-folded
   *    again — while any change to that generation re-opens it.
   * 2. The FIRST projectable event above the cursor cannot fit even as the only
   *    event of the window. That single sequence is the MEASURED culprit, and it
   *    is the only thing the cursor may skip — unless it is an authority fact.
   * 3. That measured culprit is an authority fact (`goal/change`,
   *    `todo/write`). Authority Goal/TODO facts are never skipped: a durable
   *    `blockAuthorityFact` verdict records the typed reason (the sequence and
   *    its event type) and the generation, the cursor stays exactly where it
   *    was, and the fact stays PENDING.
   *
   * Every verdict is written durably BEFORE the diagnostic audit pair, and a
   * refused or failed write claims nothing: the durable state and the in-memory
   * pointer stay exactly as they were. The verdict never needs a committed
   * stable — a record carrying only identity and verdict is written when the
   * Session has not committed yet, and no empty stable is ever fabricated.
   * @returns whether the schedule may continue with the remaining backlog.
   */
  private async handleInfeasible(
    kind: BatchTrigger,
    session: Session,
    base: TaskStateStable | null,
    cursor: number,
    folded: Extract<FoldedBatch, { readonly kind: 'infeasible' }>,
  ): Promise<boolean> {
    if (!this.isOpen) return false
    // The generation every verdict below is measured against: the committed base
    // stable identity (or its absence) plus the configured byte budget. It is
    // what makes a block re-openable instead of a permanent ban.
    const generation = terminalGeneration(base, folded.maxInputBytes)
    // Cause 1: measure the frame the base stable alone already needs. The
    // provider's framing function is deterministic, so this is the exact same
    // measurement the fold made before it rejected the window.
    const baseOnlyBytes = Buffer.byteLength(this.env.frame(this.sessionId, base, {
      includedSeqs: [],
      sourceCursor: cursor,
      events: [],
      truncation: [],
      inputBytes: 0,
    }), 'utf8')
    if (baseOnlyBytes > folded.maxInputBytes) {
      const reason = `the committed stable alone frames ${baseOnlyBytes} bytes, above maxInputBytes `
        + `(${folded.maxInputBytes}); no eligible window can ever fit and no event is quarantined `
        + `(the base, not the log, is the measured cause)`
      this.ctx.logger.error(
        `task-state-basic: ${this.sessionId} ${reason}; recording a durable block and leaving the cursor at ${cursor}`,
      )
      const recorded = await this.recordVerdict(kind, base, cursor, {
        kind: 'blockBaseOverBudget',
        generation,
        cursor,
        reason,
      })
      this.recomputeEligible()
      return recorded
    }

    const events = session.snapshotEvents()
    let candidateEvent: { readonly seq: number; readonly type: string; readonly data: unknown } | undefined
    for (const event of events) {
      if (Number(event.seq) <= cursor) continue
      if (!isEligibleType(event.type)) continue
      if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) !== null) {
        candidateEvent = event
        break
      }
    }

    if (candidateEvent === undefined) {
      // Nothing projectable is outstanding: recompute so a stale incremental
      // count cannot keep a threshold alive, and claim nothing.
      this.recomputeEligible()
      return false
    }

    // Cause 3: an authority fact is never skipped or quarantined. Its Goal/TODO
    // replacement or clear must stay PENDING until it can be folded, so the
    // provider records the typed blocked reason and advances nothing.
    if (isAuthorityEventType(candidateEvent.type)) {
      const reason = `authority event seq ${candidateEvent.seq} (${candidateEvent.type}) exceeds `
        + `maxInputBytes (${folded.maxInputBytes}); authority facts cannot be quarantined and stay pending`
      this.ctx.logger.error(
        `task-state-basic: ${this.sessionId} ${reason}; recording a durable block and leaving the cursor at ${cursor}`,
      )
      const recorded = await this.recordVerdict(kind, base, cursor, {
        kind: 'blockAuthorityFact',
        generation,
        cursor,
        blockSeq: Number(candidateEvent.seq),
        blockType: candidateEvent.type,
        reason,
      })
      this.recomputeEligible()
      return recorded
    }

    // Cause 2: the measured culprit is exactly this first projectable sequence.
    // Every sequence between the committed cursor and it projects nothing, so a
    // cursor at the culprit skips that one measured event and nothing else.
    const quarantinedSeq = Number(candidateEvent.seq)
    const reason = `batch input (${folded.frameBytes} bytes) exceeds configured maxInputBytes `
      + `(${folded.maxInputBytes}) even after deterministic truncation`
    const recorded = await this.recordVerdict(kind, base, cursor, {
      kind: 'quarantined',
      generation,
      cursor: quarantinedSeq,
      includedSeqs: [quarantinedSeq],
      reason,
    })
    if (!recorded) {
      // Fail closed: no advance was recorded, so nothing may be claimed and the
      // window stays pending for a later legal wave. Nothing is retried here.
      this.recomputeEligible()
      return false
    }

    this.ctx.logger.warn(
      `task-state-basic: ${this.sessionId} quarantined infeasible event seq ${quarantinedSeq} `
      + `(${candidateEvent.type}): ${reason}`,
    )
    this.recomputeEligible()
    return true
  }

  /**
   * Record ONE durable terminal verdict, then its diagnostic ledger pair.
   *
   * The authority write comes FIRST: a verdict that is not durable must not be
   * reported anywhere, and a durable verdict always carries its own provenance
   * (request id, kind, generation, measured cursor/sequences, code, reason,
   * trigger). The audit pair is written only AFTER the authority put resolved,
   * because the audit table is a separate table and therefore a separate
   * whole-document write — a loss there is a diagnostic gap, never a state
   * claim, and no cross-table atomicity is assumed or claimed.
   * @returns whether the verdict became durable.
   */
  private async recordVerdict(
    kind: BatchTrigger,
    base: TaskStateStable | null,
    cursorFloor: number,
    verdict: TerminalVerdictSeed,
  ): Promise<boolean> {
    const requestId = TaskStateRequestId(`ts-terminal-${randomUUID()}`)
    const terminal: TaskStateTerminalRecord = {
      ...verdict,
      requestId,
      code: 'BUDGET',
      trigger: kind,
      time: Date.now(),
    }
    const failure: TaskStateBatchFailure = {
      stage: 'request',
      code: 'BUDGET',
      message: terminal.reason,
    }
    let recorded = false
    try {
      recorded = await this.env.putTerminal(this.sessionId, terminal)
    } catch (error: unknown) {
      this.ctx.logger.error(`task-state-basic: ${this.sessionId} terminal verdict record failed: ${String(error)}`)
    }
    if (!recorded) return false

    // Diagnostic ledger only, and only AFTER the authority advance exists: a
    // missing or rejected audit put is a diagnostic gap, never a state change.
    try {
      await this.env.putOpenAudit(this.sessionId, {
        requestId,
        revision: (base?.revision ?? 0) + 1,
        trigger: kind,
        base: base === null ? null : structuredClone(base),
        includedSeqs: terminal.kind === 'quarantined' ? [...terminal.includedSeqs] : [],
        filterVersion: TASK_STATE_FILTER_VERSION,
        system: this.system,
        route: this.env.resolveRoute(this.sessionId),
        maxTokens: 0,
        schema: { version: TASK_STATE_INPUT_SCHEMA_VERSION },
        truncation: [],
      })
      await this.env.putFinishedAudit(this.sessionId, {
        outcome: 'terminal-infeasible',
        requestId,
        revision: base?.revision ?? 0,
        sourceCursor: terminal.kind === 'quarantined' ? terminal.cursor : cursorFloor,
        error: failure,
      })
    } catch (error: unknown) {
      this.ctx.logger.error(
        `task-state-basic: ${this.sessionId} terminal verdict audit row failed (the verdict record stays authoritative): ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Decide what may legally follow one SETTLED quarantine. A quarantine
   * advanced the committed cursor by exactly one measured culprit sequence, so
   * the remaining backlog may be folded immediately: the schedule continues
   * while the backlog still reaches the threshold and terminates because every
   * step strictly advances the cursor.
   *
   * A BLOCK is not a quarantine: it advanced nothing. Continuing the schedule
   * for it is still correct and terminating — the very next launch reads the
   * active block, finds the same unchanged generation, and stops without a fold
   * — but it must never be described as backlog progress.
   *
   * The `urgent` follow-up is admitted only when a deferred authority fact is
   * still outstanding, so an ordinary tail is never mislabelled `urgent`.
   */
  private settleQuarantine(): void {
    if (!this.isOpen) return
    this.followUpRequested = false
    if (this.pendingEligible >= this.minEvents) {
      this.launch('threshold')
      return
    }
    if (this.followUpUrgent && this.pendingEligible >= 1) {
      this.followUpUrgent = false
      this.launch('urgent')
    }
  }

  /** Run one captured immutable batch window as an update cycle. */
  private async performBatch(trigger: BatchTrigger, window: {
    readonly includedSeqs: readonly number[]
    readonly sourceCursor: number
    readonly events: readonly TaskStateFilteredEvent[]
    readonly truncation: readonly TaskStateTruncationRecord[]
    readonly inputBytes: number
  }): Promise<CycleOutcome> {
    if (!this.isOpen) return { kind: 'noop' }
    const controller = new AbortController()
    this.controller = controller
    try {
      const session = this.env.liveSession(this.sessionId)
      if (session === undefined) return { kind: 'noop' }
      const base = this.env.readBase(this.sessionId)
      this.ctx.logger.debug(`task-state-basic: ${this.sessionId} batch over ${window.includedSeqs.length} eligible seqs`)
      const attempt: TaskStateUpdateAttempt = {
        ctx: this.ctx,
        route: this.env.resolveRoute(this.sessionId),
        base,
        projection: this.env.frame(this.sessionId, base, window),
        includedSeqs: window.includedSeqs,
        windowEvents: window.events,
        trigger,
        truncation: window.truncation,
        system: this.system,
        maxOutputTokens: this.maxOutputTokens,
        timeoutMs: this.timeoutMs,
        sessionId: this.sessionId,
        signal: controller.signal,
        limits: this.limits,
        // The inherited fork boundary of THIS lifecycle rides the attempt into
        // both durable places that describe one window: the committed stable and
        // the open-phase audit row. It is read from the live Session at dispatch
        // time (never from memory), so a resumed child reports the boundary its
        // own durable header states.
        inherited: sessionInheritedPrefix(session),
      }
      const result = await this.attemptWithRetry(attempt, controller)
      if (!result.ok) {
        // A candidate PARSE/SCHEMA/SEMANTIC failure is a model-OUTPUT failure,
        // not an infeasible window: the projection fitted the budget, only the
        // produced JSON was unusable. It is classified `transient-failure` by
        // the audit contract (eligible for a later retry), so it may NEVER
        // advance the cursor or quarantine the whole window — that would discard
        // every ordinary fact of a window whose input was perfectly processable.
        // The pending watermark and eligible count stay untouched so a later
        // legal wave re-folds from the same cursor.
        // A failed attempt already appended its structured finished audit event
        // (when the audit put itself could land). Nothing was committed, so no
        // repair is needed.
        return { kind: 'failed', failure: result.failure }
      }
      // A successful commit advanced the cursor. The authority put resolved, so
      // the cycle is committed even when the finished audit later failed (the
      // attempt classified that as an audit gap and the provider schedules a
      // repair credential that never reruns the model).
      if (result.auditGap) {
        try {
          await this.env.scheduleAuditRepair(this.sessionId, result.stable, String(result.requestId))
        } catch (error: unknown) {
          this.ctx.logger.error(`task-state-basic: ${this.sessionId} audit repair scheduling failed: ${String(error)}`)
        }
      }
      this.recomputeEligible()
      return { kind: 'committed', stable: result.stable }
    } finally {
      this.controller = undefined
    }
  }

  /** Run one update attempt with the bounded infrastructure-retry policy. */
  private async attemptWithRetry(
    attempt: TaskStateUpdateAttempt,
    controller: AbortController,
  ): Promise<TaskStateUpdateAttemptResult> {
    let last: TaskStateUpdateAttemptResult = {
      ok: false,
      failure: { stage: 'stream', code: 'UNEXPECTED', message: 'task-state update made no attempt' },
    }
    for (let attemptNumber = 0; attemptNumber <= this.maxInfraRetries; attemptNumber++) {
      if (!this.isOpen || controller.signal.aborted) {
        return { ok: false, failure: { stage: 'stream', code: 'ABORTED', message: 'task-state worker was disposed or cancelled' } }
      }
      const result = await runUpdateAttempt({ ...attempt, signal: controller.signal }, this.hooks())
      if (result.ok) return result
      last = result
      if (!isInfrastructureFailure(result.failure)) return result
      if (attemptNumber < this.maxInfraRetries) await backoffDelay(attemptNumber, controller.signal)
    }
    return last
  }

  /** The provider-owned storage/audit/publish boundary for one update. */
  private hooks(): TaskStateUpdateHooks {
    const id = this.sessionId
    return {
      putOpenAudit: async (data) => {
        if (this.isOpen) await this.env.putOpenAudit(id, data)
      },
      putFinishedAudit: data => this.env.putFinishedAudit(id, data),
      putStable: async (stable) => {
        if (!this.isOpen) throw new Error(SESSION_DISPOSED_ABORT_CODE)
        await this.env.putStable(id, stable)
      },
      onCommitted: (stable) => {
        if (this.isOpen) this.env.onCommitted(id, stable)
      },
    }
  }

  /**
   * Dispose this worker: close admission, abort cancellable work, and prevent
   * any late append, flush, or publish. An already successful put remains
   * authoritative for the next process load.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.open = false
    this.controller?.abort(new Error(SESSION_DISPOSED_ABORT_CODE))
    await this.chain
  }
}

/** The provider-owned environment one worker closes over. */
export interface WorkerEnvironment {
  /** Pinned model-visible system instruction. */
  readonly system: string
  /** Resolve one Session's latest model route when an auxiliary batch starts. */
  readonly resolveRoute: (sessionId: SessionId) => { readonly provider: string; readonly model: string }
  /** Resolve the live Session, or `undefined` once it left the store. */
  readonly liveSession: (sessionId: SessionId) => Session | undefined
  /** Read the committed source cursor of one Session (-1 before the first commit). */
  readonly committedCursor: (sessionId: SessionId) => number
  /** Read the committed base stable, or `null` before the first commit. */
  readonly readBase: (sessionId: SessionId) => TaskStateStable | null
  /**
   * Read the Session's effective committed cursor: the newest of the committed
   * stable's `sourceCursor` (absent before the first commit) and any durable
   * terminal verdict cursor. It is the floor a new verdict must be consistent
   * with, whether or not a stable exists.
   */
  readonly cursorFloor: (sessionId: SessionId) => number
  /**
   * Read the still-ACTIVE terminal block of one Session, or `undefined` when it
   * holds no block verdict or its stored generation no longer matches the
   * current base/filter/budget. An active block means the same un-measurable
   * situation was already recorded durably: the worker must skip it without a
   * fold, a model call, or another storage write.
   */
  readonly activeBlock: (sessionId: SessionId) => TaskStateBlockedVerdict | undefined
  /** Count PROJECTABLE eligible events above the committed cursor for one Session. */
  readonly eligibleCount: (sessionId: SessionId) => number
  /** Deterministically frame one batch window into model-visible text. */
  readonly frame: (
    sessionId: SessionId,
    base: TaskStateStable | null,
    window: {
      readonly includedSeqs: readonly number[]
      readonly sourceCursor: number
      readonly events: readonly TaskStateFilteredEvent[]
      readonly truncation: readonly TaskStateTruncationRecord[]
      readonly inputBytes: number
    },
  ) => string
  /** Put one open-phase audit row and await its durability. */
  readonly putOpenAudit: (sessionId: SessionId, data: TaskStateUpdateRequestData) => Promise<void>
  /** Put one finished-phase audit update and await its durability. */
  readonly putFinishedAudit: (sessionId: SessionId, data: TaskStateUpdateFinishedData) => Promise<void>
  /** The durable authority commit: replace one Session's stable record. */
  readonly putStable: (sessionId: SessionId, stable: TaskStateStable) => Promise<void>
  /**
   * Record ONE durable terminal verdict — a `quarantined` measured culprit, or
   * a `block…` verdict naming a measured cause that is not a log event — and
   * then its diagnostic audit pair. Resolves `true` only when the verdict really
   * became durable together with the committed state it describes; a refused or
   * failed write resolves `false` and MUST leave the durable state, the
   * effective cursor, and the in-memory pointer exactly as they were, so the
   * caller can fail closed instead of claiming a verdict it does not have.
   */
  readonly putTerminal: (sessionId: SessionId, terminal: TaskStateTerminalRecord) => Promise<boolean>
  /** Publish the committed pointer only after the authority put succeeds. */
  readonly onCommitted: (sessionId: SessionId, stable: TaskStateStable) => void
  /**
   * Arrange a live repair credential certifying a stable the authority put
   * already committed but whose finished audit could not be put durably. The
   * provider schedules this outside the observer stack; it never reruns the
   * model and never invents raw output.
   */
  readonly scheduleAuditRepair: (
    sessionId: SessionId,
    stable: TaskStateStable,
    requestId: string,
  ) => Promise<void>
}

/** Whether one failure is transient infrastructure (eligible for retry). */
function isInfrastructureFailure(failure: { readonly code: string }): boolean {
  return failure.code === 'TRANSIENT_LLM' || failure.code === 'TIMEOUT'
}

/** Deterministic bounded backoff between infrastructure attempts. */
async function backoffDelay(attemptNumber: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  const delayMs = Math.min(250 * 2 ** attemptNumber, 4_000)
  await new Promise<void>((resolve) => {
    const id = setTimeout(resolve, delayMs)
    signal.addEventListener('abort', () => {
      clearTimeout(id)
      resolve()
    }, { once: true })
  })
}

/**
 * Highest ELIGIBLE-TYPE sequence of one Session snapshot, used as the
 * already-counted boundary of the worker's initial backlog count. It reads
 * only the event type: the authoritative projectable count comes from the
 * environment's real filter, so this boundary never needs to project.
 * @param events - the Session's snapshot events.
 * @returns the highest eligible-type sequence, or -1 when there is none.
 */
function lastEligibleSeq(events: readonly { readonly type: string; readonly seq: number }[]): number {
  let highest = -1
  for (const event of events) {
    if (!isEligibleType(event.type)) continue
    const seq = Number(event.seq)
    if (seq > highest) highest = seq
  }
  return highest
}

export type { TaskStateUpdateAttemptResult }
