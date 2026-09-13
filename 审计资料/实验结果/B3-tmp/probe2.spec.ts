import { describe, expect, it } from 'vitest'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '../../../src/compaction-basic.ts'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../../../src/internal/compaction/config.ts'
import { buildSurfaceSourceIndex } from '../../../src/internal/compaction/source-index.ts'

const SURFACE = { surfaceOp: 'append' as const }
function priceMessage(message: { readonly content: readonly unknown[] }): number {
  let chars = 0
  for (const block of message.content) {
    const r = block as { type?: string; text?: string }
    if (r.type === 'text' && typeof r.text === 'string') chars += r.text.length
  }
  return Math.max(1, Math.ceil(chars / 4))
}

async function runCase(id: string, chars: number) {
  const session = Session.create(SessionId(id))
  session.append('request/header', { header: { config: { provider: 'mock', model: 'model' } }, reason: 'initial' })
  for (let turn = 1; turn <= 10; turn += 1) {
    session.append('assistant/message', { turn, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `turn-${turn}` }], source: { kind: 'model', provider: 'mock', model: 'model' } }) }, SURFACE)
  }
  const prices = new Map<SessionSeq, number>()
  const measure = (): TokenMeasurement => {
    const nodes = session.surface.nodes.map(seq => { const t = prices.get(seq) ?? 1000; return { seq, tokens: t, heuristicTokens: t } })
    const s = nodes.reduce((a, n) => a + n.tokens, 0)
    return { totalTokens: s, surfaceTokens: s, nodes, logRevision: 0, baseline: { kind: 'estimated', tokens: 0 }, surfaceDeltaTokens: s } as unknown as TokenMeasurement
  }
  const config = resolveConfig({ toolGroupSummarizer: { enabled: false }, maxMaintenanceBatches: 1, maxPressureBatches: 2, responseReserveTokens: 1000, safetyMarginTokens: 500, maxTokens: 1000 })
  const spec = resolveCompactSpec(resolveTargetPolicy(config, { provider: 'mock', model: 'model' }), 10000)
  const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
  const fake = {
    config,
    ctx: {
      tokenMeter: { measure, estimateMessage: priceMessage },
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 10000 } }) },
      get: () => undefined,
      logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
    },
    summarizeToolGroups: async () => undefined,
    sourceIndex: (s: Session) => buildSurfaceSourceIndex(s),
    hasPendingToolIntermediateWork: () => 'none' as const,
    internalFindFirstToolStageDebtIndex: () => null,
    pressureStops: new WeakMap(),
    pressureLedgers: new WeakMap(),
    logPressureStop: () => undefined,
    compactRegion: async (start: SessionSeq, end: SessionSeq): Promise<CompactionResult> => {
      const nodes = session.surface.nodes
      compacted.push({ start, end })
      const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
      const cid = CompactionId(`c-${compacted.length}`)
      const text = 's'.repeat(chars)
      const rep = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: compactCheckpointSource(cid) }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
      prices.set(rep.seq, priceMessage({ content: [{ type: 'text', text }] }))
      return { compactionId: cid, startSeq: rep.seq, summarySeq: rep.seq, endSeq: rep.seq, summary: [{ type: 'text', text: 's' }], shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount: 0 }
    },
  }
  const prototype = BasicCompactionEngine.prototype as unknown as Record<string, (...a: never[]) => unknown>
  const seams = fake as unknown as Record<string, unknown>
  for (const name of ['zones', 'envelopeBudget', 'envelopeZoneBudget', 'pressurePassTerminated', 'stopEnvelopeBudgetPass']) {
    seams[name] = (...args: unknown[]) => (prototype[name] as (...a: unknown[]) => unknown).call(fake, ...args)
  }
  const engine = fake as unknown as BasicCompactionEngine
  const agent = { session, options: { provider: 'mock', model: 'model' } } as unknown as Agent
  const before = measure()
  await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
  const ledger = (prototype.pressureLedger as (s: Session) => unknown).call(fake, session)
  console.log(`CASE ${id} chars=${chars} before=${before.totalTokens} after=${measure().totalTokens} calls=${compacted.length}`)
  console.log(`  LEDGER ${JSON.stringify(ledger)}`)
}

describe('probe2', () => {
  it('calibrates', async () => {
    await runCase('exit', 4900)
    await runCase('exit2', 3000)
    await runCase('guard', 8000)
    await runCase('low', 11000)
    await runCase('low2', 15000)
    expect(true).toBe(true)
  })
})
