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
 * @module dsh-context-enhancement/internal/task-state/basic/worker
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TaskStateStable, TaskStateTruncationRecord } from '../contract/types.ts';
import type { TaskStateUpdateFinishedData, TaskStateUpdateRequestData } from '../contract/types.ts';
import { type TaskStateUpdateAttemptResult } from './update.ts';
import type { TaskStateBasicConfig, TaskStateBatchFailure, TaskStateFilteredEvent } from './types.ts';
/** Stable code marking a Session-disposal cancellation. */
export declare const SESSION_DISPOSED_ABORT_CODE = "task-state-basic/session-disposed";
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
    /** Id of the owning Session, for diagnostics. */
    private readonly sessionId;
    constructor(ctx: Context, session: Session, config: TaskStateBasicConfig, env: WorkerEnvironment);
    /** The Session identity this worker fences. */
    get id(): SessionId;
    /** Whether this worker still admits new batches. */
    get isOpen(): boolean;
    /**
     * Raise the pending eligible-event watermark and count one projectable
     * eligible event. Observer-only, synchronous. The provider forwards only
     * eligible events whose real filter projection is non-empty, so an event
     * that folds nothing never inflates the threshold.
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
     * Launch one batch cycle: snap the batch window at this instant, then
     * serialize the async request on the worker's single chain. The snapshot is
     * what makes events arriving during the request a LATER wave.
     */
    private launch;
    /** Decide what may legally follow one settled cycle (never called on a disposed worker). */
    private settleCycle;
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
    /** Exact provider-owned model route for every auxiliary request. */
    readonly route: {
        readonly provider: string;
        readonly model: string;
    };
    /** Resolve the live Session, or `undefined` once it left the store. */
    readonly liveSession: (sessionId: SessionId) => Session | undefined;
    /** Read the committed source cursor of one Session (-1 before the first commit). */
    readonly committedCursor: (sessionId: SessionId) => number;
    /** Read the committed base stable, or `null` before the first commit. */
    readonly readBase: (sessionId: SessionId) => TaskStateStable | null;
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