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
import { Service } from '@deepseek-ai/cordis';
export { TaskStateEntryId, TaskStateRequestId } from "./brand.js";
export { taskStateCandidateEntrySchema, taskStateCandidateSchema, taskStateContinuationSchema, taskStateEntryIdSchema, taskStateEvidenceReferenceSchema, taskStateRecordSchema, taskStateRequestIdSchema, taskStateSessionIdentitySchema, taskStateStableContentSchema, taskStateStableEntrySchema, taskStateStableSchema, taskStateTodoReferenceSchema, } from "./spec.js";
export { deriveAuditTimeline, finishAuditRow, highestCertifiedRevision, openAuditRow, rowsForLifecycle, selectRepairRow, taskStateAuditSchema, } from "./audit.js";
/**
 * The read-only task-state service (`ctx.taskState`). Providers publish each
 * live Session's committed stable pointer only after their authoritative
 * storage-domain put succeeds; reads are synchronous so prompt assembly never
 * performs storage I/O. A durable stable that does not match the current
 * Session lifecycle identity is never published.
 */
export class TaskStateService extends Service {
    constructor(ctx) {
        super(ctx, 'taskState');
    }
}
export default TaskStateService;
//# sourceMappingURL=index.js.map