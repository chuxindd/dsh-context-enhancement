/**
 * Durable audit vocabulary of one task-state update, plus pure derivation
 * helpers for keyless tests and startup repair reconciliation.
 *
 * Audit design: ONE audit row per auxiliary request, keyed by the Host-minted
 * request id, in the provider's `audit` table. A row is written in two
 * phases — the OPEN phase carries the complete pre-dispatch request evidence
 * and is put durably BEFORE the model is dispatched; the FINISHED phase
 * (success, failure, manual, or repair) later fills the same row. The authoritative
 * committed stable lives in the `sessions` table; the audit table exists only
 * for auxiliary-call reconstruction, diagnostics, and replay and never
 * becomes a second authority. There is no cross-table atomicity assumption:
 * an open row may survive without a finished phase after a crash, and startup
 * reconciliation fills only the row that actually committed.
 *
 * A committed stable ALWAYS has its open row: the open put is awaited before
 * dispatch, and the sessions-table put follows dispatch, so a process that
 * committed must first have made its open row durable. Repair therefore
 * never needs a requestless credential — it certifies the existing open row
 * whose target revision equals the committed revision and which still lacks a
 * finished phase.
 *
 * The audit table is a plain storage-domain table — NOT Session events — so
 * no SessionEventMap member is declared and unloading task-state leaves every
 * old Session log readable by rc.1 code.
 * @module dsh-context-enhancement/internal/task-state/contract/audit
 */

import { z } from 'zod'
import type { TaskStateRequestId } from './brand.ts'
import type {
  TaskStateSessionIdentity,
  TaskStateUpdateFinishedData,
  TaskStateUpdateRequestData,
} from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nonEmptyTrimmed = z.string().min(1).refine(value => value.trim() === value, {
  message: 'must be non-empty and have no surrounding whitespace',
})

/** A permissive stable-envelope view used only to validate a restored open row. */
const stableEnvelopeSchema = z.object({
  schemaVersion: nonNegativeSafeInteger,
  revision: nonNegativeSafeInteger,
  filterVersion: nonEmptyTrimmed,
  sourceCursor: nonNegativeSafeInteger,
  digest: nonEmptyTrimmed,
})

/**
 * Durable open-phase schema. Permissive enough that an independently written
 * row still opens while gross corruption of the medium is caught by the JSON
 * parse and this schema. The full candidate schema is NOT reapplied here:
 * rows are schema-validated at the moment they are written, and the audit
 * table is diagnostic-only — the `sessions` table is the authority.
 */
export const taskStateAuditOpenSchema = z.object({
  requestId: nonEmptyTrimmed,
  time: nonNegativeSafeInteger,
  session: z.object({
    createdAt: nonNegativeSafeInteger,
    cwd: z.string().optional(),
  }),
  request: z.object({
    requestId: nonEmptyTrimmed,
    revision: nonNegativeSafeInteger,
    base: stableEnvelopeSchema.nullable(),
    includedSeqs: z.array(nonNegativeSafeInteger),
    filterVersion: nonEmptyTrimmed,
    system: z.string(),
    route: z.object({
      provider: nonEmptyTrimmed,
      model: nonEmptyTrimmed,
      reasoningEffort: z.string().optional(),
    }),
    maxTokens: nonNegativeSafeInteger,
    schema: z.object({
      version: nonNegativeSafeInteger,
      material: z.unknown().optional(),
    }),
    truncation: z.array(z.object({
      path: z.string(),
      limitBytes: nonNegativeSafeInteger,
      keptBytes: nonNegativeSafeInteger,
    })).default([]),
  }),
})

/** One permissive finished-phase view used to validate a restored row. */
export const taskStateAuditFinishedSchema = z.object({
  outcome: z.enum(['success', 'failure', 'manual', 'repair']),
  requestId: z.string().optional(),
  revision: nonNegativeSafeInteger.optional(),
  sourceCursor: nonNegativeSafeInteger.optional(),
  llmStreamCall: z.boolean().optional(),
  rawOutput: z.array(z.unknown()).optional(),
  usage: z.unknown().optional(),
  finish: z.unknown().optional(),
  error: z.object({
    stage: z.string(),
    code: z.string(),
    message: z.string(),
  }).optional(),
})

/**
 * One durable audit row of one auxiliary request. The row is keyed by
 * `requestId`; `finished` is absent while the request is open (or after a
 * crash between the open put and the finished put).
 */
export interface TaskStateAuditRecord {
  /** Branded Host-minted request id; equals the row key. */
  readonly requestId: TaskStateRequestId
  /** Epoch milliseconds when the open phase was written (row order). */
  readonly time: number
  /** Session lifecycle identity this audit row is fenced to. */
  readonly session: TaskStateSessionIdentity
  /** The complete pre-dispatch request evidence (the open phase). */
  readonly request: TaskStateUpdateRequestData
  /** The finished phase, when the request settled. */
  readonly finished?: TaskStateUpdateFinishedData
}

/** Whole-row schema used by the storage domain to validate the audit table. */
export const taskStateAuditSchema = taskStateAuditOpenSchema.extend({
  finished: taskStateAuditFinishedSchema.optional(),
}).strict() as unknown as z.ZodType<TaskStateAuditRecord>

/**
 * Build the durable open-phase row of one request.
 * @param requestId - branded request id (the row key).
 * @param session - lifecycle identity the row is fenced to.
 * @param request - complete pre-dispatch request evidence.
 * @param time - open-phase write time (defaults to now).
 * @returns the row value to put under `requestId`.
 */
export function openAuditRow(
  requestId: TaskStateRequestId,
  session: TaskStateSessionIdentity,
  request: TaskStateUpdateRequestData,
  time = Date.now(),
): TaskStateAuditRecord {
  return { requestId, time, session, request }
}

/**
 * Build the finished-phase update of one audit row. The row key (`requestId`)
 * and the open phase stay untouched; only an open row accepts a finished phase.
 * A settled row is immutable, so a stale repair cannot replace success evidence.
 * @param row - the durable open row being settled.
 * @param finished - the finished phase to attach.
 * @returns the replacement row value.
 */
export function finishAuditRow(
  row: TaskStateAuditRecord,
  finished: TaskStateUpdateFinishedData,
): TaskStateAuditRecord {
  if (row.finished === undefined) return { ...row, finished }
  // A repair is provisional evidence for a crash gap. If the original
  // finished success arrives later, preserve its complete replay evidence.
  if (row.finished.outcome === 'repair' && finished.outcome === 'success') {
    return { ...row, finished }
  }
  return row
}

/** The resolved per-request view a keyless replay test can read. */
export interface TaskStateAuditTimelineEntry {
  /** Branded request id. */
  readonly requestId: string
  /** Epoch ms of the open phase. */
  readonly time: number
  /** The open-phase request evidence. */
  readonly request: TaskStateUpdateRequestData
  /** The finished phase, when the request settled; `undefined` while open. */
  readonly finished: TaskStateUpdateFinishedData | undefined
  /** Whether a model, manual, or repair finished phase certifies a commit. */
  readonly certified: boolean
  /** Revision the finished phase certifies, when `certified`. */
  readonly certifiedRevision: number | undefined
}

/**
 * Pure derivation: project audit rows of one lifecycle into a deterministic,
 * time-ascending per-request timeline. Keyless tests read committed stable
 * provenance through this helper; the provider's repair reconciliation uses
 * the same ordering rules.
 * @param rows - audit records (already lifecycle-filtered by the caller).
 * @returns the timeline, ascending by `time` then lexicographic request id.
 */
export function deriveAuditTimeline(rows: readonly TaskStateAuditRecord[]): TaskStateAuditTimelineEntry[] {
  return [...rows]
    .sort((a, b) => a.time - b.time || String(a.requestId).localeCompare(String(b.requestId)))
    .map((row) => {
      const finished = row.finished
      const certified = finished !== undefined && (finished.outcome === 'success' || finished.outcome === 'manual' || finished.outcome === 'repair')
      return {
        requestId: String(row.requestId),
        time: row.time,
        request: row.request,
        finished,
        certified,
        certifiedRevision: certified && finished !== undefined && finished.outcome !== undefined
          ? finished.revision
          : undefined,
      }
    })
}

/**
 * The highest revision any model, manual, or repair finished phase certifies across
 * one lifecycle's audit rows. Used by startup reconciliation to decide whether
 * the committed sessions-table stable still lacks a durable credential.
 * @param rows - audit records of one lifecycle.
 * @returns the highest certified revision, or 0 when none is certified.
 */
export function highestCertifiedRevision(rows: readonly TaskStateAuditRecord[]): number {
  let latest = 0
  for (const row of rows) {
    const finished = row.finished
    if (finished === undefined) continue
    if (finished.outcome !== 'success' && finished.outcome !== 'manual' && finished.outcome !== 'repair') continue
    if (finished.revision > latest) latest = finished.revision
  }
  return latest
}

/**
 * Select the ONE open audit row of one lifecycle that a repair must certify
 * for a committed stable revision, or `undefined` when no durable open row
 * targets that revision. A committed stable always has its open row (the open
 * put is awaited before dispatch), so `undefined` indicates an unreachable
 * durability corner the reconciler logs and skips: the stable stays
 * authoritative and simply uncertified.
 * @param rows - audit records of one lifecycle.
 * @param committedRevision - revision of the stable the sessions table holds.
 * @returns the audit row the repair should certify, or `undefined` when no
 *   open row targets the committed revision.
 */
export function selectRepairRow(
  rows: readonly TaskStateAuditRecord[],
  committedRevision: number,
): TaskStateAuditRecord | undefined {
  let newest: TaskStateAuditRecord | undefined
  for (const row of rows) {
    if (row.finished !== undefined || row.request.revision !== committedRevision) continue
    if (newest === undefined || row.time > newest.time
      || (row.time === newest.time && String(row.requestId) > String(newest.requestId))) {
      newest = row
    }
  }
  return newest
}

/**
 * Filter audit rows to those fenced to one exact session lifecycle.
 * @param rows - all audit records of one session id.
 * @param identity - the lifecycle identity to keep.
 * @returns matching rows; a mismatched record is never touched by the caller.
 */
export function rowsForLifecycle(
  rows: readonly TaskStateAuditRecord[],
  identity: TaskStateSessionIdentity,
): readonly TaskStateAuditRecord[] {
  return rows.filter(row =>
    row.session.createdAt === identity.createdAt
    && row.session.cwd === identity.cwd)
}

export type {
  TaskStateRequestId,
  TaskStateSessionIdentity,
  TaskStateUpdateFinishedData,
  TaskStateUpdateRequestData,
}
