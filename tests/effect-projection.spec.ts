import { describe, expect, it } from 'vitest'
import { contextEnhancementProjectionDefinition } from '../src/effect-projection.ts'

describe('context enhancement projection', () => {
  it('counts request participation without claiming task-state success', () => {
    const initial = contextEnhancementProjectionDefinition.init()
    const next = contextEnhancementProjectionDefinition.apply(initial, { type: 'request/header' } as never)
    expect(next.taskStateRequests).toBe(1)
    expect(next.taskStateBasic).toBe(0)
    expect(next.taskStatePrompt).toBe(0)
  })
})
