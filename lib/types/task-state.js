/**
 * dsh-context-enhancement — `./task-state` subpath.
 *
 * The read-only durable task-state Service Definition (`ctx.taskState`):
 * service key, durable value schemas, branded request/entry ids, and the
 * audit vocabulary — extracted from the reference prototype and adapted to a
 * standalone root package. This module exports the contract types and the
 * schemas so providers and prompt consumers share one durable vocabulary.
 *
 * The module declares NO SessionEventMap member: the audit vocabulary lives in
 * the provider's own storage domain, never in the Session log, so unloading
 * task-state leaves old Sessions fully readable by rc.1 code.
 *
 * @module dsh-context-enhancement/task-state
 */
export { TaskStateEntryId, TaskStateRequestId, } from "./internal/task-state/contract/index.js";
export { TaskStateService } from "./internal/task-state/contract/index.js";
export { activeTerminalBlock, sameTerminalGeneration, taskStateAuthorityStatusSchema, taskStateBlockedVerdictSchema, taskStateCandidateEntrySchema, taskStateCandidateSchema, taskStateContinuationSchema, taskStateEntryIdSchema, taskStateEvidenceReferenceSchema, taskStateGoalViewSchema, taskStateInheritedPrefixSchema, taskStateQuarantinedVerdictSchema, taskStateRecordSchema, taskStateRequestIdSchema, taskStateSessionIdentitySchema, taskStateStableContentSchema, taskStateStableEntrySchema, taskStateStableSchema, taskStateTerminalGenerationSchema, taskStateTerminalSchema, taskStateTodoReferenceSchema, taskStateTodoViewItemSchema, taskStateTodoViewSchema, terminalGeneration, } from "./internal/task-state/contract/spec.js";
export { classifyAuditRow, deriveAuditTimeline, finishAuditRow, highestCertifiedRevision, openAuditRow, rowsForLifecycle, selectRepairRow, } from "./internal/task-state/contract/audit.js";
import { TaskStateService } from "./internal/task-state/contract/index.js";
export default TaskStateService;
//# sourceMappingURL=task-state.js.map