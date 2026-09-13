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

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { TokenMeasurement, TokenMeter, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling pruning service available to
// `ctx.get('toolResultPruner')` through THIS package's own Context merge. The
// official rc1 pruner package is intentionally not imported: its root declares
// the same `ctx.toolResultPruner` merge on the official class, and the preset
// isolate realm mounts exactly one pruner provider (this package's), so the
// two declarations must never coexist in one program.
import type { ToolResultPruner } from './tool-result-pruner.ts'
import { randomUUID } from 'node:crypto'
import { selectToolGroups } from './internal/compaction/tool-groups.ts'
import { estimateToolGroupAuxiliaryRequestTokens, summarizeToolGroup, ToolGroupSummaryFallbackError } from './internal/compaction/tool-group-summarizer.ts'
import type { ToolGroupSummaryCallResult } from './internal/compaction/tool-group-summarizer.ts'
import { replaceToolGroup } from './internal/compaction/tool-group-replacement.ts'
import type { ToolGroupReplacementResult } from './internal/compaction/tool-group-replacement.ts'
import { adoptToolGroupAudit, attemptSlotFor, AUDIT_DIAGNOSTIC, assertToolGroupCommitStable, contentDigest, finishToolGroupAudit, hasToolGroupAttemptBudget, TOOL_GROUP_AUDIT_MAX_ATTEMPTS, openToolGroupAudit, planAuditRecovery, recordToolGroupLanded, resumeToolGroupAudit, servedReplacementSeqs, sessionLandedReductions, shouldAttemptToolGroupSummary, toolGroupFingerprint } from './internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditRecord } from './internal/compaction/tool-group-audit.ts'
import { openToolGroupAuditStore } from './internal/compaction/tool-group-audit-store.ts'
import type { ToolGroupAuditStore } from './internal/compaction/tool-group-audit-store.ts'
import type { ToolGroup, ToolGroupSelectionOptions } from './internal/compaction/tool-groups.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './internal/compaction/config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './internal/compaction/region.ts'
import { partitionSurfaceZones, planForgetBatch, planPressureSpan, selectForgetBatch } from './internal/compaction/zones.ts'
import type { ForgetBatchBlockReason, PressureSpanBlockReason } from './internal/compaction/zones.ts'
import { resolveEnvelopeBudget, resolveEnvelopeZoneBudget, retainedTailFloorTokens } from './internal/compaction/envelope-budget.ts'
import type { EnvelopeBudget, EnvelopeZoneBudget } from './internal/compaction/envelope-budget.ts'
import { buildSurfaceSourceIndex } from './internal/compaction/source-index.ts'
import type { SurfaceSourceIndex } from './internal/compaction/source-index.ts'
import { isTaskStateSlotSource } from './internal/task-state/contract/index.ts'
import { compactionInstructionTokens, minimumCheckpointTokens, summarizeWithLlm } from './internal/compaction/summarizer.ts'
import type { SummarizationInput, SummaryResult } from './internal/compaction/summarizer.ts'

import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './internal/compaction/types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './internal/compaction/types.ts'

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

type PressureStopReason = ForgetBatchBlockReason
  | PressureSpanBlockReason
  | 'same-pass-tool-replacement'
  | 'reentry-deferred'
  | 'tool-stage-deferred'
  | 'no-progress'
  | 'pressure-exit'
  | 'low-yield'
  | 'batch-limit'

/**
 * Why a candidate span containing an already-condensed checkpoint is or is not
 * admissible. Every value is a verdict about ONE candidate plan derived from the
 * current surface; none of them suppresses a later plan.
 */
export type PressureReentryReason =
  /** The span carries original content, so no re-summarization is involved. */
  | 'new-original-content'
  /** A checkpoint inside the span has surface content newer than its own coverage. */
  | 'new-coverage'
  /** Only already-covered checkpoints: folding them would re-summarize summaries. */
  | 'no-new-coverage'
  /** The checkpoint is younger than the required completed turns. */
  | 'completed-turns-deferred'
  /** Durable provenance is missing or third-party, so the span keeps the strict rule. */
  | 'unknown-provenance'

/** One paid semantic batch of a pressure pass. */
export interface PressureBatchRecord {
  /** 1-based batch number inside its invocation. */
  readonly batch: number
  readonly spanStartIndex: number
  readonly spanEndIndex: number
  /** Route price of the selected span (`selectedTokens`). */
  readonly spanTokens: number
  readonly beforeTokens: number
  readonly afterTokens: number
  /** `beforeTokens - afterTokens`; negative means the request grew. */
  readonly netReleaseTokens: number
  /** `netReleaseTokens / spanTokens`, the ideal-plan definition. */
  readonly netReleaseRatio: number
  /** Typed verdicts recorded for this batch (`low-yield` when it missed both floors). */
  readonly reasons: readonly PressureStopReason[]
}

/**
 * One pressure invocation's structured ledger: which spans were paid for, what
 * each released, and why the invocation ended. This is the durable-shape record
 * the batch requires; it is deliberately NOT persisted to a new storage schema,
 * so rolling back to an older build cannot make an old process misread it.
 */
export interface PressurePassLedger {
  readonly trigger: 'pressure'
  /** Surface generation when the invocation was admitted. */
  readonly generation: number
  /** Measured total on entry (>= the trigger, otherwise the tier would not run). */
  readonly beforeTokens: number
  /** Measured total when the invocation ended. */
  readonly afterTokens: number
  readonly thresholdTokens: number
  /** `floor(contextWindow * pressureExitRatio)`: the level the pass reclaims to. */
  readonly exitTokens: number
  readonly batches: readonly PressureBatchRecord[]
  readonly batchesRun: number
  /** Sum of every batch's release in this invocation. */
  readonly netReleaseTokens: number
  /** True when the invocation ended at or below the exit target. */
  readonly exitReached: boolean
  /** Why the invocation ended, or `null` while it is still running. */
  readonly terminalReason: PressureStopReason | null
  /**
   * Every typed verdict recorded in this invocation, in order, deduplicated.
   *
   * `'pressure-exit'` and `'batch-limit'` describe the pass itself: the exit line
   * was reached, or the configured batch budget ran out while the request was
   * still above it. Neither one is a claim about a single batch's realised
   * release, so neither may be reported as `'low-yield'`.
   */
  readonly stopReasons: readonly PressureStopReason[]
  /** Stable task-state slot injection tokens reconciled in this ledger pass. */
  readonly injectionTokens?: number
  /** True when the measurement baseline was a provider usage anchor. */
  readonly usageBaseline?: boolean
}

/**
 * The pending-work probe's verdict for one surface span. `'actionable'` defers
 * the pass (`tool-stage-deferred`) because an actor will clear the debt;
 * `'inert'` logs a non-blocking reason and ALLOWS the history pass, because
 * pending-shaped content exists that no actor can ever act on.
 */
export type ToolStageDebt = 'none' | 'inert' | 'actionable'

/**
 * Envelope-budget stop reasons that must not repeat a paid semantic call while
 * nothing about the request changes: each stop verdict is only as fresh as the
 * surface and pressure state it was derived from. `low-yield` is deliberately
 * NOT terminal: it is a verdict about one batch's realised release, and a later
 * step with different content must be allowed to try again. `batch-limit` is not
 * terminal either: the batch budget of ONE invocation is not a property of the
 * surface, so the next above-threshold step must be free to re-plan.
 */
const TERMINAL_PRESSURE_REASONS: ReadonlySet<PressureStopReason> = new Set<PressureStopReason>([
  'envelope-dominated',
  'no-progress',
])

/**
 * Fallback ledger store for seam-based harnesses that borrow individual
 * prototype methods on a bare object literal: the per-instance field below is
 * absent there, and a diagnostic write must never turn a pressure pass into a
 * runtime error. A real engine always has its own store, so two engines can
 * never share one ledger.
 */
const fallbackPressureLedgers = new WeakMap<Session, PressurePassLedger>()

/** The engine's own ledger store, or the module fallback when it has none. */
function pressureLedgerStore(
  store: WeakMap<Session, PressurePassLedger> | undefined,
): WeakMap<Session, PressurePassLedger> {
  return store ?? fallbackPressureLedgers
}

/**
 * Per-engine audit bookkeeping the recovery state machine needs (B6.2).
 *
 * It is held in a module-level map keyed by the engine OBJECT rather than in
 * class fields, for the reason {@link reportStoppedReason} documents about
 * sibling methods: the specs here borrow single production methods onto bare
 * object literals (`prototype.compactIfNeeded.call(fake, …)`), so a borrowed
 * method may not depend on a field a constructor would have initialized — and
 * keying by the receiver keeps two engines in one process from sharing (and
 * silently suppressing) each other's state.
 */
interface AuditEngineState {
  /**
   * Identity of THIS engine instance, stamped on the audit rows it opens. An
   * `open` row whose `ownerId` differs (or is absent, on a row written before
   * B6.2) belongs to an attempt that is not this instance's: a restored
   * Session, or a concurrent writer this package cannot tell apart from one.
   */
  owner: string | undefined
  /** Sessions whose audit rows this instance has already judged. */
  readonly recovered: WeakSet<Session>
  /**
   * Attempts started for one fingerprint while the durable audit write failed
   * (`AUDIT_DIAGNOSTIC.auditWriteFailed`).
   *
   * This is a BOUND on model spend, never durable state and never a repair:
   * with the audit unable to record attempts, the Session provenance still owns
   * classification, but nothing durable counts the retries — so an in-memory
   * counter keeps one repeatedly failing group from paying for a model call on
   * every pass. A successful audit write for the same fingerprint clears it, so
   * the durable row governs as soon as one exists.
   */
  readonly unwritten: Map<string, number>
  /** Audit diagnostics already logged, so a repeated pass does not spam the log. */
  readonly logged: Set<string>
}

const auditEngineStates = new WeakMap<object, AuditEngineState>()

/** The audit bookkeeping of one engine, created on first use. */
function auditEngineState(engine: object): AuditEngineState {
  const existing = auditEngineStates.get(engine)
  if (existing !== undefined) return existing
  const created: AuditEngineState = { owner: undefined, recovered: new WeakSet(), unwritten: new Map(), logged: new Set() }
  auditEngineStates.set(engine, created)
  return created
}

/** Report one audit diagnostic through the engine's logging seam. */
function logAuditDiagnostic(engine: BasicCompactionEngine, message: string): void {
  const host = engine as unknown as AuditHost
  host.ctx?.logger?.warn(message)
}

/** Report one audit diagnostic once per key, so repeated passes stay quiet. */
function logAuditDiagnosticOnce(engine: BasicCompactionEngine, key: string, message: string): void {
  const state = auditEngineState(engine)
  if (state.logged.has(key)) return
  state.logged.add(key)
  logAuditDiagnostic(engine, message)
}

/** This engine instance's audit attempt identity, created on first use. */
function auditOwnerId(engine: BasicCompactionEngine): string {
  const state = auditEngineState(engine)
  return state.owner ??= randomUUID()
}

/**
 * The engine surface the audit state machine reads, read structurally.
 *
 * A borrowed method may run on a bare object literal, so a missing store skips
 * the work and a missing logger degrades a report — never the run.
 */
interface AuditHost {
  readonly toolGroupAuditStore?: ToolGroupAuditStore
  readonly ctx?: { readonly logger?: { warn(message: string): void } }
}

/**
 * Judge every `open`/`aborted` audit row of one session against the Session
 * log's own landing evidence and persist the verdict (B6.2).
 *
 * The audit is a diagnostic and a work schedule; the Session log is the type
 * authority. Recovery therefore REPAIRS the schedule on evidence and never
 * promotes a type: `repaired` is written only when the validated provenance of
 * the current surface already proves a `tool-summary` of this exact group
 * identity landed, and an `open` row nobody owns becomes `aborted` —
 * repairable, and never read as committed. A rejected write (for instance
 * `missing-key`, the durable symptom of a whole-document last-write-wins
 * overwrite removing the row) is reported with its diagnostic and changes
 * nothing about classification.
 * @param engine - engine whose audit store and identity are used.
 * @param session - session whose audit rows are judged.
 */
async function recoverToolGroupAudits(engine: BasicCompactionEngine, session: Session): Promise<void> {
  const host = engine as unknown as AuditHost
  const store = host.toolGroupAuditStore
  if (store === undefined) return
  const done = auditEngineState(engine).recovered
  if (done.has(session)) return
  const records = store.recordsForSession(session.id, session.header.createdAt)
  const steps = planAuditRecovery(records, buildSurfaceSourceIndex(session), auditOwnerId(engine))
  for (const step of steps) {
    try {
      await store.finish(step.requestId, step.apply)
      logAuditDiagnostic(engine, `tool-group audit ${step.status}: ${step.diagnostic} (${step.requestId})`)
    } catch (error: unknown) {
      const missing = (error as { code?: unknown }).code === 'missing-key'
      logAuditDiagnostic(
        engine,
        `tool-group audit recovery write failed (${step.diagnostic})`
        + `${missing ? `; the row is gone (${AUDIT_DIAGNOSTIC.auditRecordMissing})` : ''}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  done.add(session)
}

/**
 * Whether one durable tool group still owes semantic summarization work, as the
 * scheduler must judge it.
 *
 * The Session log decides first: a group whose reduction its own validated
 * provenance proves landed owes nothing, whether the audit row is present,
 * stale, still `open` after a failed commit, or gone with the whole document
 * (R-P2-3). Only then do the rows decide, under the durable attempt budget —
 * and an attempt started while the audit could not record it is counted in
 * memory, so a store that keeps failing cannot pay for a model call on every
 * pass.
 * @param engine - engine carrying the degraded-attempt ledger.
 * @param index - classifier of the CURRENT surface, the evidence source.
 * @param records - audit rows of the session's lifecycle.
 * @param fingerprint - durable tool-group identity.
 * @returns whether an attempt is still owed.
 */
function mayAttemptToolGroupSummary(
  engine: BasicCompactionEngine,
  index: SurfaceSourceIndex,
  records: readonly ToolGroupAuditRecord[],
  fingerprint: string,
): boolean {
  const landed = sessionLandedReductions(index, fingerprint)
  if (landed.length > 0) {
    // A group whose reduction the durable Session provenance proves landed owes
    // no work, whatever the writable document says. Under the current selection
    // rules such a group is normally not even selectable (its results are no
    // longer originals), so this is a fence against a selection change making
    // `shouldAttemptToolGroupSummary`'s evidence rule the only thing standing
    // between a landed reduction and a duplicate model call.
    return false
  }
  const unwritten = auditEngineState(engine).unwritten.get(fingerprint) ?? 0
  if (unwritten >= TOOL_GROUP_AUDIT_MAX_ATTEMPTS) {
    logAuditDiagnosticOnce(
      engine,
      `unwritten:${fingerprint}`,
      `tool-group summary attempts exhausted while the audit could not record them (${AUDIT_DIAGNOSTIC.attemptsExhausted})`,
    )
    return false
  }
  if (!hasToolGroupAttemptBudget(records, fingerprint)) {
    logAuditDiagnosticOnce(
      engine,
      `budget:${fingerprint}`,
      `tool-group summary attempts exhausted (${AUDIT_DIAGNOSTIC.attemptsExhausted})`,
    )
    return false
  }
  return shouldAttemptToolGroupSummary(records, fingerprint, { landed })
}

/**
 * Report every Session-proven `tool-summary` whose group the audit has no row
 * for.
 *
 * This is the observable symptom of an audit document that was deleted,
 * truncated, or replaced by another writer's whole-document write
 * (`layout: 'single'`, last write wins — the E10/B1 gap this package cannot fix
 * without an upstream revision/compare-and-swap API). It is reported, never
 * acted on: classification comes from the Session log, so an audit row that is
 * missing changes no kind and no schedule — but an operator can see that the
 * diagnostic document no longer agrees with the log, instead of the loss being
 * silent.
 * @param engine - engine whose logging seam receives the report.
 * @param index - classifier of the current surface.
 * @param records - audit rows of this session's lifecycle.
 */
function reportUnrecordedAuditLandings(
  engine: BasicCompactionEngine,
  index: SurfaceSourceIndex,
  records: readonly ToolGroupAuditRecord[],
): void {
  const missing = new Set<string>()
  for (const [, entry] of index.entries) {
    const reduction = entry.reduction
    if (reduction === null || reduction.kind !== 'tool-summary') continue
    const groupId = reduction.groupId
    if (groupId === null || groupId === undefined) continue
    if (records.some(record => record.fingerprint === groupId)) continue
    missing.add(groupId)
  }
  for (const groupId of missing) {
    logAuditDiagnosticOnce(
      engine,
      `unrecorded:${groupId}`,
      `tool-group audit has no row for a reduction the Session log proves landed (${AUDIT_DIAGNOSTIC.auditLandingUnrecorded})`,
    )
  }
}

/**
 * Attribute token price of the active model-visible task-state slot node.
 * Resolves from the session surface and token measurement nodes.
 */
function visibleSlotTokens(session: Session, measurement: Pick<TokenMeasurement, 'nodes'>): number {
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type === 'user/message' && isTaskStateSlotSource(event.data?.source)) {
      const node = measurement.nodes.find((n: TokenSurfaceNode) => n.seq === seq)
      return node?.tokens ?? event.data.source.injectionTokens ?? 0
    }
  }
  return 0
}

/**
 * Report one above-threshold pressure stop to the engine's own logging seam when
 * it has one, and to the warning line otherwise.
 *
 * The seam is dispatched THROUGH the receiver rather than through the class
 * prototype, so a harness that overlays `logPressureStop` on a bare object
 * literal observes every reason the pressure pass reports — the seam harnesses in
 * this package's specs borrow individual prototype methods and would otherwise
 * bypass their own recorder. A harness that borrows the stop funnel without
 * supplying the seam still degrades to a warning line instead of a runtime error,
 * and the engine's private method stays private: the receiver is typed
 * structurally, so no `this as {…}` cast and no `any` is involved.
 */
function reportStoppedReason(
  engine: BasicCompactionEngine,
  logger: { warn(message: string): void },
  reason: PressureStopReason,
  totalTokens: number,
  thresholdTokens: number,
): void {
  if (totalTokens < thresholdTokens) return
  const sink = engine as unknown as {
    logPressureStop?: (r: PressureStopReason, t: number, th: number) => void
  }
  if (typeof sink.logPressureStop === 'function') {
    sink.logPressureStop(reason, totalTokens, thresholdTokens)
    return
  }
  logger.warn(`three-zone pressure stopped: ${reason} (${totalTokens} >= ${thresholdTokens})`)
}

/**
 * Why a candidate span containing an already-condensed checkpoint may or may
 * not be folded: a verdict about ONE plan over the CURRENT surface, never a
 * session-wide suppression.
 *
 * `'new-coverage'` means the span reaches surface content the last pressure
 * replacement does not stand for — its shadowed seqs are still addressable as
 * positions on the current surface at or beyond the checkpoint's own position.
 * `'no-new-coverage'` means the checkpoint already covers everything the span
 * would shadow, so another summary over it would release nothing and only pay
 * again; a later surface that grows new content past the checkpoint flips the
 * same verdict without any stored ban.
 *
 * The verdict reads no instance state, so it is a module function: the
 * compaction specs run the real planner through seam objects that borrow
 * individual prototype methods, and a method call there would leave
 * `this.pressureReentryVerdict` undefined and turn a plan verdict into a
 * runtime error.
 * @param session - session supplying the current surface order.
 * @param sources - source classification of that same surface.
 * @param blockerSeq - the checkpoint inside the candidate span.
 * @returns the plan's reentry verdict.
 */
function pressureReentryVerdict(
  session: Session,
  sources: SurfaceSourceIndex,
  blockerSeq: SessionSeq,
): PressureReentryReason {
  const blockerEntry = sources.entry(blockerSeq)
  if (blockerEntry.kind === 'original') return 'new-original-content'
  if (blockerEntry.kind === 'unknown-replacement') return 'unknown-provenance'
  if (blockerEntry.completedTurnsAfter > 0) return 'completed-turns-deferred'
  // Only a history checkpoint can cover a whole head; a tool summary or a
  // pruned result always stands for tool text that never reached the semantic
  // compact, so folding it is new work.
  if (blockerEntry.kind !== 'history-summary') return 'new-original-content'
  // A history checkpoint can only re-enter when the session has grown new content since it was produced.
  // When no surface node has a seq > blockerSeq, the surface is unchanged from when the checkpoint
  // was produced, so re-summarizing it would pay again without any new coverage.
  const hasNewerNodes = session.surface.nodes.some(seq => seq > blockerSeq)
  return hasNewerNodes ? 'new-coverage' : 'no-new-coverage'
}

/**
 * One terminal stop verdict together with the state it was derived from.
 * `generation` advances only when a positional replacement lands, so a memo
 * pinned to it alone would also suppress passes after plain appends — new
 * turns or messages that never touch a replacement — even though the plan and
 * domination verdicts recorded for the old state no longer describe the
 * session. `surfaceNodes` and `totalTokens` pin the appended and re-priced
 * sides, and any mismatch reopens the verdict.
 */
interface PressureStopMemo {
  readonly generation: number
  readonly surfaceNodes: number
  readonly totalTokens: number
  readonly reasons: Set<PressureStopReason>
}

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const ratioSchema = z.number()
const positiveIntegerSchema = z.number().step(1).min(1)
const policyFields = {
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  recentRatio: ratioSchema,
  forgetBoundaryRatio: ratioSchema,
  toolMaintenanceRatio: ratioSchema,
  forgetMaintenanceRatio: ratioSchema,
  pressureRatio: ratioSchema,
  pressureExitRatio: ratioSchema,
  minNetReleaseTokens: z.number().step(1).min(0),
  // No schema bound: legality of the (0, 1] / [0, 1] distinction lives in
  // `resolveConfig`, and two sources of truth would mean two error surfaces for
  // the same bad value.
  minNetReleaseRatio: z.number(),
  targetBatchTokens: positiveIntegerSchema,
  maxBatchTokens: positiveIntegerSchema,
  maxMaintenanceBatches: z.number().step(1).min(0),
  maxPressureBatches: z.number().step(1).min(0),
  minReentryTurns: positiveIntegerSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  responseReserveTokens: z.number().step(1).min(0),
  safetyMarginTokens: z.number().step(1).min(0),
}
const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  ...policyFields,
})

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
export class BasicCompactionEngine extends CompactionEngine {
  // `storageDomain` is declared here because the tool-group summary audit
  // store opens its own durable domain. It is NOT provided inside the preset
  // isolate realm: like `llm`/`sessions`, the declared property resolves
  // through to the host plane's process-global domain facility, and without
  // this declaration `ctx.storageDomain` access throws
  // `cannot get property "storageDomain" without inject`.
  static inject = ['llm', 'tokenMeter', 'sessions', 'storageDomain']

  static Config: z<BasicCompactionConfig> = z.object({
    ...policyFields,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    toolGroupSummarizer: z.object({
      enabled: z.boolean(),
      minGroupResults: z.number().step(1).min(1),
      minGroupChars: z.number().step(1).min(1),
      minGroupTokens: z.number().step(1).min(1),
      maxGroupTokens: z.number().step(1).min(1),
      maxGroupsPerPass: z.number().step(1).min(1),
      maxSummaryTokens: z.number().step(1).min(1),
    }),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** Envelope-budget stop reasons already terminal for one surface generation. */
  private readonly pressureStops = new WeakMap<Session, PressureStopMemo>()
  /** The structured ledger of the latest pressure invocation per session. */
  private readonly pressureLedgers = new WeakMap<Session, PressurePassLedger>()
  /**
   * The verdict list of the pressure pass THIS engine is currently running, so
   * the one stop funnel records each verdict where it is reported instead of the
   * loop recording it again by hand. `undefined` between passes: a stop reached
   * outside a pass must not write into a finished ledger.
   */
  private activePressureStopReasons: PressureStopReason[] | undefined
  private toolGroupAuditStore: ToolGroupAuditStore | undefined
  private toolGroupAuditStorePromise: Promise<void> | undefined

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.toolGroupAuditStorePromise = openToolGroupAuditStore(ctx).then(store => {
      this.toolGroupAuditStore = store
    }).catch(error => {
      this.toolGroupAuditStorePromise = undefined
      ctx.logger.warn(`tool-group summarization audit disabled: ${error instanceof Error ? error.message : String(error)}`)
    })
    ctx.effect(() => async () => {
      await this.toolGroupAuditStorePromise
      await this.toolGroupAuditStore?.close()
      this.toolGroupAuditStore = undefined
    }, 'tool-group-summary.audit-store')
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // The signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // The signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // The signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

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
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

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
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    if (trigger !== 'pressure' && trigger !== 'context-overflow') assertNever(trigger, 'compaction trigger')

    const prune = this.ctx.get('toolResultPruner')
    // Judge the audit rows left behind by an earlier process (or another
    // instance) BEFORE this pass schedules any tool work: an `open` row whose
    // owner is gone becomes a durable `aborted`/`repaired` verdict here, and a
    // row the Session log already proves served can never look like outstanding
    // work to the planners below (B6.2).
    await recoverToolGroupAudits(this, agent.session)
    if (trigger === 'context-overflow') {
      return this.recoverOverflow(agent, prune, signal)
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic three-zone compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(targetKey, `compaction-basic: no context capacity for ${targetKey}; configure contextWindow on that adapter model`)
    }
    const spec = resolveCompactSpec(policy, context.contextWindow)
    const toolWatermark = Math.floor(spec.contextWindow * policy.toolMaintenanceRatio)
    const forgetWatermark = Math.floor(spec.contextWindow * policy.forgetMaintenanceRatio)
    if (measurement.totalTokens < toolWatermark) return null

    // Every operation measures again and derives fresh positional boundaries.
    // A round-local exclusion set prevents its tool replacements entering the
    // semantic forget pass even if the replacement shifts surface positions.
    const roundReplacements = new Set<SessionSeq>()
    let zones = this.zones(agent.session, measurement, spec)
    await this.summarizeToolGroups(
      agent,
      target,
      policy,
      zones.tool,
      signal,
      roundReplacements,
      // Group calls obey the same envelope input cap as the semantic span
      // below: a dominating envelope must not buy an over-budget call here.
      this.envelopeBudget(agent.session, measurement, spec).summarizerInputCapTokens,
    )
    measurement = meter.measure(agent.session)
    zones = this.zones(agent.session, measurement, spec)
    if (prune !== undefined && zones.tool !== null) {
      const index = this.sourceIndex(agent.session)
      // Keep ordinary pruning inside the tool zone, but include original recent
      // results in the explicit provenance set so the pruner can still enforce
      // its opt-in hard limit without ever visiting summaries or forget-zone data.
      const candidates = agent.session.surface.nodes.slice(zones.tool.startIndex)
        .filter(seq => index.isOriginalToolResult(seq))
      const pruned = prune.pruneSession(agent.session, {
        olderRange: { start: zones.tool.startSeq, end: zones.tool.endSeq },
        candidateSeqs: candidates,
        // Exclude each landed replacement the moment it exists, so a prune pass
        // that throws after a partial landing still cannot have its own fresh
        // replacements folded by this invocation's semantic pass.
        onReplacement: entry => roundReplacements.add(entry.replacementSeq),
      })
      pruned.pruned.forEach(entry => roundReplacements.add(entry.replacementSeq))
      measurement = meter.measure(agent.session)
    }

    if (measurement.totalTokens < forgetWatermark) return null

    // Clear tool-stage debt that has aged into the forget zone. These
    // replacements remain excluded from semantic compaction for this pass, so
    // the intermediate representation gets at least one later request unless
    // a subsequent pressure pass deliberately re-enters it.
    zones = this.zones(agent.session, measurement, spec)
    if (zones.forget !== null) {
      await this.summarizeToolGroups(
        agent,
        target,
        policy,
        zones.forget,
        signal,
        roundReplacements,
        this.envelopeBudget(agent.session, measurement, spec).summarizerInputCapTokens,
      )
      measurement = meter.measure(agent.session)
      zones = this.zones(agent.session, measurement, spec)
      if (prune !== undefined && zones.forget !== null) {
        const index = this.sourceIndex(agent.session)
        const candidates = agent.session.surface.nodes
          .slice(zones.forget.startIndex, zones.forget.endIndex + 1)
          .filter(seq => index.isOriginalToolResult(seq))
        const pruned = prune.pruneSession(agent.session, {
          olderRange: { start: zones.forget.startSeq, end: zones.forget.endSeq },
          candidateSeqs: candidates,
          onReplacement: entry => roundReplacements.add(entry.replacementSeq),
        })
        pruned.pruned.forEach(entry => roundReplacements.add(entry.replacementSeq))
        measurement = meter.measure(agent.session)
      }
    }

    // Judge pressure on the surface AFTER the tool-stage governance above, so a
    // governed session that no longer reaches 80% stays in bounded maintenance.
    if (measurement.totalTokens < forgetWatermark) return null
    const pressure = measurement.totalTokens >= spec.thresholdTokens

    // Normal 70% maintenance tier (forgetWatermark <= total < pressureRatio).
    // Unchanged from the historical planner: one or more oldest bounded batches,
    // each capped by targetBatchTokens/maxBatchTokens, so ordinary growth is
    // kept below pressure without paying for one huge semantic call.
    if (!pressure) {
      let result: CompactionResult | null = null
      let batch = 0
      while (batch < policy.maxMaintenanceBatches) {
        // Do not reuse an old zone after a replacement. Re-price and re-derive
        // fresh positional boundaries before every bounded batch.
        measurement = meter.measure(agent.session)
        if (measurement.totalTokens < forgetWatermark) break
        const currentZones = this.zones(agent.session, measurement, spec)
        const budget = this.envelopeBudget(agent.session, measurement, spec)
        const plan = planForgetBatch(agent.session, measurement, currentZones, {
          // The envelope budget also caps a bounded batch by the auxiliary
          // input budget, so a dominating envelope cannot turn maintenance into
          // an over-budget summarization call.
          targetBatchTokens: Math.min(policy.targetBatchTokens, budget.summarizerInputCapTokens),
          maxBatchTokens: Math.min(policy.maxBatchTokens, budget.summarizerInputCapTokens),
        })
        if (plan.kind === 'blocked') break
        const selected = plan.range
        const selectedSeqs = agent.session.surface.nodes.slice(selected.startIndex, selected.endIndex + 1)
        const sources = this.sourceIndex(agent.session)
        if (selectedSeqs.some(seq => roundReplacements.has(seq))) break
        if (selectedSeqs.some(seq => !sources.canCompactHistory(seq, policy.minReentryTurns))) break
        const debt = this.hasPendingToolIntermediateWork(agent.session, selected.startSeq, selected.endSeq, prune, budget.summarizerInputCapTokens)
        if (debt === 'actionable') break
        if (debt === 'inert') {
          // Pending-shaped tool-stage content no actor can act on must not
          // stall bounded maintenance: the batch proceeds and the audit-refused
          // groups age into the history summary instead.
          this.ctx.logger.warn(`three-zone maintenance proceeding past inert tool-stage debt before batch ${batch + 1}`)
        }
        const beforeTokens = measurement.totalTokens
        result = await this.compactRegion(selected.startSeq, selected.endSeq, agent, signal)
        batch += 1
        measurement = meter.measure(agent.session)
        if (measurement.totalTokens >= beforeTokens) break
        if (measurement.totalTokens < spec.thresholdTokens) break
      }
      return result
    }

    // Pressure: a BOUNDED LOOP of deficit-sized semantic batches that reclaims
    // down to `pressureExitTokens`. The retained ~20% recent tail is untouched
    // and the tool zone keeps its governance result. The exit target is fixed by
    // configuration, not by the current deficit: E03 recorded 6/6 pressure
    // passes exiting at 78%-79% with 1 000-2 000 tokens of headroom, less than
    // one typical 4 000-token tool result, which is what made maintenance
    // re-fire on every single tool call.
    //
    // This is not a whole-zone selection. `planPressureSpan` starts at the
    // surface head, ends strictly before `zones.recent.startIndex`, and is
    // truncated at `Bcap`; the larger exit target simply asks for a wider
    // deficit-sized prefix and falls back to the widest safe prefix under the cap.
    // E02 dynamically falsified the whole-zone reading and E03 O5 recorded
    // `selectedStartIndex = 0` on a deficit-sized span, so both the trigger and
    // the comments here must describe that prefix planner, not an entire zone.
    //
    // `planPressureSpan` also covers the older head the envelope-clamped
    // partition carves out: pressure is priced on the whole request envelope, so
    // a large system prompt/tool catalog — or a provider usage anchor above the
    // heuristic price — can hold a session above the threshold while its surface
    // forget zone stays empty. The fallback keeps every guarantee above (surface
    // prefix, retained tail untouched, pairing/step-safe end, never above the
    // forget-boundary budget), so a high-pressure session with safe old
    // tool/history nodes still releases them instead of stopping with
    // `no-forget-range` on every step forever.
    //
    // Every iteration re-prices and re-partitions before planning: a replacement
    // invalidates both positional boundaries and both envelope budgets.
    if (this.pressurePassTerminated(agent.session, measurement.totalTokens)) return null

    const exitTokens = Math.min(spec.thresholdTokens, spec.pressureExitTokens)
    const minSpanTokens = minimumCheckpointTokens(this.ctx.tokenMeter)
    const injectionTokens = visibleSlotTokens(agent.session, measurement)
    const usageBaseline = measurement.baseline.kind === 'usage'
    // The mutable array behind the ledger's readonly `stopReasons`: the one stop
    // funnel appends to it, so a verdict is recorded where it is reported.
    const stopReasons: PressureStopReason[] = []
    const ledger: {
      trigger: 'pressure'
      generation: number
      beforeTokens: number
      afterTokens: number
      thresholdTokens: number
      exitTokens: number
      batches: PressureBatchRecord[]
      batchesRun: number
      netReleaseTokens: number
      exitReached: boolean
      terminalReason: PressureStopReason | null
      stopReasons: PressureStopReason[]
      injectionTokens?: number
      usageBaseline?: boolean
    } = {
      trigger: 'pressure',
      generation: agent.session.surface.replaceGeneration,
      beforeTokens: measurement.totalTokens,
      afterTokens: measurement.totalTokens,
      thresholdTokens: spec.thresholdTokens,
      exitTokens,
      batches: [],
      batchesRun: 0,
      netReleaseTokens: 0,
      exitReached: false,
      terminalReason: null,
      stopReasons,
      injectionTokens,
      usageBaseline,
    }
    pressureLedgerStore(this.pressureLedgers).set(agent.session, ledger)
    // The pass this invocation is currently writing, so the ONE stop funnel
    // (`stopEnvelopeBudgetPass`) records its verdicts instead of the loop
    // recording them a second time by hand.
    this.activePressureStopReasons = stopReasons
    const recordVerdict = (reason: PressureStopReason): void => {
      if (!stopReasons.includes(reason)) stopReasons.push(reason)
    }
    const finishLedger = (reason: PressureStopReason | null, exitReached: boolean): void => {
      ledger.afterTokens = measurement.totalTokens
      ledger.exitReached = exitReached
      ledger.terminalReason = reason
      if (reason !== null) recordVerdict(reason)
      this.activePressureStopReasons = undefined
    }

    let result: CompactionResult | null = null
    let batch = 0
    let maxEndIndex: number | undefined = undefined
    let activeVeto: PressureStopReason | null = null

    while (batch < policy.maxPressureBatches) {
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens <= exitTokens) {
        // The pass reached its release target. Logging it once per state is the
        // difference between "stopped because done" and "stopped because stuck".
        this.stopEnvelopeBudgetPass(agent.session, 'pressure-exit', measurement.totalTokens, spec.thresholdTokens)
        finishLedger('pressure-exit', true)
        return result
      }
      // The loop's termination test is the EXIT line, not the trigger. The exit
      // line sits strictly below the trigger by configuration, so a batch that
      // only dunks under 80% leaves the pass above `pressureExitTokens` and the
      // loop must keep releasing: E03 recorded 6/6 passes exiting at 78%-79%
      // with less than one typical tool result of headroom, which is what made
      // maintenance re-fire on every call. Stopping at the trigger here is what
      // silently reduced the whole bounded loop back to a single batch.
      if (this.pressurePassTerminated(agent.session, measurement.totalTokens)) {
        finishLedger(ledger.terminalReason ?? 'no-progress', false)
        return result
      }
      zones = this.zones(agent.session, measurement, spec)
      const budget = this.envelopeBudget(agent.session, measurement, spec)
      if (this.envelopeZoneBudget(agent.session, measurement, spec).envelopeDominated) {
        // `E + guaranteed tail` already reaches the trigger: the partition never
        // shadows that tail, so every span it can select leaves the request at or
        // above the threshold. Stop with the typed, memoized reason instead of
        // paying for a semantic call that cannot end the state.
        this.stopEnvelopeBudgetPass(agent.session, 'envelope-dominated', measurement.totalTokens, spec.thresholdTokens)
        finishLedger('envelope-dominated', false)
        return result
      }
      if (budget.summarizerInputCapTokens <= 0) {
        this.stopEnvelopeBudgetPass(agent.session, 'envelope-dominated', measurement.totalTokens, spec.thresholdTokens)
        finishLedger('envelope-dominated', false)
        return result
      }
      // The span is planned against the EXIT line, so a pass asks for the release
      // the configuration promises instead of just dunking under the trigger.
      // `planPressureSpan` still truncates at `Bcap` and refuses to cross the
      // retained tail, so a target the head cannot afford degrades to the widest
      // safe prefix rather than to a whole-zone selection.
      let minStartIndex = 0
      if (batch > 0) {
        while (minStartIndex < agent.session.surface.nodes.length
          && roundReplacements.has(agent.session.surface.nodes[minStartIndex]!)) {
          minStartIndex += 1
        }
      }
      const plan = planPressureSpan(agent.session, measurement, zones, {
        reclaimTokens: Math.max(0, measurement.totalTokens - exitTokens),
        inputCapTokens: budget.summarizerInputCapTokens,
        minSpanTokens,
        maxEndIndex,
        minStartIndex,
      })
      if (plan.kind === 'blocked') {
        // Every in-loop stop goes through the ONE funnel, which logs the reason
        // once for the current pressure/surface state and records it in the
        // ledger. Routed separately it would be reported twice for the same
        // state — once by the funnel and once by the loop — and a memoized
        // verdict (`envelope-dominated`) must keep reaching that funnel or the
        // state it was derived from is never remembered.
        //
        // When a candidate was vetoed and the loop narrowed its endpoint at
        // least once, yet the narrowed geometry still admits NO prefix, this is
        // the ONE invocation whose plan verdict is the pass-level answer, so the
        // VETO reason — not the inner `no-safe-prefix`/`span-below-minimum` the
        // narrowing produced — is what the pass reports. A narrowing that DOES
        // pay for a later span never lands here: the payment resets
        // `activeVeto`, so a pass that made progress cannot be reported as a
        // veto stop, and a `low-yield`/`no-progress` batch keeps its own typed
        // verdict. A plan-level veto with no paid call is reported and never
        // memoized as terminal: the same reason may not hold on a later surface,
        // so it must not become a session-wide ban on historical summaries.
        const reason = activeVeto ?? plan.reason
        this.stopEnvelopeBudgetPass(agent.session, reason, measurement.totalTokens, spec.thresholdTokens)
        finishLedger(reason, false)
        return result
      }

      const sources = this.sourceIndex(agent.session)
      const candidateSeqs = agent.session.surface.nodes.slice(plan.range.startIndex, plan.range.endIndex + 1)
      const samePassIdx = candidateSeqs.findIndex(seq => roundReplacements.has(seq))
      if (samePassIdx >= 0) {
        activeVeto = 'same-pass-tool-replacement'
        const blockerSurfaceIndex = plan.range.startIndex + samePassIdx
        if (blockerSurfaceIndex <= plan.range.startIndex) {
          this.stopEnvelopeBudgetPass(agent.session, activeVeto, measurement.totalTokens, spec.thresholdTokens)
          finishLedger(activeVeto, false)
          return result
        }
        maxEndIndex = blockerSurfaceIndex - 1
        continue
      }

      const reentryIdx = candidateSeqs.findIndex(seq => !sources.canCompactHistory(seq, policy.minReentryTurns, true))
      if (reentryIdx >= 0) {
        const blockingIndex = plan.range.startIndex + reentryIdx
        activeVeto = 'reentry-deferred'
        if (blockingIndex <= plan.range.startIndex) {
          this.stopEnvelopeBudgetPass(agent.session, activeVeto, measurement.totalTokens, spec.thresholdTokens)
          finishLedger(activeVeto, false)
          return result
        }
        maxEndIndex = blockingIndex - 1
        continue
      }

      const historySummaryIdx = candidateSeqs.findIndex(seq => {
        try {
          return sources.entry(seq).kind === 'history-summary'
        } catch {
          return false
        }
      })
      if (historySummaryIdx >= 0) {
        const blockerSeq = candidateSeqs[historySummaryIdx]!
        const blockingIndex = plan.range.startIndex + historySummaryIdx
        const reentry = pressureReentryVerdict(agent.session, sources, blockerSeq)
        const admitsNewCoverage = reentry === 'new-original-content' || reentry === 'new-coverage'
        if (!admitsNewCoverage) {
          activeVeto = 'reentry-deferred'
          this.ctx.logger.warn(`three-zone pressure reentry deferred: ${reentry}`)
          if (blockingIndex <= plan.range.startIndex) {
            this.stopEnvelopeBudgetPass(agent.session, activeVeto, measurement.totalTokens, spec.thresholdTokens)
            finishLedger(activeVeto, false)
            return result
          }
          maxEndIndex = blockingIndex - 1
          continue
        }
      }

      const debt = this.hasPendingToolIntermediateWork(agent.session, plan.range.startSeq, plan.range.endSeq, prune, budget.summarizerInputCapTokens)
      if (debt === 'actionable') {
        activeVeto = 'tool-stage-deferred'
        const toolDebtIdx = BasicCompactionEngine.prototype.internalFindFirstToolStageDebtIndex.call(
          this,
          agent.session,
          plan.range.startSeq,
          plan.range.endSeq,
          prune,
          budget.summarizerInputCapTokens,
          sources,
        )
        const blockerSurfaceIndex = toolDebtIdx ?? plan.range.endIndex
        if (blockerSurfaceIndex <= plan.range.startIndex) {
          this.stopEnvelopeBudgetPass(agent.session, activeVeto, measurement.totalTokens, spec.thresholdTokens)
          finishLedger(activeVeto, false)
          return result
        }
        maxEndIndex = blockerSurfaceIndex - 1
        continue
      }

      if (debt === 'inert') {
        // A candidate can be pending-shaped yet actionable by NO actor: the span
        // resolves to nothing, or every selectable group is already refused by
        // the audit (terminal failure/fallback records). Deferring on such debt
        // vetoed every pressure pass forever, so history pressure compaction is
        // allowed and the non-blocking reason is reported instead.
        this.ctx.logger.warn(`three-zone pressure proceeding past inert tool-stage debt (${measurement.totalTokens} >= ${spec.thresholdTokens})`)
      }

      activeVeto = null
      const span = plan.range
      const beforeTokens = measurement.totalTokens
      result = await this.compactRegion(span.startSeq, span.endSeq, agent, signal)
      if (result !== null) {
        roundReplacements.add(result.summarySeq)
        roundReplacements.add(result.startSeq)
      }
      batch += 1
      ledger.batchesRun = batch
      maxEndIndex = undefined
      // Re-measure after the replacement. The strict-shrink assertion only
      // bounds the replacement between the checkpoint floor and one token under
      // the span, so even a deficit-sized span can reclaim as little as one
      // token. Every later batch re-plans from this fresh surface.
      measurement = meter.measure(agent.session)
      const netReleaseTokens = beforeTokens - measurement.totalTokens
      // The ideal-plan ratio is measured against the span the batch PAID for, not
      // against the whole request: a batch that shadows 7 000 tokens and releases
      // 700 of them has not paid off, however small the request-level number is.
      const netReleaseRatio = span.tokens === 0 ? 0 : netReleaseTokens / span.tokens
      const batchReasons: PressureStopReason[] = []
      if (measurement.totalTokens >= beforeTokens) {
        // A pass that did not lower the total at all is stopped with the typed,
        // memoized `no-progress` verdict instead of paying again for this state.
        this.stopEnvelopeBudgetPass(agent.session, 'no-progress', measurement.totalTokens, spec.thresholdTokens)
        batchReasons.push('no-progress')
      } else if (netReleaseTokens < policy.minNetReleaseTokens
        && netReleaseRatio < policy.minNetReleaseRatio) {
        // Both floors missed. The batch is already durable — the reduction cannot
        // be un-committed — so the honest accounting is to record `low-yield` and
        // stop rather than to pretend it never happened.
        batchReasons.push('low-yield')
      }
      ledger.batches.push({
        batch,
        spanStartIndex: span.startIndex,
        spanEndIndex: span.endIndex,
        spanTokens: span.tokens,
        beforeTokens,
        afterTokens: measurement.totalTokens,
        netReleaseTokens,
        netReleaseRatio,
        reasons: batchReasons,
      })
      ledger.netReleaseTokens += netReleaseTokens
      for (const reason of batchReasons) recordVerdict(reason)
      if (batchReasons.includes('no-progress')) {
        // `stopEnvelopeBudgetPass` above already logged this reason once for this
        // pressure/surface state; logging it again here would double-report the
        // same verdict.
        finishLedger('no-progress', false)
        return result
      }
      if (batchReasons.includes('low-yield')) {
        // One low-yield batch ends the paid pass. The batch is already durable —
        // the reduction cannot be un-committed — so the honest accounting is to
        // record `low-yield` and stop paying, instead of re-planning for another
        // call in the same pressure state. It is deliberately NOT memoized as
        // terminal: it describes ONE batch's realised release, so a later step
        // with different content stays free to try again.
        this.stopEnvelopeBudgetPass(agent.session, 'low-yield', measurement.totalTokens, spec.thresholdTokens)
        finishLedger('low-yield', false)
        return result
      }
    }
    // The batch guard ended the loop, not success: the next above-threshold step
    // re-plans from this surface. The typed verdict says which of the two
    // happened — the exit line was reached, or the configured batch budget ran
    // out while the request was still above it — so a batch-limit stop is never
    // reported as a low-yield batch (the floors are about ONE batch's realised
    // release, not about the pass running out of batches).
    if (measurement.totalTokens <= exitTokens) {
      finishLedger('pressure-exit', true)
      return result
    }
    this.ctx.logger.warn(`three-zone pressure ended after ${batch} batch(es) at ${measurement.totalTokens} > exit ${exitTokens}`)
    // The typed verdict is what the caller gets back; the batch budget simply
    // ran out above the exit line, so this is not one of the `logPressureStop`
    // "stopped because it could not continue" reasons and it must not be
    // reported as a low-yield batch either (the floors describe ONE batch's
    // realised release, not the pass exhausting its batch budget).
    finishLedger('batch-limit', false)
    return result
  }

  /**
   * The structured ledger of the latest pressure invocation on one session, or
   * `undefined` when this engine has not run a pressure pass for it. The record
   * is in-memory only: it carries the shape the batch needs without introducing
   * a persistent schema an older build could misread.
   */
  pressureLedger(session: Session): PressurePassLedger | undefined {
    return pressureLedgerStore(this.pressureLedgers).get(session)
  }

  /**
   * Attribute token price of the active model-visible task-state slot node.
   * Resolves from the session surface and token measurement nodes.
   */
  visibleSlotTokens(session: Session, measurement: Pick<TokenMeasurement, 'nodes'>): number {
    return visibleSlotTokens(session, measurement)
  }

  /**
   * Inspect or reconcile the token ledger for one session under a given measurement.
   * Derives slot injection token attribution and baseline kind without requiring a full pressure loop run.
   */
  inspectLedger(session: Session, measurement: TokenMeasurement, contextWindow = 128_000): PressurePassLedger {
    const policy = resolveTargetPolicy(this.config, { provider: 'default', model: 'default' })
    const spec = resolveCompactSpec(policy, contextWindow)
    const injectionTokens = visibleSlotTokens(session, measurement)
    const usageBaseline = measurement.baseline.kind === 'usage'
    const exitTokens = Math.min(spec.thresholdTokens, spec.pressureExitTokens)
    return {
      trigger: 'pressure',
      generation: session.surface.replaceGeneration,
      beforeTokens: measurement.totalTokens,
      afterTokens: measurement.totalTokens,
      thresholdTokens: spec.thresholdTokens,
      exitTokens,
      batches: [],
      batchesRun: 0,
      netReleaseTokens: 0,
      exitReached: measurement.totalTokens <= exitTokens,
      terminalReason: null,
      stopReasons: [],
      injectionTokens,
      usageBaseline,
    }
  }

  /** Rebuild source types from Session provenance and durable served audits. */
  private sourceIndex(session: Session) {
    const store = this.toolGroupAuditStore
    // `servedReplacementSeqs` includes an audit left `open` after its
    // replacements landed: the success commit can fail after the durable
    // rewrite, and that reduction still owns tool-summary provenance.
    const records = store === undefined ? [] : store.recordsForSession(session.id, session.header.createdAt)
    const index = buildSurfaceSourceIndex(session, servedReplacementSeqs(records))
    reportUnrecordedAuditLandings(this, index, records)
    return index
  }

  /** Rebuild the durable fingerprint used to classify one selected tool group. */
  private toolGroupFingerprint(session: Session, group: ToolGroup): string {
    const events = group.sourceSeqs.map(seq => session.eventAt(seq))
    return toolGroupFingerprint({
      lifecycle: { sessionId: session.id, createdAt: session.header.createdAt },
      sourceSeqs: group.sourceSeqs,
      callIds: group.callIds,
      eventTypes: events.map(event => event?.type ?? 'missing'),
      contentDigest: contentDigest(events.map(event => JSON.stringify(event))),
      schemaVersion: 1,
    })
  }

  /**
   * Judge the tool-stage debt of one surface span. `'actionable'` names work an
   * actor of THIS engine will actually perform on it: the deterministic pruner
   * reducing an over-threshold original, or `summarizeToolGroups` selecting and
   * re-attempting a group. `'inert'` names pending-SHAPED content no actor can
   * act on — an unresolvable span, or groups the audit already refuses — which
   * must allow the history pass instead of deferring it forever.
   */
  private hasPendingToolIntermediateWork(
    session: Session,
    start: SessionSeq,
    end: SessionSeq,
    prune: ToolResultPruner | undefined,
    inputCapTokens?: number,
  ): ToolStageDebt {
    const nodes = session.surface.nodes
    const startIndex = nodes.indexOf(start)
    const endIndex = nodes.indexOf(end)
    // A span that names no current surface content cannot hold inspectable
    // work: reporting pending here vetoed passes with zero candidates.
    if (startIndex < 0 || endIndex < startIndex) return 'inert'
    const index = this.sourceIndex(session)
    const selected = nodes.slice(startIndex, endIndex + 1)
    // Deterministic pruning debt: the same source classification the prune pass
    // applies, and the SAME metric over every text block of the message that
    // the pruner measures and reduces with.
    if (prune !== undefined && selected.some(seq => {
      const event = session.eventAt(seq)
      if (event?.type !== 'tool/result' || !index.isOriginalToolResult(seq)) return false
      // An empty content array carries nothing the pruner could measure or
      // reduce; treating it as owed work would defer a pass over nothing.
      const messageContent: readonly ContentBlock[] = event.data.message.content
      if (messageContent.length === 0) return false
      return prune.measureMessageText(messageContent) > prune.config.thresholdChars
    })) return 'actionable'
    // Disabled or unavailable semantic summarization owes no group work. Large
    // originals remain guarded above because the deterministic pruner can still
    // process them.
    if (!this.config.toolGroupSummarizer.enabled || this.toolGroupAuditStore === undefined) return 'none'
    // A qualifying group is outstanding semantic tool work, even when not
    // individually large enough for deterministic pruning. The selection is the
    // ACTOR's own — the exact option object `summarizeToolGroups` builds, same
    // surface span, eligibility classification, text metric, max-group cap, and
    // envelope input cap — so pending work here can never be work the actor
    // would skip.
    const records = this.toolGroupAuditStore.recordsForSession(session.id, session.header.createdAt)
    const groups = selectToolGroups(session, this.toolGroupSelectionOptions({ start, end }, inputCapTokens, index, session))
    const actionable = groups.some(group => group.toolResultSeqs.every(seq => index.isOriginalToolResult(seq))
      && mayAttemptToolGroupSummary(this, index, records, this.toolGroupFingerprint(session, group)))
    // Groups that qualify on shape but that the audit already refuses (terminal
    // failure/fallback records) are pending-shaped but not actionable: no actor
    // will ever summarize them, so deferring on them is a deadlock.
    if (groups.length > 0 && !actionable) return 'inert'
    return actionable ? 'actionable' : 'none'
  }

  /**
   * Find the surface index of the earliest actionable tool-stage work within a
   * surface span, so pressure planning can back off before that exact debt.
   */
  internalFindFirstToolStageDebtIndex(
    session: Session,
    start: SessionSeq,
    end: SessionSeq,
    prune: ToolResultPruner | undefined,
    inputCapTokens: number | undefined,
    index: SurfaceSourceIndex,
  ): number | undefined {
    const nodes = session.surface.nodes
    const startIndex = nodes.indexOf(start)
    const endIndex = nodes.indexOf(end)
    if (startIndex < 0 || endIndex < startIndex) return undefined
    const selected = nodes.slice(startIndex, endIndex + 1)
    if (prune !== undefined) {
      const pruneDebtOffset = selected.findIndex(seq => {
        const event = session.eventAt(seq)
        if (event?.type !== 'tool/result' || !index.isOriginalToolResult(seq)) return false
        const messageContent: readonly ContentBlock[] = event.data.message.content
        if (messageContent.length === 0) return false
        return prune.measureMessageText(messageContent) > prune.config.thresholdChars
      })
      if (pruneDebtOffset >= 0) return startIndex + pruneDebtOffset
    }
    if (!this.config?.toolGroupSummarizer?.enabled || this.toolGroupAuditStore === undefined) return undefined
    const records = this.toolGroupAuditStore.recordsForSession(session.id, session.header.createdAt)
    const groups = selectToolGroups(session, this.toolGroupSelectionOptions({ start, end }, inputCapTokens, index, session))
    for (const group of groups) {
      if (group.toolResultSeqs.every(seq => index.isOriginalToolResult(seq))
        && mayAttemptToolGroupSummary(this, index, records, this.toolGroupFingerprint(session, group))) {
        const firstSeq = group.sourceSeqs[0] ?? group.startSeq
        const idx = nodes.indexOf(firstSeq)
        if (idx >= 0) return idx
      }
    }
    return undefined
  }

  /**
   * The ONE selection option object the summarize actor and the pending-work
   * probe share: same surface span, eligibility classification, code-point
   * text metric, estimator, max-group cap, and envelope input cap. Divergence
   * between the two is what let the probe report pending work the actor could
   * never act on, vetoing every pressure pass with `tool-stage-deferred`.
   */
  private toolGroupSelectionOptions(
    olderRange: { start: SessionSeq; end: SessionSeq },
    inputCapTokens: number | undefined,
    index: ReturnType<typeof buildSurfaceSourceIndex>,
    session?: Session,
  ): ToolGroupSelectionOptions {
    const config = this.config.toolGroupSummarizer
    return {
      olderRange: { start: olderRange.start, end: olderRange.end },
      minGroupResults: config.minGroupResults,
      minGroupChars: config.minGroupChars,
      minGroupTokens: config.minGroupTokens,
      // The envelope input cap narrows the group budget: a group whose
      // summarization call could exceed the window is never paid for, and the
      // probe must agree that such a group is not outstanding work.
      maxGroupTokens: this.cappedMaxGroupTokens(config.maxGroupTokens, inputCapTokens),
      maxGroups: config.maxGroupsPerPass,
      estimateTokens: event => event.type === 'tool/result' || event.type === 'assistant/message'
        ? this.ctx.tokenMeter.estimateMessage(event.data.message)
        : 0,
      isEligibleResult: seq => index.isOriginalToolResult(seq),
      isGroupFittable: inputCapTokens === undefined || session === undefined
        ? undefined
        : group => estimateToolGroupAuxiliaryRequestTokens(
          session,
          group,
          config.maxSummaryTokens,
          msg => this.ctx.tokenMeter.estimateMessage(msg),
        ) <= inputCapTokens,
    }
  }

  /** Derive current zones from one fresh meter snapshot and the routed capacity. */
  private zones(session: Session, measurement: ReturnType<TokenMeter['measure']>, spec: ReturnType<typeof resolveCompactSpec>) {
    // Both boundaries are absolute token budgets derived from the request
    // envelope, so they reach the partition without a ratio round-trip (which
    // can move a boundary by one token and split a step).
    // Clamping the forget boundary to the affordable surface grant is what
    // removes the dead zone: when a dominating envelope prices the request
    // above the trigger while the surface cannot reach the window fraction, the
    // head outside the affordable tail IS the forget zone.
    const zoneBudget = this.envelopeZoneBudget(session, measurement, spec)
    return partitionSurfaceZones(session, measurement, {
      recentRatio: spec.retainTokens / spec.contextWindow,
      forgetBoundaryRatio: spec.forgetBoundaryRatio,
      contextWindow: spec.contextWindow,
      recentBoundaryTokens: zoneBudget.retainedTailTokens,
      forgetBoundaryTokens: zoneBudget.forgetBoundaryTokens,
    })
  }

  /**
   * Derive the envelope-aware zone boundaries of one snapshot. `retainedTailTokens`
   * matches {@link envelopeBudget}'s affordable tail exactly (same floor, same
   * clamp), and the domination verdict is the pass's typed `envelope-dominated`
   * stop condition.
   */
  private envelopeZoneBudget(
    session: Session,
    measurement: ReturnType<TokenMeter['measure']>,
    spec: ReturnType<typeof resolveCompactSpec>,
  ): EnvelopeZoneBudget {
    const injectionTokens = visibleSlotTokens(session, measurement)
    return resolveEnvelopeZoneBudget(measurement, {
      pressureTokens: spec.thresholdTokens,
      forgetWatermarkTokens: Math.floor(spec.contextWindow * spec.forgetMaintenanceRatio),
      forgetBoundaryTokens: Math.floor(spec.contextWindow * spec.forgetBoundaryRatio),
      retainTokens: spec.retainTokens,
      minRetainTokens: retainedTailFloorTokens(session, measurement),
      injectionTokens,
    })
  }

  /**
   * Resolve the envelope budget of one snapshot. The instruction and the
   * minimum framed checkpoint are priced per call so the cap follows the
   * session's own estimator rather than a constant.
   */
  private envelopeBudget(
    session: Session,
    measurement: ReturnType<TokenMeter['measure']>,
    spec: ReturnType<typeof resolveCompactSpec>,
  ): EnvelopeBudget {
    const meter = this.ctx.tokenMeter
    const injectionTokens = visibleSlotTokens(session, measurement)
    return resolveEnvelopeBudget(measurement, {
      contextWindow: spec.contextWindow,
      responseReserveTokens: spec.responseReserveTokens,
      safetyMarginTokens: spec.safetyMarginTokens,
      instructionTokens: compactionInstructionTokens(meter),
      summaryMaxTokens: spec.maxTokens,
      retainTokens: spec.retainTokens,
      minRetainTokens: retainedTailFloorTokens(session, measurement),
      injectionTokens,
    })
  }

  /**
   * The effective per-group input cap: the configured group budget narrowed by
   * the envelope auxiliary input cap, so a group whose summarization call
   * could not fit the window is never selected, probed, or paid for.
   */
  private cappedMaxGroupTokens(maxGroupTokens: number, inputCapTokens: number | undefined): number {
    return inputCapTokens === undefined ? maxGroupTokens : Math.min(maxGroupTokens, Math.max(0, inputCapTokens))
  }

  /**
   * Whether a terminal envelope-budget stop still holds for the current
   * pressure/surface state. The memo reopens — and is dropped — when the
   * surface generation, the surface node count, or the measured pressure no
   * longer matches the state the verdict was derived from: newly appended
   * content or a moved pressure anchor can change the plan and the domination
   * verdicts, so the suppression must not outlive its own evidence.
   */
  private pressurePassTerminated(session: Session, totalTokens: number): boolean {
    const memo = this.pressureStops.get(session)
    if (memo === undefined) return false
    if (memo.generation !== session.surface.replaceGeneration
      || memo.surfaceNodes !== session.surface.nodes.length
      || memo.totalTokens !== totalTokens) {
      this.pressureStops.delete(session)
      return false
    }
    for (const reason of memo.reasons) {
      if (TERMINAL_PRESSURE_REASONS.has(reason)) return true
    }
    return false
  }

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
  private stopEnvelopeBudgetPass(
    session: Session,
    reason: PressureStopReason,
    totalTokens: number,
    thresholdTokens: number,
  ): void {
    const generation = session.surface.replaceGeneration
    const surfaceNodes = session.surface.nodes.length
    const memo = this.pressureStops.get(session)
    const current = memo !== undefined
      && memo.generation === generation
      && memo.surfaceNodes === surfaceNodes
      && memo.totalTokens === totalTokens
      ? memo
      : undefined
    if (current !== undefined && current.reasons.has(reason)) return
    if (current !== undefined) current.reasons.add(reason)
    else this.pressureStops.set(session, { generation, surfaceNodes, totalTokens, reasons: new Set([reason]) })
    const stopReasons = this.activePressureStopReasons
    if (stopReasons !== undefined && !stopReasons.includes(reason)) stopReasons.push(reason)
    reportStoppedReason(this, this.ctx.logger, reason, totalTokens, thresholdTokens)
  }

  /**
   * Overflow is the only path allowed to relax normal zones. It first prunes
   * provenance-indexed original results, then progresses oldest-first through
   * forget, tool, and recent ranges. No custom SessionEventMap entry is needed:
   * each reduction uses the official compaction/prune or compaction transaction.
   */
  private async recoverOverflow(
    agent: Agent,
    prune: ToolResultPruner | undefined,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    if (prune !== undefined) {
      const sources = this.sourceIndex(session)
      prune.pruneSession(session, { candidateSeqs: session.surface.nodes.filter(seq => sources.isOriginalToolResult(seq)) })
    }
    const target = routedTarget(session)
    if (target === undefined) return null
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    if (context === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const spec = resolveCompactSpec(policy, context.contextWindow)
    let latest: CompactionResult | null = null
    // An overflow attempt may cross a protection boundary only after the prior
    // zone has no eligible bounded batch or reaches its explicit safety cap.
    // Reprice and repartition before EVERY batch; replacements invalidate every
    // old positional boundary.
    //
    // `maxPressureBatches` is the batch budget of THIS ladder. The ordinary
    // pressure tier reads the same key for its own bounded batch loop, so the two
    // budgets are deliberately the same configured number, but they are
    // independent counters over independent ranges: an overflow level never
    // inherits the pressure tier's remaining batches, and the pressure tier never
    // crosses into the tool or recent zone the way this ladder may.
    for (const level of ['overflow-forget', 'overflow-tool-zone', 'overflow-recent'] as const) {
      for (let batch = 0; batch < policy.maxPressureBatches; batch += 1) {
        const current = this.ctx.tokenMeter.measure(session)
        if (current.totalTokens < spec.thresholdTokens) return latest
        const zones = this.zones(session, current, spec)
        const range = level === 'overflow-forget'
          ? zones.forget
          : level === 'overflow-tool-zone'
            ? zones.tool
            : zones.recent
        if (range === null) break
        // Overflow is the explicit ladder, but each auxiliary call it buys is
        // still one the window must fit: the same envelope input cap that
        // bounds ordinary passes bounds overflow batches, so recovery never
        // spends a call that can only fail with context-window-exceeded.
        const batchBudget = this.envelopeBudget(session, current, spec)
        const selected = selectForgetBatch(session, current, { ...zones, forget: range }, {
          targetBatchTokens: Math.min(spec.targetBatchTokens, batchBudget.summarizerInputCapTokens),
          maxBatchTokens: Math.min(spec.maxBatchTokens, batchBudget.summarizerInputCapTokens),
        })
        if (selected === null) break
        const sourceIndex = this.sourceIndex(session)
        const selectedSeqs = session.surface.nodes.slice(selected.startIndex, selected.endIndex + 1)
        // A prior overflow replacement is still a history summary; a retry must
        // not immediately re-summarize it before a later completed turn exists.
        if (selectedSeqs.some(seq => !sourceIndex.canCompactHistory(seq, policy.minReentryTurns))) break
        this.ctx.logger.warn(`context-overflow recovery level ${level}, batch ${batch + 1}`)
        latest = await this.compactRegion(selected.startSeq, selected.endSeq, agent, signal)
        if (batch + 1 === policy.maxPressureBatches) {
          // Do not cross into a younger protection level while this zone may
          // still contain candidates; a later overflow retry gets fresh zones.
          const after = this.ctx.tokenMeter.measure(session)
          const afterZones = this.zones(session, after, spec)
          const remaining = level === 'overflow-forget' ? afterZones.forget
            : level === 'overflow-tool-zone' ? afterZones.tool : afterZones.recent
          const afterBudget = this.envelopeBudget(session, after, spec)
          if (remaining !== null && selectForgetBatch(session, after, { ...afterZones, forget: remaining }, {
            targetBatchTokens: Math.min(spec.targetBatchTokens, afterBudget.summarizerInputCapTokens),
            maxBatchTokens: Math.min(spec.maxBatchTokens, afterBudget.summarizerInputCapTokens),
          }) !== null) return latest
        }
      }
    }
    return latest
  }

  private async summarizeToolGroups(
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    policy: ReturnType<typeof resolveTargetPolicy>,
    olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
    signal: AbortSignal,
    roundReplacements: Set<SessionSeq>,
    inputCapTokens?: number,
  ): Promise<void> {
    const config = this.config.toolGroupSummarizer
    if (!config.enabled || olderRange === null) return
    await this.toolGroupAuditStorePromise
    const store = this.toolGroupAuditStore
    if (store === undefined) return
    const session = agent.session
    // Rows an earlier process (or another instance) left `open` are judged
    // against the Session log before this pass can adopt or re-attempt them.
    await recoverToolGroupAudits(this, session)
    // Selection itself must ignore replaced results: a run left mixed by an
    // earlier partial summary is split at safe step/pair cuts so its raw
    // originals stay selectable instead of being skipped with their replaced
    // siblings.
    const selectionSources = this.sourceIndex(session)
    // The exact option object the pending-work probe judges with, so the two
    // can never disagree about what counts as outstanding tool work.
    const groups = selectToolGroups(session, this.toolGroupSelectionOptions(
      { start: olderRange.startSeq, end: olderRange.endSeq },
      inputCapTokens,
      selectionSources,
      session,
    ))
    const unwritten = auditEngineState(this).unwritten
    for (const group of groups) {
      // Tool summaries have the same Session event type as raw results. Their
      // durable replacement provenance, not their generated text, decides
      // whether a future op1 call may consume the group.
      const sources = this.sourceIndex(session)
      if (group.toolResultSeqs.some(seq => !sources.isOriginalToolResult(seq))) continue
      const fingerprint = this.toolGroupFingerprint(session, group)
      const records = store.recordsForSession(session.id, session.header.createdAt)
      // The Session log decides first: a group whose reduction its own durable
      // provenance proves landed owes no model call, whatever the rows say.
      if (!mayAttemptToolGroupSummary(this, sources, records, fingerprint)) continue
      // One durable row per group: an attempt this instance owns is resumed, an
      // interrupted/foreign one is adopted in place (so the durable attempt
      // budget cannot double-count), and only a group with no row at all opens
      // a new one.
      const slot = attemptSlotFor(records, fingerprint, auditOwnerId(this))
      const open = slot === undefined
        ? openToolGroupAudit(
          `tg-${randomUUID()}`,
          session.id,
          group,
          session.surface.replaceGeneration,
          policy.summarizationProvider || target.provider,
          policy.summarizationModel || target.model,
          fingerprint,
          { createdAt: session.header.createdAt },
          { ownerId: auditOwnerId(this) },
        )
        : slot.adopted
          ? adoptToolGroupAudit(slot.record, {
            ownerId: auditOwnerId(this),
            sourceSeqs: group.sourceSeqs,
            surfaceGeneration: session.surface.replaceGeneration,
            diagnostic: AUDIT_DIAGNOSTIC.adoptedInterruptedAttempt,
          })
          : resumeToolGroupAudit(slot.record, {
            sourceSeqs: group.sourceSeqs,
            surfaceGeneration: session.surface.replaceGeneration,
          })
      const requestId = open.requestId
      // The durable attempt row is written FIRST, and a rejected write must not
      // cancel the reduction: the Session log is what classifies a landed
      // replacement (B6.1), so the pass continues in a reported degraded mode
      // instead of spending the model call later. The attempt is counted in
      // memory so a store that keeps failing cannot buy model calls forever.
      let auditWrites = true
      try {
        await store.open(open)
        unwritten.delete(fingerprint)
      } catch (error: unknown) {
        auditWrites = false
        unwritten.set(fingerprint, (unwritten.get(fingerprint) ?? 0) + 1)
        logAuditDiagnostic(this, 
          `tool-group summary audit write failed (${AUDIT_DIAGNOSTIC.auditWriteFailed}); `
          + `the durable Session provenance still owns classification: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // Only this pre-commit phase may record a terminal failure/fallback: the
      // model call, the stability assertion, and the durable surface rewrite all
      // happen before any reduction exists, so a throw here means no replacement
      // was committed by this pass.
      let summarized: ToolGroupSummaryCallResult | undefined
      let replacement: ToolGroupReplacementResult
      const landedSeqs: SessionSeq[] = []
      try {
        summarized = await summarizeToolGroup(this.ctx, session, group, agent, { provider: open.provider, model: open.model, maxTokens: config.maxSummaryTokens }, signal, inputCapTokens)
        assertToolGroupCommitStable(session.id, session.surface.replaceGeneration, group.sourceSeqs, open)
        // Price every reduction with the session's own estimator, exactly like
        // the deterministic pruner, so the shared shadow-price event records
        // this successful reduction path too and replay folds stay exact.
        replacement = replaceToolGroup(session, group, summarized.summary, {
          estimateTokens: message => this.ctx.tokenMeter.estimateMessage(message),
          // A mid-group append failure leaves earlier members durable; exclude
          // each one the moment it lands rather than only on a full return.
          onLanded: seq => {
            landedSeqs.push(seq)
            roundReplacements.add(seq)
          },
        })
      } catch (error: unknown) {
        if (landedSeqs.length > 0) {
          // A mid-group append failure leaves earlier members durable on the surface.
          // Never record this attempt as a terminal failure/fallback: record the landed
          // replacements so the audit stays in served/open state with tool-summary provenance.
          if (auditWrites) {
            try {
              await store.finish(requestId, current => recordToolGroupLanded(current, landedSeqs, {
                ...(summarized?.summary === undefined ? {} : { summary: summarized.summary }),
                ...(summarized?.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }),
                error: error instanceof Error ? error.message : String(error),
              }))
            } catch (auditError: unknown) {
              this.ctx.logger.warn(`tool-group summary audit landing record failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`)
            }
          }
          continue
        }
        if (!auditWrites) {
          // Nothing landed and nothing could be recorded: report the attempt and
          // leave the group retryable within the budget rather than pretending a
          // terminal row exists.
          logAuditDiagnostic(this, 
            `tool-group summary attempt failed without an audit row (${AUDIT_DIAGNOSTIC.auditWriteFailed}): `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        const reason = error instanceof ToolGroupSummaryFallbackError ? error.reason : 'failure'
        const message = error instanceof Error ? error.message : String(error)
        const transient = reason === 'stream' || reason === 'failure'
        try {
          await store.finish(requestId, current => finishToolGroupAudit(current, transient ? 'failure' : 'fallback', { error: message }))
        } catch (auditError: unknown) {
          this.ctx.logger.warn(`tool-group summary audit finish failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`)
        }
        continue
      }
      // The reduction is durable from here on. Exclude it from this pass's
      // semantic compaction first, then commit the success record without ever
      // letting an audit write failure downgrade a landed reduction to a
      // terminal failure/fallback (see commitToolGroupSuccess).
      replacement.replacementSeqs.forEach(seq => roundReplacements.add(seq))
      if (!auditWrites) {
        // The reduction landed and the Session log proves it; only the audit
        // bookkeeping is missing, which recovery repairs from that provenance.
        logAuditDiagnostic(this, 
          `tool-group summary audit commit skipped (${AUDIT_DIAGNOSTIC.auditWriteFailed}); `
          + 'the landed reduction keeps its durable Session provenance',
        )
        continue
      }
      if (replacement.replacementSeqs.length > 0) {
        try {
          await store.finish(requestId, current => recordToolGroupLanded(current, replacement.replacementSeqs, {
            rawOutput: summarized.rawOutput,
            summary: summarized.summary,
          }))
        } catch (auditError: unknown) {
          this.ctx.logger.warn(`tool-group summary audit landing record failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`)
        }
      }
      await this.commitToolGroupSuccess(store, requestId, {
        rawOutput: summarized.rawOutput,
        summary: summarized.summary,
        replacementSeqs: replacement.replacementSeqs,
      })
    }
  }

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
  private async commitToolGroupSuccess(
    store: ToolGroupAuditStore,
    requestId: string,
    patch: Pick<ToolGroupAuditRecord, 'rawOutput' | 'summary' | 'replacementSeqs'>,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await store.finish(requestId, current => finishToolGroupAudit(current, 'success', patch))
        return
      } catch (error: unknown) {
        if (attempt === 0) continue
        this.ctx.logger.warn(
          `tool-group summary audit success commit failed: ${error instanceof Error ? error.message : String(error)}; `
          + 'the durable replacement stays recoverable',
        )
      }
    }
    // If commit to 'success' status failed continuously, ensure the open record at least durably carries
    // the landed replacementSeqs and summary so it is recognized as a served audit (tool-summary provenance).
    try {
      await store.finish(requestId, current => recordToolGroupLanded(current, patch.replacementSeqs ?? [], {
        rawOutput: patch.rawOutput,
        ...(patch.summary === undefined ? {} : { summary: patch.summary }),
      }))
    } catch (fallbackError: unknown) {
      this.ctx.logger.warn(
        `tool-group summary audit open-record fallback persistence failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      )
    }
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

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
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          // The durable compaction lock outranks range selection so a live
          // unmatched marker reports busy even when the head is an isolated
          // checkpoint the empty-benefit guard would otherwise decline.
          assertNoActiveCompaction(agent.session, 'manual compaction')
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }
}

export default BasicCompactionEngine
