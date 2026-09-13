/**
 * E05 · Goal 大幅更新（L2，Stable Task State 服务级；模型与 storage 均为 fake）
 *
 * Static findings under test: `DIF-TRIGGER-NO-URGENT-CLASS`,
 * `DIF-TRIGGER-NO-URGENT-BYPASS`, `DIF-STABLE-GOALVIEW-MISSING`,
 * `DIF-GOAL-REVISION-NO-REPLACE`, `DIF-INJECT-NO-CURRENT-GOAL-SLOT`.
 *
 * Claimed design:
 *   - the ONLY trigger is `pendingEligible >= minEvents` (`worker.ts:156-164`);
 *     `goal/change` counts exactly 1, like any progress event;
 *   - the committed stable has no `goalView` slot
 *     (`contract/types.ts:153-174`), so the Host cannot overwrite the goal view
 *     at commit time (`host.ts:233-253`);
 *   - the rendered injection has no "current Goal" section; the model-facing
 *     "current objective" is whatever the auxiliary model last wrote into
 *     `continuation.currentObjective`.
 *
 * Consequence under measurement: replacing Goal A with a semantically different
 * Goal B does not refresh the injected task narrative, and the old narrative
 * keeps being injected until `minEvents` (deployment 20) further projectable
 * events arrive.
 *
 * Environment: temporary `Context` + real `SessionStore`/`LlmRuntime` + real
 * `TaskStateWorker` and real update/filter/host/render paths, a FAKE scripted
 * LLM adapter, a FAKE in-memory worker environment, randomized temporary session
 * id. No storage backend, no `$HOME/.dsh`, no DSH process, no port.
 */

import { describe, expect, it } from 'vitest'
import { filterEvent } from '../../../src/internal/task-state/basic/filter.ts'
import { BASELINE_CONFIG, candidateEchoing, createTaskStateFixture } from '../harness/task-state-harness.ts'

const GOAL_A = {
  id: 'goal-a',
  revision: 1,
  phase: 'active',
  objective: 'Ship the font-rendering pipeline for the web client.',
}
const GOAL_B = {
  id: 'goal-b',
  revision: 3,
  phase: 'active',
  objective: 'Abandon the font work entirely and migrate the billing service to Postgres.',
}

describe('E05 · a large Goal change does not refresh the injected narrative', () => {
  it('Case A: goal/change counts 1 projectable event and the goal snapshot is projected verbatim', () => {
    const projected = filterEvent({
      type: 'goal/change',
      seq: 21,
      data: { operation: 'change', goal: GOAL_B, roundsStarted: 1 },
    })
    expect(projected).not.toBeNull()
    expect(projected!.event.fields).toMatchObject({
      kind: 'goal/change',
      operation: 'change',
      goal: {
        id: GOAL_B.id,
        revision: GOAL_B.revision,
        phase: GOAL_B.phase,
        objective: GOAL_B.objective,
        roundsStarted: 1,
      },
    })
    // The clear tombstone projects too, but with no status field: there is no
    // goalView.status to set.
    const cleared = filterEvent({ type: 'goal/change', seq: 22, data: { operation: 'clear' } })
    expect(cleared!.event.fields).toEqual({ kind: 'goal/change', operation: 'clear' })
  })

  it('Case B: Goal A → Goal B does not trigger an update, and A keeps being injected', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: GOAL_A.objective, focus: 'working on goal A' }),
    })
    try {
      // Wave 1: reach the deployment minEvents with ordinary progress events and
      // commit the stable that carries Goal A's narrative.
      for (let index = 0; index < BASELINE_CONFIG.minEvents; index += 1) {
        fixture.appendUser(`progress ${index}`)
      }
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)
      const first = fixture.ledger.cycles[0]!
      expect(first.stableRevisionAfter).toBe(1)
      expect(first.objectiveAfter).toBe(GOAL_A.objective)
      expect(first.injectedText).toContain(GOAL_A.objective)
      expect(first.staleByEligibleEvents).toBe(0)

      const revisionBeforeChange = fixture.latest()!.revision
      const cursorBeforeChange = fixture.latest()!.sourceCursor
      const injectionBeforeChange = fixture.renderInjection()!
      const cyclesBeforeChange = fixture.ledger.cycles.length
      const requestsBeforeChange = fixture.adapter.requests.length

      // The user's goal is replaced by a semantically unrelated Goal B at goal
      // revision 3. The auxiliary model is pointed at the NEW objective, so any
      // committed snapshot from here on would carry Goal B.
      fixture.adapter.setOutput(candidateEchoing({ objective: GOAL_B.objective, focus: 'working on goal B' }))
      const changeSeq = fixture.appendGoal(GOAL_B)

      // The event carries goal revision 3 in the Session log.
      const event = fixture.session.eventAt(changeSeq as never)!
      expect(event.type).toBe('goal/change')
      expect((event.data as { goal: { revision: number } }).goal.revision).toBe(3)

      // 1. It counts exactly ONE projectable eligible event — the same weight as
      //    any progress message, with no urgent class and no bypass.
      expect(fixture.eligibleAboveCursor()).toBe(1)

      // 2. No wave is launched, at the deployment threshold.
      fixture.schedule()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(fixture.ledger.cycles.length).toBe(cyclesBeforeChange)
      expect(fixture.adapter.requests.length).toBe(requestsBeforeChange)

      // 3. The committed stable, its cursor and the injected text are unchanged:
      //    the model still reads Goal A.
      const afterChange = fixture.latest()!
      expect(afterChange.revision).toBe(revisionBeforeChange)
      expect(afterChange.sourceCursor).toBe(cursorBeforeChange)
      expect(afterChange.continuation.currentObjective).toBe(GOAL_A.objective)
      expect(fixture.renderInjection()).toBe(injectionBeforeChange)
      expect(fixture.renderInjection()).toContain(GOAL_A.objective)
      expect(fixture.renderInjection()).not.toContain(GOAL_B.objective)
      // No goal identity is carried by the committed stable at all.
      expect(afterChange).not.toHaveProperty('goalView')
      expect(fixture.renderInjection()).not.toContain(GOAL_B.id)
      expect(fixture.renderInjection()).not.toContain('Goal')

      // 4. Latency: 18 further progress events still leave the stale narrative
      //    injected; only the 19th (the 20th projectable event since the last
      //    commit) triggers the next wave.
      for (let index = 0; index < 18; index += 1) fixture.appendUser(`filler ${index}`)
      expect(fixture.eligibleAboveCursor()).toBe(19)
      fixture.schedule()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(fixture.ledger.cycles.length).toBe(cyclesBeforeChange)
      expect(fixture.renderInjection()).toContain(GOAL_A.objective)

      fixture.appendUser('filler 18')
      expect(fixture.eligibleAboveCursor()).toBe(20)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === cyclesBeforeChange + 1, 10_000)

      // 5. Only now does the narrative follow the goal — and it follows because
      //    the MODEL rewrote `currentObjective`, not because the Host aligned it
      //    with the authoritative goal event.
      const committedAfterLag = fixture.ledger.cycles[fixture.ledger.cycles.length - 1]!
      expect(committedAfterLag.goalRevision).toBe(3)
      expect(committedAfterLag.objectiveAfter).toBe(GOAL_B.objective)
      expect(committedAfterLag.injectedText).toContain(GOAL_B.objective)
      expect(committedAfterLag.includedSeqs).toContain(changeSeq)
    } finally {
      await fixture.dispose()
    }
  })

  it('Case C: goal/change alone never launches a wave, even with minEvents = 1 above an empty cursor', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: GOAL_A.objective }),
      config: { minEvents: 1 },
    })
    try {
      // A first wave exists, so the second goal change is a real replacement.
      fixture.appendUser('bootstrap')
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)
      const cyclesBefore = fixture.ledger.cycles.length

      fixture.adapter.setOutput(candidateEchoing({ objective: GOAL_B.objective }))
      fixture.appendGoal(GOAL_B)
      // With minEvents = 1 the goal change DOES count as one event and does
      // launch — the point being that even here it is indistinguishable from a
      // progress event, and that the committed narrative is model-authored.
      expect(fixture.eligibleAboveCursor()).toBe(1)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === cyclesBefore + 1, 10_000)
      const cycle = fixture.ledger.cycles[cyclesBefore]!
      expect(cycle.goalRevision).toBe(GOAL_B.revision)
      expect(cycle.objectiveAfter).toBe(GOAL_B.objective)

      // Now clear the goal: the clear tombstone is only a marker; nothing about
      // the committed narrative is retracted, and no Goal section exists to
      // reset. The model keeps whatever it last wrote unless it rewrites it.
      const clearSeq = fixture.appendGoalClear()
      expect(fixture.eligibleAboveCursor()).toBe(1)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === cyclesBefore + 2, 10_000)
      const cleared = fixture.ledger.cycles[cyclesBefore + 1]!
      expect(cleared.includedSeqs).toContain(clearSeq)
      // The harness model still echoes B (it is the sole author of this field),
      // and the committed stable contains no goal-status field that could say
      // the goal is gone.
      expect(cleared.objectiveAfter).toBe(GOAL_B.objective)
      expect(fixture.latest()).not.toHaveProperty('goalView')
      expect(cleared.injectedText).not.toContain('cleared')
    } finally {
      await fixture.dispose()
    }
  })
})
