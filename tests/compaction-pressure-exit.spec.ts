import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '../src/internal/compaction/config.ts'
import { partitionSurfaceZones, planPressureSpan } from '../src/internal/compaction/zones.ts'

const SURFACE = { surfaceOp: 'append' as const }

/**
 * B3 pressure exit contract.
 *
 * The pressure tier stops at a fixed exit target
 * `pressureExitTokens = floor(contextWindow * pressureExitRatio)` instead of
 * "just below the trigger", and the planner never widens that target into a
 * whole-zone selection. E02 already falsified the whole-zone reading, so these
 * assertions are the negative contract that keeps the deficit/prefix planner
 * intact while the exit line moves.
 */
describe('pressure exit ratio configuration', () => {
  function specFor(config: Parameters<typeof resolveConfig>[0], contextWindow: number) {
    const resolved = resolveConfig(config)
    const policy = resolveTargetPolicy(resolved, { provider: 'mock', model: 'model' })
    return resolveCompactSpec(policy, contextWindow)
  }

  it('resolves the ideal-plan defaults: exit 0.70, floor 1024 tokens, floor 0.15 ratio', () => {
    const resolved = resolveConfig()
    expect(resolved.pressureExitRatio).toBe(0.70)
    expect(resolved.minNetReleaseTokens).toBe(1_024)
    expect(resolved.minNetReleaseRatio).toBe(0.15)
  })

  it('derives the absolute exit target from the context window', () => {
    const spec = specFor({}, 100_000)
    expect(spec.pressureExitTokens).toBe(70_000)
    expect(spec.thresholdTokens).toBe(80_000)
    // The exit line is strictly below the trigger: it is a real release target,
    // not a restatement of the trigger.
    expect(spec.pressureExitTokens).toBeLessThan(spec.thresholdTokens)
  })

  it('derives the exit target from the inherited forget maintenance watermark', () => {
    // pressureExitRatio defaults to the RESOLVED forgetMaintenanceRatio, not to
    // a frozen constant, so a model that raises its maintenance waterline moves
    // its exit line with it.
    const spec = specFor({ forgetMaintenanceRatio: 0.75 }, 100_000)
    expect(spec.pressureExitRatio).toBe(0.75)
    expect(spec.pressureExitTokens).toBe(75_000)
  })

  it('accepts an explicit in-range exit ratio and rejects out-of-range or contradictory ones', () => {
    expect(specFor({ pressureExitRatio: 0.70 }, 100_000).pressureExitTokens).toBe(70_000)
    expect(specFor({ pressureExitRatio: 0.75 }, 100_000).pressureExitTokens).toBe(75_000)
    // >= pressureRatio would make the exit line a no-op: the tier would already
    // be at or below its own target when it starts.
    expect(() => resolveConfig({ pressureExitRatio: 0.80 })).toThrow(/pressureExitRatio/)
    // < forgetMaintenanceRatio would exit below the ordinary maintenance
    // waterline, which the bounded maintenance tier is not allowed to cross.
    expect(() => resolveConfig({ pressureExitRatio: 0.60 })).toThrow(/pressureExitRatio/)
    // assertRatio's open lower bound: 0 is not a ratio.
    expect(() => resolveConfig({ pressureExitRatio: 0 })).toThrow(/pressureExitRatio/)
    expect(() => resolveConfig({ pressureExitRatio: 1.5 })).toThrow(/pressureExitRatio/)
    // A rejected key must not silently become an accepted one.
    expect(() => resolveConfig({ pressureExit: 0.7 } as never)).toThrow(/unknown key/)
  })

  it('rejects a model override that inherits an exit line above its own maintenance waterline', () => {
    expect(() => resolveConfig({
      modelPolicies: [{ provider: 'p', model: 'm', forgetMaintenanceRatio: 0.75 }],
    })).toThrow(/pressureExitRatio/)
  })

  it('validates the net-release floors', () => {
    expect(() => resolveConfig({ minNetReleaseTokens: -1 })).toThrow(/non-negative integer/)
    expect(() => resolveConfig({ minNetReleaseTokens: 1.5 })).toThrow(/non-negative integer/)
    expect(resolveConfig({ minNetReleaseTokens: 0 }).minNetReleaseTokens).toBe(0)
    expect(() => resolveConfig({ minNetReleaseRatio: 1.5 })).toThrow(/minNetReleaseRatio/)
    expect(() => resolveConfig({ minNetReleaseRatio: -0.1 })).toThrow(/minNetReleaseRatio/)
    // The net-release ratio upper bound is CLOSED at 1 (a summary may release
    // everything it shadowed) and its lower bound is closed at 0 (branch off).
    expect(resolveConfig({ minNetReleaseRatio: 1 }).minNetReleaseRatio).toBe(1)
    expect(resolveConfig({ minNetReleaseRatio: 0 }).minNetReleaseRatio).toBe(0)
  })

  it('accepts the new keys in the plugin Config schema while resolveConfig owns legality', () => {
    // The schema exists to describe shape, not policy legality: it must not
    // reject a value that resolveConfig rejects, or the two sources of truth
    // would disagree about the error surface.
    const shape = BasicCompactionEngine.Config as unknown as {
      dict?: Record<string, unknown>
      [key: string]: unknown
    }
    const fields = (shape.dict ?? shape) as Record<string, unknown>
    expect(Object.keys(fields)).toEqual(expect.arrayContaining([
      'pressureExitRatio',
      'minNetReleaseTokens',
      'minNetReleaseRatio',
      'maxPressureBatches',
    ]))
  })

  it('does not widen the selected span when the exit target exceeds what the head can afford', () => {
    // A pure planner contract: a target far above the cap must still return a
    // prefix bounded by the cap, starting at the surface head and ending before
    // the retained tail. A larger exit target can never become a whole-zone
    // selection.
    const session = Session.create(SessionId('pressure-exit-no-whole-zone'))
    for (let turn = 1; turn <= 12; turn += 1) {
      session.append('assistant/message', {
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `turn-${turn}` }],
          source: { kind: 'model', provider: 'mock', model: 'model' },
        }),
      }, SURFACE)
    }
    const nodes = session.surface.nodes.map(seq => ({ seq, tokens: 10, heuristicTokens: 10 }))
    const priced = {
      totalTokens: 120,
      surfaceTokens: 120,
      nodes,
      logRevision: 0,
      baseline: { kind: 'estimated', tokens: 0 },
      surfaceDeltaTokens: 120,
    } as unknown as TokenMeasurement
    const zones = partitionSurfaceZones(session, priced, {
      recentRatio: 0.20,
      forgetBoundaryRatio: 0.50,
      contextWindow: 100,
    })
    const plan = planPressureSpan(session, priced, zones, {
      // 120 - 10 = 110: an exit target below the whole surface.
      reclaimTokens: 110,
      inputCapTokens: 50,
      minSpanTokens: 10,
    })
    expect(plan.kind).toBe('selected')
    if (plan.kind !== 'selected') return
    expect(plan.range.startIndex).toBe(0)
    expect(plan.range.tokens).toBeLessThanOrEqual(50)
    expect(plan.range.endIndex).toBeLessThan(zones.recent!.startIndex)
    expect(plan.range.endIndex).toBeLessThan(nodes.length - 1)
  })
})

describe('pressure exit geometry', () => {
  it('keeps the newest turn verbatim: an exit-driven span still stops at the tail', () => {
    const session = Session.create(SessionId('pressure-exit-tail'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open' }],
      source: { kind: 'user' },
    }), SURFACE)
    const tailSeq = session.surface.nodes.at(-1)!
    const nodes = session.surface.nodes.map(seq => ({ seq, tokens: 10, heuristicTokens: 10 }))
    const priced = {
      totalTokens: 20,
      surfaceTokens: 20,
      nodes,
      logRevision: 0,
      baseline: { kind: 'estimated', tokens: 0 },
      surfaceDeltaTokens: 20,
    } as unknown as TokenMeasurement
    const zones = partitionSurfaceZones(session, priced, {
      recentRatio: 0.20,
      forgetBoundaryRatio: 0.50,
      contextWindow: 100,
    })
    const plan = planPressureSpan(session, priced, zones, {
      reclaimTokens: 15,
      inputCapTokens: 100,
      minSpanTokens: 0,
    })
    // No safe prefix exists under the retained tail, so the planner must refuse
    // rather than reach into the tail to satisfy the exit target.
    if (plan.kind === 'selected') expect(plan.range.endSeq).not.toBe(tailSeq)
    expect(tailSeq).toBe(session.surface.nodes.at(-1))
  })
})
