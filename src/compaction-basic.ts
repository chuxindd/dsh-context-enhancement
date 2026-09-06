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
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
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
import { summarizeToolGroup, ToolGroupSummaryFallbackError } from './internal/compaction/tool-group-summarizer.ts'
import { replaceToolGroup } from './internal/compaction/tool-group-replacement.ts'
import { assertToolGroupCommitStable, contentDigest, finishToolGroupAudit, openToolGroupAudit, recoverableOpenAuditFor, shouldAttemptToolGroupSummary, toolGroupFingerprint } from './internal/compaction/tool-group-audit.ts'
import { openToolGroupAuditStore } from './internal/compaction/tool-group-audit-store.ts'
import type { ToolGroupAuditStore } from './internal/compaction/tool-group-audit-store.ts'
import type { ToolGroup } from './internal/compaction/tool-groups.ts'
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
import { partitionSurfaceZones, planForgetBatch, selectForgetBatch } from './internal/compaction/zones.ts'
import type { ForgetBatchBlockReason } from './internal/compaction/zones.ts'
import { buildSurfaceSourceIndex } from './internal/compaction/source-index.ts'
import { summarizeWithLlm } from './internal/compaction/summarizer.ts'
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
  | 'same-pass-tool-replacement'
  | 'reentry-deferred'
  | 'tool-stage-deferred'
  | 'no-progress'
  | 'convergence-guard'

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
  static inject = ['llm', 'tokenMeter', 'sessions']

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
    await this.summarizeToolGroups(agent, target, policy, zones.tool, signal, roundReplacements)
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
      })
      pruned.pruned.forEach(entry => roundReplacements.add(entry.replacementSeq))
      measurement = meter.measure(agent.session)
    }

    if (measurement.totalTokens < forgetWatermark) return null
    const pressure = measurement.totalTokens >= spec.thresholdTokens

    // Clear tool-stage debt that has aged into the forget zone. These
    // replacements remain excluded from semantic compaction for this pass, so
    // the intermediate representation gets at least one later request unless
    // a subsequent pressure pass deliberately re-enters it.
    zones = this.zones(agent.session, measurement, spec)
    if (zones.forget !== null) {
      await this.summarizeToolGroups(agent, target, policy, zones.forget, signal, roundReplacements)
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
        })
        pruned.pruned.forEach(entry => roundReplacements.add(entry.replacementSeq))
        measurement = meter.measure(agent.session)
      }
    }

    const maintenanceLimit = pressure
      ? agent.session.surface.nodes.length
      : policy.maxMaintenanceBatches
    let result: CompactionResult | null = null
    let batch = 0
    while (batch < maintenanceLimit) {
      // Do not reuse an old zone after a replacement. Pressure continues while
      // each freshly selected batch makes measurable progress below 80%.
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < forgetWatermark) break
      const currentZones = this.zones(agent.session, measurement, spec)
      const plan = planForgetBatch(agent.session, measurement, currentZones, {
        targetBatchTokens: policy.targetBatchTokens,
        maxBatchTokens: policy.maxBatchTokens,
      })
      if (plan.kind === 'blocked') {
        this.logPressureStop(plan.reason, measurement.totalTokens, spec.thresholdTokens)
        break
      }
      const selected = plan.range
      const selectedSeqs = agent.session.surface.nodes.slice(selected.startIndex, selected.endIndex + 1)
      const sources = this.sourceIndex(agent.session)
      if (selectedSeqs.some(seq => roundReplacements.has(seq))) {
        this.logPressureStop('same-pass-tool-replacement', measurement.totalTokens, spec.thresholdTokens)
        break
      }
      if (selectedSeqs.some(seq => !sources.canCompactHistory(seq, policy.minReentryTurns, pressure))) {
        this.logPressureStop('reentry-deferred', measurement.totalTokens, spec.thresholdTokens)
        break
      }
      if (this.hasPendingToolIntermediateWork(agent.session, selected.startSeq, selected.endSeq, prune)) {
        this.logPressureStop('tool-stage-deferred', measurement.totalTokens, spec.thresholdTokens)
        break
      }
      const beforeTokens = measurement.totalTokens
      result = await this.compactRegion(selected.startSeq, selected.endSeq, agent, signal)
      batch += 1
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens >= beforeTokens) {
        this.logPressureStop('no-progress', measurement.totalTokens, spec.thresholdTokens)
        break
      }
      if (!pressure || measurement.totalTokens < spec.thresholdTokens) break
    }
    if (pressure && batch >= maintenanceLimit && measurement.totalTokens >= spec.thresholdTokens) {
      this.logPressureStop('convergence-guard', measurement.totalTokens, spec.thresholdTokens)
    }
    return result
  }

  /** Record why an above-threshold pressure pass could not continue safely. */
  private logPressureStop(reason: PressureStopReason, totalTokens: number, thresholdTokens: number): void {
    if (totalTokens < thresholdTokens) return
    this.ctx.logger.warn(`three-zone pressure stopped: ${reason} (${totalTokens} >= ${thresholdTokens})`)
  }

  /** Rebuild source types from Session provenance and durable successful audits. */
  private sourceIndex(session: Session) {
    const summarized = this.toolGroupAuditStore?.recordsForSession(session.id, session.header.createdAt)
      .filter(record => record.status === 'success')
      .flatMap(record => record.replacementSeqs ?? []) ?? []
    return buildSurfaceSourceIndex(session, summarized)
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

  /** Whether a forget batch still contains raw content owed an intermediate tool pass. */
  private hasPendingToolIntermediateWork(
    session: Session,
    start: SessionSeq,
    end: SessionSeq,
    prune: ToolResultPruner | undefined,
  ): boolean {
    const nodes = session.surface.nodes
    const startIndex = nodes.indexOf(start)
    const endIndex = nodes.indexOf(end)
    if (startIndex < 0 || endIndex < startIndex) return true
    const index = this.sourceIndex(session)
    const selected = nodes.slice(startIndex, endIndex + 1)
    if (prune !== undefined && selected.some(seq => {
      const event = session.eventAt(seq)
      return event?.type === 'tool/result' && index.isOriginalToolResult(seq)
        && prune.measureContent(event.data.message.content[0].content) > prune.config.thresholdChars
    })) return true
    // Disabled or unavailable semantic summarization must never block the
    // ordinary history pass. Large originals remain guarded above because the
    // deterministic pruner can still process them.
    if (!this.config.toolGroupSummarizer.enabled || this.toolGroupAuditStore === undefined) return false
    // A qualifying group is outstanding semantic tool work, even when not
    // individually large enough for deterministic pruning.
    const records = this.toolGroupAuditStore.recordsForSession(session.id, session.header.createdAt)
    return selectToolGroups(session, {
      olderRange: { start, end },
      minGroupResults: this.config.toolGroupSummarizer.minGroupResults,
      minGroupChars: this.config.toolGroupSummarizer.minGroupChars,
      minGroupTokens: this.config.toolGroupSummarizer.minGroupTokens,
      maxGroupTokens: this.config.toolGroupSummarizer.maxGroupTokens,
      maxGroups: selected.length,
      estimateTokens: event => event.type === 'tool/result' || event.type === 'assistant/message'
        ? this.ctx.tokenMeter.estimateMessage(event.data.message)
        : 0,
    }).some(group => group.toolResultSeqs.every(seq => index.isOriginalToolResult(seq))
      && shouldAttemptToolGroupSummary(records, this.toolGroupFingerprint(session, group)))
  }

  /** Derive current zones from one fresh meter snapshot and the routed capacity. */
  private zones(session: Session, measurement: ReturnType<TokenMeter['measure']>, spec: ReturnType<typeof resolveCompactSpec>) {
    return partitionSurfaceZones(session, measurement, {
      recentRatio: spec.retainTokens / spec.contextWindow,
      forgetBoundaryRatio: spec.forgetBoundaryRatio,
      contextWindow: spec.contextWindow,
    })
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
        const selected = selectForgetBatch(session, current, { ...zones, forget: range }, {
          targetBatchTokens: spec.targetBatchTokens,
          maxBatchTokens: spec.maxBatchTokens,
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
          if (remaining !== null && selectForgetBatch(session, after, { ...afterZones, forget: remaining }, {
            targetBatchTokens: spec.targetBatchTokens,
            maxBatchTokens: spec.maxBatchTokens,
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
  ): Promise<void> {
    const config = this.config.toolGroupSummarizer
    if (!config.enabled || olderRange === null) return
    await this.toolGroupAuditStorePromise
    const store = this.toolGroupAuditStore
    if (store === undefined) return
    const session = agent.session
    const groups = selectToolGroups(session, {
      olderRange: olderRange === null ? null : { start: olderRange.startSeq, end: olderRange.endSeq },
      minGroupResults: config.minGroupResults,
      minGroupChars: config.minGroupChars,
      minGroupTokens: config.minGroupTokens,
      maxGroupTokens: config.maxGroupTokens,
      maxGroups: config.maxGroupsPerPass,
      estimateTokens: event => event.type === 'tool/result' || event.type === 'assistant/message'
        ? this.ctx.tokenMeter.estimateMessage(event.data.message)
        : 0,
    })
    for (const group of groups) {
      // Tool summaries have the same Session event type as raw results. Their
      // durable replacement provenance, not their generated text, decides
      // whether a future op1 call may consume the group.
      const sources = this.sourceIndex(session)
      if (group.toolResultSeqs.some(seq => !sources.isOriginalToolResult(seq))) continue
      const fingerprint = this.toolGroupFingerprint(session, group)
      const records = store.recordsForSession(session.id, session.header.createdAt)
      if (!shouldAttemptToolGroupSummary(records, fingerprint)) continue
      const priorOpen = recoverableOpenAuditFor(records, fingerprint)
      const requestId = priorOpen?.requestId ?? `tg-${randomUUID()}`
      const open = priorOpen ?? openToolGroupAudit(requestId, session.id, group, session.surface.replaceGeneration, policy.summarizationProvider || target.provider, policy.summarizationModel || target.model, fingerprint, { createdAt: session.header.createdAt })
      try {
        if (priorOpen === undefined) await store.open(open)
        const result = await summarizeToolGroup(this.ctx, session, group, agent, { provider: open.provider, model: open.model, maxTokens: config.maxSummaryTokens }, signal)
        assertToolGroupCommitStable(session.id, session.surface.replaceGeneration, group.sourceSeqs, open)
        const replacement = replaceToolGroup(session, group, result.summary)
        replacement.replacementSeqs.forEach(seq => roundReplacements.add(seq))
        await store.finish(requestId, current => finishToolGroupAudit(current, 'success', { rawOutput: result.rawOutput, summary: result.summary, replacementSeqs: replacement.replacementSeqs }))
      } catch (error: unknown) {
        const reason = error instanceof ToolGroupSummaryFallbackError ? error.reason : 'failure'
        const message = error instanceof Error ? error.message : String(error)
        const transient = reason === 'stream' || reason === 'failure'
        try {
          await store.finish(requestId, current => finishToolGroupAudit(current, transient ? 'failure' : 'fallback', { error: message }))
        } catch (auditError: unknown) {
          this.ctx.logger.warn(`tool-group summary audit finish failed: ${auditError instanceof Error ? auditError.message : String(auditError)}`)
        }
      }
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
