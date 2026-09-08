import { t as Schema } from "./lib-Bj3jGSND.js";
import { s as freezeMessage, u as deepFreeze } from "./lib-DXy8Ramy.js";
import { Service } from "@deepseek-ai/cordis";
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
const DEFAULTS = deepFreeze({
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
		thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
		headChars: config.headChars ?? DEFAULTS.headChars,
		tailChars: config.tailChars ?? DEFAULTS.tailChars,
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
//#region lib/types/tool-result-pruner.js
/**
* `dsh-context-enhancement` — `./tool-result-pruner` subpath entry.
*
* Replay-safe, model-free tool-result pruning service providing the official
* rc1 `toolResultPruner` service identity (`ctx.toolResultPruner`). The
* official rc1 package has no extensible provider/definition to subclass (its
* root exports the concrete {@link ToolResultPruner} class directly, and the
* official service name `toolResultPruner` is matched by the Service
* constructor), so this module re-implements the rc1 public class semantics
* from the published rc1 sources — plus the Card5/6 region-aware `olderRange`
* three-state option and the experimental text-only `hardLimitChars` bound —
* while registering the same `toolResultPruner` service name. It re-declares
* the official `ctx.toolResultPruner` Context merge so composition type-checks
* against this provider in the same preset isolate realm.
*
* Only the published rc1 exports of the official packages are imported; the
* internal implementation is a local MIT copy of the rc1 sources. SOURCE
* provenance is recorded in THIRD_PARTY_NOTICES.md under
* `@deepseek-ai/dsh-compaction-tool-result-pruner` (MIT, tag dsh-v0.1.2-rc.1).
*
* @module dsh-context-enhancement/tool-result-pruner
*/
/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
var ToolResultPruner = class extends Service {
	static inject = ["tokenMeter"];
	static Config = Schema.object({
		thresholdChars: Schema.number().step(1).min(1).default(DEFAULTS.thresholdChars),
		headChars: Schema.number().step(1).min(0).default(DEFAULTS.headChars),
		tailChars: Schema.number().step(1).min(0).default(DEFAULTS.tailChars),
		hardLimitChars: Schema.number().step(1).min(1).default(void 0)
	});
	/** Resolved and immutable character budgets. */
	config;
	constructor(ctx, config = {}) {
		super(ctx, "toolResultPruner");
		this.config = resolveConfig(config);
	}
	/**
	* Measure text content in Unicode code points; non-text blocks cost zero.
	* @param blocks - tool-result content to measure.
	* @returns total Unicode code points across text blocks.
	*/
	measureContent(blocks) {
		let chars = 0;
		for (const block of blocks) if (block.type === "text") chars += codePointLength(block.text);
		return chars;
	}
	/**
	* Replace an over-budget text middle while retaining rich-block order. Text
	* slicing is by Unicode code point, not UTF-16 code unit, so a retained
	* boundary cannot split a surrogate pair. Grapheme clusters may still split.
	* @param blocks - original tool-result content.
	* @returns pruned content, or `null` when the text is within budget.
	*/
	pruneContent(blocks) {
		return this.reduceContent(blocks, this.config.thresholdChars);
	}
	/**
	* Reduce one exceptionally large tool result below the configured head,
	* marker, and tail budgets when its `text` exceeds the experimental
	* recent-result hard limit; returns `null` when no hard limit is configured
	* or the content stays within it. Non-text blocks never count toward the
	* measured total.
	* @param blocks - original tool-result content.
	* @returns the bounded replacement, or `null` when reduction does not apply.
	*/
	pruneRecentContent(blocks) {
		if (this.config.hardLimitChars === void 0) return null;
		return this.reduceContent(blocks, this.config.hardLimitChars);
	}
	/**
	* Reduce text whose total exceeds `triggerChars` to the configured head,
	* marker, and tail budget while preserving rich-block order. The measured
	* total counts `text`-block Unicode code points only; image, attachment, and
	* other non-text blocks cost zero and are never sliced or counted against a
	* budget.
	* @param blocks - original tool-result content.
	* @param triggerChars - character bound that makes a reduction apply.
	* @returns the bounded replacement, or `null` when the text is within budget.
	*/
	reduceContent(blocks, triggerChars) {
		const totalChars = this.measureContent(blocks);
		if (totalChars <= triggerChars) return null;
		const removedStart = this.config.headChars;
		const removedEnd = totalChars - this.config.tailChars;
		const pruned = [];
		let consumed = 0;
		let markerInserted = false;
		for (const block of blocks) {
			if (block.type !== "text") {
				pruned.push(block);
				continue;
			}
			const points = Array.from(block.text);
			const blockStart = consumed;
			const blockEnd = blockStart + points.length;
			const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
			const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
			const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : "";
			if (marker.length > 0) markerInserted = true;
			const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("");
			if (text.length > 0) pruned.push({
				...block,
				text
			});
			consumed = blockEnd;
		}
		if (!markerInserted) throw new Error("tool-result prune: failed to locate the removed text span");
		const charsAfter = this.measureContent(pruned);
		if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) throw new Error("tool-result prune: replacement must be smaller and within threshold");
		return pruned;
	}
	/**
	* Prune eligible tool results from one stable current-surface snapshot.
	* Without `options`, every over-budget result in the snapshot is ordinary-
	* eligible, preserving the original whole-surface pass. With `options`, only
	* results inside the caller-selected older eligible span are ordinary-
	* eligible; a result outside the span (the protected recent region) stays at
	* high fidelity unless `hardLimitChars` forces one exceptionally large recent
	* result down to the ordinary budget. The span's `start`/`end` name surface
	* POSITIONS by current-surface event seq (a closed interval resolved with
	* `indexOf`), so a numerically larger `start` than `end` is valid when
	* replacements made the visible seqs non-monotonic. Each replacement
	* preserves the complete event data except for `content`, cites the shadowed
	* node so replay can recover the replacement input, and is immediately
	* preceded by a `compaction/prune` shadow-price event pricing the shadowed
	* node through the injected token meter, so pure consumers can subtract it
	* without per-node state.
	* @param session - session whose current surface is rewritten.
	* @param options - optional eligible older span for region-aware passes.
	* @returns landed replacements and aggregate Unicode-code-point savings.
	* @throws when the session rejects a replacement, or an `olderRange` names a
	* seq absent from the current surface; replacements committed earlier in the
	* pass remain durable.
	*/
	pruneSession(session, options) {
		const nodes = [...session.surface.nodes];
		const olderSpan = options?.olderRange === void 0 ? {
			startIndex: 0,
			endIndex: nodes.length - 1
		} : options.olderRange === null ? null : resolveOlderSpan(nodes, options.olderRange);
		const explicitCandidates = options?.candidateSeqs === void 0 ? void 0 : new Set(options.candidateSeqs);
		if (explicitCandidates !== void 0) {
			for (const seq of explicitCandidates) if (!nodes.includes(seq)) throw new Error(`tool-result prune: candidate seq ${seq} not found in surface`);
		}
		const candidates = [];
		for (const [position, seq] of nodes.entries()) {
			const event = session.eventAt(seq);
			if (event?.type !== "tool/result" || explicitCandidates !== void 0 && !explicitCandidates.has(seq)) continue;
			const ordinaryEligible = olderSpan === null ? false : position >= olderSpan.startIndex && position <= olderSpan.endIndex;
			candidates.push({
				seq,
				event,
				ordinaryEligible
			});
		}
		const pruned = [];
		let charsRemoved = 0;
		for (const { seq, event, ordinaryEligible } of candidates) {
			const result = event.data.message.content[0];
			const content = ordinaryEligible ? this.pruneContent(result.content) : this.pruneRecentContent(result.content);
			if (content === null) continue;
			const charsBefore = this.measureContent(result.content);
			const charsAfter = this.measureContent(content);
			const message = freezeMessage({
				...event.data.message,
				content: [{
					...result,
					content
				}]
			});
			session.append("compaction/prune", {
				shadowedRange: {
					start: seq,
					end: seq
				},
				shadowedSeqs: [seq],
				shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message)
			});
			const replacement = session.append("tool/result", {
				...event.data,
				message
			}, {
				surfaceOp: {
					op: "replace",
					start: seq,
					end: seq
				},
				sourceEventSeqs: [seq]
			});
			pruned.push({
				originalSeq: seq,
				replacementSeq: replacement.seq,
				callId: event.data.message.source.callId,
				charsBefore,
				charsAfter
			});
			charsRemoved += charsBefore - charsAfter;
		}
		return {
			pruned,
			charsRemoved
		};
	}
};
/** Resolve a caller older span's inclusive surface positions. */
function resolveOlderSpan(nodes, range) {
	const startIndex = nodes.indexOf(range.start);
	const endIndex = nodes.indexOf(range.end);
	if (startIndex === -1) throw new Error(`tool-result prune: olderRange start seq ${range.start} not found in surface`);
	if (endIndex === -1) throw new Error(`tool-result prune: olderRange end seq ${range.end} not found in surface`);
	if (startIndex > endIndex) throw new Error(`tool-result prune: olderRange start seq ${range.start} (position ${startIndex}) is after end seq ${range.end} (position ${endIndex}) on the surface`);
	return {
		startIndex,
		endIndex
	};
}
//#endregion
export { DEFAULTS, PRUNE_MARKER, ToolResultPruner, ToolResultPruner as default, codePointLength, resolveConfig };
