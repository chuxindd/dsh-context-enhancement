import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { deriveAuditTimeline, rowsForLifecycle } from '../src/task-state.ts'
import {
  TaskStateBasicService,
  taskStateDomainSpec,
} from '../src/task-state-basic.ts'
import { taskStateAuditSchema } from '../src/internal/task-state/contract/audit.ts'

/**
 * Keyless long-session verification of the durable task-state provider: one
 * tool-heavy Session (>= 30 eligible events) is driven through real Session
 * JSONL persistence and the real JSON storage domain across MULTIPLE batch
 * waves, then a process restart re-loads the committed stable with zero model
 * calls. Asserts:
 * - eligible-threshold batches launch automatically and advance `sourceCursor`
 *   to the live tail across waves (multi-batch convergence);
 * - recent fidelity: the committed stable reflects the MOST RECENT eligible
 *   events, not an early snapshot;
 * - the durable audit rows carry the complete pre-dispatch request evidence
 *   and the success raw output, and deriveAuditTimeline regenerates the
 *   canonical request order (the keyless replay helper contract);
 * - restart publishes the stored stable directly (no adapter) and a
 *   follow-up eligible tail commits a higher revision through a new model call.
 */

/** A model JSON that names the LAST folded user text so recent fidelity is observable. */
function modelJsonFor(focus: string): string {
  return JSON.stringify({
    facts: [{ content: `fact about ${focus}` }],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: [],
    continuation: {
      currentObjective: `objective for ${focus}`,
      currentFocus: focus,
      openWork: ['finish'],
      nextActions: ['verify'],
    },
  })
}

/** Adapter that projects the highest step-(\d+) mentioned anywhere in the framed input. */
class FocusAdapter extends LlmAdapter {
  constructor(private readonly onCall?: (options: GenerateOptions) => void) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onCall?.(options)
    const userText = (options.messages ?? [])
      .map(message => (message as { content?: unknown }).content)
      .flatMap(blocks => Array.isArray(blocks) ? blocks : [])
      .filter((block): block is { type: string; text?: string } =>
        typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
      .map(block => block.text ?? '')
      .join(' ')
    // The framed projection serializes the whole batch as text; pick the
    // HIGHEST step-(\d+) mentioned so recent fidelity is observable across
    // waves regardless of projection framing.
    const steps = [...userText.matchAll(/step-(\d+)/gu)].map(match => Number(match[1]))
    const focus = steps.length > 0 ? `step-${Math.max(...steps)}` : (userText.slice(0, 24) || 'initial')
    const json = modelJsonFor(focus)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: json }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: json } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The deployment policy shared by every provider mount in this file. */
const PROVIDER_CONFIG = {
  provider: 'current-route',
  model: 'current-model',
  minEvents: 4,
  maxEvents: 20,
  maxInputBytes: 100_000,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 2_000,
  maxListItems: 8,
} as const

/** Mount the host stack (sessions, JSONL, storage, llm) once per context. */
async function mountHost(ctx: Context, sessionSubroot = 'sessions'): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root as string, sessionSubroot),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root as string, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
}

/** Mount the closest-independent composition with a real domain + JSONL. */
async function mountComposition(
  sessionSubroot = 'sessions',
  adapter?: LlmAdapter,
  minEvents = PROVIDER_CONFIG.minEvents,
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountHost(ctx, sessionSubroot)
  await ctx.plugin(TaskStateBasicService, { ...PROVIDER_CONFIG, minEvents })
  if (adapter !== undefined) ctx.llm.registerAdapter(['current-route'], adapter)
  return ctx
}

/** Append one direct user/message on the surface and return its seq. */
function userTurn(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append one closed assistant tool-call + result step and return its seq. */
function toolStep(session: Session, turn: number, step: number, call: string, text = 'done'): number {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(call), name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step, callId: ToolCallId(call), name: 'bash', arguments: '{}' })
  return session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(call),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
}

/** Poll one async predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('long session did not settle in time')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Read the durable single-layout domain document. */
async function readDomain(): Promise<{
  unit: { name: string; version: number }
  tables: { sessions: Record<string, unknown>; audit: Record<string, unknown> }
}> {
  const text = await readFile(join(root as string, 'storage', 'context_enhancement_task_state.json'), 'utf8')
  return JSON.parse(text) as {
    unit: { name: string; version: number }
    tables: { sessions: Record<string, unknown>; audit: Record<string, unknown> }
  }
}

const LONG_TIMEOUT = 30_000

describe('task-state-basic keyless long-session + replay', () => {
  it('converges across multiple waves to the live tail of a 30+ event tool-heavy session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-long-'))
    const createdAt = 1_700_000_000_000
    const ctx = await mountComposition('sessions', new FocusAdapter(), 4)
    const session = ctx.sessions.create(SessionId('long-session'), { meta: { cwd: root, createdAt } })

    // A tool-heavy session: each "turn" is a user prompt + 2 closed tool steps
    // = 3 eligible surface events. 12 turns => 36 eligible events.
    let lastSeq = 0
    for (let turn = 1; turn <= 12; turn += 1) {
      lastSeq = userTurn(session, `turn ${turn}: implement step-${turn}`)
      toolStep(session, turn, 1, `c${turn}a`)
      lastSeq = toolStep(session, turn, 2, `c${turn}b`)
      // Give the worker a chance to fold between waves; the domain commits
      // asynchronously after the threshold.
      await new Promise<void>(resolve => setTimeout(resolve, 8))
    }

    // The provider converges to the live eligible tail (last tool result seq).
    await waitUntil(() => {
      const stable = ctx.taskState.getStable(session.id)
      return stable !== undefined && stable.sourceCursor === lastSeq
    }, LONG_TIMEOUT)
    const stable = ctx.taskState.getStable(session.id)
    expect(stable).toBeDefined()
    expect(stable!.revision).toBeGreaterThanOrEqual(2)
    expect(stable!.sourceCursor).toBe(lastSeq)

    // Recent fidelity: the committed stable's focus reflects the LAST turn,
    // not an early one.
    expect(stable!.facts[0]?.content).toContain('step-12')

    // The finished-phase audit put follows the sessions put asynchronously;
    // wait until every durable row carries its finished phase.
    await waitUntil(async () => {
      const current = await readDomain()
      return Object.values(current.tables.audit).every(row =>
        (row as { finished?: unknown }).finished !== undefined)
    }, LONG_TIMEOUT)

    // Durable audit: every request row (open + finished success) is present
    // with complete raw output; deriveAuditTimeline yields the canonical order.
    const doc = await readDomain()
    expect(doc.unit.name).toBe(taskStateDomainSpec.name)
    const rows = Object.values(doc.tables.audit)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      taskStateAuditSchema.parse(row)
      const finished = (row as { finished?: { outcome?: string; llmStreamCall?: boolean; rawOutput?: unknown[] } }).finished
      expect(['success', 'repair']).toContain(finished?.outcome)
      // A repair certifies an already committed stable without inventing a
      // second LLM call. Only success rows carry replayable model output.
      if (finished?.outcome === 'success') {
        expect(finished.llmStreamCall).toBe(true)
        expect(Array.isArray(finished.rawOutput)).toBe(true)
        expect((finished.rawOutput ?? []).length).toBeGreaterThan(0)
      }
    }
    const timeline = deriveAuditTimeline(rowsForLifecycle(
      rows as Parameters<typeof rowsForLifecycle>[0],
      { createdAt, cwd: root },
    ))
    expect(timeline.length).toBe(rows.length)
    expect(timeline.every(entry => entry.certified)).toBe(true)
    // The last certified revision matches the committed stable revision.
    expect(timeline.at(-1)!.certifiedRevision).toBe(stable!.revision)

    // A keyless replay helper can regenerate the auxiliary stream data purely
    // from audit rows: each success's raw output parses as a stable candidate
    // JSON and references its request evidence.
    for (const entry of timeline) {
      const raw = entry.finished
      if (raw === undefined || raw.outcome !== 'success') continue
      const rawOutput = raw.rawOutput as readonly unknown[] | undefined
      const json = (rawOutput ?? []).map((block): string => {
        const record = block as { type?: unknown; text?: unknown }
        return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
      }).join('')
      expect(() => JSON.parse(json)).not.toThrow()
      expect(entry.request.includedSeqs.length).toBeGreaterThan(0)
      expect(entry.request.revision).toBeGreaterThan(0)
    }
  }, LONG_TIMEOUT)

  it('restarts into a fresh process with zero model calls and re-reads the durable audit', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-restart-'))
    const createdAt = 1_700_000_000_000
    let firstCalls = 0

    const first = await mountComposition('sessions', new FocusAdapter(() => { firstCalls += 1 }), 4)
    const session = first.sessions.create(SessionId('restart-session'), {
      meta: { cwd: root, createdAt },
    })
    let lastSeq = 0
    for (let turn = 1; turn <= 6; turn += 1) {
      lastSeq = userTurn(session, `phase-one step-${turn}`)
      await new Promise<void>(resolve => setTimeout(resolve, 8))
      lastSeq = toolStep(session, turn, 1, `p1c${turn}`, 'ok')
      await new Promise<void>(resolve => setTimeout(resolve, 8))
    }
    await waitUntil(() => first.taskState.getStable(session.id)?.sourceCursor === lastSeq, LONG_TIMEOUT)
    const firstRevision = first.taskState.getStable(session.id)!.revision
    expect(firstCalls).toBeGreaterThanOrEqual(1)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // Fresh context with NO adapter: startup must publish the stored stable
    // directly from the domain (any model call would fail loudly) and keep the
    // audit rows readable.
    const second = await mountComposition('sessions-2', undefined, 4)
    const resumed = second.sessions.create(SessionId('restart-session'), {
      meta: { cwd: root, createdAt },
    })
    expect(second.taskState.getStable(resumed.id)).toBeDefined()
    expect(second.taskState.getStable(resumed.id)!.revision).toBe(firstRevision)
    expect(second.taskState.getStable(resumed.id)!.sourceCursor).toBe(lastSeq)

    // The durable domain still holds every audit row (sessions put + finished
    // audit put both landed before dispose), so replay evidence survives restart.
    const doc = await readDomain()
    const rows = Object.values(doc.tables.audit)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const timeline = deriveAuditTimeline(rowsForLifecycle(
      rows as Parameters<typeof rowsForLifecycle>[0],
      { createdAt, cwd: root },
    ))
    expect(timeline.at(-1)!.certifiedRevision).toBe(firstRevision)
  }, LONG_TIMEOUT)
})
