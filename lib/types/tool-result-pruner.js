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
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from "./internal/compaction/pruner-config.js";
import { reductionProvenance, shadowPriceWithProvenance } from "./internal/compaction/source-index.js";
import { toolResultTextLength } from "./internal/compaction/tool-groups.js";
export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from "./internal/compaction/pruner-config.js";
/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
    // The token meter prices each shadowed node for its logged shadow-price
    // event, so pruning genuinely requires the pricing capability.
    static inject = ['tokenMeter'];
    static Config = z.object({
        thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
        headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
        tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
        // Preserve omission so the resolved config can distinguish a disabled
        // recent-result hard limit from an explicitly configured value.
        hardLimitChars: z.number().step(1).min(1).default(undefined),
    });
    /** Resolved and immutable character budgets. */
    config;
    constructor(ctx, config = {}) {
        super(ctx, 'toolResultPruner');
        this.config = resolveConfig(config);
    }
    /**
     * Measure text content in Unicode code points; non-text blocks cost zero.
     * @param blocks - tool-result content to measure.
     * @returns total Unicode code points across text blocks.
     */
    measureContent(blocks) {
        let chars = 0;
        for (const block of blocks) {
            if (block.type === 'text')
                chars += codePointLength(block.text);
        }
        return chars;
    }
    /**
     * Measure one tool-result MESSAGE's content the way {@link pruneSession}
     * reduces it: Unicode code points across EVERY text block — message-level
     * text blocks and the text blocks nested in each tool-result block alike —
     * so a pending-work probe that asks this metric can never call a multi-block
     * result small when the deterministic pass would still reduce it.
     * @param blocks - message-level content blocks of one tool result.
     * @returns total Unicode code points across every text block.
     */
    measureMessageText(blocks) {
        return toolResultTextLength(blocks);
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
        if (this.config.hardLimitChars === undefined)
            return null;
        return this.reduceContent(blocks, this.config.hardLimitChars);
    }
    /**
     * Reduce one whole tool-result MESSAGE below the ordinary threshold while
     * preserving its message-level block structure: every original content block
     * survives (rich and message-level text blocks ride along in place), and the
     * shared removed window spans every text block of the message. Returns null
     * for a message whose total text is within budget.
     */
    pruneMessageContent(messageContent) {
        return this.reduceMessageContent(messageContent, this.config.thresholdChars);
    }
    /** The recent-result hard limit applied to a whole message's content. */
    pruneRecentMessageContent(messageContent) {
        if (this.config.hardLimitChars === undefined)
            return null;
        return this.reduceMessageContent(messageContent, this.config.hardLimitChars);
    }
    /**
     * Message-level twin of {@link reduceContent}: the measured total and the
     * removed span cover EVERY text block of the message (message-level text and
     * the text nested inside tool-result blocks alike), while all other blocks —
     * including the tool-result blocks that carry them — keep their positions.
     * An empty content array measures zero and never reduces.
     */
    reduceMessageContent(messageContent, triggerChars) {
        const totalChars = this.measureMessageText(messageContent);
        if (totalChars <= triggerChars)
            return null;
        const removedStart = this.config.headChars;
        const removedEnd = totalChars - this.config.tailChars;
        const state = { consumed: 0, markerInserted: false };
        const pruned = this.reduceMessageBlocks(messageContent, removedStart, removedEnd, state);
        if (!state.markerInserted)
            throw new Error('tool-result prune: failed to locate the removed text span');
        const charsAfter = this.measureMessageText(pruned);
        if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
            throw new Error('tool-result prune: replacement must be smaller and within threshold');
        }
        return pruned;
    }
    /**
     * Walk one message-level (or nested tool-result) block list, sharing the
     * removed window across every text unit in surface order. Non-text blocks
     * pass through untouched; a tool-result block recurses so its own text joins
     * the same measured stream. Slicing is by Unicode code point, so a retained
     * boundary cannot split a surrogate pair.
     */
    reduceMessageBlocks(blocks, removedStart, removedEnd, state) {
        const pruned = [];
        for (const block of blocks) {
            if (block.type === 'tool-result') {
                pruned.push({ ...block, content: this.reduceMessageBlocks(block.content, removedStart, removedEnd, state) });
                continue;
            }
            if (block.type !== 'text') {
                pruned.push(block);
                continue;
            }
            const points = Array.from(block.text);
            const blockStart = state.consumed;
            const blockEnd = blockStart + points.length;
            const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
            const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
            const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart;
            const marker = intersectsRemoved && !state.markerInserted ? PRUNE_MARKER : '';
            if (marker.length > 0)
                state.markerInserted = true;
            const text = points.slice(0, headEnd).join('')
                + marker
                + points.slice(tailStart).join('');
            state.consumed = blockEnd;
            if (text.length > 0)
                pruned.push({ ...block, text });
        }
        return pruned;
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
        if (totalChars <= triggerChars)
            return null;
        const removedStart = this.config.headChars;
        const removedEnd = totalChars - this.config.tailChars;
        const pruned = [];
        let consumed = 0;
        let markerInserted = false;
        for (const block of blocks) {
            if (block.type !== 'text') {
                pruned.push(block);
                continue;
            }
            const points = Array.from(block.text);
            const blockStart = consumed;
            const blockEnd = blockStart + points.length;
            const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
            const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
            const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart;
            const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : '';
            if (marker.length > 0)
                markerInserted = true;
            const text = points.slice(0, headEnd).join('')
                + marker
                + points.slice(tailStart).join('');
            if (text.length > 0)
                pruned.push({ ...block, text });
            consumed = blockEnd;
        }
        // totalChars > trigger and valid budgets guarantee a removed text span.
        if (!markerInserted)
            throw new Error('tool-result prune: failed to locate the removed text span');
        const charsAfter = this.measureContent(pruned);
        // Config validation fixes the emitted head + marker + tail budget.
        if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
            throw new Error('tool-result prune: replacement must be smaller and within threshold');
        }
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
     * @param options - optional eligible older span for region-aware passes, plus
     * the per-replacement landing callback a partial pass reports through.
     * @returns landed replacements and aggregate Unicode-code-point savings.
     * @throws when the session rejects a replacement, or an `olderRange` names a
     * seq absent from the current surface; replacements committed earlier in the
     * pass remain durable.
     */
    pruneSession(session, options) {
        const nodes = [...session.surface.nodes];
        const olderSpan = options?.olderRange === undefined
            ? { startIndex: 0, endIndex: nodes.length - 1 }
            : options.olderRange === null
                ? null
                : resolveOlderSpan(nodes, options.olderRange);
        const explicitCandidates = options?.candidateSeqs === undefined
            ? undefined
            : new Set(options.candidateSeqs);
        if (explicitCandidates !== undefined) {
            for (const seq of explicitCandidates) {
                if (!nodes.includes(seq))
                    throw new Error(`tool-result prune: candidate seq ${seq} not found in surface`);
            }
        }
        const candidates = [];
        for (const [position, seq] of nodes.entries()) {
            const event = session.eventAt(seq);
            // The normal legacy pass can consider every original tool result. Three-zone
            // maintenance provides an explicit provenance-derived set, so summaries are
            // never identified by generated text or accidentally re-pruned.
            if (event?.type !== 'tool/result' || (explicitCandidates !== undefined && !explicitCandidates.has(seq)))
                continue;
            const ordinaryEligible = olderSpan === null
                ? false
                : position >= olderSpan.startIndex && position <= olderSpan.endIndex;
            candidates.push({ seq, event, ordinaryEligible });
        }
        const pruned = [];
        let charsRemoved = 0;
        for (const { seq, event, ordinaryEligible } of candidates) {
            // Measurement and reduction walk EVERY message-level content block, so an
            // empty content array has nothing to measure (skip, stay raw) and a
            // corrupt or synthetic multi-block message cannot crash the pass.
            const originalContent = event.data.message.content;
            if (originalContent.length === 0)
                continue;
            const content = ordinaryEligible
                ? this.pruneMessageContent(originalContent)
                : this.pruneRecentMessageContent(originalContent);
            if (content === null)
                continue;
            const charsBefore = this.measureMessageText(originalContent);
            const charsAfter = this.measureMessageText(content);
            const message = freezeMessage({
                ...event.data.message,
                // The reduction preserves the message-level block structure; for the
                // well-formed single tool-result block this is exactly that block with
                // its pruned inner content.
                content: content,
            });
            // Shadow-price protocol: the metering event and its replacement are
            // appended synchronously adjacent, so pure consumers subtract the
            // shadowed node's heuristic price without retaining per-node state. That
            // same event carries this reduction's durable provenance, so a restarted
            // or replayed Session classifies the replacement as `tool-pruned` from the
            // Session log alone — no audit document takes part — while a foreign
            // pruner that logs only the price stays fail-closed (`unknown-replacement`)
            // instead of being read as this package's own model-free reduction.
            const provenance = reductionProvenance({
                kind: 'tool-pruned',
                // A model-free prune stands for exactly the one node it shadows and
                // derives from it alone, so it cites that node once.
                coveredSeqs: [seq],
                sourceEventSeqs: [seq],
                // No tool group took part, and the record says so rather than inventing
                // an identity a recovery could mistake for a summarized group.
                groupId: null,
                generation: session.surface.replaceGeneration,
                content: message.content,
            });
            session.append('compaction/prune', shadowPriceWithProvenance(seq, this.ctx.tokenMeter.estimateMessage(event.data.message), provenance));
            const replacement = session.append('tool/result', {
                ...event.data,
                message,
            }, {
                surfaceOp: { op: 'replace', start: seq, end: seq },
                sourceEventSeqs: [seq],
            });
            const entry = {
                originalSeq: seq,
                replacementSeq: replacement.seq,
                callId: event.data.message.source.callId,
                charsBefore,
                charsAfter,
            };
            pruned.push(entry);
            charsRemoved += charsBefore - charsAfter;
            // Report the landed replacement before touching the next candidate: a
            // later throw in this same pass leaves it durable, and the caller must be
            // able to exclude it from this invocation's remaining work.
            options?.onReplacement?.(entry);
        }
        return { pruned, charsRemoved };
    }
}
/** Resolve a caller older span's inclusive surface positions. */
function resolveOlderSpan(nodes, range) {
    const startIndex = nodes.indexOf(range.start);
    const endIndex = nodes.indexOf(range.end);
    if (startIndex === -1) {
        throw new Error(`tool-result prune: olderRange start seq ${range.start} not found in surface`);
    }
    if (endIndex === -1) {
        throw new Error(`tool-result prune: olderRange end seq ${range.end} not found in surface`);
    }
    if (startIndex > endIndex) {
        throw new Error(`tool-result prune: olderRange start seq ${range.start} (position ${startIndex}) `
            + `is after end seq ${range.end} (position ${endIndex}) on the surface`);
    }
    return { startIndex, endIndex };
}
export default ToolResultPruner;
//# sourceMappingURL=tool-result-pruner.js.map