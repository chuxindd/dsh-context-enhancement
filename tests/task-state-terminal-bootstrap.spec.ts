/**
 * B4.4 · terminal-bootstrap: a terminal verdict BEFORE the first commit, and the
 * fail-closed mechanics that surround it.
 *
 * B4.3 left one gap explicitly open: a Session whose window is infeasible before
 * any stable was committed could not carry a verdict, because the record's
 * `stable` was required. The provider therefore refused to record anything and
 * the window stalled forever — a permanent stall, and a repeated re-fold on
 * every restart. This spec pins the closure of that gap on the REAL storage
 * stack, and it pins the clean break that makes it possible.
 *
 * The questions this spec answers, one test each:
 *  1. is a quarantine for an infeasible window BEFORE the first commit durable,
 *     does a restart recover its effective cursor without re-folding and without
 *     a model call, and is no authority stable ever fabricated to carry it?
 *  2. does a second impossible window AFTER the first-commit quarantine also
 *     avoid re-paying, and does its tail fold from the recovered cursor?
 *  3. does a FAILED terminal write advance nothing and claim nothing — no
 *     cursor, no in-memory verdict, no diagnostic row?
 *  4. are transient infrastructure failures and abandoned in-flight waves free
 *     of any terminal verdict (no permanent ban), while a later legal fact still
 *     gets through?
 *  5. is the clean break real: is the previous v1 domain document neither read
 *     nor rewritten, and does a differently stamped document at the CURRENT
 *     domain name fail the whole open (fail closed, never migrated)?
 *  6. do two independent instances still share one medium with no CAS — the
 *     explicitly RETAINED multi-instance risk this batch does not fix?
 *
 * Composition: real `SessionStore`, real JSONL session persistence, real
 * `Storage` + `StorageJson` + `StorageDomain`, real `LlmRuntime`, and the REAL
 * `TaskStateBasicService`. The only fake is the scripted LLM adapter. Every
 * durable assertion reads the real JSON domain document of the clean-break
 * domain, and every no-re-pay assertion counts real adapter requests.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../src/task-state-basic.ts'
import { TaskStateRequestId } from '../src/task-state.ts'
import type { TaskStateQuarantinedVerdict, TaskStateRecord } from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import { taskStateDomainSpec } from '../src/internal/task-state/basic/domain.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'

/**
 * Deployment-shaped config. `maxInputBytes` is the budget this spec moves: the
 * empty frame is 201 bytes, so 1 500 bytes admits a small ordinary window and
 * rejects one oversized event on its own.
 */
const BASE_CONFIG: TaskStateBasicConfig = {
  provider: 'current-route',
  model: 'current-model',
  minEvents: 1,
  maxEvents: 200,
  maxInputBytes: 1_500,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 500,
  maxListItems: 8,
}

const PROVIDER = 'current-route'
const CREATED_AT = 1_700_000_000_000
const DOMAIN_FILE = 'context_enhancement_task_state_v2.json'
/** The RETIRED generation's document: never opened, read, migrated, or rewritten. */
const LEGACY_DOMAIN_FILE = 'context_enhancement_task_state.json'

/** One oversized ordinary fact whose own frame exceeds the budget. */
const OVERSIZED_TEXT = 'x'.repeat(3_000)

/** A small candidate whose committed stable keeps the NEXT base frame feasible. */
const SMALL_CANDIDATE = JSON.stringify({
  facts: [{ content: 'baseline fact' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [],
  continuation: {
    currentObjective: 'keep the baseline',
    currentFocus: 'bootstrapping',
    openWork: [],
    nextActions: [],
  },
})

/** One scripted answer for a single adapter call. */
type Script =
  | { readonly kind: 'output'; readonly text: string; readonly delayMs?: number }
  | { readonly kind: 'finish-error'; readonly code: string; readonly message: string }

/** Adapter that replays one script entry per request and records every frame. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: { readonly includedSeqs: readonly number[] }[] = []

  constructor(private readonly script: Script[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script[Math.min(this.requests.length, this.script.length - 1)]
    this.requests.push({ includedSeqs: readFrameSeqs(options) })
    if (entry !== undefined && entry.kind === 'finish-error') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: entry.code, message: entry.message } } }
      return
    }
    if (entry?.kind === 'output' && entry.delayMs !== undefined) {
      await new Promise<void>(resolve => setTimeout(resolve, entry.delayMs))
    }
    const body = entry === undefined || entry.kind !== 'output' ? SMALL_CANDIDATE : entry.text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The eligible sequences of the frame one request received. */
function readFrameSeqs(options: GenerateOptions): number[] {
  const messages = (options.messages ?? []) as readonly { readonly content?: unknown }[]
  const texts = messages
    .flatMap(message => Array.isArray(message.content) ? message.content as readonly unknown[] : [])
    .filter((block): block is { readonly type: string; readonly text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as { readonly events?: readonly { readonly seq: number }[] }
      if (Array.isArray(parsed.events)) return parsed.events.map(event => Number(event.seq))
    } catch {
      // Not the frame: keep looking.
    }
  }
  throw new Error('task-state-terminal-bootstrap: no framed projection was delivered to the adapter')
}

const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch(() => {})
  }
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

/** One mounted host stack with a real storage root and real session logs. */
interface Mounted {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly storageRoot: string
  readonly held: { preparation: unknown; detach: () => void }[]
}

/** Mount sessions + real storage/domain + llm, WITHOUT the task-state provider. */
async function mountBase(
  scratch: string,
  adapter: ScriptedAdapter,
  sessionRoot = join(scratch, 'sessions'),
): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = join(scratch, 'storage')
  await mkdir(storageRoot, { recursive: true })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: sessionRoot,
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter, storageRoot, held: [] }
}

/** Mount the base stack plus the real task-state provider, and await its init. */
async function mountComposition(
  scratch: string,
  overrides: Partial<TaskStateBasicConfig> = {},
  script: Script[] = [{ kind: 'output', text: SMALL_CANDIDATE }],
  sessionRoot?: string,
): Promise<Mounted> {
  const adapter = new ScriptedAdapter(script)
  const mounted = await mountBase(scratch, adapter, sessionRoot)
  await mounted.ctx.plugin(TaskStateBasicService, { ...BASE_CONFIG, ...overrides })
  return mounted
}

/** Append one direct human user/message and return its seq. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Resume one durable Session through the production persistence idiom. */
async function resume(ctx: Context, id: SessionId, mounted?: Mounted): Promise<Session> {
  const persistence = (ctx as unknown as {
    sessionPersistence: { prepare: (id: SessionId) => Promise<unknown> }
  }).sessionPersistence
  const preparation = await persistence.prepare(id)
  const session = (preparation as { readonly session: Session }).session
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  mounted?.held.push({ preparation, detach })
  return session
}

/** Release one held preparation through its `Symbol.dispose` protocol. */
function releasePreparation(preparation: unknown): void {
  const dispose = (preparation as Record<PropertyKey, unknown> | undefined)?.[Symbol.dispose as unknown as PropertyKey]
  if (typeof dispose === 'function') (dispose as () => void).call(preparation)
}

/** Close one mounted stage completely, draining the durable writers first. */
async function closeProcess(mounted: Mounted): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  for (const handle of mounted.held.splice(0)) {
    handle.detach()
    releasePreparation(handle.preparation)
  }
  await mounted.ctx.fiber.dispose()
  const index = contexts.indexOf(mounted.ctx)
  if (index >= 0) contexts.splice(index, 1)
}

/** Poll one predicate until it holds or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`task-state-terminal-bootstrap: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Let the ONE startup backlog check of a fresh runtime run over an empty backlog. */
async function settleStartupCheck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 30))
}

/** Settle asynchronous scheduler work that must NOT produce anything. */
async function settleQuiet(ms = 250): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

/** The concrete provider behind `ctx.taskState` (test seam, same as B4.1–B4.3). */
function providerOf(ctx: Context): TaskStateBasicService {
  return ctx.get('taskState') as TaskStateBasicService
}

/** Every durable audit row of the live domain. */
function auditRows(ctx: Context): TaskStateAuditRecord[] {
  const table = (providerOf(ctx) as unknown as {
    auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
  }).auditTable
  if (table === undefined) return []
  return [...table.entries()].map(entry => entry[1])
}

/**
 * The provider's served terminal verdict ASSERTED to be a quarantine.
 * @param ctx - the mounted Context whose provider owns the verdict.
 * @param id - the Session id.
 * @returns the quarantined verdict.
 */
function quarantinedOf(ctx: Context, id: SessionId): TaskStateQuarantinedVerdict {
  const terminal = providerOf(ctx).getTerminal(id)
  expect(terminal?.kind).toBe('quarantined')
  return terminal as TaskStateQuarantinedVerdict
}

/** The raw durable domain document on disk, or `null` when absent/unparsable. */
async function readDomain(storageRoot: string, file = DOMAIN_FILE): Promise<RawDomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, file), 'utf8')) as RawDomainDoc
  } catch {
    return null
  }
}

/** The durable document shape this spec reads (deliberately loose, JSON-level). */
interface RawDomainDoc {
  readonly unit?: { readonly name: string; readonly version: number }
  readonly tables: {
    readonly sessions: Record<string, {
      readonly session?: { readonly createdAt: number; readonly cwd?: string }
      readonly stable?: { readonly revision: number; readonly sourceCursor: number }
      readonly terminal?: { readonly kind?: string; readonly cursor: number; readonly requestId?: string }
    }>
    readonly audit: Record<string, { readonly finished?: { readonly outcome: string } }>
  }
}

describe('task-state terminal bootstrap (B4.4)', () => {
  it('persists a first-commit quarantine, never fabricates a stable, and restores its cursor without re-paying', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-bootstrap-nobase-'))
    const sessionId = SessionId('terminal-bootstrap-nobase')
    const first = await mountComposition(root, {}, [
      { kind: 'output', text: SMALL_CANDIDATE },
      { kind: 'output', text: SMALL_CANDIDATE },
    ])
    let requestId: string
    let culprits: number[]
    try {
      await settleStartupCheck()
      const session = first.ctx.sessions.create(sessionId, {
        meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
      })
      // TWO independently impossible facts before ANY commit: the first is
      // quarantined, the second is the next wave's measured culprit. Neither may
      // cost a model call, and the schedule must continue on its own.
      culprits = [appendUser(session, OVERSIZED_TEXT), appendUser(session, `${OVERSIZED_TEXT}y`)]
      await waitUntil(
        () => providerOf(first.ctx).getTerminal(session.id)?.cursor === culprits[1],
        5_000,
        'second first-commit quarantine',
      )

      // Not a single model call: both culprits are quarantined as measured.
      expect(first.adapter.requests.length).toBe(0)
      expect(first.ctx.taskState.getStable(session.id)).toBeUndefined()
      const verdict = quarantinedOf(first.ctx, session.id)
      expect(verdict.cursor).toBe(culprits[1])
      expect(verdict.includedSeqs).toEqual([culprits[1]])
      expect(verdict.generation.baseSourceCursor).toBe(-1)
      expect(verdict.generation.baseFilterVersion).toBe('none')
      expect(verdict.generation.maxInputBytes).toBe(BASE_CONFIG.maxInputBytes)
      requestId = verdict.requestId
      expect(String(requestId).length).toBeGreaterThan(0)

      // Durable: the record is the identity plus the verdict and NOTHING else.
      const doc = await readDomain(first.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record).toBeDefined()
      expect(record?.stable).toBeUndefined()
      expect(record?.terminal?.kind).toBe('quarantined')
      expect(record?.terminal?.cursor).toBe(culprits[1])
      expect(doc?.unit).toEqual({ name: 'context_enhancement_task_state_v2', version: 2 })
      await settleQuiet(200)
    } finally {
      await closeProcess(first)
    }

    // Restart: the verdict is recovered verbatim, the cursor is not re-derived
    // by folding, and the impossible window is NEVER paid for again.
    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await settleQuiet(400)
      expect(second.adapter.requests.length).toBe(0)
      expect(second.ctx.taskState.getStable(resumed.id)).toBeUndefined()
      const restored = quarantinedOf(second.ctx, resumed.id)
      expect(restored.requestId).toBe(requestId)
      expect(restored.cursor).toBe(culprits[1])
      expect(restored.includedSeqs).toEqual([culprits[1]])

      // The recovered cursor still admits NEW work: a later legal fact folds from
      // it and commits the FIRST revision — no fabricated skeleton, no replay.
      const laterSeq = appendUser(resumed, 'a legal fact after the quarantines')
      await waitUntil(() => second.ctx.taskState.getStable(resumed.id)?.revision === 1, 5_000, 'first commit')
      expect(second.adapter.requests.length).toBe(1)
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([laterSeq])
      const committed = second.ctx.taskState.getStable(resumed.id)!
      expect(committed.sourceCursor).toBe(laterSeq)
      expect(committed.facts.map(fact => fact.content)).toEqual(['baseline fact'])
      await settleQuiet(200)
      const after = await readDomain(second.storageRoot)
      const afterRecord = after?.tables.sessions[String(sessionId)]
      expect(afterRecord?.stable?.revision).toBe(1)
      expect(afterRecord?.stable?.sourceCursor).toBe(laterSeq)
      expect(afterRecord?.terminal?.cursor).toBe(culprits[1])
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('advances nothing and claims nothing when the terminal write itself fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-bootstrap-writefail-'))
    const sessionId = SessionId('terminal-write-fails')
    const mounted = await mountComposition(root)
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    let culprit: number
    try {
      await settleStartupCheck()
      const provider = providerOf(mounted.ctx)
      // The authority put is the only step that may advance anything, so make it
      // REJECT for the whole of this stage and prove that the wave fails closed.
      const table = (provider as unknown as {
        sessionsTable?: {
          get: (key: string) => TaskStateRecord | undefined
          put: (key: string, value: TaskStateRecord) => Promise<void>
        }
      }).sessionsTable
      expect(table).toBeDefined()
      const original = table!.put.bind(table)
      let attempts = 0
      table!.put = async (key, value) => {
        if (value.terminal !== undefined) {
          attempts += 1
          throw new Error('terminal record put rejected')
        }
        await original(key, value)
      }

      culprit = appendUser(session, OVERSIZED_TEXT)
      await waitUntil(() => attempts > 0, 5_000, 'refused verdict write')
      await settleQuiet(300)

      // The refusal is proven to have been exercised, and it produced NOTHING:
      // no in-memory verdict, no durable record, no diagnostic claim, and no
      // cursor anywhere — while the pending window is still exactly pending.
      expect(mounted.adapter.requests.length).toBe(0)
      expect(provider.getTerminal(session.id)).toBeUndefined()
      expect(mounted.ctx.taskState.getStable(session.id)).toBeUndefined()
      expect(table!.get(String(session.id))).toBeUndefined()
      const pending = mounted.ctx.sessions.get(session.id)!
      expect(pending.snapshotEvents().some(event => Number(event.seq) === culprit)).toBe(true)
      expect(auditRows(mounted.ctx).some(row => row.finished?.outcome === 'terminal-infeasible')).toBe(false)
    } finally {
      await closeProcess(mounted)
    }

    // A restart measures the SAME still-pending window once more — proof that the
    // refusal lost nothing — and this time the medium accepts the verdict.
    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await waitUntil(() => providerOf(second.ctx).getTerminal(resumed.id) !== undefined, 5_000, 'verdict on restart')
      const verdict = quarantinedOf(second.ctx, resumed.id)
      expect(verdict.cursor).toBe(culprit)
      expect(verdict.includedSeqs).toEqual([culprit])
      expect(second.adapter.requests.length).toBe(0)
      const doc = await readDomain(second.storageRoot)
      const record = doc?.tables.sessions[String(sessionId)]
      expect(record?.stable).toBeUndefined()
      expect(record?.terminal?.kind).toBe('quarantined')
      expect(record?.terminal?.cursor).toBe(culprit)
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('writes no terminal verdict for a transient failure or an abandoned wave, and never bans the session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-bootstrap-transient-'))
    const sessionId = SessionId('terminal-transient')
    // Stage A: the FIRST wave commits the baseline, the SECOND fails transiently
    // and the THIRD is abandoned in flight because the process dies mid-request.
    const first = await mountComposition(root, {}, [
      { kind: 'output', text: SMALL_CANDIDATE },
      { kind: 'finish-error', code: 'SERVER', message: 'provider is temporarily unavailable' },
      { kind: 'output', text: SMALL_CANDIDATE, delayMs: 2_000 },
    ])
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    let transientSeq: number
    let abandonedSeq: number
    try {
      await settleStartupCheck()
      const firstSeq = appendUser(session, 'a baseline fact')
      await waitUntil(() => first.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'baseline commit')
      expect(first.adapter.requests.length).toBe(1)

      transientSeq = appendUser(session, 'a fact whose update fails transiently')
      await waitUntil(() => first.adapter.requests.length === 2, 5_000, 'transient attempt')
      await waitUntil(() => auditRows(first.ctx).some(row => row.finished?.outcome === 'failure'), 5_000, 'transient row')
      expect(providerOf(first.ctx).getTerminal(session.id)).toBeUndefined()
      expect(first.ctx.taskState.getStable(session.id)?.sourceCursor).toBe(firstSeq)

      // The transient failure wrote no verdict, so the tail is still admissible:
      // a further fact admits the next wave, which is then abandoned in flight.
      abandonedSeq = appendUser(session, 'a fact folded by an abandoned wave')
      await waitUntil(() => first.adapter.requests.length === 3, 5_000, 'in-flight wave')
      const doc = await readDomain(first.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]?.terminal).toBeUndefined()
      expect(providerOf(first.ctx).getTerminal(session.id)).toBeUndefined()
      expect(transientSeq).toBeGreaterThan(firstSeq)
      expect(abandonedSeq).toBeGreaterThan(transientSeq)
      // Neither the transient failure nor the abandoned wave advanced anything.
      expect(doc?.tables.sessions[String(sessionId)]?.stable?.sourceCursor).toBe(firstSeq)
    } finally {
      await closeProcess(first)
    }

    const second = await mountComposition(root)
    try {
      await settleQuiet(60)
      const resumed = await resume(second.ctx, sessionId, second)
      // The abandoned attempt and the transient failure left no ban: the
      // inherited tail is folded by the ordinary startup backlog check and the
      // session reaches revision 2 instead of staying permanently stalled.
      await waitUntil(() => second.ctx.taskState.getStable(resumed.id)?.revision === 2, 5_000, 'recovered commit')
      expect(providerOf(second.ctx).getTerminal(resumed.id)).toBeUndefined()
      expect(second.adapter.requests.length).toBe(1)
      // The facts that were pending behind the transient failure and the
      // abandoned wave are exactly the ones this commit folds: nothing lost.
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([transientSeq, abandonedSeq])
      expect(second.ctx.taskState.getStable(resumed.id)!.sourceCursor).toBe(abandonedSeq)
      await settleQuiet(200)
      expect(providerOf(second.ctx).getTerminal(resumed.id)).toBeUndefined()
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('never reads or rewrites the retired v1 document and fails closed on a mismatched stamp', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-bootstrap-cleanbreak-'))
    // A genuine-looking v1 document of the PREVIOUS generation, planted where it
    // used to live: one committed stable that this build must never adopt.
    const legacyBody = `${JSON.stringify({
      unit: { name: 'context_enhancement_task_state', version: 1 },
      global: null,
      tables: {
        sessions: {
          'legacy-session': {
            session: { createdAt: CREATED_AT, cwd: 'C:\\legacy' },
            stable: { schemaVersion: 1, revision: 7, filterVersion: 'task-state-basic/filter-v3', sourceCursor: 42, digest: 'legacy-digest' },
          },
        },
        audit: {},
      },
    }, null, 2)}\n`
    await mkdir(join(root, 'storage'), { recursive: true })
    await writeFile(join(root, 'storage', LEGACY_DOMAIN_FILE), legacyBody, 'utf8')
    const legacyPath = join(root, 'storage', LEGACY_DOMAIN_FILE)
    const before = await stat(legacyPath)

    const mounted = await mountComposition(root)
    const sessionId = SessionId('cleanbreak-session')
    try {
      await settleStartupCheck()
      const session = mounted.ctx.sessions.create(sessionId, {
        meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
      })
      appendUser(session, 'a fact of the new generation')
      await waitUntil(() => mounted.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'new-generation commit')

      // The new generation is alive and writes its OWN document...
      const current = await readDomain(mounted.storageRoot)
      expect(current?.unit).toEqual({ name: 'context_enhancement_task_state_v2', version: 2 })
      expect(Object.keys(current?.tables.sessions ?? {})).toEqual([String(sessionId)])
      // ...the retired document is byte-identical and its record was never
      // adopted (revision 7 and cursor 42 appear nowhere in the live state)...
      expect(await readFile(legacyPath, 'utf8')).toBe(legacyBody)
      const after = await stat(legacyPath)
      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(mounted.ctx.taskState.getStable(session.id)?.revision).toBe(1)
      expect(mounted.ctx.taskState.getStable(session.id)?.sourceCursor).not.toBe(42)
      expect(mounted.ctx.taskState.getStable(SessionId('legacy-session'))).toBeUndefined()
    } finally {
      await closeProcess(mounted)
    }

    // A document stamped for ANOTHER version at the CURRENT domain name is not
    // reinterpreted and not migrated: the whole open fails and task state is
    // disabled for the overlay, leaving ordinary Sessions usable.
    const corruptRoot = await mkdtemp(join(tmpdir(), 'dsh-terminal-bootstrap-mismatch-'))
    try {
      await mkdir(join(corruptRoot, 'storage'), { recursive: true })
      await writeFile(join(corruptRoot, 'storage', DOMAIN_FILE), `${JSON.stringify({
        unit: { name: 'context_enhancement_task_state_v2', version: 1 },
        global: null,
        tables: { sessions: {}, audit: {} },
      }, null, 2)}\n`, 'utf8')
      const probe = await mountComposition(corruptRoot)
      try {
        const session = probe.ctx.sessions.create(SessionId('mismatch-session'), {
          meta: { cwd: probe.storageRoot, createdAt: CREATED_AT },
        })
        appendUser(session, 'an event that must not start a wave')
        await settleQuiet(300)
        expect(probe.ctx.taskState.getStable(session.id)).toBeUndefined()
        expect(probe.adapter.requests.length).toBe(0)
        expect(providerOf(probe.ctx).getTerminal(session.id)).toBeUndefined()
        // Fail closed without rewriting the unacceptable medium.
        const raw = await readFile(join(corruptRoot, 'storage', DOMAIN_FILE), 'utf8')
        expect(JSON.parse(raw).unit.version).toBe(1)
      } finally {
        await closeProcess(probe)
      }
    } finally {
      await rm(corruptRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it('still shares one medium between two independent instances, with no CAS (the retained B1 risk)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-terminal-bootstrap-multiinstance-'))
    const sessionId = SessionId('shared-medium-session')
    const first = await mountComposition(root)
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    // A SECOND, independent storage stack over the SAME storage root. This is the
    // faithful stand-in for a second OS process at the storage API boundary: the
    // only thing the two stacks share is the medium (B1/E10's measured shape).
    const secondCtx = new Context()
    contexts.push(secondCtx)
    await secondCtx.plugin(Storage)
    await secondCtx.plugin(StorageJson, { root: join(root, 'storage') })
    await secondCtx.plugin(StorageDomain, { backend: 'json' })
    try {
      const secondDomain = await secondCtx.storageDomain.open(taskStateDomainSpec)
      const secondSessions = secondDomain.table('sessions') as unknown as {
        get: (key: string) => unknown
        put: (key: string, value: unknown) => Promise<void>
      }
      // The second stack opened the SAME unit (the exactly-one-handle guard is
      // per-registry, so it is a same-process guard only) and never re-reads, so
      // it holds NO record: exactly the stale view a second process has.
      expect(secondSessions.get(String(session.id))).toBeUndefined()

      appendUser(session, 'a fact of the single-writer contract')
      await waitUntil(() => first.ctx.taskState.getStable(session.id) !== undefined, 5_000, 'instance A commit')
      const committed = first.ctx.taskState.getStable(session.id)!
      expect(committed.revision).toBe(1)
      // Still stale after A's commit: there is no refresh or reopen primitive.
      expect(secondSessions.get(String(session.id))).toBeUndefined()

      // The second writer now publishes a terminal verdict from that stale view.
      // There is no revision precondition and no conflict signal, so this
      // resolves as an ordinary success: the whole document is rewritten and A's
      // committed record is silently erased. That is precisely the B1
      // `blocked-upstream` risk this batch does NOT fix, keeps enabled, and must
      // not claim to fix — B4.4's record shape changes nothing about it.
      await secondSessions.put(String(session.id), {
        session: { createdAt: CREATED_AT, cwd: first.storageRoot },
        terminal: {
          kind: 'quarantined',
          requestId: String(TaskStateRequestId('ts-terminal-b4-4-stale')),
          generation: {
            baseSourceCursor: -1,
            baseFilterVersion: 'none',
            baseDigest: 'none',
            maxInputBytes: BASE_CONFIG.maxInputBytes,
          },
          cursor: 99,
          includedSeqs: [99],
          code: 'BUDGET',
          reason: 'a stale writer that never saw instance A',
          time: Date.now(),
        },
      })

      // A's committed stable is gone from the medium, with no error anywhere...
      const doc = await readDomain(first.storageRoot)
      expect(doc?.tables.sessions[String(sessionId)]?.stable).toBeUndefined()
      expect(doc?.tables.sessions[String(sessionId)]?.terminal?.cursor).toBe(99)
      // ...while A keeps serving its own in-memory pointer, which is why the
      // divergence is silent rather than loud.
      expect(first.ctx.taskState.getStable(session.id)?.revision).toBe(committed.revision)
      await secondDomain.close()
    } finally {
      await closeProcess(first)
      await secondCtx.fiber.dispose()
      const index = contexts.indexOf(secondCtx)
      if (index >= 0) contexts.splice(index, 1)
    }
  }, 60_000)
})
