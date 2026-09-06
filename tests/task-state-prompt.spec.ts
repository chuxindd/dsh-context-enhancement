import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { renderContextSnapshot, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { TaskStateEntryId, TaskStateService, type TaskStateStable } from '../src/task-state.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as TaskStatePrompt from '../src/task-state-prompt.ts'

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
  })

  it('renders no context when no agent is present', async () => {
    const { ctx } = await mount()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')
  })

  it('renders no context when the session has no committed stable', async () => {
    const { ctx } = await mount()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('missing-session' as SessionId)))).toBe('')
  })

  it('renders the stable for the session and preserves literal double braces', async () => {
    const { ctx } = await mount({
      publish: { sessionId: 'session-1' as SessionId, stable: stable('1', 'ship the consumer') },
    })
    const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('session-1' as SessionId)))
    expect(snapshot).toContain('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
    expect(snapshot).toContain('Current objective: ship the consumer')
    expect(snapshot).toContain('Durable task state (revision 1, source event 3, digest digest-1).')
    expect(snapshot).toContain('- 事实 fact for 1 with literal {{task_state_snapshot}} braces 中文')
    expect(snapshot).toContain('- todo 1 模板 {{literal}} 保留 (session event 2)')
  })

  it('renders nothing for another session without a committed stable', async () => {
    const { ctx } = await mount({
      publish: { sessionId: 'session-1' as SessionId, stable: stable('1', 'ship the consumer') },
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('session-2' as SessionId)))).toBe('')
  })

  it('bounds the rendered variable value to the deployment byte budget', async () => {
    const encoder = new TextEncoder()
    const fullCtx = await mount({
      publish: { sessionId: 'bounded-full' as SessionId, stable: stable('2', 'short') },
    })
    const fullSnapshot = renderContextSnapshot(
      await fullCtx.ctx.systemPrompt.assemble(contextFor('bounded-full' as SessionId)),
    )
    const fullValue = fullSnapshot.slice(fullSnapshot.indexOf('\n\n') + 2)
    const { ctx } = await mount({
      publish: { sessionId: 'bounded' as SessionId, stable: stable('2', 'short') },
      maxBytes: encoder.encode(fullValue).byteLength - 30,
    })
    const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor('bounded' as SessionId)))
    const value = snapshot.slice(snapshot.indexOf('\n\n') + 2)
    expect(encoder.encode(value).byteLength).toBeLessThanOrEqual(encoder.encode(fullValue).byteLength - 30)
    expect(value).toContain('Durable task state')
    expect(value).toContain('truncated')
  })

  it('reads only the task-state pointer during assembly — one synchronous getStable call', async () => {
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
    const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor(sessionId)))
    expect(reads).toBe(1)
    expect(snapshot).toContain('Current objective: pointer')
    renderContextSnapshot(await ctx.systemPrompt.assemble(contextFor(sessionId)))
    expect(reads).toBe(2)
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
