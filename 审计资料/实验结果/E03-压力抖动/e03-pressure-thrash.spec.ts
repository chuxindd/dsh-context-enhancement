/**
 * E03 · 压力抖动 / pressure thrashing (L1, fake token meter + fake LLM + 临时 Session)
 *
 * EXPERIMENT QUESTION (the only one)
 * ----------------------------------
 * On the CURRENT workspace pressure path, after one initial ~82% pressure
 * maintenance, does appending ONE typical tool/result make the NEXT
 * maintenance fire and commit again — i.e. is there "one tool call, one
 * compaction" thrashing?
 *
 * HYPOTHESIS UNDER TEST (written before the run, falsifiable)
 * -----------------------------------------------------------
 * The pressure planner sizes its single span to the pressure DEFICIT
 * (`reclaimTokens = total - threshold`, `planPressureSpan`). When the
 * summarizer's replacement is much smaller than the span, the committed pass
 * lands just BELOW the 80% trigger — with a headroom on the order of the
 * minimum framed checkpoint, i.e. far smaller than a typical tool/result. The
 * next tool/result therefore re-crosses the trigger and the next pre-step
 * maintenance commits again, once per tool call, indefinitely (or until the
 * retained tail absorbs the head). THIS is what E03 measures.
 *
 * This spec deliberately does NOT test the "whole-zone once" reading: E02
 * (`../E02-压力回落/e02-pressure-release.spec.ts`) dynamically falsified it, so
 * E03 re-uses it in no way. E03 tests repeated invocation + headroom only.
 *
 * VERDICT RULE (fixed before the run, per the E03 protocol)
 * ---------------------------------------------------------
 *   reproduced     = at least THREE consecutive adjacent-maintenance gaps with
 *                    exactly ONE appended tool/result AND a committed
 *                    replacement in the later maintenance;
 *   not-reproduced = the full multi-cycle ledger exists and that streak does
 *                    not;
 *   inconclusive   = the fixture/runner could not produce the evidence;
 *   design-confirmed = static-design evidence only, no dynamic ledger.
 * The spec computes the label into the ledger and asserts the criteria, so a
 * failing run IS the not-reproduced/inconclusive evidence; the ledger file is
 * written before any assertion runs.
 *
 * FIXTURE SHAPE (fixture tokens, NOT provider tokens — see README)
 * ---------------------------------------------------------------
 *   contextWindow 100 000 -> maintenance waterlines 40% (tool) / 70% (forget),
 *   pressure trigger 80%, retained tail R0 = 20 000, reserve 8 192 + margin 2 048.
 *   turn 1 (completed): 31 assistant/message nodes x 2 000 = 62 000 history
 *   turn 2 (completed): 3 x (tool-call 1 000 + tool-result 4 000) = 15 000
 *   turn 3 (OPEN)     : 1 x (tool-call 1 000 + tool-result 4 000) =  5 000
 *   -> initial total 82 000 fixture tokens = 82% of the window.
 *   Each cycle appends ONE tool/call + ONE tool/result (1 000 + 4 000) to the
 *   OPEN turn, exactly as one real model step + one tool execution would, then
 *   runs the next pre-step maintenance.
 *
 * See `../harness/compaction-harness.ts` (read-only, unmodified) for which
 * bodies are production code and which are fake.
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCompactionFixture, priceContent } from '../harness/compaction-harness.ts'
import type { CompactionLedgerEntry } from '../harness/compaction-harness.ts'
import type { SurfaceZones } from '../../../src/internal/compaction/zones.ts'
import { frameSummary } from '../../../src/internal/compaction/summarizer.ts'

const CONTEXT_WINDOW = 100_000
/** `floor(contextWindow * pressureRatio 0.80)`: the pressure trigger. */
const THRESHOLD_TOKENS = 80_000
/** `floor(contextWindow * forgetMaintenanceRatio 0.70)`: ordinary maintenance gate. */
const FORGET_WATERMARK_TOKENS = 70_000
/** `floor(contextWindow * toolMaintenanceRatio 0.40)`: tool-stage gate. */
const TOOL_WATERMARK_TOKENS = 40_000

const HISTORY_TURN = 1
const WORKING_TURN = 2
const OPEN_TURN = 3

const HISTORY_STEPS = 31
const HISTORY_STEP_TOKENS = 2_000
const INITIAL_WORKING_PAIRS = 3
const INITIAL_OPEN_PAIRS = 1

/** One appended tool/result cycle: the model step and the tool execution. */
const CYCLE_TOOL_CALL_TOKENS = 1_000
const CYCLE_TOOL_RESULT_TOKENS = 4_000
/** The "typical tool/result budget" the reproduced threshold is compared against. */
const TYPICAL_TOOL_RESULT_TOKENS = CYCLE_TOOL_RESULT_TOKENS

const INITIAL_TOTAL = HISTORY_STEPS * HISTORY_STEP_TOKENS
  + INITIAL_WORKING_PAIRS * (CYCLE_TOOL_CALL_TOKENS + CYCLE_TOOL_RESULT_TOKENS)
  + INITIAL_OPEN_PAIRS * (CYCLE_TOOL_CALL_TOKENS + CYCLE_TOOL_RESULT_TOKENS)

/** How many append + maintain cycles the protocol requires (at least 4). */
const CYCLES = 5

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const LEDGER_PATH = join(OUT_DIR, 'e03-ledger.json')

/** One append + maintenance cycle's added content. */
interface AddedContent {
  readonly toolResults: number
  readonly toolCalls: number
  readonly toolResultFixtureTokens: number
  readonly toolCallFixtureTokens: number
}

/** Zone geometry in ledger form (copied out of the production partition). */
interface ZoneRow {
  readonly forgetTokens: number | null
  readonly toolTokens: number | null
  readonly recentTokens: number | null
  readonly retainedTailTokens: number
}

/** One maintenance invocation's full ledger row. */
interface MaintenanceRow {
  /** 0 = the initial pressure maintenance, 1..CYCLES = the post-append ones. */
  readonly cycle: number
  /** Tool/result nodes appended since the previous maintenance invocation. */
  readonly addedSincePreviousMaintenance: AddedContent
  /** Invocation accounting. */
  readonly maintenanceInvocations: number
  readonly trigger: string
  /** Which production tier judged this invocation, from the measured total. */
  readonly tier: 'pressure' | 'maintenance' | 'below-tool-watermark'
  /** Fake-meter totals before the invocation. */
  readonly beforeTotalTokens: number
  readonly beforeSurfaceTokens: number
  readonly beforeEnvelopeTokens: number
  /** Production zone partition BEFORE the invocation. */
  readonly zonesBefore: ZoneRow
  /** The span the production pass handed to the real region transaction. */
  readonly selected: {
    readonly startIndex: number
    readonly endIndex: number
    readonly tokens: number
    readonly sourceKinds: readonly string[]
    readonly sourceSeqs: readonly number[]
  } | null
  /** Auxiliary summarization calls this invocation made. */
  readonly summary: {
    readonly requests: number
    readonly inputChars: number
    readonly outputChars: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly outputTextChars: number | null
    readonly outputTextPrefix: string | null
  }
  /** Production-heuristic price of the framed checkpoint this pass would land. */
  readonly framedCheckpointTokens: number | null
  /** Fake-meter totals after the invocation. */
  readonly afterTotalTokens: number
  readonly afterSurfaceTokens: number
  /** `before - after` on the fixture meter (upper bound; see limitations). */
  readonly netReleasedTokens: number
  readonly netReleaseRatio: number
  /** `thresholdTokens - afterTotalTokens`, fixture tokens. */
  readonly headroomTokens: number
  /** Same headroom, recomputed with the framed checkpoint priced for real. */
  readonly derivedHeadroomWithFramedCheckpointTokens: number | null
  readonly stopReasons: readonly string[]
  readonly shadowedNodes: number
  readonly surfaceGenerationBefore: number
  readonly surfaceGenerationAfter: number
  /** A replacement landed in this invocation (surface generation advanced). */
  readonly replacementCommitted: boolean
  readonly belowThresholdAfter: boolean
  /** Production zone partition AFTER the invocation (fresh re-partition). */
  readonly zonesAfterCall: ZoneRow
  /** Surface node counts by fixture kind after the invocation. */
  readonly surfaceKindsAfter: Readonly<Record<string, number>>
  /** Appended total before/after this cycle's append (cycle 0: null). */
  readonly totalBeforeAppendTokens: number | null
  readonly totalAfterAppendTokens: number | null
}

/** Project one production zone partition into the ledger row. */
function zoneRow(zones: SurfaceZones, retainedTailTokens: number): ZoneRow {
  return {
    forgetTokens: zones.forget?.tokens ?? null,
    toolTokens: zones.tool?.tokens ?? null,
    recentTokens: zones.recent?.tokens ?? null,
    retainedTailTokens,
  }
}

/** Count fixture node kinds after one invocation. */
function kindCounts(kinds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1
  return counts
}

describe('E03 · pressure thrashing: one typical tool/result per maintenance', () => {
  it('runs 1 initial + 5 cycle maintenance invocations and records every ledger field', async () => {
    const fixture = await createCompactionFixture({
      id: 'e03-pressure-thrash',
      contextWindow: CONTEXT_WINDOW,
    })

    // turn 1: completed history head
    for (let step = 1; step <= HISTORY_STEPS; step += 1) {
      fixture.append('assistant', {
        tokens: HISTORY_STEP_TOKENS,
        chars: HISTORY_STEP_TOKENS * 4,
        turn: HISTORY_TURN,
        step,
      })
    }
    fixture.endTurn()

    // turn 2: the last COMPLETED working turn
    fixture.beginTurn(WORKING_TURN)
    for (let pair = 0; pair < INITIAL_WORKING_PAIRS; pair += 1) {
      const step = pair + 1
      const callId = `t2-${pair}`
      fixture.append('tool-call', {
        tokens: CYCLE_TOOL_CALL_TOKENS,
        chars: CYCLE_TOOL_CALL_TOKENS * 4,
        turn: WORKING_TURN,
        step,
        callId,
      })
      fixture.append('tool-result', {
        tokens: CYCLE_TOOL_RESULT_TOKENS,
        chars: CYCLE_TOOL_RESULT_TOKENS * 4,
        turn: WORKING_TURN,
        step,
        callId,
      })
    }
    fixture.endTurn()

    // turn 3: the OPEN turn — the tool call already in flight when the first
    // pre-step maintenance runs, and the turn every cycle appends into.
    fixture.beginTurn(OPEN_TURN)
    for (let pair = 0; pair < INITIAL_OPEN_PAIRS; pair += 1) {
      const step = pair + 1
      const callId = `t3-open-${pair}`
      fixture.append('tool-call', {
        tokens: CYCLE_TOOL_CALL_TOKENS,
        chars: CYCLE_TOOL_CALL_TOKENS * 4,
        turn: OPEN_TURN,
        step,
        callId,
      })
      fixture.append('tool-result', {
        tokens: CYCLE_TOOL_RESULT_TOKENS,
        chars: CYCLE_TOOL_RESULT_TOKENS * 4,
        turn: OPEN_TURN,
        step,
        callId,
      })
    }

    const initialTotal = fixture.totalTokens()

    const rows: MaintenanceRow[] = []
    let invocationError: string | null = null
    let phase = 'initial'

    const capture = (
      cycle: number,
      entry: CompactionLedgerEntry,
      added: AddedContent,
      totalBeforeAppendTokens: number | null,
      totalAfterAppendTokens: number | null,
      zonesAfterCall: ZoneRow,
    ): MaintenanceRow => {
      return {
        cycle,
        addedSincePreviousMaintenance: added,
        maintenanceInvocations: fixture.ledger.length,
        trigger: entry.trigger,
        tier: entry.beforeTotalTokens >= THRESHOLD_TOKENS
          ? 'pressure'
          : entry.beforeTotalTokens >= FORGET_WATERMARK_TOKENS
            ? 'maintenance'
            : 'below-tool-watermark',
        beforeTotalTokens: entry.beforeTotalTokens,
        beforeSurfaceTokens: entry.beforeSurfaceTokens,
        beforeEnvelopeTokens: entry.beforeEnvelopeTokens,
        zonesBefore: {
          forgetTokens: entry.zonesBefore.forgetTokens,
          toolTokens: entry.zonesBefore.toolTokens,
          recentTokens: entry.zonesBefore.recentTokens,
          retainedTailTokens: entry.zonesBefore.retainedTailTokens,
        },
        selected: entry.selected === null
          ? null
          : {
            startIndex: entry.selected.startIndex,
            endIndex: entry.selected.endIndex,
            tokens: entry.selected.tokens,
            sourceKinds: [...entry.selected.sourceKinds],
            sourceSeqs: entry.selected.sourceSeqs.map(Number),
          },
        summary: {
          requests: entry.summary.requests,
          inputChars: entry.summary.inputChars,
          outputChars: entry.summary.outputChars,
          inputTokens: entry.summary.inputTokens,
          outputTokens: entry.summary.outputTokens,
          outputTextChars: entry.summary.outputText === null ? null : entry.summary.outputText.length,
          outputTextPrefix: entry.summary.outputText === null
            ? null
            : entry.summary.outputText.slice(0, 48),
        },
        framedCheckpointTokens: entry.summary.outputText === null
          ? null
          : priceContent(frameSummary([{ type: 'text', text: entry.summary.outputText }])),
        afterTotalTokens: entry.afterTotalTokens,
        afterSurfaceTokens: entry.afterSurfaceTokens,
        netReleasedTokens: entry.netReleasedTokens,
        netReleaseRatio: entry.netReleaseRatio,
        headroomTokens: THRESHOLD_TOKENS - entry.afterTotalTokens,
        derivedHeadroomWithFramedCheckpointTokens: entry.summary.outputText === null
          ? null
          : THRESHOLD_TOKENS - entry.afterTotalTokens
            - priceContent(frameSummary([{ type: 'text', text: entry.summary.outputText }])),
        stopReasons: [...entry.stopReasons],
        shadowedNodes: entry.shadowedNodes,
        surfaceGenerationBefore: entry.surfaceGenerationBefore,
        surfaceGenerationAfter: entry.surfaceGenerationAfter,
        replacementCommitted: entry.surfaceGenerationAfter > entry.surfaceGenerationBefore,
        belowThresholdAfter: entry.belowThresholdAfter,
        zonesAfterCall,
        surfaceKindsAfter: kindCounts(fixture.kinds()),
        totalBeforeAppendTokens,
        totalAfterAppendTokens,
      }
    }

    const zonesAfterCallNow = (): ZoneRow => {
      const zones = fixture.zones()
      // `recentBoundaryTokens` IS the production `retainedTailTokens` this
      // snapshot's partition was derived from; the boundary is rounded
      // head-ward to a pairing/step-safe cut.
      return zoneRow(zones, zones.recentBoundaryTokens)
    }

    try {
      // ---- initial ~82% pressure maintenance --------------------------------
      phase = 'initial maintenance'
      const initialEntry = await fixture.run('pressure')
      rows.push(capture(
        0,
        initialEntry,
        { toolResults: 0, toolCalls: 0, toolResultFixtureTokens: 0, toolCallFixtureTokens: 0 },
        null,
        null,
        zonesAfterCallNow(),
      ))

      // ---- append one tool/result, then maintain — repeat CYCLES times ------
      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        phase = `cycle ${cycle} append`
        const totalBeforeAppend = fixture.totalTokens()
        const step = INITIAL_OPEN_PAIRS + cycle
        const callId = `cycle-${cycle}`
        fixture.append('tool-call', {
          tokens: CYCLE_TOOL_CALL_TOKENS,
          chars: CYCLE_TOOL_CALL_TOKENS * 4,
          turn: OPEN_TURN,
          step,
          callId,
        })
        fixture.append('tool-result', {
          tokens: CYCLE_TOOL_RESULT_TOKENS,
          chars: CYCLE_TOOL_RESULT_TOKENS * 4,
          turn: OPEN_TURN,
          step,
          callId,
        })
        const totalAfterAppend = fixture.totalTokens()
        phase = `cycle ${cycle} maintenance`
        const entry = await fixture.run('pressure')
        rows.push(capture(
          cycle,
          entry,
          {
            toolResults: 1,
            toolCalls: 1,
            toolResultFixtureTokens: CYCLE_TOOL_RESULT_TOKENS,
            toolCallFixtureTokens: CYCLE_TOOL_CALL_TOKENS,
          },
          totalBeforeAppend,
          totalAfterAppend,
          zonesAfterCallNow(),
        ))
      }
    } catch (error: unknown) {
      invocationError = `${phase}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    }

    // ---- adjacent-maintenance gaps (the verdict evidence) --------------------
    const gaps = rows.slice(1).map((row, index) => {
      const earlier = rows[index]!
      return {
        fromMaintenance: earlier.cycle,
        toMaintenance: row.cycle,
        addedToolResults: row.addedSincePreviousMaintenance.toolResults,
        addedToolCalls: row.addedSincePreviousMaintenance.toolCalls,
        laterMaintenanceCommittedReplacement: row.replacementCommitted,
        laterMaintenanceTier: row.tier,
        headroomAfterEarlierMaintenance: earlier.headroomTokens,
        headroomBelowTypicalToolResult: earlier.headroomTokens < TYPICAL_TOOL_RESULT_TOKENS,
        thrashGap: row.addedSincePreviousMaintenance.toolResults === 1 && row.replacementCommitted,
      }
    })

    let thrashStreak = 0
    let running = 0
    for (const gap of gaps) {
      running = gap.thrashGap ? running + 1 : 0
      if (running > thrashStreak) thrashStreak = running
    }
    const headroomGapStreak = ((): number => {
      let best = 0
      let run = 0
      for (const gap of gaps) {
        run = gap.thrashGap && gap.headroomBelowTypicalToolResult ? run + 1 : 0
        if (run > best) best = run
      }
      return best
    })()

    const completeLedger = invocationError === null && initialTotal === INITIAL_TOTAL && rows.length === CYCLES + 1
    const verdictFromCriteria = thrashStreak >= 3
      ? 'reproduced'
      : completeLedger
        ? 'not-reproduced'
        : 'inconclusive'

    const ledger = {
      experiment: 'E03-pressure-thrashing',
      measurement: 'fake token meter (fixture tokens), fake LLM, temporary Session, unmodified harness',
      invokedAs: 'BasicCompactionEngine.prototype.compactIfNeeded(agent, "pressure", signal)',
      policy: {
        contextWindow: CONTEXT_WINDOW,
        pressureThresholdTokens: THRESHOLD_TOKENS,
        forgetMaintenanceWatermarkTokens: FORGET_WATERMARK_TOKENS,
        toolMaintenanceWatermarkTokens: TOOL_WATERMARK_TOKENS,
        typicalToolResultFixtureTokens: TYPICAL_TOOL_RESULT_TOKENS,
      },
      fixture: {
        initialTotalTokens: initialTotal,
        initialTotalRatio: initialTotal / CONTEXT_WINDOW,
        cycles: CYCLES,
        appendedPerCycle: {
          toolCalls: 1,
          toolResults: 1,
          toolCallFixtureTokens: CYCLE_TOOL_CALL_TOKENS,
          toolResultFixtureTokens: CYCLE_TOOL_RESULT_TOKENS,
          appendedTo: 'the OPEN turn (turn 3), one new step per cycle',
        },
      },
      invocationError,
      rows,
      gaps,
      criteria: {
        requiredConsecutiveThrashGaps: 3,
        thrashStreak,
        headroomGapStreak,
        completeLedger,
      },
      verdictFromCriteria,
    }

    // Evidence first: the ledger must survive even when an assertion below fails.
    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    // ---- structural invariants (the experiment ran as designed) --------------
    expect(invocationError).toBeNull()
    expect(initialTotal).toBe(INITIAL_TOTAL)
    expect(initialTotal).toBe(82_000)
    expect(rows.length).toBe(CYCLES + 1)
    expect(fixture.ledger.length).toBe(CYCLES + 1)

    // The production trigger constant used for `tier`/`headroom` is validated
    // against the engine's own verdict, not assumed.
    for (const row of rows) {
      expect(row.belowThresholdAfter).toBe(row.afterTotalTokens < THRESHOLD_TOKENS)
      // One invocation never commits more than one span (no in-invocation loop).
      expect(row.surfaceGenerationAfter - row.surfaceGenerationBefore).toBeLessThanOrEqual(1)
      expect(row.summary.requests).toBeLessThanOrEqual(1)
    }

    // Each cycle appended exactly one tool/result of the declared size.
    for (const row of rows.slice(1)) {
      expect(row.addedSincePreviousMaintenance.toolResults).toBe(1)
      expect(row.addedSincePreviousMaintenance.toolResultFixtureTokens).toBe(TYPICAL_TOOL_RESULT_TOKENS)
      expect(row.totalAfterAppendTokens).toBe(row.totalBeforeAppendTokens! + CYCLE_TOOL_CALL_TOKENS + CYCLE_TOOL_RESULT_TOKENS)
      expect(row.beforeTotalTokens).toBe(row.totalAfterAppendTokens)
    }

    // ---- the E03 verdict criteria -------------------------------------------
    // (a) at least three consecutive maintenance-to-maintenance gaps carrying
    //     exactly one appended tool/result, with the later maintenance landing a
    //     replacement;
    expect(thrashStreak).toBeGreaterThanOrEqual(3)
    // (b) the plan's own threshold: after those maintenances the headroom is
    //     smaller than the next typical tool/result budget.
    expect(headroomGapStreak).toBeGreaterThanOrEqual(3)
    expect(verdictFromCriteria).toBe('reproduced')
  }, 120_000)
})
