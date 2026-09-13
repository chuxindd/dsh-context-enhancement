/**
 * E04 · Step 边界盲区（L1，纯算法）
 *
 * Static finding under test: `IB-11` / 遗忘矩阵 #12 / `zones.ts:326-331`
 * (`stepBoundaryAfter` → `sameStep`).
 *
 * `sameStep(left, right)` returns `true` only when BOTH payloads expose
 * `turn` AND `step`. Its negated value is what `stepBoundaryAfter` reports as
 * "safe to cut here". A `user/message` event's `data` IS the `UserMessage`
 * payload and carries neither field, so every cut whose LEFT side is a user
 * message (or a `<compacted-summary>` checkpoint replacement, also a
 * `user/message`) is unconditionally judged a step boundary.
 *
 * What this file does and does not do
 * -----------------------------------
 * - It builds REAL `Session` objects with the production payload shapes and
 *   calls the REAL exported planners (`partitionSurfaceZones`,
 *   `planForgetBatch`, `planPressureSpan`).
 * - It does NOT start DSH, does NOT read a real session log, and does NOT
 *   establish how often a real conversation's boundary lands on such a cut.
 *   Real-world frequency and semantic loss stay `X1` / `IB-R1`
 *   (需实验确认，真实会话回放).
 * - Every assertion is a measurement of the current design. No production file,
 *   config, existing test, `lib`, or `tgz` is modified by this experiment.
 *
 * Three distinct cut sites are measured, because the blind spot is not confined
 * to one planner:
 *   1. the bounded forget/maintenance batch planner (`planForgetBatch`);
 *   2. the retained-tail boundary produced by `partitionSurfaceZones`'
 *      `boundaryFromTail` repair loop (which cannot repair a cut that IS the
 *      boundary);
 *   3. the pressure planner (`planPressureSpan`), which reaches across the
 *      forget boundary and is the only above-80% path.
 */

import { describe, expect, it } from 'vitest'
import {
  partitionSurfaceZones,
  planForgetBatch,
  planPressureSpan,
} from '../../../src/internal/compaction/zones.ts'
import { PricedSurface, carriesTurnStep, payloadTurnStep } from '../harness/surface-harness.ts'

/** A context window far above every fixture surface, so only explicit boundaries bite. */
const CONTEXT_WINDOW = 1000

describe('E04 · step boundary blind spot', () => {
  it('Case A: a user/message payload carries no turn/step while its same-step reply does', () => {
    const fixture = new PricedSurface('e04-case-a')
    fixture
      .assistant(1, 1, 'earlier step', 3)
      .user('the question', 3)
      .toolCall(1, 2, 'c1', 3)
      .toolResult(1, 2, 'c1', 3)
      .assistant(1, 3, 'follow-up', 3)
      .assistant(1, 4, 'tail', 3)
    const ledger = fixture.build()

    // The structural fact the static audit asserts.
    expect(carriesTurnStep(ledger.session, ledger.nodes[1]!.seq)).toBe(false)
    expect(payloadTurnStep(ledger.session, ledger.nodes[1]!.seq)).toBeNull()
    expect(carriesTurnStep(ledger.session, ledger.nodes[2]!.seq)).toBe(true)
    expect(payloadTurnStep(ledger.session, ledger.nodes[2]!.seq)).toEqual({ turn: 1, step: 2 })

    // No turn ever closes in this fixture: the whole surface is ONE open turn,
    // and positions 1..3 are ONE step (the step answering the user message).
    const turns = new Set(
      ledger.nodes
        .map(node => payloadTurnStep(ledger.session, node.seq)?.turn)
        .filter((turn): turn is number => turn !== undefined),
    )
    expect([...turns]).toEqual([1])
    expect(payloadTurnStep(ledger.session, ledger.nodes[3]!.seq)).toEqual({ turn: 1, step: 2 })
  })

  it('Case B: metadata alone moves the batch endpoint from inside the user step to the step boundary', () => {
    // Two sessions that differ ONLY in whether the leading user-message payload
    // exposes turn/step. Node order, prices, boundaries and targets are
    // identical. Surface: user(3) | tool-call t1s1(3) | tool-result t1s1(3) |
    // assistant t1s2(3) | assistant t1s3(3); the tool call/result and the user
    // message are the same step t1s1.
    function build(withTurnStep: boolean) {
      const fixture = new PricedSurface(withTurnStep ? 'e04-case-b-control' : 'e04-case-b-blind')
      fixture.user('the question', 3, withTurnStep ? { turn: 1, step: 1 } : {})
      fixture.toolCall(1, 1, 'c1', 3)
      fixture.toolResult(1, 1, 'c1', 3)
      fixture.assistant(1, 2, 'follow-up', 3)
      fixture.assistant(1, 3, 'tail', 3)
      const ledger = fixture.build()
      const zones = partitionSurfaceZones(ledger.session, ledger.measurement, {
        recentRatio: 0.2,
        forgetBoundaryRatio: 0.5,
        contextWindow: CONTEXT_WINDOW,
        recentBoundaryTokens: 6,
        forgetBoundaryTokens: 6,
      })
      return { ledger, zones }
    }

    const blind = build(false)
    const control = build(true)
    // Identical geometry on the critical path: the marker is invisible to the
    // partition itself, which is exactly why the blind spot is not repaired.
    const geometry = (entry: ReturnType<typeof build>) => ({
      surfaceTokens: entry.ledger.measurement.surfaceTokens,
      forgetBoundaryTokens: entry.zones.forgetBoundaryTokens,
      forget: [entry.zones.forget!.startIndex, entry.zones.forget!.endIndex, entry.zones.forget!.tokens],
      tool: entry.zones.tool,
      recent: [entry.zones.recent!.startIndex, entry.zones.recent!.endIndex, entry.zones.recent!.tokens],
    })
    expect(geometry(blind)).toEqual(geometry(control))

    const options = { targetBatchTokens: 3, maxBatchTokens: 15 }
    const blindPlan = planForgetBatch(blind.ledger.session, blind.ledger.measurement, blind.zones, options)
    const controlPlan = planForgetBatch(control.ledger.session, control.ledger.measurement, control.zones, options)

    // Blind (production payload): index 0 is accepted as a safe end and already
    // reaches the 3-token target, so the semantic batch ends INSIDE step t1s1 —
    // between the user's question and the tool call that answers it.
    expect(blindPlan.kind).toBe('selected')
    if (blindPlan.kind !== 'selected') return
    expect([blindPlan.range.startIndex, blindPlan.range.endIndex]).toEqual([0, 0])
    expect(blindPlan.range.endSeq).toBe(blind.ledger.nodes[0]!.seq)
    expect(payloadTurnStep(blind.ledger.session, blind.ledger.nodes[1]!.seq)).toEqual({ turn: 1, step: 1 })

    // Control (same payload with turn/step added): index 0 is a genuine
    // same-step cut, so the planner runs on to index 2 — the step boundary that
    // keeps the question and the tool result together.
    expect(controlPlan.kind).toBe('selected')
    if (controlPlan.kind !== 'selected') return
    expect([controlPlan.range.startIndex, controlPlan.range.endIndex]).toEqual([0, 2])
    expect(controlPlan.range.tokens).toBe(9)

    expect(blindPlan.range.endIndex).not.toBe(controlPlan.range.endIndex)
  })

  it('Case C: the pressure planner cuts at the user message when the tail boundary cannot repair it', () => {
    // Surface: user(1) | tool-call t1s1(5) | tool-result t1s1(5) | assistant
    // t1s2(5) | assistant t1s3(5). The tail boundary is priced at 10 tokens, so
    // the repair loop stops on the user message and cannot move further: the
    // user payload exposes no step, so `stepBoundaryAfter(index 0)` reports a
    // safe cut even though index 1 opens the step that answers it.
    const fixture = new PricedSurface('e04-case-c')
    fixture
      .user('the question', 1)
      .toolCall(1, 1, 'c1', 5)
      .toolResult(1, 1, 'c1', 5)
      .assistant(1, 2, 'follow-up', 5)
      .assistant(1, 3, 'tail', 5)
    const ledger = fixture.build()
    const zones = partitionSurfaceZones(ledger.session, ledger.measurement, {
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.1,
      contextWindow: CONTEXT_WINDOW,
      recentBoundaryTokens: 10,
      forgetBoundaryTokens: 1,
    })
    // The one-token forget boundary walks back to index 2 and then the repair
    // loop cannot advance past index 0.
    expect([zones.forget!.startIndex, zones.forget!.endIndex]).toEqual([0, 2])
    expect(zones.recent!.startIndex).toBe(3)
    expect(payloadTurnStep(ledger.session, ledger.nodes[1]!.seq)).toEqual({ turn: 1, step: 1 })

    const plan = planPressureSpan(ledger.session, ledger.measurement, zones, {
      reclaimTokens: 0,
      inputCapTokens: 11,
      minSpanTokens: 2,
    })
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect([plan.range.startIndex, plan.range.endIndex]).toEqual([0, 2])
    expect(plan.range.endSeq).toBe(ledger.nodes[2]!.seq)
    // The selected span CONTAINS the false-safe cut at 0|1: the user's question
    // and the tool call/result answering it land on opposite sides of the
    // boundary, because the node the walk landed on has no step metadata.
    expect(payloadTurnStep(ledger.session, ledger.nodes[0]!.seq)).toBeNull()
    expect(plan.range.tokens).toBe(11)
  })

  it('Case D: pressure reaches across the forget boundary and takes the false-safe end', () => {
    const fixture = new PricedSurface('e04-case-d')
    fixture
      .user('the question', 3) // 0
      .toolCall(1, 1, 'c1', 3) // 1  same step as 2
      .toolResult(1, 1, 'c1', 3) // 2
      .assistant(1, 2, 'follow-up', 3) // 3
      .assistant(1, 3, 'tail', 3) // 4
    const ledger = fixture.build()
    const zones = partitionSurfaceZones(ledger.session, ledger.measurement, {
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.5,
      contextWindow: CONTEXT_WINDOW,
      recentBoundaryTokens: 6,
      forgetBoundaryTokens: 6,
    })
    expect(zones.recent!.startIndex).toBe(3)
    // reclaim 1 + minSpan 2 + 1 => strict target 4 tokens. The first safe ends
    // are 0 (false-safe, metadata-free) and 2 (the real step boundary), so the
    // deficit-sized answer is [0,2]: the span contains the false-safe cut at the
    // user message even though it ends at a genuine boundary.
    const plan = planPressureSpan(ledger.session, ledger.measurement, zones, {
      reclaimTokens: 1,
      inputCapTokens: 100,
      minSpanTokens: 2,
    })
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect([plan.range.startIndex, plan.range.endIndex]).toEqual([0, 2])
    expect(plan.range.tokens).toBe(9)
    // The tool pair stays whole and the retained tail is untouched: the only
    // structural risk this pass carries is the step cut at 0|1.
    expect(payloadTurnStep(ledger.session, ledger.nodes[1]!.seq)).toEqual({ turn: 1, step: 1 })
    expect(payloadTurnStep(ledger.session, ledger.nodes[2]!.seq)).toEqual({ turn: 1, step: 1 })
  })

  it('Case E: with metadata on BOTH sides the guard does fire (the blind spot is the missing payload)', () => {
    const fixture = new PricedSurface('e04-case-e')
    fixture
      .assistant(1, 1, 'step one', 3) // 0
      .assistant(1, 1, 'same step, second message', 3) // 1
      .assistant(2, 1, 'next turn', 3) // 2
    const ledger = fixture.build()
    const zones = partitionSurfaceZones(ledger.session, ledger.measurement, {
      recentRatio: 0.2,
      forgetBoundaryRatio: 0.5,
      contextWindow: CONTEXT_WINDOW,
      recentBoundaryTokens: 3,
      forgetBoundaryTokens: 3,
    })
    expect(zones.recent!.startIndex).toBe(2)
    expect(zones.forget!.startIndex).toBe(0)
    expect(zones.forget!.endIndex).toBe(1)
    // index 0 is NOT a safe end here (index 1 shares its turn AND step, and both
    // payloads expose them), so no batch can be produced at a 3-token max.
    const plan = planForgetBatch(ledger.session, ledger.measurement, zones, {
      targetBatchTokens: 3,
      maxBatchTokens: 3,
    })
    expect(plan).toEqual({ kind: 'blocked', reason: 'oldest-unit-too-large' })
  })
})
