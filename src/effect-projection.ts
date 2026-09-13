import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Counts durable evidence events emitted by context capabilities. */
export interface ContextEnhancementEvidence {
  /** Request envelopes participating in task-state processing; not successes. */
  taskStateRequests: number
  taskStateBasic: number
  taskStatePrompt: number
  /**
   * Successful tool-result reductions on the current surface: the umbrella
   * "归纳工具操作" capability. Every reduction path — semantic tool-group
   * summarization and the deterministic head/middle prune — logs the shared
   * `compaction/prune` shadow-price event immediately before its replacement,
   * so this one counter covers them all without a separate capability.
   */
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
  taskStateRequests: z.number().int().nonnegative(),
  taskStateBasic: z.number().int().nonnegative(),
  taskStatePrompt: z.number().int().nonnegative(),
  toolResultPruner: z.number().int().nonnegative(),
  compactionBasic: z.number().int().nonnegative(),
}).strict()

const initial: ContextEnhancementEvidence = {
  taskStateRequests: 0,
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
      return { ...state, taskStateRequests: state.taskStateRequests + 1 }
    }
    if (event.type === 'compaction/prune') return { ...state, toolResultPruner: state.toolResultPruner + 1 }
    if (event.type === 'compaction/end') return { ...state, compactionBasic: state.compactionBasic + 1 }
    return state
  },
  wire: { viewSchema: evidenceSchema, view: state => state },
} satisfies ProjectionDefinition<'contextEnhancement', ContextEnhancementEvidence>
