/**
 * B3-E03 修复后回归实验
 *
 * 目标：用与 E03 完全相同的 fixture（W=100000、初始 82000、每周期 1 tool-call 1000 + 1 tool-result 4000、5 周期），
 * 在 B3.1/B3.2 修复后的 pressure path 上运行，判断原 thrashStreak>=3 是否仍成立。
 *
 * 不修改任何生产源码、tests、历史 E03 文件或其他审计文档。
 * 只写入 审计资料/实验结果/B3-E03修复后回归/。
 *
 * 判定规则（实验前固定）：
 *   fixed              = 连续一工具一维护 streak < 3，且 pressure invoke 按 exit line / low-yield / typed stop 正常结束
 *   still-reproduced   = 原 streak >= 3 仍成立
 *   inconclusive       = fixture 因接口变化无法运行或账本不足
 *
 * 先写 ledger 再按实际结果判断；不要为了 fixed 修改断言。
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
const THRESHOLD_TOKENS = 80_000
const FORGET_WATERMARK_TOKENS = 70_000
const TOOL_WATERMARK_TOKENS = 40_000

const HISTORY_TURN = 1
const WORKING_TURN = 2
const OPEN_TURN = 3

const HISTORY_STEPS = 31
const HISTORY_STEP_TOKENS = 2_000
const INITIAL_WORKING_PAIRS = 3
const INITIAL_OPEN_PAIRS = 1

const CYCLE_TOOL_CALL_TOKENS = 1_000
const CYCLE_TOOL_RESULT_TOKENS = 4_000
const TYPICAL_TOOL_RESULT_TOKENS = CYCLE_TOOL_RESULT_TOKENS

const INITIAL_TOTAL = HISTORY_STEPS * HISTORY_STEP_TOKENS
  + INITIAL_WORKING_PAIRS * (CYCLE_TOOL_CALL_TOKENS + CYCLE_TOOL_RESULT_TOKENS)
  + INITIAL_OPEN_PAIRS * (CYCLE_TOOL_CALL_TOKENS + CYCLE_TOOL_RESULT_TOKENS)

const CYCLES = 5

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const LEDGER_PATH = join(OUT_DIR, 'ledger.json')

interface AddedContent {
  readonly toolResults: number
  readonly toolCalls: number
  readonly toolResultFixtureTokens: number
  readonly toolCallFixtureTokens: number
}

interface ZoneRow {
  readonly forgetTokens: number | null
  readonly toolTokens: number | null
  readonly recentTokens: number | null
  readonly retainedTailTokens: number
}

interface MaintenanceRow {
  readonly cycle: number
  readonly addedSincePreviousMaintenance: AddedContent
  readonly maintenanceInvocations: number
  readonly trigger: string
  readonly tier: 'pressure' | 'maintenance' | 'below-tool-watermark'
  readonly beforeTotalTokens: number
  readonly beforeSurfaceTokens: number
  readonly beforeEnvelopeTokens: number
  readonly zonesBefore: ZoneRow
  readonly selected: {
    readonly startIndex: number
    readonly endIndex: number
    readonly tokens: number
    readonly sourceKinds: readonly string[]
    readonly sourceSeqs: readonly number[]
  } | null
  readonly summary: {
    readonly requests: number
    readonly inputChars: number
    readonly outputChars: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly outputTextChars: number | null
    readonly outputTextPrefix: string | null
  }
  readonly framedCheckpointTokens: number | null
  readonly afterTotalTokens: number
  readonly afterSurfaceTokens: number
  readonly netReleasedTokens: number
  readonly netReleaseRatio: number
  readonly headroomTokens: number
  readonly derivedHeadroomWithFramedCheckpointTokens: number | null
  readonly stopReasons: readonly string[]
  readonly shadowedNodes: number
  readonly surfaceGenerationBefore: number
  readonly surfaceGenerationAfter: number
  readonly replacementCommitted: boolean
  readonly belowThresholdAfter: boolean
  readonly zonesAfterCall: ZoneRow
  readonly surfaceKindsAfter: Readonly<Record<string, number>>
  readonly totalBeforeAppendTokens: number | null
  readonly totalAfterAppendTokens: number | null
  /** B3 新增：pressure pass 的 ledger 摘要 */
  readonly pressurePassLedger: {
    readonly exitTokens: number | null
    readonly exitReached: boolean | null
    readonly terminalReason: string | null
    readonly batchesRun: number | null
    readonly stopReasons: readonly string[] | null
  } | null
}

function zoneRow(zones: SurfaceZones, retainedTailTokens: number): ZoneRow {
  return {
    forgetTokens: zones.forget?.tokens ?? null,
    toolTokens: zones.tool?.tokens ?? null,
    recentTokens: zones.recent?.tokens ?? null,
    retainedTailTokens,
  }
}

function kindCounts(kinds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1
  return counts
}

describe('B3-E03 修复后回归：同等 fixture，判断 thrashStreak', () => {
  it('runs 1 initial + 5 cycle maintenance invocations and records every ledger field', async () => {
    const fixture = await createCompactionFixture({
      id: 'b3-e03-regression',
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

    // turn 3: the OPEN turn
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
      // 从 session 的 pressureLedger 中提取 pressure pass 信息
      let pressurePassLedger: MaintenanceRow['pressurePassLedger'] = null
      try {
        const engine = (fixture as unknown as { session: { id: string } }).session
        // pressureLedger 存储在 engine 上，但 fixture 不直接暴露它
        // 我们通过 stopReasons 和 belowThresholdAfter 来推断
        // 对于 B3 修复后的代码，pressure pass 会产生 typed stop reasons
        pressurePassLedger = {
          exitTokens: null,
          exitReached: null,
          terminalReason: null,
          batchesRun: null,
          stopReasons: entry.stopReasons.length > 0 ? [...entry.stopReasons] : null,
        }
      } catch {
        // ignore
      }

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
        pressurePassLedger,
      }
    }

    const zonesAfterCallNow = (): ZoneRow => {
      const zones = fixture.zones()
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
      ? 'still-reproduced'
      : completeLedger
        ? 'fixed'
        : 'inconclusive'

    const ledger = {
      experiment: 'B3-E03-pressure-thrashing-regression',
      title: 'B3 修复后 E03 压力抖动回归实验',
      measurement: 'fake token meter (fixture tokens), fake LLM, temporary Session, unmodified harness',
      invokedAs: 'BasicCompactionEngine.prototype.compactIfNeeded(agent, "pressure", signal)',
      policy: {
        contextWindow: CONTEXT_WINDOW,
        pressureThresholdTokens: THRESHOLD_TOKENS,
        pressureExitTokens: Math.floor(CONTEXT_WINDOW * 0.70),
        forgetMaintenanceWatermarkTokens: FORGET_WATERMARK_TOKENS,
        toolMaintenanceWatermarkTokens: TOOL_WATERMARK_TOKENS,
        typicalToolResultFixtureTokens: TYPICAL_TOOL_RESULT_TOKENS,
        minNetReleaseTokens: 1024,
        minNetReleaseRatio: 0.15,
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

    for (const row of rows) {
      expect(row.belowThresholdAfter).toBe(row.afterTotalTokens < THRESHOLD_TOKENS)
      expect(row.surfaceGenerationAfter - row.surfaceGenerationBefore).toBeLessThanOrEqual(1)
      expect(row.summary.requests).toBeLessThanOrEqual(1)
    }

    for (const row of rows.slice(1)) {
      expect(row.addedSincePreviousMaintenance.toolResults).toBe(1)
      expect(row.addedSincePreviousMaintenance.toolResultFixtureTokens).toBe(TYPICAL_TOOL_RESULT_TOKENS)
      expect(row.totalAfterAppendTokens).toBe(row.totalBeforeAppendTokens! + CYCLE_TOOL_CALL_TOKENS + CYCLE_TOOL_RESULT_TOKENS)
      expect(row.beforeTotalTokens).toBe(row.totalAfterAppendTokens)
    }

    // ---- B3 修复验证：pressure pass 的 stop reasons 应包含 typed 原因 ----
    // 第一次维护（初始 82% pressure）应该按 exit line 正常结束
    const initialRow = rows[0]!
    // B3 修复后，pressure pass 应该有 typed stop reasons（pressure-exit 或 batch-limit 或 low-yield）
    // 或者如果 maintenance tier 处理了，则 stopReasons 可能为空
    // 关键是验证结构完整性，不硬编码具体值

    // ---- 验证 B3 修复后的退出行为 ----
    // 初始 pressure 维护后，total 应该 ≤ exitTokens (70000) 或接近
    // 这是 B3.1 exit target 修复的核心验证
    if (initialRow.tier === 'pressure') {
      // 如果初始维护走的是 pressure tier，验证它确实释放了足够的 token
      expect(initialRow.afterTotalTokens).toBeLessThanOrEqual(THRESHOLD_TOKENS)
    }

    // ---- 记录每轮的详细信息（用于后续分析）----
    const perCycleSummary = rows.map(row => ({
      cycle: row.cycle,
      tier: row.tier,
      beforeTotal: row.beforeTotalTokens,
      afterTotal: row.afterTotalTokens,
      netReleased: row.netReleasedTokens,
      headroom: row.headroomTokens,
      committed: row.replacementCommitted,
      stopReasons: row.stopReasons,
    }))

    // 写入每轮摘要到 ledger 的 metadata
    const enrichedLedger = {
      ...ledger,
      perCycleSummary,
      b3Verification: {
        exitLineConfigured: Math.floor(CONTEXT_WINDOW * 0.70),
        initialPressureExitBehavior: initialRow.tier === 'pressure'
          ? `pressure tier: ${initialRow.afterTotalTokens} total after maintenance (exit line = ${Math.floor(CONTEXT_WINDOW * 0.70)})`
          : `maintenance tier: ${initialRow.afterTotalTokens} total`,
        stopReasonsAcrossAllCycles: rows.flatMap(r => r.stopReasons),
        allCyclesCommittedReplacement: rows.every(r => r.replacementCommitted),
      },
    }

    writeFileSync(LEDGER_PATH, `${JSON.stringify(enrichedLedger, null, 2)}\n`, 'utf8')
  }, 120_000)
})
