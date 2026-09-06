import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/internal/compaction/config.ts'

describe('tool group summarizer configuration', () => {
  it('resolves the documented defaults', () => {
    const config = resolveConfig()
    expect(config.toolGroupSummarizer).toEqual({
      enabled: true,
      minGroupResults: 2,
      minGroupChars: 12_000,
      minGroupTokens: 2_000,
      maxGroupTokens: 12_000,
      maxGroupsPerPass: 2,
      maxSummaryTokens: 1_200,
    })
  })

  it('accepts overrides and rejects invalid group limits', () => {
    expect(resolveConfig({ toolGroupSummarizer: { enabled: false, maxGroupsPerPass: 1 } }).toolGroupSummarizer.enabled).toBe(false)
    expect(() => resolveConfig({ toolGroupSummarizer: { minGroupTokens: 10, maxGroupTokens: 2 } })).toThrow(/must not exceed/)
    expect(() => resolveConfig({ toolGroupSummarizer: { maxSummaryTokens: 0 } })).toThrow(/positive integer/)
  })
})
