import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { contextEnhancementProjectionDefinition } from '../src/effect-projection.ts'
import type { ContextEnhancementEvidence } from '../src/effect-projection.ts'
import { resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { buildToolGroupSummaryInput } from '../src/internal/compaction/tool-group-summary.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import { servedReplacementSeqs, shouldAttemptToolGroupSummary, successfulAuditFor } from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditRecord } from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditStore } from '../src/internal/compaction/tool-group-audit-store.ts'

const SURFACE = { surfaceOp: 'append' as const }
const SHADOWED_PRICE = 7

class ScriptAdapter extends LlmAdapter {
  constructor(private text: string) { super() }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  setText(text: string): void { this.text = text }
}

/** Structural view of the private orchestration method under test. */
type EngineInternals = {
  summarizeToolGroups: (
    agent: Agent,
    target: { provider: string; model: string },
    policy: ReturnType<typeof resolveTargetPolicy>,
    olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
    signal: AbortSignal,
    roundReplacements: Set<SessionSeq>,
  ) => Promise<void>
}

/** One `finish` attempt against the in-memory audit table. */
type FinishAttempt = (
  requestId: string,
  update: (record: ToolGroupAuditRecord) => ToolGroupAuditRecord,
  records: ToolGroupAuditRecord[],
) => Promise<void>

interface Harness {
  readonly session: Session
  readonly group: ToolGroup
  readonly records: ToolGroupAuditRecord[]
  readonly warnings: string[]
  readonly roundReplacements: Set<SessionSeq>
  readonly run: () => Promise<void>
}

function addToolStep(session: Session, step: number, callId: string): { callSeq: SessionSeq; resultSeq: SessionSeq } {
  const callSeq = session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: `--file ${callId}.ts` }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE).seq
  const resultSeq = session.append('tool/result', {
    turn: 1,
    step,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: `updated ${callId}.ts` }], isError: false }),
  }, SURFACE).seq
  return { callSeq, resultSeq }
}

function summaryOutput(session: Session, group: ToolGroup): string {
  const input = buildToolGroupSummaryInput(session, group)
  return JSON.stringify({
    version: 1,
    groupSummary: 'done',
    items: input.items.map(item => ({
      sourceSeq: item.sourceSeq,
      ...(item.callId === undefined ? {} : { callId: item.callId }),
      summary: 'done',
      facts: [],
      files: [],
      identifiers: [],
      errors: [],
      unresolved: [],
    })),
    groupErrors: [],
    unresolved: [],
  })
}

function project(session: Session): ContextEnhancementEvidence {
  return session.snapshotEvents().reduce<ContextEnhancementEvidence>(
    (state, event) => contextEnhancementProjectionDefinition.apply(state, event),
    contextEnhancementProjectionDefinition.init(),
  )
}

/** Real engine pass over one two-result tool group with a scripted audit store. */
async function createHarness(
  label: string,
  finish: FinishAttempt,
  options: { readonly rejectOpen?: boolean } = {},
): Promise<Harness> {
  const host = new Context()
  const adapter = new ScriptAdapter('{}')
  await host.plugin(LlmRuntime)
  host.llm.registerAdapter(['route'], adapter)

  const session = Session.create(SessionId(label))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
  const first = addToolStep(session, 1, 'a')
  const last = addToolStep(session, 2, 'b')
  const estimateTokens = (): number => 1
  const group = selectToolGroups(session, {
    olderRange: { start: first.callSeq, end: last.resultSeq },
    minGroupResults: 1,
    minGroupChars: 1,
    minGroupTokens: 1,
    maxGroupTokens: 10_000,
    maxGroups: 1,
    estimateTokens,
  })[0]!
  adapter.setText(summaryOutput(session, group))

  const records: ToolGroupAuditRecord[] = []
  const store: ToolGroupAuditStore = {
    open: async record => {
      // The attempt row itself is refused: the audit medium is unavailable.
      if (options.rejectOpen === true) throw new Error('audit store write failed')
      records.push(record)
    },
    finish: (requestId, update) => finish(requestId, update, records),
    recordsForSession: () => records,
    close: async () => {},
  }
  const warnings: string[] = []
  const ctx = {
    llm: host.llm,
    tokenMeter: {
      estimateMessage: (message: any) => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 2 : SHADOWED_PRICE
      },
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  }
  const base = resolveConfig({})
  const engine = Object.assign(Object.create(BasicCompactionEngine.prototype) as Record<string, unknown>, {
    config: {
      ...base,
      toolGroupSummarizer: {
        ...base.toolGroupSummarizer,
        minGroupResults: 1,
        minGroupChars: 1,
        minGroupTokens: 1,
        maxGroupTokens: 10_000,
        maxGroupsPerPass: 1,
      },
    },
    ctx,
    toolGroupAuditStorePromise: Promise.resolve(),
    toolGroupAuditStore: store,
  }) as unknown as EngineInternals
  const roundReplacements = new Set<SessionSeq>()
  return {
    session,
    group,
    records,
    warnings,
    roundReplacements,
    run: () => engine.summarizeToolGroups(
      { session } as unknown as Agent,
      { provider: 'route', model: 'model' },
      resolveTargetPolicy(base, { provider: 'route', model: 'model' }),
      { startSeq: first.callSeq, endSeq: last.resultSeq },
      new AbortController().signal,
      roundReplacements,
    ),
  }
}

/**
 * Assert the durable reduction landed: one shadow price per replacement, priced
 * with the session's own estimator and immediately adjacent to it.
 */
function landedReplacementSeqs(session: Session, group: ToolGroup): SessionSeq[] {
  const prices = session.snapshotEvents().filter(event => event.type === 'compaction/prune')
  expect(prices).toHaveLength(group.toolResultSeqs.length)
  const landed: SessionSeq[] = []
  for (const price of prices) {
    if (price.type !== 'compaction/prune') throw new Error('unreachable')
    expect(price.data.shadowedTokenCount).toBe(SHADOWED_PRICE)
    expect(price.data.shadowedSeqs).toHaveLength(1)
    const replacement = session.eventAt((price.seq + 1) as SessionSeq)
    if (replacement === undefined || !isReplacementSurfaceEvent(replacement)) throw new Error('expected a surface replacement')
    expect(replacement.type).toBe('tool/result')
    expect(replacement.sourceEventSeqs).toEqual(price.data.shadowedSeqs)
    landed.push(replacement.seq)
  }
  return landed
}

describe('tool group summary evidence survives a failed audit commit', () => {
  it('keeps the landed reduction recorded, priced, and identified from session provenance', async () => {
    // Every audit write fails: the durable session log keeps the reduction, the
    // audit store keeps only a recoverable open record.
    const harness = await createHarness('tool-group-audit-failure', async () => { throw new Error('audit store write failed') })
    const { session, group, records, warnings, roundReplacements } = harness
    await harness.run()

    const landed = landedReplacementSeqs(session, group)
    expect(roundReplacements).toEqual(new Set(landed))
    // Umbrella evidence counts the semantic reduction even though no audit
    // success record exists.
    expect(project(session).toolResultPruner).toBe(group.toolResultSeqs.length)

    // The failed commit leaves a recoverable open record instead of losing the
    // work, and the failure never escapes the pass.
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('open')
    expect(shouldAttemptToolGroupSummary(records, records[0]!.fingerprint)).toBe(true)
    expect(warnings.some(message => message.includes('audit success commit failed'))).toBe(true)
    // A reduction that landed is never represented as a terminal audit outcome.
    expect(records.some(record => record.status === 'failure' || record.status === 'fallback')).toBe(false)

    // The durable provenance the replacement itself carries — not the missing
    // audit row, and not the shadow-price protocol's mere adjacency — still
    // identifies the replacement as this engine's own semantic tool summary
    // rather than a model-free prune or an unknown third-party replacement.
    const index = buildSurfaceSourceIndex(session)
    for (const seq of landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
      expect(index.canCompactHistory(seq, 1, true)).toBe(true)
      expect(index.canCompactHistory(seq, 1)).toBe(false)
    }
  })

  it('never records a landed reduction as a terminal failure when only the success commit fails', async () => {
    // The success commit fails once and the store recovers: the replacement is
    // already durable, so the record must end as success (or stay open), never
    // as a terminal failure/fallback.
    let attempts = 0
    const harness = await createHarness('tool-group-audit-commit-recovery', async (requestId, update, records) => {
      attempts += 1
      if (attempts === 1) throw new Error('audit store write failed')
      const index = records.findIndex(record => record.requestId === requestId)
      if (index < 0) throw new Error(`audit store has no record ${requestId}`)
      records[index] = update(records[index]!)
    })
    const { session, group, records, warnings, roundReplacements } = harness
    await harness.run()

    const landed = landedReplacementSeqs(session, group)
    expect(roundReplacements).toEqual(new Set(landed))
    expect(project(session).toolResultPruner).toBe(group.toolResultSeqs.length)

    // The transient failure was retried and the durable reduction ended as the
    // success record it actually is.
    expect(attempts).toBe(2)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.status).toBe('success')
    expect(record.replacementSeqs).toEqual(landed)
    expect(record.error).toBeUndefined()
    expect(warnings.some(message => message.includes('audit success commit failed'))).toBe(false)
    expect(warnings.some(message => message.includes('audit finish failed'))).toBe(false)

    // Source classification keeps the strongest durable identity: the success
    // record, exactly as the engine rebuilds its index.
    const summarized = records.filter(candidate => candidate.status === 'success').flatMap(candidate => candidate.replacementSeqs ?? [])
    const index = buildSurfaceSourceIndex(session, summarized)
    for (const seq of landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
      expect(index.canCompactHistory(seq, 1, true)).toBe(true)
      expect(index.canCompactHistory(seq, 1)).toBe(false)
    }
    // A success record also keeps the fingerprint idempotent: the same content
    // is never summarized twice.
    expect(successfulAuditFor(records, record.fingerprint)?.requestId).toBe(record.requestId)
    expect(shouldAttemptToolGroupSummary(records, record.fingerprint)).toBe(false)
  })

  it('handles mid-group append failure without terminal failure/fallback, preserving landed replacement seqs and tool-summary provenance', async () => {
    // A group has 2 items. The first replacement lands successfully on the surface;
    // appending the second replacement fails.
    const harness = await createHarness('mid-group-append-failure', async (requestId, update, records) => {
      const index = records.findIndex(record => record.requestId === requestId)
      if (index < 0) throw new Error(`audit store has no record ${requestId}`)
      records[index] = update(records[index]!)
    })
    const { session, records, roundReplacements } = harness

    // Intercept session.append: allow the first replacement to land, fail on the second replacement.
    const originalAppend = session.append.bind(session)
    let replacementCount = 0
    session.append = ((type: any, data: any, opts: any) => {
      if (type === 'tool/result' && opts?.surfaceOp?.op === 'replace') {
        replacementCount += 1
        if (replacementCount === 2) {
          throw new Error('injected mid-group replacement append failure')
        }
      }
      return originalAppend(type, data, opts)
    }) as typeof session.append

    await harness.run()

    // 1. Audit record is NOT terminal failure or fallback; it stays open.
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.status).toBe('open')
    expect(records.some(r => r.status === 'failure' || r.status === 'fallback')).toBe(false)

    // 2. The first replacement landed and is preserved in replacementSeqs.
    expect(record.replacementSeqs).toBeDefined()
    expect(record.replacementSeqs).toHaveLength(1)
    const firstReplacementSeq = record.replacementSeqs![0]!
    expect(session.surface.nodes).toContain(firstReplacementSeq)
    expect(record.error).toBe('injected mid-group replacement append failure')

    // 3. roundReplacements / onLanded already contains the landed replacement.
    expect(roundReplacements.has(firstReplacementSeq)).toBe(true)

    // 4. Rebuilding source index classifies the landed replacement as tool-summary provenance.
    const index = buildSurfaceSourceIndex(session, servedReplacementSeqs(records))
    expect(index.entry(firstReplacementSeq).kind).toBe('tool-summary')
    expect(index.isOriginalToolResult(firstReplacementSeq)).toBe(false)

    // 5. Will not re-enter or duplicate summary in the same round.
    expect(shouldAttemptToolGroupSummary(records, record.fingerprint)).toBe(false)
  })

  it('preserves semantic provenance and avoids duplicate summary when success audit persistence fails continuously', async () => {
    // Replacements land, but committing the success audit fails continuously (both attempts throw).
    let attempts = 0
    const harness = await createHarness('success-audit-persistence-failure', async (requestId, update, records) => {
      const index = records.findIndex(record => record.requestId === requestId)
      if (index < 0) throw new Error(`audit store has no record ${requestId}`)
      const next = update(records[index]!)
      if (next.status === 'success') {
        attempts += 1
        throw new Error('injected success audit persistence failure')
      }
      records[index] = next
    })
    const { session, group, records, warnings, roundReplacements } = harness
    await harness.run()

    const landed = landedReplacementSeqs(session, group)
    expect(roundReplacements).toEqual(new Set(landed))
    expect(attempts).toBe(2)

    // The record stays in served/open status, never terminal failure or fallback.
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.status).toBe('open')
    expect(records.some(r => r.status === 'failure' || r.status === 'fallback')).toBe(false)
    expect(record.replacementSeqs).toEqual(landed)
    expect(warnings.some(message => message.includes('audit success commit failed'))).toBe(true)

    // Provenance is preserved: rebuilding source index classifies landed replacements
    // as tool-summary, not degraded to tool-pruned.
    const index = buildSurfaceSourceIndex(session, servedReplacementSeqs(records))
    for (const seq of landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
      expect(index.canCompactHistory(seq, 1, true)).toBe(true)
      expect(index.canCompactHistory(seq, 1)).toBe(false)
    }

    // Fingerprint is considered served: will not duplicate or re-attempt tool group summary.
    expect(shouldAttemptToolGroupSummary(records, record.fingerprint)).toBe(false)
  })

  it('reports a rejected attempt row and still lands the reduction the Session log alone classifies', async () => {
    // B6.2: the durable row is written BEFORE the model call, so a rejected OPEN
    // write is the one failure that leaves no audit record at all. It must not
    // cancel the reduction — the Session log is the type authority — and it must
    // be reported rather than silently swallowed.
    const harness = await createHarness(
      'tool-group-audit-open-rejected',
      async () => { throw new Error('audit store write failed') },
      { rejectOpen: true },
    )
    const { session, group, records, warnings, roundReplacements } = harness
    await harness.run()

    const landed = landedReplacementSeqs(session, group)
    expect(roundReplacements).toEqual(new Set(landed))
    expect(project(session).toolResultPruner).toBe(group.toolResultSeqs.length)

    // No row exists, and the degraded mode says so with the stable reason code.
    expect(records).toEqual([])
    expect(servedReplacementSeqs(records)).toEqual([])
    expect(warnings.some(message => message.includes('audit-write-failed'))).toBe(true)
    // The reduction is never represented as an audit outcome at all: a rejected
    // write can neither fabricate a success nor a terminal refusal.
    expect(warnings.some(message => message.includes('audit success commit failed'))).toBe(false)

    // Classification comes from the replacement's own durable provenance, with
    // NO audit contribution whatsoever.
    const index = buildSurfaceSourceIndex(session, servedReplacementSeqs(records))
    for (const seq of landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
      expect(index.canCompactHistory(seq, 1, true)).toBe(true)
    }
    // A group with no row at all stays workable: the loss is availability, not a
    // scheduling verdict, and the landed results are no longer selectable.
    expect(index.isOriginalToolResult(group.toolResultSeqs[0]!)).toBe(false)
  })
})
