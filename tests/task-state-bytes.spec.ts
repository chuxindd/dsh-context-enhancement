import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { MARKER_BYTES, TRUNCATION_MARKER, boundField, boundUtf8 } from '../src/internal/task-state/basic/bytes.ts'

describe('task-state-basic deterministic byte bounding', () => {
  it('keeps a value at or under its limit untruncated', () => {
    const result = boundUtf8('abc', 3)
    expect(result).toEqual({ text: 'abc', truncated: false, keptBytes: 3 })
    const records: { path: string; limitBytes: number; keptBytes: number }[] = []
    expect(boundField('user/message.text', 'abc', 4, records)).toBe('abc')
    expect(records).toEqual([])
  })

  it('cuts a multibyte value on code-point boundaries without splitting it', () => {
    const value = '任务状态任务状态'
    const result = boundUtf8(value, 10)
    expect(result.truncated).toBe(true)
    expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(result.text.slice(0, -1)).toBe('任务')
    expect(result.keptBytes).toBeLessThanOrEqual(10)
    expect(result.keptBytes).toBe(2 * 3 + MARKER_BYTES)
  })

  it('throws when an oversized value is cut at a limit below the marker size', () => {
    expect(() => boundUtf8('a', MARKER_BYTES - 1)).not.toThrow()
    expect(() => boundUtf8('abcd', MARKER_BYTES - 1)).toThrow(/below the marker size/)
  })

  it('keeps only the marker when even the first code point cannot fit', () => {
    const result = boundUtf8('任务状态', MARKER_BYTES)
    expect(result).toEqual({ text: TRUNCATION_MARKER, truncated: true, keptBytes: MARKER_BYTES })
  })

  it('records one marked truncation with the exact cut facts', () => {
    const records: { path: string; limitBytes: number; keptBytes: number }[] = []
    const text = boundField('tool/result.text', 'a very long result body', 8, records)
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(records).toEqual([{ path: 'tool/result.text', limitBytes: 8, keptBytes: Buffer.byteLength(text, 'utf8') }])
  })

  it('reports the exact UTF-8 byte length of the marker', () => {
    expect(Buffer.byteLength(TRUNCATION_MARKER, 'utf8')).toBe(3)
    expect(MARKER_BYTES).toBe(3)
  })
})
