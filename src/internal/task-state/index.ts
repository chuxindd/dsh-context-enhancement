/**
 * Internal barrel of the task-state capability family.
 *
 * This path is NOT a published subpath; entries under `exports` are the public
 * surface (`./task-state`, `./task-state-basic`, `./task-state-prompt`).
 * @module dsh-context-enhancement/internal/task-state
 */

export * from './contract/index.ts'
export { TaskStateBasicService } from './basic/service.ts'
export type {
  TaskStateFilteredEvent,
  TaskStateBatchProjection,
  TaskStateHostNormalization,
  TaskStateBatchErrorCode,
  TaskStateBatchFailure,
} from './basic/types.ts'
export { TaskStateWorker, SESSION_DISPOSED_ABORT_CODE } from './basic/worker.ts'
export type { WorkerEnvironment, CycleOutcome } from './basic/worker.ts'
export { runUpdateAttempt, TASK_STATE_UPDATE_TIMEOUT_CODE } from './basic/update.ts'
export type {
  TaskStateUpdateAttempt,
  TaskStateUpdateHooks,
  TaskStateUpdateAttemptResult,
  TaskStateGenerateOptions,
} from './basic/update.ts'
export { foldBatchWindow } from './basic/batch.ts'
export type { FoldedBatchWindow, FoldedBatch, BatchWindowBudget } from './basic/batch.ts'
export {
  TASK_STATE_FILTER_VERSION,
  DEFAULT_FILTER_FIELD_LIMITS,
  filterEvent,
  isEligibleType,
  jsonBytes,
} from './basic/filter.ts'
export type {
  FilterFieldLimits,
  RawSessionEvent,
  FilteredEvent,
  FilterResult,
  FilterTruncation,
} from './basic/filter.ts'
export {
  TASK_STATE_INPUT_SCHEMA_VERSION,
  TASK_STATE_STABLE_SCHEMA_VERSION,
  TASK_STATE_SYSTEM_INSTRUCTION,
  frameProjection,
} from './basic/prompt.ts'
export { boundField, boundUtf8, MARKER_BYTES, TRUNCATION_MARKER } from './basic/bytes.ts'
export type { ByteBoundResult } from './basic/bytes.ts'
export { resolveTaskStateBasicConfig } from './basic/config.ts'
export {
  authorityUrgency,
  isAuthorityEventType,
  NO_GOAL_VIEW,
  NO_TODO_VIEW,
  resolveAuthorityViews,
  todoReferencesOf,
} from './basic/authority.ts'
export type {
  TaskStateAuthorityResolution,
  TaskStateAuthorityViewName,
} from './basic/authority.ts'
export { commitStable, digestOf, normalizeCandidate, parseCandidate } from './basic/host.ts'
export { renderTaskStateSnapshot, TASK_STATE_TRUNCATION_MARKER } from './prompt/render.ts'
