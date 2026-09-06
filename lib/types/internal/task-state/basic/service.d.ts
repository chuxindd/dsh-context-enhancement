/**
 * Basic durable task-state provider (`ctx.taskState`): the sole MVP owner of
 * the authoritative `context_enhancement_task_state` storage domain, the
 * published committed pointers, the versioned input filter, per-Session
 * background scheduling, independent auxiliary LLM calls, output validation,
 * private writes, and lifecycle. It subclasses the read-only Service
 * Definition; it never exposes a write, finalize, status, or changed method.
 *
 * Startup opens and validates the domain, then publishes each stored
 * lifecycle-matching stable directly — no model call, no history fold, no
 * unfinished-update replay. A damaged or incompatible domain fails activation
 * LOUDLY and puts the whole provider into a permanent disabled state: it
 * serves no stable pointer, installs no Session observers or workers, never
 * opens storage a second time, and never invokes a model to repair the
 * medium. Ordinary Sessions remain fully usable; they simply see
 * `getStable()` return `undefined`. Eligible events after a committed cursor
 * are processed later in the background when normal activity schedules the
 * per-Session worker.
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
import { TaskStateService, type TaskStateStable } from '../contract/index.ts';
import type { TaskStateBasicConfig } from './types.ts';
export type { TaskStateBasicConfig } from './types.ts';
export type { TaskStateFilteredEvent, TaskStateBatchProjection, TaskStateHostNormalization, TaskStateBatchErrorCode, TaskStateBatchFailure, } from './types.ts';
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
     * Count PROJECTABLE eligible events above the committed cursor for one
     * Session by running the real versioned filter over each event.
     */
    private eligibleEventCount;
    /** Put one open-phase audit row keyed by the request id. */
    private putOpenAudit;
    /** Put one finished-phase audit update on the request id's existing open row. */
    private putFinishedAudit;
    /** The authoritative commit: replace one Session's stable record. */
    private putStable;
    /** Publish the committed pointer only after the authority put resolved. */
    private publishCommitted;
    /** The published committed pointer, or `undefined`. */
    private publishedStable;
    /** Read the synchronous committed stable of one Session. */
    getStable(sessionId: SessionId): TaskStateStable | undefined;
}
export default TaskStateBasicService;
//# sourceMappingURL=service.d.ts.map