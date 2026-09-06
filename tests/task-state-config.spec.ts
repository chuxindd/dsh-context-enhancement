import { describe, expect, it } from 'vitest'
import { resolveTaskStateBasicConfig } from '../src/internal/task-state/basic/config.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'

/** One valid minimal deployment policy. */
function valid(): TaskStateBasicConfig {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4',
    minEvents: 20,
    maxEvents: 200,
    maxInputBytes: 60_000,
    maxOutputTokens: 4_000,
    timeoutMs: 120_000,
    maxInfraRetries: 2,
    maxEntriesPerKind: 50,
    maxEntryBytes: 4_000,
    maxListItems: 40,
  }
}

describe('task-state-basic configuration validation', () => {
  it('accepts a canonical explicit deployment policy and freezes the copy', () => {
    const resolved = resolveTaskStateBasicConfig(valid())
    expect(resolved.provider).toBe('deepseek-official')
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(resolved).not.toBe(valid())
  })

  it('rejects a non-object or missing configuration', () => {
    expect(() => resolveTaskStateBasicConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveTaskStateBasicConfig(undefined as never)).toThrow(/configuration is required/)
  })

  it('rejects an unknown configuration key', () => {
    expect(() => resolveTaskStateBasicConfig({ ...valid(), staleKey: 1 } as never)).toThrow(/unknown config key "staleKey"/)
  })

  it('rejects a missing or empty provider/model', () => {
    expect(() => resolveTaskStateBasicConfig({ ...valid(), provider: '' })).toThrow(/provider and model must be non-empty/)
    expect(() => resolveTaskStateBasicConfig({ ...valid(), model: '' })).toThrow(/provider and model must be non-empty/)
  })

  it('rejects non-positive-safe-integer numeric fields', () => {
    expect(() => resolveTaskStateBasicConfig({ ...valid(), minEvents: 0 }))
      .toThrow(/minEvents must be a positive safe integer/)
    expect(() => resolveTaskStateBasicConfig({ ...valid(), maxEvents: 1.5 }))
      .toThrow(/maxEvents must be a positive safe integer/)
    expect(() => resolveTaskStateBasicConfig({ ...valid(), maxInputBytes: -1 }))
      .toThrow(/maxInputBytes must be a positive safe integer/)
    expect(() => resolveTaskStateBasicConfig({ ...valid(), maxEntriesPerKind: NaN }))
      .toThrow(/maxEntriesPerKind must be a positive safe integer/)
  })

  it('rejects a timeout outside the allowed positive range', () => {
    expect(() => resolveTaskStateBasicConfig({ ...valid(), timeoutMs: 0 }))
      .toThrow(/timeoutMs must be a positive safe integer/)
    expect(() => resolveTaskStateBasicConfig({ ...valid(), timeoutMs: Number.MAX_SAFE_INTEGER }))
      .toThrow(/timeoutMs must be a positive safe integer no greater than/)
  })

  it('rejects a negative maxInfraRetries', () => {
    expect(() => resolveTaskStateBasicConfig({ ...valid(), maxInfraRetries: -1 }))
      .toThrow(/maxInfraRetries must be a non-negative safe integer/)
  })

  it('rejects maxEvents below minEvents', () => {
    expect(() => resolveTaskStateBasicConfig({ ...valid(), minEvents: 50, maxEvents: 10 }))
      .toThrow(/maxEvents must be greater than or equal to minEvents/)
  })
})
