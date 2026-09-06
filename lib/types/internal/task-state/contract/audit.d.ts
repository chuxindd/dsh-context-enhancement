/**
 * Durable audit vocabulary of one task-state update, plus pure derivation
 * helpers for keyless tests and startup repair reconciliation.
 *
 * Audit design: ONE audit row per auxiliary request, keyed by the Host-minted
 * request id, in the provider's `audit` table. A row is written in two
 * phases — the OPEN phase carries the complete pre-dispatch request evidence
 * and is put durably BEFORE the model is dispatched; the FINISHED phase
 * (success, failure, or repair) later fills the same row. The authoritative
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
import { z } from 'zod';
import type { TaskStateRequestId } from './brand.ts';
import type { TaskStateSessionIdentity, TaskStateUpdateFinishedData, TaskStateUpdateRequestData } from './types.ts';
/**
 * Durable open-phase schema. Permissive enough that an independently written
 * row still opens while gross corruption of the medium is caught by the JSON
 * parse and this schema. The full candidate schema is NOT reapplied here:
 * rows are schema-validated at the moment they are written, and the audit
 * table is diagnostic-only — the `sessions` table is the authority.
 */
export declare const taskStateAuditOpenSchema: z.ZodObject<{
    requestId: z.ZodString;
    time: z.ZodNumber;
    session: z.ZodObject<{
        createdAt: z.ZodNumber;
        cwd: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    request: z.ZodObject<{
        requestId: z.ZodString;
        revision: z.ZodNumber;
        base: z.ZodNullable<z.ZodObject<{
            schemaVersion: z.ZodNumber;
            revision: z.ZodNumber;
            filterVersion: z.ZodString;
            sourceCursor: z.ZodNumber;
            digest: z.ZodString;
        }, z.core.$strip>>;
        includedSeqs: z.ZodArray<z.ZodNumber>;
        filterVersion: z.ZodString;
        system: z.ZodString;
        route: z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            reasoningEffort: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        maxTokens: z.ZodNumber;
        schema: z.ZodObject<{
            version: z.ZodNumber;
            material: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
        truncation: z.ZodDefault<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            limitBytes: z.ZodNumber;
            keptBytes: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
}, z.core.$strip>;
/** One permissive finished-phase view used to validate a restored row. */
export declare const taskStateAuditFinishedSchema: z.ZodObject<{
    outcome: z.ZodEnum<{
        success: "success";
        failure: "failure";
        repair: "repair";
    }>;
    requestId: z.ZodOptional<z.ZodString>;
    revision: z.ZodOptional<z.ZodNumber>;
    sourceCursor: z.ZodOptional<z.ZodNumber>;
    llmStreamCall: z.ZodOptional<z.ZodBoolean>;
    rawOutput: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    usage: z.ZodOptional<z.ZodUnknown>;
    finish: z.ZodOptional<z.ZodUnknown>;
    error: z.ZodOptional<z.ZodObject<{
        stage: z.ZodString;
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * One durable audit row of one auxiliary request. The row is keyed by
 * `requestId`; `finished` is absent while the request is open (or after a
 * crash between the open put and the finished put).
 */
export interface TaskStateAuditRecord {
    /** Branded Host-minted request id; equals the row key. */
    readonly requestId: TaskStateRequestId;
    /** Epoch milliseconds when the open phase was written (row order). */
    readonly time: number;
    /** Session lifecycle identity this audit row is fenced to. */
    readonly session: TaskStateSessionIdentity;
    /** The complete pre-dispatch request evidence (the open phase). */
    readonly request: TaskStateUpdateRequestData;
    /** The finished phase, when the request settled. */
    readonly finished?: TaskStateUpdateFinishedData;
}
/** Whole-row schema used by the storage domain to validate the audit table. */
export declare const taskStateAuditSchema: z.ZodType<TaskStateAuditRecord>;
/**
 * Build the durable open-phase row of one request.
 * @param requestId - branded request id (the row key).
 * @param session - lifecycle identity the row is fenced to.
 * @param request - complete pre-dispatch request evidence.
 * @param time - open-phase write time (defaults to now).
 * @returns the row value to put under `requestId`.
 */
export declare function openAuditRow(requestId: TaskStateRequestId, session: TaskStateSessionIdentity, request: TaskStateUpdateRequestData, time?: number): TaskStateAuditRecord;
/**
 * Build the finished-phase update of one audit row. The row key (`requestId`)
 * and the open phase stay untouched; only an open row accepts a finished phase.
 * A settled row is immutable, so a stale repair cannot replace success evidence.
 * @param row - the durable open row being settled.
 * @param finished - the finished phase to attach.
 * @returns the replacement row value.
 */
export declare function finishAuditRow(row: TaskStateAuditRecord, finished: TaskStateUpdateFinishedData): TaskStateAuditRecord;
/** The resolved per-request view a keyless replay test can read. */
export interface TaskStateAuditTimelineEntry {
    /** Branded request id. */
    readonly requestId: string;
    /** Epoch ms of the open phase. */
    readonly time: number;
    /** The open-phase request evidence. */
    readonly request: TaskStateUpdateRequestData;
    /** The finished phase, when the request settled; `undefined` while open. */
    readonly finished: TaskStateUpdateFinishedData | undefined;
    /** Whether a success or repair finished certifies a commit. */
    readonly certified: boolean;
    /** Revision the finished phase certifies, when `certified`. */
    readonly certifiedRevision: number | undefined;
}
/**
 * Pure derivation: project audit rows of one lifecycle into a deterministic,
 * time-ascending per-request timeline. Keyless tests read committed stable
 * provenance through this helper; the provider's repair reconciliation uses
 * the same ordering rules.
 * @param rows - audit records (already lifecycle-filtered by the caller).
 * @returns the timeline, ascending by `time` then lexicographic request id.
 */
export declare function deriveAuditTimeline(rows: readonly TaskStateAuditRecord[]): TaskStateAuditTimelineEntry[];
/**
 * The highest revision any success or repair finished phase certifies across
 * one lifecycle's audit rows. Used by startup reconciliation to decide whether
 * the committed sessions-table stable still lacks a durable credential.
 * @param rows - audit records of one lifecycle.
 * @returns the highest certified revision, or 0 when none is certified.
 */
export declare function highestCertifiedRevision(rows: readonly TaskStateAuditRecord[]): number;
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
export declare function selectRepairRow(rows: readonly TaskStateAuditRecord[], committedRevision: number): TaskStateAuditRecord | undefined;
/**
 * Filter audit rows to those fenced to one exact session lifecycle.
 * @param rows - all audit records of one session id.
 * @param identity - the lifecycle identity to keep.
 * @returns matching rows; a mismatched record is never touched by the caller.
 */
export declare function rowsForLifecycle(rows: readonly TaskStateAuditRecord[], identity: TaskStateSessionIdentity): readonly TaskStateAuditRecord[];
export type { TaskStateRequestId, TaskStateSessionIdentity, TaskStateUpdateFinishedData, TaskStateUpdateRequestData, };
//# sourceMappingURL=audit.d.ts.map