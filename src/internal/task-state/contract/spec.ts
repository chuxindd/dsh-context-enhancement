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
  TaskStateCandidateContent,
  TaskStateCandidateEntry,
  TaskStateEvidenceReference,
  TaskStateRecord,
  TaskStateSessionIdentity,
  TaskStateStable,
  TaskStateStableContent,
  TaskStateStableEntry,
  TaskStateTodoReference,
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
  todoReferences: z.array(taskStateTodoReferenceSchema),
}

/** Kinded entry and reference lists of one committed stable content. */
const stableShape = {
  facts: z.array(taskStateStableEntrySchema),
  decisions: z.array(taskStateStableEntrySchema),
  constraints: z.array(taskStateStableEntrySchema),
  risks: z.array(taskStateStableEntrySchema),
  evidence: z.array(taskStateEvidenceReferenceSchema),
  todoReferences: z.array(taskStateTodoReferenceSchema),
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
}).superRefine(rejectDuplicateIds) as z.ZodType<TaskStateStable>

/** One whole-Session durable record. Unknown members fail the record. */
export const taskStateRecordSchema = z.object({
  session: taskStateSessionIdentitySchema,
  stable: taskStateStableSchema,
}).strict() as z.ZodType<TaskStateRecord>

/** Lossless JSON value accepted anywhere inside task-state schema evidence. */
export type TaskStateJsonValue = JsonValue
