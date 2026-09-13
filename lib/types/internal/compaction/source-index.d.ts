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
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEventMap, SessionSeq } from '@deepseek-ai/dsh-session';
export type SurfaceSourceKind = 'original' | 'tool-summary' | 'tool-pruned' | 'history-summary' | 'unknown-replacement'
/**
 * One plugin-owned Stable task-state slot node: runtime/task-state delivery,
 * NOT an original fact of the conversation. The consumer replaces this exact
 * node on every committed revision, so folding it into a history summary
 * would condense live durable state as if it were dialogue and would leave the
 * consumer's slot shadowed (it rebuilds from the log afterwards).
 */
 | 'task-state-slot';
export interface SurfaceSourceEntry {
    readonly seq: SessionSeq;
    readonly kind: SurfaceSourceKind;
    readonly sourceEventSeqs: readonly SessionSeq[];
    /**
     * Later completed turns after this replacement. Under the ordinary
     * maintenance/overflow rule a replacement may only re-enter semantic
     * compaction after this many of them; the whole-zone pressure pass
     * deliberately relaxes that rule for known replacements (see
     * {@link SurfaceSourceIndex.canCompactHistory}).
     *
     * For an {@link SurfaceSourceEntry.inherited} node this counts only the turns
     * of the CURRENT lifecycle: a node a fork child received inside its inherited
     * prefix is aged by the child's own completed turns, never by the parent's.
     */
    readonly completedTurnsAfter: number;
    /**
     * The validated durable reduction provenance of this node, or `null` when the
     * node is not one of this package's reductions — an original, a checkpoint, a
     * runtime task-state slot, a foreign replacement, or a reduction whose
     * recorded provenance did not survive validation (a damaged record reads as
     * `null`, never as a guessed kind).
     */
    readonly reduction: ReductionProvenance | null;
    /**
     * Whether this surface node lies INSIDE the Session's inherited fork prefix,
     * i.e. below `Session.inheritedEventCount`.
     *
     * Such a node is durable history the current lifecycle was seeded with, not
     * content it produced: it is never a live source of this lifecycle for
     * re-entry purposes, and it is aged by this lifecycle's own turns only. The
     * node keeps the `kind` its own durable provenance states — inherited content
     * is not misclassified, only fenced.
     */
    readonly inherited: boolean;
}
export interface SurfaceSourceIndex {
    readonly entries: ReadonlyMap<SessionSeq, SurfaceSourceEntry>;
    /**
     * The Session's own-event boundary: the seq of its first own event, or `0`
     * for a lifecycle that began on its own events (every unforked Session).
     * Every seq below it is inherited through the fork prefix.
     */
    readonly ownBoundarySeq: number;
    entry(seq: SessionSeq): SurfaceSourceEntry;
    isOriginalToolResult(seq: SessionSeq): boolean;
    /**
     * Whether one surface node may be folded into a semantic history compaction.
     *
     * Original content is always eligible. Replacement content is deferred until
     * `minReentryTurns` later completed turns exist, so a replacement is served
     * by real requests before being condensed again. Pass
     * `allowImmediateReentry` to waive that age rule for reductions THIS package
     * produced and can still prove (tool summary, pruned result, history
     * summary) — the pressure tier needs it, because a replacement that sits
     * inside a later invocation's span already has newer dialogue after it and
     * its content has reached at least one request regardless of `turn/end`
     * boundaries. A replacement that carries no validated provenance, or one a
     * third party produced, is never relaxed by the flag and keeps the
     * completed-turn rule in every path: without durable provenance this package
     * cannot prove the replacement holds anything but already-condensed text.
     *
     * An {@link SurfaceSourceEntry.inherited} node is never relaxed by the flag
     * either: the current lifecycle did not produce it. A fork child inherited it
     * as history, and it becomes eligible again only once the CHILD's own
     * completed turns satisfy `minReentryTurns`.
     *
     * The flag waives the AGE rule only. Whether an already-covered replacement is
     * worth re-summarizing at all is a plan-level question the caller answers with
     * {@link replacementCoverage} and the surface's new content; this predicate
     * stays a pure per-node classification.
     *
     * Same-invocation freshness is NOT a source-index concern: the engine excludes
     * its own just-created replacements through a round-local set before
     * consulting this index.
     */
    canCompactHistory(seq: SessionSeq, minReentryTurns: number, allowImmediateReentry?: boolean): boolean;
    /**
     * Durable replacement provenance of one surface node, or `undefined` when the
     * engine cannot attribute the replacement at all.
     */
    replacementCoverage(seq: SessionSeq): ReplacementCoverage | undefined;
}
/** Durable provenance of one replacement surface node. */
export interface ReplacementCoverage {
    readonly kind: SurfaceSourceKind;
    /**
     * The session seqs whose content this replacement now stands for. `null` when
     * the node is not a replacement (its own seq is its content), and an EMPTY
     * array when it is a replacement whose provenance was not recorded — unknown
     * provenance must never be read as "covers nothing".
     */
    readonly coveredSeqs: readonly SessionSeq[] | null;
}
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
export declare const REDUCTION_PROVENANCE_PRODUCER = "dsh-context-enhancement";
/** Schema version of {@link ReductionProvenance}. Any other value fails closed. */
export declare const REDUCTION_PROVENANCE_VERSION = 1;
/**
 * Which of this package's reduction paths produced one surface replacement.
 *
 * `tool-summary` is the semantic tool-group reduction (a model wrote the text),
 * `tool-pruned` is the deterministic model-free head/tail reduction. They share
 * one event vocabulary and one content shape, so this field — not the generated
 * text and not a separate audit document — is what a replay must trust.
 */
export type ReductionKind = 'tool-summary' | 'tool-pruned';
/**
 * The durable provenance of one tool-result reduction, written into the Session
 * log beside the replacement it describes.
 */
export interface ReductionProvenance {
    /** Fixed producer marker; a record without it is never trusted. */
    readonly producer: typeof REDUCTION_PROVENANCE_PRODUCER;
    /** Payload schema version. */
    readonly schemaVersion: typeof REDUCTION_PROVENANCE_VERSION;
    /** Reduction path that produced the replacement. */
    readonly kind: ReductionKind;
    /** The shadowed range this replacement stands for, in surface order. */
    readonly coveredSeqs: readonly SessionSeq[];
    /**
     * Every Session event the reduction was derived from: the whole tool group's
     * event range for a semantic summary, the single shadowed node for a prune.
     */
    readonly sourceEventSeqs: readonly SessionSeq[];
    /**
     * Durable tool-group identity of a semantic summary — the same fingerprint the
     * audit schedules the group's work under, so a recovery can correlate the two.
     * `null` for a model-free prune, which has no group.
     */
    readonly groupId: string | null;
    /**
     * Surface replace generation the producer observed immediately before this
     * replacement landed. A record claiming a generation ahead of the Session's
     * own counter cannot be trusted.
     */
    readonly generation: number;
    /** Digest binding every other field to the exact replacement content. */
    readonly digest: string;
}
/** The official shadow-price payload, exactly as `@deepseek-ai/dsh-compaction` declares it. */
export type ShadowPriceData = SessionEventMap['compaction/prune'];
/**
 * The official shadow-price payload plus this package's additive provenance.
 *
 * Every official field keeps its exact meaning and validation, so a consumer
 * that never mounted this package folds the event unchanged; the extra key is
 * simply not part of its view of the type.
 */
export type ShadowPriceDataWithProvenance = ShadowPriceData & {
    readonly provenance: ReductionProvenance;
};
/** Everything one reduction tells its durable record about itself. */
export interface ReductionProvenanceInput {
    readonly kind: ReductionKind;
    readonly coveredSeqs: readonly SessionSeq[];
    readonly sourceEventSeqs: readonly SessionSeq[];
    readonly groupId: string | null;
    readonly generation: number;
    /** Content of the replacement message the record describes. */
    readonly content: readonly ContentBlock[];
}
/** Canonical digest of one reduction record over its fields and its content. */
export declare function reductionDigest(input: ReductionProvenanceInput): string;
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
export declare function reductionProvenance(input: ReductionProvenanceInput): ReductionProvenance;
/**
 * Build the official shadow-price payload for one single-node reduction, with
 * this package's provenance attached.
 * @param shadowedSeq - the one shadowed surface node.
 * @param shadowedTokenCount - heuristic price of the shadowed content.
 * @param provenance - the validated-shape provenance record of this reduction.
 * @returns the payload to append as `compaction/prune`, immediately before the
 *   replacement.
 */
export declare function shadowPriceWithProvenance(shadowedSeq: SessionSeq, shadowedTokenCount: number, provenance: ReductionProvenance): ShadowPriceDataWithProvenance;
/** Reconstruct current source types entirely from persisted session provenance. */
export declare function buildSurfaceSourceIndex(session: Session, auditClaimedSummarySeqs?: Iterable<SessionSeq>): SurfaceSourceIndex;
//# sourceMappingURL=source-index.d.ts.map