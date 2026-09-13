import { E as taskStateStableSchema, M as terminalGeneration, N as TaskStateEntryId, P as TaskStateRequestId, a as openAuditRow, c as taskStateAuditSchema, i as highestCertifiedRevision, l as activeTerminalBlock, m as taskStateCandidateSchema, o as rowsForLifecycle, r as finishAuditRow, s as selectRepairRow, u as sameTerminalGeneration, x as taskStateRecordSchema } from "./audit-DbO0V0N_.js";
import { a as TaskStateService } from "./contract-C2nAZOQi.js";
import { a as createUserMessage, d as MAX_TIMER_DELAY_MS, f as deadline, i as contentHasImage, m as Schema, p as timeoutOf, t as BlockAssembler } from "./lib-UkEFLxaM.js";
import { n as defineDomain, r as domainTable } from "./lib-Bq6jN40l.js";
import { a as MARKER_BYTES, i as isEligibleType, n as TASK_STATE_FILTER_VERSION, o as boundUtf8, r as filterEvent, t as DEFAULT_FILTER_FIELD_LIMITS } from "./filter-CczOGkqh.js";
import { Service } from "@deepseek-ai/cordis";
import { createHash, randomUUID } from "node:crypto";
import { Buffer as Buffer$1 } from "node:buffer";
//#region lib/types/internal/task-state/basic/domain.js
/**
* Storage-domain declaration for authoritative durable task state. The
* provider opens this one process-global domain with the `single` layout so a
* damaged or incompatible document fails activation loudly as a whole instead
* of being read as an empty medium.
*
* Two tables:
* - `sessions`, keyed directly by the Session id, holds the authoritative
*   lifecycle-fenced record: identity, the latest committed stable WHEN one
*   exists, and the latest durable terminal verdict WHEN one was measured;
* - `audit`, keyed by the Host-minted request id, holds the per-request
*   open/finished phases (the pre-dispatch request evidence and its outcome).
*
* ATOMIC BOUNDARY (measured against the DSH storage API, not assumed): the
* domain layer serializes writes on ONE per-domain chain, but every
* `KvTable.put` is its own durable unit operation — in the `single` layout each
* one republishes the WHOLE document (`dsh-storage-json` `writeAtomic`). Two
* table puts are therefore two whole-file replacements, and there is NO
* cross-table transaction to be had (the domain contract says so explicitly).
* The only atomic durable boundary available to this plugin is ONE record in
* ONE table. That is why the optional stable, the optional terminal verdict,
* and the cursor the verdict carries all live inside the ONE `sessions` record:
* a terminal verdict and the committed state it advances are written by a
* single put, and a crash between them is impossible by construction. The
* `audit` table is diagnostic and is written strictly AFTER that authority put,
* so a lost audit row is a diagnostic gap and never a state claim.
*
* CLEAN BREAK (explicitly authorized): this generation is a NEW domain identity
* `context_enhancement_task_state_v2` at version 2. The previous
* `context_enhancement_task_state` v1 document is never read, never opened,
* never migrated and never rewritten — it is not even the unit this descriptor
* resolves to (the JSON backend derives the file name from the domain name).
* `version: 2` additionally makes a document stamped for another format version
* reject the whole open (`version-mismatch`), which is the fail-closed lever
* for any document that does carry this name.
* @module dsh-context-enhancement/internal/task-state/basic/domain
*/
/**
* Domain identity and durable schemas of the authoritative task-state store.
* The name is deliberately deployment-owned and version-suffixed so an install
* of this bundle never collides with an upstream `task_state` domain of a
* different format — and so the incompatible v1 document of this same plugin is
* left untouched on the medium instead of being reinterpreted.
*/
const taskStateDomainSpec = defineDomain({
	name: "context_enhancement_task_state_v2",
	version: 2,
	layout: "single",
	tables: {
		sessions: domainTable(taskStateRecordSchema),
		audit: domainTable(taskStateAuditSchema)
	}
});
//#endregion
//#region lib/types/internal/task-state/basic/config.js
/**
* Load-time validation and detachment of the task-state-basic deployment
* policy. Every field is explicit and required from the composition; no
* repository default hardcodes a deployment choice.
*
* The Loader-facing schema lives inline on the service class (`static Config`)
* so the config catalog's static walker can enumerate every validated key;
* this module owns the raw-key set and the direct-construction validation used
* when a caller mounts the plugin without Loader normalization.
* @module dsh-context-enhancement/internal/task-state/basic/config
*/
/** Complete configuration key set. */
const CONFIG_KEYS = /* @__PURE__ */ new Set([
	"provider",
	"model",
	"minEvents",
	"maxEvents",
	"maxInputBytes",
	"maxOutputTokens",
	"timeoutMs",
	"maxInfraRetries",
	"maxEntriesPerKind",
	"maxEntryBytes",
	"maxListItems"
]);
function assertSafeInteger(name, value) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`task-state-basic: ${name} must be a positive safe integer`);
}
/**
* Validate and detach one task-state-basic configuration object (used when a
* caller constructs the plugin directly without Loader schema normalization).
* @param config - raw deployment configuration.
* @returns a detached immutable policy.
*/
function resolveTaskStateBasicConfig(config) {
	const value = config;
	if (value === null || typeof value !== "object") throw new Error("task-state-basic: configuration is required");
	const record = value;
	for (const key of Object.keys(record)) if (!CONFIG_KEYS.has(key)) throw new Error(`task-state-basic: unknown config key "${key}"`);
	if (typeof record.provider !== "string" || record.provider.length === 0 || typeof record.model !== "string" || record.model.length === 0) throw new Error("task-state-basic: provider and model must be non-empty strings");
	assertSafeInteger("minEvents", record.minEvents);
	assertSafeInteger("maxEvents", record.maxEvents);
	assertSafeInteger("maxInputBytes", record.maxInputBytes);
	assertSafeInteger("maxOutputTokens", record.maxOutputTokens);
	if (!Number.isSafeInteger(record.timeoutMs) || record.timeoutMs <= 0 || record.timeoutMs > 2147483647) throw new Error(`task-state-basic: timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isSafeInteger(record.maxInfraRetries) || record.maxInfraRetries < 0) throw new Error("task-state-basic: maxInfraRetries must be a non-negative safe integer");
	assertSafeInteger("maxEntriesPerKind", record.maxEntriesPerKind);
	assertSafeInteger("maxEntryBytes", record.maxEntryBytes);
	assertSafeInteger("maxListItems", record.maxListItems);
	if (record.maxEvents < record.minEvents) throw new Error("task-state-basic: maxEvents must be greater than or equal to minEvents");
	return Object.freeze({ ...record });
}
//#endregion
//#region lib/types/internal/task-state/basic/authority.js
/**
* Authoritative Goal/TODO view resolution for one folded batch window.
*
* Goal and TODO are NOT ordinary appended facts: each is a named view whose
* value is decided by the NEWEST durable authority fact in the window, so a new
* revision REPLACES the previous value and an explicit clear REMOVES it. This
* module is the single Host-owned resolution used by every reader of a window:
*
* - the model-visible frame (`prompt.ts`) publishes the resolved views and the
*   replace/clear provenance so the auxiliary model is told what changed;
* - Host semantic validation (`host.ts`) commits the resolved views verbatim,
*   so a model that echoes a superseded goal or a cleared list cannot merge it
*   back into the authoritative state.
*
* Real DSH event contracts resolved here (verified against the harness
* packages, not assumed):
* - `goal/change` carries either a complete post-mutation snapshot
*   (`{ kind, version: 1, operation: 'create'|'edit'|'pause'|'resume'|
*   'complete'|'block', goal: { id, revision, objective, phase,
*   maxGoalRounds }, roundsStarted, createdAt, updatedAt }`) or a clear
*   tombstone (`{ kind, version: 1, operation: 'clear', cleared: { id,
*   revision }, clearedAt }`);
* - `todo/write` carries a whole replacement list (`{ todos: TodoItem[] }`),
*   so the latest write wins and `{ todos: [] }` is the legal explicit clear.
*
* Windows without an authority fact for one view CARRY THAT VIEW FORWARD from
* the committed base — the absence of a new fact never erases an existing
* authoritative value, and it never re-merges a superseded one either.
* @module dsh-context-enhancement/internal/task-state/basic/authority
*/
/** The absent Goal view: no authority fact ever established one. */
const NO_GOAL_VIEW = Object.freeze({ status: "none" });
/** The absent TODO view: no authority fact ever established one. */
const NO_TODO_VIEW = Object.freeze({
	status: "none",
	items: Object.freeze([])
});
/** The authority fact types whose observation is urgent (never waits for `minEvents`). */
const AUTHORITY_EVENT_TYPES = /* @__PURE__ */ new Set(["goal/change", "todo/write"]);
/**
* Whether one Session event type is an authority fact type. The provider uses
* this on the synchronous observer stack to decide that the observation needs
* an urgent scheduling request; it reads only the event TYPE, so the
* synchronous stack never projects, reads storage, or calls a model.
* @param type - the Session event type.
* @returns true for `goal/change` and `todo/write`.
*/
function isAuthorityEventType(type) {
	return AUTHORITY_EVENT_TYPES.has(type);
}
/** Read the projected fields of one filtered event as a JSON record. */
function fieldsOf(event) {
	const fields = event.fields;
	return typeof fields === "object" && fields !== null ? fields : {};
}
/** Resolve the Goal view a single `goal/change` projection states. */
function goalViewOf(event) {
	const fields = fieldsOf(event);
	if (fields["kind"] !== "goal/change") return void 0;
	const operation = typeof fields["operation"] === "string" ? fields["operation"] : void 0;
	if (operation === void 0) return void 0;
	if (operation === "clear") return { status: "cleared" };
	const goal = fields.goal;
	if (goal === void 0 || typeof goal !== "object" || goal === null) return;
	const view = { status: "current" };
	if (typeof goal.id === "string" && goal.id.length > 0) view.goalId = goal.id;
	if (typeof goal.revision === "number" && Number.isSafeInteger(goal.revision) && goal.revision > 0) view.goalRevision = goal.revision;
	if (typeof goal.phase === "string" && goal.phase.length > 0) view.phase = goal.phase;
	if (typeof goal.objective === "string" && goal.objective.length > 0) view.objective = goal.objective;
	return view;
}
/** Resolve the TODO view a single `todo/write` projection states. */
function todoViewOf(event) {
	const fields = fieldsOf(event);
	if (fields["kind"] !== "todo/write") return void 0;
	const projected = fields;
	const raw = Array.isArray(projected.todos) ? projected.todos : void 0;
	if (projected.status === "cleared" || raw !== void 0 && raw.length === 0) return {
		status: "cleared",
		sourceSeq: event.seq,
		items: []
	};
	if (raw === void 0) return void 0;
	const items = [];
	for (const item of raw) {
		const content = typeof item.content === "string" ? item.content : "";
		const status = typeof item.status === "string" ? item.status : "";
		if (content.length === 0) continue;
		items.push({
			content,
			status: status.length === 0 ? "pending" : status
		});
	}
	return {
		status: "current",
		sourceSeq: event.seq,
		items
	};
}
/** Whether two Goal views state the same authoritative value. */
function sameGoalView(left, right) {
	return left.status === right.status && left.goalId === right.goalId && left.goalRevision === right.goalRevision && left.phase === right.phase && left.objective === right.objective;
}
/** Whether two TODO views state the same authoritative value. */
function sameTodoView(left, right) {
	if (left.status !== right.status || left.items.length !== right.items.length) return false;
	for (let index = 0; index < left.items.length; index += 1) {
		const a = left.items[index];
		const b = right.items[index];
		if (a === void 0 || b === void 0) return false;
		if (a.content !== b.content || a.status !== b.status) return false;
	}
	return true;
}
/**
* Derive the bounded TODO reference implied by one authoritative TODO view:
* exactly one reference pointing at the winning `todo/write` sequence, or none
* at all when the view is not `current`. The reference is Host-authored, so a
* cleared list can never leave a stale reference behind and the auxiliary model
* can never resurrect one.
* @param view - the resolved authoritative TODO view.
* @param maxEntryBytes - configured byte bound for the reference content.
* @returns zero or one bounded reference.
*/
function todoReferencesOf(view, maxEntryBytes) {
	if (view.status !== "current" || view.sourceSeq === void 0) return [];
	if (maxEntryBytes < MARKER_BYTES) return [];
	const parts = [];
	for (const item of view.items) {
		const content = item.content.trim();
		if (content.length === 0) continue;
		parts.push(`${content} [${item.status}]`);
	}
	if (parts.length === 0) return [];
	const text = boundUtf8(parts.join("; "), maxEntryBytes).text;
	if (text.length === 0) return [];
	return [{
		seq: view.sourceSeq,
		content: text
	}];
}
/**
* Resolve the authoritative Goal/TODO views of one folded window against the
* committed base.
*
* The newest authority fact in the window wins for its own view; a window
* without one carries the base view forward (or `none` when no base exists).
* Replace and clear provenance is computed by comparing the resolved view with
* the base view, so "changed" means the authoritative value really differs and
* "cleared" means this window is what removed a value that still existed.
* @param events - the folded window's projections, ascending by sequence.
* @param base - the committed base stable, or `null` before the first commit.
* @param limits - the configured byte bound for a derived TODO reference content.
* @returns the complete resolution for this window.
*/
function resolveAuthorityViews(events, base, limits) {
	const baseGoal = base?.goalView ?? NO_GOAL_VIEW;
	const baseTodo = base?.todoView ?? NO_TODO_VIEW;
	let goalView;
	let todoView;
	for (const event of events) {
		const goal = goalViewOf(event);
		if (goal !== void 0) goalView = goal;
		const todo = todoViewOf(event);
		if (todo !== void 0) todoView = todo;
	}
	const resolvedGoal = goalView ?? baseGoal;
	const resolvedTodo = todoView ?? baseTodo;
	const goalChanged = goalView !== void 0 && !sameGoalView(resolvedGoal, baseGoal);
	const todoChanged = todoView !== void 0 && !sameTodoView(resolvedTodo, baseTodo);
	const changed = [];
	const cleared = [];
	if (goalChanged) changed.push("goal");
	if (todoChanged) changed.push("todo");
	if (goalChanged && resolvedGoal.status === "cleared" && baseGoal.status === "current") cleared.push("goal");
	if (todoChanged && resolvedTodo.status === "cleared" && baseTodo.status === "current") cleared.push("todo");
	return {
		goalView: resolvedGoal,
		todoView: resolvedTodo,
		changed,
		cleared,
		todoReferences: todoReferencesOf(resolvedTodo, limits.maxEntryBytes),
		goalChanged,
		todoChanged
	};
}
/**
* Classify one newly observed authority event: does observing it require an
* urgent wave, and for which view?
*
* - any `todo/write` is urgent: the whole list is replaced by that one fact, so
*   a clear or mutation that waits for `minEvents` leaves a stale list injected;
* - a `goal/change` is urgent only when it actually changes the authoritative
*   Goal view relative to the committed base. A fact that restates the view
*   already committed (or states no goal value at all) carries nothing new and
*   must not force a wave on its own.
* @param event - the projection of one observed authority event.
* @param base - the committed base stable, or `null`.
* @returns the urgent view name, or `undefined` when no urgent wave is warranted.
*/
function authorityUrgency(event, base) {
	if (event.type === "todo/write") return todoViewOf(event) === void 0 ? void 0 : "todo";
	if (event.type !== "goal/change") return void 0;
	const goal = goalViewOf(event);
	if (goal === void 0) return void 0;
	return sameGoalView(goal, base?.goalView ?? NO_GOAL_VIEW) ? void 0 : "goal";
}
/**
* The pinned auxiliary system instruction. It describes the exact expected
* output as JSON (facts, decisions, constraints, risks, evidence, and
* continuation state), the Host-owned id rules, the authoritative Goal/TODO
* view rules, and the constraints the Host enforces.
*/
const TASK_STATE_SYSTEM_INSTRUCTION = [
	"You are the durable task-state updater for one AI coding-assistant session. Update the previous durable task state from the supplied projection of recent session events.",
	"",
	"Return ONLY one JSON object with EXACTLY these fields:",
	"{",
	"  \"facts\": [{ \"content\": \"string\" } | { \"id\": \"fact-<uuid>\", \"content\": \"string\" }],",
	"  \"decisions\": [{ \"content\": \"string\" } | { \"id\": \"decision-<uuid>\", \"content\": \"string\" }],",
	"  \"constraints\": [{ \"content\": \"string\" } | { \"id\": \"constraint-<uuid>\", \"content\": \"string\" }],",
	"  \"risks\": [{ \"content\": \"string\" } | { \"id\": \"risk-<uuid>\", \"content\": \"string\" }],",
	"  \"evidence\": [{ \"seq\": <number>, \"note\": \"string\" }],",
	"  \"continuation\": {",
	"    \"currentObjective\": \"string\",",
	"    \"currentFocus\": \"string\",",
	"    \"openWork\": [\"string\"],",
	"    \"nextActions\": [\"string\"]",
	"  }",
	"}",
	"",
	"Authoritative Goal and TODO views:",
	"- `authorityViews.goal` and `authorityViews.todo` in the input are AUTHORITATIVE views the Host resolved from the newest durable `goal/change` and `todo/write` facts of this exact window. They are not yours to write: the output schema above has no field for them and anything you emit for them is ignored.",
	"- A new goal revision REPLACES the previous goal outright; `authorityViews.changed` names every view whose committed value this window changed (a clear is a change), and `authorityViews.cleared` names the subset of those views this window emptied (a goal clear tombstone, or a whole-list TODO write carrying an empty list).",
	"- When `changed` or `cleared` names `goal`, the superseded objective is gone: never restate it, and never carry the old goal into `continuation.currentObjective` or `openWork`. State the objective that the authoritative view states, or nothing when the goal was cleared.",
	"- When `changed` or `cleared` names `todo`, the previous TODO list is gone. Never restate cleared items anywhere, and never treat the TODO list as yours to maintain: it is reproduced from the authoritative view, not from your output.",
	"",
	"Rules:",
	"- A NEW fact, decision, constraint, or risk OMITS the id: the Host mints one with the matching prefix.",
	"- An entry CARRIED FORWARD from the previous state ECHOES its exact existing id verbatim. Do not invent, rename, or change any id prefix.",
	"- An entry you remove entirely disappears; never edit the content of an entry whose id you echo — drop it and add a new entry without an id when the content changes materially.",
	"- Keep the four kinded lists authoritative and deduplicated: same fact in several lists is wrong.",
	"- `evidence` references the exact `seq` values listed as eligible in the projection; every note explains what the reference supports in one short sentence. Never reference a seq the projection did not list.",
	"- `continuation.currentObjective` is the human task objective in force; `currentFocus` what is being worked on; `openWork` concrete unfinished work; `nextActions` concrete next steps. TODO stays separate and never merges into these fields.",
	"- Empty lists are `[]`. Preserve exact file paths, commands, queries, error strings, identifiers, and numeric values.",
	"- Keep every string short enough that the total output fits the reported byte budget. Output ONLY the JSON object: no Markdown fence, no commentary, no tool call."
].join("\n");
/**
* Build the deterministic model-visible input frame for one batch. The frame
* is the owned JSON that filter v3 reconstructs from the exact included
* sequences: previous stable content (or null), the authoritative Goal/TODO
* views of this exact window with their replace/clear provenance, the filter
* version, the input schema version, the deterministic event projections, and
* the truncation records. The caller bounds the serialized frame to the batch
* input budget.
*
* The frame's `authorityViews` block is what conveys the replace/clear
* semantics to the model: `changed` lists the views this window replaced with
* a newer authority fact and `cleared` lists the views it emptied, so a window
* holding no authority fact is plainly the ordinary fact-delta case. Ordinary
* windows are NOT replayed as stable content — the event projections stay the
* same bounded delta they always were.
* @param input - base stable, projected events, and truncation records.
* @returns the serialized deterministic model-visible frame.
*/
function frameProjection(input) {
	const authority = resolveAuthorityViews(input.events, input.base, { maxEntryBytes: TASK_STATE_AUTHORITY_REFERENCE_BYTES });
	const frame = {
		previousStable: input.base === null ? null : contentOfStable(input.base),
		authorityViews: {
			goal: authority.goalView,
			todo: authority.todoView,
			changed: authority.changed,
			cleared: authority.cleared
		},
		filterVersion: TASK_STATE_FILTER_VERSION,
		inputSchemaVersion: 2,
		events: input.events.map((event) => ({
			seq: event.seq,
			type: event.type,
			fields: event.fields
		})),
		truncation: input.truncation
	};
	return JSON.stringify(frame);
}
/**
* Byte bound applied to the authority reference content inside the frame. The
* frame is a bounded model input, not a commit path, so it uses the shipped
* state-field bound rather than a deployment policy.
*/
const TASK_STATE_AUTHORITY_REFERENCE_BYTES = DEFAULT_FILTER_FIELD_LIMITS.stateBytes;
/** Stable content view (without Host commit metadata) handed to the model. */
function contentOfStable(stable) {
	return {
		facts: stable.facts,
		decisions: stable.decisions,
		constraints: stable.constraints,
		risks: stable.risks,
		evidence: stable.evidence,
		todoReferences: stable.todoReferences,
		goalView: stable.goalView,
		todoView: stable.todoView,
		continuation: stable.continuation
	};
}
//#endregion
//#region lib/types/internal/task-state/basic/host.js
/**
* Versioned Host semantic validation of one auxiliary task-state candidate
* against the committed base and the batch window. It parses nothing (the
* caller parses with `JSON.parse` and the contract schema), mints Host-owned
* branded ids for new entries, verifies echoed ids exist in the base, applies
* the complete-candidate update rules, bounds every retained value with the
* configured UTF-8 byte and item limits, keeps every evidence reference that
* points into the folded batch window while quarantining (dropping, with a
* diagnostic) any reference that points outside it, commits the authoritative
* Goal/TODO views the window resolved (never a model-proposed value), and
* computes the stable digest over the normalized content. A semantic failure
* still rejects the complete candidate; the previous stable and cursor stay
* untouched.
* @module dsh-context-enhancement/internal/task-state/basic/host
*/
/** Kinded list names in committed order, each paired with its entry-id kind prefix. */
const KINDS = [
	["facts", "fact"],
	["decisions", "decision"],
	["constraints", "constraint"],
	["risks", "risk"]
];
/**
* Verify one candidate parses against the contract candidate schema.
* @param raw - the parsed model output to validate.
* @returns the schema-validated candidate content.
* @throws when the value does not satisfy the contract candidate schema.
*/
function parseCandidate(raw) {
	const parsed = taskStateCandidateSchema.safeParse(raw);
	if (!parsed.success) throw new Error(`task-state-basic: candidate failed the durable schema: ${parsed.error.message}`);
	return parsed.data;
}
/** Mint one opaque kind-prefixed branded id (`fact-<uuid>`). */
function mintId(prefix) {
	return TaskStateEntryId(`${prefix}-${randomUUID()}`);
}
/** Bound one retained entry or continuation field to the configured byte limit. */
function boundEntry(text, limitBytes) {
	return boundUtf8(text, limitBytes).text;
}
/**
* Normalize one parsed candidate into committed content. Steps, in order:
* check per-kind count and per-list item limits; bound every retained entry,
* continuation field, and evidence note; verify every echoed id exists in the
* base, is used in the list whose kind matches its prefix, echoes the base
* content VERBATIM, and is unique across the complete candidate; mint ids for
* every new entry; keep every evidence reference whose sequence is one of the
* exact folded eligible sequences while QUARANTINING (dropping, with a
* diagnostic) any reference pointing outside the window — a stale reference
* carried forward from a previous window can never become eligible again, so
* failing the whole candidate on it would freeze every future update at the
* last committed revision; commit the Host-resolved authoritative Goal/TODO
* views and their derived TODO reference from `context.authority`; then
* validate the fully id-ed content against the committed-content schema. No
* sequence is ever fabricated for a quarantined reference: only the invalid
* reference is dropped, valid references and every other summary field are
* preserved.
* @param candidate - parsed and schema-validated candidate content.
* @param context - durable base and folded-window facts.
* @param onQuarantine - optional observer of each dropped stale reference.
* @returns the normalized committed content.
*/
function normalizeCandidate(candidate, context, onQuarantine) {
	const { limits } = context;
	const checkCount = (kind) => {
		const list = candidate[kind];
		if (list.length > limits.maxEntriesPerKind) throw new Error(`task-state-basic: candidate ${kind} has ${list.length} entries, exceeding maxEntriesPerKind ${limits.maxEntriesPerKind}`);
	};
	checkCount("facts");
	checkCount("decisions");
	checkCount("constraints");
	checkCount("risks");
	/** The exact base entry one echoed id names, or `undefined`. */
	const baseEntryById = /* @__PURE__ */ new Map();
	for (const entry of context.base?.entries ?? []) baseEntryById.set(entry.id, entry);
	const seenEchoed = /* @__PURE__ */ new Set();
	const kinded = {
		facts: [],
		decisions: [],
		constraints: [],
		risks: []
	};
	for (const [list, prefix] of KINDS) {
		const out = kinded[list];
		for (const entry of candidate[list]) {
			const content = boundEntry(entry.content, limits.maxEntryBytes);
			if (entry.id === void 0) {
				out.push({
					id: mintId(prefix),
					content
				});
				continue;
			}
			const id = String(entry.id);
			const baseEntry = baseEntryById.get(id);
			if (baseEntry === void 0) throw new Error(`task-state-basic: candidate echoes unknown entry id "${id}"`);
			if (seenEchoed.has(id)) throw new Error(`task-state-basic: candidate echoes entry id "${id}" more than once`);
			seenEchoed.add(id);
			if (baseEntry.kind !== prefix) throw new Error(`task-state-basic: candidate echoes "${id}" in ${list}, but the base holds it as a ${baseEntry.kind}`);
			if (content !== baseEntry.content) throw new Error(`task-state-basic: candidate echoes "${id}" with changed content; drop the id and add a new ${prefix} without an id when the content changes`);
			out.push({
				id: TaskStateEntryId(id),
				content
			});
		}
	}
	const boundNote = (note) => boundEntry(note, limits.maxEntryBytes);
	const quarantine = onQuarantine ?? (() => {});
	const evidence = [];
	for (const reference of candidate.evidence) {
		if (!context.includedSeqs.has(reference.seq)) {
			quarantine({
				kind: "evidence",
				seq: reference.seq
			});
			continue;
		}
		evidence.push({
			seq: reference.seq,
			note: boundNote(reference.note)
		});
	}
	if (evidence.length > limits.maxListItems) throw new Error(`task-state-basic: candidate evidence exceeds maxListItems ${limits.maxListItems}`);
	const { goalView, todoView, todoReferences } = context.authority;
	if (todoReferences.length > limits.maxListItems) throw new Error(`task-state-basic: derived todoReferences exceeds maxListItems ${limits.maxListItems}`);
	const openWork = candidate.continuation.openWork.map((item) => boundEntry(item, limits.maxEntryBytes));
	const nextActions = candidate.continuation.nextActions.map((item) => boundEntry(item, limits.maxEntryBytes));
	if (openWork.length > limits.maxListItems || nextActions.length > limits.maxListItems) throw new Error(`task-state-basic: continuation lists exceed maxListItems ${limits.maxListItems}`);
	const continuation = {
		currentObjective: boundEntry(candidate.continuation.currentObjective, limits.maxEntryBytes),
		currentFocus: boundEntry(candidate.continuation.currentFocus, limits.maxEntryBytes),
		openWork,
		nextActions
	};
	return {
		facts: kinded.facts,
		decisions: kinded.decisions,
		constraints: kinded.constraints,
		risks: kinded.risks,
		evidence,
		todoReferences: todoReferences.map((reference) => ({
			seq: reference.seq,
			content: reference.content
		})),
		goalView,
		todoView,
		continuation
	};
}
/**
* Compute the SHA-256 digest over one stable's normalized structured content.
* @param content - normalized committed content to digest.
* @returns lowercase hex digest of the content's JSON serialization.
*/
function digestOf(content) {
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
/**
* Build the committed stable from normalized content and Host-owned metadata.
* @param content - normalized committed content.
* @param schemaVersion - stable content schema version.
* @param revision - next monotonic revision (base revision + 1, or 1 first).
* @param filterVersion - deterministic input-filter version that produced the projection.
* @param sourceCursor - last eligible sequence actually folded.
* @param inherited - the inherited fork boundary this coverage stops at, or
*   `null`/absent when the lifecycle began on its own events. Metadata only: it
*   rides beside the digest and never enters the digested content.
* @returns the immutable committed stable.
*/
function commitStable(content, schemaVersion, revision, filterVersion, sourceCursor, inherited) {
	const stable = {
		schemaVersion,
		revision,
		filterVersion,
		sourceCursor,
		digest: digestOf(content),
		...inherited === void 0 || inherited === null ? {} : { inherited },
		...content
	};
	const check = taskStateStableSchema.safeParse(stable);
	if (!check.success) throw new Error(`task-state-basic: committed stable failed its durable schema: ${check.error.message}`);
	return stable;
}
//#endregion
//#region lib/types/internal/task-state/basic/inherited.js
/**
* The inherited fork boundary of one Session lifecycle, and the coverage fence
* that keeps a forked child from re-claiming its parent's facts.
*
* DSH seeds a forked child with the parent's prefix. Those events are durable
* HISTORY of the child: they are already part of the state the child inherited,
* they were never observed by the child's own lifecycle, and folding them again
* would report the parent's eligible events as new live facts of the child.
*
* The durable boundary is `Session.inheritedEventCount` — the length of the seed
* the child was created with, restored from the persisted `seedLength` header
* field. `Session.firstLiveSeq` is NOT a substitute: it is the in-process
* constructor seed length, so it equals the inherited count on a fresh fork and
* the WHOLE stored log length after a resume. This module therefore reads the
* boundary from `inheritedEventCount` alone.
*
* Two rules follow, and both are fail-closed:
*
* 1. A coverage claim below the boundary is impossible. The effective committed
*    cursor is `max(stored cursor, ownBoundarySeq - 1)`, so a record written
*    before this boundary existed (or damaged to claim coverage inside the
*    prefix) can never make the next window fold an inherited event.
* 2. A coverage claim whose recorded marker DISAGREES with the live boundary is
*    refused wholesale: the lifecycle re-derives from its own events above the
*    boundary instead of trusting a claim it cannot verify. The record's
*    content is still served — refusing a claim is not losing state — but its
*    provenance is not trusted for coverage.
*
* For every lifecycle that did not begin on an inherited prefix
* (`inheritedEventCount === 0`, which is every Session that was not forked) both
* rules are identity: the floor is `-1` and no marker can exist, so behavior is
* exactly what it was before the boundary contract existed.
* @module dsh-context-enhancement/internal/task-state/basic/inherited
*/
/** The cursor floor of a lifecycle with no inherited prefix. */
const NO_FLOOR = -1;
/**
* Read one Session's inherited fork boundary, or `null` when its lifecycle began
* on its own events.
*
* The boundary is the durable seeding length. An unseeded Session reports `0`,
* which is not a boundary but the absence of one: its own first event is seq 0,
* so there is nothing to exclude.
* @param session - live Session whose durable seeding length is read.
* @returns the inherited prefix record, or `null` for an unseeded lifecycle.
*/
function sessionInheritedPrefix(session) {
	const ownBoundarySeq = Number(session.inheritedEventCount);
	if (!Number.isSafeInteger(ownBoundarySeq) || ownBoundarySeq <= 0) return null;
	const parentSession = session.header.parentSession;
	return {
		source: "fork-prefix",
		ownBoundarySeq,
		inheritedThroughSeq: ownBoundarySeq - 1,
		...parentSession === void 0 ? {} : { parentSession: String(parentSession) }
	};
}
/**
* The lowest cursor one lifecycle may hold: its own boundary minus one.
*
* A lifecycle with no inherited prefix floors at `-1`, which is the same
* "nothing folded yet" value the provider used before this contract.
* @param prefix - the Session's inherited prefix, or `null`.
* @returns the inclusive cursor floor for every coverage claim of that lifecycle.
*/
function inheritedCursorFloor(prefix) {
	return prefix === null ? NO_FLOOR : prefix.ownBoundarySeq - 1;
}
/**
* Whether one recorded coverage claim must be REFUSED because its inherited
* marker disagrees with the live boundary.
*
* An absent marker is not a disagreement: it only means the record predates the
* marker (or the lifecycle is unseeded), and rule 1's floor already bounds it.
* A marker that names a different boundary, a different source, or a non-empty
* prefix on a lifecycle that has none is a claim this lifecycle cannot verify,
* and it is refused rather than merged.
* @param prefix - the LIVE inherited prefix of the Session, or `null`.
* @param marker - the inherited marker recorded on the stored coverage claim.
* @returns true when the claim's coverage provenance must not be trusted.
*/
function inheritedCoverageRefused(prefix, marker) {
	if (marker === void 0) return false;
	if (prefix === null) return true;
	return marker.source !== prefix.source || marker.ownBoundarySeq !== prefix.ownBoundarySeq;
}
//#endregion
//#region lib/types/internal/task-state/basic/batch.js
/**
* Deterministic batch-window fold for one task-state update: it walks the
* eligible Session events between the committed source cursor and one pending
* watermark, projects each through the versioned filter, and stops when the
* configured maximum eligible-event count or the maximum framed-input byte
* budget would be exceeded. The folded window is immutable once returned; the
* caller owns it for the whole update, so events arriving during the request
* only raise the pending watermark and produce a later trailing batch.
*
* The maximum framed-input budget constrains the COMPLETE deterministic model
* frame — the previous stable content, the event projections, the truncation
* metadata, and every framing wrapper — so an oversized first event or an
* oversized base stable can never bypass the budget. If field-level
* deterministic truncation has already run and even the smallest meaningful
* window cannot fit the budget, the fold reports `infeasible`: the caller
* records a terminal budget failure, never calls the model, and never
* advances the cursor.
* @module dsh-context-enhancement/internal/task-state/basic/batch
*/
/**
* Fold one immutable batch window over an owned slice of the Session log.
* Only events with a sequence above `cursor` and at or below `windowEndSeq`
* are candidates; an eligible event that projects no meaningful content is
* skipped (it neither enters the window nor advances the endpoint). Folding
* stops as soon as adding another event would exceed `budget.maxEvents` or
* `budget.maxInputBytes`. If the smallest meaningful window (the base frame
* plus one candidate) still exceeds the input budget, the fold is
* `infeasible` and must never dispatch a model call or advance the cursor.
* @param events - the Session's complete ordered events (read-only snapshot).
* @param base - committed base stable, or `null` before the first commit.
* @param cursor - committed source cursor; only sequences above it fold.
* @param windowEndSeq - inclusive pending watermark of this window.
* @param budget - validated event-count and byte budgets.
* @returns the folded window, `empty` when no meaningful eligible event lies
*   in the window, or `infeasible` when even one meaningful event cannot fit
*   the complete framed-input budget.
*/
function foldBatchWindow(events, base, cursor, windowEndSeq, budget) {
	const includedSeqs = [];
	const projected = [];
	const truncation = [];
	let sourceCursor = 0;
	let inputBytes = Buffer$1.byteLength(frameProjection({
		base,
		events: [],
		truncation: []
	}), "utf8");
	if (inputBytes > budget.maxInputBytes) return {
		kind: "infeasible",
		frameBytes: inputBytes,
		maxInputBytes: budget.maxInputBytes
	};
	for (const event of events) {
		if (event.seq <= cursor) continue;
		if (event.seq > windowEndSeq) break;
		if (projected.length >= budget.maxEvents) break;
		const filtered = filterEvent({
			type: event.type,
			seq: event.seq,
			data: event.data
		});
		if (filtered === null) continue;
		const candidate = {
			seq: filtered.event.seq,
			type: filtered.event.type,
			fields: filtered.event.fields
		};
		const nextEvents = [...projected, candidate];
		const nextTruncation = [...truncation, ...filtered.truncation];
		const nextBytes = Buffer$1.byteLength(frameProjection({
			base,
			events: nextEvents,
			truncation: nextTruncation
		}), "utf8");
		if (nextBytes > budget.maxInputBytes) {
			if (projected.length === 0) return {
				kind: "infeasible",
				frameBytes: nextBytes,
				maxInputBytes: budget.maxInputBytes
			};
			break;
		}
		projected.push(candidate);
		includedSeqs.push(candidate.seq);
		sourceCursor = candidate.seq;
		truncation.push(...filtered.truncation);
		inputBytes = nextBytes;
	}
	if (projected.length === 0) return { kind: "empty" };
	return {
		kind: "window",
		window: {
			includedSeqs,
			sourceCursor,
			events: projected,
			truncation,
			inputBytes
		}
	};
}
//#endregion
//#region lib/types/internal/task-state/basic/update.js
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
/** Stable Host-owned timeout code stamped on the deadline reason. */
const TASK_STATE_UPDATE_TIMEOUT_CODE = "task-state-basic/update-timeout";
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
async function runUpdateAttempt(attempt, hooks) {
	const requestId = TaskStateRequestId(`ts-${randomUUID()}`);
	const targetRevision = (attempt.base?.revision ?? 0) + 1;
	try {
		await hooks.putOpenAudit({
			requestId,
			revision: targetRevision,
			...attempt.trigger === void 0 ? {} : { trigger: attempt.trigger },
			base: attempt.base === null ? null : structuredClone(attempt.base),
			includedSeqs: [...attempt.includedSeqs],
			filterVersion: TASK_STATE_FILTER_VERSION,
			system: attempt.system,
			route: {
				provider: attempt.route.provider,
				model: attempt.route.model
			},
			maxTokens: attempt.maxOutputTokens,
			schema: { version: 2 },
			truncation: [...attempt.truncation],
			...attempt.inherited === void 0 || attempt.inherited === null ? {} : { inherited: attempt.inherited }
		});
	} catch (error) {
		return {
			ok: false,
			failure: {
				stage: "request",
				code: "AUDIT",
				message: error instanceof Error ? `task-state-basic: open-phase audit could not be made durable before dispatch: ${error.message}` : "task-state-basic: open-phase audit could not be made durable before dispatch"
			}
		};
	}
	const timed = deadline(attempt.signal, attempt.timeoutMs, TASK_STATE_UPDATE_TIMEOUT_CODE);
	try {
		let collected;
		try {
			collected = await streamAndCollect(attempt, timed.signal);
		} catch (error) {
			collected = classifyFailure(error, attempt.signal, timed.signal);
		}
		if (!collected.ok) {
			await appendFailureSafely(hooks, requestId, collected.failure);
			return {
				ok: false,
				failure: collected.failure
			};
		}
		const terminal = terminalFailure(collected.finish, attempt.signal, timed.signal);
		if (terminal !== void 0) {
			await appendFailureSafely(hooks, requestId, terminal);
			return {
				ok: false,
				failure: terminal
			};
		}
		return await commitFromOutput(attempt, hooks, requestId, collected.blocks, targetRevision, collected.usage);
	} finally {
		timed[Symbol.dispose]();
	}
}
/**
* Stream one model call and collect complete untruncated output blocks. The
* request is built with the locally typed task-state purpose and cast once at
* the runtime stream boundary; the adapter receives the exact same options
* object fields (provider, model, messages, system, maxTokens, sessionId,
* purpose, signal) it would receive from an upstream `GenerateOptions`.
*/
async function streamAndCollect(attempt, signal) {
	const options = {
		provider: attempt.route.provider,
		model: attempt.route.model,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: attempt.projection
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-context-enhancement/task-state-basic"
			}
		})],
		system: attempt.system,
		maxTokens: attempt.maxOutputTokens,
		sessionId: attempt.sessionId,
		purpose: "task-state",
		signal
	};
	const assembler = new BlockAssembler();
	for await (const chunk of attempt.ctx.llm.stream(options)) assembler.push(chunk);
	return {
		ok: true,
		blocks: assembler.blocks(),
		...assembler.usage === void 0 ? {} : { usage: assembler.usage },
		finish: assembler.finish
	};
}
/** Classify one thrown stream error into its failure facts. */
function classifyFailure(error, sessionSignal, deadlineSignal) {
	if (sessionSignal.aborted) return {
		ok: false,
		failure: {
			stage: "stream",
			code: "ABORTED",
			message: errorMessage(error)
		}
	};
	if (timeoutOfDeadline(deadlineSignal)) return {
		ok: false,
		failure: {
			stage: "stream",
			code: "TIMEOUT",
			message: "task-state update exceeded its configured timeout"
		}
	};
	const thrown = error;
	const code = typeof thrown?.code === "string" ? thrown.code : void 0;
	return {
		ok: false,
		failure: {
			stage: "stream",
			code: code === "ABORTED" ? "ABORTED" : code !== void 0 && isTransientCode(code) ? "TRANSIENT_LLM" : "UNEXPECTED",
			message: errorMessage(error)
		}
	};
}
/** Map a terminal finish to the corresponding failure, or undefined on `stop`. */
function terminalFailure(finish, sessionSignal, deadlineSignal) {
	switch (finish.kind) {
		case "stop": return;
		case "error": return {
			stage: "stream",
			code: codeFor(finish.failure.code),
			message: finish.failure.message
		};
		case "aborted": return sessionSignal.aborted ? {
			stage: "stream",
			code: "ABORTED",
			message: finish.failure.message
		} : deadlineSignal.aborted ? {
			stage: "stream",
			code: "TIMEOUT",
			message: "task-state update exceeded its configured timeout"
		} : {
			stage: "stream",
			code: "ABORTED",
			message: finish.failure.message
		};
		case "max-tokens": return {
			stage: "parse",
			code: "PARSE",
			message: "task-state update output reached maxOutputTokens (incomplete JSON)"
		};
		case "tool-calls": return {
			stage: "semantic",
			code: "SEMANTIC",
			message: "task-state update model unexpectedly requested a tool"
		};
		default: return {
			stage: "stream",
			code: "UNEXPECTED",
			message: `unsupported finish kind "${String(finish.kind)}"`
		};
	}
}
/** Translate a provider-neutral failure code into the batch code taxonomy. */
function codeFor(code) {
	return code === "ABORTED" ? "ABORTED" : isTransientCode(code) ? "TRANSIENT_LLM" : "UNEXPECTED";
}
/** Whether one provider-neutral code is transient infrastructure. */
function isTransientCode(code) {
	return code === "EMPTY_RESPONSE" || code === "RATE_LIMIT" || code === "SERVER" || code === "TIMEOUT" || code === "TRANSPORT";
}
/** Render a thrown error message. */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Whether the deadline signal aborted with the owned timeout reason. */
function timeoutOfDeadline(signal) {
	return timeoutOf(signal, TASK_STATE_UPDATE_TIMEOUT_CODE) !== void 0;
}
/** Whether one streamed finish produced usable text output. */
function hasTextOutput(blocks) {
	return blocks.some((block) => block.type === "text" && block.text.trim().length > 0);
}
/** Append a failure finished audit, containing the failure facts if the append itself fails. */
async function appendFailureSafely(hooks, requestId, failure) {
	try {
		const outcome = failure.code === "ABORTED" ? "aborted" : "failure";
		await hooks.putFinishedAudit({
			outcome,
			requestId,
			error: {
				stage: failure.stage,
				code: failure.code,
				message: failure.message
			}
		});
	} catch {}
}
/** Commit the parsed stable from collected text blocks. */
async function commitFromOutput(attempt, hooks, requestId, blocks, targetRevision, usage) {
	if (contentHasImage(blocks)) {
		await appendFailureSafely(hooks, requestId, {
			stage: "parse",
			code: "PARSE",
			message: "task-state update output cannot contain image content"
		});
		return {
			ok: false,
			failure: {
				stage: "parse",
				code: "PARSE",
				message: "task-state update output cannot contain image content"
			}
		};
	}
	if (!hasTextOutput(blocks)) {
		await appendFailureSafely(hooks, requestId, {
			stage: "parse",
			code: "PARSE",
			message: "task-state update model produced no text output"
		});
		return {
			ok: false,
			failure: {
				stage: "parse",
				code: "PARSE",
				message: "task-state update model produced no text output"
			}
		};
	}
	const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const failure = {
			stage: "parse",
			code: "PARSE",
			message: `task-state update output is not valid JSON: ${errorMessage(error)}`
		};
		await appendFailureSafely(hooks, requestId, failure);
		return {
			ok: false,
			failure
		};
	}
	let candidate;
	try {
		candidate = parseCandidate(parsed);
	} catch (error) {
		const failure = {
			stage: "schema",
			code: "SCHEMA",
			message: `task-state candidate failed schema validation: ${errorMessage(error)}`
		};
		await appendFailureSafely(hooks, requestId, failure);
		return {
			ok: false,
			failure
		};
	}
	const context = candidateContext(attempt);
	const quarantined = [];
	let normalized;
	try {
		normalized = normalizeCandidate(candidate, context, (item) => {
			quarantined.push(item);
		});
	} catch (error) {
		const failure = {
			stage: "semantic",
			code: "SEMANTIC",
			message: `task-state candidate failed Host semantic checks: ${errorMessage(error)}`
		};
		await appendFailureSafely(hooks, requestId, failure);
		return {
			ok: false,
			failure
		};
	}
	if (quarantined.length > 0) try {
		attempt.ctx.logger.warn(`task-state-basic: ${attempt.sessionId} quarantined ${quarantined.length} stale reference(s) outside the folded window (${quarantined.map((item) => `${item.kind} ${item.seq}`).join(", ")}); the references were dropped with the candidate, valid references and all other fields were preserved, and no sequence was fabricated`);
	} catch {}
	const sourceCursor = attempt.includedSeqs[attempt.includedSeqs.length - 1] ?? 0;
	let stable;
	try {
		stable = commitStable(normalized, 2, targetRevision, TASK_STATE_FILTER_VERSION, sourceCursor, attempt.inherited ?? null);
	} catch (error) {
		/* v8 ignore start -- see the comment above the catch. */
		const failure = {
			stage: "semantic",
			code: "SEMANTIC",
			message: `committed stable failed its durable schema: ${errorMessage(error)}`
		};
		await appendFailureSafely(hooks, requestId, failure);
		return {
			ok: false,
			failure
		};
	}
	try {
		await hooks.putStable(stable);
	} catch (error) {
		const failure = {
			stage: "storage",
			code: "STORAGE",
			message: `task-state stable write failed: ${errorMessage(error)}`
		};
		await appendFailureSafely(hooks, requestId, failure);
		return {
			ok: false,
			failure
		};
	}
	hooks.onCommitted(stable);
	let auditGap = false;
	try {
		await hooks.putFinishedAudit({
			outcome: "success",
			requestId,
			revision: stable.revision,
			sourceCursor: stable.sourceCursor,
			llmStreamCall: true,
			rawOutput: [...blocks],
			...usage === void 0 ? {} : { usage },
			finish: { kind: "stop" }
		});
	} catch (error) {
		auditGap = true;
		try {
			attempt.ctx.logger.warn(`task-state-basic: ${attempt.sessionId} committed stable revision ${stable.revision} but its finished audit failed; repair will certify it: ${errorMessage(error)}`);
		} catch {}
	}
	return {
		ok: true,
		stable,
		requestId,
		auditGap,
		...usage === void 0 ? {} : { usage }
	};
}
/** Build the Host semantic-validation context from one attempt. */
function candidateContext(attempt) {
	const base = attempt.base;
	const authority = resolveAuthorityViews(attempt.windowEvents, base, { maxEntryBytes: attempt.limits.maxEntryBytes });
	return {
		base: base === null ? null : {
			revision: base.revision,
			sourceCursor: base.sourceCursor,
			entryIds: new Set(allEntryIds(base)),
			entries: allEntries(base)
		},
		includedSeqs: new Set(attempt.includedSeqs),
		authority: {
			goalView: authority.goalView,
			todoView: authority.todoView,
			todoReferences: authority.todoReferences
		},
		limits: attempt.limits
	};
}
/** All Host-minted entry ids of one stable, for echoed-id verification. */
function allEntryIds(stable) {
	return allEntries(stable).map((entry) => entry.id);
}
/** Every committed entry of one stable with its kind. */
function allEntries(stable) {
	return [
		...stable.facts.map((entry) => ({
			id: String(entry.id),
			kind: "fact",
			content: entry.content
		})),
		...stable.decisions.map((entry) => ({
			id: String(entry.id),
			kind: "decision",
			content: entry.content
		})),
		...stable.constraints.map((entry) => ({
			id: String(entry.id),
			kind: "constraint",
			content: entry.content
		})),
		...stable.risks.map((entry) => ({
			id: String(entry.id),
			kind: "risk",
			content: entry.content
		}))
	];
}
//#endregion
//#region lib/types/internal/task-state/basic/worker.js
/**
* Per-Session background worker state for task-state-basic. One worker owns a
* Session's whole single-flight schedule: it admits batches only while the
* Session is live, folds an immutable batch window at the pending watermark
* observed WHEN A CYCLE IS LAUNCHED, runs the auxiliary update outside the
* observer stack, and after a threshold-triggered COMMIT runs AT MOST ONE
* trailing batch for events that arrived while the request ran. Audit puts
* are serialized per Session (a single worker per Session), and disposal
* closes admission, aborts the active request, and prevents late append,
* flush, or publish.
*
* Scheduling model (the "wave"): a threshold schedule launches one batch
* cycle whose window is snapped at launch — events that arrive after the
* launch only raise the pending watermark and become the next wave's input.
* While any cycle runs, further threshold requests only raise a follow-up
* flag. When a threshold cycle COMMITS, one trailing cycle may run for the
* remaining eligible tail; a trailing cycle never cascades into another
* trailing. A FAILED cycle never schedules anything on its own (no immediate
* no-backoff re-run of the same deterministic window): the pending watermark
* survives and the next legal activity — a later observe whose recomputed
* eligible count again crosses `minEvents` — starts a fresh threshold wave
* that re-folds from the previous committed cursor, so the tail is never
* lost. Events arriving during a trailing commit are likewise preserved.
*
* An INFINITE WINDOW is the third, separate outcome of a fold, and it has TWO
* measured causes that are never confused with each other:
*
* - A NON-EVENT cause — the committed base stable alone already exceeds the
*   input budget, or the first projectable event is an AUTHORITY fact
*   (`goal/change`, `todo/write`) too large to frame. Nothing may be blamed or
*   skipped either way, so the window stays PENDING and the measured cause is
*   recorded as ONE durable typed `block…` verdict carrying the generation it
*   was measured against. The block suppresses re-folding (and re-paying for)
*   the very same situation on every later wave and on every restart, while a
*   changed base/filter/budget generation re-opens the window for a fresh
*   measurement.
* - An EVENT cause — the single first projectable event above the cursor is an
*   ordinary fact that cannot fit even as the only event of the window. That ONE
*   measured culprit sequence is quarantined and recorded as one durable
*   terminal verdict on the same Session record, so restart never re-attempts or
*   re-pays for it. The schedule then continues while the remaining backlog
*   still reaches the threshold, and terminates because every quarantine
*   strictly advances the cursor.
*
* A terminal verdict is durable whether or not the Session has committed a
* stable: the record carries the verdict on its own, and no empty authority
* stable is ever fabricated to hold it.
*
* ONE startup wave is admitted outside that event-driven path: a Session
* runtime established by creation, domain open, or stored-record hydration
* offers a single startup check, and when the projectable eligible backlog
* above the committed cursor already meets `minEvents` the inherited tail is
* folded without waiting for a new Session event. An `urgent` wave is admitted
* when an observed AUTHORITY fact (a `goal/change` that changes the Goal view,
* or any `todo/write` whole-list fact including the empty clear) must be folded
* without waiting for `minEvents`, because the injected Goal/TODO views are
* authoritative state and a stale one must not survive a whole threshold
* window. The check runs once per worker and never races a wave already in
* flight; every wave records why it was admitted (`startup`, `threshold`,
* `urgent`, `trailing`, or `manual`) on its durable open audit row.
* @module dsh-context-enhancement/internal/task-state/basic/worker
*/
/** Stable code marking a Session-disposal cancellation. */
const SESSION_DISPOSED_ABORT_CODE = "task-state-basic/session-disposed";
/** One per-Session worker's complete owned state. */
var TaskStateWorker = class {
	ctx;
	env;
	minEvents;
	maxEvents;
	maxInputBytes;
	maxOutputTokens;
	timeoutMs;
	maxInfraRetries;
	limits;
	system;
	/** Admission open only while the Session lifecycle is live and not disposing. */
	open = true;
	/** Pending eligible-event watermark observed (highest eligible seq seen). */
	pending = 0;
	/** Number of projectable eligible events observed above the committed cursor (incremental). */
	pendingEligible = 0;
	/** Whether a batch cycle is currently running (single-flight guard). */
	active = false;
	/** Whether another threshold was requested while one was already running. */
	followUpRequested = false;
	/** The in-flight batch cycle's cancellation controller, if one is running. */
	controller;
	/** Serialized chain: every scheduled batch cycle runs after the previous one. */
	chain = Promise.resolve();
	/** Whether this worker was disposed (closes admission permanently). */
	disposed = false;
	/**
	* Whether the one startup backlog check of this worker's lifetime already
	* ran. Set when a startup request is admitted AND when it is deferred into
	* an already-running wave, so the same backlog never starts a second startup
	* wave from repeated hydration or creation notifications.
	*/
	startupScheduled = false;
	/**
	* Highest AUTHORITY sequence already admitted (or deferred into a running
	* wave) as an urgent request. An urgent request is idempotent per eligible
	* sequence, so neither a replayed observation nor a second scheduling caller
	* can fold the same authority fact twice.
	*/
	urgentThrough = -1;
	/**
	* Authority sequence whose urgent request was DEFERRED into a running wave,
	* or `-1`. Only a sequence still above the committed cursor at settle time
	* makes the wave's follow-up urgent.
	*/
	urgentDeferredSeq = -1;
	/** Whether the pending follow-up wave was requested by an authority fact. */
	followUpUrgent = false;
	/** Id of the owning Session, for diagnostics. */
	sessionId;
	/**
	* Highest eligible sequence already counted by the initial snapshot count,
	* or `-1` when no eligible event was counted (Session sequence numbering
	* starts at 0, so `-1` is the only safe "nothing counted" sentinel).
	* Observations at or below it are replays of events the seed already counted
	* (a resumed Session can be announced to the observer seam a second time),
	* and counting them again would inflate the backlog past the real one.
	*/
	countedThrough = -1;
	/**
	* The Session's still-ACTIVE terminal block as of the last launch decision,
	* or `undefined`. Read from the durable record at construction (so a restart
	* inherits it) and re-read before every launch, because the provider
	* re-computes it whenever a verdict is written or a stable commits.
	*/
	block;
	constructor(ctx, session, config, env) {
		this.ctx = ctx;
		this.env = env;
		this.sessionId = session.id;
		this.minEvents = config.minEvents;
		this.maxEvents = config.maxEvents;
		this.maxInputBytes = config.maxInputBytes;
		this.maxOutputTokens = config.maxOutputTokens;
		this.timeoutMs = config.timeoutMs;
		this.maxInfraRetries = config.maxInfraRetries;
		this.limits = {
			maxEntriesPerKind: config.maxEntriesPerKind,
			maxEntryBytes: config.maxEntryBytes,
			maxListItems: config.maxListItems
		};
		this.system = this.env.system;
		const events = session.snapshotEvents();
		const last = events[events.length - 1];
		this.pending = last === void 0 ? 0 : Number(last.seq);
		this.pendingEligible = this.env.eligibleCount(this.sessionId);
		this.countedThrough = lastEligibleSeq(session.snapshotEvents());
		this.block = this.env.activeBlock(this.sessionId);
	}
	/** The Session identity this worker fences. */
	get id() {
		return this.sessionId;
	}
	/** Whether this worker still admits new batches. */
	get isOpen() {
		return this.open && !this.disposed;
	}
	/** Serialize one external mutation behind any admitted batch cycle. */
	enqueueMutation(operation) {
		if (!this.isOpen) return Promise.reject(/* @__PURE__ */ new Error(SESSION_DISPOSED_ABORT_CODE));
		const result = this.chain.then(async () => {
			if (!this.isOpen) throw new Error(SESSION_DISPOSED_ABORT_CODE);
			return operation();
		});
		this.chain = result.then(() => void 0, () => void 0);
		return result;
	}
	/**
	* Raise the pending eligible-event watermark and count one projectable
	* eligible event. Observer-only, synchronous. The provider forwards only
	* eligible events whose real filter projection is non-empty, so an event
	* that folds nothing never inflates the threshold. An event at or below the
	* boundary the initial snapshot count already covered is a replay of a
	* counted event (a resumed Session may be announced twice) and is ignored, so
	* one backlog can never be counted twice.
	* @param seq - sequence of one newly observed projectable eligible Session event.
	*/
	observe(seq) {
		if (seq > this.pending) this.pending = seq;
		if (seq <= this.countedThrough) return;
		this.countedThrough = seq;
		this.pendingEligible += 1;
	}
	/** Recompute the pending eligible count from the real log and cursor. */
	recomputeEligible() {
		this.pendingEligible = this.env.eligibleCount(this.sessionId);
		this.countedThrough = lastEligibleSeq(this.env.liveSession(this.sessionId)?.snapshotEvents() ?? []);
	}
	/**
	* Schedule a background collect-and-merge when the pending watermark grew
	* past the configured minimum projectable eligible events. Called outside
	* the observer stack; never performs append, flush, storage, or model work
	* inline. The schedule is idempotent: at most one batch starts at a time,
	* and a request while one runs only marks a follow-up.
	*/
	maybeSchedule() {
		if (!this.isOpen) return;
		if (this.pendingEligible < this.minEvents) return;
		if (this.active) {
			this.followUpRequested = true;
			return;
		}
		this.launch("threshold");
	}
	/**
	* Offer the ONE startup backlog check of this worker's lifetime: when the
	* projectable eligible backlog above the committed cursor already meets
	* `minEvents`, admit a `startup` wave without waiting for a new Session
	* event. A resumed, reopened, or freshly hydrated Session therefore folds
	* the tail it inherited instead of serving a stale stable until the next
	* eligible event arrives.
	*
	* The check is isolated from the threshold path: it is admitted exactly
	* once per worker (a second hydration or creation notification for the same
	* backlog never starts a concurrent or duplicated startup wave), it never
	* launches on an empty or sub-threshold backlog, and it runs on the worker's
	* serialized chain — never inline on the caller's stack. A startup request
	* that arrives while another wave already runs is folded into that wave's
	* single legal follow-up instead of racing it.
	* @returns nothing; the wave is observed through the worker's commit hooks.
	*/
	maybeScheduleStartup() {
		if (!this.isOpen || this.startupScheduled) return;
		this.startupScheduled = true;
		if (this.pendingEligible < this.minEvents) return;
		if (this.active) {
			this.followUpRequested = true;
			return;
		}
		this.launch("startup");
	}
	/**
	* Admit an `urgent` wave for one observed AUTHORITATIVE fact — a
	* `goal/change` that changes the Goal view, or any `todo/write` whole-list
	* fact including the empty clear. The authoritative Goal/TODO views are part
	* of what the main model is injected, so waiting for `minEvents` ordinary
	* events would keep a superseded objective or a cleared list injected for up
	* to a full threshold window; an authority fact is folded as soon as it is
	* observed instead.
	*
	* Idempotence is per eligible sequence: the exact authority sequence that
	* already admitted (or deferred) an urgent request can never request a second
	* one, so a replayed observation of the same fact — or a second scheduling
	* caller for the same event — never folds that sequence concurrently or
	* twice. The wave itself is a normal single-flight cycle, so an urgent
	* request while a cycle runs only marks that cycle's follow-up; that
	* follow-up is admitted with the `urgent` trigger, which is how an authority
	* fact that arrives during a running wave still skips the threshold.
	* @param seq - sequence of the observed authority event.
	*/
	maybeScheduleUrgent(seq) {
		if (!this.isOpen) return;
		if (seq <= this.urgentThrough) return;
		if (this.pendingEligible < 1) return;
		this.urgentThrough = seq;
		if (this.active) {
			this.urgentDeferredSeq = seq;
			this.followUpRequested = true;
			this.followUpUrgent = true;
			return;
		}
		this.urgentDeferredSeq = -1;
		this.launch("urgent");
	}
	/**
	* Launch one batch cycle: snap the batch window at this instant, then
	* serialize the async request on the worker's single chain. The snapshot is
	* what makes events arriving during the request a LATER wave.
	*/
	launch(kind) {
		if (!this.isOpen || this.active) return;
		this.block = this.env.activeBlock(this.sessionId);
		if (this.block !== void 0) {
			this.recomputeEligible();
			return;
		}
		const windowEnd = this.pending;
		const cursor = this.env.committedCursor(this.sessionId);
		const base = this.env.readBase(this.sessionId);
		const session = this.env.liveSession(this.sessionId);
		if (session === void 0) return;
		const folded = foldBatchWindow(session.snapshotEvents(), base, cursor, windowEnd, {
			maxEvents: this.maxEvents,
			maxInputBytes: this.maxInputBytes
		});
		if (folded.kind === "empty") {
			this.recomputeEligible();
			return;
		}
		if (folded.kind === "infeasible") {
			this.active = true;
			this.chain = this.chain.then(async () => {
				let advanced = false;
				try {
					advanced = await this.handleInfeasible(kind, session, base, cursor, folded);
				} finally {
					this.active = false;
				}
				if (advanced) this.settleQuarantine();
			}).catch((error) => {
				this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker infeasible handle failed: ${String(error)}`);
			});
			return;
		}
		this.active = true;
		this.chain = this.chain.then(async () => {
			let outcome;
			try {
				outcome = await this.performBatch(kind, folded.window);
			} catch (error) {
				this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker cycle rejected unexpectedly: ${String(error)}`);
				outcome = {
					kind: "failed",
					failure: {
						stage: "request",
						code: "UNEXPECTED",
						message: `worker cycle rejected: ${String(error)}`
					}
				};
			} finally {
				this.active = false;
			}
			this.settleCycle(kind, outcome);
		}).catch((error) => {
			this.ctx.logger.error(`task-state-basic: ${this.sessionId} worker settle failed: ${String(error)}`);
		});
	}
	/** Decide what may legally follow one settled cycle (never called on a disposed worker). */
	settleCycle(kind, outcome) {
		if (!this.isOpen) return;
		if (outcome.kind !== "committed") return;
		const deferredUrgentOutstanding = this.urgentDeferredSeq > outcome.stable.sourceCursor;
		const urgentOutstanding = this.followUpUrgent && deferredUrgentOutstanding;
		if (deferredUrgentOutstanding) this.urgentDeferredSeq = -1;
		this.recomputeEligible();
		if (kind === "trailing" || kind === "urgent") {
			this.followUpUrgent = false;
			if (this.pendingEligible >= this.minEvents) {
				this.launch("threshold");
				return;
			}
			if (urgentOutstanding && this.pendingEligible >= 1) this.launch("urgent");
			return;
		}
		this.followUpUrgent = false;
		const wantTrailing = this.followUpRequested || this.pendingEligible >= this.minEvents;
		this.followUpRequested = false;
		if (wantTrailing && this.pendingEligible >= 1) this.launch(urgentOutstanding ? "urgent" : "trailing");
	}
	/**
	* Handle an infeasible batch window — the fold proved that no meaningful
	* window can be framed inside `maxInputBytes`. The caller must prove WHICH
	* cause applies before anything durable is written, because the two causes
	* have opposite consequences for the cursor:
	*
	* 1. The base stable ALONE already exceeds the budget. The previously
	*    committed stable — not the log — is the cause, so quarantining eligible
	*    events would discard facts and would not make progress either. A durable
	*    `blockBaseOverBudget` verdict is recorded: typed provenance naming the
	*    measured base bytes and the exact generation (base cursor/digest/filter
	*    version plus the byte budget) it was measured against. The cursor does
	*    NOT move, nothing is skipped, and the SAME situation is never re-folded
	*    again — while any change to that generation re-opens it.
	* 2. The FIRST projectable event above the cursor cannot fit even as the only
	*    event of the window. That single sequence is the MEASURED culprit, and it
	*    is the only thing the cursor may skip — unless it is an authority fact.
	* 3. That measured culprit is an authority fact (`goal/change`,
	*    `todo/write`). Authority Goal/TODO facts are never skipped: a durable
	*    `blockAuthorityFact` verdict records the typed reason (the sequence and
	*    its event type) and the generation, the cursor stays exactly where it
	*    was, and the fact stays PENDING.
	*
	* Every verdict is written durably BEFORE the diagnostic audit pair, and a
	* refused or failed write claims nothing: the durable state and the in-memory
	* pointer stay exactly as they were. The verdict never needs a committed
	* stable — a record carrying only identity and verdict is written when the
	* Session has not committed yet, and no empty stable is ever fabricated.
	* @returns whether the schedule may continue with the remaining backlog.
	*/
	async handleInfeasible(kind, session, base, cursor, folded) {
		if (!this.isOpen) return false;
		const generation = terminalGeneration(base, folded.maxInputBytes);
		const baseOnlyBytes = Buffer.byteLength(this.env.frame(this.sessionId, base, {
			includedSeqs: [],
			sourceCursor: cursor,
			events: [],
			truncation: [],
			inputBytes: 0
		}), "utf8");
		if (baseOnlyBytes > folded.maxInputBytes) {
			const reason = `the committed stable alone frames ${baseOnlyBytes} bytes, above maxInputBytes (${folded.maxInputBytes}); no eligible window can ever fit and no event is quarantined (the base, not the log, is the measured cause)`;
			this.ctx.logger.error(`task-state-basic: ${this.sessionId} ${reason}; recording a durable block and leaving the cursor at ${cursor}`);
			const recorded = await this.recordVerdict(kind, base, cursor, {
				kind: "blockBaseOverBudget",
				generation,
				cursor,
				reason
			});
			this.recomputeEligible();
			return recorded;
		}
		const events = session.snapshotEvents();
		let candidateEvent;
		for (const event of events) {
			if (Number(event.seq) <= cursor) continue;
			if (!isEligibleType(event.type)) continue;
			if (filterEvent({
				type: event.type,
				seq: event.seq,
				data: event.data
			}) !== null) {
				candidateEvent = event;
				break;
			}
		}
		if (candidateEvent === void 0) {
			this.recomputeEligible();
			return false;
		}
		if (isAuthorityEventType(candidateEvent.type)) {
			const reason = `authority event seq ${candidateEvent.seq} (${candidateEvent.type}) exceeds maxInputBytes (${folded.maxInputBytes}); authority facts cannot be quarantined and stay pending`;
			this.ctx.logger.error(`task-state-basic: ${this.sessionId} ${reason}; recording a durable block and leaving the cursor at ${cursor}`);
			const recorded = await this.recordVerdict(kind, base, cursor, {
				kind: "blockAuthorityFact",
				generation,
				cursor,
				blockSeq: Number(candidateEvent.seq),
				blockType: candidateEvent.type,
				reason
			});
			this.recomputeEligible();
			return recorded;
		}
		const quarantinedSeq = Number(candidateEvent.seq);
		const reason = `batch input (${folded.frameBytes} bytes) exceeds configured maxInputBytes (${folded.maxInputBytes}) even after deterministic truncation`;
		if (!await this.recordVerdict(kind, base, cursor, {
			kind: "quarantined",
			generation,
			cursor: quarantinedSeq,
			includedSeqs: [quarantinedSeq],
			reason
		})) {
			this.recomputeEligible();
			return false;
		}
		this.ctx.logger.warn(`task-state-basic: ${this.sessionId} quarantined infeasible event seq ${quarantinedSeq} (${candidateEvent.type}): ${reason}`);
		this.recomputeEligible();
		return true;
	}
	/**
	* Record ONE durable terminal verdict, then its diagnostic ledger pair.
	*
	* The authority write comes FIRST: a verdict that is not durable must not be
	* reported anywhere, and a durable verdict always carries its own provenance
	* (request id, kind, generation, measured cursor/sequences, code, reason,
	* trigger). The audit pair is written only AFTER the authority put resolved,
	* because the audit table is a separate table and therefore a separate
	* whole-document write — a loss there is a diagnostic gap, never a state
	* claim, and no cross-table atomicity is assumed or claimed.
	* @returns whether the verdict became durable.
	*/
	async recordVerdict(kind, base, cursorFloor, verdict) {
		const requestId = TaskStateRequestId(`ts-terminal-${randomUUID()}`);
		const terminal = {
			...verdict,
			requestId,
			code: "BUDGET",
			trigger: kind,
			time: Date.now()
		};
		const failure = {
			stage: "request",
			code: "BUDGET",
			message: terminal.reason
		};
		let recorded = false;
		try {
			recorded = await this.env.putTerminal(this.sessionId, terminal);
		} catch (error) {
			this.ctx.logger.error(`task-state-basic: ${this.sessionId} terminal verdict record failed: ${String(error)}`);
		}
		if (!recorded) return false;
		try {
			await this.env.putOpenAudit(this.sessionId, {
				requestId,
				revision: (base?.revision ?? 0) + 1,
				trigger: kind,
				base: base === null ? null : structuredClone(base),
				includedSeqs: terminal.kind === "quarantined" ? [...terminal.includedSeqs] : [],
				filterVersion: TASK_STATE_FILTER_VERSION,
				system: this.system,
				route: this.env.resolveRoute(this.sessionId),
				maxTokens: 0,
				schema: { version: 2 },
				truncation: []
			});
			await this.env.putFinishedAudit(this.sessionId, {
				outcome: "terminal-infeasible",
				requestId,
				revision: base?.revision ?? 0,
				sourceCursor: terminal.kind === "quarantined" ? terminal.cursor : cursorFloor,
				error: failure
			});
		} catch (error) {
			this.ctx.logger.error(`task-state-basic: ${this.sessionId} terminal verdict audit row failed (the verdict record stays authoritative): ${String(error)}`);
		}
		return true;
	}
	/**
	* Decide what may legally follow one SETTLED quarantine. A quarantine
	* advanced the committed cursor by exactly one measured culprit sequence, so
	* the remaining backlog may be folded immediately: the schedule continues
	* while the backlog still reaches the threshold and terminates because every
	* step strictly advances the cursor.
	*
	* A BLOCK is not a quarantine: it advanced nothing. Continuing the schedule
	* for it is still correct and terminating — the very next launch reads the
	* active block, finds the same unchanged generation, and stops without a fold
	* — but it must never be described as backlog progress.
	*
	* The `urgent` follow-up is admitted only when a deferred authority fact is
	* still outstanding, so an ordinary tail is never mislabelled `urgent`.
	*/
	settleQuarantine() {
		if (!this.isOpen) return;
		this.followUpRequested = false;
		if (this.pendingEligible >= this.minEvents) {
			this.launch("threshold");
			return;
		}
		if (this.followUpUrgent && this.pendingEligible >= 1) {
			this.followUpUrgent = false;
			this.launch("urgent");
		}
	}
	/** Run one captured immutable batch window as an update cycle. */
	async performBatch(trigger, window) {
		if (!this.isOpen) return { kind: "noop" };
		const controller = new AbortController();
		this.controller = controller;
		try {
			const session = this.env.liveSession(this.sessionId);
			if (session === void 0) return { kind: "noop" };
			const base = this.env.readBase(this.sessionId);
			this.ctx.logger.debug(`task-state-basic: ${this.sessionId} batch over ${window.includedSeqs.length} eligible seqs`);
			const attempt = {
				ctx: this.ctx,
				route: this.env.resolveRoute(this.sessionId),
				base,
				projection: this.env.frame(this.sessionId, base, window),
				includedSeqs: window.includedSeqs,
				windowEvents: window.events,
				trigger,
				truncation: window.truncation,
				system: this.system,
				maxOutputTokens: this.maxOutputTokens,
				timeoutMs: this.timeoutMs,
				sessionId: this.sessionId,
				signal: controller.signal,
				limits: this.limits,
				inherited: sessionInheritedPrefix(session)
			};
			const result = await this.attemptWithRetry(attempt, controller);
			if (!result.ok) return {
				kind: "failed",
				failure: result.failure
			};
			if (result.auditGap) try {
				await this.env.scheduleAuditRepair(this.sessionId, result.stable, String(result.requestId));
			} catch (error) {
				this.ctx.logger.error(`task-state-basic: ${this.sessionId} audit repair scheduling failed: ${String(error)}`);
			}
			this.recomputeEligible();
			return {
				kind: "committed",
				stable: result.stable
			};
		} finally {
			this.controller = void 0;
		}
	}
	/** Run one update attempt with the bounded infrastructure-retry policy. */
	async attemptWithRetry(attempt, controller) {
		let last = {
			ok: false,
			failure: {
				stage: "stream",
				code: "UNEXPECTED",
				message: "task-state update made no attempt"
			}
		};
		for (let attemptNumber = 0; attemptNumber <= this.maxInfraRetries; attemptNumber++) {
			if (!this.isOpen || controller.signal.aborted) return {
				ok: false,
				failure: {
					stage: "stream",
					code: "ABORTED",
					message: "task-state worker was disposed or cancelled"
				}
			};
			const result = await runUpdateAttempt({
				...attempt,
				signal: controller.signal
			}, this.hooks());
			if (result.ok) return result;
			last = result;
			if (!isInfrastructureFailure(result.failure)) return result;
			if (attemptNumber < this.maxInfraRetries) await backoffDelay(attemptNumber, controller.signal);
		}
		return last;
	}
	/** The provider-owned storage/audit/publish boundary for one update. */
	hooks() {
		const id = this.sessionId;
		return {
			putOpenAudit: async (data) => {
				if (this.isOpen) await this.env.putOpenAudit(id, data);
			},
			putFinishedAudit: (data) => this.env.putFinishedAudit(id, data),
			putStable: async (stable) => {
				if (!this.isOpen) throw new Error(SESSION_DISPOSED_ABORT_CODE);
				await this.env.putStable(id, stable);
			},
			onCommitted: (stable) => {
				if (this.isOpen) this.env.onCommitted(id, stable);
			}
		};
	}
	/**
	* Dispose this worker: close admission, abort cancellable work, and prevent
	* any late append, flush, or publish. An already successful put remains
	* authoritative for the next process load.
	*/
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.open = false;
		this.controller?.abort(/* @__PURE__ */ new Error(SESSION_DISPOSED_ABORT_CODE));
		await this.chain;
	}
};
/** Whether one failure is transient infrastructure (eligible for retry). */
function isInfrastructureFailure(failure) {
	return failure.code === "TRANSIENT_LLM" || failure.code === "TIMEOUT";
}
/** Deterministic bounded backoff between infrastructure attempts. */
async function backoffDelay(attemptNumber, signal) {
	if (signal.aborted) return;
	const delayMs = Math.min(250 * 2 ** attemptNumber, 4e3);
	await new Promise((resolve) => {
		const id = setTimeout(resolve, delayMs);
		signal.addEventListener("abort", () => {
			clearTimeout(id);
			resolve();
		}, { once: true });
	});
}
/**
* Highest ELIGIBLE-TYPE sequence of one Session snapshot, used as the
* already-counted boundary of the worker's initial backlog count. It reads
* only the event type: the authoritative projectable count comes from the
* environment's real filter, so this boundary never needs to project.
* @param events - the Session's snapshot events.
* @returns the highest eligible-type sequence, or -1 when there is none.
*/
function lastEligibleSeq(events) {
	let highest = -1;
	for (const event of events) {
		if (!isEligibleType(event.type)) continue;
		const seq = Number(event.seq);
		if (seq > highest) highest = seq;
	}
	return highest;
}
//#endregion
//#region lib/types/internal/task-state/basic/service.js
/**
* Basic durable task-state provider (`ctx.taskState`): the sole MVP owner of
* the authoritative `context_enhancement_task_state` storage domain, the
* published committed pointers, the versioned input filter, per-Session
* background scheduling, independent auxiliary LLM calls, output validation,
* private writes, and lifecycle. It subclasses the read-only Service
* Definition; its plugin-owned control Remote may invoke the provider's
* revision-checked `editStable` method without widening `ctx.taskState` for
* ordinary consumers.
*
* Startup opens and validates the domain, then publishes each stored
* lifecycle-matching stable directly — no model call, no history fold, no
* unfinished-update replay. A damaged or incompatible domain fails activation
* LOUDLY and puts the whole provider into a permanent disabled state: it
* serves no stable pointer, installs no Session observers or workers, never
* opens storage a second time, and never invokes a model to repair the
* medium. Ordinary Sessions remain fully usable; they simply see
* `getStable()` return `undefined`. Eligible events after a committed cursor
* are folded in the background: normal activity schedules the per-Session
* worker, and establishing a runtime (creation, domain open, or stored-record
* hydration) additionally offers ONE startup backlog check, which folds an
* inherited tail that already meets `minEvents` without waiting for a new
* event. Recovery itself never folds, never replays an unfinished update, and
* never calls a model — the recovered stable is published first and any
* backlog revision is committed afterwards by its own scheduled wave.
*
* The plugin declares NO SessionEventMap members: the audit vocabulary lives
* in this provider's own storage domain (`sessions` + `audit` tables), never
* in the Session log, so unloading task-state leaves old Sessions readable
* and reloadable by rc.1 code.
* @module dsh-context-enhancement/internal/task-state/basic/service
*/
/** The durable lifecycle identity derived from one Session header. */
function lifecycleOf(session) {
	return {
		createdAt: session.header.createdAt,
		...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
	};
}
/**
* The basic task-state provider service. A host-level plugin (not agent- or
* preset-scoped): it opens ONE process-global domain and serves every Session
* in the overlay.
*/
var TaskStateBasicService = class extends TaskStateService {
	static inject = [
		"storageDomain",
		"sessions",
		"llm"
	];
	/** Required deployment policy; every field is explicit from the composition. */
	static Config = Schema.object({
		provider: Schema.string().required(),
		model: Schema.string().required(),
		minEvents: Schema.number().step(1).min(1).required(),
		maxEvents: Schema.number().step(1).min(1).required(),
		maxInputBytes: Schema.number().step(1).min(1).required(),
		maxOutputTokens: Schema.number().step(1).min(1).required(),
		timeoutMs: Schema.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
		maxInfraRetries: Schema.number().step(1).min(0).required(),
		maxEntriesPerKind: Schema.number().step(1).min(1).required(),
		maxEntryBytes: Schema.number().step(1).min(1).required(),
		maxListItems: Schema.number().step(1).min(1).required()
	});
	config;
	sessionsTable;
	auditTable;
	runtimes = /* @__PURE__ */ new Map();
	/** Startup audit repairs that disposal must drain before closing the domain. */
	repairs = /* @__PURE__ */ new Set();
	/** Admission closes at plugin disposal; workers reject new batches then. */
	admissionOpen = true;
	/** Set when the domain failed to open: the provider serves nothing further. */
	disabled = false;
	/** Registered committed-stable observers, notified after each authority put. */
	committedListeners = /* @__PURE__ */ new Set();
	/**
	* @param ctx - host context carrying storage-domain, sessions, and llm.
	* @param config - validated required deployment policy.
	*/
	constructor(ctx, config) {
		super(ctx);
		this.config = resolveTaskStateBasicConfig(config);
	}
	/** Open the authoritative domain, seed committed pointers, and install lifecycle. */
	async [Service.init]() {
		const createdDuringOpen = /* @__PURE__ */ new Set();
		const captureCreated = (session) => {
			createdDuringOpen.add(session);
		};
		const releaseCapture = this.ctx.on("session/created", captureCreated, { global: true });
		let domain;
		try {
			domain = await this.ctx.storageDomain.open(taskStateDomainSpec);
		} catch (error) {
			this.disabled = true;
			this.admissionOpen = false;
			releaseCapture();
			try {
				this.ctx.logger.error(`task-state-basic: authoritative context_enhancement_task_state domain failed to open; task state is disabled and no stable will be published. Medium left unchanged; no model was invoked. Cause: ${describeOpenFailure(error)}`);
			} catch {}
			return;
		}
		releaseCapture();
		this.ctx.effect(() => async () => {
			this.admissionOpen = false;
			const workers = [...this.runtimes.values()].map((runtime) => runtime.worker);
			await Promise.all(workers.map((worker) => worker.dispose().catch((error) => {
				try {
					this.ctx.logger.warn(`task-state-basic: worker disposal during service dispose failed: ${String(error)}`);
				} catch {}
			})));
			await this.drainRepairs();
			this.runtimes.clear();
			this.committedListeners.clear();
			await domain.close();
		}, "task-state-basic.domainAndWorkers");
		this.sessionsTable = domain.table("sessions");
		this.auditTable = domain.table("audit");
		const seeded = /* @__PURE__ */ new Set();
		for (const session of [...this.ctx.sessions.list(), ...createdDuringOpen]) {
			if (this.ctx.sessions.get(session.id) !== session) continue;
			if (seeded.has(session.id)) continue;
			seeded.add(session.id);
			this.runtimeFor(session);
		}
		this.installLifecycle();
	}
	/** Track one audit repair so provider disposal observes and drains it. */
	trackRepair(label, operation) {
		if (!this.admissionOpen || this.disabled) return Promise.resolve();
		const repair = Promise.resolve().then(operation).catch((error) => {
			try {
				this.ctx.logger.error(`task-state-basic: ${label} audit repair failed: ${String(error)}`);
			} catch {}
		});
		this.repairs.add(repair);
		repair.finally(() => {
			this.repairs.delete(repair);
		});
		return repair;
	}
	/** Drain every repair admitted before provider disposal closed admission. */
	async drainRepairs() {
		while (this.repairs.size > 0) await Promise.all([...this.repairs]);
	}
	/** Append a repair credential when the log has not certified the stored stable. */
	scheduleRepair(session) {
		this.trackRepair(`${session.id} startup`, async () => {
			if (this.ctx.sessions.get(session.id) !== session) return;
			await this.reconcileRepair(session);
		});
	}
	/**
	* Reconcile one Session's durable audit against its committed sessions-table
	* stable: when the stable's revision exceeds every certified revision, fill
	* the matching open audit row with a repair credential (never rerunning the
	* model, never inventing raw output).
	*/
	async reconcileRepair(session) {
		const stored = this.recordFor(session);
		if (stored === void 0) return;
		const stable = stored.stable;
		if (stable === void 0) return;
		const audit = this.auditTable;
		if (audit === void 0) return;
		const rows = rowsForLifecycle([...audit.entries()].map((entry) => entry[1]), lifecycleOf(session));
		if (highestCertifiedRevision(rows) >= stable.revision) return;
		const open = selectRepairRow(rows, stable.revision);
		if (open === void 0) {
			try {
				this.ctx.logger.warn(`task-state-basic: ${session.id} committed stable revision ${stable.revision} has no matching open audit row; leaving it uncertified (stable stays authoritative)`);
			} catch {}
			return;
		}
		const finished = {
			outcome: "repair",
			requestId: open.requestId,
			revision: stable.revision,
			sourceCursor: stable.sourceCursor
		};
		await this.finishOpenAudit(open.requestId, lifecycleOf(session), stable, finished);
	}
	/**
	* Live-repair one just-committed stable whose finished audit did not become
	* durable: fill that exact request's open row. The operation is tracked so
	* disposal cannot close the domain while repair is pending.
	*/
	scheduleAuditRepair(id, stable, requestId, expectedSession) {
		return this.trackRepair(`${id} live`, async () => {
			const session = this.ctx.sessions.get(id);
			if (session === void 0 || expectedSession !== void 0 && session !== expectedSession) return;
			const row = this.auditTable?.get(requestId);
			if (row === void 0 || String(row.requestId) !== requestId) return;
			const finished = {
				outcome: "repair",
				requestId: row.requestId,
				revision: stable.revision,
				sourceCursor: stable.sourceCursor
			};
			await this.finishOpenAudit(row.requestId, lifecycleOf(session), stable, finished);
		});
	}
	/** Finish only the exact row that is still open for this lifecycle and commit. */
	async finishOpenAudit(requestId, lifecycle, stable, finished) {
		const audit = this.auditTable;
		if (audit === void 0) return;
		const key = String(requestId);
		await audit.update(key, (current) => {
			const certifying = finished.outcome === "success" || finished.outcome === "repair";
			if (current.finished !== void 0 || String(current.requestId) !== key || String(current.request.requestId) !== key || current.session.createdAt !== lifecycle.createdAt || current.session.cwd !== lifecycle.cwd || current.request.revision !== stable.revision || certifying && (finished.revision !== stable.revision || finished.sourceCursor !== stable.sourceCursor)) return current;
			return finishAuditRow(current, finished);
		});
	}
	/** One runtime for a live Session: identity-fenced record + single worker. */
	runtimeFor(session) {
		if (this.ctx.sessions.get(session.id) !== session) return void 0;
		const lifecycle = lifecycleOf(session);
		let runtime = this.runtimes.get(session.id);
		if (runtime !== void 0) {
			if (runtime.session !== session || runtime.lifecycle.createdAt !== lifecycle.createdAt || runtime.lifecycle.cwd !== lifecycle.cwd) {
				const staleRuntime = runtime;
				if (this.runtimes.get(session.id) === staleRuntime) this.runtimes.delete(session.id);
				(async () => {
					let disposeError;
					try {
						await staleRuntime.worker.dispose();
					} catch (error) {
						disposeError = error;
					}
					if (disposeError !== void 0) try {
						this.ctx.logger.warn(`task-state-basic: mismatched worker disposal for "${session.id}" failed: ${String(disposeError)}`);
					} catch {}
				})();
				runtime = void 0;
			}
		}
		let createdRuntime;
		if (runtime === void 0) {
			runtime = {
				session,
				lifecycle,
				worker: void 0,
				stable: void 0,
				terminal: void 0,
				terminalBlock: void 0,
				repairScheduled: false
			};
			this.runtimes.set(session.id, runtime);
			if (this.ctx.sessions.get(session.id) === session) {
				const record = this.recordFor(session);
				if (record !== void 0) {
					runtime.stable = record.stable;
					runtime.terminal = record.terminal;
					const recovered = record.stable;
					if (recovered !== void 0) this.notifyCommitted(session.id, recovered);
					runtime.repairScheduled = true;
				}
			}
			this.refreshTerminalBlock(runtime);
			const worker = new TaskStateWorker(this.ctx, session, this.config, {
				system: TASK_STATE_SYSTEM_INSTRUCTION,
				resolveRoute: (id) => {
					const current = this.ctx.sessions.get(id)?.requestHeader()?.config;
					return current === void 0 ? {
						provider: this.config.provider,
						model: this.config.model
					} : {
						provider: current.provider,
						model: current.model
					};
				},
				liveSession: (id) => {
					const live = this.ctx.sessions.get(id);
					return live === session ? live : void 0;
				},
				committedCursor: (id) => this.effectiveCursor(id, session),
				readBase: (id) => this.publishedStable(id, session) ?? null,
				cursorFloor: (id) => this.effectiveCursor(id, session),
				activeBlock: (id) => this.activeTerminalBlock(id, session),
				eligibleCount: (id) => this.eligibleEventCount(this.ctx.sessions.get(id) === session ? session : void 0, id),
				frame: (_id, base, batchWindow) => frameProjection({
					base,
					events: batchWindow.events,
					truncation: batchWindow.truncation
				}),
				putOpenAudit: (_id, data) => this.putOpenAudit(session, data),
				putFinishedAudit: (_id, data) => this.putFinishedAudit(session, data),
				putStable: (_id, stable) => this.putStable(session, stable),
				putTerminal: (_id, terminal) => this.putTerminal(session, terminal),
				onCommitted: (id, stable) => {
					this.publishCommitted(id, stable, runtime);
				},
				scheduleAuditRepair: (id, stable, requestId) => this.scheduleAuditRepair(id, stable, requestId, session)
			});
			runtime.worker = worker;
			if (runtime.repairScheduled) this.scheduleRepair(session);
			createdRuntime = runtime;
		}
		if (runtime.stable === void 0 && this.ctx.sessions.get(session.id) === session) {
			const record = this.recordFor(session);
			if (record !== void 0) {
				runtime.stable = record.stable;
				runtime.terminal = record.terminal;
				const recovered = record.stable;
				if (recovered !== void 0) this.notifyCommitted(session.id, recovered);
				if (!runtime.repairScheduled) {
					runtime.repairScheduled = true;
					this.scheduleRepair(session);
				}
			}
			this.refreshTerminalBlock(runtime);
		}
		if (createdRuntime !== void 0) {
			const target = createdRuntime;
			queueMicrotask(() => {
				if (!this.admissionOpen || this.disabled) return;
				if (this.ctx.sessions.get(session.id) !== session) return;
				if (this.runtimes.get(session.id) !== target) return;
				target.worker.maybeScheduleStartup();
			});
		}
		return runtime;
	}
	/** Install creation/event/disposal observers that drive the workers. */
	installLifecycle() {
		this.ctx.on("session/created", (session) => {
			if (this.disabled) return;
			if (this.ctx.sessions.get(session.id) !== session) return;
			this.runtimeFor(session);
		}, { global: true });
		this.ctx.on("session/event", (session, event) => {
			if (this.disabled) return;
			if (!isEligibleType(event.type)) return;
			const projected = filterEvent({
				type: event.type,
				seq: event.seq,
				data: event.data
			});
			if (projected === null) return;
			const runtime = this.runtimes.get(session.id);
			if (runtime === void 0 || runtime.session !== session) return;
			const urgent = authorityUrgency({
				seq: projected.event.seq,
				type: projected.event.type,
				fields: projected.event.fields
			}, runtime.stable ?? null) !== void 0;
			runtime.worker.observe(event.seq);
			const target = runtime;
			queueMicrotask(() => {
				if (!this.admissionOpen || this.disabled) return;
				if (this.ctx.sessions.get(session.id) !== session) return;
				if (this.runtimes.get(session.id) !== target) return;
				if (urgent) target.worker.maybeScheduleUrgent(event.seq);
				target.worker.maybeSchedule();
			});
		}, { global: true });
		this.ctx.on("session/disposed", (session) => {
			if (this.disabled) return;
			const runtime = this.runtimes.get(session.id);
			if (runtime === void 0 || runtime.session !== session) return;
			(async () => {
				let disposeError;
				try {
					await runtime.worker.dispose();
				} catch (error) {
					disposeError = error;
				} finally {
					if (this.runtimes.get(session.id) === runtime) this.runtimes.delete(session.id);
				}
				if (disposeError !== void 0) try {
					this.ctx.logger.warn(`task-state-basic: worker disposal for "${session.id}" failed: ${String(disposeError)}`);
				} catch {}
			})();
		}, { global: true });
	}
	/** The lifecycle-matching stored record, or `undefined` (absent or mismatched). */
	recordFor(session) {
		const table = this.sessionsTable;
		if (table === void 0) return void 0;
		const record = table.get(session.id);
		if (record === void 0) return void 0;
		const identity = record.session;
		if (identity.createdAt !== session.header.createdAt || identity.cwd !== session.header.cwd) return;
		return record;
	}
	/**
	* Read the effective committed cursor for one Session: the newest of the
	* committed stable's `sourceCursor` (absent before the first commit) and the
	* durable terminal verdict's cursor. A verdict therefore never has to be
	* carried by a stable, and a stable never silently discards one.
	*
	* The result is always fenced against the Session's own-event boundary, so a
	* forked child can never fold (or report coverage of) its inherited prefix:
	* see {@link fenceCursor}.
	*/
	effectiveCursor(id, expectedSession) {
		const session = expectedSession ?? this.ctx.sessions.get(id);
		if (session === void 0) return -1;
		const inherited = sessionInheritedPrefix(session);
		const runtime = this.runtimes.get(id);
		if (runtime !== void 0 && (expectedSession === void 0 || runtime.session === expectedSession)) {
			const stableCursor = runtime.stable?.sourceCursor ?? -1;
			const terminalCursor = runtime.terminal?.cursor ?? -1;
			return this.fenceCursor(session, inherited, runtime.stable?.inherited, Math.max(stableCursor, terminalCursor));
		}
		const record = this.recordFor(session);
		const stableCursor = record?.stable?.sourceCursor ?? -1;
		const terminalCursor = record?.terminal?.cursor ?? -1;
		return this.fenceCursor(session, inherited, record?.stable?.inherited, Math.max(stableCursor, terminalCursor));
	}
	/**
	* Fence one stored coverage claim against the LIVE own-event boundary of its
	* Session lifecycle.
	*
	* Below the boundary nothing may be claimed: those sequences are the parent's
	* facts, delivered to this lifecycle as history. A claim that contradicts the
	* live boundary is refused as a whole and the lifecycle re-derives from its own
	* events above the boundary, which is the conservative direction — the content
	* is still served, while no unverifiable coverage is trusted. Every lifecycle
	* that did not begin on an inherited prefix floors at `-1`, so its cursor is
	* exactly what it was before this contract existed.
	*/
	fenceCursor(session, inherited, marker, claimed) {
		const floor = inheritedCursorFloor(inherited);
		if (inheritedCoverageRefused(inherited, marker)) {
			this.warnDiagnostic(`task-state-basic: Session "${String(session.id)}" holds a coverage claim whose inherited boundary (ownBoundarySeq ${String(marker?.ownBoundarySeq)}) disagrees with the live fork cut (${String(inherited?.ownBoundarySeq)}); the claim is refused and the state is re-derived from the Session's own events above seq ${String(floor)}`);
			return floor;
		}
		return Math.max(claimed, floor);
	}
	/**
	* Emit one best-effort lifecycle diagnostic. A warning must never fail a read,
	* a commit, or a startup path, and a throwing logger must not escape.
	*/
	warnDiagnostic(message) {
		try {
			this.ctx.logger.warn(message);
		} catch {}
	}
	/**
	* The generation of one Session's CURRENT measurable situation: the committed
	* base stable (revision identity, cursor, digest, and filter version) together
	* with the configured framed-input budget. A terminal verdict stores the
	* generation it was measured against, so this is what decides whether the
	* window must be re-opened.
	*/
	currentGeneration(session) {
		const stable = this.publishedStable(session.id, session) ?? this.recordFor(session)?.stable ?? null;
		return terminalGeneration(stable, this.config.maxInputBytes);
	}
	/**
	* Recompute one runtime's ACTIVE terminal block from its durable verdict.
	* Called after a verdict write and after every commit, because a commit
	* changes the base generation and therefore re-opens a blocked window.
	*/
	refreshTerminalBlock(runtime, session) {
		if (runtime === void 0) return;
		const live = session ?? runtime.session;
		if (this.ctx.sessions.get(runtime.session.id) !== runtime.session) {
			runtime.terminalBlock = void 0;
			return;
		}
		runtime.terminalBlock = activeTerminalBlock(runtime.terminal, this.currentGeneration(live));
	}
	/**
	* The still-active block of one Session, or `undefined` when its verdict is a
	* quarantine or its generation no longer matches. The provider reads the
	* durable record for a runtime it does not own, so a Session hydrated later
	* still answers with its own stored, generation-fenced block.
	*/
	activeTerminalBlock(id, expectedSession) {
		const session = expectedSession ?? this.ctx.sessions.get(id);
		if (session === void 0) return void 0;
		const runtime = this.runtimes.get(id);
		if (runtime !== void 0 && (expectedSession === void 0 || runtime.session === expectedSession)) return runtime.terminalBlock;
		return activeTerminalBlock(this.recordFor(session)?.terminal, this.currentGeneration(session));
	}
	/**
	* Count PROJECTABLE eligible events above the committed cursor for one
	* Session by running the real versioned filter over each event.
	*/
	eligibleEventCount(session, id) {
		if (session === void 0 || this.disabled) return 0;
		const cursor = this.effectiveCursor(id, session);
		let count = 0;
		for (const event of session.snapshotEvents()) {
			if (event.seq <= cursor) continue;
			if (!isEligibleType(event.type)) continue;
			if (filterEvent({
				type: event.type,
				seq: event.seq,
				data: event.data
			}) === null) continue;
			count += 1;
		}
		return count;
	}
	/** Put one open-phase audit row keyed by the request id. */
	async putOpenAudit(session, data) {
		const audit = this.auditTable;
		if (audit === void 0 || !this.admissionOpen || this.disabled) return;
		if (this.ctx.sessions.get(session.id) !== session) return;
		await audit.put(String(data.requestId), openAuditRow(data.requestId, lifecycleOf(session), data));
	}
	/** Put one finished-phase audit update on the request id's existing open row. */
	async putFinishedAudit(session, finished) {
		const audit = this.auditTable;
		if (audit === void 0 || !this.admissionOpen || this.disabled) return;
		const key = String(finished.requestId ?? "");
		if (key.length === 0) return;
		const existing = audit.get(key);
		if (existing === void 0) {
			try {
				this.ctx.logger.warn(`task-state-basic: ${session.id} finished audit for unknown open row "${key}" dropped`);
			} catch {}
			return;
		}
		if (this.ctx.sessions.get(session.id) !== session) return;
		const stable = finished.outcome === "success" || finished.outcome === "repair" ? this.publishedStable(session.id, session) : void 0;
		if (stable !== void 0) {
			await this.finishOpenAudit(existing.requestId, lifecycleOf(session), stable, finished);
			return;
		}
		await audit.update(key, (current) => current.finished === void 0 ? finishAuditRow(current, finished) : current);
	}
	/**
	* The authoritative commit: replace one Session's stable record.
	*
	* The durable terminal verdict — when the lifecycle holds one — is carried
	* forward VERBATIM inside the same record put, so a commit can neither
	* resurrect a quarantined window nor lose the typed reason why a blocked one
	* is blocked. The verdict keeps its own stored generation: a commit changes
	* the current generation, so the next decision about that window is a
	* re-evaluation against the NEW base rather than an inherited ban.
	*/
	async putStable(session, stable) {
		const id = session.id;
		if (this.ctx.sessions.get(id) !== session) throw new Error(`task-state-basic: session "${id}" is not live`);
		const table = this.sessionsTable;
		if (table === void 0) throw new Error("task-state-basic: domain is not initialized");
		const existing = table.get(id);
		if (existing !== void 0 && (existing.session.createdAt !== session.header.createdAt || existing.session.cwd !== session.header.cwd)) throw new Error(`task-state-basic: session "${id}" record belongs to another lifecycle and cannot be overwritten`);
		const runtime = this.runtimes.get(id);
		const terminal = existing?.terminal ?? runtime?.terminal;
		await table.put(id, {
			session: {
				createdAt: session.header.createdAt,
				...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
			},
			stable,
			...terminal !== void 0 ? { terminal } : {}
		});
		this.refreshTerminalBlock(runtime, session);
	}
	/**
	* Persist ONE durable terminal verdict.
	*
	* The write carries the lifecycle identity, the untouched committed stable
	* WHEN one exists, and the verdict — all inside ONE record put, because one
	* `KvTable.put` is the only atomic durable boundary this storage contract
	* offers (per-table puts are separate whole-document rewrites). The effective
	* cursor (`max(stable?.sourceCursor ?? -1, terminal.cursor)`) therefore can
	* never advance without its provenance, and a rejected or failed put changes
	* neither the medium nor the in-memory pointer.
	*
	* `stable` is NOT required: a verdict is recorded just as durably before the
	* Session's first commit, so an impossible window no longer has to stall
	* forever. It NEVER manufactures a stable — the record simply carries none.
	*
	* Admission is monotone:
	* - a `quarantined` verdict must strictly advance the effective cursor past
	*   the floor it was measured against, so a quarantine can never be a no-op
	*   and can never move the cursor backwards;
	* - a `block…` verdict must name the CURRENT generation. It records the
	*   typed reason why the pending window stays pending, so a restart does not
	*   re-fold (and never re-pays for) a window whose cause is unchanged, while
	*   a changed base/filter/budget re-opens it. A block that would restate the
	*   verdict already stored for the same generation is refused, so a blocked
	*   window cannot churn the medium.
	*
	* Single-writer contract: this is a read-modify-write on the JSON domain's
	* single unit and there is NO record-level compare-and-swap (B1 is
	* `blocked-upstream`), so it is only safe while one process writes the
	* domain. It never claims CAS.
	* @param session - the live Session whose record is written.
	* @param terminal - the terminal verdict to record.
	* @returns whether the verdict became durable (and therefore took effect).
	*/
	async putTerminal(session, terminal) {
		if (!this.admissionOpen || this.disabled) return false;
		const id = session.id;
		if (this.ctx.sessions.get(id) !== session) return false;
		const table = this.sessionsTable;
		if (table === void 0) return false;
		const existing = table.get(id);
		if (existing !== void 0 && (existing.session.createdAt !== session.header.createdAt || existing.session.cwd !== session.header.cwd)) return false;
		const runtime = this.runtimes.get(id);
		const published = runtime !== void 0 && runtime.session === session ? runtime.stable : void 0;
		const stable = existing?.stable ?? published;
		const floor = Math.max(stable?.sourceCursor ?? -1, existing?.terminal?.cursor ?? -1);
		if (terminal.kind === "quarantined") {
			if (terminal.cursor <= floor) return false;
		} else {
			const current = this.currentGeneration(session);
			if (terminal.cursor !== floor) return false;
			if (existing?.terminal !== void 0 && existing.terminal.kind !== "quarantined" && sameTerminalGeneration(existing.terminal.generation, current) && existing.terminal.kind === terminal.kind && existing.terminal.blockSeq === terminal.blockSeq) return false;
			if (!sameTerminalGeneration(terminal.generation, current)) return false;
		}
		const next = {
			session: {
				createdAt: session.header.createdAt,
				...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
			},
			...stable !== void 0 ? { stable } : {},
			terminal
		};
		await table.put(id, next);
		if (runtime !== void 0 && runtime.session === session) {
			runtime.terminal = terminal;
			this.refreshTerminalBlock(runtime, session);
		}
		return true;
	}
	/** Publish the committed pointer only after the authority put resolved. */
	publishCommitted(id, stable, expectedRuntime) {
		const runtime = this.runtimes.get(id);
		if (runtime === void 0) return;
		if (expectedRuntime !== void 0 && runtime !== expectedRuntime) return;
		const live = this.ctx.sessions.get(id);
		if (live === void 0 || live !== runtime.session) return;
		runtime.stable = stable;
		this.refreshTerminalBlock(runtime, live);
		this.notifyCommitted(id, stable);
	}
	/** Announce one published or recovered stable to every committed observer. */
	notifyCommitted(id, stable) {
		for (const listener of this.committedListeners) try {
			listener(id, stable);
		} catch (error) {
			try {
				this.ctx.logger.warn(`task-state-basic: committed observer for "${id}" failed: ${String(error)}`);
			} catch {}
		}
	}
	/**
	* Observe every committed stable after its authority put resolved, plus the
	* stable recovered from storage when a runtime first seeds it. The listener
	* receives the Session identity and the committed stable; live audit repairs
	* never publish (they certify an already-published stable), so an observer
	* sees exactly the values that advanced the published pointer — including
	* the startup/reconnect recovery that advances it from nothing to a durable
	* stable, which is how an already-open remote stream hydrates a Session
	* whose baseline was read before the seed.
	*
	* The subscription is caller-owned: the returned disposer removes this
	* listener and must be run by the caller's teardown. The provider unload
	* additionally clears every remaining subscription so a disposed provider
	* never notifies. This is a minimal observer seam for Host-side consumers
	* (remote streams); it never writes the Session log and never changes the
	* storage authority or the lifecycle fence.
	* @param listener - committed-stable observer to add.
	* @returns a disposer removing this listener.
	*/
	subscribeCommitted(listener) {
		this.committedListeners.add(listener);
		return () => {
			this.committedListeners.delete(listener);
		};
	}
	/** Replace the user-editable stable content under optimistic revision control. */
	async editStable(request) {
		if (this.disabled || !this.admissionOpen) return {
			ok: false,
			code: "unavailable",
			message: "Task-state storage is unavailable."
		};
		const session = this.ctx.sessions.get(request.sessionId);
		if (session === void 0) return {
			ok: false,
			code: "not-found",
			message: "The session is no longer available."
		};
		const runtime = this.runtimeFor(session);
		if (runtime === void 0) return {
			ok: false,
			code: "not-found",
			message: "The session is no longer available."
		};
		try {
			return await runtime.worker.enqueueMutation(async () => {
				if (this.disabled || !this.admissionOpen) return {
					ok: false,
					code: "unavailable",
					message: "Task-state storage is unavailable."
				};
				const liveStart = this.ctx.sessions.get(request.sessionId);
				if (liveStart !== session || this.runtimes.get(request.sessionId) !== runtime) {
					if (liveStart === void 0) return {
						ok: false,
						code: "unavailable",
						message: "The session is no longer available."
					};
					const activeStable = this.runtimes.get(request.sessionId)?.stable;
					return {
						ok: false,
						code: "conflict",
						message: "The summary changed while it was being edited.",
						...activeStable !== void 0 ? { stable: activeStable } : {}
					};
				}
				const current = runtime.stable;
				if (current === void 0) return {
					ok: false,
					code: "not-found",
					message: "No task-state summary exists for this session."
				};
				if (current.revision !== request.expectedRevision) return {
					ok: false,
					code: "conflict",
					message: "The summary changed while it was being edited.",
					stable: current
				};
				let content;
				try {
					content = this.resolveManualContent(current, request.value);
				} catch (error) {
					return {
						ok: false,
						code: "invalid",
						message: String(error instanceof Error ? error.message : error)
					};
				}
				const inherited = sessionInheritedPrefix(session);
				const stable = commitStable(content, current.schemaVersion, current.revision + 1, current.filterVersion, current.sourceCursor, inherited);
				const requestId = TaskStateRequestId(`ts-manual-${randomUUID()}`);
				const identity = lifecycleOf(session);
				const open = {
					requestId,
					revision: stable.revision,
					trigger: "manual",
					base: current,
					includedSeqs: [],
					filterVersion: current.filterVersion,
					system: "User-authored task-state edit.",
					route: {
						provider: "dsh-context-enhancement",
						model: "manual-edit"
					},
					maxTokens: 0,
					schema: {
						version: current.schemaVersion,
						material: { source: "manual-edit" }
					},
					truncation: [],
					...inherited === null ? {} : { inherited }
				};
				await this.putOpenAudit(session, open);
				if (this.disabled || !this.admissionOpen) return {
					ok: false,
					code: "unavailable",
					message: "Task-state storage is unavailable."
				};
				const liveAfterAudit = this.ctx.sessions.get(request.sessionId);
				if (liveAfterAudit !== session || this.runtimes.get(request.sessionId) !== runtime) {
					if (liveAfterAudit === void 0) return {
						ok: false,
						code: "unavailable",
						message: "The session is no longer available."
					};
					const activeStable = this.runtimes.get(request.sessionId)?.stable;
					return {
						ok: false,
						code: "conflict",
						message: "The summary changed while it was being edited.",
						...activeStable !== void 0 ? { stable: activeStable } : {}
					};
				}
				await this.putStable(session, stable);
				if (this.disabled || !this.admissionOpen) return {
					ok: false,
					code: "unavailable",
					message: "Task-state storage is unavailable."
				};
				const liveAfterPut = this.ctx.sessions.get(request.sessionId);
				if (liveAfterPut !== session || this.runtimes.get(request.sessionId) !== runtime) {
					if (liveAfterPut === void 0) return {
						ok: false,
						code: "unavailable",
						message: "The session is no longer available."
					};
					const activeStable = this.runtimes.get(request.sessionId)?.stable;
					return {
						ok: false,
						code: "conflict",
						message: "The summary changed while it was being edited.",
						...activeStable !== void 0 ? { stable: activeStable } : {}
					};
				}
				this.publishCommitted(request.sessionId, stable, runtime);
				try {
					await this.finishOpenAudit(requestId, identity, stable, {
						outcome: "manual",
						requestId,
						revision: stable.revision,
						sourceCursor: stable.sourceCursor
					});
				} catch (error) {
					try {
						this.ctx.logger.error(`task-state-basic: ${request.sessionId} manual-edit audit finish failed: ${String(error)}`);
					} catch {}
					await this.scheduleAuditRepair(request.sessionId, stable, String(requestId), session);
				}
				return {
					ok: true,
					stable
				};
			});
		} catch (error) {
			if (error instanceof Error && error.message === "task-state-basic/session-disposed") return {
				ok: false,
				code: "unavailable",
				message: "The session is no longer available."
			};
			throw error;
		}
	}
	/** Validate, bound-check, and identity-map user-authored stable fields. */
	resolveManualContent(current, value) {
		const text = (field, input, empty) => {
			const resolved = input.trim();
			if (!empty && resolved.length === 0) throw new Error(`${field} contains an empty item.`);
			if (Buffer$1.byteLength(resolved, "utf8") > this.config.maxEntryBytes) throw new Error(`${field} exceeds ${this.config.maxEntryBytes} UTF-8 bytes.`);
			return resolved;
		};
		const plainList = (field, input) => {
			if (input.length > this.config.maxListItems) throw new Error(`${field} has too many items.`);
			return input.map((item, index) => text(`${field}[${index}]`, item, false));
		};
		const entries = (field, prefix, input) => {
			if (input.length > this.config.maxEntriesPerKind) throw new Error(`${field} has too many items.`);
			const available = [...current[field]];
			return input.map((item, index) => {
				const content = text(`${field}[${index}]`, item, false);
				const existingIndex = available.findIndex((entry) => entry.content === content);
				if (existingIndex >= 0) return available.splice(existingIndex, 1)[0];
				return {
					id: TaskStateEntryId(`${prefix}-${randomUUID()}`),
					content
				};
			});
		};
		return {
			facts: entries("facts", "fact", value.facts),
			decisions: entries("decisions", "decision", value.decisions),
			constraints: entries("constraints", "constraint", value.constraints),
			risks: entries("risks", "risk", value.risks),
			continuation: {
				currentObjective: text("currentObjective", value.currentObjective, true),
				currentFocus: text("currentFocus", value.currentFocus, true),
				openWork: plainList("openWork", value.openWork),
				nextActions: plainList("nextActions", value.nextActions)
			},
			evidence: current.evidence,
			todoReferences: current.todoReferences,
			goalView: current.goalView,
			todoView: current.todoView
		};
	}
	/** The published committed pointer, or `undefined`. */
	publishedStable(id, expectedSession) {
		const runtime = this.runtimes.get(id);
		if (runtime === void 0) return void 0;
		const live = this.ctx.sessions.get(id);
		if (live === void 0 || live !== runtime.session) return void 0;
		if (expectedSession !== void 0 && live !== expectedSession) return void 0;
		return runtime.stable;
	}
	/** Read the synchronous committed stable of one Session. */
	getStable(sessionId) {
		if (this.disabled) return void 0;
		return this.publishedStable(sessionId);
	}
	/**
	* Read the synchronous durable terminal verdict of one Session, if present:
	* a `quarantined` culprit window or a `block…` verdict naming a measured
	* cause that is not a log event (an oversized base stable, or an authority
	* fact that may never be skipped).
	*/
	getTerminal(sessionId) {
		if (this.disabled) return void 0;
		const runtime = this.runtimes.get(sessionId);
		if (runtime !== void 0) return runtime.terminal;
		const session = this.ctx.sessions.get(sessionId);
		if (session === void 0) return void 0;
		return this.recordFor(session)?.terminal;
	}
	/**
	* Read the terminal BLOCK of one Session that still applies to the current
	* base/filter/budget generation, or `undefined`. A quarantine never blocks,
	* and a block whose generation changed is already re-openable.
	*/
	getActiveTerminalBlock(sessionId) {
		if (this.disabled) return void 0;
		return this.activeTerminalBlock(sessionId);
	}
	/**
	* Read the whole durable record of one Session, if present. The record may
	* carry a terminal verdict without any committed stable (an impossible
	* window before the first commit), which is why `stable` is optional.
	*/
	getRecord(sessionId) {
		if (this.disabled) return void 0;
		const session = this.ctx.sessions.get(sessionId);
		if (session === void 0) return void 0;
		return this.recordFor(session);
	}
};
/** Render one domain-open failure into a bounded diagnostic. */
function describeOpenFailure(error) {
	if (error instanceof Error) {
		const code = error.code;
		const codeText = code === void 0 ? void 0 : typeof code === "string" || typeof code === "number" ? String(code) : JSON.stringify(code);
		return codeText === void 0 ? error.message : `${codeText}: ${error.message}`;
	}
	return String(error);
}
//#endregion
//#region lib/types/task-state-basic.js
/**
* dsh-context-enhancement — `./task-state-basic` subpath.
*
* The durable task-state provider (`ctx.taskState`): the sole MVP owner of
* the authoritative `context_enhancement_task_state` storage domain, the
* published committed pointers, the versioned input filter, per-Session
* background scheduling, independent auxiliary LLM calls, output validation,
* private writes, and lifecycle.
*
* The default export is the Loader-recognizable Service class (the Loader
* treats a default-exported Service subclass as a mountable plugin row). The
* provider declares NO SessionEventMap members: its audit vocabulary lives in
* its own storage-domain `audit` table, never in the Session log.
*
* @module dsh-context-enhancement/task-state-basic
*/
var task_state_basic_default = TaskStateBasicService;
//#endregion
export { TaskStateBasicService, task_state_basic_default as default, taskStateDomainSpec };
