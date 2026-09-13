/**
 * Automatic-compaction scheduling contract.
 *
 * Evidence for this contract (harness checkout, `@deepseek-ai/dsh-agent`
 * 0.1.2-rc.1): the agent `Events` interface declares exactly
 * `agent/created|disposed|status|inbox/*`, `agent/session-start`,
 * `agent/pre-step`, `agent/request-error`, `agent/turn-stopping`, and
 * `agent/error`. There is NO post-step and no post-turn event, and the official
 * `compaction-basic` backend registers the same four hooks this engine does.
 *
 * The agent loop (`packages/core/agent-loop/src/agent.ts` lines 272-328) runs
 * `preStep` (the `agent/pre-step` waterfall) at the START of every step, before
 * `step/start`, before the claimed messages are appended to the surface, and
 * before the request is derived; when a step ends the turn it breaks out of the
 * loop and appends `turn/end` without another `preStep`. Every model request is
 * therefore preceded by a pressure pass that sees all previously durable surface
 * growth, so a compaction scheduled "after step/turn completion" is neither
 * available from the host nor needed for request safety.
 *
 * This spec pins the engine's side of that contract so a future change cannot
 * silently move automatic compaction onto a lifecycle point the host does not
 * provide, and so a failing pass can never block the turn.
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { resolveConfig } from '../src/internal/compaction/config.ts'

type AnyHandler = (...args: never[]) => unknown

interface HookHarness {
  readonly handlers: Map<string, AnyHandler>
  readonly calls: string[]
  readonly warnings: string[]
  readonly order: string[]
}

/** Register the engine's real automatic hooks over a capturing fake Context. */
function hookHarness(
  compact: (trigger: string, signal: AbortSignal) => Promise<unknown> = async () => null,
): HookHarness {
  const handlers = new Map<string, AnyHandler>()
  const calls: string[] = []
  const warnings: string[] = []
  const order: string[] = []
  const engine = Object.assign(
    Object.create(BasicCompactionEngine.prototype) as BasicCompactionEngine,
    {
      ctx: {
        on: (name: string, handler: AnyHandler) => {
          handlers.set(name, handler)
          return () => handlers.delete(name)
        },
        logger: {
          info: () => undefined,
          warn: (message: string) => { warnings.push(message) },
        },
      },
      config: resolveConfig({ auto: true, toolGroupSummarizer: { enabled: false } }),
      warnedPressureConfigTargets: new Set<string>(),
      overflowRetries: new WeakMap<object, number>(),
      overflowAgents: new WeakMap<object, Agent>(),
      compactIfNeeded: async (_agent: Agent, trigger: string, signal: AbortSignal) => {
        calls.push(trigger)
        order.push(`compact:${trigger}`)
        return await compact(trigger, signal)
      },
    },
  )
  ;(engine as unknown as { _registerAutomaticCompaction(): void })._registerAutomaticCompaction()
  return { handlers, calls, warnings, order }
}

const AGENT = { session: {}, options: { provider: 'mock', model: 'mock' } } as unknown as Agent

function preStep(harness: HookHarness, signal: AbortSignal): Promise<unknown> {
  const handler = harness.handlers.get('agent/pre-step') as unknown as (
    payload: { agent: Agent; messages: never[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  return handler({ agent: AGENT, messages: [], turn: 1, step: 1, signal }, async () => {
    harness.order.push('next')
    return { kind: 'enter', messages: [] }
  })
}

describe('automatic compaction lifecycle scheduling', () => {
  it('registers only the step-boundary and overflow hooks the host provides', () => {
    const harness = hookHarness()
    // Deliberate equality pin: the host has no post-step/post-turn event, so a
    // new automatic-compaction trigger has to be a reviewed contract change.
    expect([...harness.handlers.keys()]).toEqual([
      'agent/pre-step',
      'agent/status',
      'session/event',
      'agent/request-error',
    ])
    // No lifecycle point "after completion" is subscribed at all: compaction
    // cannot be scheduled from a step/step-end/turn-end/turn-stopping callback.
    expect([...harness.handlers.keys()]).not.toContain('agent/turn-stopping')
    expect([...harness.handlers.keys()]).not.toContain('agent/step-end')
    expect([...harness.handlers.keys()]).not.toContain('agent/turn-end')
    expect([...harness.handlers.keys()]).not.toContain('step/end')
    expect([...harness.handlers.keys()]).not.toContain('turn/end')
  })

  it('awaits the pressure pass before the step is admitted', async () => {
    const harness = hookHarness()
    await preStep(harness, new AbortController().signal)
    expect(harness.calls).toEqual(['pressure'])
    expect(harness.order).toEqual(['compact:pressure', 'next'])
  })

  it('skips the pass for an already-cancelled step but still admits the turn', async () => {
    const harness = hookHarness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await preStep(harness, controller.signal)
    expect(harness.calls).toEqual([])
    expect(harness.order).toEqual(['next'])
  })

  it('never lets a failed pass block the turn', async () => {
    const harness = hookHarness(async () => { throw new Error('summarizer unavailable') })
    await expect(preStep(harness, new AbortController().signal)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(harness.order).toEqual(['compact:pressure', 'next'])
    expect(harness.warnings.join('\n')).toContain('summarizer unavailable')
    expect(harness.warnings.join('\n')).toContain('continuing the turn')
  })

  it('does not compact from completion-shaped session events', () => {
    const harness = hookHarness()
    const sessionEvent = harness.handlers.get('session/event') as unknown as (
      session: unknown,
      event: { type: string },
    ) => void
    for (const type of ['step/end', 'turn/end', 'step/start', 'turn/start']) {
      sessionEvent({}, { type })
    }
    const status = harness.handlers.get('agent/status') as unknown as (
      payload: { agent: Agent; status: string },
    ) => void
    status({ agent: AGENT, status: 'idle' })
    expect(harness.calls).toEqual([])
    expect(harness.order).toEqual([])
  })
})
