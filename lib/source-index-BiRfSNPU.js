import { o as isTaskStateSlotSource } from "./contract-C2nAZOQi.js";
import { u as deepFreeze } from "./lib-UkEFLxaM.js";
import { createHash } from "node:crypto";
//#region lib/types/internal/compaction/tool-pairing.js
/**
* Tool-pairing balance over a session surface, re-implemented for
* `dsh-context-enhancement` from the MIT-licensed official rc1 source.
*
* SOURCE: this file is a local copy of the official rc.1 release file
* `packages/compaction/compaction/src/tool-pairing.ts` from the
* `deepseek-harness` repository (tag 0.1.2-rc.1, LICENSE MIT), with the Card5/6
* migration delta (structural `SessionRead` over the root `Session` import)
* folded in. It exists because official `@deepseek-ai` packages' `src/*`
* subpaths are not a stable third-party API. Only the published rc1 exports
* of the official packages are consumed elsewhere. Provenance is recorded in
* THIRD_PARTY_NOTICES.md.
*
* Compaction changes surface positions, so safe cuts are derived from
* tool-call/result content in current surface order rather than step markers.
* Cordis-free: it imports no cordis value and only session *types* (never the
* root Context merge).
* @module dsh-context-enhancement/internal/compaction/tool-pairing
*/
const balanceCacheBySession = /* @__PURE__ */ new WeakMap();
/** Return how one surface event changes the in-progress tool-call count. */
function eventDelta(event) {
	switch (event.type) {
		case "assistant/message": return event.data.message.content.filter((block) => block.type === "tool-call").length;
		case "tool/result": return -1;
		default: return 0;
	}
}
/** Read and validate the event named by a surface sequence. */
function eventForSeq(session, seq) {
	const event = session.eventAt(seq);
	if (event === void 0 || event.seq !== seq) throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`);
	return event;
}
/** Fold surface sequences not yet in the cache into its balance state. */
function extendCache(session, cache, seqs) {
	const processed = cache.cutBalanced.length - 1;
	const tail = seqs.slice(processed);
	const pendingCuts = [];
	let inProgressToolCalls = cache.inProgressToolCalls;
	for (const seq of tail) {
		inProgressToolCalls += eventDelta(eventForSeq(session, seq));
		if (inProgressToolCalls < 0) throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`);
		pendingCuts.push(inProgressToolCalls === 0);
	}
	tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset));
	cache.cutBalanced = cache.cutBalanced.concat(pendingCuts);
	cache.inProgressToolCalls = inProgressToolCalls;
	return cache;
}
/** Return balance state synchronized with the current session surface. */
function balanceCache(session) {
	const surface = session.surface;
	const seqs = surface.nodes;
	const generation = surface.replaceGeneration;
	const cached = balanceCacheBySession.get(session);
	if (cached === void 0 || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
		const rebuilt = extendCache(session, {
			generation,
			cutBalanced: [true],
			indexBySeq: /* @__PURE__ */ new Map(),
			inProgressToolCalls: 0
		}, seqs);
		balanceCacheBySession.set(session, rebuilt);
		return rebuilt;
	}
	if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs);
	return cached;
}
/** Balance of the cut at a sequence's position plus offset, rejecting seqs outside current membership. */
function cutBalance(cache, seq, offset) {
	const index = cache.indexBySeq.get(seq);
	const balanced = index === void 0 ? void 0 : cache.cutBalanced[index + offset];
	if (balanced === void 0) throw new Error(`tool-pairing balance: surface seq ${seq} not found`);
	return balanced;
}
/**
* Whether the cut immediately before a current surface sequence is tool-pairing balanced.
* @param session - session whose surface is checked.
* @param seq - event sequence whose leading cut is checked.
* @returns true when no unanswered tool call crosses the cut.
* @throws when the seq is absent from the current surface, a surface sequence has no
* matching log event, or a tool result has no preceding open call.
*/
function toolPairingBalancedBefore(session, seq) {
	return cutBalance(balanceCache(session), seq, 0);
}
/**
* Whether the cut immediately after a current surface sequence is tool-pairing balanced.
* @param session - session whose surface is checked.
* @param seq - event sequence whose trailing cut is checked.
* @returns true when no unanswered tool call crosses the cut.
* @throws when the seq is absent from the current surface, a surface sequence has no
* matching log event, or a tool result has no preceding open call.
*/
function toolPairingBalancedAfter(session, seq) {
	return cutBalance(balanceCache(session), seq, 1);
}
//#endregion
//#region lib/types/internal/compaction/pruner-config.js
/**
* Configuration resolution for deterministic tool-result pruning,
* re-implemented for `dsh-context-enhancement` from the MIT-licensed official
* rc1 source with the Card5/6 `hardLimitChars` delta.
*
* SOURCE: local copy of the official rc.1 `dsh-compaction-tool-result-pruner`
* `src/config.ts` (MIT, tag dsh-v0.1.2-rc.1 of the `deepseek-harness`
* repository) plus the Card5/6 working-tree delta (`hardLimitChars`).
* `deepFreeze` comes from the published rc1 `@deepseek-ai/dsh-util-values`
* package. Provenance is recorded in THIRD_PARTY_NOTICES.md.
*
* @module dsh-context-enhancement/internal/compaction/pruner-config
*/
/** Fixed marker substituted for every removed middle span. */
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
/** Low-friction defaults for coding-agent tool output. */
const DEFAULTS$1 = deepFreeze({
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024,
	hardLimitChars: void 0
});
const CONFIG_KEYS = /* @__PURE__ */ new Set([
	"thresholdChars",
	"headChars",
	"tailChars",
	"hardLimitChars"
]);
/**
* Count Unicode code points without splitting surrogate pairs.
* @param text - text to measure.
* @returns the Unicode code-point count.
*/
function codePointLength(text) {
	return Array.from(text).length;
}
/**
* Resolve and validate pruning budgets.
* @param config - raw plugin configuration.
* @returns a detached deeply immutable configuration.
*/
function resolveConfig(config = {}) {
	for (const key of Object.keys(config)) if (!CONFIG_KEYS.has(key)) throw new Error(`ToolResultPruneConfig: unknown key "${key}" (allowed: thresholdChars, headChars, tailChars, hardLimitChars)`);
	const resolved = {
		thresholdChars: config.thresholdChars ?? DEFAULTS$1.thresholdChars,
		headChars: config.headChars ?? DEFAULTS$1.headChars,
		tailChars: config.tailChars ?? DEFAULTS$1.tailChars,
		hardLimitChars: config.hardLimitChars
	};
	assertPositiveInteger("thresholdChars", resolved.thresholdChars);
	assertNonNegativeInteger("headChars", resolved.headChars);
	assertNonNegativeInteger("tailChars", resolved.tailChars);
	const emittedChars = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars;
	if (emittedChars > resolved.thresholdChars) throw new Error(`ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) must be at most thresholdChars (${resolved.thresholdChars})`);
	if (resolved.hardLimitChars !== void 0) {
		assertPositiveInteger("hardLimitChars", resolved.hardLimitChars);
		if (resolved.hardLimitChars < resolved.thresholdChars) throw new Error(`ToolResultPruneConfig: hardLimitChars (${resolved.hardLimitChars}) must be at least thresholdChars (${resolved.thresholdChars})`);
	}
	return deepFreeze(structuredClone(resolved));
}
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`);
}
function assertNonNegativeInteger(name, value) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`);
}
//#endregion
//#region lib/types/internal/compaction/tool-segments.js
/**
* Conservative deterministic tool-segment identification over a session
* surface, re-implemented for `dsh-context-enhancement` from the MIT-licensed
* Card5/6 migration delta of the official rc.1 tree.
*
* SOURCE: this file is a local copy of the working-tree Card5/6 addition
* `packages/compaction/compaction/src/tool-segments.ts` (MIT, on top of tag
* 0.1.2-rc.1 of the `deepseek-harness` repository). The upstream file lands in
* the published package only after the migration ships; this standalone package
* must not depend on that unshipped subpath, so the helper is copied here.
* Provenance is recorded in THIRD_PARTY_NOTICES.md.
*
* A tool segment is a maximal same-turn surface run of assistant tool-call
* messages and complete tool results that starts and ends at balanced tool-pair
* cuts. Every parallel call of one assistant message stays together because the
* run consumes the whole assistant node and its complete results, and an open
* or incomplete trailing tail is excluded. Ordinary user messages, ordinary
* assistant responses, runtime-context snapshots, compaction replacements, and
* every other non-tool surface node interrupt a segment, and a run cannot cross
* a turn. The segmenter infers no semantic objectives, data dependencies,
* cross-turn causality, child-session semantics, or dependencies among parallel
* tools; ambiguous work therefore remains in separate segments.
*
* @module dsh-context-enhancement/internal/compaction/tool-segments
*/
/**
* Whether a surface node is an assistant message that asks for at least one tool.
* @param event - the surface node event.
* @returns true when the derived assistant message contains a tool-call block.
*/
function isToolCallAssistantMessage(event) {
	return event.type === "assistant/message" && event.data.message.content.some((block) => block.type === "tool-call");
}
/**
* Whether a surface node can belong to a tool burst: an assistant message that
* asks for tools, or a tool result. Ordinary assistant responses, user messages
* of every kind (including runtime-context snapshots and compaction
* replacements), and every other non-tool surface node are not burst members.
* @param event - the surface node event.
* @returns true for a tool-call assistant message or a tool result.
*/
function isToolBurstNode(event) {
	if (event.type === "assistant/message") return isToolCallAssistantMessage(event);
	if (event.type === "tool/result") return true;
	return false;
}
/** Read one burst member's owning turn from its payload. */
function turnOf(event) {
	return event.data.turn;
}
/**
* Snapshot the current surface as validated node/event pairs in surface order,
* so every later indexed access is over a dense owned array.
* @param session - session supplying the authoritative current surface.
* @returns the current surface's node seqs and events in surface order.
* @throws when a surface node has no matching log event (corrupt surface).
*/
function surfaceEntries(session) {
	return [...session.surface.nodes].map((seq) => {
		const event = session.eventAt(seq);
		if (event === void 0 || event.seq !== seq) throw new Error(`tool-segments: surface seq ${seq} has no matching session event (corrupt surface)`);
		return {
			seq,
			event
		};
	});
}
/**
* Enumerate the current surface's balanced deterministic tool segments in
* surface order.
*
* Each maximal same-turn run of tool-burst nodes is scanned for balanced
* tool-pair cuts. The emitted segment starts at the first run position whose
* leading cut is balanced and ends at the last position whose trailing cut is
* balanced, so a complete call/result pair is never split, parallel calls from
* one assistant message stay together, and an open or incomplete trailing tail
* (an unanswered assistant tool call) is excluded rather than emitted as a
* partial segment. A run left open by an interrupt or an unanswered earlier
* call emits no partial segment.
* @param session - session supplying the authoritative current surface.
* @returns the balanced tool segments in surface order.
* @throws when a surface node has no matching log event or the surface is
* otherwise corrupt (delegated to the tool-pairing predicates).
*/
function toolSegments(session) {
	const surface = surfaceEntries(session);
	const segments = [];
	let index = 0;
	while (index < surface.length) {
		const first = surface[index].event;
		if (!isToolBurstNode(first) || first.type === "tool/result") {
			index += 1;
			continue;
		}
		const turn = turnOf(first);
		let runEnd = index + 1;
		while (runEnd < surface.length) {
			const candidate = surface[runEnd].event;
			if (!isToolBurstNode(candidate) || turnOf(candidate) !== turn) break;
			runEnd += 1;
		}
		let firstBalancedIndex = -1;
		let lastBalancedIndex = -1;
		for (let cursor = index; cursor < runEnd; cursor += 1) {
			const seq = surface[cursor].seq;
			if (firstBalancedIndex === -1 && toolPairingBalancedBefore(session, seq)) firstBalancedIndex = cursor;
			if (toolPairingBalancedAfter(session, seq)) lastBalancedIndex = cursor;
		}
		if (firstBalancedIndex !== -1 && lastBalancedIndex > firstBalancedIndex) segments.push({
			startSeq: surface[firstBalancedIndex].seq,
			endSeq: surface[lastBalancedIndex].seq,
			seqs: surface.slice(firstBalancedIndex, lastBalancedIndex + 1).map((entry) => entry.seq),
			turn
		});
		index = runEnd;
	}
	return segments;
}
//#endregion
//#region lib/types/internal/compaction/tool-groups.js
const DEFAULTS = {
	minGroupResults: 2,
	minGroupChars: 12e3,
	minGroupTokens: 2e3,
	maxGroupTokens: 12e3,
	maxGroups: 2
};
/** Find qualifying complete tool groups in current surface order. */
function selectToolGroups(session, options = {}) {
	const estimateTokens = options.estimateTokens ?? (() => 0);
	const measureText = options.measureText ?? defaultTextLength;
	const minGroupResults = options.minGroupResults ?? DEFAULTS.minGroupResults;
	const minGroupChars = options.minGroupChars ?? DEFAULTS.minGroupChars;
	const minGroupTokens = options.minGroupTokens ?? DEFAULTS.minGroupTokens;
	const maxGroupTokens = options.maxGroupTokens ?? DEFAULTS.maxGroupTokens;
	const maxGroups = options.maxGroups ?? DEFAULTS.maxGroups;
	const isEligibleResult = options.isEligibleResult;
	const isGroupFittable = options.isGroupFittable;
	const positions = olderPositions(session.surface.nodes, options.olderRange);
	if (positions === null || maxGroups <= 0) return [];
	const selected = [];
	for (const segment of toolSegments(session)) {
		const startPosition = session.surface.nodes.indexOf(segment.startSeq);
		const endPosition = session.surface.nodes.indexOf(segment.endSeq);
		if (startPosition < 0 || endPosition < startPosition) continue;
		if (startPosition < positions.start || endPosition > positions.end) continue;
		const sourceSeqs = segment.seqs;
		const toolResultSeqs = sourceSeqs.filter((seq) => session.eventAt(seq)?.type === "tool/result");
		if (toolResultSeqs.length < minGroupResults) continue;
		const events = sourceSeqs.map((seq) => session.eventAt(seq)).filter((event) => event !== void 0);
		if (events.length !== sourceSeqs.length) throw new Error("tool-groups: surface contains a missing event");
		const estimatedTokens = events.reduce((total, event) => total + estimateTokens(event), 0);
		if (toolResultSeqs.reduce((total, seq) => {
			const event = session.eventAt(seq);
			return event?.type === "tool/result" ? total + measureText(event) : total;
		}, 0) < minGroupChars || estimatedTokens < minGroupTokens) continue;
		const spans = estimatedTokens <= maxGroupTokens ? [sourceSeqs] : splitOversizedRun(session, sourceSeqs, maxGroupTokens, estimateTokens);
		for (const span of spans) {
			const eligibleSpans = isEligibleResult === void 0 ? [span] : splitMixedSpan(session, span, isEligibleResult);
			for (const eligible of eligibleSpans) {
				const group = buildGroup(session, eligible, {
					minGroupResults,
					minGroupChars,
					minGroupTokens,
					maxGroupTokens,
					estimateTokens,
					measureText
				}, isGroupFittable);
				if (group === null) continue;
				selected.push(group);
				if (selected.length >= maxGroups) break;
			}
			if (selected.length >= maxGroups) break;
		}
		if (selected.length >= maxGroups) break;
	}
	return selected;
}
/**
* Build one selectable group from a contiguous surface span of a tool run.
* @param session - session supplying the current surface.
* @param seqs - the span's current surface seqs in surface order.
* @param thresholds - resolved selection budgets and pricing seams.
* @returns the group, or null when the span is empty, over the token cap, or
* below the result/char/token minimums.
* @throws when a span seq has no matching log event (corrupt surface).
*/
function buildGroup(session, seqs, thresholds, isGroupFittable) {
	if (seqs.length === 0) return null;
	const events = seqs.map((seq) => {
		const event = session.eventAt(seq);
		if (event === void 0) throw new Error("tool-groups: surface contains a missing event");
		return event;
	});
	const toolResultSeqs = seqs.filter((_, index) => events[index].type === "tool/result");
	if (toolResultSeqs.length < thresholds.minGroupResults) return null;
	const estimatedTokens = events.reduce((total, event) => total + thresholds.estimateTokens(event), 0);
	if (estimatedTokens < thresholds.minGroupTokens || estimatedTokens > thresholds.maxGroupTokens) return null;
	if (events.reduce((total, event) => total + (event.type === "tool/result" ? thresholds.measureText(event) : 0), 0) < thresholds.minGroupChars) return null;
	const callIds = events.flatMap((event) => event.type === "tool/result" ? [String(event.data.message.source.callId)] : event.type === "assistant/message" ? event.data.message.content.flatMap((block) => block.type === "tool-call" ? [String(block.id)] : []) : []);
	const startSeq = seqs[0];
	const endSeq = seqs.at(-1);
	const first = events[0];
	if (first.type !== "assistant/message" && first.type !== "tool/result") throw new Error("tool-groups: a tool-run span must start on a tool-call message");
	const candidateGroup = {
		sourceSeqs: [...seqs],
		toolResultSeqs,
		callIds: [...new Set(callIds)],
		startSeq,
		endSeq,
		estimatedTokens,
		startPosition: session.surface.nodes.indexOf(startSeq),
		endPosition: session.surface.nodes.indexOf(endSeq),
		turn: first.data.turn
	};
	if (isGroupFittable !== void 0 && !isGroupFittable(candidateGroup)) return null;
	return candidateGroup;
}
/**
* Split one oversized same-turn tool run into step-aligned chunks that fit the
* cap. A cut is taken only where the run stays tool-pairing balanced and the two
* sides belong to different steps, so a tool call never separates from its
* result, parallel calls of one assistant message stay together, and no chunk
* spans two steps.
*
* Every chunk end is re-evaluated from its own chunk start instead of trusting a
* running accumulator: the largest safe end whose own price still fits the cap
* wins, so a fittable prefix survives an over-cap step that only becomes
* visible later in the run. A step that alone exceeds the cap is emitted as its
* own over-cap chunk, which {@link buildGroup} then rejects exactly as before,
* and the split resumes after it so its fittable siblings stay selectable.
* @param session - session supplying the current surface.
* @param seqs - the oversized run's seqs in surface order.
* @param maxGroupTokens - token cap one chunk must not exceed.
* @param estimateTokens - per-event token price.
* @returns the chunks in surface order, covering every input seq exactly once.
*/
function splitOversizedRun(session, seqs, maxGroupTokens, estimateTokens) {
	const tokens = seqs.map((seq) => {
		const event = session.eventAt(seq);
		if (event === void 0) throw new Error("tool-groups: surface contains a missing event");
		return estimateTokens(event);
	});
	const safeCuts = /* @__PURE__ */ new Set();
	for (let position = 1; position < seqs.length; position += 1) if (safeChunkCut(session, seqs[position - 1], seqs[position])) safeCuts.add(position);
	const chunks = [];
	let start = 0;
	while (start < seqs.length) {
		let fitEnd = -1;
		let running = 0;
		for (let end = start; end < seqs.length; end += 1) {
			running += tokens[end];
			if (running > maxGroupTokens) break;
			if (end + 1 === seqs.length || safeCuts.has(end + 1)) fitEnd = end + 1;
		}
		if (fitEnd > start) {
			chunks.push(seqs.slice(start, fitEnd));
			start = fitEnd;
			continue;
		}
		const nextCut = [...safeCuts].find((position) => position > start) ?? seqs.length;
		chunks.push(seqs.slice(start, nextCut));
		start = nextCut;
	}
	return chunks;
}
/**
* Split one candidate span so no returned span mixes eligible and ineligible
* tool results, cutting only at safe step/pair boundaries, and keep only the
* spans whose results are all eligible.
*
* A partial summary can leave a run where replaced results sit beside raw ones.
* Returning that mixed run made the caller skip it as a whole and strand the raw
* siblings forever, so the mixed span is cut where eligibility changes and only
* the all-eligible part is offered for selection. A mix that cannot be cut apart
* safely (the change falls inside one step or across an open pair) yields no
* selectable span, exactly like any other unfittable unit.
* @param session - session supplying the current surface.
* @param seqs - the candidate span's seqs in surface order.
* @param isEligibleResult - eligibility classifier for one tool result seq.
* @returns the all-eligible sub-spans in surface order, possibly empty.
*/
function splitMixedSpan(session, seqs, isEligibleResult) {
	const cutPositions = [];
	for (let position = 1; position < seqs.length; position += 1) if (safeChunkCut(session, seqs[position - 1], seqs[position])) cutPositions.push(position);
	const spans = [];
	let start = 0;
	let chunkEligible;
	let lastResult = -1;
	for (let index = 0; index < seqs.length; index += 1) {
		const event = session.eventAt(seqs[index]);
		if (event === void 0) throw new Error("tool-groups: surface contains a missing event");
		if (event.type !== "tool/result") continue;
		const eligible = isEligibleResult(seqs[index]);
		if (chunkEligible === void 0) chunkEligible = eligible;
		else if (eligible !== chunkEligible) {
			const cut = latestCut(cutPositions, lastResult, index);
			if (cut > start) {
				spans.push(seqs.slice(start, cut));
				start = cut;
				chunkEligible = eligible;
			}
		}
		lastResult = index;
	}
	spans.push(seqs.slice(start));
	return spans.filter((span) => span.every((seq) => {
		const event = session.eventAt(seq);
		if (event === void 0) throw new Error("tool-groups: surface contains a missing event");
		return event.type !== "tool/result" || isEligibleResult(seq);
	}));
}
/** The latest safe boundary in `(after, at]`, or -1 when the two sides cannot be separated. */
function latestCut(cutPositions, after, at) {
	let latest = -1;
	for (const position of cutPositions) if (position > after && position <= at) latest = position;
	return latest;
}
/** Whether a chunk boundary between two adjacent run nodes is balanced and step-aligned. */
function safeChunkCut(session, previous, next) {
	if (!toolPairingBalancedBefore(session, next)) return false;
	const left = session.eventAt(previous);
	const right = session.eventAt(next);
	if (left === void 0 || right === void 0) return false;
	return !sameStep(left, right);
}
function sameStep(left, right) {
	const leftData = left.data;
	const rightData = right.data;
	return leftData.turn !== void 0 && leftData.step !== void 0 && leftData.turn === rightData.turn && leftData.step === rightData.step;
}
function olderPositions(nodes, range) {
	if (range === null) return null;
	if (range === void 0) return {
		start: 0,
		end: nodes.length - 1
	};
	const start = nodes.indexOf(range.start);
	const end = nodes.indexOf(range.end);
	if (start < 0 || end < 0) throw new Error("tool-groups: olderRange must name current surface nodes");
	if (start > end) throw new Error("tool-groups: olderRange start must precede end in surface order");
	return {
		start,
		end
	};
}
/**
* The shared production-default text metric for one tool-result MESSAGE's
* content: Unicode code points across EVERY `text` block — message-level text
* blocks and the text blocks nested in each `tool-result` block alike.
*
* Group selection must qualify on the same measure the deterministic pruning
* threshold uses. Counting the ContentBlock ARRAY LENGTH instead made
* `minGroupChars` a block count no real group could ever satisfy, and counting
* only the first content block hid the later text of a multi-block result from
* the pending-work probe that the deterministic pruner would still reduce.
* @param content - the message-level content blocks of one tool result.
* @returns total Unicode code points across every text block.
*/
function toolResultTextLength(content) {
	let chars = 0;
	for (const block of content) {
		if (block.type === "text") {
			chars += codePointLength(block.text);
			continue;
		}
		if (block.type !== "tool-result") continue;
		chars += toolResultTextLength(block.content);
	}
	return chars;
}
/** The selection metric: the shared code-point metric over the whole message. */
function defaultTextLength(event) {
	return toolResultTextLength(event.data.message.content);
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-compaction_433516940b548e7f8507762c30a53880/node_modules/@deepseek-ai/dsh-compaction/lib/types/checkpoint.js
/**
* Compaction checkpoint provenance: the correlated source constructor and type
* every backend uses for its replacement user message, plus the predicate that
* recognizes persisted checkpoints.
*
* The seam itself lives in `@deepseek-ai/dsh-compaction`, which re-exports these
* contracts; this module is a pure type/value/predicate outlet (no cordis
* imports, no module augmentation) so client and wire programs can name the
* checkpoint source without loading the host plugin's Context merges — the
* `dsh-commands/brand` shape.
*
* @module @deepseek-ai/dsh-compaction/checkpoint
*/
const COMPACT_CHECKPOINT_MARKER = Object.freeze({
	kind: "plugin",
	plugin: "compact"
});
/**
* Test whether a persisted message source identifies a compaction checkpoint.
* @param source - source restored from a surface user message.
* @returns whether the source carries the backend-independent checkpoint marker.
*/
function isCompactCheckpointSource(source) {
	return source.kind === "plugin" && source.plugin === COMPACT_CHECKPOINT_MARKER.plugin;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0._ee5063a80d448ae764858c08e7528ed1/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js
/** Runtime counterpart of the message-producing event union. */
const SURFACE_EVENT_TYPES = /* @__PURE__ */ new Set([
	"user/message",
	"assistant/message",
	"tool/result"
]);
/**
* Narrow an event to a surface-eligible event carrying its required marker.
* @param event - event to test.
* @returns true when both the type and marker identify a surface event.
*/
function isSurfaceEvent(event) {
	if (!SURFACE_EVENT_TYPES.has(event.type)) return false;
	return event.surfaceOp !== void 0;
}
/**
* Narrow an event to a surface replacement: a node that shadowed an existing
* surface range instead of appending to the tail. The counterpart of
* {@link isAppendSurfaceEvent} over the two {@link SurfaceOp} variants.
* @param event - event to test.
* @returns true when the event replaced a surface range.
*/
function isReplacementSurfaceEvent(event) {
	return isSurfaceEvent(event) && event.surfaceOp !== "append";
}
//#endregion
//#region lib/types/internal/compaction/source-index.js
/**
* Durable source classification for the current session surface.
*
* Classification is derived from each replacement's OWN durable provenance —
* written into the Session log by the producer beside the replacement — plus the
* official compaction events, never from generated text and never from a separate
* storage document. The tool-group audit is a diagnostic and a work schedule; it
* is NOT the type authority (see {@link ReductionProvenance}), so an audit
* document that is lost, truncated, or overwritten by another writer's
* whole-document last-write-wins cannot change how a committed replacement is
* classified. A replacement whose provenance is missing or damaged fails closed
* to `unknown-replacement`, which is never read as an original fact.
*/
/**
* Producer marker of every reduction provenance record this package writes.
*
* The field rides the OFFICIAL shadow-price event the shared protocol already
* places immediately before a replacement, because the DSH surface contract
* forbids every other carrier:
*
* - a `tool/result` surface replacement may change ONLY its content
*   (`assertToolResultRewrite`), so the replacement's own `data` cannot carry it;
* - `Session.append()` cannot mark an event `ignorable`, and the persistence read
*   path refuses event types outside the harness's own generated vocabulary that
*   lack that marker, so a plugin-owned event type would make every Session this
*   package touched unreadable after a restart;
* - the official `compaction/prune` data type is a closed interface member that
*   TypeScript refuses to widen by module augmentation, so the writer carries the
*   field on its own widened payload type and the classifier re-validates it from
*   the logged JSON.
*/
const REDUCTION_PROVENANCE_PRODUCER = "dsh-context-enhancement";
/**
* The exact text a reduction's digest binds: every text block of the replacement
* message in document order, nested tool-result blocks included.
*
* It reads text only — never the serialized block objects — so the digest stays
* stable across JSON round-trips that re-order object keys, and the classifier
* can recompute the SAME value from the logged event. The parts are digested as a
* JSON array rather than a joined string, so no separator choice can make two
* different texts collide.
*/
function reductionTextParts(content) {
	const parts = [];
	const visit = (blocks) => {
		for (const block of blocks) if (block.type === "text") parts.push(block.text);
		else if (block.type === "tool-result") visit(block.content);
	};
	visit(content);
	return parts;
}
/** Canonical digest of one reduction record over its fields and its content. */
function reductionDigest(input) {
	return createHash("sha256").update(JSON.stringify([
		REDUCTION_PROVENANCE_PRODUCER,
		String(1),
		input.kind,
		JSON.stringify([...input.coveredSeqs]),
		JSON.stringify([...input.sourceEventSeqs]),
		JSON.stringify(input.groupId),
		String(input.generation),
		JSON.stringify(reductionTextParts(input.content))
	])).digest("hex");
}
/**
* Encode one reduction's durable provenance record.
*
* The builder is a pure encoder and deliberately validates nothing: it is the
* producer's statement of what it did, and the classifier re-validates every
* field it reads back. A damaged record is therefore representable (and is
* rejected on read) rather than silently repaired on write.
* @param input - the reduction's own account of itself.
* @returns the frozen-by-`Session.append` provenance record.
*/
function reductionProvenance(input) {
	return {
		producer: REDUCTION_PROVENANCE_PRODUCER,
		schemaVersion: 1,
		kind: input.kind,
		coveredSeqs: [...input.coveredSeqs],
		sourceEventSeqs: [...input.sourceEventSeqs],
		groupId: input.groupId,
		generation: input.generation,
		digest: reductionDigest(input)
	};
}
/**
* Build the official shadow-price payload for one single-node reduction, with
* this package's provenance attached.
* @param shadowedSeq - the one shadowed surface node.
* @param shadowedTokenCount - heuristic price of the shadowed content.
* @param provenance - the validated-shape provenance record of this reduction.
* @returns the payload to append as `compaction/prune`, immediately before the
*   replacement.
*/
function shadowPriceWithProvenance(shadowedSeq, shadowedTokenCount, provenance) {
	return {
		shadowedRange: {
			start: shadowedSeq,
			end: shadowedSeq
		},
		shadowedSeqs: [shadowedSeq],
		shadowedTokenCount,
		provenance
	};
}
/** Whether one value is a data record an unknown JSON payload can be read from. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read one non-empty array of event seqs, or `undefined` when it is malformed. */
function readSeqArray(value) {
	if (!Array.isArray(value) || value.length === 0) return void 0;
	const seqs = [];
	for (const item of value) {
		if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) return void 0;
		seqs.push(item);
	}
	return seqs;
}
/**
* The validated durable provenance of one surface node, or `undefined` when the
* node carries none this package can trust.
*
* The record must agree with the OFFICIAL part of the event it rides — the
* shadowed range the shared shadow-price protocol states — and its digest must
* still bind the replacement content that is actually in the log. Anything else
* (a foreign producer, an unknown schema version, a truncated or re-typed
* payload, a range that disagrees with the protocol's own statement, a stale
* digest) returns `undefined`, which the classifier turns into
* `unknown-replacement` rather than a guess.
* @param session - session owning the log.
* @param replacement - the surface event being classified.
* @returns the validated record, or `undefined`.
*/
function readReductionProvenance(session, replacement) {
	if (replacement.type !== "tool/result" || !isReplacementSurfaceEvent(replacement)) return void 0;
	if (replacement.seq === 0) return void 0;
	const price = session.eventAt(replacement.seq - 1);
	if (price?.type !== "compaction/prune") return void 0;
	const raw = price.data.provenance;
	if (!isRecord(raw)) return void 0;
	if (raw["producer"] !== "dsh-context-enhancement") return void 0;
	if (raw["schemaVersion"] !== 1) return void 0;
	const kind = raw["kind"];
	if (kind !== "tool-summary" && kind !== "tool-pruned") return void 0;
	const coveredSeqs = readSeqArray(raw["coveredSeqs"]);
	const sourceEventSeqs = readSeqArray(raw["sourceEventSeqs"]);
	if (coveredSeqs === void 0 || sourceEventSeqs === void 0) return void 0;
	const shadowedSeqs = readSeqArray(price.data.shadowedSeqs);
	if (shadowedSeqs === void 0 || shadowedSeqs.length !== coveredSeqs.length || shadowedSeqs.some((seq, index) => seq !== coveredSeqs[index])) return void 0;
	if (coveredSeqs.some((seq) => !sourceEventSeqs.includes(seq))) return void 0;
	if (sourceEventSeqs.some((seq, index) => seq >= replacement.seq || sourceEventSeqs.indexOf(seq) !== index)) return;
	const groupId = raw["groupId"];
	if (kind === "tool-summary") {
		if (typeof groupId !== "string" || groupId.length === 0) return void 0;
	} else if (groupId !== null) return;
	const generation = raw["generation"];
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return void 0;
	if (generation > session.surface.replaceGeneration) return void 0;
	const digest = raw["digest"];
	if (typeof digest !== "string") return void 0;
	if (digest !== reductionDigest({
		kind,
		coveredSeqs,
		sourceEventSeqs,
		groupId: typeof groupId === "string" ? groupId : null,
		generation,
		content: replacement.data.message.content
	})) return void 0;
	return {
		producer: REDUCTION_PROVENANCE_PRODUCER,
		schemaVersion: 1,
		kind,
		coveredSeqs,
		sourceEventSeqs,
		groupId: typeof groupId === "string" ? groupId : null,
		generation,
		digest
	};
}
/** Reconstruct current source types entirely from persisted session provenance. */
function buildSurfaceSourceIndex(session, auditClaimedSummarySeqs = []) {
	const auditClaimedSummaries = new Set(auditClaimedSummarySeqs);
	const boundary = ownBoundarySeq(session);
	const entries = /* @__PURE__ */ new Map();
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (event === void 0) throw new Error(`source-index: surface seq ${seq} has no event`);
		const reduction = readReductionProvenance(session, event);
		const kind = classifyEvent(event, reduction, auditClaimedSummaries.has(seq));
		entries.set(seq, {
			seq,
			kind,
			sourceEventSeqs: replacementSources(event),
			completedTurnsAfter: kind === "original" ? 0 : completedTurnsAfter(session, event, boundary),
			reduction: reduction ?? null,
			inherited: Number(seq) < boundary
		});
	}
	return {
		entries,
		ownBoundarySeq: boundary,
		entry(seq) {
			const entry = entries.get(seq);
			if (entry === void 0) throw new Error(`source-index: surface seq ${seq} is not indexed`);
			return entry;
		},
		isOriginalToolResult(seq) {
			return session.eventAt(seq)?.type === "tool/result" && entries.get(seq)?.kind === "original";
		},
		canCompactHistory(seq, minReentryTurns, allowImmediateReentry = false) {
			const entry = entries.get(seq);
			if (entry === void 0 || entry.kind === "unknown-replacement") return false;
			if (entry.kind === "original") return true;
			if (allowImmediateReentry && !entry.inherited && (entry.kind === "tool-summary" || entry.kind === "tool-pruned" || entry.kind === "history-summary")) return true;
			return entry.completedTurnsAfter >= minReentryTurns;
		},
		replacementCoverage(seq) {
			const event = session.eventAt(seq);
			const entry = entries.get(seq);
			if (event === void 0 || entry === void 0) return void 0;
			if (!isReplacementSurfaceEvent(event)) return {
				kind: entry.kind === "task-state-slot" ? "task-state-slot" : "original",
				coveredSeqs: null
			};
			return {
				kind: entry.kind,
				coveredSeqs: entry.reduction?.coveredSeqs ?? entry.sourceEventSeqs
			};
		}
	};
}
/**
* Classify one surface node from its validated durable provenance.
*
* A replacement is the kind its OWN record says it is. A replacement without a
* usable record is `unknown-replacement` — never `original`, and never one of
* the kind buckets a foreign producer might have intended, because this package
* cannot prove what such a node holds. A node that is not a replacement is an
* `original` fact of the conversation regardless of what event precedes it.
* @param event - the node being classified.
* @param reduction - its validated provenance, when it has one.
* @param auditClaimedSummary - whether the diagnostic audit claims this exact
*   node as a served semantic summary.
* @returns the node's source kind.
*/
function classifyEvent(event, reduction, auditClaimedSummary) {
	if (event.type === "user/message" && isTaskStateSlotSource(event.data.source)) return "task-state-slot";
	if (isHistorySummary(event)) return "history-summary";
	if (event.type !== "tool/result" || !isReplacementSurfaceEvent(event)) return "original";
	if (reduction === void 0) return "unknown-replacement";
	if (auditClaimedSummary && reduction.kind !== "tool-summary") return "unknown-replacement";
	return reduction.kind;
}
function isHistorySummary(event) {
	if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return false;
	const source = event.data.source;
	return source.kind === "plugin" && isCompactCheckpointSource(source);
}
function replacementSources(event) {
	return isReplacementSurfaceEvent(event) ? [...event.sourceEventSeqs ?? []] : [];
}
/**
* The Session's own-event boundary: the seq of its first own event.
*
* `Session.inheritedEventCount` is the durable seeding length restored from the
* persisted `seedLength` header field, so it is the same value before and after a
* resume — unlike `firstLiveSeq`, which reports the in-process constructor seed
* length and therefore the WHOLE stored log length after a resume. An unseeded
* Session reports `0`: it has no prefix and its first own event is seq 0, which
* is what keeps every unforked Session's index byte-for-byte identical.
*/
function ownBoundarySeq(session) {
	const inherited = Number(session.inheritedEventCount);
	return Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
}
/**
* How many completed turns of the CURRENT lifecycle follow one replacement.
*
* The count starts at the replacement's own successor, but never below the
* Session's own boundary: the completed turns of an inherited prefix belong to
* the parent lifecycle and cannot age a node for the child that inherited it.
* @param session - session owning the log.
* @param replacement - the replacement node being aged.
* @param boundary - the Session's own-event boundary (`0` when unseeded).
* @returns the number of own completed turns after the replacement.
*/
function completedTurnsAfter(session, replacement, boundary) {
	let count = 0;
	for (let seq = Math.max(replacement.seq + 1, boundary); seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event?.type === "turn/end" && event.data.reason?.kind === "completed") count += 1;
	}
	return count;
}
//#endregion
export { isCompactCheckpointSource as a, DEFAULTS$1 as c, resolveConfig as d, toolPairingBalancedAfter as f, isReplacementSurfaceEvent as i, PRUNE_MARKER as l, reductionProvenance as n, selectToolGroups as o, toolPairingBalancedBefore as p, shadowPriceWithProvenance as r, toolResultTextLength as s, buildSurfaceSourceIndex as t, codePointLength as u };
