/**
 * Conservative deterministic tool-segment identification over a session
 * surface, re-implemented for `dsh-context-enhancement` from the MIT-licensed
 * Card5/6 migration delta of the official rc.1 tree.
 *
 * SOURCE: this file is a local copy of the working-tree Card5/6 addition
 * `packages/compaction/compaction/src/tool-segments.ts` (MIT, on top of tag
 * 0.1.2-rc.1 of the `deepseek-harness` repository). The upstream file lands in
 * the published package only after the migration ships; this standalone package
 * must not depend on that unshipped subpath, so the helper is copied here.
 * Provenance is recorded in THIRD_PARTY_NOTICES.md.
 *
 * A tool segment is a maximal same-turn surface run of assistant tool-call
 * messages and complete tool results that starts and ends at balanced tool-pair
 * cuts. Every parallel call of one assistant message stays together because the
 * run consumes the whole assistant node and its complete results, and an open
 * or incomplete trailing tail is excluded. Ordinary user messages, ordinary
 * assistant responses, runtime-context snapshots, compaction replacements, and
 * every other non-tool surface node interrupt a segment, and a run cannot cross
 * a turn. The segmenter infers no semantic objectives, data dependencies,
 * cross-turn causality, child-session semantics, or dependencies among parallel
 * tools; ambiguous work therefore remains in separate segments.
 *
 * @module dsh-context-enhancement/internal/compaction/tool-segments
 */

import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'
import type { SessionRead } from './tool-pairing.ts'

/** One balanced deterministic tool segment over contiguous current surface positions. */
export interface ToolSegment {
  /** Surface seq of the segment's first node. */
  readonly startSeq: SessionSeq
  /** Surface seq of the segment's last node. */
  readonly endSeq: SessionSeq
  /** Seqs of the segment's nodes in surface order (not necessarily sorted by value after replacements). */
  readonly seqs: readonly SessionSeq[]
  /** Turn that owns the whole segment. */
  readonly turn: number
}

/** A surface node a tool burst may contain. */
type ToolBurstNode = SessionEvent<'assistant/message'> | SessionEvent<'tool/result'>

/** One current surface node paired with its validated log event. */
interface SurfaceEntry {
  /** The node's surface seq. */
  readonly seq: SessionSeq
  /** The log event the surface seq names. */
  readonly event: SessionEvent
}

/**
 * Whether a surface node is an assistant message that asks for at least one tool.
 * @param event - the surface node event.
 * @returns true when the derived assistant message contains a tool-call block.
 */
function isToolCallAssistantMessage(event: SessionEvent): event is SessionEvent<'assistant/message'> {
  return event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'tool-call')
}

/**
 * Whether a surface node can belong to a tool burst: an assistant message that
 * asks for tools, or a tool result. Ordinary assistant responses, user messages
 * of every kind (including runtime-context snapshots and compaction
 * replacements), and every other non-tool surface node are not burst members.
 * @param event - the surface node event.
 * @returns true for a tool-call assistant message or a tool result.
 */
function isToolBurstNode(event: SessionEvent): event is ToolBurstNode {
  if (event.type === 'assistant/message') return isToolCallAssistantMessage(event)
  if (event.type === 'tool/result') return true
  return false
}

/** Read one burst member's owning turn from its payload. */
function turnOf(event: ToolBurstNode): number {
  return event.data.turn
}

/**
 * Snapshot the current surface as validated node/event pairs in surface order,
 * so every later indexed access is over a dense owned array.
 * @param session - session supplying the authoritative current surface.
 * @returns the current surface's node seqs and events in surface order.
 * @throws when a surface node has no matching log event (corrupt surface).
 */
function surfaceEntries(session: SessionRead): SurfaceEntry[] {
  return [...session.surface.nodes].map((seq) => {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) {
      throw new Error(`tool-segments: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    return { seq, event }
  })
}

/**
 * Enumerate the current surface's balanced deterministic tool segments in
 * surface order.
 *
 * Each maximal same-turn run of tool-burst nodes is scanned for balanced
 * tool-pair cuts. The emitted segment starts at the first run position whose
 * leading cut is balanced and ends at the last position whose trailing cut is
 * balanced, so a complete call/result pair is never split, parallel calls from
 * one assistant message stay together, and an open or incomplete trailing tail
 * (an unanswered assistant tool call) is excluded rather than emitted as a
 * partial segment. A run left open by an interrupt or an unanswered earlier
 * call emits no partial segment.
 * @param session - session supplying the authoritative current surface.
 * @returns the balanced tool segments in surface order.
 * @throws when a surface node has no matching log event or the surface is
 * otherwise corrupt (delegated to the tool-pairing predicates).
 */
export function toolSegments(session: SessionRead): ToolSegment[] {
  const surface = surfaceEntries(session)
  const segments: ToolSegment[] = []
  let index = 0
  while (index < surface.length) {
    // The scan index is bounded by the dense owned surface snapshot.
    const first = surface[index]!.event
    // A segment starts only at an assistant tool-call message. A tool result
    // whose call an interrupt separated from it is not a burst start.
    if (!isToolBurstNode(first) || first.type === 'tool/result') {
      index += 1
      continue
    }
    const turn = turnOf(first)
    // Consume the maximal same-turn tool-burst run.
    let runEnd = index + 1
    while (runEnd < surface.length) {
      // The scan index is bounded by the dense owned surface snapshot.
      const candidate = surface[runEnd]!.event
      if (!isToolBurstNode(candidate) || turnOf(candidate) !== turn) break
      runEnd += 1
    }
    // Trim the run to its longest balanced-tool span: start on a balanced
    // leading cut and stop at the last balanced trailing cut, leaving an open
    // tail or an unanswered earlier call unemitted.
    let firstBalancedIndex = -1
    let lastBalancedIndex = -1
    for (let cursor = index; cursor < runEnd; cursor += 1) {
      // The scan index is bounded by the dense owned surface snapshot.
      const seq = surface[cursor]!.seq
      if (firstBalancedIndex === -1 && toolPairingBalancedBefore(session, seq)) firstBalancedIndex = cursor
      if (toolPairingBalancedAfter(session, seq)) lastBalancedIndex = cursor
    }
    if (firstBalancedIndex !== -1 && lastBalancedIndex > firstBalancedIndex) {
      segments.push({
        // Indices were found within the dense snapshot run.
        startSeq: surface[firstBalancedIndex]!.seq,
        // Indices were found within the dense snapshot run.
        endSeq: surface[lastBalancedIndex]!.seq,
        seqs: surface.slice(firstBalancedIndex, lastBalancedIndex + 1).map(entry => entry.seq),
        turn,
      })
    }
    index = runEnd
  }
  return segments
}

/**
 * Find the balanced tool segment that owns a current surface node, for snapping
 * a caller-selected boundary to a whole segment.
 * @param session - session supplying the current surface.
 * @param seq - a current surface node seq.
 * @returns the owning segment, or null when the node belongs to no balanced segment.
 * @throws when the seq is absent from the current surface.
 */
export function toolSegmentAt(session: SessionRead, seq: SessionSeq): ToolSegment | null {
  if (!session.surface.nodes.includes(seq)) {
    throw new Error(`tool-segments: surface seq ${seq} not found`)
  }
  return toolSegments(session).find(segment =>
    segment.seqs.includes(seq)) ?? null
}
