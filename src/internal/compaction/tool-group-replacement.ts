import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
import { contentDigest, toolGroupFingerprint } from './tool-group-audit.ts'
import { reductionProvenance, shadowPriceWithProvenance } from './source-index.ts'
import { toolResultTextLength } from './tool-groups.ts'
import type { ToolGroup } from './tool-groups.ts'
import type { ToolGroupSummary } from './tool-group-summary.ts'

/** Pricing seam for the shared shadow-price protocol. */
export interface ToolGroupReplacementOptions {
  /**
   * Heuristic price of one shadowed tool result under the SAME fixed estimator
   * the session's token meter prices appends with. It is logged with the
   * shadow-price event, so a bounded replay fold can subtract the replaced
   * node's price without retaining per-node state.
   */
  readonly estimateTokens: (message: ToolResultMessage) => number
  /**
   * Invoked synchronously for each landed replacement, before the next group
   * member is attempted. A `session.append` failure mid-group leaves the
   * earlier replacements durable, so reporting them immediately lets the caller
   * exclude them from the same invocation's semantic pass even though the
   * returned result never arrives.
   */
  readonly onLanded?: (seq: SessionSeq) => void
}
export interface ToolGroupReplacementResult {
  readonly replacementSeqs: readonly SessionSeq[]
  readonly sourceSeqs: readonly SessionSeq[]
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
export function replaceToolGroup(
  session: Session,
  group: ToolGroup,
  summary: ToolGroupSummary,
  options: ToolGroupReplacementOptions,
): ToolGroupReplacementResult {
  const replacementSeqs: SessionSeq[] = []
  // The group's durable identity is one value for the whole pass: the same
  // fingerprint the audit schedules this group's work under.
  const groupId = toolGroupIdentity(session, group)
  const snapshot = group.toolResultSeqs.map(sourceSeq => {
    const event = session.eventAt(sourceSeq)
    if (event?.type !== 'tool/result') throw new Error(`tool-group-replacement: source seq ${sourceSeq} is no longer a tool result`)
    const item = summary.items.find(candidate => candidate.sourceSeq === sourceSeq)
    if (item === undefined) throw new Error(`tool-group-replacement: missing summary item for source seq ${sourceSeq}`)
    return { sourceSeq, event, item }
  })
  for (const { sourceSeq, event, item } of snapshot) {
    const original = event.data.message
    // The summary distills the node's text representation. The FIRST
    // tool-result content block carries the replacement text; every other
    // message-level block and every non-text block keeps its original place.
    const blockIndex = original.content.findIndex(block => block.type === 'tool-result')
    // A tool/result without any tool-result content block has no legal replacement
    // structure; the node stays raw exactly like a non-shrinking one.
    if (blockIndex === -1) continue
    const block = original.content[blockIndex]!
    // A result with no text at all — an empty content array, or only rich
    // blocks — has nothing to distill: fabricating a summary would grow the
    // node and produce an invalid replacement, so it stays raw with no
    // exception and no shadow-price event.
    if (toolResultTextLength(original.content) === 0) continue
    const text: ContentBlock = {
      type: 'text',
      text: formatSummary(item.summary, item.facts, item.files, item.errors, item.unresolved, sourceSeq),
    }
    // Preserve every non-text block of the replaced result: the summary only
    // distills the text, so images, attachments, and any other rich block ride
    // along after it in their original order instead of being dropped.
    const preserved = block.content.filter(inner => inner.type !== 'text')
    const content = original.content.map((messageBlock, index) => {
      // A non-tool-result message-level block rides along untouched.
      if (messageBlock.type !== 'tool-result') return messageBlock
      if (index === blockIndex) {
        return { ...messageBlock, content: [text, ...preserved] }
      }
      // A further tool-result block of the same node loses only its raw text
      // to the same distilled representation; its non-text blocks ride along.
      return { ...messageBlock, content: messageBlock.content.filter(inner => inner.type !== 'text') }
    })
    const message = freezeMessage<ToolResultMessage>({
      ...original,
      content: content as [typeof block],
    })
    // Per-node shrink guard: a replacement that would price EQUAL TO OR MORE
    // than the node it shadows must never land. The shadow-price protocol
    // would fold a reduction that never happened (the logged price describes
    // the original), and the surface would grow or stall without shrinking,
    // so the node keeps its raw original and stays eligible for the
    // deterministic pruner instead. A landed sibling does not excuse one
    // non-shrinking node: the guard is per node, and the skipped seq is simply
    // absent from the returned replacement seqs.
    const shadowedTokens = options.estimateTokens(original)
    if (options.estimateTokens(message) >= shadowedTokens) continue
    // Shadow-price protocol: the metering event states this exact replaced
    // range's price and the replacement MUST follow synchronously adjacent, so
    // the bounded surface fold subtracts the original price instead of folding
    // an unpriced replacement neutrally. The same event carries this reduction's
    // durable provenance: the kind, the covered range, the whole group's source
    // set, the group identity, the observed replace generation, and a digest
    // binding all of it to the replacement text below. A restarted or replayed
    // Session therefore classifies the node as `tool-summary` from the Session
    // log alone, with no audit document taking part.
    const provenance = reductionProvenance({
      kind: 'tool-summary',
      coveredSeqs: [sourceSeq],
      sourceEventSeqs: [...group.sourceSeqs],
      groupId,
      generation: session.surface.replaceGeneration,
      content: message.content,
    })
    session.append('compaction/prune', shadowPriceWithProvenance(sourceSeq, shadowedTokens, provenance))
    const replacement = session.append('tool/result', {
      ...event.data,
      message,
    }, {
      surfaceOp: { op: 'replace', start: sourceSeq, end: sourceSeq },
      sourceEventSeqs: [sourceSeq],
    })
    replacementSeqs.push(replacement.seq)
    options.onLanded?.(replacement.seq)
  }
  return { replacementSeqs, sourceSeqs: [...group.sourceSeqs] }
}

/**
 * Durable identity of one selected tool group.
 *
 * It is the SAME fingerprint `BasicCompactionEngine.toolGroupFingerprint`
 * computes for the audit — same lifecycle identity, same source seqs, same call
 * ids, same event types, same content digest, same schema version — rebuilt here
 * from the group and the Session so the provenance written into the log can
 * always be correlated with the audit row that schedules this group's work. The
 * equality is asserted by `tests/compaction-tool-provenance-replay.spec.ts`.
 *
 * It is derived rather than passed in on purpose: the replacement writer must
 * not be able to claim an identity its caller invented, and the two producers of
 * this value agree because they read the same durable inputs.
 * @param session - session owning the group's events.
 * @param group - the selected group.
 * @returns the group's durable fingerprint.
 */
function toolGroupIdentity(session: Session, group: ToolGroup): string {
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

function formatSummary(
  summary: string,
  facts: readonly string[],
  files: readonly string[],
  errors: readonly string[],
  unresolved: readonly string[],
  sourceSeq: SessionSeq,
): string {
  return [
    '[tool group summary]',
    `Result: ${summary}`,
    `Facts: ${facts.length === 0 ? '(none)' : facts.join('; ')}`,
    `Files: ${files.length === 0 ? '(none)' : files.join(', ')}`,
    `Errors: ${errors.length === 0 ? '(none)' : errors.join('; ')}`,
    `Unresolved: ${unresolved.length === 0 ? '(none)' : unresolved.join('; ')}`,
    `Source event: seq=${sourceSeq}`,
    '[/tool group summary]',
  ].join('\n')
}
