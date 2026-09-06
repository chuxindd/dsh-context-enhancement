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

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskStateStable } from './types.ts'

export { TaskStateEntryId, TaskStateRequestId } from './brand.ts'
export type * from './types.ts'
export {
  taskStateCandidateEntrySchema,
  taskStateCandidateSchema,
  taskStateContinuationSchema,
  taskStateEntryIdSchema,
  taskStateEvidenceReferenceSchema,
  taskStateRecordSchema,
  taskStateRequestIdSchema,
  taskStateSessionIdentitySchema,
  taskStateStableContentSchema,
  taskStateStableEntrySchema,
  taskStateStableSchema,
  taskStateTodoReferenceSchema,
} from './spec.ts'
export type { TaskStateJsonValue } from './spec.ts'
export {
  deriveAuditTimeline,
  finishAuditRow,
  highestCertifiedRevision,
  openAuditRow,
  rowsForLifecycle,
  selectRepairRow,
  taskStateAuditSchema,
} from './audit.ts'
export type {
  TaskStateAuditRecord,
  TaskStateAuditTimelineEntry,
} from './audit.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Read-only committed task-state pointers. The key is declared by the
     * task-state Service Definition so a provider mounts under it and prompt
     * consumers read it without depending on a provider package. The MVP
     * deliberately exposes no mutation or status surface.
     */
    taskState: TaskStateService
  }
}

/**
 * The read-only task-state service (`ctx.taskState`). Providers publish each
 * live Session's committed stable pointer only after their authoritative
 * storage-domain put succeeds; reads are synchronous so prompt assembly never
 * performs storage I/O. A durable stable that does not match the current
 * Session lifecycle identity is never published.
 */
export abstract class TaskStateService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'taskState')
  }

  /**
   * Read the current committed stable of one Session.
   * @param sessionId - logical Session identity whose stable should be read.
   * @returns the committed stable, or `undefined` when that Session lifecycle
   *   holds no committed stable (before the first successful commit or under
   *   an identity-mismatched record).
   */
  abstract getStable(sessionId: SessionId): TaskStateStable | undefined
}

export default TaskStateService
