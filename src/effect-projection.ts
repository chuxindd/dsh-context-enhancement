import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Counts durable evidence events emitted by the four context capabilities. */
export interface ContextEnhancementEvidence {
  taskStateBasic: number
  taskStatePrompt: number
  toolResultPruner: number
  compactionBasic: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Counts of context-enhancement evidence events in the current Session. */
    contextEnhancement: ContextEnhancementEvidence
  }
  interface SessionProjectionStateMap {
    /** Internal state for context-enhancement evidence counts. */
    contextEnhancement: ContextEnhancementEvidence
  }
}

const evidenceSchema = z.object({
  taskStateBasic: z.number().int().nonnegative(),
  taskStatePrompt: z.number().int().nonnegative(),
  toolResultPruner: z.number().int().nonnegative(),
  compactionBasic: z.number().int().nonnegative(),
}).strict()

const initial: ContextEnhancementEvidence = {
  taskStateBasic: 0,
  taskStatePrompt: 0,
  toolResultPruner: 0,
  compactionBasic: 0,
}

/** Project logged evidence into a small browser-readable counter object. */
export const contextEnhancementProjectionDefinition = {
  key: 'contextEnhancement',
  stateVersion: 1,
  stateSchema: evidenceSchema,
  init: () => initial,
  apply: (state, event) => {
    if (event.type === 'request/header') {
      return {
        ...state,
        taskStateBasic: state.taskStateBasic + 1,
        taskStatePrompt: state.taskStatePrompt + 1,
      }
    }
    if (event.type === 'compaction/prune') return { ...state, toolResultPruner: state.toolResultPruner + 1 }
    if (event.type === 'compaction/end') return { ...state, compactionBasic: state.compactionBasic + 1 }
    return state
  },
  wire: { viewSchema: evidenceSchema, view: state => state },
} satisfies ProjectionDefinition<'contextEnhancement', ContextEnhancementEvidence>
