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
import type { SurfaceZones } from '../../../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }
function priceMessage(message: { readonly content: readonly unknown[] }): number {
  let chars = 0
  for (const block of message.content) {
    const r = block as { type?: string; text?: string }
    if (r.type === 'text' && typeof r.text === 'string') chars += r.text.length
  }
  return Math.max(1, Math.ceil(chars / 4))
}

describe('probe', () => {
  it('prints geometry', async () => {
    const session = Session.create(SessionId('probe'))
    session.append('request/header', { header: { config: { provider: 'mock', model: 'model' } }, reason: 'initial' })
    for (let turn = 1; turn <= 10; turn += 1) {
      session.append('assistant/message', { turn, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `turn-${turn}` }], source: { kind: 'model', provider: 'mock', model: 'model' } }) }, SURFACE)
    }
    const nodeTokens = 1000
    const prices = new Map<SessionSeq, number>()
    const measure = (): TokenMeasurement => {
      const nodes = session.surface.nodes.map(seq => { const t = prices.get(seq) ?? nodeTokens; return { seq, tokens: t, heuristicTokens: t } })
      const s = nodes.reduce((a, n) => a + n.tokens, 0)
      return { totalTokens: s, surfaceTokens: s, nodes, logRevision: 0, baseline: { kind: 'estimated', tokens: 0 }, surfaceDeltaTokens: s } as unknown as TokenMeasurement
    }
    const config = resolveConfig({ toolGroupSummarizer: { enabled: false }, maxMaintenanceBatches: 1, maxPressureBatches: 2, responseReserveTokens: 1000, safetyMarginTokens: 500, maxTokens: 1000 })
    const spec = resolveCompactSpec(resolveTargetPolicy(config, { provider: 'mock', model: 'model' }), 10000)
    const compacted: Array<{ start: SessionSeq; end: SessionSeq }> = []
    let batchIndex = 0
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
        const id = CompactionId(`p-${compacted.length}`)
        const text = 's'.repeat(18000)
        const rep = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: compactCheckpointSource(id) }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [...shadowedSeqs] })
        prices.set(rep.seq, priceMessage({ content: [{ type: 'text', text }] }))
        batchIndex += 1
        return { compactionId: id, startSeq: rep.seq, summarySeq: rep.seq, endSeq: rep.seq, summary: [{ type: 'text', text: 's' }], shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount: 0 }
      },
    }
    const prototype = BasicCompactionEngine.prototype as unknown as Record<string, (...args: never[]) => unknown>
    const seams = fake as unknown as Record<string, unknown>
    for (const name of ['zones', 'envelopeBudget', 'envelopeZoneBudget', 'pressurePassTerminated']) {
      seams[name] = (...args: unknown[]) => (prototype[name] as (...a: unknown[]) => unknown).call(fake, ...args)
    }
    seams.stopEnvelopeBudgetPass = (...args: unknown[]) => (prototype.stopEnvelopeBudgetPass as (...a: unknown[]) => unknown).call(fake, ...args)
    const engine = fake as unknown as BasicCompactionEngine
    const agent = { session, options: { provider: 'mock', model: 'model' } } as unknown as Agent
    const m = measure()
    const zones = (prototype.zones as (s: Session, p: TokenMeasurement, sp: unknown) => SurfaceZones).call(fake, session, m, spec)
    console.log('THRESHOLD', spec.thresholdTokens, 'EXIT', spec.pressureExitTokens)
    console.log('ZONES', JSON.stringify({ total: zones.totalTokens, recentStart: zones.recent?.startIndex, forgetEnd: zones.forget?.endIndex, tool: [zones.tool?.startIndex, zones.tool?.endIndex] }))
    const eb = (prototype.envelopeBudget as (s: Session, p: TokenMeasurement, sp: unknown) => { summarizerInputCapTokens: number; retainedTailTokens: number }) .call(fake, session, m, spec)
    console.log('BUDGET', JSON.stringify(eb))
    const ezb = (prototype.envelopeZoneBudget as (s: Session, p: TokenMeasurement, sp: unknown) => { forgetBoundaryTokens: number; retainedTailTokens: number }) .call(fake, session, m, spec)
    console.log('EZB', JSON.stringify(ezb))
    await BasicCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
    console.log('COMPACTED', JSON.stringify(compacted.map(c => ({ s: session.surface.nodes.indexOf(c.start), e: session.surface.nodes.indexOf(c.end) }))))
    console.log('LEDGER', JSON.stringify((prototype.pressureLedger as (s: Session) => unknown).call(fake, session)))
    console.log('TOTAL', measure().totalTokens, 'SURFACE', [...session.surface.nodes].length)
    expect(true).toBe(true)
  })
})

