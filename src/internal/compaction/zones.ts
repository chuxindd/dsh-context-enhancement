/**
 * Positional three-zone planning for progressive context compaction.
 *
 * All ranges are expressed as current-surface indexes. This is deliberate:
 * replacement events append fresh sequence numbers and therefore visible seqs
 * are not necessarily numerically ordered. Pairing and step-boundary checks
 * keep every emitted range whole.
 */

import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'

export type CompactionZone = 'forget' | 'tool' | 'recent'

export interface SurfaceIndexRange {
  readonly startIndex: number
  readonly endIndex: number
  readonly startSeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly tokens: number
}

export interface SurfaceZones {
  readonly totalTokens: number
  readonly recentBoundaryTokens: number
  readonly forgetBoundaryTokens: number
  readonly forget: SurfaceIndexRange | null
  readonly tool: SurfaceIndexRange | null
  readonly recent: SurfaceIndexRange | null
}

export interface ZoneRatios {
  readonly recentRatio: number
  readonly forgetBoundaryRatio: number
  /** Model context capacity used for tail-distance boundaries. */
  readonly contextWindow: number
}

export interface ForgetBatchOptions {
  readonly targetBatchTokens: number
  readonly maxBatchTokens: number
}

export type ForgetBatchBlockReason =
  | 'no-forget-range'
  | 'unsafe-forget-start'
  | 'oldest-unit-too-large'
  | 'no-safe-batch-end'

export type ForgetBatchPlan =
  | { readonly kind: 'selected'; readonly range: SurfaceIndexRange }
  | { readonly kind: 'blocked'; readonly reason: ForgetBatchBlockReason }

/**
 * Partition one token snapshot into non-overlapping forget/tool/recent zones.
 * Boundaries are measured from the newest surface tail and moved toward the
 * historical side until the cut is outside any open tool pair.
 */
export function partitionSurfaceZones(
  session: Session,
  measurement: TokenMeasurement,
  ratios: ZoneRatios,
): SurfaceZones {
  const nodes = [...session.surface.nodes]
  assertMeasurementSurface(nodes, measurement)
  if (nodes.length === 0) {
    return {
      totalTokens: 0,
      recentBoundaryTokens: 0,
      forgetBoundaryTokens: 0,
      forget: null,
      tool: null,
      recent: null,
    }
  }

  const capacity = ratios.contextWindow
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('compaction zones: contextWindow must be positive')
  const recentBoundaryTokens = Math.floor(capacity * ratios.recentRatio)
  const forgetBoundaryTokens = Math.floor(capacity * ratios.forgetBoundaryRatio)
  const recentStart = boundaryFromTail(session, measurement, recentBoundaryTokens)
  const forgetStart = Math.min(recentStart, boundaryFromTail(session, measurement, forgetBoundaryTokens))

  return {
    totalTokens: measurement.surfaceTokens,
    recentBoundaryTokens,
    forgetBoundaryTokens,
    forget: makeRange(nodes, measurement, 0, forgetStart - 1),
    tool: makeRange(nodes, measurement, forgetStart, recentStart - 1),
    recent: makeRange(nodes, measurement, recentStart, nodes.length - 1),
  }
}

/** Return a current-surface range by indexes, or null for an empty range. */
export function rangeFromIndexes(
  session: Session,
  measurement: TokenMeasurement,
  startIndex: number,
  endIndex: number,
): SurfaceIndexRange | null {
  assertMeasurementSurface([...session.surface.nodes], measurement)
  return makeRange([...session.surface.nodes], measurement, startIndex, endIndex)
}

/**
 * Select the oldest complete forget-zone batch. The first complete unit is
 * allowed to be below the target, but never above max; if it is above max no
 * semantic call is made. The returned range never crosses the forget boundary.
 */
export function planForgetBatch(
  session: Session,
  measurement: TokenMeasurement,
  zones: SurfaceZones,
  options: ForgetBatchOptions,
): ForgetBatchPlan {
  const zone = zones.forget
  if (zone === null) return { kind: 'blocked', reason: 'no-forget-range' }
  if (!toolPairingBalancedBefore(session, zone.startSeq)) {
    return { kind: 'blocked', reason: 'unsafe-forget-start' }
  }
  const target = Math.max(1, options.targetBatchTokens)
  const max = Math.max(target, options.maxBatchTokens)
  let candidate: SurfaceIndexRange | null = null
  let sawSafeEnd = false
  for (let end = zone.startIndex; end <= zone.endIndex; end += 1) {
    if (!toolPairingBalancedAfter(session, session.surface.nodes[end]!)) continue
    if (!stepBoundaryAfter(session, end, zone.endIndex)) continue
    sawSafeEnd = true
    const range = makeRange([...session.surface.nodes], measurement, zone.startIndex, end)
    if (range === null) continue
    if (range.tokens > max) {
      return candidate === null
        ? { kind: 'blocked', reason: 'oldest-unit-too-large' }
        : { kind: 'selected', range: candidate }
    }
    candidate = range
    if (range.tokens >= target) break
  }
  if (candidate !== null) return { kind: 'selected', range: candidate }
  return { kind: 'blocked', reason: sawSafeEnd ? 'oldest-unit-too-large' : 'no-safe-batch-end' }
}

export function selectForgetBatch(
  session: Session,
  measurement: TokenMeasurement,
  zones: SurfaceZones,
  options: ForgetBatchOptions,
): SurfaceIndexRange | null {
  const plan = planForgetBatch(session, measurement, zones, options)
  return plan.kind === 'selected' ? plan.range : null
}

/** A batch boundary must not split a surface step with the same turn/step. */
function stepBoundaryAfter(session: Session, index: number, zoneEnd: number): boolean {
  if (index >= zoneEnd) return true
  const current = session.eventAt(session.surface.nodes[index]!)
  const next = session.eventAt(session.surface.nodes[index + 1]!)
  if (current === undefined || next === undefined) return false
  return !sameStep(current, next)
}

function sameStep(left: SessionEvent, right: SessionEvent): boolean {
  const leftData = left.data as { turn?: unknown; step?: unknown }
  const rightData = right.data as { turn?: unknown; step?: unknown }
  return leftData.turn !== undefined && leftData.step !== undefined
    && leftData.turn === rightData.turn && leftData.step === rightData.step
}

function boundaryFromTail(
  session: Session,
  measurement: TokenMeasurement,
  boundaryTokens: number,
): number {
  const nodes = [...session.surface.nodes]
  if (boundaryTokens <= 0) return nodes.length
  let total = 0
  let start = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    total += measurement.nodes[index]!.tokens
    start = index
    if (total >= boundaryTokens) break
  }
  while (start > 0 && (!toolPairingBalancedBefore(session, nodes[start]!)
    || !stepBoundaryAfter(session, start - 1, nodes.length - 1))) start -= 1
  return start
}

function makeRange(
  nodes: readonly SessionSeq[],
  measurement: TokenMeasurement,
  startIndex: number,
  endIndex: number,
): SurfaceIndexRange | null {
  if (startIndex > endIndex || startIndex < 0 || endIndex >= nodes.length) return null
  let tokens = 0
  for (let index = startIndex; index <= endIndex; index += 1) {
    tokens += measurement.nodes[index]!.tokens
  }
  return {
    startIndex,
    endIndex,
    startSeq: nodes[startIndex]!,
    endSeq: nodes[endIndex]!,
    tokens,
  }
}

function assertMeasurementSurface(
  nodes: readonly SessionSeq[],
  measurement: TokenMeasurement,
): void {
  if (nodes.length !== measurement.nodes.length
    || nodes.some((seq, index) => measurement.nodes[index]?.seq !== seq)) {
    throw new Error('compaction zones: token-meter surface does not match current session surface')
  }
}
