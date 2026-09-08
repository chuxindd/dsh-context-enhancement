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
import { foldBatchWindow } from "./batch.js";
import { runUpdateAttempt } from "./update.js";
/** Stable code marking a Session-disposal cancellation. */
export const SESSION_DISPOSED_ABORT_CODE = 'task-state-basic/session-disposed';
/** One per-Session worker's complete owned state. */
export class TaskStateWorker {
    ctx;
    env;
    minEvents;
    maxEvents;
    maxInputBytes;
    maxOutputTokens;
    timeoutMs;
    maxInfraRetries;
    limits;
    system;
    /** Admission open only while the Session lifecycle is live and not disposing. */
    open = true;
    /** Pending eligible-event watermark observed (highest eligible seq seen). */
    pending = 0;
    /** Number of projectable eligible events observed above the committed cursor (incremental). */
    pendingEligible = 0;
    /** Whether a batch cycle is currently running (single-flight guard). */
    active = false;
    /** Whether another threshold was requested while one was already running. */
    followUpRequested = false;
    /** The in-flight batch cycle's cancellation controller, if one is running. */
    controller;
    /** Serialized chain: every scheduled batch cycle runs after the previous one. */
    chain = Promise.resolve();
    /** Whether this worker was disposed (closes admission permanently). */
    disposed = false;
    /** Id of the owning Session, for diagnostics. */
    sessionId;
    constructor(ctx, session, config, env) {
        this.ctx = ctx;
        this.env = env;
        this.sessionId = session.id;
        this.minEvents = config.minEvents;
        this.maxEvents = config.maxEvents;
        this.maxInputBytes = config.maxInputBytes;
        this.maxOutputTokens = config.maxOutputTokens;
        this.timeoutMs = config.timeoutMs;
        this.maxInfraRetries = config.maxInfraRetries;
        this.limits = {
            maxEntriesPerKind: config.maxEntriesPerKind,
            maxEntryBytes: config.maxEntryBytes,
            maxListItems: config.maxListItems,
        };
        this.system = this.env.system;
        // A resumed or seeded Session may already hold a log tail above its
        // committed cursor; the watermark starts at the last event so a later
        // threshold schedule folds the whole existing tail.
        const events = session.snapshotEvents();
        const last = events[events.length - 1];
        this.pending = last === undefined ? 0 : Number(last.seq);
        // One initial count of projectable eligible events above the committed
        // cursor (the environment answers with the real filter projection).
        this.pendingEligible = this.env.eligibleCount(this.sessionId);
    }
    /** The Session identity this worker fences. */
    get id() {
        return this.sessionId;
    }
    /** Whether this worker still admits new batches. */
    get isOpen() {
        return this.open && !this.disposed;
    }
    /** Serialize one external mutation behind any admitted batch cycle. */
    enqueueMutation(operation) {
        if (!this.isOpen)
            return Promise.reject(new Error(SESSION_DISPOSED_ABORT_CODE));
        const result = this.chain.then(async () => {
            if (!this.isOpen)
                throw new Error(SESSION_DISPOSED_ABORT_CODE);
            return operation();
        });
        this.chain = result.then(() => undefined, () => undefined);
        return result;
    }
    /**
     * Raise the pending eligible-event watermark and count one projectable
     * eligible event. Observer-only, synchronous. The provider forwards only
     * eligible events whose real filter projection is non-empty, so an event
     * that folds nothing never inflates the threshold.
     * @param seq - sequence of one newly observed projectable eligible Session event.
     */
    observe(seq) {
        if (seq > this.pending)
            this.pending = seq;
        this.pendingEligible += 1;
    }
    /** Recompute the pending eligible count from the real log and cursor. */
    recomputeEligible() {
        this.pendingEligible = this.env.eligibleCount(this.sessionId);
    }
    /**
     * Schedule a background collect-and-merge when the pending watermark grew
     * past the configured minimum projectable eligible events. Called outside
     * the observer stack; never performs append, flush, storage, or model work
     * inline. The schedule is idempotent: at most one batch starts at a time,
     * and a request while one runs only marks a follow-up.
     */
    maybeSchedule() {
        if (!this.isOpen)
            return;
        if (this.pendingEligible < this.minEvents)
            return;
        if (this.active) {
            this.followUpRequested = true;
            return;
        }
        this.launch('threshold');
    }
    /**
     * Launch one batch cycle: snap the batch window at this instant, then
     * serialize the async request on the worker's single chain. The snapshot is
     * what makes events arriving during the request a LATER wave.
     */
    launch(kind) {
        if (!this.isOpen || this.active)
            return;
        const windowEnd = this.pending;
        const cursor = this.env.committedCursor(this.sessionId);
        const base = this.env.readBase(this.sessionId);
        const session = this.env.liveSession(this.sessionId);
        if (session === undefined)
            return;
        // Empty or infeasible windows never launch a request. An infeasible window
        // (even the smallest meaningful projection exceeds the whole framed-input
        // budget) is a terminal budget failure that is logged and never retried by
        // this worker on its own.
        const folded = foldBatchWindow(session.snapshotEvents(), base, cursor, windowEnd, {
            maxEvents: this.maxEvents,
            maxInputBytes: this.maxInputBytes,
        });
        if (folded.kind === 'empty') {
            // No meaningful projectable event actually lies in the window. Nothing
            // to do; recompute so the incremental counter cannot keep a stale
            // threshold alive, then stop.
            this.recomputeEligible();
            return;
        }
        if (folded.kind === 'infeasible') {
            const failure = {
                stage: 'request',
                code: 'BUDGET',
                message: `task-state-basic: batch input (${folded.frameBytes} bytes) exceeds the configured maxInputBytes (${folded.maxInputBytes}) even after deterministic truncation`,
            };
            this.ctx.logger.error(`task-state-basic: ${this.sessionId} ${failure.message}`);
            this.recomputeEligible();
            return;
        }
        this.active = true;
        this.chain = this.chain.then(async () => {
            let outcome;
            try {
                outcome = await this.performBatch(folded.window);
            }
            catch (error) {
                // The cycle body reports its own structured failure through the update
                // result; reaching here is an unexpected scheduler-level rejection. It
                // must never be swallowed silently: log a structured diagnostic and
                // treat the cycle as failed so the pending watermark survives.
                this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker cycle rejected unexpectedly: ${String(error)}`);
                outcome = {
                    kind: 'failed',
                    failure: { stage: 'request', code: 'UNEXPECTED', message: `worker cycle rejected: ${String(error)}` },
                };
            }
            finally {
                this.active = false;
            }
            this.settleCycle(kind, outcome);
        }).catch((error) => {
            // A rejection inside settleCycle must not poison the chain.
            this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker settle failed: ${String(error)}`);
        });
    }
    /** Decide what may legally follow one settled cycle (never called on a disposed worker). */
    settleCycle(kind, outcome) {
        if (!this.isOpen)
            return;
        // Only a successful commit may schedule further work. A failed cycle never
        // auto-schedules (no immediate no-backoff re-run of the same deterministic
        // window); the follow-up flag and watermark survive for a later legal wave.
        if (outcome.kind !== 'committed')
            return;
        // A committed trailing cycle never cascades into another trailing cycle.
        // Events that arrived during it remain above the committed cursor: when
        // the projectable eligible tail again crosses the threshold, a fresh
        // threshold wave folds it; below the threshold it waits for later
        // activity, exactly like any sub-threshold accumulation.
        this.recomputeEligible();
        if (kind === 'trailing') {
            if (this.pendingEligible >= this.minEvents)
                this.launch('threshold');
            return;
        }
        // A committed threshold cycle may yield exactly one trailing cycle when a
        // follow-up was requested while it ran or the commit left an eligible tail.
        const wantTrailing = this.followUpRequested || this.pendingEligible >= this.minEvents;
        this.followUpRequested = false;
        if (wantTrailing && this.pendingEligible >= 1)
            this.launch('trailing');
    }
    /** Run one captured immutable batch window as an update cycle. */
    async performBatch(window) {
        if (!this.isOpen)
            return { kind: 'noop' };
        const controller = new AbortController();
        this.controller = controller;
        try {
            const session = this.env.liveSession(this.sessionId);
            if (session === undefined)
                return { kind: 'noop' };
            const base = this.env.readBase(this.sessionId);
            this.ctx.logger.debug(`task-state-basic: ${this.sessionId} batch over ${window.includedSeqs.length} eligible seqs`);
            const attempt = {
                ctx: this.ctx,
                route: this.env.resolveRoute(this.sessionId),
                base,
                projection: this.env.frame(this.sessionId, base, window),
                includedSeqs: window.includedSeqs,
                truncation: window.truncation,
                system: this.system,
                maxOutputTokens: this.maxOutputTokens,
                timeoutMs: this.timeoutMs,
                sessionId: this.sessionId,
                signal: controller.signal,
                limits: this.limits,
            };
            const result = await this.attemptWithRetry(attempt, controller);
            if (!result.ok) {
                // A failed attempt already appended its structured finished audit event
                // (when the audit put itself could land). The pending watermark and
                // eligible count stay untouched so a later legal wave re-folds from the
                // same cursor; nothing was committed, so no repair is needed.
                return { kind: 'failed', failure: result.failure };
            }
            // A successful commit advanced the cursor. The authority put resolved, so
            // the cycle is committed even when the finished audit later failed (the
            // attempt classified that as an audit gap and the provider schedules a
            // repair credential that never reruns the model).
            if (result.auditGap) {
                try {
                    await this.env.scheduleAuditRepair(this.sessionId, result.stable, String(result.requestId));
                }
                catch (error) {
                    this.ctx.logger.error(`task-state-basic: ${this.sessionId} audit repair scheduling failed: ${String(error)}`);
                }
            }
            this.recomputeEligible();
            return { kind: 'committed', stable: result.stable };
        }
        finally {
            this.controller = undefined;
        }
    }
    /** Run one update attempt with the bounded infrastructure-retry policy. */
    async attemptWithRetry(attempt, controller) {
        let last = {
            ok: false,
            failure: { stage: 'stream', code: 'UNEXPECTED', message: 'task-state update made no attempt' },
        };
        for (let attemptNumber = 0; attemptNumber <= this.maxInfraRetries; attemptNumber++) {
            if (!this.isOpen || controller.signal.aborted) {
                return { ok: false, failure: { stage: 'stream', code: 'ABORTED', message: 'task-state worker was disposed or cancelled' } };
            }
            const result = await runUpdateAttempt({ ...attempt, signal: controller.signal }, this.hooks());
            if (result.ok)
                return result;
            last = result;
            if (!isInfrastructureFailure(result.failure))
                return result;
            if (attemptNumber < this.maxInfraRetries)
                await backoffDelay(attemptNumber, controller.signal);
        }
        return last;
    }
    /** The provider-owned storage/audit/publish boundary for one update. */
    hooks() {
        const id = this.sessionId;
        return {
            putOpenAudit: async (data) => {
                if (this.isOpen)
                    await this.env.putOpenAudit(id, data);
            },
            putFinishedAudit: data => this.env.putFinishedAudit(id, data),
            putStable: async (stable) => {
                if (!this.isOpen)
                    throw new Error(SESSION_DISPOSED_ABORT_CODE);
                await this.env.putStable(id, stable);
            },
            onCommitted: (stable) => {
                if (this.isOpen)
                    this.env.onCommitted(id, stable);
            },
        };
    }
    /**
     * Dispose this worker: close admission, abort cancellable work, and prevent
     * any late append, flush, or publish. An already successful put remains
     * authoritative for the next process load.
     */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.open = false;
        this.controller?.abort(new Error(SESSION_DISPOSED_ABORT_CODE));
        await this.chain;
    }
}
/** Whether one failure is transient infrastructure (eligible for retry). */
function isInfrastructureFailure(failure) {
    return failure.code === 'TRANSIENT_LLM' || failure.code === 'TIMEOUT';
}
/** Deterministic bounded backoff between infrastructure attempts. */
async function backoffDelay(attemptNumber, signal) {
    if (signal.aborted)
        return;
    const delayMs = Math.min(250 * 2 ** attemptNumber, 4_000);
    await new Promise((resolve) => {
        const id = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => {
            clearTimeout(id);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=worker.js.map