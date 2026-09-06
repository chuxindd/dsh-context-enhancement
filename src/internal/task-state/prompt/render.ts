/**
 * Deterministic UTF-8-byte-bounded rendering of one committed task-state stable
 * for the main model. The renderer is a pure function of the stable plus the
 * deployment's byte budget: it never reads storage, consults a Session, appends
 * an event, or awaits, and it never mutates or re-authorizes the stable.
 * Truncation drops whole lines from the tail and appends a fixed marker, so no
 * UTF-8 codepoint is ever split and the returned text always fits the budget.
 * @module dsh-context-enhancement/internal/task-state/prompt/render
 */

import type { TaskStateStable } from '../contract/types.ts'

const encoder = new TextEncoder()

/** Fixed model-visible marker appended when a bounded render dropped any line. */
export const TASK_STATE_TRUNCATION_MARKER = '[Task-state snapshot truncated; the committed durable state remains authoritative.]'

/** One stable's kinded entry-list key, in the canonical render order. */
type KindedKey = 'facts' | 'decisions' | 'constraints' | 'risks'

/** Ordered list sections of one stable, each with its header line. */
const KINDED: readonly (readonly [string, KindedKey])[] = [
  ['Facts:', 'facts'],
  ['Decisions:', 'decisions'],
  ['Constraints:', 'constraints'],
  ['Risks:', 'risks'],
]

/** Whether any list section of the stable carries content. */
function hasListContent(stable: TaskStateStable): boolean {
  return stable.facts.length > 0 || stable.decisions.length > 0
    || stable.constraints.length > 0 || stable.risks.length > 0
    || stable.evidence.length > 0 || stable.todoReferences.length > 0
}

/**
 * The deterministic ordered lines of one stable's rendering, before bounding.
 *
 * The header (revision, source cursor, digest) always renders. Continuation
 * state comes next so the actionable current objective, focus, open work, and
 * next actions survive a head-retained truncation; the long-lived kinded lists,
 * evidence, and TODO references follow.
 */
function linesOf(stable: TaskStateStable): string[] {
  const lines = [
    `Durable task state (revision ${stable.revision}, source event ${stable.sourceCursor}, digest ${stable.digest}).`,
  ]
  const continuation = stable.continuation
  const hasContinuation = continuation.currentObjective !== ''
    || continuation.currentFocus !== ''
    || continuation.openWork.length > 0
    || continuation.nextActions.length > 0
  if (continuation.currentObjective !== '') {
    lines.push(`Current objective: ${continuation.currentObjective}`)
  }
  if (continuation.currentFocus !== '') {
    lines.push(`Current focus: ${continuation.currentFocus}`)
  }
  if (continuation.openWork.length > 0) {
    lines.push('Open work:')
    for (const item of continuation.openWork) lines.push(`- ${item}`)
  }
  if (continuation.nextActions.length > 0) {
    lines.push('Next actions:')
    for (const item of continuation.nextActions) lines.push(`- ${item}`)
  }
  if (!hasContinuation && !hasListContent(stable)) return lines
  if (hasListContent(stable)) {
    lines.push('')
    for (const [header, key] of KINDED) {
      const entries = stable[key]
      if (entries.length === 0) continue
      lines.push(header)
      for (const entry of entries) lines.push(`- ${entry.content}`)
    }
    if (stable.evidence.length > 0) {
      lines.push('Evidence:')
      for (const reference of stable.evidence) {
        lines.push(`- ${reference.note} (session event ${reference.seq})`)
      }
    }
    if (stable.todoReferences.length > 0) {
      lines.push('TODO references:')
      for (const reference of stable.todoReferences) {
        lines.push(`- ${reference.content} (session event ${reference.seq})`)
      }
    }
  }
  return lines
}

/**
 * Render one committed stable deterministically within a UTF-8 byte budget.
 *
 * When the full render fits, it is returned verbatim. Otherwise whole lines are
 * taken from the head while the next line still fits beside the fixed
 * truncation marker, and the marker is appended to whatever prefix survived, so
 * the result never exceeds `maxBytes`, never splits a codepoint, and never
 * pretends to be complete. When even the first line cannot fit beside the
 * marker, an empty string is returned.
 * @param stable - the committed stable to present; its authority is untouched.
 * @param maxBytes - maximum UTF-8 bytes of the returned text; must be a
 *   non-negative safe integer.
 * @returns the bounded model-facing rendering of the stable.
 */
export function renderTaskStateSnapshot(stable: TaskStateStable, maxBytes: number): string {
  const lines = linesOf(stable)
  const full = lines.join('\n')
  if (encoder.encode(full).byteLength <= maxBytes) return full

  const markerBytes = encoder.encode(TASK_STATE_TRUNCATION_MARKER).byteLength
  let text = ''
  for (const line of lines) {
    const candidate = text.length === 0 ? line : `${text}\n${line}`
    // A truncated render always ends in `\n<marker>` once a prefix is kept.
    if (encoder.encode(candidate).byteLength > maxBytes - markerBytes - 1) break
    text = candidate
  }
  if (text.length === 0) return ''
  return `${text}\n${TASK_STATE_TRUNCATION_MARKER}`
}
