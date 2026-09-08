import { S as TaskStateRequestId, a as openAuditRow, c as taskStateAuditSchema, i as highestCertifiedRevision, m as taskStateRecordSchema, o as rowsForLifecycle, r as finishAuditRow, s as selectRepairRow, t as TaskStateService, u as taskStateCandidateSchema, x as TaskStateEntryId, y as taskStateStableSchema } from "./contract-BuVHI3zF.js";
import { t as Schema } from "./lib-Bj3jGSND.js";
import { a as createUserMessage, d as MAX_TIMER_DELAY_MS, f as deadline, i as contentHasImage, p as timeoutOf, t as BlockAssembler } from "./lib-DXy8Ramy.js";
import { n as domainTable, t as defineDomain } from "./lib-biAw7Hvg.js";
import { Service } from "@deepseek-ai/cordis";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
//#region lib/types/internal/task-state/basic/domain.js
/**
* Storage-domain declaration for authoritative durable task state. The
* provider opens this one process-global domain with the `single` layout so a
* damaged or incompatible document fails activation loudly as a whole instead
* of being read as an empty medium.
*
* Two tables:
* - `sessions`, keyed directly by the Session id, holds the authoritative
*   lifecycle-fenced record (identity + latest committed stable);
* - `audit`, keyed by the Host-minted request id, holds the per-request
*   open/finished phases (the pre-dispatch request evidence and its outcome).
*
* The audit table is diagnostic-only: it never becomes a second state
* authority, and there is no cross-table atomicity assumption between the two
* tables.
* @module dsh-context-enhancement/internal/task-state/basic/domain
*/
/**
* Domain identity and durable schemas of the authoritative task-state store.
* The name is deliberately deployment-owned (`context_enhancement_task_state`)
* so an install of this bundle never collides with an upstream `task_state`
* domain of a different format.
*/
const taskStateDomainSpec = defineDomain({
	name: "context_enhancement_task_state",
	version: 1,
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
/** UTF-8 byte length of {@link TRUNCATION_MARKER}. */
const MARKER_BYTES = Buffer.byteLength("…", "utf8");
/**
* Bound a string to an explicit UTF-8 byte limit, cutting on code-point
* boundaries so no multibyte character is split. The cut appends the fixed
* {@link TRUNCATION_MARKER} and never exceeds the limit; an empty value at a
* limit below the marker size keeps only the marker.
* @param value - the string to bound.
* @param limitBytes - explicit UTF-8 byte limit.
* @returns the retained text and the truncation facts.
*/
function boundUtf8(value, limitBytes) {
	const actualBytes = Buffer.byteLength(value, "utf8");
	if (actualBytes <= limitBytes) return {
		text: value,
		truncated: false,
		keptBytes: actualBytes
	};
	if (limitBytes < MARKER_BYTES) throw new Error(`task-state-basic: byte limit ${limitBytes} is below the marker size ${MARKER_BYTES}`);
	let kept = "";
	let keptBytes = 0;
	for (const codePoint of value) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (keptBytes + codePointBytes + MARKER_BYTES > limitBytes) break;
		kept += codePoint;
		keptBytes += codePointBytes;
	}
	return {
		text: `${kept}…`,
		truncated: true,
		keptBytes: keptBytes + MARKER_BYTES
	};
}
/**
* Bound a JSON-safe string field, appending one truncation record when the
* bound cut the value.
* @param path - dotted field path recorded on the truncation record.
* @param value - the string to bound.
* @param limitBytes - explicit UTF-8 byte limit.
* @param records - mutable truncation accumulator this call appends to.
* @returns the bounded text.
*/
function boundField(path, value, limitBytes, records) {
	const result = boundUtf8(value, limitBytes);
	if (result.truncated) records.push({
		path,
		limitBytes,
		keptBytes: result.keptBytes
	});
	return result.text;
}
//#endregion
//#region lib/types/internal/task-state/basic/filter.js
/** Deterministic filter version recorded on requests and committed stables. */
const TASK_STATE_FILTER_VERSION = "task-state-basic/filter-v2";
/** Shipped default per-field byte limits (whole-batch budget stays deployment config). */
const DEFAULT_FILTER_FIELD_LIMITS = Object.freeze({
	userMessageBytes: 4e3,
	assistantMessageBytes: 2e3,
	toolNameBytes: 200,
	toolArgumentsBytes: 2e3,
	toolResultTextBytes: 4e3,
	toolResultMetaBytes: 2e3,
	jsonLeafStringBytes: 400,
	errorBytes: 400,
	commandBytes: 400,
	stateBytes: 2e3
});
/** Slash-command names whose durable lifecycle materially changes task intent. */
const LIFECYCLE_COMMANDS = /* @__PURE__ */ new Set([
	"goal",
	"plan",
	"compact"
]);
/** JSON leaves that look like binary/base64/bytes never enter the projection. */
const BINARY_LEAF_PATTERN = /^(?:[A-Za-z0-9+/]{16,}={0,2}|data:[^;,]{1,40};base64,)/u;
/** Maximum array entries and object nesting retained by the JSON leaf walk. */
const MAX_JSON_ARRAY_ITEMS = 8;
const MAX_JSON_DEPTH = 6;
/** Text fragments of one content-block list (raw reasoning excluded by block type). */
function textOf(blocks) {
	if (!Array.isArray(blocks)) return "";
	const collected = [];
	for (const block of blocks) {
		if (!isRecord(block) || block["type"] !== "text") continue;
		const text = block["text"];
		if (typeof text === "string" && text.trim().length > 0) collected.push(text);
	}
	return collected.join("\n");
}
/** The durable text of one `tool-result` message: its inner content blocks. */
function toolResultText(message) {
	if (!isRecord(message)) return "";
	const content = message["content"];
	if (!Array.isArray(content)) return "";
	const block = content[0];
	if (!isRecord(block) || block["type"] !== "tool-result") return "";
	return textOf(block["content"]);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Whether one parsed JSON leaf string is worth retaining. */
function isMeaningfulLeaf(value) {
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	return !BINARY_LEAF_PATTERN.test(trimmed);
}
/**
* Collect the meaningful scalar leaves of one parsed JSON value as bounded
* `path -> text` entries, with deterministic array caps and depth bounds.
* An array over the item cap and any container at the depth bound each leave
* one deterministic `…` marker leaf under the cut path.
*/
function jsonLeaves(value, path, out, leafBytes, depth, records) {
	if (depth > MAX_JSON_DEPTH) {
		out.push({
			path: `${path}…`,
			value: "…"
		});
		return;
	}
	if (value === null || value === void 0) return;
	if (typeof value === "string") {
		if (!isMeaningfulLeaf(value)) return;
		out.push({
			path,
			value: boundField(path, value, leafBytes, records)
		});
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		out.push({
			path,
			value: String(value)
		});
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			if (index >= MAX_JSON_ARRAY_ITEMS) {
				out.push({
					path: `${path}[${index}…]`,
					value: "…"
				});
				return;
			}
			jsonLeaves(child, `${path}[${index}]`, out, leafBytes, depth + 1, records);
		}
		return;
	}
	for (const [key, child] of Object.entries(value)) jsonLeaves(child, path === "" ? key : `${path}.${key}`, out, leafBytes, depth + 1, records);
}
/** Render bounded leaves as a deterministic JSON record (first value wins on a repeated path). */
function renderLeaves(leaves) {
	if (leaves.length === 0) return "";
	const record = {};
	for (const leaf of leaves) record[leaf.path] ??= leaf.value;
	return JSON.stringify(record);
}
/** Parse tool-call arguments; malformed JSON degrades to the raw bounded string. */
function projectArguments(argumentsRaw, leafBytes, wholeBytes, records) {
	const raw = typeof argumentsRaw === "string" ? argumentsRaw.trim() : "";
	if (raw.length === 0) return {
		kind: "raw",
		text: ""
	};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			kind: "raw",
			text: boundField("tool/call.arguments", raw, wholeBytes, records)
		};
	}
	const leaves = [];
	jsonLeaves(parsed, "", leaves, leafBytes, 0, records);
	return {
		kind: "json",
		leaves
	};
}
/** Whether a message's source is a direct human or authorized goal continuation. */
function directHumanKind(message) {
	if (!isRecord(message)) return void 0;
	const source = message["source"];
	if (!isRecord(source)) return void 0;
	const kind = source["kind"];
	if (kind !== "user" && kind !== "goal") return void 0;
	return kind;
}
/** Join message text blocks of a user/assistant/tool message. */
function messageText(message) {
	/* v8 ignore next 3 -- every caller passes a record already checked by isRecord. */
	if (!isRecord(message)) return "";
	const content = message["content"];
	if (!Array.isArray(content)) return "";
	return textOf(content);
}
/** Turn-end reason projected as bounded durable facts. */
function projectTurnEndReason(reason) {
	if (!isRecord(reason)) return null;
	const kind = reason["kind"];
	if (kind === "aborted") {
		const inner = reason["reason"];
		const innerKind = isRecord(inner) ? inner["kind"] : void 0;
		return {
			kind,
			reason: { kind: innerKind === void 0 ? "unknown" : innerKind }
		};
	}
	if (kind === "error") {
		const error = reason["error"];
		const code = isRecord(error) ? error["code"] : void 0;
		return {
			kind,
			...code === void 0 ? {} : { code }
		};
	}
	return { kind };
}
/** Bound one optional durable string field, dropping it when absent or blank. */
function optionalBound(record, key, path, limitBytes, records) {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) return void 0;
	return boundField(path, value, limitBytes, records);
}
/** Read one durable field, dropping non-string values to ''. */
function stringField(value) {
	return typeof value === "string" ? value : "";
}
/**
* Project one eligible Session event into owned lossless JSON. Only events the
* filter marks eligible reach this function; each projection reads only the
* durable fields recorded by that event through the widened JSON view and
* never copies the full event.
* @param event - eligible source Session event (widened).
* @param limits - explicit field byte limits.
* @param records - truncation accumulator this projection appends to.
* @returns the owned projection fields, or `undefined` when the event projects nothing meaningful.
*/
function projectEvent(event, limits, records) {
	const data = event.data;
	switch (event.type) {
		case "user/message": {
			const kind = directHumanKind(data);
			if (kind === void 0) return void 0;
			const text = messageText(data);
			if (text.trim().length === 0) return void 0;
			return {
				kind: kind === "goal" ? "goal-continuation" : "user",
				text: boundField("user/message.text", text, limits.userMessageBytes, records)
			};
		}
		case "assistant/message": {
			if (isRecord(data) && data["interrupted"] === true) return void 0;
			if (!isRecord(data) || !isRecord(data["message"])) return void 0;
			const text = messageText(data["message"]);
			if (text.trim().length === 0) return void 0;
			return {
				kind: "assistant",
				text: boundField("assistant/message.text", text, limits.assistantMessageBytes, records)
			};
		}
		case "tool/call": {
			if (!isRecord(data)) return void 0;
			const name = boundField("tool/call.name", stringField(data["name"]), limits.toolNameBytes, records);
			const projected = projectArguments(data["arguments"], limits.jsonLeafStringBytes, limits.toolArgumentsBytes, records);
			const args = projected.kind === "json" ? boundField("tool/call.arguments", renderLeaves(projected.leaves), limits.toolArgumentsBytes, records) : projected.text;
			const result = {
				kind: "tool/call",
				name,
				callId: stringField(data["callId"])
			};
			if (args.trim().length > 0) result.arguments = args;
			return result;
		}
		case "tool/result": {
			if (!isRecord(data)) return void 0;
			const message = data["message"];
			const content = isRecord(message) ? message["content"] : void 0;
			const first = Array.isArray(content) ? content[0] : void 0;
			const block = isRecord(first) ? first : void 0;
			const callId = block !== void 0 && block["type"] === "tool-result" ? stringField(block["toolCallId"]) : "";
			const isError = block !== void 0 && block["isError"] === true;
			const text = toolResultText(message);
			const error = data["error"];
			const result = {
				kind: "tool/result",
				callId,
				isError
			};
			if (text.trim().length > 0) result.text = boundField("tool/result.text", text, limits.toolResultTextBytes, records);
			if (isRecord(error)) {
				const name = optionalBound(error, "name", "tool/result.error.name", limits.errorBytes, records);
				const code = optionalBound(error, "code", "tool/result.error.code", limits.errorBytes, records);
				if (name !== void 0 || code !== void 0) result.error = {
					...name === void 0 ? {} : { name },
					...code === void 0 ? {} : { code }
				};
			}
			const meta = data["meta"];
			if (meta !== void 0) {
				const metaLeaves = [];
				jsonLeaves(meta, "meta", metaLeaves, limits.jsonLeafStringBytes, 0, records);
				const rendered = renderLeaves(metaLeaves);
				if (rendered.trim().length > 0) result.meta = boundField("tool/result.meta", rendered, limits.toolResultMetaBytes, records);
			}
			if (result.text === void 0 && result.meta === void 0 && result.error === void 0) return void 0;
			return result;
		}
		case "turn/end":
			if (!isRecord(data)) return void 0;
			return {
				kind: "turn/end",
				turn: data["turn"],
				reason: projectTurnEndReason(data["reason"])
			};
		case "goal/change": {
			if (!isRecord(data)) return void 0;
			const operation = data["operation"];
			if (operation === "clear") return {
				kind: "goal/change",
				operation: "clear"
			};
			const goal = data["goal"];
			if (!isRecord(goal)) return void 0;
			const roundsStarted = data["roundsStarted"];
			return {
				kind: "goal/change",
				operation,
				goal: {
					...typeof goal["id"] === "string" ? { id: goal["id"] } : {},
					...typeof goal["revision"] === "number" && Number.isSafeInteger(goal["revision"]) ? { revision: goal["revision"] } : {},
					...typeof goal["phase"] === "string" ? { phase: goal["phase"] } : {},
					objective: boundField("goal/change.objective", stringField(goal["objective"]), limits.stateBytes, records),
					...typeof goal["maxGoalRounds"] === "number" && Number.isSafeInteger(goal["maxGoalRounds"]) ? { maxGoalRounds: goal["maxGoalRounds"] } : {},
					...typeof roundsStarted === "number" && Number.isSafeInteger(roundsStarted) ? { roundsStarted } : {},
					...isRecord(goal["blockedReason"]) && typeof goal["blockedReason"]["code"] === "string" ? { blockedReason: goal["blockedReason"]["code"] } : {}
				}
			};
		}
		case "request/header": {
			if (!isRecord(data)) return void 0;
			const reason = data["reason"];
			if (reason !== "initial" && reason !== "resume" && reason !== "change") return void 0;
			const header = data["header"];
			if (!isRecord(header)) return void 0;
			const config = header["config"];
			if (!isRecord(config)) return void 0;
			const provider = stringField(config["provider"]);
			const model = stringField(config["model"]);
			if (provider.length === 0 || model.length === 0) return void 0;
			const result = {
				kind: "request/header",
				reason,
				provider: boundField("request/header.provider", provider, limits.toolNameBytes, records),
				model: boundField("request/header.model", model, limits.toolNameBytes, records)
			};
			const reasoningEffort = config["reasoningEffort"];
			if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) result.reasoningEffort = boundField("request/header.reasoningEffort", reasoningEffort, limits.toolNameBytes, records);
			return result;
		}
		case "agent-preset/selected": {
			if (!isRecord(data)) return void 0;
			const preset = stringField(data["agentPreset"]);
			if (preset.length === 0) return void 0;
			return {
				kind: "agent-preset/selected",
				preset: boundField("agent-preset/selected.preset", preset, limits.toolNameBytes, records)
			};
		}
		case "compaction/start":
			if (!isRecord(data)) return void 0;
			return {
				kind: "compaction/start",
				compactionId: boundField("compaction/start.compactionId", stringField(data["compactionId"]), limits.errorBytes, records),
				...typeof data["turn"] === "number" && Number.isSafeInteger(data["turn"]) ? { turn: data["turn"] } : {}
			};
		case "compaction/end": {
			if (!isRecord(data)) return void 0;
			const error = optionalBound(data, "error", "compaction/end.error", limits.errorBytes, records);
			return {
				kind: "compaction/end",
				compactionId: boundField("compaction/end.compactionId", stringField(data["compactionId"]), limits.errorBytes, records),
				...error === void 0 ? {} : { error }
			};
		}
		case "todo/write": {
			if (!isRecord(data)) return void 0;
			const todos = data["todos"];
			if (!Array.isArray(todos) || todos.length === 0) return void 0;
			return {
				kind: "todo/write",
				todos: todos.map((todo) => ({
					content: boundField("todo/write.content", stringField(isRecord(todo) ? todo["content"] : void 0), limits.stateBytes, records),
					status: stringField(isRecord(todo) ? todo["status"] : void 0)
				}))
			};
		}
		case "plan/mode":
			if (!isRecord(data)) return void 0;
			return {
				kind: "plan/mode",
				active: data["active"] === true
			};
		case "command/run": {
			if (!isRecord(data)) return void 0;
			const name = stringField(data["name"]);
			if (!LIFECYCLE_COMMANDS.has(name)) return void 0;
			const source = isRecord(data["source"]) ? data["source"]["kind"] : void 0;
			const result = {
				kind: "command/run",
				commandId: stringField(data["commandId"]),
				name
			};
			const args = optionalBound(data, "args", "command/run.args", limits.commandBytes, records);
			if (args !== void 0) result.args = args;
			if (source !== void 0) result.source = source;
			return result;
		}
		/* v8 ignore next 2 -- filterEvent gates on ELIGIBLE_TYPES before calling, so no eligible type reaches this default. */
		default: return;
	}
}
/** Event types the filter considers eligible for folding. */
const ELIGIBLE_TYPES = /* @__PURE__ */ new Set([
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"turn/end",
	"goal/change",
	"todo/write",
	"plan/mode",
	"command/run",
	"request/header",
	"agent-preset/selected",
	"compaction/start",
	"compaction/end"
]);
/** Event types that never enter the projection regardless of payload. */
const NEVER_ELIGIBLE = /* @__PURE__ */ new Set([
	"task-state/update-request",
	"task-state/update-finished",
	"context-enhancement/task-state-committed"
]);
/**
* Whether one event type is eligible for the task-state source filter.
* The task-state audit events and every excluded presentation/transport/chunk
* type are never eligible. The task-state audit events no longer exist as
* Session events in this implementation (they are storage-domain rows), but
* the names stay reserved so an older log that did record them (or a foreign
* producer) can never feed the fold.
* @param type - Session event type.
* @returns whether the filter may fold the event.
*/
function isEligibleType(type) {
	if (NEVER_ELIGIBLE.has(type)) return false;
	return ELIGIBLE_TYPES.has(type);
}
/**
* Filter one Session event: decide eligibility and project owned durable
* fields when the event is eligible AND projects meaningful content.
* @param event - candidate Session event.
* @param limits - explicit field byte limits.
* @returns the owned projection plus the truncation records applied, or `null`
*   when the event is ineligible or projects nothing meaningful.
*/
function filterEvent(event, limits = DEFAULT_FILTER_FIELD_LIMITS) {
	if (!isEligibleType(event.type)) return null;
	const records = [];
	const fields = projectEvent(event, limits, records);
	if (fields === void 0) return null;
	return {
		event: {
			seq: event.seq,
			type: event.type,
			fields
		},
		truncation: records
	};
}
/**
* The pinned auxiliary system instruction. It describes the exact expected
* output as JSON (facts, decisions, constraints, risks, evidence, TODO
* references, and continuation state), the Host-owned id rules, and the
* constraints the Host enforces.
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
	"  \"todoReferences\": [{ \"seq\": <number>, \"content\": \"string\" }],",
	"  \"continuation\": {",
	"    \"currentObjective\": \"string\",",
	"    \"currentFocus\": \"string\",",
	"    \"openWork\": [\"string\"],",
	"    \"nextActions\": [\"string\"]",
	"  }",
	"}",
	"",
	"Rules:",
	"- A NEW fact, decision, constraint, or risk OMITS the id: the Host mints one with the matching prefix.",
	"- An entry CARRIED FORWARD from the previous state ECHOES its exact existing id verbatim. Do not invent, rename, or change any id prefix.",
	"- An entry you remove entirely disappears; never edit the content of an entry whose id you echo — drop it and add a new entry without an id when the content changes materially.",
	"- Keep the four kinded lists authoritative and deduplicated: same fact in several lists is wrong.",
	"- `evidence` references the exact `seq` values listed as eligible in the projection; every note explains what the reference supports in one short sentence. Never reference a seq the projection did not list.",
	"- `todoReferences` records only durable todo lists already shown in the projection, by their exact `seq`, with bounded readable content.",
	"- `continuation.currentObjective` is the human task objective in force; `currentFocus` what is being worked on; `openWork` concrete unfinished work; `nextActions` concrete next steps. TODO stays separate and is only referenced, never merged into these fields.",
	"- Empty lists are `[]`. Preserve exact file paths, commands, queries, error strings, identifiers, and numeric values.",
	"- Keep every string short enough that the total output fits the reported byte budget. Output ONLY the JSON object: no Markdown fence, no commentary, no tool call."
].join("\n");
/**
* Build the deterministic model-visible input frame for one batch. The frame
* is the owned JSON that filter v2 reconstructs from the exact included
* sequences: previous stable content (or null), the filter version, the input
* schema version, the deterministic event projections, and the truncation
* records. The caller bounds the serialized frame to the batch input budget.
* @param input - base stable, projected events, and truncation records.
* @returns the serialized deterministic model-visible frame.
*/
function frameProjection(input) {
	const frame = {
		previousStable: input.base === null ? null : contentOfStable(input.base),
		filterVersion: TASK_STATE_FILTER_VERSION,
		inputSchemaVersion: 1,
		events: input.events.map((event) => ({
			seq: event.seq,
			type: event.type,
			fields: event.fields
		})),
		truncation: input.truncation
	};
	return JSON.stringify(frame);
}
/** Stable content view (without Host commit metadata) handed to the model. */
function contentOfStable(stable) {
	return {
		facts: stable.facts,
		decisions: stable.decisions,
		constraints: stable.constraints,
		risks: stable.risks,
		evidence: stable.evidence,
		todoReferences: stable.todoReferences,
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
* configured UTF-8 byte and item limits, verifies every evidence and TODO
* reference points into the folded batch window, and computes the stable
* digest over the normalized content. Any failure rejects the complete
* candidate; the previous stable and cursor stay untouched.
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
* continuation, evidence note, and TODO content; verify every echoed id exists
* in the base, is used in the list whose kind matches its prefix, echoes the
* base content VERBATIM, and is unique across the complete candidate; mint ids
* for every new entry; require every evidence and TODO reference sequence to be
* one of the exact folded eligible sequences; then validate the fully id-ed
* content against the committed-content schema.
* @param candidate - parsed and schema-validated candidate content.
* @param context - durable base and folded-window facts.
* @returns the normalized committed content.
*/
function normalizeCandidate(candidate, context) {
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
	const evidence = candidate.evidence.map((reference) => {
		if (!context.includedSeqs.has(reference.seq)) throw new Error(`task-state-basic: evidence reference ${reference.seq} is not an included eligible sequence`);
		return {
			seq: reference.seq,
			note: boundNote(reference.note)
		};
	});
	if (evidence.length > limits.maxListItems) throw new Error(`task-state-basic: candidate evidence exceeds maxListItems ${limits.maxListItems}`);
	const todoReferences = candidate.todoReferences.map((reference) => {
		if (!context.includedSeqs.has(reference.seq)) throw new Error(`task-state-basic: todo reference ${reference.seq} is not an included eligible sequence`);
		return {
			seq: reference.seq,
			content: boundNote(reference.content)
		};
	});
	if (todoReferences.length > limits.maxListItems) throw new Error(`task-state-basic: candidate todoReferences exceeds maxListItems ${limits.maxListItems}`);
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
		todoReferences,
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
* @returns the immutable committed stable.
*/
function commitStable(content, schemaVersion, revision, filterVersion, sourceCursor) {
	const stable = {
		schemaVersion,
		revision,
		filterVersion,
		sourceCursor,
		digest: digestOf(content),
		...content
	};
	const check = taskStateStableSchema.safeParse(stable);
	if (!check.success) throw new Error(`task-state-basic: committed stable failed its durable schema: ${check.error.message}`);
	return stable;
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
	let inputBytes = Buffer.byteLength(frameProjection({
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
		const nextBytes = Buffer.byteLength(frameProjection({
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
			base: attempt.base === null ? null : structuredClone(attempt.base),
			includedSeqs: [...attempt.includedSeqs],
			filterVersion: TASK_STATE_FILTER_VERSION,
			system: attempt.system,
			route: {
				provider: attempt.route.provider,
				model: attempt.route.model
			},
			maxTokens: attempt.maxOutputTokens,
			schema: { version: 1 },
			truncation: [...attempt.truncation]
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
		await hooks.putFinishedAudit({
			outcome: "failure",
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
	let normalized;
	try {
		normalized = normalizeCandidate(candidate, context);
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
	const sourceCursor = attempt.includedSeqs[attempt.includedSeqs.length - 1] ?? 0;
	let stable;
	try {
		stable = commitStable(normalized, 1, targetRevision, TASK_STATE_FILTER_VERSION, sourceCursor);
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
		attempt.ctx.logger.warn(`task-state-basic: ${attempt.sessionId} committed stable revision ${stable.revision} but its finished audit failed; repair will certify it: ${errorMessage(error)}`);
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
	return {
		base: base === null ? null : {
			revision: base.revision,
			sourceCursor: base.sourceCursor,
			entryIds: new Set(allEntryIds(base)),
			entries: allEntries(base)
		},
		includedSeqs: new Set(attempt.includedSeqs),
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
	/** Id of the owning Session, for diagnostics. */
	sessionId;
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
	* that folds nothing never inflates the threshold.
	* @param seq - sequence of one newly observed projectable eligible Session event.
	*/
	observe(seq) {
		if (seq > this.pending) this.pending = seq;
		this.pendingEligible += 1;
	}
	/** Recompute the pending eligible count from the real log and cursor. */
	recomputeEligible() {
		this.pendingEligible = this.env.eligibleCount(this.sessionId);
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
	* Launch one batch cycle: snap the batch window at this instant, then
	* serialize the async request on the worker's single chain. The snapshot is
	* what makes events arriving during the request a LATER wave.
	*/
	launch(kind) {
		if (!this.isOpen || this.active) return;
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
			const failure = {
				stage: "request",
				code: "BUDGET",
				message: `task-state-basic: batch input (${folded.frameBytes} bytes) exceeds the configured maxInputBytes (${folded.maxInputBytes}) even after deterministic truncation`
			};
			this.ctx.logger.error(`task-state-basic: ${this.sessionId} ${failure.message}`);
			this.recomputeEligible();
			return;
		}
		this.active = true;
		this.chain = this.chain.then(async () => {
			let outcome;
			try {
				outcome = await this.performBatch(folded.window);
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
		this.recomputeEligible();
		if (kind === "trailing") {
			if (this.pendingEligible >= this.minEvents) this.launch("threshold");
			return;
		}
		const wantTrailing = this.followUpRequested || this.pendingEligible >= this.minEvents;
		this.followUpRequested = false;
		if (wantTrailing && this.pendingEligible >= 1) this.launch("trailing");
	}
	/** Run one captured immutable batch window as an update cycle. */
	async performBatch(window) {
		if (!this.isOpen) return { kind: "noop" };
		const controller = new AbortController();
		this.controller = controller;
		try {
			if (this.env.liveSession(this.sessionId) === void 0) return { kind: "noop" };
			const base = this.env.readBase(this.sessionId);
			this.ctx.logger.debug(`task-state-basic: ${this.sessionId} batch over ${window.includedSeqs.length} eligible seqs`);
			const attempt = {
				ctx: this.ctx,
				route: this.env.resolveRoute(this.sessionId),
				base,
				projection: this.env.frame(this.sessionId, base, window),
				includedSeqs: window.includedSeqs,
				truncation: window.truncation,
				system: this.system,
				maxOutputTokens: this.maxOutputTokens,
				timeoutMs: this.timeoutMs,
				sessionId: this.sessionId,
				signal: controller.signal,
				limits: this.limits
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
* are processed later in the background when normal activity schedules the
* per-Session worker.
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
			this.ctx.logger.error(`task-state-basic: authoritative context_enhancement_task_state domain failed to open; task state is disabled and no stable will be published. Medium left unchanged; no model was invoked. Cause: ${describeOpenFailure(error)}`);
			return;
		}
		releaseCapture();
		this.ctx.effect(() => async () => {
			this.admissionOpen = false;
			const workers = [...this.runtimes.values()].map((runtime) => runtime.worker);
			await Promise.all(workers.map((worker) => worker.dispose()));
			await this.drainRepairs();
			this.runtimes.clear();
			this.committedListeners.clear();
			await domain.close();
		}, "task-state-basic.domainAndWorkers");
		this.sessionsTable = domain.table("sessions");
		this.auditTable = domain.table("audit");
		const seeded = /* @__PURE__ */ new Set();
		for (const session of [...this.ctx.sessions.list(), ...createdDuringOpen]) {
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
			this.ctx.logger.error(`task-state-basic: ${label} audit repair failed: ${String(error)}`);
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
		const { stable } = stored;
		const audit = this.auditTable;
		if (audit === void 0) return;
		const rows = rowsForLifecycle([...audit.entries()].map((entry) => entry[1]), lifecycleOf(session));
		if (highestCertifiedRevision(rows) >= stable.revision) return;
		const open = selectRepairRow(rows, stable.revision);
		if (open === void 0) {
			this.ctx.logger.warn(`task-state-basic: ${session.id} committed stable revision ${stable.revision} has no matching open audit row; leaving it uncertified (stable stays authoritative)`);
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
	scheduleAuditRepair(id, stable, requestId) {
		return this.trackRepair(`${id} live`, async () => {
			const session = this.ctx.sessions.get(id);
			if (session === void 0) return;
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
			if (current.finished !== void 0 || String(current.requestId) !== key || String(current.request.requestId) !== key || current.session.createdAt !== lifecycle.createdAt || current.session.cwd !== lifecycle.cwd || current.request.revision !== stable.revision || finished.outcome !== "failure" && (finished.revision !== stable.revision || finished.sourceCursor !== stable.sourceCursor)) return current;
			return finishAuditRow(current, finished);
		});
	}
	/** One runtime for a live Session: identity-fenced record + single worker. */
	runtimeFor(session) {
		let runtime = this.runtimes.get(session.id);
		if (runtime === void 0) {
			runtime = {
				worker: new TaskStateWorker(this.ctx, session, this.config, {
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
					liveSession: (id) => this.ctx.sessions.get(id),
					committedCursor: (id) => this.publishedStable(id)?.sourceCursor ?? -1,
					readBase: (id) => this.publishedStable(id) ?? null,
					eligibleCount: (id) => this.eligibleEventCount(this.ctx.sessions.get(id), id),
					frame: (_id, base, batchWindow) => frameProjection({
						base,
						events: batchWindow.events,
						truncation: batchWindow.truncation
					}),
					putOpenAudit: (id, data) => this.putOpenAudit(id, data),
					putFinishedAudit: (id, data) => this.putFinishedAudit(id, data),
					putStable: (id, stable) => this.putStable(id, stable),
					onCommitted: (id, stable) => {
						this.publishCommitted(id, stable);
					},
					scheduleAuditRepair: (id, stable, requestId) => this.scheduleAuditRepair(id, stable, requestId)
				}),
				stable: void 0,
				repairScheduled: false
			};
			this.runtimes.set(session.id, runtime);
		}
		if (runtime.stable === void 0) {
			const record = this.recordFor(session);
			if (record !== void 0) {
				runtime.stable = record.stable;
				if (!runtime.repairScheduled) {
					runtime.repairScheduled = true;
					this.scheduleRepair(session);
				}
			}
		}
		return runtime;
	}
	/** Install creation/event/disposal observers that drive the workers. */
	installLifecycle() {
		this.ctx.on("session/created", (session) => {
			if (this.disabled) return;
			this.runtimeFor(session);
		}, { global: true });
		this.ctx.on("session/event", (session, event) => {
			if (this.disabled) return;
			if (!isEligibleType(event.type)) return;
			if (filterEvent({
				type: event.type,
				seq: event.seq,
				data: event.data
			}) === null) return;
			const runtime = this.runtimes.get(session.id);
			if (runtime === void 0) return;
			runtime.worker.observe(event.seq);
			queueMicrotask(() => {
				runtime.worker.maybeSchedule();
			});
		}, { global: true });
		this.ctx.on("session/disposed", (session) => {
			if (this.disabled) return;
			const runtime = this.runtimes.get(session.id);
			if (runtime === void 0) return;
			runtime.worker.dispose().then(() => {
				this.runtimes.delete(session.id);
			}).catch((error) => {
				this.ctx.logger.warn(`task-state-basic: worker disposal for "${session.id}" failed: ${String(error)}`);
				this.runtimes.delete(session.id);
			});
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
	* Count PROJECTABLE eligible events above the committed cursor for one
	* Session by running the real versioned filter over each event.
	*/
	eligibleEventCount(session, id) {
		if (session === void 0 || this.disabled) return 0;
		const cursor = this.publishedStable(id)?.sourceCursor ?? -1;
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
	async putOpenAudit(id, data) {
		const session = this.ctx.sessions.get(id);
		const audit = this.auditTable;
		if (session === void 0 || audit === void 0 || !this.admissionOpen || this.disabled) return;
		await audit.put(String(data.requestId), openAuditRow(data.requestId, lifecycleOf(session), data));
	}
	/** Put one finished-phase audit update on the request id's existing open row. */
	async putFinishedAudit(id, finished) {
		const audit = this.auditTable;
		if (audit === void 0 || !this.admissionOpen || this.disabled) return;
		const key = String(finished.requestId ?? "");
		if (key.length === 0) return;
		const existing = audit.get(key);
		if (existing === void 0) {
			this.ctx.logger.warn(`task-state-basic: ${id} finished audit for unknown open row "${key}" dropped`);
			return;
		}
		const session = this.ctx.sessions.get(id);
		if (session === void 0) return;
		const stable = finished.outcome === "success" || finished.outcome === "repair" ? this.publishedStable(id) : void 0;
		if (stable !== void 0) {
			await this.finishOpenAudit(existing.requestId, lifecycleOf(session), stable, finished);
			return;
		}
		await audit.update(key, (current) => current.finished === void 0 ? finishAuditRow(current, finished) : current);
	}
	/** The authoritative commit: replace one Session's stable record. */
	async putStable(id, stable) {
		const session = this.ctx.sessions.get(id);
		if (session === void 0) throw new Error(`task-state-basic: session "${id}" is not live`);
		const table = this.sessionsTable;
		if (table === void 0) throw new Error("task-state-basic: domain is not initialized");
		const existing = table.get(id);
		if (existing !== void 0 && (existing.session.createdAt !== session.header.createdAt || existing.session.cwd !== session.header.cwd)) throw new Error(`task-state-basic: session "${id}" record belongs to another lifecycle and cannot be overwritten`);
		await table.put(id, {
			session: {
				createdAt: session.header.createdAt,
				...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
			},
			stable
		});
	}
	/** Publish the committed pointer only after the authority put resolved. */
	publishCommitted(id, stable) {
		const runtime = this.runtimes.get(id);
		if (runtime === void 0) return;
		runtime.stable = stable;
		for (const listener of this.committedListeners) try {
			listener(id, stable);
		} catch (error) {
			this.ctx.logger.warn(`task-state-basic: committed observer for "${id}" failed: ${String(error)}`);
		}
	}
	/**
	* Observe every committed stable after its authority put resolved. The
	* listener receives the Session identity and the committed stable; startup
	* reconciliation and live audit repairs never publish, so an observer sees
	* exactly the values that advanced the published pointer.
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
		return runtime.worker.enqueueMutation(async () => {
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
			const stable = commitStable(content, current.schemaVersion, current.revision + 1, current.filterVersion, current.sourceCursor);
			const requestId = TaskStateRequestId(`ts-manual-${randomUUID()}`);
			const identity = lifecycleOf(session);
			const open = {
				requestId,
				revision: stable.revision,
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
				truncation: []
			};
			await this.putOpenAudit(request.sessionId, open);
			await this.putStable(request.sessionId, stable);
			this.publishCommitted(request.sessionId, stable);
			try {
				await this.finishOpenAudit(requestId, identity, stable, {
					outcome: "manual",
					requestId,
					revision: stable.revision,
					sourceCursor: stable.sourceCursor
				});
			} catch (error) {
				this.ctx.logger.error(`task-state-basic: ${request.sessionId} manual-edit audit finish failed: ${String(error)}`);
				await this.scheduleAuditRepair(request.sessionId, stable, String(requestId));
			}
			return {
				ok: true,
				stable
			};
		});
	}
	/** Validate, bound-check, and identity-map user-authored stable fields. */
	resolveManualContent(current, value) {
		const text = (field, input, empty) => {
			const resolved = input.trim();
			if (!empty && resolved.length === 0) throw new Error(`${field} contains an empty item.`);
			if (Buffer.byteLength(resolved, "utf8") > this.config.maxEntryBytes) throw new Error(`${field} exceeds ${this.config.maxEntryBytes} UTF-8 bytes.`);
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
			todoReferences: current.todoReferences
		};
	}
	/** The published committed pointer, or `undefined`. */
	publishedStable(id) {
		return this.runtimes.get(id)?.stable;
	}
	/** Read the synchronous committed stable of one Session. */
	getStable(sessionId) {
		if (this.disabled) return void 0;
		return this.publishedStable(sessionId);
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
