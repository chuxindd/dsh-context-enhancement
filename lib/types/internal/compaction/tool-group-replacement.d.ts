import type { ToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ToolGroup } from './tool-groups.ts';
import type { ToolGroupSummary } from './tool-group-summary.ts';
/** Pricing seam for the shared shadow-price protocol. */
export interface ToolGroupReplacementOptions {
    /**
     * Heuristic price of one shadowed tool result under the SAME fixed estimator
     * the session's token meter prices appends with. It is logged with the
     * shadow-price event, so a bounded replay fold can subtract the replaced
     * node's price without retaining per-node state.
     */
    readonly estimateTokens: (message: ToolResultMessage) => number;
    /**
     * Invoked synchronously for each landed replacement, before the next group
     * member is attempted. A `session.append` failure mid-group leaves the
     * earlier replacements durable, so reporting them immediately lets the caller
     * exclude them from the same invocation's semantic pass even though the
     * returned result never arrives.
     */
    readonly onLanded?: (seq: SessionSeq) => void;
}
export interface ToolGroupReplacementResult {
    readonly replacementSeqs: readonly SessionSeq[];
    readonly sourceSeqs: readonly SessionSeq[];
}
/**
 * Replace every tool result of one summarized group on the current surface.
 *
 * Each landed replacement follows the shared shadow-price protocol exactly like
 * the deterministic pruner: a `compaction/prune` event stating the replaced
 * node's price is appended synchronously immediately before the surface
 * `replace`. That single durable event vocabulary therefore records EVERY
 * successful tool-result reduction path — semantic group summarization here and
 * the model-free head/middle prune — and keeps replay folds exact instead of
 * folding an unpriced replacement neutrally.
 *
 * That same event also carries this reduction's durable provenance record
 * (`kind: 'tool-summary'`, the whole group's source seqs, the group identity,
 * the observed replace generation, and a digest over the replacement text).
 * It is what a restart or replay classifies from, so losing the tool-group
 * audit can no longer downgrade a committed summary.
 * @param session - session whose current surface is rewritten.
 * @param group - selected group whose tool results are replaced.
 * @param summary - validated per-source summary items.
 * @param options - pricing seam for the logged shadow price.
 * @returns landed replacements and the cited group sources. A source node whose
 *   formatted summary would price more than the original is skipped by the
 *   per-node shrink guard and contributes no replacement; a source node with
 *   no text to distill (an empty content array, or only rich blocks) stays raw
 *   without an exception too.
 * @throws when a target is no longer a tool result or has no summary item;
 * nothing is appended in that case.
 */
export declare function replaceToolGroup(session: Session, group: ToolGroup, summary: ToolGroupSummary, options: ToolGroupReplacementOptions): ToolGroupReplacementResult;
//# sourceMappingURL=tool-group-replacement.d.ts.map