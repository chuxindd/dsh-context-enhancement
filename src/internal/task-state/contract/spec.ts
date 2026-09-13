/**
 * Durable zod schemas for the task-state domain. The provider opens its
 * authoritative storage domain against these record and stable schemas, so
 * the durable shape stays owned by this contract layer and the provider only
 * declares the domain. The schemas use zod v4, the version rc.1 publishes.
 * @module dsh-context-enhancement/internal/task-state/contract/spec
 */

import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { TaskStateEntryId, TaskStateRequestId } from './brand.ts'
import type {
  TaskStateBlockedVerdict,
  TaskStateCandidateContent,
  TaskStateCandidateEntry,
  TaskStateEvidenceReference,
  TaskStateGoalView,
  TaskStateInheritedPrefix,
  TaskStateQuarantinedVerdict,
  TaskStateRecord,
  TaskStateSessionIdentity,
  TaskStateStable,
  TaskStateStableContent,
  TaskStateStableEntry,
  TaskStateTerminalGeneration,
  TaskStateTerminalRecord,
  TaskStateTodoReference,
  TaskStateTodoView,
  TaskStateTodoViewItem,
} from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonEmptyTrimmed = z.string().min(1).refine(value => value.trim() === value, {
  message: 'must be non-empty and have no surrounding whitespace',
})

/**
 * Branded Host-minted request id stored on audit rows. Only non-empty
 * trimmed strings pass; the opaque value itself is Host-minted, so no format
 * validation lives in the contract layer.
 */
export const taskStateRequestIdSchema = nonEmptyTrimmed
  .transform(value => value as TaskStateRequestId)

/**
 * Branded Host-minted stable entry id, opaque by type. This schema enforces
 * only a non-empty trimmed string; minting the opaque kind-prefixed UUID
 * format is the Host durable boundary, owned by the provider at commit.
 */
export const taskStateEntryIdSchema = nonEmptyTrimmed
  .transform(value => value as TaskStateEntryId)

/** Session lifecycle identity fencing one durable record. */
export const taskStateSessionIdentitySchema = z.object({
  createdAt: nonNegativeSafeInteger,
  cwd: z.string().optional(),
}) as z.ZodType<TaskStateSessionIdentity>

/** One durable entry carried inside a committed stable. */
export const taskStateStableEntrySchema = z.object({
  id: taskStateEntryIdSchema,
  content: nonEmptyTrimmed,
}) as z.ZodType<TaskStateStableEntry>

/** One candidate entry proposed by the auxiliary model. */
export const taskStateCandidateEntrySchema = z.object({
  id: taskStateEntryIdSchema.optional(),
  content: nonEmptyTrimmed,
}) as z.ZodType<TaskStateCandidateEntry>

/** One evidence reference pointing at an eligible durable event sequence. */
export const taskStateEvidenceReferenceSchema = z.object({
  seq: nonNegativeSafeInteger,
  note: nonEmptyTrimmed,
}) as z.ZodType<TaskStateEvidenceReference>

/** One bounded reference to an independently owned `todo/write` list. */
export const taskStateTodoReferenceSchema = z.object({
  seq: nonNegativeSafeInteger,
  content: nonEmptyTrimmed,
}) as z.ZodType<TaskStateTodoReference>

/** The three-state authority vocabulary of one named view. */
export const taskStateAuthorityStatusSchema = z.enum(['current', 'cleared', 'none'])

/**
 * The authoritative Goal view committed with one stable. Every optional field
 * is absent unless the view is `current`: a cleared or never-established goal
 * carries no identity, revision, phase, or objective that a reader could
 * mistake for a live goal.
 */
export const taskStateGoalViewSchema = z.object({
  status: taskStateAuthorityStatusSchema,
  goalId: nonEmptyTrimmed.optional(),
  goalRevision: positiveSafeInteger.optional(),
  phase: nonEmptyTrimmed.optional(),
  objective: nonEmptyTrimmed.optional(),
}).superRefine((value, ctx) => {
  if (value.status !== 'current'
    && (value.goalId !== undefined || value.goalRevision !== undefined
      || value.phase !== undefined || value.objective !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a non-current goalView carries no goal identity, revision, phase, or objective',
    })
  }
}) as unknown as z.ZodType<TaskStateGoalView>

/** One item of the authoritative TODO view. */
export const taskStateTodoViewItemSchema = z.object({
  content: nonEmptyTrimmed,
  status: nonEmptyTrimmed,
}) as z.ZodType<TaskStateTodoViewItem>

/**
 * The authoritative TODO view committed with one stable. Items exist only
 * while the view is `current`: a cleared list carries an empty item list, so a
 * cleared TODO can never render as a live list.
 */
export const taskStateTodoViewSchema = z.object({
  status: taskStateAuthorityStatusSchema,
  sourceSeq: nonNegativeSafeInteger.optional(),
  items: z.array(taskStateTodoViewItemSchema),
}).superRefine((value, ctx) => {
  if (value.status !== 'current' && value.items.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'a non-current todoView carries no items' })
  }
}) as unknown as z.ZodType<TaskStateTodoView>

/** Durable continuation state carried by a stable and a model candidate. */
export const taskStateContinuationSchema = z.object({
  currentObjective: z.string().refine(value => value.trim() === value, {
    message: 'currentObjective must have no surrounding whitespace',
  }),
  currentFocus: z.string().refine(value => value.trim() === value, {
    message: 'currentFocus must have no surrounding whitespace',
  }),
  openWork: z.array(nonEmptyTrimmed),
  nextActions: z.array(nonEmptyTrimmed),
})

/**
 * Reject any committed content whose kinded entry lists repeat one id across
 * or within lists. Entry ids are Host-minted and unique within a stable.
 */
function rejectDuplicateIds(value: {
  facts: readonly { id: string }[]
  decisions: readonly { id: string }[]
  constraints: readonly { id: string }[]
  risks: readonly { id: string }[]
}, ctx: z.RefinementCtx): void {
  const seen = new Map<string, string>()
  for (const key of ['facts', 'decisions', 'constraints', 'risks'] as const) {
    for (const entry of value[key]) {
      const previous = seen.get(entry.id)
      if (previous !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `task-state entry id '${entry.id}' repeats across ${previous} and ${key}`,
        })
      } else {
        seen.set(entry.id, key)
      }
    }
  }
}

/** Kinded entry and reference lists of one auxiliary-model candidate. */
const candidateShape = {
  facts: z.array(taskStateCandidateEntrySchema),
  decisions: z.array(taskStateCandidateEntrySchema),
  constraints: z.array(taskStateCandidateEntrySchema),
  risks: z.array(taskStateCandidateEntrySchema),
  evidence: z.array(taskStateEvidenceReferenceSchema),
}

/**
 * Kinded entry and reference lists of one committed stable, plus the
 * Host-derived authoritative views. The candidate shape deliberately lacks
 * `todoReferences`, `goalView`, and `todoView`: those are Host-owned and a
 * model-proposed value for any of them is not part of the candidate contract.
 */
const stableShape = {
  facts: z.array(taskStateStableEntrySchema),
  decisions: z.array(taskStateStableEntrySchema),
  constraints: z.array(taskStateStableEntrySchema),
  risks: z.array(taskStateStableEntrySchema),
  evidence: z.array(taskStateEvidenceReferenceSchema),
  todoReferences: z.array(taskStateTodoReferenceSchema),
  goalView: taskStateGoalViewSchema,
  todoView: taskStateTodoViewSchema,
}

/**
 * The content of one auxiliary-model candidate snapshot, parsed straight from
 * the model output. Entry ids are optional — an id is echoed from the previous
 * stable, and a new entry omits it — so this schema intentionally accepts both
 * and never resolves into a stable on its own.
 */
export const taskStateCandidateSchema = z.object({
  ...candidateShape,
  continuation: taskStateContinuationSchema,
}) as z.ZodType<TaskStateCandidateContent>

/**
 * The content of one committed stable, validated only AFTER the Host has
 * minted ids for new candidate entries and verified echoed ones. This schema
 * requires a Host-minted id on every entry and rejects duplicate ids.
 */
export const taskStateStableContentSchema = z.object({
  ...stableShape,
  continuation: taskStateContinuationSchema,
}).superRefine(rejectDuplicateIds) as z.ZodType<TaskStateStableContent>

/**
 * The inherited fork boundary schema. It is additive metadata of one lifecycle:
 * a stable or audit row written by a lifecycle that BEGAN on an inherited prefix
 * carries it, and every other record legitimately omits it.
 */
export const taskStateInheritedPrefixSchema = z.object({
  source: z.literal('fork-prefix'),
  ownBoundarySeq: nonNegativeSafeInteger,
  inheritedThroughSeq: nonNegativeSafeInteger.nullable(),
  parentSession: nonEmptyTrimmed.optional(),
}) as z.ZodType<TaskStateInheritedPrefix>

/**
 * One committed authoritative stable. Cursor monotonicity and revision
 * sequencing are properties of a committed chain, owned by the provider and
 * its invariant companion, so they are not validated here.
 */
export const taskStateStableSchema = z.object({
  ...stableShape,
  continuation: taskStateContinuationSchema,
  schemaVersion: nonNegativeSafeInteger,
  revision: positiveSafeInteger,
  filterVersion: nonEmptyTrimmed,
  sourceCursor: nonNegativeSafeInteger,
  digest: nonEmptyTrimmed,
  inherited: taskStateInheritedPrefixSchema.optional(),
}).superRefine(rejectDuplicateIds) as z.ZodType<TaskStateStable>

/**
 * Stable generation schema carried by every durable terminal verdict. It is
 * stored WITH the verdict (never re-derived from memory) so a restart or a
 * later commit can decide whether the measured cause still applies.
 */
export const taskStateTerminalGenerationSchema = z.object({
  baseSourceCursor: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  baseFilterVersion: nonEmptyTrimmed,
  baseDigest: nonEmptyTrimmed,
  maxInputBytes: positiveSafeInteger,
}).strict() as z.ZodType<TaskStateTerminalGeneration>

/** Shared scalar fields of every terminal verdict variant. */
const terminalCommonShape = {
  requestId: taskStateRequestIdSchema,
  generation: taskStateTerminalGenerationSchema,
  cursor: nonNegativeSafeInteger,
  code: z.literal('BUDGET'),
  reason: nonEmptyTrimmed,
  trigger: z.enum(['startup', 'threshold', 'urgent', 'trailing', 'manual']).optional(),
  time: nonNegativeSafeInteger,
}

/**
 * Terminal provenance schema of one durable QUARANTINED infeasible window. The
 * request id is branded by the shared {@link taskStateRequestIdSchema} so the
 * parsed record carries the same opaque identity the audit row is keyed by;
 * `includedSeqs` must name at least the one quarantined sequence, because a
 * terminal verdict that quarantined nothing would be a pure cursor advance.
 */
export const taskStateQuarantinedVerdictSchema = z.object({
  kind: z.literal('quarantined'),
  ...terminalCommonShape,
  includedSeqs: z.array(nonNegativeSafeInteger).min(1),
}).strict() as unknown as z.ZodType<TaskStateQuarantinedVerdict>

/**
 * Terminal provenance schema of a measured non-event cause: an oversized base
 * stable, or an oversized authority fact that may never be skipped. The schema
 * has NO `includedSeqs`: nothing was quarantined, and the cursor stays on the
 * committed floor.
 */
export const taskStateBlockedVerdictSchema = z.object({
  kind: z.enum(['blockBaseOverBudget', 'blockAuthorityFact']),
  ...terminalCommonShape,
  blockSeq: nonNegativeSafeInteger.optional(),
  blockType: nonEmptyTrimmed.optional(),
}).strict() as unknown as z.ZodType<TaskStateBlockedVerdict>

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
export const taskStateTerminalSchema = z.union([
  taskStateQuarantinedVerdictSchema,
  taskStateBlockedVerdictSchema,
]) as z.ZodType<TaskStateTerminalRecord>

/**
 * One whole-Session durable record. `stable` is optional because a terminal
 * verdict must be persistable BEFORE the Session's first commit; `terminal` is
 * optional because most sessions never hit an infeasible window. Unknown
 * members fail the record (fail closed on a foreign or future shape).
 */
export const taskStateRecordSchema = z.object({
  session: taskStateSessionIdentitySchema,
  stable: taskStateStableSchema.optional(),
  terminal: taskStateTerminalSchema.optional(),
}).strict() as z.ZodType<TaskStateRecord>

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
export function terminalGeneration(
  base: { readonly revision: number; readonly sourceCursor: number; readonly filterVersion: string; readonly digest: string } | null,
  maxInputBytes: number,
): TaskStateTerminalGeneration {
  return {
    baseSourceCursor: base === null ? -1 : base.sourceCursor,
    baseFilterVersion: base === null ? 'none' : base.filterVersion,
    baseDigest: base === null ? 'none' : base.digest,
    maxInputBytes,
  }
}

/**
 * Whether two stored generations describe the same measurable situation.
 * @param left - one durable generation.
 * @param right - the generation measured now.
 * @returns true when the verdict may NOT be re-opened.
 */
export function sameTerminalGeneration(
  left: TaskStateTerminalGeneration,
  right: TaskStateTerminalGeneration,
): boolean {
  return left.baseSourceCursor === right.baseSourceCursor
    && left.baseFilterVersion === right.baseFilterVersion
    && left.baseDigest === right.baseDigest
    && left.maxInputBytes === right.maxInputBytes
}

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
export function activeTerminalBlock(
  verdict: TaskStateTerminalRecord | undefined,
  current: TaskStateTerminalGeneration,
): TaskStateBlockedVerdict | undefined {
  if (verdict === undefined || verdict.kind === 'quarantined') return undefined
  return sameTerminalGeneration(verdict.generation, current) ? verdict : undefined
}

/** Lossless JSON value accepted anywhere inside task-state schema evidence. */
export type TaskStateJsonValue = JsonValue
