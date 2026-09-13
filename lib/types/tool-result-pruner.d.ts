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
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { PruneResult, ResolvedConfig, ToolResultPruneConfig, ToolResultPruneOptions } from './internal/compaction/pruner-types.ts';
export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './internal/compaction/pruner-config.ts';
export type { PrunedEntry, PruneResult, ResolvedConfig, ToolResultPruneConfig, ToolResultPruneOptions, ToolResultPruneRange, } from './internal/compaction/pruner-types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        toolResultPruner: ToolResultPruner;
    }
}
/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export declare class ToolResultPruner extends Service {
    static inject: string[];
    static Config: z<ToolResultPruneConfig>;
    /** Resolved and immutable character budgets. */
    readonly config: ResolvedConfig;
    constructor(ctx: Context, config?: ToolResultPruneConfig);
    /**
     * Measure text content in Unicode code points; non-text blocks cost zero.
     * @param blocks - tool-result content to measure.
     * @returns total Unicode code points across text blocks.
     */
    measureContent(blocks: readonly ContentBlock[]): number;
    /**
     * Measure one tool-result MESSAGE's content the way {@link pruneSession}
     * reduces it: Unicode code points across EVERY text block — message-level
     * text blocks and the text blocks nested in each tool-result block alike —
     * so a pending-work probe that asks this metric can never call a multi-block
     * result small when the deterministic pass would still reduce it.
     * @param blocks - message-level content blocks of one tool result.
     * @returns total Unicode code points across every text block.
     */
    measureMessageText(blocks: readonly ContentBlock[]): number;
    /**
     * Replace an over-budget text middle while retaining rich-block order. Text
     * slicing is by Unicode code point, not UTF-16 code unit, so a retained
     * boundary cannot split a surrogate pair. Grapheme clusters may still split.
     * @param blocks - original tool-result content.
     * @returns pruned content, or `null` when the text is within budget.
     */
    pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null;
    /**
     * Reduce one exceptionally large tool result below the configured head,
     * marker, and tail budgets when its `text` exceeds the experimental
     * recent-result hard limit; returns `null` when no hard limit is configured
     * or the content stays within it. Non-text blocks never count toward the
     * measured total.
     * @param blocks - original tool-result content.
     * @returns the bounded replacement, or `null` when reduction does not apply.
     */
    pruneRecentContent(blocks: readonly ContentBlock[]): ContentBlock[] | null;
    /**
     * Reduce one whole tool-result MESSAGE below the ordinary threshold while
     * preserving its message-level block structure: every original content block
     * survives (rich and message-level text blocks ride along in place), and the
     * shared removed window spans every text block of the message. Returns null
     * for a message whose total text is within budget.
     */
    private pruneMessageContent;
    /** The recent-result hard limit applied to a whole message's content. */
    private pruneRecentMessageContent;
    /**
     * Message-level twin of {@link reduceContent}: the measured total and the
     * removed span cover EVERY text block of the message (message-level text and
     * the text nested inside tool-result blocks alike), while all other blocks —
     * including the tool-result blocks that carry them — keep their positions.
     * An empty content array measures zero and never reduces.
     */
    private reduceMessageContent;
    /**
     * Walk one message-level (or nested tool-result) block list, sharing the
     * removed window across every text unit in surface order. Non-text blocks
     * pass through untouched; a tool-result block recurses so its own text joins
     * the same measured stream. Slicing is by Unicode code point, so a retained
     * boundary cannot split a surrogate pair.
     */
    private reduceMessageBlocks;
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
    private reduceContent;
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
    pruneSession(session: Session, options?: ToolResultPruneOptions): PruneResult;
}
export default ToolResultPruner;
//# sourceMappingURL=tool-result-pruner.d.ts.map