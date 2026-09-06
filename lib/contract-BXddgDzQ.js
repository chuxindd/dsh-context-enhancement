import { a as object, i as number, n as array, o as string, r as boolean, s as unknown, t as _enum } from "./schemas-CmHu7nPi.js";
import { Service } from "@deepseek-ai/cordis";
//#region lib/types/internal/task-state/contract/brand.js
/**
* Host-minted opaque identities of the durable task-state domain: the branded
* request id that keys one audit row (and pairs its open and finished phases)
* and the branded entry id that names one committed fact, decision, constraint,
* or risk. Branding reuses `@deepseek-ai/dsh-brand` so the values stay
* nominally typed at every same-process boundary without owning runtime state.
* @module dsh-context-enhancement/internal/task-state/contract/brand
*/
/**
* Brand a Host-minted task-state request id.
* @param id - opaque request identity.
* @returns the same string, branded; no validation is performed.
*/
function TaskStateRequestId(id) {
	return id;
}
/**
* Brand a Host-minted task-state entry id.
* @param id - opaque entry identity.
* @returns the same string, branded; no validation is performed.
*/
function TaskStateEntryId(id) {
	return id;
}
//#endregion
//#region lib/types/internal/task-state/contract/spec.js
/**
* Durable zod schemas for the task-state domain. The provider opens its
* authoritative storage domain against these record and stable schemas, so
* the durable shape stays owned by this contract layer and the provider only
* declares the domain. The schemas use zod v4, the version rc.1 publishes.
* @module dsh-context-enhancement/internal/task-state/contract/spec
*/
const nonNegativeSafeInteger$1 = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonEmptyTrimmed$1 = string().min(1).refine((value) => value.trim() === value, { message: "must be non-empty and have no surrounding whitespace" });
/**
* Branded Host-minted request id stored on audit rows. Only non-empty
* trimmed strings pass; the opaque value itself is Host-minted, so no format
* validation lives in the contract layer.
*/
const taskStateRequestIdSchema = nonEmptyTrimmed$1.transform((value) => value);
/**
* Branded Host-minted stable entry id, opaque by type. This schema enforces
* only a non-empty trimmed string; minting the opaque kind-prefixed UUID
* format is the Host durable boundary, owned by the provider at commit.
*/
const taskStateEntryIdSchema = nonEmptyTrimmed$1.transform((value) => value);
/** Session lifecycle identity fencing one durable record. */
const taskStateSessionIdentitySchema = object({
	createdAt: nonNegativeSafeInteger$1,
	cwd: string().optional()
});
/** One durable entry carried inside a committed stable. */
const taskStateStableEntrySchema = object({
	id: taskStateEntryIdSchema,
	content: nonEmptyTrimmed$1
});
/** One candidate entry proposed by the auxiliary model. */
const taskStateCandidateEntrySchema = object({
	id: taskStateEntryIdSchema.optional(),
	content: nonEmptyTrimmed$1
});
/** One evidence reference pointing at an eligible durable event sequence. */
const taskStateEvidenceReferenceSchema = object({
	seq: nonNegativeSafeInteger$1,
	note: nonEmptyTrimmed$1
});
/** One bounded reference to an independently owned `todo/write` list. */
const taskStateTodoReferenceSchema = object({
	seq: nonNegativeSafeInteger$1,
	content: nonEmptyTrimmed$1
});
/** Durable continuation state carried by a stable and a model candidate. */
const taskStateContinuationSchema = object({
	currentObjective: string().refine((value) => value.trim() === value, { message: "currentObjective must have no surrounding whitespace" }),
	currentFocus: string().refine((value) => value.trim() === value, { message: "currentFocus must have no surrounding whitespace" }),
	openWork: array(nonEmptyTrimmed$1),
	nextActions: array(nonEmptyTrimmed$1)
});
/**
* Reject any committed content whose kinded entry lists repeat one id across
* or within lists. Entry ids are Host-minted and unique within a stable.
*/
function rejectDuplicateIds(value, ctx) {
	const seen = /* @__PURE__ */ new Map();
	for (const key of [
		"facts",
		"decisions",
		"constraints",
		"risks"
	]) for (const entry of value[key]) {
		const previous = seen.get(entry.id);
		if (previous !== void 0) ctx.addIssue({
			code: "custom",
			path: [key],
			message: `task-state entry id '${entry.id}' repeats across ${previous} and ${key}`
		});
		else seen.set(entry.id, key);
	}
}
/** Kinded entry and reference lists of one auxiliary-model candidate. */
const candidateShape = {
	facts: array(taskStateCandidateEntrySchema),
	decisions: array(taskStateCandidateEntrySchema),
	constraints: array(taskStateCandidateEntrySchema),
	risks: array(taskStateCandidateEntrySchema),
	evidence: array(taskStateEvidenceReferenceSchema),
	todoReferences: array(taskStateTodoReferenceSchema)
};
/** Kinded entry and reference lists of one committed stable content. */
const stableShape = {
	facts: array(taskStateStableEntrySchema),
	decisions: array(taskStateStableEntrySchema),
	constraints: array(taskStateStableEntrySchema),
	risks: array(taskStateStableEntrySchema),
	evidence: array(taskStateEvidenceReferenceSchema),
	todoReferences: array(taskStateTodoReferenceSchema)
};
/**
* The content of one auxiliary-model candidate snapshot, parsed straight from
* the model output. Entry ids are optional — an id is echoed from the previous
* stable, and a new entry omits it — so this schema intentionally accepts both
* and never resolves into a stable on its own.
*/
const taskStateCandidateSchema = object({
	...candidateShape,
	continuation: taskStateContinuationSchema
});
/**
* The content of one committed stable, validated only AFTER the Host has
* minted ids for new candidate entries and verified echoed ones. This schema
* requires a Host-minted id on every entry and rejects duplicate ids.
*/
const taskStateStableContentSchema = object({
	...stableShape,
	continuation: taskStateContinuationSchema
}).superRefine(rejectDuplicateIds);
/**
* One committed authoritative stable. Cursor monotonicity and revision
* sequencing are properties of a committed chain, owned by the provider and
* its invariant companion, so they are not validated here.
*/
const taskStateStableSchema = object({
	...stableShape,
	continuation: taskStateContinuationSchema,
	schemaVersion: nonNegativeSafeInteger$1,
	revision: positiveSafeInteger,
	filterVersion: nonEmptyTrimmed$1,
	sourceCursor: nonNegativeSafeInteger$1,
	digest: nonEmptyTrimmed$1
}).superRefine(rejectDuplicateIds);
/** One whole-Session durable record. Unknown members fail the record. */
const taskStateRecordSchema = object({
	session: taskStateSessionIdentitySchema,
	stable: taskStateStableSchema
}).strict();
//#endregion
//#region lib/types/internal/task-state/contract/audit.js
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
const nonNegativeSafeInteger = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonEmptyTrimmed = string().min(1).refine((value) => value.trim() === value, { message: "must be non-empty and have no surrounding whitespace" });
/** A permissive stable-envelope view used only to validate a restored open row. */
const stableEnvelopeSchema = object({
	schemaVersion: nonNegativeSafeInteger,
	revision: nonNegativeSafeInteger,
	filterVersion: nonEmptyTrimmed,
	sourceCursor: nonNegativeSafeInteger,
	digest: nonEmptyTrimmed
});
/**
* Durable open-phase schema. Permissive enough that an independently written
* row still opens while gross corruption of the medium is caught by the JSON
* parse and this schema. The full candidate schema is NOT reapplied here:
* rows are schema-validated at the moment they are written, and the audit
* table is diagnostic-only — the `sessions` table is the authority.
*/
const taskStateAuditOpenSchema = object({
	requestId: nonEmptyTrimmed,
	time: nonNegativeSafeInteger,
	session: object({
		createdAt: nonNegativeSafeInteger,
		cwd: string().optional()
	}),
	request: object({
		requestId: nonEmptyTrimmed,
		revision: nonNegativeSafeInteger,
		base: stableEnvelopeSchema.nullable(),
		includedSeqs: array(nonNegativeSafeInteger),
		filterVersion: nonEmptyTrimmed,
		system: string(),
		route: object({
			provider: nonEmptyTrimmed,
			model: nonEmptyTrimmed,
			reasoningEffort: string().optional()
		}),
		maxTokens: nonNegativeSafeInteger,
		schema: object({
			version: nonNegativeSafeInteger,
			material: unknown().optional()
		}),
		truncation: array(object({
			path: string(),
			limitBytes: nonNegativeSafeInteger,
			keptBytes: nonNegativeSafeInteger
		})).default([])
	})
});
/** One permissive finished-phase view used to validate a restored row. */
const taskStateAuditFinishedSchema = object({
	outcome: _enum([
		"success",
		"failure",
		"repair"
	]),
	requestId: string().optional(),
	revision: nonNegativeSafeInteger.optional(),
	sourceCursor: nonNegativeSafeInteger.optional(),
	llmStreamCall: boolean().optional(),
	rawOutput: array(unknown()).optional(),
	usage: unknown().optional(),
	finish: unknown().optional(),
	error: object({
		stage: string(),
		code: string(),
		message: string()
	}).optional()
});
/** Whole-row schema used by the storage domain to validate the audit table. */
const taskStateAuditSchema = taskStateAuditOpenSchema.extend({ finished: taskStateAuditFinishedSchema.optional() }).strict();
/**
* Build the durable open-phase row of one request.
* @param requestId - branded request id (the row key).
* @param session - lifecycle identity the row is fenced to.
* @param request - complete pre-dispatch request evidence.
* @param time - open-phase write time (defaults to now).
* @returns the row value to put under `requestId`.
*/
function openAuditRow(requestId, session, request, time = Date.now()) {
	return {
		requestId,
		time,
		session,
		request
	};
}
/**
* Build the finished-phase update of one audit row. The row key (`requestId`)
* and the open phase stay untouched; only an open row accepts a finished phase.
* A settled row is immutable, so a stale repair cannot replace success evidence.
* @param row - the durable open row being settled.
* @param finished - the finished phase to attach.
* @returns the replacement row value.
*/
function finishAuditRow(row, finished) {
	if (row.finished === void 0) return {
		...row,
		finished
	};
	if (row.finished.outcome === "repair" && finished.outcome === "success") return {
		...row,
		finished
	};
	return row;
}
/**
* Pure derivation: project audit rows of one lifecycle into a deterministic,
* time-ascending per-request timeline. Keyless tests read committed stable
* provenance through this helper; the provider's repair reconciliation uses
* the same ordering rules.
* @param rows - audit records (already lifecycle-filtered by the caller).
* @returns the timeline, ascending by `time` then lexicographic request id.
*/
function deriveAuditTimeline(rows) {
	return [...rows].sort((a, b) => a.time - b.time || String(a.requestId).localeCompare(String(b.requestId))).map((row) => {
		const finished = row.finished;
		const certified = finished !== void 0 && (finished.outcome === "success" || finished.outcome === "repair");
		return {
			requestId: String(row.requestId),
			time: row.time,
			request: row.request,
			finished,
			certified,
			certifiedRevision: certified && finished !== void 0 && finished.outcome !== void 0 ? finished.revision : void 0
		};
	});
}
/**
* The highest revision any success or repair finished phase certifies across
* one lifecycle's audit rows. Used by startup reconciliation to decide whether
* the committed sessions-table stable still lacks a durable credential.
* @param rows - audit records of one lifecycle.
* @returns the highest certified revision, or 0 when none is certified.
*/
function highestCertifiedRevision(rows) {
	let latest = 0;
	for (const row of rows) {
		const finished = row.finished;
		if (finished === void 0) continue;
		if (finished.outcome !== "success" && finished.outcome !== "repair") continue;
		if (finished.revision > latest) latest = finished.revision;
	}
	return latest;
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
function selectRepairRow(rows, committedRevision) {
	let newest;
	for (const row of rows) {
		if (row.finished !== void 0 || row.request.revision !== committedRevision) continue;
		if (newest === void 0 || row.time > newest.time || row.time === newest.time && String(row.requestId) > String(newest.requestId)) newest = row;
	}
	return newest;
}
/**
* Filter audit rows to those fenced to one exact session lifecycle.
* @param rows - all audit records of one session id.
* @param identity - the lifecycle identity to keep.
* @returns matching rows; a mismatched record is never touched by the caller.
*/
function rowsForLifecycle(rows, identity) {
	return rows.filter((row) => row.session.createdAt === identity.createdAt && row.session.cwd === identity.cwd);
}
//#endregion
//#region lib/types/internal/task-state/contract/index.js
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
/**
* The read-only task-state service (`ctx.taskState`). Providers publish each
* live Session's committed stable pointer only after their authoritative
* storage-domain put succeeds; reads are synchronous so prompt assembly never
* performs storage I/O. A durable stable that does not match the current
* Session lifecycle identity is never published.
*/
var TaskStateService = class extends Service {
	constructor(ctx) {
		super(ctx, "taskState");
	}
};
//#endregion
export { TaskStateRequestId as S, taskStateStableContentSchema as _, openAuditRow as a, taskStateTodoReferenceSchema as b, taskStateAuditSchema as c, taskStateContinuationSchema as d, taskStateEntryIdSchema as f, taskStateSessionIdentitySchema as g, taskStateRequestIdSchema as h, highestCertifiedRevision as i, taskStateCandidateEntrySchema as l, taskStateRecordSchema as m, deriveAuditTimeline as n, rowsForLifecycle as o, taskStateEvidenceReferenceSchema as p, finishAuditRow as r, selectRepairRow as s, TaskStateService as t, taskStateCandidateSchema as u, taskStateStableEntrySchema as v, TaskStateEntryId as x, taskStateStableSchema as y };
