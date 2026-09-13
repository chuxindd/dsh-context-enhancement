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

export {
  TaskStateEntryId,
  TaskStateRequestId,
} from './internal/task-state/contract/index.ts'
export { TaskStateService } from './internal/task-state/contract/index.ts'
export type {
  TaskStateAuthorityStatus,
  TaskStateEntryKind,
  TaskStateCandidate,
  TaskStateCandidateContent,
  TaskStateCandidateEntry,
  TaskStateContinuation,
  TaskStateContentFields,
  TaskStateEvidenceReference,
  TaskStateGoalView,
  TaskStateInheritedPrefix,
  TaskStateRecord,
  TaskStateSessionIdentity,
  TaskStateStable,
  TaskStateStableContent,
  TaskStateStableEntry,
  TaskStateTodoReference,
  TaskStateTodoView,
  TaskStateTodoViewItem,
  TaskStateAuxRoute,
  TaskStateSchemaEvidence,
  TaskStateTruncationRecord,
  TaskStateUpdateRequestData,
  TaskStateUpdateTrigger,
  TaskStateFailureStage,
  TaskStateFailureFacts,
  TaskStateUpdateFinishedData,
  TaskStateTerminalRecord,
  TaskStateTerminalCode,
  TaskStateTerminalGeneration,
  TaskStateQuarantinedVerdict,
  TaskStateBlockedVerdict,
} from './internal/task-state/contract/types.ts'
export {
  activeTerminalBlock,
  sameTerminalGeneration,
  taskStateAuthorityStatusSchema,
  taskStateBlockedVerdictSchema,
  taskStateCandidateEntrySchema,
  taskStateCandidateSchema,
  taskStateContinuationSchema,
  taskStateEntryIdSchema,
  taskStateEvidenceReferenceSchema,
  taskStateGoalViewSchema,
  taskStateInheritedPrefixSchema,
  taskStateQuarantinedVerdictSchema,
  taskStateRecordSchema,
  taskStateRequestIdSchema,
  taskStateSessionIdentitySchema,
  taskStateStableContentSchema,
  taskStateStableEntrySchema,
  taskStateStableSchema,
  taskStateTerminalGenerationSchema,
  taskStateTerminalSchema,
  taskStateTodoReferenceSchema,
  taskStateTodoViewItemSchema,
  taskStateTodoViewSchema,
  terminalGeneration,
} from './internal/task-state/contract/spec.ts'
export type { TaskStateJsonValue } from './internal/task-state/contract/spec.ts'
export {
  classifyAuditRow,
  deriveAuditTimeline,
  finishAuditRow,
  highestCertifiedRevision,
  openAuditRow,
  rowsForLifecycle,
  selectRepairRow,
} from './internal/task-state/contract/audit.ts'
export type {
  TaskStateAuditClassification,
  TaskStateAuditRecord,
  TaskStateAuditTimelineEntry,
} from './internal/task-state/contract/audit.ts'

import { TaskStateService } from './internal/task-state/contract/index.ts'
export default TaskStateService

