import { describe, expect, it } from 'vitest'
import {
  TaskStateEntryId,
  type TaskStateCandidate,
} from '../src/task-state.ts'
import { commitStable, digestOf, normalizeCandidate, parseCandidate } from '../src/internal/task-state/basic/host.ts'

function candidate(overrides: Partial<TaskStateCandidate> = {}): TaskStateCandidate {
  return {
    facts: [{ content: 'new fact' }],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [{ seq: 5, note: 'from the last tool result' }],
    todoReferences: [],
    continuation: {
      currentObjective: 'land the state provider',
      currentFocus: 'writing the worker',
      openWork: ['write the tests'],
      nextActions: ['run the gates'],
    },
    ...overrides,
  }
}

const context = {
  base: {
    revision: 1,
    sourceCursor: 4,
    entryIds: new Set(['fact-11111111-1111-4111-8111-111111111111']),
    entries: [
      { id: 'fact-11111111-1111-4111-8111-111111111111', kind: 'fact', content: 'root cause fixed' },
    ],
  },
  includedSeqs: new Set([5, 6]),
  limits: { maxEntriesPerKind: 10, maxEntryBytes: 2_000, maxListItems: 8 },
}

describe('task-state-basic candidate parsing', () => {
  it('accepts a canonical candidate', () => {
    expect(() => parseCandidate(candidate())).not.toThrow()
  })

  it('rejects malformed candidate output', () => {
    expect(() => parseCandidate({ facts: 'not-an-array' })).toThrow()
  })
})

describe('task-state-basic Host normalization', () => {
  it('mints Host ids for new entries and echoes existing ones', () => {
    const normalized = normalizeCandidate(candidate({
      facts: [
        { id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'), content: 'root cause fixed' },
        { content: 'new fact' },
      ],
    }), context)
    expect(normalized.facts.length).toBe(2)
    expect(normalized.facts[0]?.id).toBe('fact-11111111-1111-4111-8111-111111111111')
    expect(normalized.facts[1]?.id).toMatch(/^fact-/)
  })

  it('rejects an echoed id that is not in the base', () => {
    expect(() => normalizeCandidate(candidate({
      facts: [{ id: TaskStateEntryId('fact-unknown-0000-0000-0000-000000000000'), content: 'stale' }],
    }), context)).toThrow(/unknown entry id/)
  })

  it('rejects echoing the same id twice with unchanged content', () => {
    const id = TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111')
    expect(() => normalizeCandidate(candidate({
      facts: [
        { id, content: 'root cause fixed' },
        { id, content: 'root cause fixed' },
      ],
    }), context)).toThrow(/more than once/)
  })

  it('rejects echoing an id with changed content (must drop the id and add a new entry)', () => {
    const id = TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111')
    expect(() => normalizeCandidate(candidate({
      facts: [{ id, content: 'root cause fixed again' }],
    }), context)).toThrow(/changed content/)
  })

  it('rejects echoing an id into a kinded list that does not match its prefix', () => {
    const id = TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111')
    expect(() => normalizeCandidate(candidate({
      facts: [],
      risks: [{ id, content: 'root cause fixed' }],
    }), context)).toThrow(/base holds it as a fact/)
  })

  it('rejects an evidence reference outside the folded window', () => {
    expect(() => normalizeCandidate(candidate({
      evidence: [{ seq: 999, note: 'out of window' }],
    }), context)).toThrow(/not an included eligible sequence/)
  })

  it('rejects a todo reference outside the folded window', () => {
    expect(() => normalizeCandidate(candidate({
      todoReferences: [{ seq: 999, content: 'out of window' }],
    }), context)).toThrow(/not an included eligible sequence/)
  })

  it('rejects more entries of one kind than the configured cap', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ content: `fact ${i}` }))
    expect(() => normalizeCandidate(candidate({ facts: many }), context)).toThrow(/exceeding maxEntriesPerKind/)
    const manyDecisions = Array.from({ length: 11 }, (_, i) => ({ content: `decision ${i}` }))
    expect(() => normalizeCandidate(candidate({ decisions: manyDecisions }), context)).toThrow(/exceeding maxEntriesPerKind/)
  })

  it('rejects evidence and todo lists over the item cap', () => {
    const manyEvidence = Array.from({ length: 9 }, (_, i) => ({ seq: 5, note: `note ${i}` }))
    expect(() => normalizeCandidate(candidate({ evidence: manyEvidence }), context)).toThrow(/evidence exceeds maxListItems/)
    const manyTodos = Array.from({ length: 9 }, (_, i) => ({ seq: 5, content: `todo ${i}` }))
    expect(() => normalizeCandidate(candidate({ todoReferences: manyTodos }), context)).toThrow(/todoReferences exceeds maxListItems/)
  })

  it('rejects continuation openWork and nextActions over the item cap', () => {
    const manyOpen = Array.from({ length: 9 }, (_, i) => `work ${i}`)
    expect(() => normalizeCandidate(candidate({ continuation: { ...candidate().continuation, openWork: manyOpen } }), context))
      .toThrow(/continuation lists exceed maxListItems/)
    const manyNext = Array.from({ length: 9 }, (_, i) => `next ${i}`)
    expect(() => normalizeCandidate(candidate({ continuation: { ...candidate().continuation, nextActions: manyNext } }), context))
      .toThrow(/continuation lists exceed maxListItems/)
  })

  it('bounds an oversized retained entry to the configured byte limit', () => {
    const huge = 'x'.repeat(2_500)
    const normalized = normalizeCandidate(candidate({ facts: [{ content: huge }] }), context)
    expect(normalized.facts[0]?.content.length).toBeLessThan(2_500)
    expect(normalized.facts[0]?.content.endsWith('…')).toBe(true)
  })

  it('echoes an id into one list and rejects a second list carrying the same id', () => {
    const id = TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111')
    expect(() => normalizeCandidate(candidate({
      facts: [],
      decisions: [{ id, content: 'root cause fixed' }],
    }), context)).toThrow(/base holds it as a fact/)
  })
})

describe('task-state-basic stable commit', () => {
  it('commits a stable whose digest covers the normalized content', () => {
    const normalized = normalizeCandidate(candidate(), context)
    const stable = commitStable(normalized, 1, 2, 'task-state-basic/filter-v2', 5)
    expect(stable.revision).toBe(2)
    expect(stable.sourceCursor).toBe(5)
    expect(stable.digest).toBe(digestOf(normalized))
    expect(stable.facts.length).toBe(1)
  })

  it('rejects a committed stable that fails its durable schema', () => {
    const normalized = normalizeCandidate(candidate(), context)
    expect(() => commitStable(normalized, 1, 0, 'task-state-basic/filter-v2', 5))
      .toThrow(/committed stable failed its durable schema/)
  })
})
