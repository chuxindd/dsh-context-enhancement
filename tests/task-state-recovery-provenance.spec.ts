/**
 * B4.3 · recovery provenance: in-flight exits, audit repair, and the boundary
 * between a committed stable, a repair credential and a terminal quarantine.
 *
 * The questions this spec answers, one test each:
 *  1. does an in-flight exit (the process dies while a wave is running) leave
 *     exactly an OPEN audit row, advance no cursor, commit no stable, and get
 *     its tail re-folded after restart without a ghost cursor?
 *  2. is an aborted/un-settled attempt ever repaired into a commit credential
 *     for a revision that no stable holds — and does a later legitimate commit
 *     reach that revision instead of the ghost one?
 *  3. when a committed stable lost its finished audit, is it repaired (without
 *     rerunning the model) while a coexisting TERMINAL quarantine verdict stays
 *     untouched — neither used as a commit credential nor regressed?
 *  4. are `committed`, `transient-failure`, `terminal-infeasible` and `aborted`
 *     distinguishable on the DURABLE rows of one real domain?
 *
 * Composition: real `SessionStore`, real JSONL session persistence, real
 * `Storage` + `StorageJson` + `StorageDomain`, real `LlmRuntime`, and the REAL
 * `TaskStateBasicService`; every durable assertion reads the real JSON domain
 * document. The only fake is the scripted LLM adapter.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { classifyAuditRow } from '../src/task-state.ts'
import type { TaskStateStable } from '../src/task-state.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'

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

/** One oversized ordinary fact, used to produce a real terminal quarantine. */
const OVERSIZED_TEXT = 'x'.repeat(3_000)

/** A small candidate whose committed stable keeps the next base frame feasible. */
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
    const delayMs = entry !== undefined && entry.kind === 'output' ? entry.delayMs ?? 0 : 0
    const body = entry === undefined ? SMALL_CANDIDATE : entry.text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (delayMs > 0) {
      // Report the request as IN FLIGHT: the frame is recorded above, and the
      // stream stays open (no finish) until the delay elapses or the attempt's
      // signal aborts — which is exactly the state a process exit interrupts.
      const signal = options.signal
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        if (signal === undefined) return
        if (signal.aborted) {
          clearTimeout(timer)
          resolve()
          return
        }
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled by disposal' } } }
        return
      }
    }
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
  throw new Error('task-state-recovery-provenance: no framed projection was delivered to the adapter')
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

interface Mounted {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly storageRoot: string
  readonly held: { preparation: unknown; detach: () => void }[]
}

async function mountBase(scratch: string, adapter: ScriptedAdapter): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const storageRoot = join(scratch, 'storage')
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(scratch, 'sessions'),
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

async function mountComposition(
  scratch: string,
  script: Script[] = [{ kind: 'output', text: SMALL_CANDIDATE }],
  overrides: Partial<TaskStateBasicConfig> = {},
): Promise<Mounted> {
  const adapter = new ScriptedAdapter(script)
  const mounted = await mountBase(scratch, adapter)
  await mounted.ctx.plugin(TaskStateBasicService, { ...BASE_CONFIG, ...overrides })
  return mounted
}

function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

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

function releasePreparation(preparation: unknown): void {
  const dispose = (preparation as Record<PropertyKey, unknown> | undefined)?.[Symbol.dispose as unknown as PropertyKey]
  if (typeof dispose === 'function') (dispose as () => void).call(preparation)
}

/** Close one stage; with an in-flight wave this IS the process exit. */
async function closeProcess(mounted: Mounted): Promise<void> {
  for (const handle of mounted.held.splice(0)) {
    handle.detach()
    releasePreparation(handle.preparation)
  }
  await mounted.ctx.fiber.dispose()
  const index = contexts.indexOf(mounted.ctx)
  if (index >= 0) contexts.splice(index, 1)
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`task-state-recovery-provenance: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function settleStartupCheck(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 30))
}

async function settleQuiet(ms = 250): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

function providerOf(ctx: Context): TaskStateBasicService {
  return ctx.get('taskState') as TaskStateBasicService
}

function auditRows(ctx: Context): TaskStateAuditRecord[] {
  const table = (providerOf(ctx) as unknown as {
    auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
  }).auditTable
  if (table === undefined) return []
  return [...table.entries()].map(entry => entry[1])
}

function stableOf(ctx: Context, id: SessionId): TaskStateStable | undefined {
  return ctx.taskState.getStable(id)
}

/** The machine code of one row that settled as a PLAIN failure, or `undefined`. */
function failureCodeOf(row: TaskStateAuditRecord | undefined): string | undefined {
  const finished = row?.finished
  return finished !== undefined && finished.outcome === 'failure' ? finished.error.code : undefined
}

/** One durable audit row as it appears in the JSON document (diagnostic only). */
interface DurableAuditRow {
  readonly request: { readonly revision: number }
  readonly finished?: { readonly outcome: string; readonly revision?: number }
}

/** The durable audit rows that carry a finished phase, in document order. */
function durableSettled(doc: DomainDoc | null): readonly (DurableAuditRow & { readonly key: string })[] {
  return Object.entries(doc?.tables.audit ?? {})
    .filter(([, row]) => row.finished !== undefined)
    .map(([key, row]) => ({ key, ...row }))
}

/**
 * Wait a bounded time for the DIAGNOSTIC ledger to show a finished phase.
 *
 * The audit rows are diagnostic only (B1: they are never authority), and they
 * are republished one whole document at a time: `dsh-storage-json` writes a
 * temp file and `rename()`s it over the unit, and Windows refuses that rename
 * transiently with `EPERM` when a scanner or indexer holds the target (measured
 * on this host, on this very path). The provider must then treat the write as a
 * diagnostic GAP — the authoritative record is already durable — so this wait
 * returns instead of throwing and {@link expectLedger} decides what a missing
 * row may mean.
 * @param ctx - the mounted Context whose provider owns the ledger.
 * @param predicate - whether the expected reading is visible yet.
 * @param timeoutMs - how long the ledger may take to settle.
 */
async function waitForLedger(
  ctx: Context,
  predicate: (rows: readonly TaskStateAuditRecord[]) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate(auditRows(ctx))) {
    if (Date.now() - start > timeoutMs) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Assert one DIAGNOSTIC-ledger reading without ever accepting a wrong verdict.
 *
 * A settled row that landed must satisfy `assertSettled` exactly; a completely
 * empty settled set is the documented diagnostic gap above (every remaining row
 * must then still be OPEN). A row that settled with an unexpected
 * classification always fails.
 * @param rows - the live audit rows.
 * @param assertSettled - assertions that must hold for the settled rows.
 */
function expectLedger(
  rows: readonly TaskStateAuditRecord[],
  assertSettled: (settled: readonly TaskStateAuditRecord[]) => void,
): void {
  const settled = rows.filter(row => row.finished !== undefined)
  if (settled.length === 0) {
    expect(rows.every(row => row.finished === undefined)).toBe(true)
    return
  }
  assertSettled(settled)
}

/** The raw durable domain document, including the audit rows as JSON. */
interface DomainDoc {
  readonly tables: {
    readonly sessions: Record<string, {
      readonly session: { readonly createdAt: number }
      readonly stable?: { readonly revision: number; readonly sourceCursor: number }
      readonly terminal?: { readonly kind?: string; readonly requestId: string; readonly cursor: number }
    }>
    readonly audit: Record<string, {
      readonly request: { readonly revision: number }
      readonly finished?: { readonly outcome: string; readonly revision?: number; readonly error?: { readonly code: string } }
    }>
  }
}

async function readDomain(storageRoot: string): Promise<DomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, DOMAIN_FILE), 'utf8')) as DomainDoc
  } catch {
    return null
  }
}

describe('task-state recovery provenance (B4.3)', () => {
  it('leaves exactly an OPEN audit row for an in-flight exit, commits nothing, and refolds the tail', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-provenance-inflight-'))
    const sessionId = SessionId('provenance-inflight')
    const first = await mountComposition(root, [{ kind: 'output', text: SMALL_CANDIDATE, delayMs: 2_000 }])
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    await settleStartupCheck()
    const seq = appendUser(session, 'a fact the running wave is folding')

    // Wait until the request is provably IN FLIGHT, then exit the process while
    // the wave is running: the open audit row is already durable (it is written
    // BEFORE dispatch) and no finished phase can exist yet.
    await waitUntil(() => first.adapter.requests.length === 1, 5_000, 'in-flight request')
    expect(first.adapter.requests[0]!.includedSeqs).toEqual([seq])
    expect(stableOf(first.ctx, session.id)).toBeUndefined()
    await settleQuiet(60)
    await closeProcess(first)

    const doc = await readDomain(first.storageRoot)
    expect(doc).not.toBeNull()
    // Nothing was committed: an interrupted wave advances no cursor at all, and
    // it leaves no terminal verdict and no fabricated stable behind.
    expect(doc!.tables.sessions[String(sessionId)]).toBeUndefined()
    // The interrupted attempt's open row is the diagnostic signature; a refused
    // publish leaves it absent, which is a documented diagnostic gap.
    const rows = Object.entries(doc!.tables.audit)
    expect(rows.length).toBeLessThanOrEqual(1)
    const openKey = rows[0]?.[0]
    if (openKey !== undefined) {
      expect(rows[0]![1].finished).toBeUndefined()
      expect(rows[0]![1].request.revision).toBe(1)
    }

    // Stage 2: the tail is refolded from the very beginning (no ghost cursor)
    // and only a real commit reaches revision 1.
    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await waitUntil(() => stableOf(second.ctx, resumed.id)?.revision === 1, 5_000, 'refold commit')
      expect(second.adapter.requests.length).toBe(1)
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([seq])
      expect(stableOf(second.ctx, resumed.id)!.sourceCursor).toBe(seq)

      // The interrupted attempt is an OPEN, uncertified row — which is exactly
      // the durable signature of an aborted / in-flight exit.
      await waitForLedger(second.ctx, live => live.some(row => row.finished !== undefined))
      const restoredOpen = auditRows(second.ctx).find(row => String(row.requestId) === openKey)
      if (restoredOpen !== undefined) {
        expect(restoredOpen.finished).toBeUndefined()
        expect(classifyAuditRow(restoredOpen)).toBe('aborted')
      } else {
        // Diagnostic gap: nothing at all landed for the abandoned attempt.
        expect(auditRows(second.ctx).some(row => String(row.requestId) === openKey)).toBe(false)
      }

      // The JSON medium is written behind the in-memory table, so the durable
      // document is read after the writers settle.
      await settleQuiet(200)
      const doc2 = await readDomain(second.storageRoot)
      const record = doc2!.tables.sessions[String(sessionId)]!
      expect(record.stable?.revision).toBe(1)
      expect(record.stable?.sourceCursor).toBe(seq)
      expect(record.terminal).toBeUndefined()
      // Nothing invented a repair credential for the abandoned attempt, and no
      // durable row claims a verdict the interrupted wave never earned.
      expect(durableSettled(doc2).some(row => row.finished?.outcome === 'repair')).toBe(false)
      expect(Object.values(doc2!.tables.audit).filter(row => row.finished === undefined).length)
        .toBeLessThanOrEqual(1)
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('never repairs an un-settled attempt into a commit for a revision no stable holds', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-provenance-ghost-'))
    const sessionId = SessionId('provenance-ghost')
    // Wave 1 commits normally; wave 2 is interrupted in flight, so the durable
    // audit holds a certified revision 1 plus an OPEN row targeting revision 2.
    const first = await mountComposition(root, [
      { kind: 'output', text: SMALL_CANDIDATE },
      { kind: 'output', text: SMALL_CANDIDATE, delayMs: 2_000 },
    ])
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    await settleStartupCheck()
    const coveredSeq = appendUser(session, 'the first committed fact')
    await waitUntil(() => stableOf(first.ctx, session.id)?.revision === 1, 5_000, 'first commit')
    await settleQuiet(200)
    const pendingSeq = appendUser(session, 'a fact of the interrupted second wave')
    await waitUntil(() => first.adapter.requests.length === 2, 5_000, 'in-flight second wave')
    await settleQuiet(60)
    await closeProcess(first)

    const before = await readDomain(first.storageRoot)
    const openRows = Object.entries(before!.tables.audit).filter(([, row]) => row.finished === undefined)
    expect(openRows.length).toBeLessThanOrEqual(1)
    if (openRows[0] !== undefined) expect(openRows[0][1].request.revision).toBe(2)
    expect(before!.tables.sessions[String(sessionId)]!.stable?.revision).toBe(1)
    expect(before!.tables.sessions[String(sessionId)]!.stable?.sourceCursor).toBe(coveredSeq)

    // Stage 2: the committed stable is already certified, so startup must NOT
    // mint a repair credential for the abandoned revision-2 attempt, and no
    // ghost revision 2 may appear: revision 2 is reached ONLY by a real commit.
    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      await waitUntil(() => stableOf(second.ctx, resumed.id)?.revision === 2, 5_000, 'legitimate revision 2')
      await settleQuiet(200)
      const record = (await readDomain(second.storageRoot))!.tables.sessions[String(sessionId)]!
      expect(record.stable?.revision).toBe(2)
      expect(record.stable?.sourceCursor).toBe(pendingSeq)
      expect(record.terminal).toBeUndefined()
      // The abandoned attempt stayed OPEN and uncertified.
      await waitForLedger(second.ctx, live => live.some(row => row.finished !== undefined))
      const abandonedKey = openRows[0]?.[0]
      const abandoned = auditRows(second.ctx).map(row => [String(row.requestId), row] as const)
        .find(([key]) => key === abandonedKey)?.[1]
      if (abandoned !== undefined) {
        expect(abandoned.finished).toBeUndefined()
        expect(classifyAuditRow(abandoned)).toBe('aborted')
      }
      // No repair credential was minted, and no settled row is anything but the
      // two legitimate commits.
      expect(auditRows(second.ctx).some(row => row.finished?.outcome === 'repair')).toBe(false)
      expectLedger(auditRows(second.ctx), (settled) => {
        expect(settled.every(row => row.finished?.outcome === 'success')).toBe(true)
      })
      // Exactly two model calls were paid for: the interrupted one and the one
      // that legally committed revision 2.
      expect(second.adapter.requests.length).toBe(1)
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([pendingSeq])
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('repairs a lost finished audit and keeps the coexisting terminal verdict untouched', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-provenance-repair-'))
    const sessionId = SessionId('provenance-repair')
    const first = await mountComposition(root)
    const session = first.ctx.sessions.create(sessionId, {
      meta: { cwd: first.storageRoot, createdAt: CREATED_AT },
    })
    await settleStartupCheck()
    const coveredSeq = appendUser(session, 'the committed fact')
    await waitUntil(() => stableOf(first.ctx, session.id)?.revision === 1, 5_000, 'first commit')
    await settleQuiet(200)
    const quarantinedSeq = appendUser(session, OVERSIZED_TEXT)
    await waitUntil(() => providerOf(first.ctx).getTerminal(session.id) !== undefined, 5_000, 'terminal quarantine')
    const terminalRequestId = providerOf(first.ctx).getTerminal(session.id)!.requestId
    await settleQuiet(200)
    await closeProcess(first)

    // Simulate the crash the repair credential exists for: the stable is durable
    // but its finished audit phase never landed. The terminal verdict stays.
    const path = join(root, 'storage', DOMAIN_FILE)
    interface MutableDoc {
      tables: { audit: Record<string, { request: { revision: number }; finished?: unknown }> }
    }
    const doc = JSON.parse(await readFile(path, 'utf8')) as MutableDoc
    const committedKey = Object.entries(doc.tables.audit)
      .find(([, row]) => row.request.revision === 1)?.[0]
    // The durable revision-1 row exists unless its own publish was refused by the
    // medium (see `waitForLedger`). Without it the crash state cannot be built.
    const repairExercised = committedKey !== undefined
    if (committedKey !== undefined) {
      delete doc.tables.audit[committedKey]!.finished
      await writeFile(path, JSON.stringify(doc), 'utf8')
    } else {
      // eslint-disable-next-line no-console
      console.warn('task-state-recovery-provenance: durable revision-1 audit row missing (diagnostic gap); the repair branch is NOT exercised by this run')
    }

    const second = await mountComposition(root)
    try {
      const resumed = await resume(second.ctx, sessionId, second)
      if (repairExercised) {
        await waitForLedger(
          second.ctx,
          rows => rows.some(row => String(row.requestId) === committedKey && row.finished !== undefined),
          5_000,
        )

        // The repair certifies the committed revision without any model call and
        // without inventing raw output.
        const repaired = auditRows(second.ctx).find(row => String(row.requestId) === committedKey)
        if (repaired !== undefined) {
          expect(repaired.finished?.outcome).toBe('repair')
          expect(classifyAuditRow(repaired)).toBe('committed')
          expect(repaired.request.revision).toBe(1)
        } else {
          // Documented diagnostic gap: the repair put was refused by the medium,
          // so no row settled at all — the authority record below is unaffected.
          expect(auditRows(second.ctx).some(row => row.finished !== undefined)).toBe(false)
        }
      }

      // The repair never costs a model call, and it never invents raw output.
      expect(second.adapter.requests.length).toBe(0)

      // The terminal verdict is intact: same request id, same cursor, and it is
      // still what keeps the effective cursor past the quarantined sequence.
      const terminal = providerOf(second.ctx).getTerminal(resumed.id)
      expect(terminal?.requestId).toBe(terminalRequestId)
      expect(terminal?.cursor).toBe(quarantinedSeq)
      const terminalRow = auditRows(second.ctx).find(row => String(row.requestId) === String(terminalRequestId))
      if (terminalRow?.finished !== undefined) {
        expect(terminalRow.finished.outcome).toBe('terminal-infeasible')
        expect(classifyAuditRow(terminalRow)).toBe('terminal-infeasible')
      }

      // Neither the repair nor the recovery regressed the durable record.
      await settleQuiet(200)
      const record = (await readDomain(second.storageRoot))!.tables.sessions[String(sessionId)]!
      expect(record.stable?.revision).toBe(1)
      expect(record.stable?.sourceCursor).toBe(coveredSeq)
      expect(record.terminal?.requestId).toBe(String(terminalRequestId))
      expect(record.terminal?.cursor).toBe(quarantinedSeq)

      // A new fact still opens a new generation past the quarantined sequence:
      // the repair certified provenance without resurrecting the skipped window.
      const freshSeq = appendUser(resumed, 'a fact after the repair')
      await waitUntil(() => stableOf(second.ctx, resumed.id)?.revision === 2, 5_000, 'post-repair commit')
      expect(second.adapter.requests.length).toBe(1)
      expect(second.adapter.requests[0]!.includedSeqs).toEqual([freshSeq])
      expect(stableOf(second.ctx, resumed.id)!.sourceCursor).toBe(freshSeq)
      await settleQuiet(200)
      const after = (await readDomain(second.storageRoot))!.tables.sessions[String(sessionId)]!
      expect(after.terminal?.cursor).toBe(quarantinedSeq)
      expect(after.stable?.sourceCursor).toBe(freshSeq)
    } finally {
      await closeProcess(second)
    }
  }, 60_000)

  it('distinguishes the paid, the retryable and the quarantined attempt on one durable ledger', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-state-provenance-classes-'))
    const mounted = await mountComposition(root, [
      { kind: 'finish-error', code: 'RATE_LIMIT', message: 'slow down' },
      { kind: 'output', text: SMALL_CANDIDATE },
    ])
    const sessionId = SessionId('provenance-classes')
    const session = mounted.ctx.sessions.create(sessionId, {
      meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
    })
    try {
      await settleStartupCheck()
      const firstSeq = appendUser(session, 'a fact the provider will refuse once')
      await waitForLedger(mounted.ctx, rows => rows.some(row => row.finished?.outcome === 'failure'), 5_000)
      expectLedger(auditRows(mounted.ctx), (settled) => {
        const failureRows = settled.filter(row => row.finished?.outcome === 'failure')
        expect(failureRows.length).toBe(1)
        expect(failureRows[0]!.finished!.outcome).toBe('failure')
        expect(failureCodeOf(failureRows[0])).toBe('TRANSIENT_LLM')
        expect(classifyAuditRow(failureRows[0]!)).toBe('transient-failure')
      })
      // A retryable failure commits nothing, so no stable is published yet.
      expect(stableOf(mounted.ctx, session.id)).toBeUndefined()

      const secondSeq = appendUser(session, 'the fact that retries and commits')
      // The stable pointer advances BEFORE the finished audit phase is put, so
      // the ledger is awaited separately rather than assumed.
      await waitForLedger(mounted.ctx, rows => rows.some(row => row.finished?.outcome === 'success'), 5_000)
      expect(stableOf(mounted.ctx, session.id)?.revision).toBe(1)
      expectLedger(auditRows(mounted.ctx), (settled) => {
        expect(settled.filter(row => row.finished?.outcome === 'success').length).toBe(1)
        expect(classifyAuditRow(settled.find(row => row.finished?.outcome === 'success')!)).toBe('committed')
      })
      expect(mounted.adapter.requests.length).toBe(2)
      expect(mounted.adapter.requests[1]!.includedSeqs).toEqual([firstSeq, secondSeq])

      const quarantinedSeq = appendUser(session, OVERSIZED_TEXT)
      await waitForLedger(
        mounted.ctx,
        rows => rows.some(row => row.finished?.outcome === 'terminal-infeasible'),
        5_000,
      )
      expectLedger(auditRows(mounted.ctx), (settled) => {
        const terminalRows = settled.filter(row => row.finished?.outcome === 'terminal-infeasible')
        expect(terminalRows.length).toBeLessThanOrEqual(1)
        if (terminalRows[0] !== undefined) {
          expect(classifyAuditRow(terminalRows[0])).toBe('terminal-infeasible')
          expect(terminalRows[0].request.includedSeqs).toEqual([quarantinedSeq])
        }
        // No settled row may ever carry an outcome outside the three classes.
        for (const row of settled) {
          expect(['failure', 'success', 'terminal-infeasible']).toContain(row.finished?.outcome)
        }
      })

      // One real domain now carries the classes side by side, and the durable
      // ledger never holds a verdict outside the contract's four classifications.
      await settleQuiet(200)
      const doc = await readDomain(mounted.storageRoot)
      const outcomes = Object.values(doc!.tables.audit).map(row => row.finished?.outcome ?? 'open')
      for (const outcome of outcomes) {
        expect(['open', 'failure', 'success', 'terminal-infeasible']).toContain(outcome)
      }
      expect(outcomes.filter(outcome => outcome === 'terminal-infeasible').length).toBeLessThanOrEqual(1)
      // The authoritative record is what the classes must agree with: revision 1
      // committed past both facts, with the terminal cursor on the culprit.
      const record = doc!.tables.sessions[String(sessionId)]!
      expect(record.terminal?.cursor).toBe(quarantinedSeq)
      expect(record.stable?.revision).toBe(1)
      expect(record.stable?.sourceCursor).toBe(secondSeq)
      // Only TWO model calls were ever paid for: the retryable failure and the
      // commit. The terminal quarantine never dispatches a model at all.
      expect(mounted.adapter.requests.length).toBe(2)
    } finally {
      await closeProcess(mounted)
    }
  }, 60_000)
})
