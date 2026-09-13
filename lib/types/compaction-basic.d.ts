/**
 * `dsh-context-enhancement` — `./compaction-basic` subpath entry.
 *
 * A replacement for the official `@deepseek-ai/dsh-compaction-basic` backend
 * provider, delivered from this standalone root package. It does NOT
 * re-declare `ctx.compaction`: the default-exported class extends the official
 * rc1 {@link CompactionEngine} Service Definition consumed from the published
 * `@deepseek-ai/dsh-compaction` package, so the Loader recognizes it as the
 * `compaction` service provider. The official rc1 behavior and Config
 * vocabulary are preserved exactly; the Card5/6 region-aware migration delta
 * is folded in (see the internal module provenance headers). The optional
 * `ctx.toolResultPruner` pruning companion is this package's own
 * `./tool-result-pruner` service — compaction-basic and the pruner are mounted
 * in the same preset isolate realm and must not have two providers.
 *
 * Only the published rc1 exports of the official packages are imported; the
 * rc1 `src/*` subpaths are not a stable third-party API. The internal
 * implementation files under `src/internal/compaction/` are local MIT copies
 * (with provenance headers) of the official rc1 backend sources.
 *
 * @module dsh-context-enhancement/compaction-basic
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { ToolResultPruner } from './tool-result-pruner.ts';
import type { ForgetBatchBlockReason, PressureSpanBlockReason } from './internal/compaction/zones.ts';
import type { SurfaceSourceIndex } from './internal/compaction/source-index.ts';
import type { SummarizationInput, SummaryResult } from './internal/compaction/summarizer.ts';
import type { BasicCompactionConfig, ResolvedConfig } from './internal/compaction/types.ts';
export type { BasicCompactionConfig, CompactionPolicyConfig, ModelCompactPolicyConfig, ResolvedCompactSpec, ResolvedConfig, ResolvedRetention, ResolvedTargetPolicy, } from './internal/compaction/types.ts';
type PressureStopReason = ForgetBatchBlockReason | PressureSpanBlockReason | 'same-pass-tool-replacement' | 'reentry-deferred' | 'tool-stage-deferred' | 'no-progress' | 'pressure-exit' | 'low-yield' | 'batch-limit';
/**
 * Why a candidate span containing an already-condensed checkpoint is or is not
 * admissible. Every value is a verdict about ONE candidate plan derived from the
 * current surface; none of them suppresses a later plan.
 */
export type PressureReentryReason = 
/** The span carries original content, so no re-summarization is involved. */
'new-original-content'
/** A checkpoint inside the span has surface content newer than its own coverage. */
 | 'new-coverage'
/** Only already-covered checkpoints: folding them would re-summarize summaries. */
 | 'no-new-coverage'
/** The checkpoint is younger than the required completed turns. */
 | 'completed-turns-deferred'
/** Durable provenance is missing or third-party, so the span keeps the strict rule. */
 | 'unknown-provenance';
/** One paid semantic batch of a pressure pass. */
export interface PressureBatchRecord {
    /** 1-based batch number inside its invocation. */
    readonly batch: number;
    readonly spanStartIndex: number;
    readonly spanEndIndex: number;
    /** Route price of the selected span (`selectedTokens`). */
    readonly spanTokens: number;
    readonly beforeTokens: number;
    readonly afterTokens: number;
    /** `beforeTokens - afterTokens`; negative means the request grew. */
    readonly netReleaseTokens: number;
    /** `netReleaseTokens / spanTokens`, the ideal-plan definition. */
    readonly netReleaseRatio: number;
    /** Typed verdicts recorded for this batch (`low-yield` when it missed both floors). */
    readonly reasons: readonly PressureStopReason[];
}
/**
 * One pressure invocation's structured ledger: which spans were paid for, what
 * each released, and why the invocation ended. This is the durable-shape record
 * the batch requires; it is deliberately NOT persisted to a new storage schema,
 * so rolling back to an older build cannot make an old process misread it.
 */
export interface PressurePassLedger {
    readonly trigger: 'pressure';
    /** Surface generation when the invocation was admitted. */
    readonly generation: number;
    /** Measured total on entry (>= the trigger, otherwise the tier would not run). */
    readonly beforeTokens: number;
    /** Measured total when the invocation ended. */
    readonly afterTokens: number;
    readonly thresholdTokens: number;
    /** `floor(contextWindow * pressureExitRatio)`: the level the pass reclaims to. */
    readonly exitTokens: number;
    readonly batches: readonly PressureBatchRecord[];
    readonly batchesRun: number;
    /** Sum of every batch's release in this invocation. */
    readonly netReleaseTokens: number;
    /** True when the invocation ended at or below the exit target. */
    readonly exitReached: boolean;
    /** Why the invocation ended, or `null` while it is still running. */
    readonly terminalReason: PressureStopReason | null;
    /**
     * Every typed verdict recorded in this invocation, in order, deduplicated.
     *
     * `'pressure-exit'` and `'batch-limit'` describe the pass itself: the exit line
     * was reached, or the configured batch budget ran out while the request was
     * still above it. Neither one is a claim about a single batch's realised
     * release, so neither may be reported as `'low-yield'`.
     */
    readonly stopReasons: readonly PressureStopReason[];
    /** Stable task-state slot injection tokens reconciled in this ledger pass. */
    readonly injectionTokens?: number;
    /** True when the measurement baseline was a provider usage anchor. */
    readonly usageBaseline?: boolean;
}
/**
 * The pending-work probe's verdict for one surface span. `'actionable'` defers
 * the pass (`tool-stage-deferred`) because an actor will clear the debt;
 * `'inert'` logs a non-blocking reason and ALLOWS the history pass, because
 * pending-shaped content exists that no actor can ever act on.
 */
export type ToolStageDebt = 'none' | 'inert' | 'actionable';
/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing. Extends the
 * official rc1 {@link CompactionEngine}, preserving official behavior and
 * Config while adding the Card5/6 region-aware passes: retention-aware older
 * pruning, the recursive empty-benefit guard on the old-summary head, and the
 * overflow opt-out that re-compacts an isolated checkpoint as the last
 * deterministic reduction.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export declare class BasicCompactionEngine extends CompactionEngine {
    static inject: string[];
    static Config: z<BasicCompactionConfig>;
    /** Resolved and validated compaction configuration. */
    readonly config: ResolvedConfig;
    private readonly warnedPressureConfigTargets;
    private readonly overflowRetries;
    private readonly overflowAgents;
    /** Envelope-budget stop reasons already terminal for one surface generation. */
    private readonly pressureStops;
    /** The structured ledger of the latest pressure invocation per session. */
    private readonly pressureLedgers;
    /**
     * The verdict list of the pressure pass THIS engine is currently running, so
     * the one stop funnel records each verdict where it is reported instead of the
     * loop recording it again by hand. `undefined` between passes: a stop reached
     * outside a pass must not write into a finished ledger.
     */
    private activePressureStopReasons;
    private toolGroupAuditStore;
    private toolGroupAuditStorePromise;
    constructor(ctx: Context, config?: BasicCompactionConfig);
    /**
     * Register automatic between-step pressure and model-request overflow
     * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
     * overrides are honored at event time.
     */
    private _registerAutomaticCompaction;
    /**
     * Summarize the replayed conversation region through a direct one-shot
     * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
     * prompt, tools, and messages so the provider's KV cache is not invalidated.
     * Override this sole hook for a template or remote summarizer.
     * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
     * @param agent - supplies routed-model history, fallback model, and session id.
     * @param signal - optional cancellation forwarded to the adapter.
     * @returns safe text summary blocks and the exact auxiliary call envelope and output.
     */
    protected summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
    /**
     * Compact for replayed step-boundary pressure or one provider-confirmed context
     * overflow. Both triggers price the latest durable routed request envelope;
     * overflow bypasses the normal threshold and retained-tail policy so it can
     * force one useful balanced reduction. Pressure first prunes only the older
     * head outside the retained tail (region-aware), remeasures, and stops early
     * when the deterministic reduction cleared pressure.
     *
     * Once tool-stage debt that has aged into the forget zone is cleared, normal
     * (non-overflow) pressure runs a BOUNDED LOOP of semantic batches. The exit
     * target is a fixed release line — `floor(contextWindow * pressureExitRatio)`,
     * both trigger-independent and strictly below the trigger — not "just below the
     * threshold". Each iteration re-measures, re-partitions, re-derives both
     * envelope budgets, and re-plans from the fresh surface; the loop ends when the
     * request is AT or BELOW the exit target (`pressure-exit`), at
     * `maxPressureBatches` while still above it (`batch-limit`), at a typed veto, or
     * after a batch whose realised release missed BOTH net-release floors
     * (`low-yield`, which ends the paid pass immediately).
     *
     * The loop's termination test is the exit line and NOT the trigger. The exit
     * line sits strictly below the trigger by configuration, so a batch that only
     * dunks under 80% leaves the request above `pressureExitTokens`; ending the pass
     * there is precisely the E03 finding (6/6 passes exiting at 78%-79% with less
     * than one typical tool result of headroom, which made maintenance re-fire on
     * every call) and it silently reduced this loop to a single batch.
     *
     * The pass is NOT a whole-zone selection. `planPressureSpan` always starts at
     * the surface head, always ends strictly before `zones.recent.startIndex`, and
     * is always truncated at `Bcap`; a larger exit target narrows the answer to the
     * deficit-sized prefix and at worst falls back to the widest safe prefix under
     * the cap. E02 (`E02-压力回落`) dynamically falsified the whole-zone reading,
     * and E03 (`E03-压力抖动` O5) recorded `selectedStartIndex = 0` with a
     * deficit-sized span — both are the behaviour this comment describes.
     *
     * The retained ~20% recent tail is untouched and the tool zone keeps its
     * governance result. The loop never folds a replacement its OWN invocation
     * produced (round-local set), and it re-enters an earlier invocation's
     * checkpoint only when that checkpoint has genuine newer coverage; the verdict
     * is about one plan, never a session-wide ban on historical summaries. Tool
     * pairing, step boundaries, surface stability, and the shrink requirement live
     * inside `compactRegion`.
     *
     * The envelope-derived budget replaces the window-fraction limits: the
     * retained tail becomes the affordable surface grant (never below the
     * open/last-completed-turn floor), and the span becomes the largest safe prefix
     * whose auxiliary input still leaves the configured response reserve and safety
     * margin free (`planPressureSpan`). A selected span carries a safe boundary and
     * progress potential, not a deficit guarantee: the shrink assertion only bounds
     * a legal replacement between the checkpoint floor and one token under the
     * span, so one batch can reclaim as little as a single token. That is why the
     * loop re-measures after every replacement and why a pass that cannot lower
     * pressure at all is stopped with the typed, memoized `no-progress` verdict
     * instead of paying again for the same state.
     * @param agent - agent whose latest durable routed request is measured.
     * @param trigger - normal step-boundary pressure or context-overflow recovery.
     * @param signal - live turn cancellation signal forwarded to summarization.
     * @returns the latest summary compaction result, or `null` when no summary ran.
     */
    compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    /**
     * The structured ledger of the latest pressure invocation on one session, or
     * `undefined` when this engine has not run a pressure pass for it. The record
     * is in-memory only: it carries the shape the batch needs without introducing
     * a persistent schema an older build could misread.
     */
    pressureLedger(session: Session): PressurePassLedger | undefined;
    /**
     * Attribute token price of the active model-visible task-state slot node.
     * Resolves from the session surface and token measurement nodes.
     */
    visibleSlotTokens(session: Session, measurement: Pick<TokenMeasurement, 'nodes'>): number;
    /**
     * Inspect or reconcile the token ledger for one session under a given measurement.
     * Derives slot injection token attribution and baseline kind without requiring a full pressure loop run.
     */
    inspectLedger(session: Session, measurement: TokenMeasurement, contextWindow?: number): PressurePassLedger;
    /** Rebuild source types from Session provenance and durable served audits. */
    private sourceIndex;
    /** Rebuild the durable fingerprint used to classify one selected tool group. */
    private toolGroupFingerprint;
    /**
     * Judge the tool-stage debt of one surface span. `'actionable'` names work an
     * actor of THIS engine will actually perform on it: the deterministic pruner
     * reducing an over-threshold original, or `summarizeToolGroups` selecting and
     * re-attempting a group. `'inert'` names pending-SHAPED content no actor can
     * act on — an unresolvable span, or groups the audit already refuses — which
     * must allow the history pass instead of deferring it forever.
     */
    private hasPendingToolIntermediateWork;
    /**
     * Find the surface index of the earliest actionable tool-stage work within a
     * surface span, so pressure planning can back off before that exact debt.
     */
    internalFindFirstToolStageDebtIndex(session: Session, start: SessionSeq, end: SessionSeq, prune: ToolResultPruner | undefined, inputCapTokens: number | undefined, index: SurfaceSourceIndex): number | undefined;
    /**
     * The ONE selection option object the summarize actor and the pending-work
     * probe share: same surface span, eligibility classification, code-point
     * text metric, estimator, max-group cap, and envelope input cap. Divergence
     * between the two is what let the probe report pending work the actor could
     * never act on, vetoing every pressure pass with `tool-stage-deferred`.
     */
    private toolGroupSelectionOptions;
    /** Derive current zones from one fresh meter snapshot and the routed capacity. */
    private zones;
    /**
     * Derive the envelope-aware zone boundaries of one snapshot. `retainedTailTokens`
     * matches {@link envelopeBudget}'s affordable tail exactly (same floor, same
     * clamp), and the domination verdict is the pass's typed `envelope-dominated`
     * stop condition.
     */
    private envelopeZoneBudget;
    /**
     * Resolve the envelope budget of one snapshot. The instruction and the
     * minimum framed checkpoint are priced per call so the cap follows the
     * session's own estimator rather than a constant.
     */
    private envelopeBudget;
    /**
     * The effective per-group input cap: the configured group budget narrowed by
     * the envelope auxiliary input cap, so a group whose summarization call
     * could not fit the window is never selected, probed, or paid for.
     */
    private cappedMaxGroupTokens;
    /**
     * Whether a terminal envelope-budget stop still holds for the current
     * pressure/surface state. The memo reopens — and is dropped — when the
     * surface generation, the surface node count, or the measured pressure no
     * longer matches the state the verdict was derived from: newly appended
     * content or a moved pressure anchor can change the plan and the domination
     * verdicts, so the suppression must not outlive its own evidence.
     */
    private pressurePassTerminated;
    /**
     * Record one envelope-budget stop together with the pressure/surface state it
     * was derived from, log it the first time only for that state, and — when a
     * pressure pass of THIS engine is running — record it in that pass's ledger.
     * This is the ONE stop funnel: every in-loop typed verdict goes through it, so
     * a reason is never both logged by the funnel and pushed into the ledger by
     * the loop for the same state. The generation advances exactly when a
     * positional replacement lands, so within one unchanged state a repeated
     * reason cannot behave differently; when the node count or the measured
     * pressure moves instead, the stale verdict is replaced so the next pass
     * re-evaluates against the new state.
     */
    private stopEnvelopeBudgetPass;
    /**
     * Overflow is the only path allowed to relax normal zones. It first prunes
     * provenance-indexed original results, then progresses oldest-first through
     * forget, tool, and recent ranges. No custom SessionEventMap entry is needed:
     * each reduction uses the official compaction/prune or compaction transaction.
     */
    private recoverOverflow;
    private summarizeToolGroups;
    /**
     * Commit the durable `success` record for one already-landed tool-group
     * reduction.
     *
     * The replacement and its shadow price are in the Session log before this
     * runs, so this phase must never produce a terminal `failure`/`fallback`
     * record: such a record would misreport a reduction that really happened,
     * drop the durable `tool-summary` classification of its replacement seqs
     * (leaving only the weaker shadow-price identity), and suppress the group
     * fingerprint as if the work had been refused. One retry absorbs a transient
     * store error; if the commit still fails, the record stays `open`, so the
     * group remains recoverable and the landed reduction keeps its provenance.
     * @param store - durable audit store bound to this engine's session domain.
     * @param requestId - request id of the open record to finish.
     * @param patch - success evidence: raw model output, parsed summary, landed replacement seqs.
     */
    private commitToolGroupSuccess;
    /**
     * Compact one inclusive positional range from the agent-owned surface using
     * the effective token meter for all retention and shrink pricing.
     * @param start - inclusive first surface-node seq.
     * @param end - inclusive last surface-node seq.
     * @param agent - owner of the target session, used by the summarizer.
     * @param signal - optional summarization cancellation signal.
     * @returns the successful durable compaction result.
     */
    compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal): Promise<CompactionResult>;
    /**
     * Force one useful idle-session compaction below the pressure threshold, and
     * resolve only after its standalone marker pair is durably checkpointed. The
     * durable compaction lock is rechecked before range selection so a live
     * unmatched marker reports busy even when the only remaining head is an
     * isolated checkpoint the empty-benefit guard would otherwise decline.
     * @param agent - idle agent whose next-turn admission this call reserves.
     * @param signal - cancellation scoped to this compaction request.
     * @param sourceCommandId - initiating command identity for presentation correlation.
     * @returns the committed result, or `null` when no safe useful range exists.
     */
    compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    /** Bind the effective token meter and dynamically dispatched summarizer hook. */
    private regionDependencies;
}
export default BasicCompactionEngine;
//# sourceMappingURL=compaction-basic.d.ts.map