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
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { type TaskStateBlockedVerdict, type TaskStateStable, type TaskStateTerminalRecord, type TaskStateTruncationRecord, type TaskStateUpdateTrigger } from '../contract/types.ts';
import type { TaskStateUpdateFinishedData, TaskStateUpdateRequestData } from '../contract/types.ts';
import { type TaskStateUpdateAttemptResult } from './update.ts';
import type { TaskStateBasicConfig, TaskStateBatchFailure, TaskStateFilteredEvent } from './types.ts';
/** Stable code marking a Session-disposal cancellation. */
export declare const SESSION_DISPOSED_ABORT_CODE = "task-state-basic/session-disposed";
/**
 * Why one batch cycle launched. Every reason is recorded verbatim on the
 * durable open audit row, so a replay distinguishes a startup backlog wave
 * from a threshold wave, an urgent authority wave, and the single trailing
 * follow-up.
 */
export type BatchTrigger = Exclude<TaskStateUpdateTrigger, 'manual'>;
/** The settled outcome of one owned batch cycle. */
export type CycleOutcome = {
    readonly kind: 'committed';
    readonly stable: TaskStateStable;
} | {
    readonly kind: 'failed';
    readonly failure: TaskStateBatchFailure;
} | {
    readonly kind: 'noop';
};
/** One per-Session worker's complete owned state. */
export declare class TaskStateWorker {
    private readonly ctx;
    private readonly env;
    private readonly minEvents;
    private readonly maxEvents;
    private readonly maxInputBytes;
    private readonly maxOutputTokens;
    private readonly timeoutMs;
    private readonly maxInfraRetries;
    private readonly limits;
    private readonly system;
    /** Admission open only while the Session lifecycle is live and not disposing. */
    private open;
    /** Pending eligible-event watermark observed (highest eligible seq seen). */
    private pending;
    /** Number of projectable eligible events observed above the committed cursor (incremental). */
    private pendingEligible;
    /** Whether a batch cycle is currently running (single-flight guard). */
    private active;
    /** Whether another threshold was requested while one was already running. */
    private followUpRequested;
    /** The in-flight batch cycle's cancellation controller, if one is running. */
    private controller;
    /** Serialized chain: every scheduled batch cycle runs after the previous one. */
    private chain;
    /** Whether this worker was disposed (closes admission permanently). */
    private disposed;
    /**
     * Whether the one startup backlog check of this worker's lifetime already
     * ran. Set when a startup request is admitted AND when it is deferred into
     * an already-running wave, so the same backlog never starts a second startup
     * wave from repeated hydration or creation notifications.
     */
    private startupScheduled;
    /**
     * Highest AUTHORITY sequence already admitted (or deferred into a running
     * wave) as an urgent request. An urgent request is idempotent per eligible
     * sequence, so neither a replayed observation nor a second scheduling caller
     * can fold the same authority fact twice.
     */
    private urgentThrough;
    /**
     * Authority sequence whose urgent request was DEFERRED into a running wave,
     * or `-1`. Only a sequence still above the committed cursor at settle time
     * makes the wave's follow-up urgent.
     */
    private urgentDeferredSeq;
    /** Whether the pending follow-up wave was requested by an authority fact. */
    private followUpUrgent;
    /** Id of the owning Session, for diagnostics. */
    private readonly sessionId;
    /**
     * Highest eligible sequence already counted by the initial snapshot count,
     * or `-1` when no eligible event was counted (Session sequence numbering
     * starts at 0, so `-1` is the only safe "nothing counted" sentinel).
     * Observations at or below it are replays of events the seed already counted
     * (a resumed Session can be announced to the observer seam a second time),
     * and counting them again would inflate the backlog past the real one.
     */
    private countedThrough;
    /**
     * The Session's still-ACTIVE terminal block as of the last launch decision,
     * or `undefined`. Read from the durable record at construction (so a restart
     * inherits it) and re-read before every launch, because the provider
     * re-computes it whenever a verdict is written or a stable commits.
     */
    private block;
    constructor(ctx: Context, session: Session, config: TaskStateBasicConfig, env: WorkerEnvironment);
    /** The Session identity this worker fences. */
    get id(): SessionId;
    /** Whether this worker still admits new batches. */
    get isOpen(): boolean;
    /** Serialize one external mutation behind any admitted batch cycle. */
    enqueueMutation<T>(operation: () => Promise<T>): Promise<T>;
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
    observe(seq: number): void;
    /** Recompute the pending eligible count from the real log and cursor. */
    private recomputeEligible;
    /**
     * Schedule a background collect-and-merge when the pending watermark grew
     * past the configured minimum projectable eligible events. Called outside
     * the observer stack; never performs append, flush, storage, or model work
     * inline. The schedule is idempotent: at most one batch starts at a time,
     * and a request while one runs only marks a follow-up.
     */
    maybeSchedule(): void;
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
    maybeScheduleStartup(): void;
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
    maybeScheduleUrgent(seq: number): void;
    /**
     * Launch one batch cycle: snap the batch window at this instant, then
     * serialize the async request on the worker's single chain. The snapshot is
     * what makes events arriving during the request a LATER wave.
     */
    private launch;
    /** Decide what may legally follow one settled cycle (never called on a disposed worker). */
    private settleCycle;
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
    private handleInfeasible;
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
    private recordVerdict;
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
    private settleQuarantine;
    /** Run one captured immutable batch window as an update cycle. */
    private performBatch;
    /** Run one update attempt with the bounded infrastructure-retry policy. */
    private attemptWithRetry;
    /** The provider-owned storage/audit/publish boundary for one update. */
    private hooks;
    /**
     * Dispose this worker: close admission, abort cancellable work, and prevent
     * any late append, flush, or publish. An already successful put remains
     * authoritative for the next process load.
     */
    dispose(): Promise<void>;
}
/** The provider-owned environment one worker closes over. */
export interface WorkerEnvironment {
    /** Pinned model-visible system instruction. */
    readonly system: string;
    /** Resolve one Session's latest model route when an auxiliary batch starts. */
    readonly resolveRoute: (sessionId: SessionId) => {
        readonly provider: string;
        readonly model: string;
    };
    /** Resolve the live Session, or `undefined` once it left the store. */
    readonly liveSession: (sessionId: SessionId) => Session | undefined;
    /** Read the committed source cursor of one Session (-1 before the first commit). */
    readonly committedCursor: (sessionId: SessionId) => number;
    /** Read the committed base stable, or `null` before the first commit. */
    readonly readBase: (sessionId: SessionId) => TaskStateStable | null;
    /**
     * Read the Session's effective committed cursor: the newest of the committed
     * stable's `sourceCursor` (absent before the first commit) and any durable
     * terminal verdict cursor. It is the floor a new verdict must be consistent
     * with, whether or not a stable exists.
     */
    readonly cursorFloor: (sessionId: SessionId) => number;
    /**
     * Read the still-ACTIVE terminal block of one Session, or `undefined` when it
     * holds no block verdict or its stored generation no longer matches the
     * current base/filter/budget. An active block means the same un-measurable
     * situation was already recorded durably: the worker must skip it without a
     * fold, a model call, or another storage write.
     */
    readonly activeBlock: (sessionId: SessionId) => TaskStateBlockedVerdict | undefined;
    /** Count PROJECTABLE eligible events above the committed cursor for one Session. */
    readonly eligibleCount: (sessionId: SessionId) => number;
    /** Deterministically frame one batch window into model-visible text. */
    readonly frame: (sessionId: SessionId, base: TaskStateStable | null, window: {
        readonly includedSeqs: readonly number[];
        readonly sourceCursor: number;
        readonly events: readonly TaskStateFilteredEvent[];
        readonly truncation: readonly TaskStateTruncationRecord[];
        readonly inputBytes: number;
    }) => string;
    /** Put one open-phase audit row and await its durability. */
    readonly putOpenAudit: (sessionId: SessionId, data: TaskStateUpdateRequestData) => Promise<void>;
    /** Put one finished-phase audit update and await its durability. */
    readonly putFinishedAudit: (sessionId: SessionId, data: TaskStateUpdateFinishedData) => Promise<void>;
    /** The durable authority commit: replace one Session's stable record. */
    readonly putStable: (sessionId: SessionId, stable: TaskStateStable) => Promise<void>;
    /**
     * Record ONE durable terminal verdict — a `quarantined` measured culprit, or
     * a `block…` verdict naming a measured cause that is not a log event — and
     * then its diagnostic audit pair. Resolves `true` only when the verdict really
     * became durable together with the committed state it describes; a refused or
     * failed write resolves `false` and MUST leave the durable state, the
     * effective cursor, and the in-memory pointer exactly as they were, so the
     * caller can fail closed instead of claiming a verdict it does not have.
     */
    readonly putTerminal: (sessionId: SessionId, terminal: TaskStateTerminalRecord) => Promise<boolean>;
    /** Publish the committed pointer only after the authority put succeeds. */
    readonly onCommitted: (sessionId: SessionId, stable: TaskStateStable) => void;
    /**
     * Arrange a live repair credential certifying a stable the authority put
     * already committed but whose finished audit could not be put durably. The
     * provider schedules this outside the observer stack; it never reruns the
     * model and never invents raw output.
     */
    readonly scheduleAuditRepair: (sessionId: SessionId, stable: TaskStateStable, requestId: string) => Promise<void>;
}
export type { TaskStateUpdateAttemptResult };
//# sourceMappingURL=worker.d.ts.map