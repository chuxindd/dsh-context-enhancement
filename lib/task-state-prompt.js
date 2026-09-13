import { i as TASK_STATE_STALE_MARKER, n as TASK_STATE_SLOT_ID, o as isTaskStateSlotSource, r as TASK_STATE_SLOT_SOURCE_KIND, t as DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS } from "./contract-C2nAZOQi.js";
import { a as createUserMessage, m as Schema } from "./lib-UkEFLxaM.js";
import { i as isEligibleType } from "./filter-CczOGkqh.js";
//#region lib/types/internal/task-state/prompt/render.js
/**
* Deterministic UTF-8-byte-bounded and token-bounded rendering of one committed
* task-state stable for the main model. The renderer is a pure function of the
* stable plus the deployment's byte and token budgets: it never reads storage,
* consults a Session, appends an event, or awaits, and it never mutates or
* re-authorizes the stable.
*
* The authoritative Goal and TODO views render first and verbatim from the
* committed views, so the model always sees the state the Session is committed
* to; a cleared view renders as an explicit clear rather than as an absent
* section. Truncation drops whole lines from the tail (evidence first, then
* facts/decisions/risks, then continuation) and appends a fixed marker, so no
* UTF-8 codepoint is ever split and the returned text always fits both budgets.
* If even the authoritative minimum representation cannot fit within budget I
* or maxBytes, it fails closed (typed block) and injects nothing misleading.
* @module dsh-context-enhancement/internal/task-state/prompt/render
*/
const encoder = new TextEncoder();
/** Fixed model-visible marker appended when a bounded render dropped any line. */
const TASK_STATE_TRUNCATION_MARKER = "[Task-state snapshot truncated; the committed durable state remains authoritative.]";
/** Resolve the single injection budget from deployment config with conservative defaults. */
function resolveInjectionBudget(config) {
	return {
		maxBytes: Math.max(1, Math.floor(config.maxBytes)),
		maxTokens: Math.max(1, Math.floor(config.maxTokens ?? 512))
	};
}
/**
* Estimate tokens for a slot message text using the real tokenMeter when available,
* with an audited conservative fallback (CJK and structural overhead aware).
*/
function estimateSlotTokens(text, meter) {
	const message = createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: { kind: "user" }
	});
	if (meter !== void 0 && typeof meter.estimateMessage === "function") return meter.estimateMessage(message);
	let cjkCount = 0;
	let otherCount = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 19968 && code <= 40959 || code >= 13312 && code <= 19903 || code >= 131072 && code <= 173791 || code >= 63744 && code <= 64255) cjkCount += 1;
		else otherCount += 1;
	}
	return 8 + Math.max(Math.ceil(text.length / 4), cjkCount + Math.ceil(otherCount / 4));
}
/** Ordered list sections of one stable, each with its header line. */
const KINDED = [
	["Facts:", "facts"],
	["Decisions:", "decisions"],
	["Constraints:", "constraints"],
	["Risks:", "risks"]
];
/** Whether any list section of the stable carries content. */
function hasListContent(stable) {
	return stable.facts.length > 0 || stable.decisions.length > 0 || stable.constraints.length > 0 || stable.risks.length > 0 || stable.evidence.length > 0;
}
/** Whether the stable carries an authoritative Goal or TODO view to render. */
function hasAuthorityContent(stable) {
	return stable.goalView.status !== "none" || stable.todoView.status !== "none";
}
/**
* The authoritative Goal lines of one stable. A `current` view renders its
* objective plus the identity it belongs to; a `cleared` view renders the
* explicit fact that no authoritative goal exists — which is exactly what stops
* a superseded objective from being re-injected as if it were still in force.
*/
function goalLines(stable) {
	const view = stable.goalView;
	if (view.status === "none") return [];
	if (view.status === "cleared") return ["Current goal: cleared (no authoritative goal is set)."];
	const lines = [`Current goal: ${view.objective ?? "(no objective recorded)"}`];
	const identity = [];
	if (view.goalId !== void 0) identity.push(`goal ${view.goalId}`);
	if (view.goalRevision !== void 0) identity.push(`revision ${view.goalRevision}`);
	if (view.phase !== void 0) identity.push(`phase ${view.phase}`);
	if (identity.length > 0) lines.push(`Goal identity: ${identity.join(", ")}`);
	return lines;
}
/**
* The authoritative TODO lines of one stable, rendered from the view and never
* from a stale reference: a `cleared` view states the list is gone, so no item
* of a superseded list can keep rendering as live work.
*/
function todoLines(stable) {
	const view = stable.todoView;
	if (view.status === "none") return [];
	if (view.status === "cleared") return ["TODO list: cleared (the authoritative list is empty)."];
	const lines = [view.sourceSeq === void 0 ? "TODO list:" : `TODO list (session event ${view.sourceSeq}):`];
	for (const item of view.items) lines.push(`- [${item.status}] ${item.content}`);
	return lines;
}
/**
* Build the complete ordered lines of one stable, along with the count of lines
* belonging to the authoritative minimum representation (Header + Goal + TODO).
*/
function buildLines(stable, isStale) {
	const lines = [`Durable task state (revision ${stable.revision}, source event ${stable.sourceCursor}, digest ${stable.digest}).`];
	if (isStale) lines.push(TASK_STATE_STALE_MARKER);
	lines.push(...goalLines(stable));
	lines.push(...todoLines(stable));
	const authoritativeLineCount = lines.length;
	const continuation = stable.continuation;
	const hasContinuation = continuation.currentObjective !== "" || continuation.currentFocus !== "" || continuation.openWork.length > 0 || continuation.nextActions.length > 0;
	if (stable.goalView.status === "none" && continuation.currentObjective !== "") lines.push(`Current objective: ${continuation.currentObjective}`);
	if (continuation.currentFocus !== "") lines.push(`Current focus: ${continuation.currentFocus}`);
	if (continuation.openWork.length > 0) {
		lines.push("Open work:");
		for (const item of continuation.openWork) lines.push(`- ${item}`);
	}
	if (continuation.nextActions.length > 0) {
		lines.push("Next actions:");
		for (const item of continuation.nextActions) lines.push(`- ${item}`);
	}
	if (!hasContinuation && !hasListContent(stable) && !hasAuthorityContent(stable)) return {
		lines,
		authoritativeLineCount
	};
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
	}
	return {
		lines,
		authoritativeLineCount
	};
}
/**
* Render one committed stable as a bounded slot snapshot.
*
* Checks both byte budget (maxBytes) and token budget I (maxTokens).
* Enforces authoritative minimum representation priority: Goal and TODO views
* render first and verbatim. If even the authoritative minimum cannot fit within
* both budgets, fails closed (blocked). Truncation drops low-priority sections
* (evidence first, then facts/decisions/risks, then continuation) and appends
* the fixed truncation marker.
*/
function renderTaskStateSlot(stable, options) {
	const maxBytes = Math.max(1, Math.floor(options.maxBytes));
	const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? 512));
	const eligibleHighWater = options.eligibleHighWater ?? stable.sourceCursor;
	const isStale = eligibleHighWater > stable.sourceCursor;
	const staleness = isStale ? "stale" : "fresh";
	const { lines, authoritativeLineCount } = buildLines(stable, isStale);
	const full = lines.join("\n");
	const fullBytes = encoder.encode(full).byteLength;
	const fullTokens = estimateSlotTokens(full, options.meter);
	if (fullBytes <= maxBytes && fullTokens <= maxTokens) return {
		text: full,
		staleness,
		truncation: false,
		injectionTokens: fullTokens,
		budgetTokens: maxTokens,
		eligibleHighWater,
		blocked: false
	};
	const authText = lines.slice(0, authoritativeLineCount).join("\n");
	const authBytes = encoder.encode(authText).byteLength;
	const authTokens = estimateSlotTokens(authText, options.meter);
	if (authBytes > maxBytes || authTokens > maxTokens) return {
		text: "",
		staleness: "blocked",
		truncation: false,
		injectionTokens: 0,
		budgetTokens: maxTokens,
		eligibleHighWater,
		blocked: true
	};
	if (lines.length === authoritativeLineCount) return {
		text: authText,
		staleness,
		truncation: false,
		injectionTokens: authTokens,
		budgetTokens: maxTokens,
		eligibleHighWater,
		blocked: false
	};
	const minTruncatedCandidate = `${authText}\n${TASK_STATE_TRUNCATION_MARKER}`;
	if (encoder.encode(minTruncatedCandidate).byteLength > maxBytes || estimateSlotTokens(minTruncatedCandidate, options.meter) > maxTokens) return {
		text: "",
		staleness: "blocked",
		truncation: false,
		injectionTokens: 0,
		budgetTokens: maxTokens,
		eligibleHighWater,
		blocked: true
	};
	let acceptedPrefix = authText;
	for (let i = authoritativeLineCount; i < lines.length; i += 1) {
		const candidate = `${acceptedPrefix}\n${lines[i]}`;
		const withMarker = `${candidate}\n${TASK_STATE_TRUNCATION_MARKER}`;
		if (encoder.encode(withMarker).byteLength <= maxBytes && estimateSlotTokens(withMarker, options.meter) <= maxTokens) acceptedPrefix = candidate;
		else break;
	}
	const finalText = `${acceptedPrefix}\n${TASK_STATE_TRUNCATION_MARKER}`;
	return {
		text: finalText,
		staleness,
		truncation: true,
		injectionTokens: estimateSlotTokens(finalText, options.meter),
		budgetTokens: maxTokens,
		eligibleHighWater,
		blocked: false
	};
}
/**
* Bounded rendering of one committed stable deterministically within a UTF-8 byte budget.
* Retained for backward compatibility with existing tests and callers.
*/
function renderTaskStateSnapshot(stable, maxBytes) {
	return renderTaskStateSlot(stable, {
		maxBytes,
		maxTokens: 512
	}).text;
}
//#endregion
//#region lib/types/internal/task-state/prompt/index.js
/**
* Prompt consumer for durable task state (`dsh-context-enhancement/task-state-prompt`).
*
* MODEL-VISIBLE DELIVERY IS A PLUGIN-OWNED FIXED SLOT
* ---------------------------------------------------
* One Session lifecycle carries AT MOST ONE model-visible Stable task-state
* slot: a `user/message` surface node whose `source.kind` is
* `task-state-slot`. The first committed stable CREATES the slot with a plain
* surface append; every later committed revision REPLACES that exact node with
* `surfaceOp: { op: 'replace', start, end }` plus `sourceEventSeqs: [start]`,
* so the previous revision stops being model-visible instead of accumulating.
*
* Why the delivery is not the dynamic runtime context anymore
* ----------------------------------------------------------
* The `{{task_state_snapshot}}` runtime-context contribution is still
* registered (the template and the variable name stay reserved, and an
* unregistered variable would make assembly throw), but its value is the empty
* string. DSH's agent loop is the only writer of that projection and it appends
* (`packages/core/agent-loop/src/agent.ts`: `surfaceOp: 'append'`), with no
* plugin-visible boundary between its append and the request derived from the
* surface; shadowing its node does not converge either, because
* `RuntimeContextProjection` re-emits an unchanged snapshot once its retained
* node is replaced. Any non-empty value here therefore re-enters the
* append-only projection that E08 measured (one visible snapshot per revision).
* The legal replacement channel is the plugin's own append, which is what this
* module uses.
*
* WHERE THE SLOT IS MAINTAINED, AND WHY IT IS SAFE HERE
* -----------------------------------------------------
* Maintenance runs on the `agent/pre-step` waterfall — the step boundary the
* host dispatches before `step/start`, before the claimed messages are
* appended, and before the request is derived. That is outside every
* `Session.append()` publication, so the append is legal: an observer of
* `session/event` may NOT append (the store rejects a reentrant append while
* another append is being published). Nothing is appended during prompt
* assembly, so an assembly-only consumer performs no session side effect, and a
* step the loop rejects (or an aborted turn) is left untouched, because no
* request would ever read the node.
*
* INDEPENDENT INJECTION BUDGET I & STALENESS
* ------------------------------------------
* - Injection tokens are bounded by independent token budget I (maxTokens).
* - maxBytes and maxTokens act as independent dual bounds; neither fakes the other.
* - Authoritative Goal and TODO views render first and verbatim. If even the
*   authoritative representation cannot fit within budget I or maxBytes, slot
*   maintenance fails closed (typed blocked) and injects nothing misleading.
* - When durable cursor lags eligible session events, text carries an explicit
*   stale marker and source metadata records staleness: 'stale'. Once a catch-up
*   revision is committed, staleness returns to 'fresh'.
*
* FAIL-CLOSED RULES
* -----------------
* - a replacement that throws is caught locally, counted, and appends nothing:
*   the surface keeps exactly the node it had, so the model never sees two
*   snapshots at once;
* - a slot node shadowed by another surface operation (compaction) is rebuilt
*   with a fresh generation instead of a stale replacement;
* - two or more visible slot nodes collapse into ONE node through a single
*   range replacement, and only when the shadowed run is contiguous; a
*   non-contiguous run would force a range replacement over real content, so it
*   fails closed and appends nothing;
* - in-memory bookkeeping is fenced to the exact Session object AND lifecycle,
*   so a resumed same-id Session re-resolves the slot from ITS OWN log, and a
*   forked child never reuses its parent's record.
* @module dsh-context-enhancement/internal/task-state/prompt/index
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "task-state-prompt";
/**
* Register the runtime-context contribution while `systemPrompt` is available.
* No service key is injected for `taskState` or `sessions`: a composition
* without a task-state provider, or without a session store, must still mount
* cleanly (injecting nothing) rather than wait on a service.
*/
const inject = ["systemPrompt"];
/** Schemastery validation for {@link TaskStatePromptConfig}. */
const Config = Schema.object({
	maxBytes: Schema.number().step(1).min(1).required(),
	maxTokens: Schema.number().step(1).min(1).default(512)
});
/**
* The reserved runtime-context template. It stays registered (with its variable
* name, which assembly requires to exist) while rendering nothing: the
* model-visible stable rides the fixed slot, never the append-only
* runtime-context projection. See the module header.
*/
const SNAPSHOT_CONTEXT = "{{task_state_snapshot}}";
/** The reserved variable's value: the slot carries the text, not this context. */
const RESERVED_EMPTY = "";
/**
* Per-root slot registries: one entry per mounted consumer, keyed by the root
* context every child context shares. The registry is never module-global state
* shared across mounts, so two mounted consumers cannot see each other's
* bookkeeping, disposing one leaves the other intact, and a disposed consumer
* leaves none behind.
*/
const slotRegistries = /* @__PURE__ */ new WeakMap();
/**
* Read the in-memory slot bookkeeping of every prompt consumer mounted in one
* context's root.
* @param ctx - Any context of the application (a plugin context works).
* @returns One entry per Session a mounted consumer currently holds a slot for;
*   empty for an unmounted or disposed consumer.
*/
function taskStateSlotDiagnostics(ctx) {
	const registries = slotRegistries.get(ctx.root);
	if (registries === void 0) return [];
	return [...registries].flatMap((registry) => [...registry.values()].map((record) => ({
		sessionId: String(record.session.id),
		lifecycleCreatedAt: record.lifecycleCreatedAt,
		slotSeq: Number(record.slotSeq),
		generation: record.generation,
		revision: record.revision,
		digest: record.digest,
		textBytes: record.text.length,
		failures: record.failures,
		rebuilds: record.rebuilds,
		collisions: record.collisions,
		eligibleHighWater: record.eligibleHighWater,
		staleness: record.staleness,
		injectionTokens: record.injectionTokens,
		budgetTokens: record.budgetTokens,
		truncation: record.truncation
	})));
}
/** Best-effort diagnostic logging that never throws into the step. */
function warn(ctx, message) {
	try {
		ctx.logger.warn(message);
	} catch {}
}
/** The model-visible text of one `user/message` slot node, or `undefined`. */
function slotTextOf(data) {
	const content = data?.content;
	if (!Array.isArray(content) || content.length !== 1) return void 0;
	const block = content[0];
	return block?.type === "text" && typeof block.text === "string" ? block.text : void 0;
}
/** Resolve one surface seq to a slot node of this Session, or `undefined`. */
function slotNodeAt(session, seq) {
	const event = session.eventAt(seq);
	if (event?.type !== "user/message" || !isTaskStateSlotSource(event.data.source)) return void 0;
	const text = slotTextOf(event.data);
	if (text === void 0) return void 0;
	return {
		seq: event.seq,
		generation: event.data.source.generation,
		revision: event.data.source.revision,
		digest: event.data.source.digest,
		text,
		source: event.data.source
	};
}
/** Every slot node currently ON the surface, in surface order. */
function visibleSlotNodes(session) {
	const nodes = [];
	for (const seq of session.surface.nodes) {
		const node = slotNodeAt(session, seq);
		if (node !== void 0) nodes.push(node);
	}
	return nodes;
}
/**
* Scan the session's log for the highest sequence number of an eligible event.
* Excludes slot nodes themselves to prevent slot self-feedback.
*/
function sessionEligibleHighWater(session) {
	let highest = 0;
	for (const event of session.snapshotEvents()) {
		if (!isEligibleType(event.type)) continue;
		if (event.type === "user/message" && isTaskStateSlotSource(event.data?.source)) continue;
		const seq = Number(event.seq);
		if (seq > highest) highest = seq;
	}
	return highest;
}
/**
* Whether one logged slot node belongs to THIS Session lifecycle.
*
* A slot node is durable evidence of one lifecycle's own delivery, so it names
* the Session id and lifecycle epoch that wrote it. Both must match the live
* Session: a node inherited through a fork prefix names the PARENT's id and the
* PARENT's epoch, and adopting it would make the child's in-memory bookkeeping
* claim a node its own lifecycle never wrote — the child would then never
* publish its own snapshot, and a later collapse would report the parent's node
* as the child's own revision.
*
* Matching is by the durable `(sessionId, lifecycleCreatedAt)` pair alone, never
* by content: an identical revision/digest/text is not ownership, because a
* child that inherited the parent's prefix can legitimately hold a node whose
* content its own stable also renders.
* @param session - the live Session whose ownership is being decided.
* @param source - the logged slot source of one candidate node.
* @returns true when this exact lifecycle wrote the node.
*/
function isOwnSlotNode(session, source) {
	return source.sessionId === String(session.id) && source.lifecycleCreatedAt === session.header.createdAt;
}
/**
* The next slot generation: one past the highest generation anywhere in this
* Session's own log. Generation therefore increases strictly along the log,
* including across an inherited fork prefix or a resumed log, and never restarts
* from process memory.
*/
function nextGeneration(session, floor) {
	let highest = floor;
	for (const event of session.snapshotEvents()) {
		if (event.type !== "user/message" || !isTaskStateSlotSource(event.data.source)) continue;
		if (event.data.source.generation > highest) highest = event.data.source.generation;
	}
	return highest + 1;
}
/** Whether the surface run of slot nodes is contiguous (no content between them). */
function contiguous(session, nodes) {
	const surface = session.surface.nodes;
	const first = surface.indexOf(nodes[0].seq);
	if (first < 0) return false;
	return nodes.every((node, offset) => surface[first + offset] === node.seq);
}
/** The durable source of one slot node. */
function slotSource(session, stable, renderResult, generation, coveredSeqs, previous) {
	return {
		kind: TASK_STATE_SLOT_SOURCE_KIND,
		slotId: TASK_STATE_SLOT_ID,
		sessionId: String(session.id),
		lifecycleCreatedAt: session.header.createdAt,
		generation,
		revision: stable.revision,
		...previous === void 0 ? {} : {
			previousRevision: previous.revision,
			previousGeneration: previous.generation
		},
		digest: stable.digest,
		sourceCursor: stable.sourceCursor,
		coveredSeqs: coveredSeqs.map(Number),
		eligibleHighWater: renderResult.eligibleHighWater,
		staleness: renderResult.staleness,
		injectionTokens: renderResult.injectionTokens,
		budgetTokens: renderResult.budgetTokens,
		truncation: renderResult.truncation
	};
}
/** Commit one slot node: a plain append, or a single-node/range replacement. */
function commitSlotNode(session, stable, renderResult, generation, coveredSeqs, previous) {
	const message = createUserMessage({
		content: [{
			type: "text",
			text: renderResult.text
		}],
		source: slotSource(session, stable, renderResult, generation, coveredSeqs, previous)
	});
	if (coveredSeqs.length === 0) return session.append("user/message", message, { surfaceOp: "append" }).seq;
	return session.append("user/message", message, {
		surfaceOp: {
			op: "replace",
			start: coveredSeqs[0],
			end: coveredSeqs[coveredSeqs.length - 1]
		},
		sourceEventSeqs: [...coveredSeqs]
	}).seq;
}
/**
* Resolve, create, replace, or safely rebuild the ONE model-visible Stable slot
* of one live Session. Never leaves two visible snapshots behind: every failure
* path appends nothing, so the surface keeps the node it already had.
*/
function maintainSlot(ctx, slots, session, budget) {
	const provider = ctx.get("taskState");
	if (provider === void 0) return;
	const store = ctx.get("sessions");
	if (store !== void 0 && store.get(session.id) !== session) return;
	const stable = provider.getStable(session.id);
	if (stable === void 0) return;
	const eligibleHighWater = sessionEligibleHighWater(session);
	const render = renderTaskStateSlot(stable, {
		maxBytes: budget.maxBytes,
		maxTokens: budget.maxTokens,
		eligibleHighWater,
		meter: ctx.get("tokenMeter") ?? void 0
	});
	const key = String(session.id);
	let record = slots.get(key);
	if (record !== void 0 && (record.session !== session || record.lifecycleCreatedAt !== session.header.createdAt)) {
		slots.delete(key);
		record = void 0;
	}
	if (render.blocked) {
		if (record !== void 0) {
			record.staleness = "blocked";
			record.budgetTokens = render.budgetTokens;
			record.eligibleHighWater = render.eligibleHighWater;
		}
		warn(ctx, `task-state-prompt: authoritative state exceeds injection budget I (${render.budgetTokens}) in Session "${key}"; typed blocked`);
		return;
	}
	if (render.text === "") return;
	const visible = visibleSlotNodes(session);
	if (visible.length > 1) {
		if (!contiguous(session, visible)) {
			if (record !== void 0) {
				record.collisions += 1;
				slots.set(key, record);
			}
			warn(ctx, `task-state-prompt: ${visible.length} non-contiguous Stable slots in Session "${key}"; refusing to collapse them`);
			return;
		}
		const covered = visible.map((node) => node.seq);
		const generation = nextGeneration(session, Math.max(...visible.map((node) => node.generation)));
		const seq = commitSlotNode(session, stable, render, generation, covered, {
			revision: visible[visible.length - 1].revision,
			generation: visible[visible.length - 1].generation
		});
		slots.set(key, {
			session,
			lifecycleCreatedAt: session.header.createdAt,
			slotSeq: seq,
			generation,
			revision: stable.revision,
			digest: stable.digest,
			text: render.text,
			failures: record?.failures ?? 0,
			rebuilds: (record?.rebuilds ?? 0) + 1,
			collisions: record?.collisions ?? 0,
			eligibleHighWater: render.eligibleHighWater,
			staleness: render.staleness,
			injectionTokens: render.injectionTokens,
			budgetTokens: render.budgetTokens,
			truncation: render.truncation
		});
		return;
	}
	const current = visible[0];
	if (current === void 0) {
		const generation = nextGeneration(session, record?.generation ?? 0);
		try {
			const seq = commitSlotNode(session, stable, render, generation, [], void 0);
			slots.set(key, {
				session,
				lifecycleCreatedAt: session.header.createdAt,
				slotSeq: seq,
				generation,
				revision: stable.revision,
				digest: stable.digest,
				text: render.text,
				failures: record?.failures ?? 0,
				rebuilds: record === void 0 ? 0 : record.rebuilds + 1,
				collisions: record?.collisions ?? 0,
				eligibleHighWater: render.eligibleHighWater,
				staleness: render.staleness,
				injectionTokens: render.injectionTokens,
				budgetTokens: render.budgetTokens,
				truncation: render.truncation
			});
		} catch (error) {
			const failures = (record?.failures ?? 0) + 1;
			if (record !== void 0) {
				record.failures = failures;
				slots.set(key, record);
			}
			warn(ctx, `task-state-prompt: creating the Stable slot of Session "${key}" failed: ${String(error)}`);
		}
		return;
	}
	if (isOwnSlotNode(session, current.source) && current.revision === stable.revision && current.digest === stable.digest && current.text === render.text && current.source.staleness === render.staleness) {
		if (record === void 0 || record.slotSeq !== current.seq || record.revision !== stable.revision || record.text !== render.text) slots.set(key, {
			session,
			lifecycleCreatedAt: session.header.createdAt,
			slotSeq: current.seq,
			generation: current.generation,
			revision: current.revision,
			digest: current.digest,
			text: current.text,
			failures: record?.failures ?? 0,
			rebuilds: record?.rebuilds ?? 0,
			collisions: record?.collisions ?? 0,
			eligibleHighWater: current.source.eligibleHighWater ?? render.eligibleHighWater,
			staleness: current.source.staleness ?? render.staleness,
			injectionTokens: current.source.injectionTokens ?? render.injectionTokens,
			budgetTokens: current.source.budgetTokens ?? render.budgetTokens,
			truncation: current.source.truncation ?? render.truncation
		});
		return;
	}
	const generation = nextGeneration(session, Math.max(current.generation, record?.generation ?? 0));
	try {
		const seq = commitSlotNode(session, stable, render, generation, [current.seq], {
			revision: current.revision,
			generation: current.generation
		});
		slots.set(key, {
			session,
			lifecycleCreatedAt: session.header.createdAt,
			slotSeq: seq,
			generation,
			revision: stable.revision,
			digest: stable.digest,
			text: render.text,
			failures: record?.failures ?? 0,
			rebuilds: record?.rebuilds ?? 0,
			collisions: record?.collisions ?? 0,
			eligibleHighWater: render.eligibleHighWater,
			staleness: render.staleness,
			injectionTokens: render.injectionTokens,
			budgetTokens: render.budgetTokens,
			truncation: render.truncation
		});
	} catch (error) {
		if (record !== void 0) {
			record.failures += 1;
			slots.set(key, record);
		}
		warn(ctx, `task-state-prompt: replacing the Stable slot of Session "${key}" failed: ${String(error)}`);
	}
}
/**
* Register the reserved `{{task_state_snapshot}}` context and variable, and the
* step-boundary slot maintenance that owns the single model-visible Stable slot.
* @param ctx - plugin context; the registrations dispose with it.
* @param config - the deployment byte and token budgets for one rendered snapshot.
*/
function apply(ctx, config) {
	const budget = resolveInjectionBudget(config);
	const slots = /* @__PURE__ */ new Map();
	const root = ctx.root;
	const registries = slotRegistries.get(root) ?? /* @__PURE__ */ new Set();
	registries.add(slots);
	slotRegistries.set(root, registries);
	ctx.effect(() => () => {
		slots.clear();
		registries.delete(slots);
		if (registries.size === 0) slotRegistries.delete(root);
	});
	ctx.systemPrompt.context({
		name: "task-state:snapshot",
		order: 125,
		text: SNAPSHOT_CONTEXT
	});
	ctx.systemPrompt.variable("task_state_snapshot", () => RESERVED_EMPTY);
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind !== "enter" || signal.aborted) return decision;
		try {
			maintainSlot(ctx, slots, agent.session, budget);
		} catch (error) {
			warn(ctx, `task-state-prompt: Stable slot maintenance in Session "${String(agent.session.id)}" failed: ${String(error)}`);
		}
		return decision;
	});
}
//#endregion
export { Config, DEFAULT_TASK_STATE_INJECTION_BUDGET_TOKENS, TASK_STATE_SLOT_ID, TASK_STATE_SLOT_SOURCE_KIND, TASK_STATE_STALE_MARKER, TASK_STATE_TRUNCATION_MARKER, apply, estimateSlotTokens, inject, isOwnSlotNode, isTaskStateSlotSource, name, renderTaskStateSlot, renderTaskStateSnapshot, resolveInjectionBudget, taskStateSlotDiagnostics };
