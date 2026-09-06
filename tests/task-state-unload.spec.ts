import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import * as TaskStatePrompt from '../src/task-state-prompt.ts'

/**
 * No SessionEventMap members: unloading task-state must leave old Session logs
 * readable and reloadable by rc.1 code, whose required-on-read vocabulary
 * rejects unknown event types.
 */
describe('task-state declares no SessionEventMap members', () => {
  it('records no task-state event type in the known rc.1 session event vocabulary', () => {
    const known = [...KNOWN_SESSION_EVENT_TYPES]
    expect(known.some(type => type.startsWith('task-state/'))).toBe(false)
  })

  it('an assembled and unloaded prompt consumer leaves a session reloadable with zero unknown events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    // Mount and then unload the task-state prompt consumer.
    const fiber = await ctx.plugin(TaskStatePrompt, { maxBytes: 1 << 20 })
    const id = SessionId(`no-events-${Math.random().toString(16).slice(2)}`)
    const session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
    // A task-state provider would never be mounted in this composition, so the
    // variable renders empty; the session log records only core events.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await fiber.dispose()

    const snapshot = session.snapshotEvents()
    expect(snapshot.every(event => !event.type.startsWith('task-state/'))).toBe(true)

    // Reload the log into a detached Session exactly like a process restart
    // that never loads task-state: rc.1's restore path refuses unknown event
    // types, so success is the regression proof.
    const restoredId = SessionId(`restored-${Math.random().toString(16).slice(2)}`)
    const restored = Session.create(
      restoredId,
      snapshot,
      { ...session.header, id: restoredId },
    )
    // The detached restore closes the seeded log with rc.1's canonical
    // `session/end-seed` marker; what must hold is that no task-state event
    // entered the log, so rc.1's required-on-read vocabulary accepts it all.
    const restoredEvents = restored.snapshotEvents()
    expect(restoredEvents.some(event => event.type === 'user/message')).toBe(true)
    expect(restoredEvents.every(event => !event.type.startsWith('task-state/'))).toBe(true)
  })
})
