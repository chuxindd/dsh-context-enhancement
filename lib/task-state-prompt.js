import { t as Schema } from "./lib-Bj3jGSND.js";
//#region lib/types/internal/task-state/prompt/render.js
/**
* Deterministic UTF-8-byte-bounded rendering of one committed task-state stable
* for the main model. The renderer is a pure function of the stable plus the
* deployment's byte budget: it never reads storage, consults a Session, appends
* an event, or awaits, and it never mutates or re-authorizes the stable.
* Truncation drops whole lines from the tail and appends a fixed marker, so no
* UTF-8 codepoint is ever split and the returned text always fits the budget.
* @module dsh-context-enhancement/internal/task-state/prompt/render
*/
const encoder = new TextEncoder();
/** Fixed model-visible marker appended when a bounded render dropped any line. */
const TASK_STATE_TRUNCATION_MARKER = "[Task-state snapshot truncated; the committed durable state remains authoritative.]";
/** Ordered list sections of one stable, each with its header line. */
const KINDED = [
	["Facts:", "facts"],
	["Decisions:", "decisions"],
	["Constraints:", "constraints"],
	["Risks:", "risks"]
];
/** Whether any list section of the stable carries content. */
function hasListContent(stable) {
	return stable.facts.length > 0 || stable.decisions.length > 0 || stable.constraints.length > 0 || stable.risks.length > 0 || stable.evidence.length > 0 || stable.todoReferences.length > 0;
}
/**
* The deterministic ordered lines of one stable's rendering, before bounding.
*
* The header (revision, source cursor, digest) always renders. Continuation
* state comes next so the actionable current objective, focus, open work, and
* next actions survive a head-retained truncation; the long-lived kinded lists,
* evidence, and TODO references follow.
*/
function linesOf(stable) {
	const lines = [`Durable task state (revision ${stable.revision}, source event ${stable.sourceCursor}, digest ${stable.digest}).`];
	const continuation = stable.continuation;
	const hasContinuation = continuation.currentObjective !== "" || continuation.currentFocus !== "" || continuation.openWork.length > 0 || continuation.nextActions.length > 0;
	if (continuation.currentObjective !== "") lines.push(`Current objective: ${continuation.currentObjective}`);
	if (continuation.currentFocus !== "") lines.push(`Current focus: ${continuation.currentFocus}`);
	if (continuation.openWork.length > 0) {
		lines.push("Open work:");
		for (const item of continuation.openWork) lines.push(`- ${item}`);
	}
	if (continuation.nextActions.length > 0) {
		lines.push("Next actions:");
		for (const item of continuation.nextActions) lines.push(`- ${item}`);
	}
	if (!hasContinuation && !hasListContent(stable)) return lines;
	if (hasListContent(stable)) {
		lines.push("");
		for (const [header, key] of KINDED) {
			const entries = stable[key];
			if (entries.length === 0) continue;
			lines.push(header);
			for (const entry of entries) lines.push(`- ${entry.content}`);
		}
		if (stable.evidence.length > 0) {
			lines.push("Evidence:");
			for (const reference of stable.evidence) lines.push(`- ${reference.note} (session event ${reference.seq})`);
		}
		if (stable.todoReferences.length > 0) {
			lines.push("TODO references:");
			for (const reference of stable.todoReferences) lines.push(`- ${reference.content} (session event ${reference.seq})`);
		}
	}
	return lines;
}
/**
* Render one committed stable deterministically within a UTF-8 byte budget.
*
* When the full render fits, it is returned verbatim. Otherwise whole lines are
* taken from the head while the next line still fits beside the fixed
* truncation marker, and the marker is appended to whatever prefix survived, so
* the result never exceeds `maxBytes`, never splits a codepoint, and never
* pretends to be complete. When even the first line cannot fit beside the
* marker, an empty string is returned.
* @param stable - the committed stable to present; its authority is untouched.
* @param maxBytes - maximum UTF-8 bytes of the returned text; must be a
*   non-negative safe integer.
* @returns the bounded model-facing rendering of the stable.
*/
function renderTaskStateSnapshot(stable, maxBytes) {
	const lines = linesOf(stable);
	const full = lines.join("\n");
	if (encoder.encode(full).byteLength <= maxBytes) return full;
	const markerBytes = encoder.encode(TASK_STATE_TRUNCATION_MARKER).byteLength;
	let text = "";
	for (const line of lines) {
		const candidate = text.length === 0 ? line : `${text}\n${line}`;
		if (encoder.encode(candidate).byteLength > maxBytes - markerBytes - 1) break;
		text = candidate;
	}
	if (text.length === 0) return "";
	return `${text}\n${TASK_STATE_TRUNCATION_MARKER}`;
}
//#endregion
//#region lib/types/task-state-prompt.js
/**
* dsh-context-enhancement — `./task-state-prompt` subpath.
*
* The prompt consumer for durable task state: it renders one Session's
* committed task-state stable into the dynamic runtime context through the
* existing `ctx.systemPrompt` registry (context template
* `{{task_state_snapshot}}` plus a variable provider of the same name).
*
* This module exports named `name`/`inject`/`Config`/`apply` and deliberately
* has NO default export: the Loader mounts it as a function plugin by those
* named members, and an accidental default would shadow the shape.
*
* @module dsh-context-enhancement/task-state-prompt
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "task-state-prompt";
/**
* Register the runtime-context contribution while `systemPrompt` is available.
* No service key is injected for `taskState`: a composition without a
* task-state provider must still mount cleanly (rendering nothing).
*/
const inject = ["systemPrompt"];
/** Schemastery validation for {@link TaskStatePromptConfig}. */
const Config = Schema.object({ maxBytes: Schema.number().step(1).min(1).required() });
/**
* The fixed runtime-context template. Interpolation resolves
* `task_state_snapshot` once; the provider value is not scanned again, so a
* literal `{{...}}` inside stable-derived content survives unchanged.
*/
const SNAPSHOT_CONTEXT = "{{task_state_snapshot}}";
/**
* Register the `{{task_state_snapshot}}` context and variable provider for the
* lifetime of `ctx`.
* @param ctx - plugin context; the registrations dispose with it.
* @param config - the deployment byte budget for one rendered snapshot.
*/
function apply(ctx, config) {
	const maxBytes = config.maxBytes;
	ctx.systemPrompt.context({
		name: "task-state:snapshot",
		order: 125,
		text: SNAPSHOT_CONTEXT
	});
	ctx.systemPrompt.variable("task_state_snapshot", (context) => {
		const sessionId = context.agent?.session.id;
		if (sessionId === void 0) return "";
		const stable = ctx.get("taskState")?.getStable(sessionId);
		if (stable === void 0) return "";
		return renderTaskStateSnapshot(stable, maxBytes);
	});
}
//#endregion
export { Config, TASK_STATE_TRUNCATION_MARKER, apply, inject, name, renderTaskStateSnapshot };
