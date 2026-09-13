/**
 * Partial-landing and served-provenance coverage for the envelope-aware pass.
 *
 * Two review findings share one root cause: a durable reduction was only
 * reported to the caller AFTER the whole pass returned, so a failure in the
 * middle of the pass lost track of replacements that had already landed.
 *
 * - `pruneSession` and `replaceToolGroup` now report every landed replacement
 *   through a callback the moment it exists.
 * - A tool-group audit record left `open` because its success commit failed
 *   still proves its reduction landed, so its replacement seqs keep
 *   tool-summary provenance and the group is not outstanding work.
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { resolveConfig as resolvePrunerConfig } from '../src/internal/compaction/pruner-config.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'
import {
  isServedAudit,
  servedReplacementSeqs,
  shouldAttemptToolGroupSummary,
} from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditRecord } from '../src/internal/compaction/tool-group-audit.ts'

const SURFACE = { surfaceOp: 'append' as const }
const THRESHOLD = 64

function pruner(): ToolResultPruner {
  return Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
    config: resolvePrunerConfig({ thresholdChars: THRESHOLD, headChars: 8, tailChars: 8 }),
    ctx: { tokenMeter: { estimateMessage: () => 7 } },
  })
}

function addToolStep(session: Session, turn: number, step: number, callId: string, text: string): SessionSeq {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  return session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, SURFACE).seq
}

function groupSession(id: string): { session: Session; sourceSeqs: SessionSeq[]; group: ToolGroup } {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
  const sourceSeqs: SessionSeq[] = []
  for (const [step, callId] of [[1, 'a'], [2, 'b']] as const) {
    sourceSeqs.push(addToolStep(session, 1, step, callId, `large ${callId}`))
  }
  const group = selectToolGroups(session, {
    minGroupResults: 1,
    minGroupChars: 1,
    minGroupTokens: 1,
    maxGroupTokens: 100,
    estimateTokens: () => 1,
  })[0]!
  return { session, sourceSeqs, group }
}

function summaryFor(group: ToolGroup): ToolGroupSummary {
  return {
    version: 1,
    groupSummary: 'done',
    items: group.toolResultSeqs.map(sourceSeq => ({
      sourceSeq,
      callId: 'a',
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

function record(overrides: Partial<ToolGroupAuditRecord>): ToolGroupAuditRecord {
  return {
    requestId: 'req',
    sessionId: 'session',
    fingerprint: 'fp',
    sourceSeqs: [],
    surfaceGeneration: 0,
    provider: 'mock',
    model: 'm',
    schemaVersion: 1,
    status: 'open',
    ...overrides,
  }
}

describe('partial replacement landing', () => {
  it('reports each pruned replacement before the next candidate is attempted', () => {
    const session = Session.create(SessionId('partial-prune'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    const first = addToolStep(session, 1, 1, 'a', 'a'.repeat(THRESHOLD + 20))
    const second = addToolStep(session, 1, 2, 'b', 'b'.repeat(THRESHOLD + 20))

    const seen: Array<{ original: SessionSeq; replacement: SessionSeq; onSurface: boolean }> = []
    const stop = new Error('simulated mid-pass failure')
    expect(() => pruner().pruneSession(session, {
      candidateSeqs: [first, second],
      onReplacement: entry => {
        seen.push({
          original: entry.originalSeq,
          replacement: entry.replacementSeq,
          onSurface: session.surface.nodes.includes(entry.replacementSeq),
        })
        throw stop
      },
    })).toThrow(stop)

    // The callback saw the first replacement only, and it was already durable at
    // that moment. The second original was never replaced.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.original).toBe(first)
    expect(seen[0]!.onSurface).toBe(true)
    expect(session.surface.nodes).toContain(seen[0]!.replacement)
    expect(session.surface.nodes).toContain(second)
  })

  it('reports every group replacement as it lands, in order', () => {
    const { session, group } = groupSession('partial-group')
    const landed: Array<{ seq: SessionSeq; onSurface: boolean }> = []
    const result = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: message => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 1 : 10
      },
      onLanded: seq => landed.push({ seq, onSurface: session.surface.nodes.includes(seq) }),
    })
    expect(landed.map(entry => entry.seq)).toEqual([...result.replacementSeqs])
    expect(landed.every(entry => entry.onSurface)).toBe(true)
  })
})

describe('served audit provenance', () => {
  it('treats an open record with landed replacements as served evidence', () => {
    const landed = record({ status: 'open', replacementSeqs: [7 as SessionSeq] })
    const interrupted = record({ status: 'open' })
    const success = record({ status: 'success', replacementSeqs: [11 as SessionSeq] })
    const failed = record({ status: 'failure', replacementSeqs: [13 as SessionSeq] })
    expect(isServedAudit(landed)).toBe(true)
    expect(isServedAudit(interrupted)).toBe(false)
    expect(isServedAudit(success)).toBe(true)
    // A terminal failure is written before any replacement exists, so it never
    // proves a landed reduction even if a stray record carries seqs.
    expect(isServedAudit(failed)).toBe(false)
    expect(servedReplacementSeqs([landed, interrupted, success, failed])).toEqual([7, 11])
  })

  it('does not re-attempt a group whose replacements already landed', () => {
    // An interrupted open record is still recoverable...
    expect(shouldAttemptToolGroupSummary([record({ status: 'open' })], 'fp')).toBe(true)
    // ...but one that already landed its reduction is served, not pending.
    expect(shouldAttemptToolGroupSummary(
      [record({ status: 'open', replacementSeqs: [7 as SessionSeq] })],
      'fp',
    )).toBe(false)
  })

  it('classifies a replacement from its durable session provenance and never from the audit', () => {
    const { session, group } = groupSession('served-source-index')
    const replacement = replaceToolGroup(session, group, summaryFor(group), {
      estimateTokens: message => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 1 : 10
      },
    }).replacementSeqs[0]!
    const sourceIndex = (BasicCompactionEngine.prototype as unknown as {
      sourceIndex: (session: Session) => {
        entry: (seq: SessionSeq) => { kind: string }
        canCompactHistory: (seq: SessionSeq, minReentryTurns: number, allowImmediateReentry?: boolean) => boolean
      }
    }).sourceIndex

    const withOpenAudit = sourceIndex.call({
      toolGroupAuditStore: {
        recordsForSession: () => [record({ status: 'open', replacementSeqs: [replacement] })],
      },
    }, session)
    expect(withOpenAudit.entry(replacement).kind).toBe('tool-summary')
    expect(withOpenAudit.canCompactHistory(replacement, 1, true)).toBe(true)
    // WITHOUT the audit the replacement must classify identically: the durable
    // provenance the producer wrote beside the shadow price is the authority, not
    // the loss of an audit document. This is the R-P2-3 regression — the old
    // classifier downgraded a committed summary to `tool-pruned` here.
    const withoutAudit = sourceIndex.call({ toolGroupAuditStore: undefined }, session)
    expect(withoutAudit.entry(replacement).kind).toBe('tool-summary')
    expect(withoutAudit.canCompactHistory(replacement, 1, true)).toBe(true)

    // A replacement with no durable provenance stays a protected unknown
    // replacement and cannot re-enter immediately.
    const bare = groupSession('served-source-index-bare')
    const original = bare.sourceSeqs[0]!
    const originalEvent = bare.session.eventAt(original)
    if (originalEvent?.type !== 'tool/result') throw new Error('expected an original tool result')
    const bareReplacement = bare.session.append('tool/result', originalEvent.data, {
      surfaceOp: { op: 'replace', start: original, end: original },
      sourceEventSeqs: [original],
    }).seq
    const bareIndex = sourceIndex.call({ toolGroupAuditStore: undefined }, bare.session)
    expect(bareIndex.entry(bareReplacement).kind).toBe('unknown-replacement')
    expect(bareIndex.canCompactHistory(bareReplacement, 1, true)).toBe(false)
    // An open audit row that CLAIMS a served summary cannot create the kind: the
    // claim contradicts the (absent) durable provenance, so the node fails closed
    // rather than being promoted to a relaxed tool summary.
    const auditedBare = sourceIndex.call({
      toolGroupAuditStore: {
        recordsForSession: () => [record({ status: 'open', replacementSeqs: [bareReplacement] })],
      },
    }, bare.session)
    expect(auditedBare.entry(bareReplacement).kind).toBe('unknown-replacement')
    expect(auditedBare.canCompactHistory(bareReplacement, 1, true)).toBe(false)
  })
})
