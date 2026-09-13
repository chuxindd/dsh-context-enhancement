/**
 * E02 · 压力回落（L1，fake token meter + fake LLM + 临时 Session）
 *
 * Static findings under test (审计资料/10 `IB-05`, 审计资料/12 #3/#5/#7):
 *   - there is no `pressureExitRatio` and no in-invocation retry: a pressure pass
 *     commits ONE span and returns, whether or not the request fell back below
 *     the trigger;
 *   - the pressure span is sized to the pressure DEFICIT (not to the forget zone,
 *     not to the 70% maintenance target) and may deliberately cross the forget
 *     boundary — that is what distinguishes it from a bounded maintenance batch;
 *   - `targetBatchTokens` / `maxBatchTokens` bound only the 70% maintenance tier;
 *   - `maxPressureBatches` bounds overflow batches per zone, not this tier;
 *   - the retained tail is never touched.
 *
 * Measured through the REAL `compactIfNeeded` on a fake engine instance; see
 * `harness/compaction-harness.ts` for which bodies are production code.
 *
 * Fixture prices (fixture tokens, NOT provider tokens):
 *   history turn: 1 node at 4 000 + (n - 1) nodes at 2 000, all assistant/message
 *   each working turn: 1 assistant 1 000 + 3 * (tool-call 1 000 + tool-result 4 000)
 *   each tail turn: 1 assistant 2 000 (the last one stays OPEN)
 */

import { describe, expect, it } from 'vitest'
import { createCompactionFixture } from '../harness/compaction-harness.ts'

const CONTEXT_WINDOW = 100_000
const HEAD_FIRST = 4_000
const HEAD_REST = 2_000
const WORKING_TURN = 1_000 + 3 * (1_000 + 4_000)
const TAIL_TURN = 2_000
const THRESHOLD = 80_000

/** Build a fixture whose turn layout matches the price comment above. */
async function buildFixture(id: string, options: {
  readonly headNodes: number
  readonly workingTurns: number
  readonly tailTurns: number
  readonly policy?: Parameters<typeof createCompactionFixture>[0]['config']
}) {
  const fixture = await createCompactionFixture({
    id,
    contextWindow: CONTEXT_WINDOW,
    summaryCharsFor: inputChars => Math.max(64, Math.floor(inputChars / 40)),
    ...(options.policy === undefined ? {} : { config: options.policy }),
  })
  fixture.append('assistant', { tokens: HEAD_FIRST, chars: 16_000, turn: 1, step: 1 })
  for (let step = 2; step <= options.headNodes; step += 1) {
    fixture.append('assistant', { tokens: HEAD_REST, chars: 8_000, turn: 1, step })
  }
  for (let index = 0; index < options.workingTurns; index += 1) {
    const turn = index + 2
    fixture.endTurn()
    fixture.beginTurn(turn)
    fixture.append('assistant', { tokens: 1_000, chars: 4_000, turn, step: 1 })
    for (let pair = 0; pair < 3; pair += 1) {
      const callId = `t${turn}-${pair}`
      fixture.append('tool-call', { tokens: 1_000, chars: 4_000, turn, step: pair + 2, callId })
      fixture.append('tool-result', { tokens: 4_000, chars: 16_000, turn, step: pair + 2, callId })
    }
  }
  const firstTailTurn = options.workingTurns + 2
  for (let index = 0; index < options.tailTurns; index += 1) {
    const turn = firstTailTurn + index
    fixture.endTurn()
    fixture.beginTurn(turn)
    fixture.append('assistant', { tokens: TAIL_TURN, chars: 8_000, turn, step: 1 })
  }
  if (options.tailTurns === 0) fixture.beginTurn(firstTailTurn)
  return fixture
}

/** Total the price comment predicts for one fixture shape. */
function predictedTotal(headNodes: number, workingTurns: number, tailTurns: number): number {
  return HEAD_FIRST + (headNodes - 1) * HEAD_REST + workingTurns * WORKING_TURN + tailTurns * TAIL_TURN
}

describe('E02 · pressure release: one deficit-sized span, one call, no exit ratio', () => {
  it('Case A: 88k (deficit 8 000) commits ONE span and ends the invocation', async () => {
    // 4 000 + 20 * 2 000 = 44 000 history; 2 working turns = 32 000; 6 tail
    // turns = 12 000 -> 88 000, i.e. a 8 000-token pressure deficit.
    const fixture = await buildFixture('e02-case-a', {
      headNodes: 21,
      workingTurns: 2,
      tailTurns: 6,
    })
    expect(fixture.totalTokens()).toBe(predictedTotal(21, 2, 6))
    expect(fixture.totalTokens()).toBe(88_000)

    const zones = fixture.zones()
    expect(zones.forget).not.toBeNull()
    expect(zones.recent).not.toBeNull()
    const recentStart = zones.recent!.startIndex

    const entry = await fixture.run('pressure')
    // Exactly ONE auxiliary call and ONE surface replacement.
    expect(entry.summary.requests).toBe(1)
    expect(entry.surfaceGenerationAfter - entry.surfaceGenerationBefore).toBe(1)
    expect(entry.selected).not.toBeNull()
    // The span is the smallest safe prefix that can end pressure:
    // deficit 8 000 + checkpoint floor + 1, rounded up to a pairing/step-safe
    // boundary -> 10 000 fixture tokens. It is NOT the whole 44 000-token
    // forget zone, and it is NOT the 70% maintenance target either.
    expect(entry.selected!.startIndex).toBe(0)
    expect(entry.selected!.tokens).toBeGreaterThanOrEqual(8_000)
    expect(entry.selected!.tokens).toBeLessThan(zones.forget!.tokens)
    // Every selected node is older than the retained tail.
    expect(entry.selected!.endIndex).toBeLessThan(recentStart)
    // The release happened; the request fell back below the trigger.
    expect(entry.netReleasedTokens).toBeGreaterThan(0)
    expect(entry.netReleaseRatio).toBeGreaterThan(0)
    expect(entry.afterTotalTokens).toBeLessThan(THRESHOLD)
    expect(entry.belowThresholdAfter).toBe(true)
    // No typed stop fired: the single call advanced the surface.
    expect(entry.stopReasons).toEqual([])
    // Auxiliary call envelope, for the README table.
    expect(entry.summary.inputChars).toBeGreaterThan(0)
    expect(entry.summary.outputChars).toBeGreaterThan(0)
    expect(entry.summary.outputText).toContain('## Primary Request and Intent')
  })

  it('Case B: at 124k the span is still deficit-sized, not the 72 000-token forget zone', async () => {
    // 4 000 + 23 * 2 000 = 50 000 history; 4 working turns = 64 000; 5 tail
    // turns = 10 000 -> 124 000, i.e. a 44 000-token deficit and a forget zone of
    // 72 000 fixture tokens.
    const fixture = await buildFixture('e02-case-b', {
      headNodes: 24,
      workingTurns: 4,
      tailTurns: 5,
    })
    expect(fixture.totalTokens()).toBe(predictedTotal(24, 4, 5))
    expect(fixture.totalTokens()).toBe(124_000)
    const zones = fixture.zones()
    expect(zones.forget).not.toBeNull()
    const forgetTokens = zones.forget!.tokens
    expect(forgetTokens).toBe(72_000)

    const entry = await fixture.run('pressure')
    expect(entry.selected).not.toBeNull()
    // The planner answers "the smallest safe prefix that CAN end pressure", not
    // "the whole forget zone": 44 000 deficit + checkpoint floor + 1, rounded up
    // to the next step/pairing-safe boundary = 46 000.
    expect(entry.selected!.tokens).toBeGreaterThanOrEqual(44_000)
    expect(entry.selected!.tokens).toBeLessThan(forgetTokens)
    expect(entry.selected!.startIndex).toBe(0)
    expect(entry.selected!.endIndex).toBeLessThan(zones.recent!.startIndex)
    // 130 000... the walk is bounded by `zones.recent.startIndex` and by the
    // step boundary: this fixture's span stops inside the forget zone.
    expect(entry.selected!.endIndex).toBeLessThanOrEqual(zones.forget!.endIndex)
    expect(entry.summary.requests).toBe(1)
    expect(entry.netReleasedTokens).toBeGreaterThan(0)
    expect(entry.afterTotalTokens).toBeLessThan(THRESHOLD)
    expect(entry.belowThresholdAfter).toBe(true)
    // The whole-zone claim in the static findings is NOT what this fixture shows:
    // the pass is deficit-sized here. Recorded for the README verdict.
    expect(entry.selected!.tokens).not.toBe(forgetTokens)
  })

  it('Case C: targetBatchTokens / maxBatchTokens do not bound the pressure span', async () => {
    const loose = await buildFixture('e02-case-c-loose', {
      headNodes: 24,
      workingTurns: 1,
      tailTurns: 6,
    })
    const tight = await buildFixture('e02-case-c-tight', {
      headNodes: 24,
      workingTurns: 1,
      tailTurns: 6,
      policy: { targetBatchTokens: 4_000, maxBatchTokens: 4_000 },
    })
    // 4 000 + 23 * 2 000 = 50 000 + 16 000 + 12 000 = 78 000: above the 70%
    // maintenance waterline and just BELOW the 80% pressure trigger, so this
    // shape measures the maintenance tier, and the tight budget binds there.
    expect(loose.totalTokens()).toBe(78_000)
    const looseMaintenance = await loose.run('pressure')
    const tightMaintenance = await tight.run('pressure')
    expect(looseMaintenance.selected).not.toBeNull()
    expect(tightMaintenance.selected).not.toBeNull()
    expect(looseMaintenance.selected!.tokens).toBeGreaterThan(tightMaintenance.selected!.tokens)
    expect(tightMaintenance.selected!.tokens).toBeLessThanOrEqual(4_000)

    // The SAME budget policy on a session that reaches pressure changes nothing
    // about the span size, because the pressure path reads `targetBatchTokens`
    // only in the maintenance branch.
    const pressureLoose = await buildFixture('e02-case-c-pressure-loose', {
      headNodes: 24,
      workingTurns: 2,
      tailTurns: 6,
    })
    const pressureTight = await buildFixture('e02-case-c-pressure-tight', {
      headNodes: 24,
      workingTurns: 2,
      tailTurns: 6,
      policy: { targetBatchTokens: 4_000, maxBatchTokens: 4_000 },
    })
    expect(pressureLoose.totalTokens()).toBe(94_000)
    const looseEntry = await pressureLoose.run('pressure')
    const tightEntry = await pressureTight.run('pressure')
    expect(looseEntry.selected).not.toBeNull()
    expect(tightEntry.selected).not.toBeNull()
    expect(tightEntry.selected!.tokens).toBe(looseEntry.selected!.tokens)
    // Deficit 14 000 -> the span is far above the 4 000 batch budget.
    expect(tightEntry.selected!.tokens).toBeGreaterThan(4_000)
    expect(tightEntry.summary.requests).toBe(1)
  })

  it('Case D: maxPressureBatches = 0 does not stop the pressure tier', async () => {
    const fixture = await buildFixture('e02-case-d', {
      headNodes: 21,
      workingTurns: 2,
      tailTurns: 6,
      policy: { maxPressureBatches: 0 },
    })
    const entry = await fixture.run('pressure')
    expect(entry.summary.requests).toBe(1)
    expect(entry.selected).not.toBeNull()
    expect(entry.netReleasedTokens).toBeGreaterThan(0)
  })

  it('Case E: the invocation makes ONE call and never retries inside itself', async () => {
    // A summary body far smaller than the span, so the replacement lands near the
    // checkpoint floor: even then the invocation returns after the first call.
    const fixture = await buildFixture('e02-case-e', {
      headNodes: 24,
      workingTurns: 4,
      tailTurns: 5,
    })
    expect(fixture.totalTokens()).toBe(124_000)
    const entry = await fixture.run('pressure')
    expect(entry.summary.requests).toBe(1)
    expect(entry.surfaceGenerationAfter - entry.surfaceGenerationBefore).toBe(1)
    expect(entry.selected).not.toBeNull()
    expect(entry.stopReasons).toEqual([])

    // Re-running on the new surface is a NEW invocation: the released amount is
    // decided by the replacement price the summarizer produced, not by a loop.
    const second = await fixture.run('pressure')
    expect(second.summary.requests + entry.summary.requests).toBeGreaterThanOrEqual(1)
    expect(second.afterTotalTokens).toBeLessThan(entry.beforeTotalTokens)
  })

  it('Case F: the retained tail nodes survive the pass verbatim', async () => {
    const fixture = await buildFixture('e02-case-f', {
      headNodes: 21,
      workingTurns: 2,
      tailTurns: 6,
    })
    const zones = fixture.zones()
    const tailSeqs = [...fixture.session.surface.nodes].slice(zones.recent!.startIndex)
    const entry = await fixture.run('pressure')
    expect(entry.selected!.endIndex).toBeLessThan(zones.recent!.startIndex)
    for (const seq of tailSeqs) {
      expect(fixture.session.surface.nodes).toContain(seq)
    }
  })
})
