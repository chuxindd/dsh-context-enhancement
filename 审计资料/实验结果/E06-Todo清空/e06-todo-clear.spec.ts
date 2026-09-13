/**
 * E06 · TODO 清空（L2，Stable Task State 服务级；模型与 storage 均为 fake）
 *
 * Static findings under test: `DIF-TODO-EMPTY-DROPPED` /
 * `DIF-TODO-EMPTY-NO-CLEAR` / `D3` / `render.ts:82-87`.
 *
 * Claimed design:
 *   `filter.ts:460-471` returns `undefined` for `{todos: []}`, so the empty
 *   whole-list write is dropped. `service.ts:411-421` skips any event whose
 *   filter projection is null: it never counts toward the threshold, never
 *   enters `includedSeqs`, and never moves the committed cursor. The committed
 *   `todoReferences` therefore keep rendering as a live list.
 *
 * Environment: temporary `Context` + real `SessionStore`/`LlmRuntime` + real
 * `TaskStateWorker` and real update/filter/host/render paths, a FAKE scripted
 * LLM adapter, a FAKE in-memory worker environment, and a randomized temporary
 * session id. No storage backend, no `$HOME/.dsh`, no DSH process, no port.
 *
 * What is measured: (1) the production filter drops a legal clear; (2) the
 * worker's own eligible counter and `maybeSchedule` never see it; (3) stable
 * revision, cursor, `todoReferences` and the rendered injection text are
 * unchanged by the clear; (4) the model stays the only arbiter of the list.
 */

import { describe, expect, it } from 'vitest'
import { filterEvent } from '../../../src/internal/task-state/basic/filter.ts'
import { delay, candidateEchoing, createTaskStateFixture, projectedFields } from '../harness/task-state-harness.ts'

/** Model continuation text used in every cycle of this experiment. */
const OBJECTIVE = 'keep the durable task state aligned with the live TODO list'

describe('E06 · TODO clear is invisible to Stable Task State', () => {
  it('Case A: the production filter drops a legal empty todo/write', () => {
    const empty = filterEvent({
      type: 'todo/write',
      seq: 7,
      data: { todos: [] },
    })
    expect(empty).toBeNull()

    const nonEmpty = filterEvent({
      type: 'todo/write',
      seq: 8,
      data: { todos: [{ content: 'ship the experiment', status: 'pending' }] },
    })
    expect(nonEmpty).not.toBeNull()
    expect(nonEmpty!.event.fields).toEqual({
      kind: 'todo/write',
      todos: [{ content: 'ship the experiment', status: 'pending' }],
    })

    // A clear tombstone written as a shape the filter could read would still be
    // dropped, because the drop is by LIST EMPTINESS, not by payload shape.
    expect(filterEvent({ type: 'todo/write', seq: 9, data: { todos: [], cleared: true } })).toBeNull()
  })

  it('Case B: at the deployment threshold a clear changes nothing observable', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: OBJECTIVE }),
    })
    try {
      // Wave 1: fill the deployment minEvents (20) so the first commit exists.
      for (let index = 0; index < 20; index += 1) fixture.appendUser(`progress ${index}`)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)
      expect(fixture.ledger.cycles[0]!.stableRevisionAfter).toBe(1)

      // Wave 2: a real whole-list TODO write, cited by the model. The reference
      // must point at a seq folded in the CURRENT window, because the Host
      // quarantines any reference outside it.
      const todoSeq = fixture.appendTodo([
        { content: 'first durable item', status: 'pending' },
        { content: 'second durable item', status: 'in_progress' },
      ])
      fixture.adapter.setOutput(candidateEchoing({
        objective: OBJECTIVE,
        todoSeq,
        todoText: 'first durable item; second durable item',
      }))
      for (let index = 0; index < 19; index += 1) fixture.appendUser(`more progress ${index}`)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 2, 10_000)

      const second = fixture.ledger.cycles[1]!
      expect(second.includedSeqs).toContain(todoSeq)
      expect(second.todoSeq).toBe(todoSeq)
      expect(second.stableRevisionAfter).toBe(2)
      expect(second.todoReferencesAfter).toEqual([
        { seq: todoSeq, content: 'first durable item; second durable item' },
      ])
      expect(second.injectedText).toContain('TODO references:')
      expect(second.injectedText).toContain('first durable item; second durable item')
      expect(second.staleByEligibleEvents).toBe(0)

      const committedBeforeClear = fixture.latest()!
      const cursorBeforeClear = committedBeforeClear.sourceCursor
      const revisionBeforeClear = committedBeforeClear.revision
      const injectionBeforeClear = fixture.renderInjection()!
      const cyclesBeforeClear = fixture.ledger.cycles.length
      const requestsBeforeClear = fixture.adapter.requests.length

      // The user (or the TODO tool layer) now clears the whole list: a legal
      // durable `todo/write({ todos: [] })` event.
      const clearSeq = fixture.appendTodo([])

      // 1. The event IS in the Session log...
      expect(fixture.session.eventAt(clearSeq as never)?.type).toBe('todo/write')
      // 2. ...but the production filter has no projection for it...
      expect(filterEvent({ type: 'todo/write', seq: clearSeq, data: { todos: [] } })).toBeNull()
      expect(projectedFields(fixture.session, clearSeq)).toBeNull()
      // 3. ...so the worker's own eligible counter does not move: the clear does
      //    NOT count toward minEvents. On the real provider path
      //    (`service.ts:411-421`) `observe()` is not even called for it, so this
      //    fixture's explicit `observe()` is already the PERMISSIVE case.
      expect(fixture.pendingEligible()).toBe(0)
      expect(fixture.eligibleAboveCursor()).toBe(0)

      // 4. No wave, at the deployment threshold.
      fixture.schedule()
      await delay(150)
      expect(fixture.ledger.cycles.length).toBe(cyclesBeforeClear)
      expect(fixture.adapter.requests.length).toBe(requestsBeforeClear)

      // 5. The committed snapshot is untouched and still advertises the list.
      const afterClear = fixture.latest()!
      expect(afterClear.revision).toBe(revisionBeforeClear)
      expect(afterClear.sourceCursor).toBe(cursorBeforeClear)
      expect(afterClear.todoReferences).toEqual([
        { seq: todoSeq, content: 'first durable item; second durable item' },
      ])
      expect(fixture.renderInjection()).toBe(injectionBeforeClear)
      expect(fixture.renderInjection()).toContain('first durable item; second durable item')
      expect(injectionBeforeClear).not.toContain('cleared')
    } finally {
      await fixture.dispose()
    }
  })

  it('Case C: even with minEvents = 1 the clear launches nothing, while a non-empty write does', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: OBJECTIVE }),
      config: { minEvents: 1 },
    })
    try {
      const todoSeq = fixture.appendTodo([{ content: 'only item', status: 'pending' }])
      fixture.adapter.setOutput(candidateEchoing({
        objective: OBJECTIVE,
        todoSeq,
        todoText: 'only item',
      }))
      fixture.appendUser('bootstrap')
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)
      expect(fixture.ledger.cycles[0]!.todoReferencesAfter).toEqual([
        { seq: todoSeq, content: 'only item' },
      ])

      // Legal clear: no eligible count, no wave, no change.
      const clearSeq = fixture.appendTodo([])
      expect(clearSeq).toBeGreaterThan(todoSeq)
      expect(fixture.pendingEligible()).toBe(0)
      fixture.schedule()
      await delay(150)
      expect(fixture.ledger.cycles.length).toBe(1)
      expect(fixture.latest()!.todoReferences).toEqual([{ seq: todoSeq, content: 'only item' }])
      expect(fixture.renderInjection()).toContain('only item')

      // Control: a NON-empty write is projectable, so with minEvents = 1 it does
      // launch a wave and does advance the stable.
      const secondTodo = fixture.appendTodo([{ content: 'replacement item', status: 'pending' }])
      expect(fixture.eligibleAboveCursor()).toBe(1)
      fixture.adapter.setOutput(candidateEchoing({
        objective: OBJECTIVE,
        todoSeq: secondTodo,
        todoText: 'replacement item',
      }))
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 2, 10_000)
      const second = fixture.ledger.cycles[1]!
      expect(second.includedSeqs).toContain(secondTodo)
      expect(second.todoSeq).toBe(secondTodo)
      expect(second.todoReferencesAfter).toEqual([{ seq: secondTodo, content: 'replacement item' }])
      // The clear sequence is nowhere in the folded history of either window.
      expect(second.includedSeqs).not.toContain(clearSeq)
      expect(fixture.ledger.cycles[0]!.includedSeqs).not.toContain(clearSeq)
    } finally {
      await fixture.dispose()
    }
  })

  it('Case D: the empty write is not merely unprojectable — it is not even a stable INPUT', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: OBJECTIVE }),
      config: { minEvents: 1 },
    })
    try {
      // A window made ONLY of the clear event: `foldBatchWindow` has nothing to
      // fold, so `launch()` recomputes the counter and returns with no request.
      fixture.appendTodo([])
      const requestsBefore = fixture.adapter.requests.length
      fixture.schedule()
      await delay(150)
      expect(fixture.adapter.requests.length).toBe(requestsBefore)
      expect(fixture.ledger.cycles.length).toBe(0)
      expect(fixture.latest()).toBeNull()
      // Even the counted observer path cannot make it eligible.
      expect(fixture.pendingEligible()).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('Case E: the renderer cannot express "cleared" — the stale list looks live', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: OBJECTIVE }),
      config: { minEvents: 1 },
    })
    try {
      const todoSeq = fixture.appendTodo([{ content: 'stale item', status: 'pending' }])
      fixture.adapter.setOutput(candidateEchoing({
        objective: OBJECTIVE,
        todoSeq,
        todoText: 'stale item',
      }))
      fixture.appendUser('bootstrap')
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)

      const injection = fixture.renderInjection()!
      // The header carries revision/cursor/digest only: no staleness marker, no
      // cleared/none status, no sourceSeq authority pointer.
      expect(injection).toMatch(/Durable task state \(revision \d+, source event \d+, digest [0-9a-f]+\)/)
      expect(injection).toContain('TODO references:')
      expect(injection).toContain('stale item')
      expect(injection).not.toContain('staleness')
      expect(injection).not.toContain('cleared')
      expect(injection).not.toContain('status: none')
      const stable = fixture.latest()!
      expect(stable).not.toHaveProperty('todoView')
      expect(stable).not.toHaveProperty('goalView')
      // The only TODO-shaped field on the committed stable is a flat list.
      expect(Object.keys(stable).filter(key => key.toLowerCase().includes('todo'))).toEqual(['todoReferences'])
    } finally {
      await fixture.dispose()
    }
  })
})
