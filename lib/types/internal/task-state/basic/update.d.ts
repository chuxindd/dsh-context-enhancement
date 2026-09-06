/**
 * One single-attempt auxiliary collect-and-merge update for a Session. The
 * module runs the complete update transaction sequence: durable open-phase
 * audit put, `ctx.llm.stream()` with an explicit route and deadline,
 * collection of complete untruncated raw output, JSON parsing, contract
 * schema validation, Host semantic checks, the authoritative sessions-table
 * put, and the paired finished-phase audit put. It never retries internally:
 * transient infrastructure classification is surfaced to the per-Session
 * worker, which re-invokes one whole attempt (a fresh request id) per retry
 * so every open row pairs with exactly one finished phase. Every pre-put
 * failure preserves the previous stable and cursor.
 *
 * Audit durability contract:
 * - The open-phase audit put is awaited BEFORE the model stream is even
 *   constructed; an open row that cannot become durable aborts the attempt
 *   with an `AUDIT` request-stage failure and never calls the model.
 * - The sessions-table put is the authority commit point and the published
 *   pointer is updated only after it resolves. The finished-phase audit put
 *   may then fail WITHOUT rolling back the committed stable: the attempt
 *   returns `auditGap: true` and the owning worker arranges a live repair
 *   that certifies the existing open row — never rerunning the model and
 *   never inventing raw output.
 *
 * `purpose` handling: rc.1's `GenerateOptions.purpose` union is closed
 * (`'compaction' | 'session-title'`). The task-state request must still mark
 * its purpose for replay/diagnostics, so this module builds a locally typed
 * request (`purpose: 'task-state'`) and casts ONLY at the single
 * `ctx.llm.stream(...)` boundary; no upstream type is modified and no fake
 * compaction purpose is used.
 * @module dsh-context-enhancement/internal/task-state/basic/update
 */
import type { Context } from '@deepseek-ai/cordis';
import { type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { TaskStateRequestId, type TaskStateStable, type TaskStateTruncationRecord, type TaskStateUpdateFinishedData, type TaskStateUpdateRequestData } from '../contract/index.ts';
import type { TaskStateBatchFailure } from './types.ts';
/** Stable Host-owned timeout code stamped on the deadline reason. */
export declare const TASK_STATE_UPDATE_TIMEOUT_CODE = "task-state-basic/update-timeout";
/** One update attempt's full execution context. */
export interface TaskStateUpdateAttempt {
    /** Host context providing `ctx.llm` and logging. */
    readonly ctx: Context;
    /** Exact registered provider route for the auxiliary request. */
    readonly route: {
        readonly provider: string;
        readonly model: string;
    };
    /** Committed base stable, or `null` before the first commit. */
    readonly base: TaskStateStable | null;
    /** Exact deterministic model-visible framed projection (JSON text). */
    readonly projection: string;
    /** Exact included eligible sequences folded into the window. */
    readonly includedSeqs: readonly number[];
    /** Deterministic truncation records produced by the projection. */
    readonly truncation: readonly TaskStateTruncationRecord[];
    /** Exact model-visible system instruction (pinned). */
    readonly system: string;
    /** Validated maximum output tokens. */
    readonly maxOutputTokens: number;
    /** Validated end-to-end deadline in milliseconds. */
    readonly timeoutMs: number;
    /** Session id for the LLM call and audit pairing. */
    readonly sessionId: SessionId;
    /** Cancellation from Session or plugin disposal. */
    readonly signal: AbortSignal;
    /** Stable byte and item limits enforced by Host semantic validation. */
    readonly limits: {
        readonly maxEntriesPerKind: number;
        readonly maxEntryBytes: number;
        readonly maxListItems: number;
    };
}
/**
 * The locally typed auxiliary request. rc.1's `GenerateOptions` type only
 * admits `purpose: 'compaction' | 'session-title'`; task-state structurally
 * extends it with its own purpose tag and casts once at the stream boundary.
 * The upstream field is a closed union, so the extension drops that key and
 * restates it with the task-state literal.
 */
export type TaskStateGenerateOptions = Omit<GenerateOptions, 'purpose'> & {
    /** Auxiliary classification: task-state, never a compaction request. */
    readonly purpose: 'task-state';
};
/** The provider-owned storage and audit boundary of one attempt. */
export interface TaskStateUpdateHooks {
    /**
     * Put one durable open-phase audit row and await its durability. Rejects
     * when the open row cannot be confirmed durable, which must prevent adapter
     * dispatch.
     */
    putOpenAudit: (data: TaskStateUpdateRequestData) => Promise<void>;
    /**
     * Put one finished-phase audit update and await its durability. A rejection
     * after a successful sessions put is an audit gap, not a commit failure.
     */
    putFinishedAudit: (finished: TaskStateUpdateFinishedData) => Promise<void>;
    /** The durable authority commit: replace one Session's stable record. */
    putStable: (stable: TaskStateStable) => Promise<void>;
    /** Publish the committed pointer only after the authority put succeeds. */
    onCommitted: (stable: TaskStateStable) => void;
}
/** The complete result of one update attempt. */
export type TaskStateUpdateAttemptResult = {
    readonly ok: true;
    readonly stable: TaskStateStable;
    /** Branded request id pairing the open row with its finished or repair phase. */
    readonly requestId: TaskStateRequestId;
    /** True when the authority put committed but the finished audit could not be put durably. */
    readonly auditGap: boolean;
    readonly usage?: TokenUsage;
} | {
    readonly ok: false;
    readonly failure: TaskStateBatchFailure;
};
/**
 * Run one complete update attempt. Deterministic failures return
 * `ok: false` without retrying; transient infrastructure failures also return
 * `ok: false` with a retryable code so the owning worker may re-run the whole
 * attempt under its bounded policy. A successful put whose finished audit put
 * fails returns `ok: true` with `auditGap: true`.
 * @param attempt - full attempt context.
 * @param hooks - provider-owned storage/audit/publish boundary.
 * @returns the committed stable, or structured failure facts.
 */
export declare function runUpdateAttempt(attempt: TaskStateUpdateAttempt, hooks: TaskStateUpdateHooks): Promise<TaskStateUpdateAttemptResult>;
export type { TaskStateUpdateFinishedData, TaskStateUpdateRequestData };
//# sourceMappingURL=update.d.ts.map