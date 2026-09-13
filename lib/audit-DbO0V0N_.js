import { At as boolean, Et as array, Rn as string, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-B9RBVgB9.js";
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
/** The three-state authority vocabulary of one named view. */
const taskStateAuthorityStatusSchema = _enum([
	"current",
	"cleared",
	"none"
]);
/**
* The authoritative Goal view committed with one stable. Every optional field
* is absent unless the view is `current`: a cleared or never-established goal
* carries no identity, revision, phase, or objective that a reader could
* mistake for a live goal.
*/
const taskStateGoalViewSchema = object({
	status: taskStateAuthorityStatusSchema,
	goalId: nonEmptyTrimmed$1.optional(),
	goalRevision: positiveSafeInteger.optional(),
	phase: nonEmptyTrimmed$1.optional(),
	objective: nonEmptyTrimmed$1.optional()
}).superRefine((value, ctx) => {
	if (value.status !== "current" && (value.goalId !== void 0 || value.goalRevision !== void 0 || value.phase !== void 0 || value.objective !== void 0)) ctx.addIssue({
		code: "custom",
		message: "a non-current goalView carries no goal identity, revision, phase, or objective"
	});
});
/** One item of the authoritative TODO view. */
const taskStateTodoViewItemSchema = object({
	content: nonEmptyTrimmed$1,
	status: nonEmptyTrimmed$1
});
/**
* The authoritative TODO view committed with one stable. Items exist only
* while the view is `current`: a cleared list carries an empty item list, so a
* cleared TODO can never render as a live list.
*/
const taskStateTodoViewSchema = object({
	status: taskStateAuthorityStatusSchema,
	sourceSeq: nonNegativeSafeInteger$1.optional(),
	items: array(taskStateTodoViewItemSchema)
}).superRefine((value, ctx) => {
	if (value.status !== "current" && value.items.length > 0) ctx.addIssue({
		code: "custom",
		message: "a non-current todoView carries no items"
	});
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
	evidence: array(taskStateEvidenceReferenceSchema)
};
/**
* Kinded entry and reference lists of one committed stable, plus the
* Host-derived authoritative views. The candidate shape deliberately lacks
* `todoReferences`, `goalView`, and `todoView`: those are Host-owned and a
* model-proposed value for any of them is not part of the candidate contract.
*/
const stableShape = {
	facts: array(taskStateStableEntrySchema),
	decisions: array(taskStateStableEntrySchema),
	constraints: array(taskStateStableEntrySchema),
	risks: array(taskStateStableEntrySchema),
	evidence: array(taskStateEvidenceReferenceSchema),
	todoReferences: array(taskStateTodoReferenceSchema),
	goalView: taskStateGoalViewSchema,
	todoView: taskStateTodoViewSchema
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
* The inherited fork boundary schema. It is additive metadata of one lifecycle:
* a stable or audit row written by a lifecycle that BEGAN on an inherited prefix
* carries it, and every other record legitimately omits it.
*/
const taskStateInheritedPrefixSchema = object({
	source: literal("fork-prefix"),
	ownBoundarySeq: nonNegativeSafeInteger$1,
	inheritedThroughSeq: nonNegativeSafeInteger$1.nullable(),
	parentSession: nonEmptyTrimmed$1.optional()
});
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
	digest: nonEmptyTrimmed$1,
	inherited: taskStateInheritedPrefixSchema.optional()
}).superRefine(rejectDuplicateIds);
/**
* Stable generation schema carried by every durable terminal verdict. It is
* stored WITH the verdict (never re-derived from memory) so a restart or a
* later commit can decide whether the measured cause still applies.
*/
const taskStateTerminalGenerationSchema = object({
	baseSourceCursor: number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
	baseFilterVersion: nonEmptyTrimmed$1,
	baseDigest: nonEmptyTrimmed$1,
	maxInputBytes: positiveSafeInteger
}).strict();
/** Shared scalar fields of every terminal verdict variant. */
const terminalCommonShape = {
	requestId: taskStateRequestIdSchema,
	generation: taskStateTerminalGenerationSchema,
	cursor: nonNegativeSafeInteger$1,
	code: literal("BUDGET"),
	reason: nonEmptyTrimmed$1,
	trigger: _enum([
		"startup",
		"threshold",
		"urgent",
		"trailing",
		"manual"
	]).optional(),
	time: nonNegativeSafeInteger$1
};
/**
* Terminal provenance schema of one durable QUARANTINED infeasible window. The
* request id is branded by the shared {@link taskStateRequestIdSchema} so the
* parsed record carries the same opaque identity the audit row is keyed by;
* `includedSeqs` must name at least the one quarantined sequence, because a
* terminal verdict that quarantined nothing would be a pure cursor advance.
*/
const taskStateQuarantinedVerdictSchema = object({
	kind: literal("quarantined"),
	...terminalCommonShape,
	includedSeqs: array(nonNegativeSafeInteger$1).min(1)
}).strict();
/**
* Terminal provenance schema of a measured non-event cause: an oversized base
* stable, or an oversized authority fact that may never be skipped. The schema
* has NO `includedSeqs`: nothing was quarantined, and the cursor stays on the
* committed floor.
*/
const taskStateBlockedVerdictSchema = object({
	kind: _enum(["blockBaseOverBudget", "blockAuthorityFact"]),
	...terminalCommonShape,
	blockSeq: nonNegativeSafeInteger$1.optional(),
	blockType: nonEmptyTrimmed$1.optional()
}).strict();
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
const taskStateTerminalSchema = union([taskStateQuarantinedVerdictSchema, taskStateBlockedVerdictSchema]);
/**
* One whole-Session durable record. `stable` is optional because a terminal
* verdict must be persistable BEFORE the Session's first commit; `terminal` is
* optional because most sessions never hit an infeasible window. Unknown
* members fail the record (fail closed on a foreign or future shape).
*/
const taskStateRecordSchema = object({
	session: taskStateSessionIdentitySchema,
	stable: taskStateStableSchema.optional(),
	terminal: taskStateTerminalSchema.optional()
}).strict();
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
function terminalGeneration(base, maxInputBytes) {
	return {
		baseSourceCursor: base === null ? -1 : base.sourceCursor,
		baseFilterVersion: base === null ? "none" : base.filterVersion,
		baseDigest: base === null ? "none" : base.digest,
		maxInputBytes
	};
}
/**
* Whether two stored generations describe the same measurable situation.
* @param left - one durable generation.
* @param right - the generation measured now.
* @returns true when the verdict may NOT be re-opened.
*/
function sameTerminalGeneration(left, right) {
	return left.baseSourceCursor === right.baseSourceCursor && left.baseFilterVersion === right.baseFilterVersion && left.baseDigest === right.baseDigest && left.maxInputBytes === right.maxInputBytes;
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
function activeTerminalBlock(verdict, current) {
	if (verdict === void 0 || verdict.kind === "quarantined") return void 0;
	return sameTerminalGeneration(verdict.generation, current) ? verdict : void 0;
}
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
		trigger: _enum([
			"startup",
			"threshold",
			"urgent",
			"trailing",
			"manual"
		]).optional(),
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
		})).default([]),
		inherited: taskStateInheritedPrefixSchema.optional()
	})
});
/** One permissive finished-phase view used to validate a restored row. */
const taskStateAuditFinishedSchema = object({
	outcome: _enum([
		"success",
		"failure",
		"manual",
		"repair",
		"terminal-infeasible",
		"aborted"
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
* Classify one audit row into its semantic state:
* - `committed`: success, manual edit, or certified repair;
* - `terminal-infeasible`: permanent budget failure or explicitly quarantined terminal attempt;
* - `aborted`: cancelled or in-flight un-settled attempt;
* - `transient-failure`: non-terminal failure eligible for subsequent retry.
* @param row - the audit record to classify.
* @returns the four-way audit classification.
*/
function classifyAuditRow(row) {
	if (row.finished === void 0) return "aborted";
	const outcome = row.finished.outcome;
	if (outcome === "success" || outcome === "manual" || outcome === "repair") return "committed";
	if (outcome === "terminal-infeasible") return "terminal-infeasible";
	if (outcome === "aborted") return "aborted";
	const code = row.finished.error?.code;
	if (code === "ABORTED" || code === "SERVICE_DISPOSED") return "aborted";
	if (code === "BUDGET") return "terminal-infeasible";
	return "transient-failure";
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
		const certified = finished !== void 0 && (finished.outcome === "success" || finished.outcome === "manual" || finished.outcome === "repair");
		return {
			requestId: String(row.requestId),
			time: row.time,
			request: row.request,
			finished,
			certified,
			certifiedRevision: certified && finished !== void 0 && finished.outcome !== void 0 ? finished.revision : void 0,
			classification: classifyAuditRow(row)
		};
	});
}
/**
* The highest revision any model, manual, or repair finished phase certifies across
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
		if (finished.outcome !== "success" && finished.outcome !== "manual" && finished.outcome !== "repair") continue;
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
export { taskStateTodoViewItemSchema as A, taskStateSessionIdentitySchema as C, taskStateTerminalGenerationSchema as D, taskStateStableSchema as E, terminalGeneration as M, TaskStateEntryId as N, taskStateTerminalSchema as O, TaskStateRequestId as P, taskStateRequestIdSchema as S, taskStateStableEntrySchema as T, taskStateEvidenceReferenceSchema as _, openAuditRow as a, taskStateQuarantinedVerdictSchema as b, taskStateAuditSchema as c, taskStateAuthorityStatusSchema as d, taskStateBlockedVerdictSchema as f, taskStateEntryIdSchema as g, taskStateContinuationSchema as h, highestCertifiedRevision as i, taskStateTodoViewSchema as j, taskStateTodoReferenceSchema as k, activeTerminalBlock as l, taskStateCandidateSchema as m, deriveAuditTimeline as n, rowsForLifecycle as o, taskStateCandidateEntrySchema as p, finishAuditRow as r, selectRepairRow as s, classifyAuditRow as t, sameTerminalGeneration as u, taskStateGoalViewSchema as v, taskStateStableContentSchema as w, taskStateRecordSchema as x, taskStateInheritedPrefixSchema as y };
