/**
 * Tool-stage debt and content robustness regressions from the real-session
 * replay.
 *
 * The replayed build vetoed every pressure pass with `tool-stage-deferred`
 * while no actor could act: the pending-work probe used a different group cap
 * than the summarize actor, measured only the first content block of a result,
 * and reported pending for spans it could not even resolve. These specs pin the
 * repaired contract:
 *
 * - the pending probe and `selectToolGroups` judge the SAME span, eligibility,
 *   code-point text metric, max-group cap, and source classification, so
 *   pending work is always work an actor will perform;
 * - pending-shaped content no actor can act on (an unresolvable span, or
 *   groups the audit already refuses) is reported as INERT debt: the pressure
 *   pass proceeds and logs a non-blocking reason instead of deferring forever;
 * - text length counts Unicode code points across EVERY text block of a
 *   multi-block result — the metric the deterministic pruner reduces with;
 * - empty content arrays and multi-block results move through the pending
 *   check, the pruner, and group replacement without throwing, and a result
 *   with nothing to distill stays raw.
 */

import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import type { ToolStageDebt } from '../src/compaction-basic.ts'
import { resolveConfig } from '../src/internal/compaction/config.ts'
import type { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup, ToolGroupSelectionOptions } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import type { ToolGroupAuditRecord } from '../src/internal/compaction/tool-group-audit.ts'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { PRUNE_MARKER, resolveConfig as resolvePrunerConfig } from '../src/internal/compaction/pruner-config.ts'

const SURFACE = { surfaceOp: 'append' as const }
type SourceIndex = ReturnType<typeof buildSurfaceSourceIndex>

function userPrompt(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
}

function toolStep(session: Session, turn: number, step: number, callId: string, content: ContentBlock[]): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({ callId: ToolCallId(callId), content, isError: false }),
  }, SURFACE)
}

function parallelToolStep(session: Session, turn: number, step: number, callIds: readonly string[], text: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: callIds.map(id => ({ type: 'tool-call' as const, id: ToolCallId(id), name: 'bash', arguments: '{}' })),
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  for (const callId of callIds) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false }),
    }, SURFACE)
  }
}

function reply(session: Session, turn: number, step: number): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'interlude' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
}

/** A production-shaped pruner: override thresholds, keep the real methods. */
function pruner(overrides: { thresholdChars?: number; headChars?: number; tailChars?: number } = {}): ToolResultPruner {
  return Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
    config: resolvePrunerConfig({ thresholdChars: 64, headChars: 8, tailChars: 8, ...overrides }),
    ctx: { tokenMeter: { estimateMessage: () => 7 } },
  })
}

/** The engine's production-default pruner (thresholdChars 8192). */
function defaultPruner(): ToolResultPruner {
  return Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
    config: resolvePrunerConfig(),
    ctx: { tokenMeter: { estimateMessage: () => 7 } },
  })
}

function summaryFor(group: ToolGroup): ToolGroupSummary {
  return {
    version: 1,
    groupSummary: 'done',
    items: group.toolResultSeqs.map(sourceSeq => ({
      sourceSeq,
      summary: 'done',
      facts: [],
      files: [],
      identifiers: [],
      errors: [],
      unresolved: [],
    })),
    groupErrors: [],
    unresolved: [],
  }
}

interface DebtHarnessOptions {
  /** Durable audit records the probe classifies groups against. */
  records?: ToolGroupAuditRecord[]
  estimateMessage?: (message: { source?: { kind?: string } }) => number
  inputCapTokens?: number
  prune?: ToolResultPruner
}

/**
 * Wire the REAL pending-work probe (and the actor's own selection-option
 * factory) onto a minimal engine fake: only configuration and I/O are faked,
 * so the probe under test is the production one.
 */
function debtHarness(session: Session, options: DebtHarnessOptions = {}): {
  probe: (start?: SessionSeq, end?: SessionSeq) => ToolStageDebt
  select: (start?: SessionSeq, end?: SessionSeq) => ToolGroup[]
  fingerprintOf: (group: ToolGroup) => string
} {
  const config = resolveConfig({ toolGroupSummarizer: { enabled: true } })
  const fake = {
    config,
    ctx: {
      tokenMeter: {
        estimateMessage: options.estimateMessage
          ?? ((message: { source?: { kind?: string } }) => message.source?.kind === 'tool' ? 3_000 : 100),
      },
    },
    toolGroupAuditStore: options.records === undefined
      ? undefined
      : { recordsForSession: () => options.records },
  }
  const engine = fake as unknown as BasicCompactionEngine
  const prototype = BasicCompactionEngine.prototype as unknown as {
    sourceIndex: (current: Session) => SourceIndex
    toolGroupFingerprint: (current: Session, group: ToolGroup) => string
    cappedMaxGroupTokens: (maxGroupTokens: number, inputCapTokens: number | undefined) => number
    toolGroupSelectionOptions: (
      olderRange: { start: SessionSeq; end: SessionSeq },
      inputCapTokens: number | undefined,
      index: SourceIndex,
    ) => ToolGroupSelectionOptions
    hasPendingToolIntermediateWork: (
      current: Session,
      start: SessionSeq,
      end: SessionSeq,
      prune: ToolResultPruner | undefined,
      inputCapTokens?: number,
    ) => ToolStageDebt
  }
  const seams = engine as unknown as Record<string, unknown>
  seams.sourceIndex = (current: Session) => prototype.sourceIndex.call(engine, current)
  seams.toolGroupFingerprint = (current: Session, group: ToolGroup) =>
    prototype.toolGroupFingerprint.call(engine, current, group)
  seams.cappedMaxGroupTokens = (maxGroupTokens: number, inputCapTokens: number | undefined) =>
    prototype.cappedMaxGroupTokens.call(engine, maxGroupTokens, inputCapTokens)
  seams.toolGroupSelectionOptions = (
    olderRange: { start: SessionSeq; end: SessionSeq },
    inputCapTokens: number | undefined,
    index: SourceIndex,
  ) => prototype.toolGroupSelectionOptions.call(engine, olderRange, inputCapTokens, index)
  const nodes = [...session.surface.nodes]
  const span = (): { start: SessionSeq; end: SessionSeq } => ({ start: nodes[0]!, end: nodes.at(-1)! })
  return {
    probe: (start?: SessionSeq, end?: SessionSeq) => {
      const range = span()
      return prototype.hasPendingToolIntermediateWork.call(
        engine,
        session,
        start ?? range.start,
        end ?? range.end,
        options.prune,
        options.inputCapTokens,
      )
    },
    select: (start?: SessionSeq, end?: SessionSeq) => {
      const range = span()
      return selectToolGroups(session, prototype.toolGroupSelectionOptions.call(
        engine,
        { start: start ?? range.start, end: end ?? range.end },
        options.inputCapTokens,
        prototype.sourceIndex.call(engine, session),
      ))
    },
    fingerprintOf: (group: ToolGroup) => prototype.toolGroupFingerprint.call(engine, session, group),
  }
}

function fallbackRecord(session: Session, group: ToolGroup, fingerprint: string): ToolGroupAuditRecord {
  return {
    requestId: `tg-${fingerprint.slice(0, 8)}`,
    sessionId: session.id,
    fingerprint,
    sourceSeqs: [...group.sourceSeqs],
    surfaceGeneration: 0,
    provider: 'mock',
    model: 'mock',
    schemaVersion: 1,
    status: 'fallback',
  }
}

describe('tool group text metric', () => {
  it('selects a production-default group from a multi-block 60,000-code-point result', () => {
    const session = Session.create(SessionId('debt-metric-production-default'))
    userPrompt(session)
    // Each result carries 60,000 code points across THREE content blocks with a
    // non-text block between the text blocks.
    for (const [step, callId] of [[1, 'a'], [2, 'b']] as const) {
      toolStep(session, 1, step, callId, [
        { type: 'text', text: 'a'.repeat(30_000) },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'b'.repeat(30_000) },
      ])
    }
    const nodes = [...session.surface.nodes]
    // Production defaults: minGroupResults 2, minGroupChars 12_000, minGroupTokens
    // 2_000, maxGroupTokens 12_000, maxGroups 2. Only the estimator seam is passed.
    const groups = selectToolGroups(session, {
      olderRange: { start: nodes[0]!, end: nodes.at(-1)! },
      estimateTokens: () => 2_500,
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.toolResultSeqs).toHaveLength(2)
    expect(groups[0]!.toolResultSeqs.every(seq => {
      const event = session.eventAt(seq)
      return event?.type === 'tool/result'
    })).toBe(true)
  })

  it('counts every text block rather than the ContentBlock array length', () => {
    const session = Session.create(SessionId('debt-metric-block-count'))
    userPrompt(session)
    for (const [step, callId] of [[1, 'a'], [2, 'b']] as const) {
      toolStep(session, 1, step, callId, [
        { type: 'text', text: 'a'.repeat(20_000) },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'b'.repeat(20_000) },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'c'.repeat(20_000) },
      ])
    }
    const nodes = [...session.surface.nodes]
    const options = {
      olderRange: { start: nodes[0]!, end: nodes.at(-1)! },
      minGroupChars: 60_001,
      estimateTokens: () => 2_500,
    }
    // 120,000 code points across six text blocks qualify; a BLOCK-COUNT metric
    // (6) could never satisfy a 60,001-character floor.
    expect(selectToolGroups(session, options)).toHaveLength(1)
  })

  it('counts Unicode code points rather than UTF-16 code units', () => {
    const session = Session.create(SessionId('debt-metric-code-points'))
    userPrompt(session)
    // '𝕏' is one code point priced as two UTF-16 code units: 40,000 code points
    // per result, 80,000 in the group, but 160,000 UTF-16 units.
    for (const [step, callId] of [[1, 'a'], [2, 'b']] as const) {
      toolStep(session, 1, step, callId, [{ type: 'text', text: '𝕏'.repeat(40_000) }])
    }
    const nodes = [...session.surface.nodes]
    const options = {
      olderRange: { start: nodes[0]!, end: nodes.at(-1)! },
      minGroupChars: 90_000,
      estimateTokens: () => 2_500,
    }
    // A UTF-16 metric would select this group; the code-point metric refuses it.
    expect(selectToolGroups(session, options)).toEqual([])
  })
})

describe('pending probe and selector agreement', () => {
  it('agrees with the selector on a multi-block 60,000-code-point fixture', () => {
    const session = Session.create(SessionId('debt-agree-large'))
    userPrompt(session)
    for (const [step, callId] of [[1, 'a'], [2, 'b']] as const) {
      toolStep(session, 1, step, callId, [
        { type: 'text', text: 'a'.repeat(30_000) },
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'b'.repeat(30_000) },
      ])
    }
    const debt = debtHarness(session, { prune: defaultPruner() })
    // The actor's own option factory selects the group...
    expect(debt.select()).toHaveLength(1)
    // ...and the probe reports the same fixture as actionable through BOTH
    // actors: the deterministic pruner (60,000 > 8,192 thresholdChars) and the
    // group summarizer (a fresh, all-eligible selected group behind a live
    // audit store).
    expect(debt.probe()).toBe('actionable')
    expect(debtHarness(session, { records: [] }).probe()).toBe('actionable')
  })

  it('reports inert debt when every cap-window group is audit-refused', () => {
    const session = Session.create(SessionId('debt-agree-refused'))
    userPrompt(session)
    // Three qualifying groups (two parallel results each, separated by replies);
    // maxGroupsPerPass 2 means the actor's cap window holds only the first two.
    parallelToolStep(session, 1, 1, ['a1', 'a2'], 'x'.repeat(7_000))
    reply(session, 1, 2)
    parallelToolStep(session, 1, 3, ['b1', 'b2'], 'y'.repeat(7_000))
    reply(session, 1, 4)
    parallelToolStep(session, 1, 5, ['c1', 'c2'], 'z'.repeat(7_000))
    const debt = debtHarness(session)
    const capWindow = debt.select()
    expect(capWindow).toHaveLength(2)
    // The fixture really does hold a fresh, selectable group beyond the cap.
    const nodes = [...session.surface.nodes]
    expect(selectToolGroups(session, {
      olderRange: { start: nodes[0]!, end: nodes.at(-1)! },
      maxGroups: 3,
      estimateTokens: event => event.type === 'tool/result' ? 3_000 : 100,
    })).toHaveLength(3)
    // Refuse exactly the two cap-window groups with terminal audit records.
    const records = capWindow.map(group => fallbackRecord(session, group, debt.fingerprintOf(group)))
    const refused = debtHarness(session, { records })
    expect(refused.select()).toHaveLength(2)
    // The cap window holds no actionable group, so the probe must NOT defer the
    // pressure pass: the debt is pending-shaped but inert. The historical probe
    // (maxGroups: the whole span) saw the fresh third group and vetoed forever.
    expect(refused.probe()).toBe('inert')
  })

  it('never reports pending when the group/input cap leaves zero candidates', () => {
    const session = Session.create(SessionId('debt-agree-over-cap'))
    userPrompt(session)
    parallelToolStep(session, 1, 1, ['a1', 'a2'], 'x'.repeat(7_000))
    reply(session, 1, 2)
    parallelToolStep(session, 1, 3, ['b1', 'b2'], 'y'.repeat(7_000))
    const uncapped = debtHarness(session)
    expect(uncapped.select()).toHaveLength(2)
    // The envelope input cap narrows maxGroupTokens to 1,000: no chunk of the
    // run fits, the selector returns zero candidates, and the probe must agree
    // that nothing is actionable instead of deferring the pass forever.
    const capped = debtHarness(session, { inputCapTokens: 1_000 })
    expect(capped.select()).toEqual([])
    expect(capped.probe()).toBe('none')
  })

  it('treats an unresolvable span as inert instead of pending', () => {
    const session = Session.create(SessionId('debt-unresolvable'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [{ type: 'text', text: 'x'.repeat(7_000) }])
    const debt = debtHarness(session)
    // A span naming no current surface node cannot hold inspectable work; the
    // historical probe returned `true` here and vetoed with zero candidates.
    expect(debt.probe(9_999 as SessionSeq, 9_999 as SessionSeq)).toBe('inert')
  })
})

describe('empty content robustness', () => {
  it('moves an empty content array through the pending check without pending work', () => {
    const session = Session.create(SessionId('debt-empty-probe'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [])
    const debt = debtHarness(session, { prune: defaultPruner() })
    expect(debt.probe()).toBe('none')
    // A large sibling result still drives the verdict; the empty one must not
    // crash the pass or suppress it.
    const withLarge = Session.create(SessionId('debt-empty-plus-large'))
    userPrompt(withLarge)
    toolStep(withLarge, 1, 1, 'a', [])
    toolStep(withLarge, 1, 2, 'b', [{ type: 'text', text: 'x'.repeat(20_000) }])
    const large = debtHarness(withLarge, { prune: defaultPruner() })
    expect(large.select()).toHaveLength(1)
    expect(large.probe()).toBe('actionable')
  })

  it('leaves an empty content array raw through the pruner without throwing', () => {
    const session = Session.create(SessionId('debt-empty-prune'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [])
    const nodes = [...session.surface.nodes]
    const result = pruner().pruneSession(session, { olderRange: { start: nodes[0]!, end: nodes.at(-1)! } })
    expect(result.pruned).toEqual([])
    // The raw node is untouched.
    const event = session.eventAt(nodes[2]!)
    expect(event?.type).toBe('tool/result')
    if (event?.type !== 'tool/result') throw new Error('expected the tool result')
    expect(event.data.message.content[0]!.content).toEqual([])
  })

  it('prunes only the text-bearing sibling of an empty result', () => {
    const session = Session.create(SessionId('debt-empty-mixed-prune'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [])
    toolStep(session, 1, 2, 'b', [{ type: 'text', text: 'x'.repeat(200) }])
    const nodes = [...session.surface.nodes]
    const result = pruner().pruneSession(session, { olderRange: { start: nodes[0]!, end: nodes.at(-1)! } })
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual([nodes[4]])
    expect(result.pruned[0]!.charsBefore).toBe(200)
  })
})

describe('deterministic pruning of multi-block results', () => {
  it('spans the removed window across every text block and keeps the non-text block', () => {
    const session = Session.create(SessionId('debt-prune-multiblock'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [
      { type: 'text', text: 'a'.repeat(100) },
      { type: 'reasoning', text: 'hidden-thoughts' },
      { type: 'text', text: 'b'.repeat(100) },
    ])
    const nodes = [...session.surface.nodes]
    const result = pruner().pruneSession(session, { olderRange: { start: nodes[0]!, end: nodes.at(-1)! } })
    expect(result.pruned).toHaveLength(1)
    const entry = result.pruned[0]!
    expect(entry.charsBefore).toBe(200)
    expect(entry.charsAfter).toBeLessThan(entry.charsBefore)
    expect(entry.charsAfter).toBeLessThanOrEqual(64)
    const replacement = session.eventAt(entry.replacementSeq)
    if (replacement?.type !== 'tool/result') throw new Error('expected the replacement')
    const inner = replacement.data.message.content[0]!.content
    expect(inner).toHaveLength(3)
    const [head, reasoning, tail] = inner
    if (head?.type !== 'text' || tail?.type !== 'text') throw new Error('expected text blocks around the non-text block')
    // The non-text block rides along verbatim between the two pruned texts.
    expect(reasoning).toEqual({ type: 'reasoning', text: 'hidden-thoughts' })
    expect(head.text.startsWith('a'.repeat(8))).toBe(true)
    expect(tail.text).toBe('b'.repeat(8))
    // Exactly one marker for the whole message, not one per text block.
    expect((head.text + tail.text).split(PRUNE_MARKER)).toHaveLength(2)
  })
})

describe('group replacement block preservation', () => {
  it('keeps non-text blocks while replacing the summarized text', () => {
    const session = Session.create(SessionId('debt-replace-multiblock'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [
      { type: 'text', text: 'large a output' },
      { type: 'reasoning', text: 'trace-a' },
      { type: 'text', text: 'tail a output' },
    ])
    toolStep(session, 1, 2, 'b', [
      { type: 'text', text: 'large b output' },
      { type: 'reasoning', text: 'trace-b' },
    ])
    const nodes = [...session.surface.nodes]
    const group = selectToolGroups(session, {
      olderRange: { start: nodes[0]!, end: nodes.at(-1)! },
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      estimateTokens: () => 1,
    })[0]!
    const shrinkPrice = {
      estimateTokens: (message: any) => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 1 : 10
      },
    }
    const result = replaceToolGroup(session, group, summaryFor(group), shrinkPrice)
    expect(result.replacementSeqs).toHaveLength(2)
    for (const [index, replacementSeq] of result.replacementSeqs.entries()) {
      const replacement = session.eventAt(replacementSeq)
      if (replacement?.type !== 'tool/result') throw new Error('expected the replacement')
      const message = replacement.data.message
      // All original message content blocks survive: the single tool-result
      // block keeps its identity (call correlation) and position.
      expect(message.content).toHaveLength(1)
      expect(String(message.content[0]!.toolCallId)).toBe(index === 0 ? 'a' : 'b')
      const inner = message.content[0]!.content
      // The summarized text leads; the non-text block rides along after it.
      expect(inner).toHaveLength(2)
      const [summary, reasoning] = inner
      if (summary?.type !== 'text') throw new Error('expected the summary text block')
      expect(summary.text).toContain('[tool group summary]')
      expect(reasoning).toEqual({ type: 'reasoning', text: index === 0 ? 'trace-a' : 'trace-b' })
    }
  })

  it('keeps a result with empty content raw without an exception or shadow event', () => {
    const session = Session.create(SessionId('debt-replace-empty'))
    userPrompt(session)
    toolStep(session, 1, 1, 'a', [])
    toolStep(session, 1, 2, 'b', [{ type: 'text', text: 'large b' }])
    const nodes = [...session.surface.nodes]
    const group = selectToolGroups(session, {
      olderRange: { start: nodes[0]!, end: nodes.at(-1)! },
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      estimateTokens: () => 1,
    })[0]!
    const before = session.seq
    const result = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: (message: any) => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 1 : 10
      },
    })
    // Only the text-bearing result is replaced; the empty one contributes no
    // replacement, no shadow-price event, and no exception.
    expect(result.replacementSeqs).toHaveLength(1)
    expect(session.seq).toBe(before + 2)
    const emptyEvent = session.eventAt(nodes[2]!)
    expect(emptyEvent?.type).toBe('tool/result')
    if (emptyEvent?.type !== 'tool/result') throw new Error('expected the empty result')
    expect(emptyEvent.data.message.content[0]!.content).toEqual([])
  })
})
