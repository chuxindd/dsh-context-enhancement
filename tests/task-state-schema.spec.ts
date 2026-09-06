import { describe, expect, it } from 'vitest'
import {
  TaskStateEntryId,
  taskStateCandidateEntrySchema,
  taskStateCandidateSchema,
  taskStateRecordSchema,
  taskStateSessionIdentitySchema,
  taskStateStableContentSchema,
  taskStateStableSchema,
  type TaskStateCandidate,
  type TaskStateStable,
  type TaskStateStableContent,
} from '../src/task-state.ts'

/** One canonical committed stable that passes the durable schema. */
function canonical(): TaskStateStable {
  return {
    schemaVersion: 1,
    revision: 2,
    filterVersion: 'filter-v1',
    sourceCursor: 7,
    digest: 'digest-2',
    facts: [{ id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'), content: 'root cause fixed' }],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [{ seq: 7, note: 'tool/result confirmed the fix' }],
    todoReferences: [{ seq: 5, content: 'read the code' }],
    continuation: {
      currentObjective: 'ship the fix',
      currentFocus: 'running the gate',
      openWork: ['cover the failure path'],
      nextActions: ['push the stack'],
    },
  }
}

/** The committed content part of {@link canonical} (without Host metadata). */
function canonicalContent(): TaskStateStableContent {
  return {
    facts: canonical().facts,
    decisions: canonical().decisions,
    constraints: canonical().constraints,
    risks: canonical().risks,
    evidence: canonical().evidence,
    todoReferences: canonical().todoReferences,
    continuation: canonical().continuation,
  }
}

/** A Host-normalized content value whose entries carry ids. */
function contentWithEchoedAndMinted(): TaskStateStableContent {
  return {
    ...canonicalContent(),
    facts: [
      { id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'), content: 'root cause fixed' },
      { id: TaskStateEntryId('fact-22222222-2222-4222-8222-222222222222'), content: 'regression covered' },
    ],
    decisions: [
      { id: TaskStateEntryId('decision-33333333-3333-4333-8333-333333333333'), content: 'ship in this stack' },
    ],
  }
}

describe('task-state durable schemas', () => {
  it('accepts a canonical committed stable', () => {
    expect(taskStateStableSchema.safeParse(canonical()).success).toBe(true)
  })

  it('rejects a stable with a negative cursor or a zero revision', () => {
    expect(taskStateStableSchema.safeParse({ ...canonical(), sourceCursor: -1 }).success).toBe(false)
    expect(taskStateStableSchema.safeParse({ ...canonical(), revision: 0 }).success).toBe(false)
  })

  it('rejects duplicate entry ids across lists', () => {
    const id = TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111')
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      constraints: [{ id, content: 'duplicate id' }],
    }).success).toBe(false)
    expect(taskStateStableContentSchema.safeParse({
      ...canonicalContent(),
      constraints: [{ id, content: 'duplicate id' }],
    }).success).toBe(false)
  })

  it('rejects a blank or untrimmed entry content', () => {
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      decisions: [{ id: TaskStateEntryId('decision-11111111-1111-4111-8111-111111111111'), content: '' }],
    }).success).toBe(false)
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      decisions: [{ id: TaskStateEntryId('decision-11111111-1111-4111-8111-111111111111'), content: ' padded ' }],
    }).success).toBe(false)
  })

  it('rejects a blank or untrimmed entry id on both candidate and committed entries', () => {
    const blankCandidate = { id: '', content: 'fact with blank id' }
    const paddedCandidate = { id: ' fact-11111111-1111-4111-8111-111111111111 ', content: 'padded id' }
    expect(taskStateCandidateEntrySchema.safeParse(blankCandidate).success).toBe(false)
    expect(taskStateCandidateEntrySchema.safeParse(paddedCandidate).success).toBe(false)
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      facts: [{ id: TaskStateEntryId(''), content: 'blank id' }],
    }).success).toBe(false)
  })

  it('accepts a candidate entry without an id and with an echoed id', () => {
    expect(taskStateCandidateEntrySchema.safeParse({ content: 'a fresh fact' }).success).toBe(true)
    expect(taskStateCandidateEntrySchema.safeParse({
      id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'),
      content: 'echoed fact',
    }).success).toBe(true)
  })

  it('rejects a committed stable entry that lacks a Host-minted id', () => {
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      facts: [{ content: 'missing host id' }],
    }).success).toBe(false)
    expect(taskStateStableContentSchema.safeParse({
      ...canonicalContent(),
      facts: [{ content: 'missing host id' }],
    }).success).toBe(false)
  })

  it('accepts a committed content value only when every entry carries an id', () => {
    expect(taskStateStableContentSchema.safeParse(contentWithEchoedAndMinted()).success).toBe(true)
  })

  it('rejects a raw model candidate that still lacks minted ids when validated as stable content', () => {
    const candidate: TaskStateCandidate = {
      ...canonicalContent(),
      facts: [
        { content: 'a new fact the Host must mint' },
        { id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'), content: 'echoed fact' },
      ],
    }
    expect(taskStateCandidateSchema.safeParse(candidate).success).toBe(true)
    expect(taskStateStableContentSchema.safeParse(candidate).success).toBe(false)
  })

  it('accepts a Host-normalized transition from candidate to committed content', () => {
    const candidate: TaskStateCandidate = {
      ...canonicalContent(),
      facts: [{ content: 'a new fact the Host mints' }],
    }
    expect(taskStateCandidateSchema.safeParse(candidate).success).toBe(true)
    const normalized: TaskStateStableContent = {
      ...canonicalContent(),
      facts: [{ id: TaskStateEntryId('fact-44444444-4444-4444-8444-444444444444'), content: 'a new fact the Host mints' }],
    }
    expect(taskStateStableContentSchema.safeParse(normalized).success).toBe(true)
  })

  it('rejects untrimmed or blank continuation fields', () => {
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      continuation: { currentObjective: ' padded ', currentFocus: '', openWork: [], nextActions: [] },
    }).success).toBe(false)
    expect(taskStateStableSchema.safeParse({
      ...canonical(),
      continuation: { currentObjective: 'ok', currentFocus: '', openWork: ['ok'], nextActions: [''] },
    }).success).toBe(false)
  })

  it('accepts an identity and rejects a negative createdAt', () => {
    expect(taskStateSessionIdentitySchema.safeParse({ createdAt: 10, cwd: '/work' }).success).toBe(true)
    expect(taskStateSessionIdentitySchema.safeParse({ createdAt: -1 }).success).toBe(false)
  })

  it('accepts a whole record and rejects an unknown top-level member', () => {
    const record = {
      session: { createdAt: 10, cwd: '/work' },
      stable: canonical(),
    }
    expect(taskStateRecordSchema.safeParse(record).success).toBe(true)
    expect(taskStateRecordSchema.safeParse({ ...record, extra: true }).success).toBe(false)
  })
})
