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
import type { TaskStateCandidateContent, TaskStateCandidateEntry, TaskStateEvidenceReference, TaskStateRecord, TaskStateSessionIdentity, TaskStateStable, TaskStateStableContent, TaskStateStableEntry, TaskStateTodoReference } from './types.ts';
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
 * One committed authoritative stable. Cursor monotonicity and revision
 * sequencing are properties of a committed chain, owned by the provider and
 * its invariant companion, so they are not validated here.
 */
export declare const taskStateStableSchema: z.ZodType<TaskStateStable>;
/** One whole-Session durable record. Unknown members fail the record. */
export declare const taskStateRecordSchema: z.ZodType<TaskStateRecord>;
/** Lossless JSON value accepted anywhere inside task-state schema evidence. */
export type TaskStateJsonValue = JsonValue;
//# sourceMappingURL=spec.d.ts.map