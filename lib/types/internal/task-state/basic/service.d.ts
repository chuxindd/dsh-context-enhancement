/**
 * Basic durable task-state provider (`ctx.taskState`): the sole MVP owner of
 * the authoritative `context_enhancement_task_state` storage domain, the
 * published committed pointers, the versioned input filter, per-Session
 * background scheduling, independent auxiliary LLM calls, output validation,
 * private writes, and lifecycle. It subclasses the read-only Service
 * Definition; its plugin-owned control Remote may invoke the provider's
 * revision-checked `editStable` method without widening `ctx.taskState` for
 * ordinary consumers.
 *
 * Startup opens and validates the domain, then publishes each stored
 * lifecycle-matching stable directly — no model call, no history fold, no
 * unfinished-update replay. A damaged or incompatible domain fails activation
 * LOUDLY and puts the whole provider into a permanent disabled state: it
 * serves no stable pointer, installs no Session observers or workers, never
 * opens storage a second time, and never invokes a model to repair the
 * medium. Ordinary Sessions remain fully usable; they simply see
 * `getStable()` return `undefined`. Eligible events after a committed cursor
 * are folded in the background: normal activity schedules the per-Session
 * worker, and establishing a runtime (creation, domain open, or stored-record
 * hydration) additionally offers ONE startup backlog check, which folds an
 * inherited tail that already meets `minEvents` without waiting for a new
 * event. Recovery itself never folds, never replays an unfinished update, and
 * never calls a model — the recovered stable is published first and any
 * backlog revision is committed afterwards by its own scheduled wave.
 *
 * The plugin declares NO SessionEventMap members: the audit vocabulary lives
 * in this provider's own storage domain (`sessions` + `audit` tables), never
 * in the Session log, so unloading task-state leaves old Sessions readable
 * and reloadable by rc.1 code.
 * @module dsh-context-enhancement/internal/task-state/basic/service
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { TaskStateService, type TaskStateBlockedVerdict, type TaskStateRecord, type TaskStateStable, type TaskStateTerminalRecord } from '../contract/index.ts';
import type { TaskStateBasicConfig, TaskStateCommittedListener } from './types.ts';
import type { TaskStateEditRequest, TaskStateEditResult } from '../control/types.ts';
export type { TaskStateBasicConfig } from './types.ts';
export type { TaskStateFilteredEvent, TaskStateBatchProjection, TaskStateHostNormalization, TaskStateBatchErrorCode, TaskStateBatchFailure, } from './types.ts';
export type { TaskStateCommittedListener } from './types.ts';
/**
 * The basic task-state provider service. A host-level plugin (not agent- or
 * preset-scoped): it opens ONE process-global domain and serves every Session
 * in the overlay.
 */
export declare class TaskStateBasicService extends TaskStateService {
    static inject: string[];
    /** Required deployment policy; every field is explicit from the composition. */
    static Config: z<TaskStateBasicConfig>;
    private readonly config;
    private sessionsTable?;
    private auditTable?;
    private readonly runtimes;
    /** Startup audit repairs that disposal must drain before closing the domain. */
    private readonly repairs;
    /** Admission closes at plugin disposal; workers reject new batches then. */
    private admissionOpen;
    /** Set when the domain failed to open: the provider serves nothing further. */
    private disabled;
    /** Registered committed-stable observers, notified after each authority put. */
    private readonly committedListeners;
    /**
     * @param ctx - host context carrying storage-domain, sessions, and llm.
     * @param config - validated required deployment policy.
     */
    constructor(ctx: Context, config: TaskStateBasicConfig);
    /** Open the authoritative domain, seed committed pointers, and install lifecycle. */
    protected [Service.init](): Promise<void>;
    /** Track one audit repair so provider disposal observes and drains it. */
    private trackRepair;
    /** Drain every repair admitted before provider disposal closed admission. */
    private drainRepairs;
    /** Append a repair credential when the log has not certified the stored stable. */
    private scheduleRepair;
    /**
     * Reconcile one Session's durable audit against its committed sessions-table
     * stable: when the stable's revision exceeds every certified revision, fill
     * the matching open audit row with a repair credential (never rerunning the
     * model, never inventing raw output).
     */
    private reconcileRepair;
    /**
     * Live-repair one just-committed stable whose finished audit did not become
     * durable: fill that exact request's open row. The operation is tracked so
     * disposal cannot close the domain while repair is pending.
     */
    private scheduleAuditRepair;
    /** Finish only the exact row that is still open for this lifecycle and commit. */
    private finishOpenAudit;
    /** One runtime for a live Session: identity-fenced record + single worker. */
    private runtimeFor;
    /** Install creation/event/disposal observers that drive the workers. */
    private installLifecycle;
    /** The lifecycle-matching stored record, or `undefined` (absent or mismatched). */
    private recordFor;
    /**
     * Read the effective committed cursor for one Session: the newest of the
     * committed stable's `sourceCursor` (absent before the first commit) and the
     * durable terminal verdict's cursor. A verdict therefore never has to be
     * carried by a stable, and a stable never silently discards one.
     *
     * The result is always fenced against the Session's own-event boundary, so a
     * forked child can never fold (or report coverage of) its inherited prefix:
     * see {@link fenceCursor}.
     */
    private effectiveCursor;
    /**
     * Fence one stored coverage claim against the LIVE own-event boundary of its
     * Session lifecycle.
     *
     * Below the boundary nothing may be claimed: those sequences are the parent's
     * facts, delivered to this lifecycle as history. A claim that contradicts the
     * live boundary is refused as a whole and the lifecycle re-derives from its own
     * events above the boundary, which is the conservative direction — the content
     * is still served, while no unverifiable coverage is trusted. Every lifecycle
     * that did not begin on an inherited prefix floors at `-1`, so its cursor is
     * exactly what it was before this contract existed.
     */
    private fenceCursor;
    /**
     * Emit one best-effort lifecycle diagnostic. A warning must never fail a read,
     * a commit, or a startup path, and a throwing logger must not escape.
     */
    private warnDiagnostic;
    /**
     * The generation of one Session's CURRENT measurable situation: the committed
     * base stable (revision identity, cursor, digest, and filter version) together
     * with the configured framed-input budget. A terminal verdict stores the
     * generation it was measured against, so this is what decides whether the
     * window must be re-opened.
     */
    private currentGeneration;
    /**
     * Recompute one runtime's ACTIVE terminal block from its durable verdict.
     * Called after a verdict write and after every commit, because a commit
     * changes the base generation and therefore re-opens a blocked window.
     */
    private refreshTerminalBlock;
    /**
     * The still-active block of one Session, or `undefined` when its verdict is a
     * quarantine or its generation no longer matches. The provider reads the
     * durable record for a runtime it does not own, so a Session hydrated later
     * still answers with its own stored, generation-fenced block.
     */
    private activeTerminalBlock;
    /**
     * Count PROJECTABLE eligible events above the committed cursor for one
     * Session by running the real versioned filter over each event.
     */
    private eligibleEventCount;
    /** Put one open-phase audit row keyed by the request id. */
    private putOpenAudit;
    /** Put one finished-phase audit update on the request id's existing open row. */
    private putFinishedAudit;
    /**
     * The authoritative commit: replace one Session's stable record.
     *
     * The durable terminal verdict — when the lifecycle holds one — is carried
     * forward VERBATIM inside the same record put, so a commit can neither
     * resurrect a quarantined window nor lose the typed reason why a blocked one
     * is blocked. The verdict keeps its own stored generation: a commit changes
     * the current generation, so the next decision about that window is a
     * re-evaluation against the NEW base rather than an inherited ban.
     */
    private putStable;
    /**
     * Persist ONE durable terminal verdict.
     *
     * The write carries the lifecycle identity, the untouched committed stable
     * WHEN one exists, and the verdict — all inside ONE record put, because one
     * `KvTable.put` is the only atomic durable boundary this storage contract
     * offers (per-table puts are separate whole-document rewrites). The effective
     * cursor (`max(stable?.sourceCursor ?? -1, terminal.cursor)`) therefore can
     * never advance without its provenance, and a rejected or failed put changes
     * neither the medium nor the in-memory pointer.
     *
     * `stable` is NOT required: a verdict is recorded just as durably before the
     * Session's first commit, so an impossible window no longer has to stall
     * forever. It NEVER manufactures a stable — the record simply carries none.
     *
     * Admission is monotone:
     * - a `quarantined` verdict must strictly advance the effective cursor past
     *   the floor it was measured against, so a quarantine can never be a no-op
     *   and can never move the cursor backwards;
     * - a `block…` verdict must name the CURRENT generation. It records the
     *   typed reason why the pending window stays pending, so a restart does not
     *   re-fold (and never re-pays for) a window whose cause is unchanged, while
     *   a changed base/filter/budget re-opens it. A block that would restate the
     *   verdict already stored for the same generation is refused, so a blocked
     *   window cannot churn the medium.
     *
     * Single-writer contract: this is a read-modify-write on the JSON domain's
     * single unit and there is NO record-level compare-and-swap (B1 is
     * `blocked-upstream`), so it is only safe while one process writes the
     * domain. It never claims CAS.
     * @param session - the live Session whose record is written.
     * @param terminal - the terminal verdict to record.
     * @returns whether the verdict became durable (and therefore took effect).
     */
    private putTerminal;
    /** Publish the committed pointer only after the authority put resolved. */
    private publishCommitted;
    /** Announce one published or recovered stable to every committed observer. */
    private notifyCommitted;
    /**
     * Observe every committed stable after its authority put resolved, plus the
     * stable recovered from storage when a runtime first seeds it. The listener
     * receives the Session identity and the committed stable; live audit repairs
     * never publish (they certify an already-published stable), so an observer
     * sees exactly the values that advanced the published pointer — including
     * the startup/reconnect recovery that advances it from nothing to a durable
     * stable, which is how an already-open remote stream hydrates a Session
     * whose baseline was read before the seed.
     *
     * The subscription is caller-owned: the returned disposer removes this
     * listener and must be run by the caller's teardown. The provider unload
     * additionally clears every remaining subscription so a disposed provider
     * never notifies. This is a minimal observer seam for Host-side consumers
     * (remote streams); it never writes the Session log and never changes the
     * storage authority or the lifecycle fence.
     * @param listener - committed-stable observer to add.
     * @returns a disposer removing this listener.
     */
    subscribeCommitted(listener: TaskStateCommittedListener): () => void;
    /** Replace the user-editable stable content under optimistic revision control. */
    editStable(request: TaskStateEditRequest): Promise<TaskStateEditResult>;
    /** Validate, bound-check, and identity-map user-authored stable fields. */
    private resolveManualContent;
    /** The published committed pointer, or `undefined`. */
    private publishedStable;
    /** Read the synchronous committed stable of one Session. */
    getStable(sessionId: SessionId): TaskStateStable | undefined;
    /**
     * Read the synchronous durable terminal verdict of one Session, if present:
     * a `quarantined` culprit window or a `block…` verdict naming a measured
     * cause that is not a log event (an oversized base stable, or an authority
     * fact that may never be skipped).
     */
    getTerminal(sessionId: SessionId): TaskStateTerminalRecord | undefined;
    /**
     * Read the terminal BLOCK of one Session that still applies to the current
     * base/filter/budget generation, or `undefined`. A quarantine never blocks,
     * and a block whose generation changed is already re-openable.
     */
    getActiveTerminalBlock(sessionId: SessionId): TaskStateBlockedVerdict | undefined;
    /**
     * Read the whole durable record of one Session, if present. The record may
     * carry a terminal verdict without any committed stable (an impossible
     * window before the first commit), which is why `stable` is optional.
     */
    getRecord(sessionId: SessionId): TaskStateRecord | undefined;
}
export default TaskStateBasicService;
//# sourceMappingURL=service.d.ts.map