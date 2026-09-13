import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { contextEnhancementProjectionDefinition } from '../src/effect-projection.ts'
import type { ContextEnhancementEvidence } from '../src/effect-projection.ts'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { resolveConfig } from '../src/internal/compaction/pruner-config.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'

const SURFACE = { surfaceOp: 'append' as const }

function addToolStep(session: Session, step: number, callId: string, text: string): SessionSeq {
  session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE)
  return session.append('tool/result', {
    turn: 1,
    step,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false }),
  }, SURFACE).seq
}

/** Replay the projection exactly as the session log would be replayed. */
function project(session: Session): ContextEnhancementEvidence {
  return session.snapshotEvents().reduce<ContextEnhancementEvidence>(
    (state, event) => contextEnhancementProjectionDefinition.apply(state, event),
    contextEnhancementProjectionDefinition.init(),
  )
}

describe('context enhancement projection', () => {
  it('counts request participation without claiming task-state success', () => {
    const initial = contextEnhancementProjectionDefinition.init()
    const next = contextEnhancementProjectionDefinition.apply(initial, { type: 'request/header' } as never)
    expect(next.taskStateRequests).toBe(1)
    expect(next.taskStateBasic).toBe(0)
    expect(next.taskStatePrompt).toBe(0)
  })

  it('counts every successful tool-result reduction path under one umbrella counter', () => {
    const session = Session.create(SessionId('umbrella-tool-reductions'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }), SURFACE)
    addToolStep(session, 1, 'prune-me', 'x'.repeat(400))
    const groupA = addToolStep(session, 2, 'group-a', 'a result')
    const groupB = addToolStep(session, 3, 'group-b', 'b result')

    // Deterministic pruning path: the real service method over a fake meter.
    const pruner = Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
      config: resolveConfig({ thresholdChars: 64, headChars: 8, tailChars: 8 }),
      ctx: { tokenMeter: { estimateMessage: () => 3 } },
    })
    const pruned = pruner.pruneSession(session)

    // Semantic tool-group path: the real replacement function.
    const group: ToolGroup = {
      sourceSeqs: [groupA, groupB],
      toolResultSeqs: [groupA, groupB],
      callIds: ['group-a', 'group-b'],
      startSeq: groupA,
      endSeq: groupB,
      estimatedTokens: 100,
      startPosition: 2,
      endPosition: 4,
      turn: 1,
    }
    const summary: ToolGroupSummary = {
      version: 1,
      groupSummary: 'done',
      items: [groupA, groupB].map(sourceSeq => ({
        sourceSeq,
        callId: 'group-a',
        summary: 'done',
        facts: [],
        files: [],
        identifiers: [],
        errors: [],
        unresolved: [],
      })),
      groupErrors: [],
      unresolved: [],
    }
    const replaced = replaceToolGroup(session, group, summary, {
      estimateTokens: (message: any) => {
        const block = message.content[0]
        const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
        return text.includes('[tool group summary]') ? 2 : 5
      },
    })

    expect(pruned.pruned).toHaveLength(1)
    expect(replaced.replacementSeqs).toHaveLength(2)
    const evidence = project(session)
    // One durable reduction record per landed replacement, whatever reduced it.
    expect(evidence.toolResultPruner).toBe(3)
    expect(evidence.compactionBasic).toBe(0)
    expect(evidence.taskStateRequests).toBe(0)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(3)
  })
})
