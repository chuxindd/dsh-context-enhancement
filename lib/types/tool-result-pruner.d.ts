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
     * @param options - optional eligible older span for region-aware passes.
     * @returns landed replacements and aggregate Unicode-code-point savings.
     * @throws when the session rejects a replacement, or an `olderRange` names a
     * seq absent from the current surface; replacements committed earlier in the
     * pass remain durable.
     */
    pruneSession(session: Session, options?: ToolResultPruneOptions): PruneResult;
}
export default ToolResultPruner;
//# sourceMappingURL=tool-result-pruner.d.ts.map