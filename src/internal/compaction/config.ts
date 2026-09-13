/** Three-zone compaction configuration resolution and model-policy inheritance. */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedPolicyFields,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

const DEFAULT_PRESSURE_RATIO = 0.80
const DEFAULT_RECENT_RATIO = 0.20
const DEFAULT_FORGET_BOUNDARY_RATIO = 0.50
const DEFAULT_TOOL_MAINTENANCE_RATIO = 0.40
const DEFAULT_FORGET_MAINTENANCE_RATIO = 0.70
const DEFAULT_TARGET_BATCH_TOKENS = 16_000
const DEFAULT_MAX_BATCH_TOKENS = 24_000
const DEFAULT_MAX_MAINTENANCE_BATCHES = 1
const DEFAULT_MAX_PRESSURE_BATCHES = 2
const DEFAULT_MIN_REENTRY_TURNS = 1
const DEFAULT_RESPONSE_RESERVE_TOKENS = 8_192
const DEFAULT_SAFETY_MARGIN_TOKENS = 2_048
/**
 * Net-release floors of one semantic pressure batch. The absolute floor catches
 * a batch that releases almost nothing; the relative floor catches a batch whose
 * release is small compared with the span it paid for. Either one passing is
 * enough, so the pair is a gate on "was this batch worth its call", not a demand
 * for both.
 */
const DEFAULT_MIN_NET_RELEASE_TOKENS = 1_024
const DEFAULT_MIN_NET_RELEASE_RATIO = 0.15

const POLICY_CONFIG_KEYS = [
  'thresholdRatio', 'retainRatio', 'retainTokens', 'recentRatio',
  'forgetBoundaryRatio', 'toolMaintenanceRatio', 'forgetMaintenanceRatio',
  'pressureRatio', 'pressureExitRatio', 'minNetReleaseTokens', 'minNetReleaseRatio',
  'targetBatchTokens', 'maxBatchTokens',
  'maxMaintenanceBatches', 'maxPressureBatches', 'minReentryTurns',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries',
  'responseReserveTokens', 'safetyMarginTokens',
] as const
const TOOL_GROUP_KEYS = new Set([
  'enabled', 'minGroupResults', 'minGroupChars', 'minGroupTokens',
  'maxGroupTokens', 'maxGroupsPerPass', 'maxSummaryTokens',
])
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_CONFIG_KEYS, 'modelPolicies', 'auto', 'toolGroupSummarizer',
])
const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set(['provider', 'model', ...POLICY_CONFIG_KEYS])

export class TargetPressureConfigError extends Error {
  constructor(readonly targetKey: string, message: string) { super(message) }
}

type ResolvedPolicy = ResolvedPolicyFields & ResolvedRetention

export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  validateToolGroupConfig(config.toolGroupSummarizer)
  validatePolicy(config, 'BasicCompactionConfig')
  if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    throw new Error('BasicCompactionConfig: auto must be a boolean')
  }

  const resolved = resolvePolicy(config, undefined, 'BasicCompactionConfig')
  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    resolvePolicy(policy, resolved, `BasicCompactionConfig: modelPolicies[${index}]`)
  }
  return deepFreeze({
    ...resolved,
    modelPolicies,
    auto: config.auto ?? true,
    toolGroupSummarizer: {
      enabled: config.toolGroupSummarizer?.enabled ?? true,
      minGroupResults: config.toolGroupSummarizer?.minGroupResults ?? 2,
      minGroupChars: config.toolGroupSummarizer?.minGroupChars ?? 12_000,
      minGroupTokens: config.toolGroupSummarizer?.minGroupTokens ?? 2_000,
      maxGroupTokens: config.toolGroupSummarizer?.maxGroupTokens ?? 12_000,
      maxGroupsPerPass: config.toolGroupSummarizer?.maxGroupsPerPass ?? 2,
      maxSummaryTokens: config.toolGroupSummarizer?.maxSummaryTokens ?? 1_200,
    },
  }) as ResolvedConfig
}

export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): ResolvedTargetPolicy {
  const override = config.modelPolicies.find(policy =>
    policy.provider === target.provider && policy.model === target.model)
  const resolved = resolvePolicy(override ?? {}, config, `${target.provider}/${target.model}`)
  return deepFreeze({ ...resolved, target: { ...target } })
}

export function resolveCompactSpec(policy: ResolvedTargetPolicy, contextWindow: number): ResolvedCompactSpec {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`)
  }
  const thresholdTokens = Math.floor(contextWindow * policy.pressureRatio)
  const pressureExitTokens = Math.floor(contextWindow * policy.pressureExitRatio)
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(contextWindow * policy.recentRatio)
    : policy.retainTokens
  const forgetBoundaryTokens = Math.floor(contextWindow * policy.forgetBoundaryRatio)
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${targetKey} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`)
  }
  if (retainTokens >= forgetBoundaryTokens) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${targetKey} retainTokens (${retainTokens}) must be less than forget boundary tokens ${forgetBoundaryTokens}`)
  }
  // The exit line is a real release target: it must sit strictly below the
  // trigger this pass was admitted for, or the tier would already be at its own
  // target when it starts. The ratio form of the same relation is enforced by
  // `validateZoneRatios`, which is integer-rounding free; this check keeps the
  // rounded token form honest for small windows.
  if (pressureExitTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${targetKey} pressureExitTokens (${pressureExitTokens}) must be less than threshold tokens ${thresholdTokens}`)
  }
  // The envelope-aware surface grant is W - E - R - M. A reserve plus margin
  // that alone fills the window can never grant a surface, so the session would
  // be permanently envelope-dominated: refuse the configuration instead of
  // paying for a pass that can only stop.
  const heldFreeTokens = policy.responseReserveTokens + policy.safetyMarginTokens
  if (heldFreeTokens >= contextWindow) {
    throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${targetKey} responseReserveTokens + safetyMarginTokens (${heldFreeTokens}) must be less than the context window ${contextWindow}`)
  }
  return deepFreeze({
    ...policy,
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.pressureRatio,
    thresholdTokens,
    retainTokens,
    pressureExitTokens,
  })
}

function resolvePolicy(
  config: CompactionPolicyConfig,
  fallback: ResolvedPolicy | undefined,
  name: string,
): ResolvedPolicy {
  if (config.compactionRetries !== undefined && config.maxPressureBatches !== undefined) {
    throw new Error(`${name}: compactionRetries conflicts with maxPressureBatches; configure only one pressure budget`)
  }
  const pressureRatio = config.pressureRatio ?? config.thresholdRatio ?? fallback?.pressureRatio ?? DEFAULT_PRESSURE_RATIO
  const recentRatio = config.recentRatio ?? config.retainRatio ?? fallback?.recentRatio ?? DEFAULT_RECENT_RATIO
  const forgetBoundaryRatio = config.forgetBoundaryRatio ?? fallback?.forgetBoundaryRatio ?? DEFAULT_FORGET_BOUNDARY_RATIO
  const toolMaintenanceRatio = config.toolMaintenanceRatio ?? fallback?.toolMaintenanceRatio ?? DEFAULT_TOOL_MAINTENANCE_RATIO
  const forgetMaintenanceRatio = config.forgetMaintenanceRatio ?? fallback?.forgetMaintenanceRatio ?? DEFAULT_FORGET_MAINTENANCE_RATIO
  // The exit line defaults to the RESOLVED maintenance waterline rather than to a
  // frozen 0.70: a model that raises its own maintenance watermark must raise its
  // exit line with it, or the pressure tier would be required to reclaim below
  // the level bounded maintenance is allowed to reach.
  const pressureExitRatio = config.pressureExitRatio ?? fallback?.pressureExitRatio ?? forgetMaintenanceRatio
  validateZoneRatios(recentRatio, forgetBoundaryRatio, toolMaintenanceRatio, forgetMaintenanceRatio, pressureRatio, pressureExitRatio, name)
  validateRetention(config, pressureRatio, recentRatio, name)
  // A model override that omits retention inherits the default policy's exact
  // retention form. A new/legacy ratio on the override deliberately switches to
  // the ratio form; an explicit retainTokens remains absolute.
  const retention = config.retainTokens !== undefined
    ? { retainTokens: config.retainTokens }
    : (config.retainRatio !== undefined || config.recentRatio !== undefined)
      ? { retainRatio: recentRatio }
      : fallback?.retainTokens !== undefined
        ? { retainTokens: fallback.retainTokens }
        : { retainRatio: recentRatio }
  const fields = {
    thresholdRatio: pressureRatio,
    recentRatio,
    forgetBoundaryRatio,
    toolMaintenanceRatio,
    forgetMaintenanceRatio,
    pressureRatio,
    pressureExitRatio,
    minNetReleaseTokens: config.minNetReleaseTokens ?? fallback?.minNetReleaseTokens ?? DEFAULT_MIN_NET_RELEASE_TOKENS,
    minNetReleaseRatio: config.minNetReleaseRatio ?? fallback?.minNetReleaseRatio ?? DEFAULT_MIN_NET_RELEASE_RATIO,
    targetBatchTokens: config.targetBatchTokens ?? fallback?.targetBatchTokens ?? DEFAULT_TARGET_BATCH_TOKENS,
    maxBatchTokens: config.maxBatchTokens ?? fallback?.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS,
    maxMaintenanceBatches: config.maxMaintenanceBatches ?? fallback?.maxMaintenanceBatches ?? DEFAULT_MAX_MAINTENANCE_BATCHES,
    maxPressureBatches: config.maxPressureBatches ?? (config.compactionRetries !== undefined
      ? config.compactionRetries + 1
      : fallback?.maxPressureBatches ?? DEFAULT_MAX_PRESSURE_BATCHES),
    minReentryTurns: config.minReentryTurns ?? fallback?.minReentryTurns ?? DEFAULT_MIN_REENTRY_TURNS,
    summarizationProvider: config.summarizationProvider ?? fallback?.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? fallback?.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? fallback?.maxTokens ?? 8_192,
    compactionRetries: config.compactionRetries ?? fallback?.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? fallback?.maxOverflowRetries ?? 1,
    responseReserveTokens: config.responseReserveTokens ?? fallback?.responseReserveTokens ?? DEFAULT_RESPONSE_RESERVE_TOKENS,
    safetyMarginTokens: config.safetyMarginTokens ?? fallback?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS,
    ...retention,
  }
  validateResolvedBudgets(fields, name)
  return fields
}

function validateResolvedBudgets(fields: {
  targetBatchTokens: number; maxBatchTokens: number; maxMaintenanceBatches: number;
  maxPressureBatches: number; minReentryTurns: number;
  minNetReleaseTokens: number; minNetReleaseRatio: number; pressureExitRatio: number;
}, name: string): void {
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'maxMaintenanceBatches' || key === 'maxPressureBatches' || key === 'minNetReleaseTokens') {
      assertNonNegativeInteger(`${name}.${key}`, value)
    } else if (key === 'targetBatchTokens' || key === 'maxBatchTokens' || key === 'minReentryTurns') {
      assertPositiveInteger(`${name}.${key}`, value)
    } else if (key === 'minNetReleaseRatio') {
      // Closed [0, 1]: `0` is the documented way to switch this branch of the
      // gate off, and `1` is legal (a batch may release everything it shadowed).
      // `assertRatio` is (0, 1] and would refuse the legal `0`.
      assertBoundedRatio(`${name}.${key}`, value)
    } else if (key === 'pressureExitRatio') {
      // Re-asserted here (not only in `validateZoneRatios`) so a policy merged
      // from a source that skipped the zone-ratio pass can never resolve with an
      // undefined exit line and silently make pressure arithmetic NaN.
      assertRatio(`${name}.${key}`, value)
    }
  }
  if (fields.targetBatchTokens > fields.maxBatchTokens) {
    throw new Error(`${name}: targetBatchTokens must not exceed maxBatchTokens`)
  }
}

function validateZoneRatios(recent: number, forget: number, tool: number, forgetMaint: number, pressure: number, pressureExit: number, name: string): void {
  for (const [key, value] of Object.entries({ recentRatio: recent, forgetBoundaryRatio: forget, toolMaintenanceRatio: tool, forgetMaintenanceRatio: forgetMaint, pressureRatio: pressure, pressureExitRatio: pressureExit })) assertRatio(`${name}.${key}`, value)
  if (!(recent < forget && forget < forgetMaint && forgetMaint < pressure)) throw new Error(`${name}: require recentRatio < forgetBoundaryRatio < forgetMaintenanceRatio < pressureRatio`)
  if (!(forgetMaint <= pressureExit && pressureExit < pressure)) throw new Error(`${name}: require forgetMaintenanceRatio <= pressureExitRatio < pressureRatio`)
  if (!(tool >= recent && tool < forgetMaint)) throw new Error(`${name}: require toolMaintenanceRatio >= recentRatio and < forgetMaintenanceRatio`)
}

function validateRetention(config: CompactionPolicyConfig, pressure: number, recent: number, name: string): void {
  if (config.thresholdRatio !== undefined && config.pressureRatio !== undefined
    && config.thresholdRatio !== config.pressureRatio) {
    throw new Error(`${name}: thresholdRatio conflicts with pressureRatio`)
  }
  if (config.retainRatio !== undefined && config.recentRatio !== undefined
    && config.retainRatio !== config.recentRatio) {
    throw new Error(`${name}: retainRatio conflicts with recentRatio`)
  }
  if (config.retainTokens !== undefined && (config.retainRatio !== undefined || config.recentRatio !== undefined)) {
    throw new Error(`${name}: retainTokens is mutually exclusive with retainRatio and recentRatio`)
  }
  if (config.retainRatio !== undefined) assertRatio(`${name}.retainRatio`, config.retainRatio)
  if (config.retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, config.retainTokens)
  if (recent >= pressure) throw new Error(`${name}: recentRatio must be less than pressureRatio`)
}

function resolveModelPolicies(configured: unknown): ModelCompactPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) throw new Error('BasicCompactionConfig: modelPolicies must be an array')
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
    validateKeys(source, MODEL_POLICY_KEYS, name)
    assertNonEmptyString(`${name}.provider`, source.provider)
    assertNonEmptyString(`${name}.model`, source.model)
    validatePolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) throw new Error(`BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`)
    seen.add(key)
    return { ...source } as unknown as ModelCompactPolicyConfig
  })
}

function validatePolicy(config: CompactionPolicyConfig | Record<string, unknown>, name: string): void {
  const values = config as Record<string, unknown>
  const ratioKeys = ['thresholdRatio', 'retainRatio', 'recentRatio', 'forgetBoundaryRatio', 'toolMaintenanceRatio', 'forgetMaintenanceRatio', 'pressureRatio', 'pressureExitRatio']
  for (const key of ratioKeys) if (values[key] !== undefined) assertRatio(`${name}.${key}`, values[key])
  if (values.retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, values.retainTokens)
  if (values.minNetReleaseRatio !== undefined) assertBoundedRatio(`${name}.minNetReleaseRatio`, values.minNetReleaseRatio)
  if (values.minNetReleaseTokens !== undefined) assertNonNegativeInteger(`${name}.minNetReleaseTokens`, values.minNetReleaseTokens)
  for (const key of ['targetBatchTokens', 'maxBatchTokens', 'maxMaintenanceBatches', 'maxPressureBatches', 'minReentryTurns', 'maxTokens', 'compactionRetries', 'maxOverflowRetries']) {
    if (values[key] !== undefined) (key === 'compactionRetries' || key === 'maxOverflowRetries'
      || key === 'maxMaintenanceBatches' || key === 'maxPressureBatches')
      ? assertNonNegativeInteger(`${name}.${key}`, values[key])
      : assertPositiveInteger(`${name}.${key}`, values[key])
  }
  if (typeof values.targetBatchTokens === 'number' && typeof values.maxBatchTokens === 'number' && values.targetBatchTokens > values.maxBatchTokens) throw new Error(`${name}: targetBatchTokens must not exceed maxBatchTokens`)
  for (const key of ['responseReserveTokens', 'safetyMarginTokens']) {
    if (values[key] !== undefined) assertNonNegativeInteger(`${name}.${key}`, values[key])
  }
  validateSummarizationPair(values, name)
}

function validateSummarizationPair(config: CompactionPolicyConfig | Record<string, unknown>, name: string): void {
  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') throw new Error(`${name}.summarizationProvider must be a string`)
  if (model !== undefined && typeof model !== 'string') throw new Error(`${name}.summarizationModel must be a string`)
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined || (provider.length === 0) !== (model.length === 0)) throw new Error(`${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`)
}

function validateToolGroupConfig(config: unknown): void {
  if (config === undefined) return
  if (!isUnknownRecord(config)) throw new Error('BasicCompactionConfig: toolGroupSummarizer must be an object')
  validateKeys(config, TOOL_GROUP_KEYS, 'BasicCompactionConfig.toolGroupSummarizer')
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('BasicCompactionConfig.toolGroupSummarizer.enabled must be a boolean')
  for (const key of ['minGroupResults', 'minGroupChars', 'minGroupTokens', 'maxGroupTokens', 'maxGroupsPerPass', 'maxSummaryTokens']) if (config[key] !== undefined) assertPositiveInteger(`BasicCompactionConfig.toolGroupSummarizer.${key}`, config[key])
  if (typeof config.minGroupTokens === 'number' && typeof config.maxGroupTokens === 'number' && config.minGroupTokens > config.maxGroupTokens) throw new Error('BasicCompactionConfig.toolGroupSummarizer.minGroupTokens must not exceed maxGroupTokens')
}

function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void { for (const key of Object.keys(config)) if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`) }
function isUnknownRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function assertNonEmptyString(name: string, value: unknown): asserts value is string { if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`) }
function assertPositiveInteger(name: string, value: unknown): asserts value is number { if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`${name} (${String(value)}) must be a positive integer`) }
function assertNonNegativeInteger(name: string, value: unknown): asserts value is number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${name} (${String(value)}) must be a non-negative integer`) }
function assertRatio(name: string, value: unknown): asserts value is number { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`) }
function assertBoundedRatio(name: string, value: unknown): asserts value is number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} (${String(value)}) must be a number in [0, 1]`) }
