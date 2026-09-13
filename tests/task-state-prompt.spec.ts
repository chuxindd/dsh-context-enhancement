import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { renderContextSnapshot, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { TaskStateEntryId, TaskStateService, type TaskStateStable } from '../src/task-state.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as TaskStatePrompt from '../src/task-state-prompt.ts'

/**
 * The prompt consumer's ASSEMBLY contract.
 *
 * B5.1 moved the model-visible Stable task-state injection out of the
 * append-only dynamic runtime context into ONE plugin-owned fixed slot node on
 * the Session surface (see `tests/task-state-prompt-fixed-slot.spec.ts` for the
 * surface contract against real Sessions). What remains here is the assembly
 * contract that the slot depends on: the reserved
 * `{{task_state_snapshot}}` context and variable stay registered — so an
 * existing composition and preset keep assembling — while the variable renders
 * NOTHING, because any non-empty value would re-enter DSH's append-only
 * runtime-context projection and rebuild exactly the per-revision accumulation
 * this module must avoid. The rendered text itself is still produced by the
 * same bounded pure renderer, now handed to the slot.
 */

/** A committed stable whose content exercises lists, continuation, and literals. */
function stable(id: string, objective: string): TaskStateStable {
  return {
    schemaVersion: 1,
    revision: 1,
    filterVersion: 'filter-v1',
    sourceCursor: 3,
    digest: `digest-${id}`,
    facts: [{
      id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'),
      content: `事实 fact for ${id} with literal {{task_state_snapshot}} braces 中文`,
    }],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [{ seq: 3, note: `evidence for ${id}` }],
    todoReferences: [{ seq: 2, content: `todo ${id} 模板 {{literal}} 保留` }],
    goalView: { status: 'none' },
    todoView: {
      status: 'current',
      sourceSeq: 2,
      items: [{ content: `todo ${id} 模板 {{literal}} 保留`, status: 'pending' }],
    },
    continuation: { currentObjective: objective, currentFocus: '', openWork: [], nextActions: [] },
  }
}

/** A test-only task-state provider publishing stables under Session ids. */
class StubTaskStateService extends TaskStateService {
  private readonly bySession = new Map<string, TaskStateStable>()

  set(sessionId: SessionId, value: TaskStateStable): void {
    this.bySession.set(String(sessionId), value)
  }

  getStable(sessionId: SessionId): TaskStateStable | undefined {
    return this.bySession.get(String(sessionId))
  }
}

/** Assemble context carrying only the agent the consumer needs. */
function contextFor(sessionId: SessionId): AssembleContext {
  const agent = { session: { id: sessionId } } as unknown as Agent
  return { agent }
}

async function mount(options: {
  publish?: { sessionId: SessionId; stable: TaskStateStable }
  maxBytes?: number
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  let provider: StubTaskStateService | undefined
  if (options.publish !== undefined) {
    provider = new StubTaskStateService(ctx)
    provider.set(options.publish.sessionId, options.publish.stable)
  }
  await ctx.plugin(TaskStatePrompt, { maxBytes: options.maxBytes ?? 1 << 20 })
  return { ctx, provider }
}

describe('task-state prompt consumer', () => {
  it('rejects a non-positive or non-integer byte budget', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await expect(ctx.plugin(TaskStatePrompt, { maxBytes: 0 })).rejects.toThrow(/maxBytes/)
    await expect(ctx.plugin(TaskStatePrompt, { maxBytes: 1.5 })).rejects.toThrow(/maxBytes/)
    await expect(ctx.plugin(TaskStatePrompt, { maxBytes: Number.NaN })).rejects.toThrow(/maxBytes/)
  })

  it('registers the fixed double-brace template as a dynamic context', async () => {
    const { ctx } = await mount()
    const assembly = await ctx.systemPrompt.assemble()
    const contributed = assembly.contexts.find(entry => entry.name === 'task-state:snapshot')
    expect(contributed?.text).toBe('{{task_state_snapshot}}')
    expect('task_state_snapshot' in assembly.variables).toBe(true)
    // The reserved variable is registered but renders nothing: the slot carries
    // the model-visible text, never the append-only runtime context.
    expect(assembly.variables['task_state_snapshot']).toBe('')
  })

  it('renders no context when no agent is present', async () => {
    const { ctx } = await mount()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')
  })

  it('renders no context when the session has no committed stable', async () => {
    const { ctx } = await mount()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('missing-session' as SessionId)))).toBe('')
  })

  it('keeps the committed stable out of the runtime context while the renderer still preserves literal double braces', async () => {
    const committed = stable('1', 'ship the consumer')
    const { ctx } = await mount({ publish: { sessionId: 'session-1' as SessionId, stable: committed } })
    const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('session-1' as SessionId)))
    // The runtime-context contribution never carries the stable: delivery is the
    // plugin-owned fixed slot node, so no assembly can accumulate snapshots.
    expect(snapshot).toBe('')
    expect(snapshot).not.toContain('Durable task state')
    expect(snapshot).not.toContain('Current objective: ship the consumer')

    // The exact text the consumer hands to the slot is still produced by the
    // bounded renderer, with literal double braces preserved verbatim.
    const rendered = TaskStatePrompt.renderTaskStateSnapshot(committed, 1 << 20)
    expect(rendered).toContain('Durable task state (revision 1, source event 3, digest digest-1).')
    expect(rendered).toContain('Current objective: ship the consumer')
    expect(rendered).toContain('- 事实 fact for 1 with literal {{task_state_snapshot}} braces 中文')
    expect(rendered).toContain('- [pending] todo 1 模板 {{literal}} 保留')
  })

  it('renders nothing for another session without a committed stable', async () => {
    const { ctx } = await mount({
      publish: { sessionId: 'session-1' as SessionId, stable: stable('1', 'ship the consumer') },
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('session-2' as SessionId)))).toBe('')
  })

  it('bounds the injected text to the deployment byte budget', () => {
    const encoder = new TextEncoder()
    const full = TaskStatePrompt.renderTaskStateSnapshot(stable('2', 'short'), 1 << 20)
    const budget = encoder.encode(full).byteLength - 30
    const bounded = TaskStatePrompt.renderTaskStateSnapshot(stable('2', 'short'), budget)
    expect(encoder.encode(bounded).byteLength).toBeLessThanOrEqual(budget)
    expect(bounded).toContain('Durable task state')
    expect(bounded).toContain('truncated')
    // Below the fixed marker there is nothing honest left to inject.
    expect(TaskStatePrompt.renderTaskStateSnapshot(stable('2', 'short'), 1)).toBe('')
  })

  it('reads no task-state pointer during prompt assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const provider = new StubTaskStateService(ctx)
    provider.set('pointer-session' as SessionId, stable('3', 'pointer'))
    let reads = 0
    const base = provider.getStable.bind(provider)
    provider.getStable = ((sessionId) => {
      reads += 1
      return base(sessionId)
    })
    await ctx.plugin(TaskStatePrompt, { maxBytes: 1 << 20 })

    const sessionId = 'pointer-session' as SessionId
    // Assembly is a pure prompt operation: the pointer is read at the STEP
    // boundary that owns the slot, never on the assembly path.
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor(sessionId)))).toBe('')
    expect(reads).toBe(0)
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor(sessionId)))).toBe('')
    expect(reads).toBe(0)
  })

  it('renders an empty snapshot when a provider never mounts under ctx.taskState', async () => {
    const { ctx } = await mount()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('no-provider' as SessionId)))).toBe('')
  })

  it('disposes the variable and context registrations when its fiber unloads (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const provider = new StubTaskStateService(ctx)
    provider.set('disposed-session' as SessionId, stable('dispose', 'dispose me'))
    const fiber = await ctx.plugin(TaskStatePrompt, { maxBytes: 1 << 20 })

    const sessionId = 'disposed-session' as SessionId
    const mounted = await ctx.systemPrompt.assemble(contextFor(sessionId))
    expect(mounted.contexts.some(entry => entry.name === 'task-state:snapshot')).toBe(true)
    expect('task_state_snapshot' in mounted.variables).toBe(true)

    await fiber.dispose()

    const after = await ctx.systemPrompt.assemble(contextFor(sessionId))
    expect(after.contexts.some(entry => entry.name === 'task-state:snapshot')).toBe(false)
    expect('task_state_snapshot' in after.variables).toBe(false)
    expect(renderContextSnapshot(after)).toBe('')

    // Re-mounting the same plugin under the still-live registry must not
    // collide: no residual registration claims either name.
    await ctx.plugin(TaskStatePrompt, { maxBytes: 1 << 20 })
    const remounted = await ctx.systemPrompt.assemble(contextFor(sessionId))
    expect(remounted.contexts.find(entry => entry.name === 'task-state:snapshot')?.text).toBe('{{task_state_snapshot}}')
    expect('task_state_snapshot' in remounted.variables).toBe(true)
  })
})
