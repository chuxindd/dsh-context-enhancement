/**
 * Read-only durable task-state Service Definition (`ctx.taskState`): the
 * synchronous committed-pointer read of one Session's authoritative stable.
 * The MVP exposes no mutation, finalize, status, changed, or write method.
 * The sole MVP provider (`dsh-context-enhancement/task-state-basic`) publishes
 * the in-memory committed pointer; this module declares the service key, the
 * durable value schemas, and the audit vocabulary the provider's storage
 * domain obeys.
 *
 * The task-state family declares NO SessionEventMap members: the audit
 * vocabulary lives in the provider-owned storage domain (`sessions` +
 * `audit` tables), never in the Session log, so unloading task-state leaves
 * old Sessions fully readable by rc.1 code.
 * @module dsh-context-enhancement/internal/task-state/contract
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TaskStateBlockedVerdict, TaskStateSlotSource, TaskStateStable, TaskStateTerminalRecord } from './types.ts';
export { TaskStateEntryId, TaskStateRequestId } from './brand.ts';
export type * from './types.ts';
export { activeTerminalBlock, sameTerminalGeneration, taskStateBlockedVerdictSchema, taskStateCandidateEntrySchema, taskStateCandidateSchema, taskStateContinuationSchema, taskStateEntryIdSchema, taskStateEvidenceReferenceSchema, taskStateInheritedPrefixSchema, taskStateQuarantinedVerdictSchema, taskStateRecordSchema, taskStateRequestIdSchema, taskStateSessionIdentitySchema, taskStateStableContentSchema, taskStateStableEntrySchema, taskStateStableSchema, taskStateTerminalGenerationSchema, taskStateTerminalSchema, taskStateTodoReferenceSchema, terminalGeneration, } from './spec.ts';
export type { TaskStateJsonValue } from './spec.ts';
export { classifyAuditRow, deriveAuditTimeline, finishAuditRow, highestCertifiedRevision, openAuditRow, rowsForLifecycle, selectRepairRow, taskStateAuditSchema, } from './audit.ts';
export type { TaskStateAuditClassification, TaskStateAuditRecord, TaskStateAuditTimelineEntry, } from './audit.ts';
/** Message source kind of a plugin-owned model-visible Stable task-state slot node. */
export declare const TASK_STATE_SLOT_SOURCE_KIND = "task-state-slot";
/** Constant slot-channel identity recorded on every Stable task-state slot node. */
export declare const TASK_STATE_SLOT_ID = "task-state-stable-slot";
/** Default injection token budget I when maxTokens is omitted. */
export declare const DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS = 512;
/** Fixed model-visible marker displayed when the stable cursor lags session eligible high-water. */
export declare const TASK_STATE_STALE_MARKER = "[Task-state snapshot is stale; durable cursor lags eligible session events.]";
/**
 * Whether one durable message source identifies a Stable task-state slot node.
 *
 * The check reads only the logged source — the durable adoption key of a
 * resumed, forked, or re-mounted Session — and never process memory, so a
 * consumer that never mounted this plugin can still classify the node.
 * @param source - A logged `UserMessage['source']`.
 * @returns true when the source is a Stable task-state slot source.
 */
export declare function isTaskStateSlotSource(source: unknown): source is TaskStateSlotSource;
declare module '@deepseek-ai/cordis' {
    interface Context {
        /**
         * Read-only committed task-state pointers. The key is declared by the
         * task-state Service Definition so a provider mounts under it and prompt
         * consumers read it without depending on a provider package. The MVP
         * deliberately exposes no mutation or status surface.
         */
        taskState: TaskStateService;
    }
}
/**
 * The read-only task-state service (`ctx.taskState`). Providers publish each
 * live Session's committed stable pointer only after their authoritative
 * storage-domain put succeeds; reads are synchronous so prompt assembly never
 * performs storage I/O. A durable stable that does not match the current
 * Session lifecycle identity is never published.
 */
export declare abstract class TaskStateService extends Service {
    constructor(ctx: Context);
    /**
     * Read the current committed stable of one Session.
     * @param sessionId - logical Session identity whose stable should be read.
     * @returns the committed stable, or `undefined` when that Session lifecycle
     *   holds no committed stable (before the first successful commit or under
     *   an identity-mismatched record).
     */
    abstract getStable(sessionId: SessionId): TaskStateStable | undefined;
    /**
     * Read the durable terminal verdict of one Session: the typed provenance of a
     * window that could not be folded (a measured culprit, an oversized authority
     * fact, or a committed base that cannot be framed at all), or `undefined` when
     * that Session's lifecycle holds none.
     *
     * Added in B4.4 as a NON-abstract member so an alternate provider that only
     * serves committed stables keeps compiling and simply reports no verdict.
     * @param sessionId - logical Session identity whose verdict should be read.
     * @returns the stored terminal verdict, or `undefined` when none exists.
     */
    getTerminal(_sessionId: SessionId): TaskStateTerminalRecord | undefined;
    /**
     * Read the terminal BLOCK still in force for one Session, i.e. a stored block
     * verdict whose recorded generation still matches the current committed base,
     * filter version, and byte budget. It is `undefined` for a quarantine (which
     * never blocks) and for a block a later commit, manual replacement, or budget
     * change has already re-opened.
     * @param sessionId - logical Session identity whose block should be read.
     * @returns the active block, or `undefined` when the window is not blocked.
     */
    getActiveTerminalBlock(_sessionId: SessionId): TaskStateBlockedVerdict | undefined;
}
export default TaskStateService;
//# sourceMappingURL=index.d.ts.map