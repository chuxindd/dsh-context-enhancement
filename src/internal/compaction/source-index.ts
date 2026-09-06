/**
 * Durable source classification for the current session surface.
 *
 * Classification is derived from replacement provenance and official compaction
 * events, never from generated text. It can therefore be rebuilt after a
 * process restart from the Session log plus the surface relationship.
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

export type SurfaceSourceKind = 'original' | 'tool-summary' | 'tool-pruned' | 'history-summary' | 'unknown-replacement'

export interface SurfaceSourceEntry {
  readonly seq: SessionSeq
  readonly kind: SurfaceSourceKind
  readonly sourceEventSeqs: readonly SessionSeq[]
  /** A history summary may only re-enter after this many later completed turns. */
  readonly completedTurnsAfter: number
}

export interface SurfaceSourceIndex {
  readonly entries: ReadonlyMap<SessionSeq, SurfaceSourceEntry>
  entry(seq: SessionSeq): SurfaceSourceEntry
  isOriginalToolResult(seq: SessionSeq): boolean
  canCompactHistory(
    seq: SessionSeq,
    minReentryTurns: number,
    allowImmediateHistorySummary?: boolean,
  ): boolean
}

/** Reconstruct current source types entirely from persisted session provenance. */
export function buildSurfaceSourceIndex(
  session: Session,
  toolSummaryReplacementSeqs: readonly SessionSeq[] = [],
): SurfaceSourceIndex {
  const knownToolSummaries = new Set(toolSummaryReplacementSeqs)
  const entries = new Map<SessionSeq, SurfaceSourceEntry>()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`source-index: surface seq ${seq} has no event`)
    const kind = classifyEvent(session, event, knownToolSummaries.has(seq))
    entries.set(seq, {
      seq,
      kind,
      sourceEventSeqs: replacementSources(event),
      completedTurnsAfter: kind === 'original' ? 0 : completedTurnsAfter(session, event),
    })
  }
  return {
    entries,
    entry(seq) {
      const entry = entries.get(seq)
      if (entry === undefined) throw new Error(`source-index: surface seq ${seq} is not indexed`)
      return entry
    },
    isOriginalToolResult(seq) {
      const event = session.eventAt(seq)
      return event?.type === 'tool/result' && entries.get(seq)?.kind === 'original'
    },
    canCompactHistory(seq, minReentryTurns, allowImmediateHistorySummary = false) {
      const entry = entries.get(seq)
      if (entry === undefined || entry.kind === 'unknown-replacement') return false
      if (entry.kind === 'original') return true
      if (allowImmediateHistorySummary && entry.kind === 'history-summary') return true
      return entry.completedTurnsAfter >= minReentryTurns
    },
  }
}

function classifyEvent(session: Session, event: SessionEvent, knownToolSummary: boolean): SurfaceSourceKind {
  if (isHistorySummary(event)) return 'history-summary'
  if (event.type !== 'tool/result' || !isReplacementSurfaceEvent(event)) return 'original'
  if (wasPruned(session, event)) return 'tool-pruned'
  // Only the successful persistent audit identifies this package's tool
  // summaries. Session replacement metadata has no producer field, so an
  // unknown third-party replacement must remain protected rather than being
  // misrepresented as a successful tool summary.
  return knownToolSummary ? 'tool-summary' : 'unknown-replacement'
}

function isHistorySummary(event: SessionEvent): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source
  return source.kind === 'plugin' && isCompactCheckpointSource(source)
}

/** A pruner replacement is durably and unambiguously preceded by its price event. */
function wasPruned(session: Session, event: SessionEvent): boolean {
  const preceding = event.seq === 0 ? undefined : session.eventAt((event.seq - 1) as SessionSeq)
  if (preceding?.type !== 'compaction/prune') return false
  const sources = replacementSources(event)
  return sources.length === 1
    && preceding.data.shadowedSeqs.length === 1
    && preceding.data.shadowedSeqs[0] === sources[0]
}

function replacementSources(event: SessionEvent): readonly SessionSeq[] {
  return isReplacementSurfaceEvent(event) ? [...(event.sourceEventSeqs ?? [])] : []
}

function completedTurnsAfter(session: Session, replacement: SessionEvent): number {
  let count = 0
  for (let seq = replacement.seq + 1; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'turn/end' && event.data.reason?.kind === 'completed') count += 1
  }
  return count
}
