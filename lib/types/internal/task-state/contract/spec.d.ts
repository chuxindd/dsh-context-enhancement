/**
 * Durable zod schemas for the task-state domain. The provider opens its
 * authoritative storage domain against these record and stable schemas, so
 * the durable shape stays owned by this contract layer and the provider only
 * declares the domain. The schemas use zod v4, the version rc.1 publishes.
 * @module dsh-context-enhancement/internal/task-state/contract/spec
 */
import { z } from 'zod';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { TaskStateEntryId, TaskStateRequestId } from './brand.ts';
import type { TaskStateBlockedVerdict, TaskStateCandidateContent, TaskStateCandidateEntry, TaskStateEvidenceReference, TaskStateGoalView, TaskStateInheritedPrefix, TaskStateQuarantinedVerdict, TaskStateRecord, TaskStateSessionIdentity, TaskStateStable, TaskStateStableContent, TaskStateStableEntry, TaskStateTerminalGeneration, TaskStateTerminalRecord, TaskStateTodoReference, TaskStateTodoView, TaskStateTodoViewItem } from './types.ts';
/**
 * Branded Host-minted request id stored on audit rows. Only non-empty
 * trimmed strings pass; the opaque value itself is Host-minted, so no format
 * validation lives in the contract layer.
 */
export declare const taskStateRequestIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<TaskStateRequestId, string>>;
/**
 * Branded Host-minted stable entry id, opaque by type. This schema enforces
 * only a non-empty trimmed string; minting the opaque kind-prefixed UUID
 * format is the Host durable boundary, owned by the provider at commit.
 */
export declare const taskStateEntryIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<TaskStateEntryId, string>>;
/** Session lifecycle identity fencing one durable record. */
export declare const taskStateSessionIdentitySchema: z.ZodType<TaskStateSessionIdentity>;
/** One durable entry carried inside a committed stable. */
export declare const taskStateStableEntrySchema: z.ZodType<TaskStateStableEntry>;
/** One candidate entry proposed by the auxiliary model. */
export declare const taskStateCandidateEntrySchema: z.ZodType<TaskStateCandidateEntry>;
/** One evidence reference pointing at an eligible durable event sequence. */
export declare const taskStateEvidenceReferenceSchema: z.ZodType<TaskStateEvidenceReference>;
/** One bounded reference to an independently owned `todo/write` list. */
export declare const taskStateTodoReferenceSchema: z.ZodType<TaskStateTodoReference>;
/** The three-state authority vocabulary of one named view. */
export declare const taskStateAuthorityStatusSchema: z.ZodEnum<{
    current: "current";
    cleared: "cleared";
    none: "none";
}>;
/**
 * The authoritative Goal view committed with one stable. Every optional field
 * is absent unless the view is `current`: a cleared or never-established goal
 * carries no identity, revision, phase, or objective that a reader could
 * mistake for a live goal.
 */
export declare const taskStateGoalViewSchema: z.ZodType<TaskStateGoalView>;
/** One item of the authoritative TODO view. */
export declare const taskStateTodoViewItemSchema: z.ZodType<TaskStateTodoViewItem>;
/**
 * The authoritative TODO view committed with one stable. Items exist only
 * while the view is `current`: a cleared list carries an empty item list, so a
 * cleared TODO can never render as a live list.
 */
export declare const taskStateTodoViewSchema: z.ZodType<TaskStateTodoView>;
/** Durable continuation state carried by a stable and a model candidate. */
export declare const taskStateContinuationSchema: z.ZodObject<{
    currentObjective: z.ZodString;
    currentFocus: z.ZodString;
    openWork: z.ZodArray<z.ZodString>;
    nextActions: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/**
 * The content of one auxiliary-model candidate snapshot, parsed straight from
 * the model output. Entry ids are optional — an id is echoed from the previous
 * stable, and a new entry omits it — so this schema intentionally accepts both
 * and never resolves into a stable on its own.
 */
export declare const taskStateCandidateSchema: z.ZodType<TaskStateCandidateContent>;
/**
 * The content of one committed stable, validated only AFTER the Host has
 * minted ids for new candidate entries and verified echoed ones. This schema
 * requires a Host-minted id on every entry and rejects duplicate ids.
 */
export declare const taskStateStableContentSchema: z.ZodType<TaskStateStableContent>;
/**
 * The inherited fork boundary schema. It is additive metadata of one lifecycle:
 * a stable or audit row written by a lifecycle that BEGAN on an inherited prefix
 * carries it, and every other record legitimately omits it.
 */
export declare const taskStateInheritedPrefixSchema: z.ZodType<TaskStateInheritedPrefix>;
/**
 * One committed authoritative stable. Cursor monotonicity and revision
 * sequencing are properties of a committed chain, owned by the provider and
 * its invariant companion, so they are not validated here.
 */
export declare const taskStateStableSchema: z.ZodType<TaskStateStable>;
/**
 * Stable generation schema carried by every durable terminal verdict. It is
 * stored WITH the verdict (never re-derived from memory) so a restart or a
 * later commit can decide whether the measured cause still applies.
 */
export declare const taskStateTerminalGenerationSchema: z.ZodType<TaskStateTerminalGeneration>;
/**
 * Terminal provenance schema of one durable QUARANTINED infeasible window. The
 * request id is branded by the shared {@link taskStateRequestIdSchema} so the
 * parsed record carries the same opaque identity the audit row is keyed by;
 * `includedSeqs` must name at least the one quarantined sequence, because a
 * terminal verdict that quarantined nothing would be a pure cursor advance.
 */
export declare const taskStateQuarantinedVerdictSchema: z.ZodType<TaskStateQuarantinedVerdict>;
/**
 * Terminal provenance schema of a measured non-event cause: an oversized base
 * stable, or an oversized authority fact that may never be skipped. The schema
 * has NO `includedSeqs`: nothing was quarantined, and the cursor stays on the
 * committed floor.
 */
export declare const taskStateBlockedVerdictSchema: z.ZodType<TaskStateBlockedVerdict>;
/**
 * One durable terminal verdict: exactly one of the clean-break variants. A
 * verdict is never a blanket "skip the window" licence — `quarantined` names
 * only the MEASURED ordinary culprit, and `block…` names a cause that is not an
 * event at all and therefore advances nothing.
 *
 * The two variants are exhaustive (`kind` is `quarantined`,
 * `blockBaseOverBudget`, or `blockAuthorityFact`) and each is `.strict()`, so a
 * stored verdict of any other shape fails the record and the whole open stays
 * fail-closed rather than being read as a licence to skip an event.
 */
export declare const taskStateTerminalSchema: z.ZodType<TaskStateTerminalRecord>;
/**
 * One whole-Session durable record. `stable` is optional because a terminal
 * verdict must be persistable BEFORE the Session's first commit; `terminal` is
 * optional because most sessions never hit an infeasible window. Unknown
 * members fail the record (fail closed on a foreign or future shape).
 */
export declare const taskStateRecordSchema: z.ZodType<TaskStateRecord>;
/**
 * The durable generation identity of one terminal verdict.
 *
 * A verdict is a statement about ONE base stable, one filter version, and one
 * framed-input budget. Re-open the window exactly when this identity no longer
 * matches the current state: a new commit (revision, cursor, digest), a
 * manually edited base, a reconfigured `maxInputBytes`, or a future filter
 * version all produce a DIFFERENT generation, so the blocker is re-measured
 * instead of being inherited as a permanent ban. Nothing else — not elapsed
 * time, not a restart, not a replayed observation — may re-open it.
 * @param base - the committed base stable, or `null` before the first commit.
 * @param maxInputBytes - configured framed-input budget in force now.
 * @returns the generation to store with (or compare against) a verdict.
 */
export declare function terminalGeneration(base: {
    readonly revision: number;
    readonly sourceCursor: number;
    readonly filterVersion: string;
    readonly digest: string;
} | null, maxInputBytes: number): TaskStateTerminalGeneration;
/**
 * Whether two stored generations describe the same measurable situation.
 * @param left - one durable generation.
 * @param right - the generation measured now.
 * @returns true when the verdict may NOT be re-opened.
 */
export declare function sameTerminalGeneration(left: TaskStateTerminalGeneration, right: TaskStateTerminalGeneration): boolean;
/**
 * The still-active BLOCK of one durable verdict, or `undefined` when the
 * verdict is a quarantine or its generation no longer matches the current
 * state. This is the single predicate that keeps a blocked window from being
 * re-folded (and re-paid for) on every startup while still re-opening it as
 * soon as the base, the filter version, or the budget changes.
 * @param verdict - the stored verdict, when the lifecycle has one.
 * @param current - the generation measured now.
 * @returns the blocking verdict when it still applies.
 */
export declare function activeTerminalBlock(verdict: TaskStateTerminalRecord | undefined, current: TaskStateTerminalGeneration): TaskStateBlockedVerdict | undefined;
/** Lossless JSON value accepted anywhere inside task-state schema evidence. */
export type TaskStateJsonValue = JsonValue;
//# sourceMappingURL=spec.d.ts.map