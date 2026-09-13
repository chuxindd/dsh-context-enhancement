import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { retainedTailFloorTokens } from '../src/internal/compaction/envelope-budget.ts'

const SURFACE = { surfaceOp: 'append' as const }

function addAssistantText(session: Session, turn: number, text: string): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
}

function measurement(session: Session, each = 10): TokenMeasurement {
  const nodes = session.surface.nodes.map(seq => ({ seq, tokens: each, heuristicTokens: each }))
  const surfaceTokens = nodes.length * each
  return {
    totalTokens: surfaceTokens,
    surfaceTokens,
    nodes,
    logRevision: 0,
    baseline: { kind: 'estimated', tokens: 0 },
    surfaceDeltaTokens: surfaceTokens,
  } as unknown as TokenMeasurement
}

describe('retained-tail floor real turn semantics', () => {
  it('reaches back past interrupted and errored turns to retain the true last completed turn and open turn', () => {
    const session = Session.create(SessionId('tail-floor-interrupted-turns'))

    // Turn 1: genuinely completed
    session.append('turn/start', { turn: 1 })
    addAssistantText(session, 1, 'turn-1-output')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Turn 2: aborted
    session.append('turn/start', { turn: 2 })
    addAssistantText(session, 2, 'turn-2-aborted-output')
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user-interrupt' } } as never })

    // Turn 3: failed with error
    session.append('turn/start', { turn: 3 })
    addAssistantText(session, 3, 'turn-3-error-output')
    session.append('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'boom', code: 'TEST' } } as never })

    // Turn 4: currently open
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'turn-4-open-prompt' }],
      source: { kind: 'user' },
    }), SURFACE)
    addAssistantText(session, 4, 'turn-4-live-reply')

    // Surface contains:
    // Turn 1: 1 node (10 tokens)
    // Turn 2: 1 node (10 tokens)
    // Turn 3: 1 node (10 tokens)
    // Turn 4: 2 nodes (20 tokens)
    // Total 5 nodes = 50 tokens.
    //
    // Under naive "latest 2 distinct IDs" logic:
    // Tail would only take Turn 4 and Turn 3 (30 tokens), leaving Turn 1 and Turn 2 out.
    // That would mean Turn 1 (the genuine last completed turn) is dropped!
    //
    // Under real turn semantics:
    // Open turn = 4, Last completed turn = 1.
    // Tail MUST retain Open Turn 4 AND Last Completed Turn 1 (and everything in between: 3, 2).
    // Total retained tail floor tokens must be 50!
    const priced = measurement(session, 10)
    expect(retainedTailFloorTokens(session, priced)).toBe(50)
  })

  it('retains the open turn and the last completed turn when preceded by older completed turns', () => {
    const session = Session.create(SessionId('tail-floor-standard-completed'))

    // Turn 1: completed
    session.append('turn/start', { turn: 1 })
    addAssistantText(session, 1, 'turn-1')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Turn 2: completed
    session.append('turn/start', { turn: 2 })
    addAssistantText(session, 2, 'turn-2')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // Turn 3: open turn
    session.append('turn/start', { turn: 3 })
    addAssistantText(session, 3, 'turn-3-open')

    const priced = measurement(session, 10)
    // Open turn = 3, Last completed turn = 2.
    // Tail covers Turn 3 and Turn 2 (20 tokens).
    // Turn 1 is outside the retained tail floor.
    expect(retainedTailFloorTokens(session, priced)).toBe(20)
  })

  it('conservatively falls back to guaranteeing at least 2 distinct surface turns when turn metadata is absent', () => {
    const session = Session.create(SessionId('tail-floor-missing-metadata'))
    addAssistantText(session, 1, 'turn-1')
    addAssistantText(session, 2, 'turn-2')
    addAssistantText(session, 3, 'turn-3')

    // No turn/start or turn/end events present in the log.
    // Conservative fallback retains newest 2 distinct surface turns (turns 3 and 2 = 20 tokens).
    const priced = measurement(session, 10)
    expect(retainedTailFloorTokens(session, priced)).toBe(20)
  })

  it('protects open turn and meets guaranteed turn count even when no completed turn exists', () => {
    const session = Session.create(SessionId('tail-floor-no-completed-turn'))

    // Turn 1: error
    session.append('turn/start', { turn: 1 })
    addAssistantText(session, 1, 'turn-1-failed')
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'fail', code: 'FAIL' } } as never })

    // Turn 2: open
    session.append('turn/start', { turn: 2 })
    addAssistantText(session, 2, 'turn-2-open')

    // Open turn = 2, no completed turn exists.
    // Must protect open turn 2 and meet min GUARANTEED_TAIL_TURNS (covers turn 2 and turn 1 = 20 tokens).
    const priced = measurement(session, 10)
    expect(retainedTailFloorTokens(session, priced)).toBe(20)
  })
})
