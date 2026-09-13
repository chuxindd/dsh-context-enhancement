/**
 * B6.2 — the tool-group audit as a RECOVERABLE state machine.
 *
 * R-P2-3's mechanism was that the `context_enhancement_tool_group_summary`
 * audit document doubly served as a type authority AND as the only durable
 * memory of which groups had already been summarized. B6.1 moved the type
 * authority into the Session log; B6.2 makes the audit's own lifecycle
 * recoverable and makes every degradation explicit:
 *
 * - `open` → `success`/`fallback`/`failure` are an attempt's own transitions.
 *   `open` → `aborted` is the durable verdict a LATER observation reaches about
 *   a row whose owning attempt is gone (a restart, or a concurrent writer this
 *   package cannot distinguish from one — B1's open single-writer gap), and it
 *   is never read as a committed reduction. `open`/`aborted` → `repaired` is the
 *   ONLY transition that asserts a landed reduction on evidence the writable
 *   document did not produce.
 * - A repair requires Session provenance: the validated `tool-summary` record of
 *   THIS group identity on the current surface. It therefore cannot promote a
 *   type and cannot skip the source check the model call already passed.
 * - A lost, deleted, or whole-document-overwritten audit changes no
 *   classification and no schedule — the Session log classifies — and the loss
 *   is reported (`AUDIT_DIAGNOSTIC.auditLandingUnrecorded`) instead of being
 *   silently read as "no group work happened".
 * - A rejected audit write is reported and bounded, never a reason to lose a
 *   landed reduction and never a reason to buy model calls forever.
 *
 * Everything below runs over REAL durable layers: a real `Session` on the real
 * JSONL medium, the real dsh-storage hub with the real `json` backend and the
 * real domain facility, and the real audit store. "Restart" means disposing one
 * Context and reopening both media in another. The only substitutions are (a)
 * the model, (b) rows written deliberately to represent a corrupt or foreign
 * writer, and (c) wrappers that inject a write failure — each named `injected`.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPreparation, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import type { ToolStageDebt } from '../src/compaction-basic.ts'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { resolveConfig as resolvePrunerConfig } from '../src/internal/compaction/pruner-config.ts'
import { resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup, ToolGroupSelectionOptions } from '../src/internal/compaction/tool-groups.ts'
import { buildToolGroupSummaryInput } from '../src/internal/compaction/tool-group-summary.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import type { SurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import {
  AUDIT_DIAGNOSTIC,
  isServedAudit,
  planAuditRecovery,
  repairToolGroupAudit,
  servedReplacementSeqs,
  sessionLandedReductions,
  shouldAttemptToolGroupSummary,
  TOOL_GROUP_AUDIT_MAX_ATTEMPTS,
} from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditRecord } from '../src/internal/compaction/tool-group-audit.ts'
import { openToolGroupAuditStore } from '../src/internal/compaction/tool-group-audit-store.ts'
import type { ToolGroupAuditStore } from '../src/internal/compaction/tool-group-audit-store.ts'

const SURFACE = { surfaceOp: 'append' as const }
const SUMMARY_PRICE = 1
const ORIGINAL_PRICE = 100
const PRUNE_THRESHOLD = 96
/** The durable document of the audit domain's `single`-layout unit. */
const AUDIT_UNIT_FILE = 'context_enhancement_tool_group_summary.json'
/** The domain name, as it appears in a storage refusal. */
const AUDIT_DOMAIN = 'context_enhancement_tool_group_summary'
/** The route the scripted adapter and the engine target both use. */
const ROUTE = 'route'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The pricing seam both real producers call: a summary prices below its original. */
function estimateTokens(message: { readonly content: readonly ContentBlock[] }): number {
  const block = message.content[0]
  const text = block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
  return text.includes('[tool group summary]') ? SUMMARY_PRICE : ORIGINAL_PRICE
}

/** The deterministic pruner, constructed exactly the way the other specs do. */
function pruner(): ToolResultPruner {
  return Object.assign(Object.create(ToolResultPruner.prototype) as ToolResultPruner, {
    config: resolvePrunerConfig({ thresholdChars: PRUNE_THRESHOLD, headChars: 8, tailChars: 8 }),
    ctx: { tokenMeter: { estimateMessage: () => 7 } },
  })
}

interface Step {
  readonly callSeq: SessionSeq
  readonly resultSeq: SessionSeq
}

/** One closed assistant tool-call + result pair appended to a live Session. */
function addToolStep(session: Session, turn: number, step: number, callId: string): Step {
  const callSeq = session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: `--file ${callId}.ts` }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, SURFACE).seq
  const resultSeq = session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: `${'x'.repeat(PRUNE_THRESHOLD + 40)} result ${step}` }],
      isError: false,
    }),
  }, SURFACE).seq
  return { callSeq, resultSeq }
}

/**
 * Seed one prompt plus `count` over-budget tool results on a live Session,
 * optionally opening a second turn after `splitAfter` results so the fixture
 * has two independent tool runs (one for the semantic summary, one left raw for
 * the deterministic pruner).
 */
function seedToolRuns(session: Session, count: number, splitAfter?: number): Step[] {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
  const steps: Step[] = []
  for (let index = 0; index < count; index += 1) {
    const second = splitAfter !== undefined && index >= splitAfter
    if (second && index === splitAfter) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'next prompt' }],
        source: { kind: 'user' },
      }), SURFACE)
    }
    steps.push(addToolStep(session, second ? 2 : 1, index + 1, `call-${index + 1}`))
  }
  return steps
}

/** The inclusive span one tool run of a fixture occupies. */
function spanOf(steps: readonly Step[]): { start: SessionSeq; end: SessionSeq } {
  return { start: steps[0]!.callSeq, end: steps.at(-1)!.resultSeq }
}

/**
 * The span a LATER pass computes from the CURRENT surface, the way every
 * production caller derives its older range: after a reduction has landed, the
 * originals it shadowed are no longer surface nodes and can no longer name a
 * range.
 */
function surfaceSpan(session: Session): { start: SessionSeq; end: SessionSeq } {
  const nodes = session.surface.nodes
  return { start: nodes[0]!, end: nodes.at(-1)! }
}

/** Select the single tool group over an inclusive span. */
function groupOver(session: Session, span: { start: SessionSeq; end: SessionSeq }): ToolGroup {
  const group = selectToolGroups(session, {
    olderRange: span,
    minGroupResults: 1,
    minGroupChars: 1,
    minGroupTokens: 1,
    maxGroupTokens: 100_000,
    maxGroups: 1,
    estimateTokens: () => 1,
  })[0]
  if (group === undefined) throw new Error('fixture: no tool group selected')
  return group
}

/** The validated summary document a group's model call returns. */
function summaryFor(session: Session, group: ToolGroup): ToolGroupSummary {
  const input = buildToolGroupSummaryInput(session, group)
  return {
    version: 1,
    groupSummary: 'done',
    items: input.items.map(item => ({
      sourceSeq: item.sourceSeq,
      ...(item.callId === undefined ? {} : { callId: item.callId }),
      summary: 'done',
      facts: [],
      files: [],
      identifiers: [],
      errors: [],
      unresolved: [],
    })),
    groupErrors: [],
    unresolved: [],
  }
}

/** The engine's durable tool-group identity, read through its own seam. */
function engineGroupFingerprint(session: Session, group: ToolGroup): string {
  const seam = BasicCompactionEngine.prototype as unknown as {
    toolGroupFingerprint: (session: Session, group: ToolGroup) => string
  }
  return seam.toolGroupFingerprint.call({}, session, group)
}

/** Deterministic prune of ONE explicit result through the engine's own seam. */
function pruneOne(session: Session, resultSeq: SessionSeq): SessionSeq {
  const pruned = pruner().pruneSession(session, { candidateSeqs: [resultSeq] }).pruned[0]
  if (pruned === undefined) throw new Error('fixture: the pruner reduced nothing')
  return pruned.replacementSeq
}

/** A row written deliberately as a corrupt or foreign durable state. */
function rowFixture(options: {
  readonly requestId: string
  readonly sessionId: string
  readonly createdAt: number
  readonly fingerprint: string
  readonly sourceSeqs: readonly SessionSeq[]
  readonly status: ToolGroupAuditRecord['status']
  readonly attempt?: number
  readonly ownerId?: string
  readonly replacementSeqs?: readonly SessionSeq[]
}): ToolGroupAuditRecord {
  return {
    requestId: options.requestId,
    sessionId: options.sessionId,
    lifecycle: { createdAt: options.createdAt },
    fingerprint: options.fingerprint,
    sourceSeqs: [...options.sourceSeqs],
    surfaceGeneration: 0,
    provider: ROUTE,
    model: 'model',
    schemaVersion: 1,
    status: options.status,
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    ...(options.replacementSeqs === undefined ? {} : { replacementSeqs: [...options.replacementSeqs] }),
  }
}

class ScriptAdapter extends LlmAdapter {
  /** Model calls attempted by this process image. */
  requests = 0
  /** When set, every call fails the way a broken provider stream does. */
  failWith: string | undefined
  constructor(private text: string) { super() }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.failWith !== undefined) throw new Error(this.failWith)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  setText(text: string): void { this.text = text }
}

// ---------------------------------------------------------------------------
// Real process images
// ---------------------------------------------------------------------------

interface Medium {
  /** Root of the durable JSONL session medium. */
  readonly sessions: string
  /** Root of the durable storage-domain medium. */
  readonly storage: string
}

interface Host {
  readonly ctx: Context
  readonly adapter: ScriptAdapter
  /** The real audit store, absent when the medium refused to open it. */
  readonly store: ToolGroupAuditStore | undefined
  readonly warnings: string[]
  /** Create this image's durable Session. */
  readonly create: (id: SessionId, cwd: string) => Session
  readonly close: () => Promise<void>
}

const contexts: Context[] = []
const media: string[] = []
const resumeOwnership = new WeakMap<Context, Array<() => void>>()

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    for (const release of resumeOwnership.get(ctx) ?? []) release()
    await ctx.fiber.dispose().catch(() => {})
  }
  for (const root of media.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A fresh pair of durable medium roots, removed after the case. */
async function newMedium(prefix: string): Promise<Medium> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  media.push(root)
  return { sessions: join(root, 'sessions'), storage: join(root, 'storage') }
}

/**
 * Mount one real process image: LLM runtime with a scripted adapter, the
 * Session store over the durable JSONL medium, and the storage hub with the
 * real `json` backend plus the domain facility the audit store opens through.
 */
async function mountHost(
  medium: Medium,
  options: { readonly backend?: string; readonly skipStore?: boolean; readonly prepare?: (ctx: Context) => void } = {},
): Promise<Host> {
  const ctx = new Context()
  contexts.push(ctx)
  const adapter = new ScriptAdapter('{}')
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([ROUTE], adapter)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: medium.sessions, compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: medium.storage })
  options.prepare?.(ctx)
  await ctx.plugin(StorageDomain, { backend: options.backend ?? 'json' })
  const store = options.skipStore === true ? undefined : await openToolGroupAuditStore(ctx)
  const warnings: string[] = []
  const created: Session[] = []
  return {
    ctx,
    adapter,
    store,
    warnings,
    create: (id, cwd) => {
      const session = ctx.sessions.create(id, { meta: { cwd } })
      created.push(session)
      return session
    },
    close: async () => {
      for (const session of created) await ctx.sessions.flush(session).catch(() => {})
      await store?.close()
      await ctx.fiber.dispose()
    },
  }
}

/** Reopen one stored Session through the production resume idiom. */
async function reopen(ctx: Context, id: SessionId): Promise<Session> {
  const seam = ctx as unknown as {
    sessionPersistence: { prepare: (id: SessionId) => Promise<SessionPreparation> }
  }
  const preparation = await seam.sessionPersistence.prepare(id)
  const detach = ctx.sessions.enter(preparation.session)
  ctx.sessions.announce(preparation.session)
  const held = resumeOwnership.get(ctx) ?? []
  held.push(() => { detach(); preparation[Symbol.dispose]() })
  resumeOwnership.set(ctx, held)
  return preparation.session
}

/** The rows the durable MEDIUM holds, not the ones a live store has in memory. */
async function rowsOnMedium(medium: Medium): Promise<Record<string, ToolGroupAuditRecord>> {
  const text = await readFile(join(medium.storage, AUDIT_UNIT_FILE), 'utf8')
  const document = JSON.parse(text) as { tables?: { audit?: Record<string, ToolGroupAuditRecord> } }
  return document.tables?.audit ?? {}
}

/** Every row of one Session's lifecycle, read through a real store. */
function rowsOf(store: ToolGroupAuditStore, session: Session): readonly ToolGroupAuditRecord[] {
  return store.recordsForSession(session.id, session.header.createdAt)
}

// ---------------------------------------------------------------------------
// The real op1 orchestration, over the real store
// ---------------------------------------------------------------------------

type EngineInternals = {
  summarizeToolGroups: (
    agent: Agent,
    target: { provider: string; model: string },
    policy: ReturnType<typeof resolveTargetPolicy>,
    olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
    signal: AbortSignal,
    roundReplacements: Set<SessionSeq>,
  ) => Promise<void>
}

interface PassOptions {
  readonly host: Host
  readonly store: ToolGroupAuditStore | undefined
  readonly session: Session
  readonly group: ToolGroup
  readonly span: { readonly start: SessionSeq; readonly end: SessionSeq }
}

interface EngineSeam {
  /** Run one real op1 pass over one group. */
  readonly summarize: (options: PassOptions) => Promise<{ readonly landed: SessionSeq[] }>
}

/**
 * The summarizer policy these fixtures run under: groups of one or two small
 * results, one group per pass. The pending-work probe and the summarize actor
 * share it so the case can compare them — the same requirement the production
 * code satisfies by deriving both from one config.
 */
function fixtureEngineConfig(): ReturnType<typeof resolveConfig> {
  const base = resolveConfig({})
  return {
    ...base,
    toolGroupSummarizer: {
      ...base.toolGroupSummarizer,
      enabled: true,
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      maxGroupsPerPass: 1,
    },
  }
}

/**
 * Build one engine receiver and run the REAL op1 orchestration
 * (`summarizeToolGroups` on the production prototype) through its production
 * seams: real selection, real audit state machine, real `replaceToolGroup`,
 * scripted model.
 *
 * The receiver is deliberately long-lived within a case: like the production
 * engine — one per agent session — it is the identity the degraded-attempt
 * ledger is keyed on, so two passes through ONE receiver share that ledger and
 * two receivers do not. A bare object carries no constructor-initialized field,
 * which the production code tolerates because every audit bookkeeping field
 * lives in a per-receiver module-level state map.
 */
function engineFor(host: Host, store: ToolGroupAuditStore | undefined): EngineSeam {
  const config = fixtureEngineConfig()
  const engine = Object.assign(Object.create(BasicCompactionEngine.prototype) as Record<string, unknown>, {
    config,
    ctx: {
      llm: host.ctx.llm,
      tokenMeter: { estimateMessage: estimateTokens },
      logger: { warn: (message: string) => { host.warnings.push(message) } },
    },
    toolGroupAuditStorePromise: Promise.resolve(),
    toolGroupAuditStore: store,
  }) as unknown as EngineInternals
  return {
    summarize: async (options: PassOptions) => {
      options.host.adapter.setText(JSON.stringify(summaryFor(options.session, options.group)))
      const roundReplacements = new Set<SessionSeq>()
      await engine.summarizeToolGroups(
        { session: options.session } as unknown as Agent,
        { provider: ROUTE, model: 'model' },
        resolveTargetPolicy(config, { provider: ROUTE, model: 'model' }),
        { startSeq: options.span.start, endSeq: options.span.end },
        new AbortController().signal,
        roundReplacements,
      )
      return { landed: [...roundReplacements] }
    },
  }
}

/** One real op1 pass through a fresh engine receiver. */
async function runOp1(options: PassOptions): Promise<{ readonly landed: SessionSeq[] }> {
  return engineFor(options.host, options.store).summarize(options)
}

// ---------------------------------------------------------------------------
// Injected failures
// ---------------------------------------------------------------------------

/** A real store whose every `finish` write is rejected: a process that dies needing one. */
function storeWithRejectedFinish(store: ToolGroupAuditStore): ToolGroupAuditStore {
  return {
    ...store,
    finish: async () => { throw new Error('injected audit finish failure') },
  }
}

/** A real store whose every durable write is rejected: the audit medium is unavailable. */
function storeWithRejectedWrites(store: ToolGroupAuditStore): ToolGroupAuditStore {
  return {
    ...store,
    open: async () => { throw new Error('injected audit open failure') },
    finish: async () => { throw new Error('injected audit finish failure') },
  }
}

/**
 * Register a delegating backend whose FIRST audit write fails once and then
 * delegates, and provide the lifecycle service a routed domain form requires
 * before it will activate (`apply` injects `storage.backend.<name>`, exactly as
 * the shipped `json` backend provides it). This is the only layer a retry can
 * be observed at: the failure happens inside the real domain + real store path,
 * below the fake line.
 */
function registerFlakyAuditBackend(ctx: Context): void {
  const base = ctx.storage.backend.get('json')
  const kv = base.kv
  if (kv === undefined) throw new Error('fixture: the json backend exposes no kv facet')
  let injected = 0
  const backend: StorageBackend = {
    close: () => base.close(),
    kv: {
      open: async (descriptor): Promise<KvUnit> => {
        const unit = await kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            if (table === 'audit' && injected === 0) {
              injected += 1
              throw new Error('injected transient audit write failure')
            }
            return unit.putRecord(table, key, value)
          },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
  }
  ctx.storage.backend.register('flaky-json', backend)
  ctx.provide(storageBackendServiceKey('flaky-json'), backend)
}

// ---------------------------------------------------------------------------
// The scheduler probe, wired the way `compaction-tool-stage-debt.spec.ts` does
// ---------------------------------------------------------------------------

/** Run the real pending-work probe over a whole surface against a real store. */
function probeDebt(session: Session, store: ToolGroupAuditStore | undefined, warnings: string[]): ToolStageDebt {
  const config = fixtureEngineConfig()
  const fake = {
    config,
    ctx: {
      tokenMeter: { estimateMessage: estimateTokens },
      logger: { warn: (message: string) => { warnings.push(message) } },
    },
    toolGroupAuditStore: store,
  }
  const engine = fake as unknown as BasicCompactionEngine
  const prototype = BasicCompactionEngine.prototype as unknown as {
    sourceIndex: (session: Session) => SurfaceSourceIndex
    toolGroupFingerprint: (session: Session, group: ToolGroup) => string
    cappedMaxGroupTokens: (maxGroupTokens: number, inputCapTokens: number | undefined) => number
    toolGroupSelectionOptions: (
      olderRange: { start: SessionSeq; end: SessionSeq },
      inputCapTokens: number | undefined,
      index: SurfaceSourceIndex,
    ) => ToolGroupSelectionOptions
    hasPendingToolIntermediateWork: (
      session: Session,
      start: SessionSeq,
      end: SessionSeq,
      prune: ToolResultPruner | undefined,
      inputCapTokens?: number,
    ) => ToolStageDebt
  }
  const seams = engine as unknown as Record<string, unknown>
  seams['sourceIndex'] = (current: Session) => prototype.sourceIndex.call(engine, current)
  seams['toolGroupFingerprint'] = (current: Session, group: ToolGroup) =>
    prototype.toolGroupFingerprint.call(engine, current, group)
  seams['cappedMaxGroupTokens'] = (max: number, cap: number | undefined) =>
    prototype.cappedMaxGroupTokens.call(engine, max, cap)
  seams['toolGroupSelectionOptions'] = (...args: unknown[]) =>
    (prototype.toolGroupSelectionOptions as unknown as (...inner: unknown[]) => ToolGroupSelectionOptions)
      .apply(engine, args)
  const nodes = [...session.surface.nodes]
  return prototype.hasPendingToolIntermediateWork.call(
    engine,
    session,
    nodes[0]!,
    nodes.at(-1)!,
    undefined,
    undefined,
  )
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('B6.2 an interrupted attempt is judged, never assumed committed', () => {
  it('turns an OPEN row left by a dead process into a durable aborted/repairable verdict, then adopts it for a second attempt', async () => {
    const medium = await newMedium('dsh-b62-interrupted-')
    const id = SessionId('b62-interrupted')

    // ---- process A: the model dies, and the audit cannot record the outcome ----
    const first = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const fingerprint = engineGroupFingerprint(session, group)
    const createdAt = session.header.createdAt
    expect(first.store).toBeDefined()
    const storeA = first.store!

    first.adapter.failWith = 'injected model stream failure'
    const passA = await runOp1({ host: first, store: storeWithRejectedFinish(storeA), session, group, span: spanOf(steps) })
    expect(passA.landed).toEqual([])
    // The durable row is OPEN: an attempt started and nothing was committed.
    const rowsA = rowsOf(storeA, session)
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0]!.status).toBe('open')
    expect(rowsA[0]!.attempt).toBe(1)
    expect(rowsA[0]!.fingerprint).toBe(fingerprint)
    expect(rowsA[0]!.replacementSeqs).toBeUndefined()
    expect(rowsA[0]!.ownerId).toBeTypeOf('string')
    expect(isServedAudit(rowsA[0]!)).toBe(false)
    expect(servedReplacementSeqs(rowsA)).toEqual([])
    // Nothing landed, so the surface is exactly as it was, and the audit's own
    // outcome write was reported rather than swallowed.
    expect(session.surface.nodes).toEqual([...session.surface.nodes])
    expect(first.warnings.join('\n')).toContain('injected audit finish failure')
    await first.close()

    // ---- process B: a NEW image over the SAME durable medium ----
    const second = await mountHost(medium)
    const replay = await reopen(second.ctx, id)
    const storeB = second.store!
    // The Session's lifecycle identity is durable, so the reopened process reads
    // the same audit rows the dead one wrote.
    expect(replay.header.createdAt).toBe(createdAt)
    const rowsB = rowsOf(storeB, replay)
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0]!.status).toBe('open')
    expect(rowsB[0]!.ownerId).not.toBe('b62-interrupted')
    // No Session provenance proves a landing, so the row cannot be committed...
    const indexB = buildSurfaceSourceIndex(replay)
    expect(sessionLandedReductions(indexB, fingerprint)).toEqual([])
    // ...and the durable verdict is `aborted`: repairable, never committed.
    const stepsB = planAuditRecovery(rowsB, indexB, 'instance-B')
    expect(stepsB).toHaveLength(1)
    expect(stepsB[0]!.requestId).toBe(rowsB[0]!.requestId)
    expect(stepsB[0]!.status).toBe('aborted')
    expect(stepsB[0]!.diagnostic).toBe(AUDIT_DIAGNOSTIC.interruptedAttempt)
    await storeB.finish(stepsB[0]!.requestId, stepsB[0]!.apply)
    const aborted = rowsOf(storeB, replay)[0]!
    expect(aborted.status).toBe('aborted')
    expect(aborted.diagnostic).toBe(AUDIT_DIAGNOSTIC.interruptedAttempt)
    // The abort verdict records its reason and states that nothing was proven;
    // it is not an adoption, so it claims no predecessor the way adoption and
    // repair do.
    expect(aborted.recoveredFrom).toBeUndefined()
    expect(aborted.attempt).toBe(1)
    expect(isServedAudit(aborted)).toBe(false)
    expect(servedReplacementSeqs([aborted])).toEqual([])
    // Re-judging the same durable row writes nothing new.
    expect(planAuditRecovery([aborted], indexB, 'instance-B')).toEqual([])
    // The verdict is on the MEDIUM, not only in a live in-memory store.
    expect(Object.values(await rowsOnMedium(medium)).map(row => row.status)).toEqual(['aborted'])
    // Still owed within the durable budget, so the group stays workable.
    expect(shouldAttemptToolGroupSummary([aborted], fingerprint, { landed: [] })).toBe(true)

    // ---- process B works the group again: adoption, then a real success ----
    const groupB = groupOver(replay, spanOf(steps))
    expect(engineGroupFingerprint(replay, groupB)).toBe(fingerprint)
    second.adapter.failWith = undefined
    const passB = await runOp1({ host: second, store: storeB, session: replay, group: groupB, span: spanOf(steps) })
    expect(passB.landed).toHaveLength(2)
    expect(second.adapter.requests).toBe(1)
    const finalRow = rowsOf(storeB, replay)[0]!
    expect(finalRow.status).toBe('success')
    expect(finalRow.attempt).toBe(2)
    expect(finalRow.recoveredFrom).toBe('aborted')
    expect(finalRow.diagnostic).toBe(AUDIT_DIAGNOSTIC.adoptedInterruptedAttempt)
    expect(finalRow.replacementSeqs).toEqual(passB.landed)
    const indexB2 = buildSurfaceSourceIndex(replay)
    for (const seq of passB.landed) expect(indexB2.entry(seq).kind).toBe('tool-summary')
    expect(sessionLandedReductions(indexB2, fingerprint)).toEqual(passB.landed)
    const finalMedium = Object.values(await rowsOnMedium(medium))
    expect(finalMedium).toHaveLength(1)
    expect(finalMedium[0]!.status).toBe('success')
    expect(finalMedium[0]!.attempt).toBe(2)
  })

  it('never reads a row owned by another instance as this instance committed work, and never lets its claim move a type', async () => {
    const medium = await newMedium('dsh-b62-foreign-')
    const id = SessionId('b62-foreign')

    const first = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const fingerprint = engineGroupFingerprint(session, group)
    const storeA = first.store!
    // A durable row another writer left behind: it claims a landing, but the
    // claimed seq is still a raw original, so the Session log backs nothing.
    await storeA.open(rowFixture({
      requestId: 'foreign-1',
      sessionId: session.id,
      createdAt: session.header.createdAt,
      fingerprint,
      sourceSeqs: group.sourceSeqs,
      status: 'open',
      attempt: 1,
      ownerId: 'instance-A',
      replacementSeqs: [steps[0]!.resultSeq],
    }))
    await first.close()

    const second = await mountHost(medium)
    const replay = await reopen(second.ctx, id)
    const storeB = second.store!
    const rows = rowsOf(storeB, replay)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ownerId).toBe('instance-A')
    expect(isServedAudit(rows[0]!)).toBe(true)

    // The claim cannot be verified, and the classification ignores it: the
    // audit may only make a classification stricter, never create a kind.
    const index = buildSurfaceSourceIndex(replay, servedReplacementSeqs(rows))
    expect(index.entry(steps[0]!.resultSeq).kind).toBe('original')
    expect(index.isOriginalToolResult(steps[0]!.resultSeq)).toBe(true)
    expect(sessionLandedReductions(index, fingerprint)).toEqual([])

    // A restart and a live concurrent writer are indistinguishable from inside
    // this process (no compare-and-swap or owner heartbeat exists upstream), so
    // the only honest verdict is the repairable one.
    const recovery = planAuditRecovery(rows, index, 'instance-B')
    expect(recovery).toHaveLength(1)
    expect(recovery[0]!.status).toBe('aborted')
    await storeB.finish(recovery[0]!.requestId, recovery[0]!.apply)
    const aborted = rowsOf(storeB, replay)[0]!
    expect(aborted.status).toBe('aborted')
    expect(aborted.diagnostic).toBe(AUDIT_DIAGNOSTIC.landingClaimConflict)
    // Not repaired, not committed: nothing in the durable record asserts a
    // reduction the Session log never recorded.
    expect(aborted.repairEvidence).toBeUndefined()
    expect(isServedAudit(aborted)).toBe(false)
    // The claim is withdrawn from every reader, and the node's kind never moved.
    expect(servedReplacementSeqs([aborted])).toEqual([])
    expect(buildSurfaceSourceIndex(replay, servedReplacementSeqs([aborted])).entry(steps[0]!.resultSeq).kind)
      .toBe('original')
    expect(aborted.status).not.toBe('repaired')
    expect(aborted.status).not.toBe('success')
  })
})

describe('B6.2 repair and aborting are evidence-based, and nothing else', () => {
  it('repairs an OPEN row whose landed reduction the Session log proves, and never re-summarizes that group', async () => {
    const medium = await newMedium('dsh-b62-repair-')
    const id = SessionId('b62-repair')

    // ---- process A: the reduction lands, every audit finish write fails ----
    const first = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const fingerprint = engineGroupFingerprint(session, group)
    const storeA = first.store!
    const passA = await runOp1({ host: first, store: storeWithRejectedFinish(storeA), session, group, span: spanOf(steps) })
    expect(passA.landed).toHaveLength(2)
    const rowsA = rowsOf(storeA, session)
    expect(rowsA).toHaveLength(1)
    // The attempt never committed a terminal status and never recorded its
    // landing — the durable row is the bare `open` the crash left.
    expect(rowsA[0]!.status).toBe('open')
    expect(rowsA[0]!.replacementSeqs).toBeUndefined()
    expect(rowsA[0]!.repairEvidence).toBeUndefined()
    expect(first.warnings.join('\n')).toContain('audit success commit failed')
    await first.close()

    // ---- process B: the Session log is the evidence, and it is enough ----
    const second = await mountHost(medium)
    const replay = await reopen(second.ctx, id)
    const storeB = second.store!
    const index = buildSurfaceSourceIndex(replay)
    const landed = sessionLandedReductions(index, fingerprint)
    expect(landed).toEqual(passA.landed)
    const recovery = planAuditRecovery(rowsOf(storeB, replay), index, 'instance-B')
    expect(recovery).toHaveLength(1)
    expect(recovery[0]!.status).toBe('repaired')
    expect(recovery[0]!.diagnostic).toBe(AUDIT_DIAGNOSTIC.sessionEvidenceServed)
    await storeB.finish(recovery[0]!.requestId, recovery[0]!.apply)

    const repaired = rowsOf(storeB, replay)[0]!
    expect(repaired.status).toBe('repaired')
    expect(repaired.recoveredFrom).toBe('open')
    expect(repaired.repairEvidence).toEqual(passA.landed)
    expect(repaired.replacementSeqs).toEqual(passA.landed)
    expect(isServedAudit(repaired)).toBe(true)
    expect(servedReplacementSeqs([repaired])).toEqual(passA.landed)
    expect(shouldAttemptToolGroupSummary([repaired], fingerprint)).toBe(false)
    // Durable, not just in memory.
    const onMedium = Object.values(await rowsOnMedium(medium))
    expect(onMedium).toHaveLength(1)
    expect(onMedium[0]!.status).toBe('repaired')
    expect(onMedium[0]!.repairEvidence).toEqual(passA.landed)

    // A real pass over the same span pays for no model call: the reduction is
    // proven served, and its results are no longer selectable originals.
    const before = second.adapter.requests
    await runOp1({ host: second, store: storeB, session: replay, group, span: surfaceSpan(replay) })
    expect(second.adapter.requests).toBe(before)
    expect(rowsOf(storeB, replay)).toHaveLength(1)
  })

  it('refuses claims the Session log does not back, and the withdrawn claim restores Session truth and pending work', async () => {
    const medium = await newMedium('dsh-b62-conflict-')
    const id = SessionId('b62-conflict')

    const host = await mountHost(medium)
    const session = host.create(id, medium.sessions)
    // Two runs: the first stays RAW (its group is the outstanding work), the
    // second is deterministically pruned so a claim has a real replacement node
    // to point at.
    const steps = seedToolRuns(session, 3, 2)
    const group = groupOver(session, spanOf(steps.slice(0, 2)))
    const fingerprint = engineGroupFingerprint(session, group)
    const pruneSeq = pruneOne(session, steps[2]!.resultSeq)
    const prunedSeq = pruneSeq
    const store = host.store!

    // A durable row that claims the PRUNED node as this group's served landing.
    await store.open(rowFixture({
      requestId: 'corrupt-1',
      sessionId: session.id,
      createdAt: session.header.createdAt,
      fingerprint,
      sourceSeqs: group.sourceSeqs,
      status: 'open',
      attempt: 1,
      ownerId: 'instance-A',
      replacementSeqs: [prunedSeq],
    }))
    const rows = rowsOf(store, session)
    expect(rows).toHaveLength(1)

    // B6.1's rule: a claim contradicting the durable provenance makes the
    // claimed node fail closed, at the classification layer.
    const claimed = buildSurfaceSourceIndex(session, servedReplacementSeqs(rows))
    expect(claimed.entry(prunedSeq).kind).toBe('unknown-replacement')
    expect(claimed.entry(prunedSeq).kind).not.toBe('tool-summary')
    // The claim also makes the group look served, so the scheduler refuses it.
    expect(shouldAttemptToolGroupSummary(rows, fingerprint, { landed: [] })).toBe(false)
    expect(probeDebt(session, store, host.warnings)).toBe('inert')

    // Recovery judges the claim against the log: it is unbacked, so the row is
    // aborted and nothing is promoted.
    const recovery = planAuditRecovery(rows, buildSurfaceSourceIndex(session), 'instance-B')
    expect(recovery).toHaveLength(1)
    expect(recovery[0]!.status).toBe('aborted')
    expect(recovery[0]!.diagnostic).toBe(AUDIT_DIAGNOSTIC.landingClaimConflict)
    await store.finish(recovery[0]!.requestId, recovery[0]!.apply)

    const aborted = rowsOf(store, session)[0]!
    expect(aborted.status).toBe('aborted')
    expect(aborted.repairEvidence).toBeUndefined()
    expect(isServedAudit(aborted)).toBe(false)
    // Session truth is restored: the prune is still a prune, and no node became
    // a summary because an audit document said so.
    expect(buildSurfaceSourceIndex(session, servedReplacementSeqs([aborted])).entry(prunedSeq).kind).toBe('tool-pruned')
    expect(buildSurfaceSourceIndex(session).entry(group.toolResultSeqs[0]!).kind).toBe('original')
    // And the group is outstanding work again instead of being fenced off by a
    // claim nobody could verify.
    expect(shouldAttemptToolGroupSummary([aborted], fingerprint, { landed: [] })).toBe(true)
    expect(probeDebt(session, store, host.warnings)).toBe('actionable')
  })

  it('never repairs provenance the Session log does not carry, and refuses an evidence-free repair outright', () => {
    const session = Session.create(SessionId('b62-no-evidence'))
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const fingerprint = engineGroupFingerprint(session, group)
    const row = rowFixture({
      requestId: 'open-1',
      sessionId: session.id,
      createdAt: session.header.createdAt,
      fingerprint,
      sourceSeqs: group.sourceSeqs,
      status: 'open',
      attempt: 1,
      ownerId: 'instance-A',
    })

    // A repair cannot be constructed without evidence: this is the guard that
    // makes "repaired" mean something.
    expect(() => repairToolGroupAudit(row, [])).toThrow(/Session-proven landing evidence/)
    // With nothing proven and nothing claimed, the row is not repairable OR
    // committed: it is merely interrupted.
    const index = buildSurfaceSourceIndex(session)
    const recovery = planAuditRecovery([row], index, 'instance-B')
    expect(recovery).toHaveLength(1)
    expect(recovery[0]!.status).toBe('aborted')
    expect(recovery[0]!.status).not.toBe('repaired')
    expect(recovery[0]!.diagnostic).toBe(AUDIT_DIAGNOSTIC.interruptedAttempt)
    // The running attempt may not reach a recovery verdict for itself either.
    expect(() => repairToolGroupAudit({ ...row, status: 'success' }, [steps[0]!.resultSeq]))
      .toThrow(/cannot repair success/)
    expect(() => repairToolGroupAudit({ ...row, status: 'failure' }, [steps[0]!.resultSeq]))
      .toThrow(/cannot repair failure/)
  })
})

describe('B6.2 a lost or damaged audit degrades explicitly, and changes no classification', () => {
  it('keeps classification, op1/op2 exclusion and the diagnostic after the audit document is deleted across a restart', async () => {
    const medium = await newMedium('dsh-b62-deleted-')
    const id = SessionId('b62-deleted')

    // ---- process A: one real summary lands and is recorded ----
    const first = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const fingerprint = engineGroupFingerprint(session, group)
    const passA = await runOp1({ host: first, store: first.store!, session, group, span: spanOf(steps) })
    expect(passA.landed).toHaveLength(2)
    const recordedA = rowsOf(first.store!, session)[0]!
    expect(recordedA.status).toBe('success')
    expect(recordedA.fingerprint).toBe(fingerprint)
    await first.close()

    // The audit document is removed — the whole diagnostic memory is gone.
    await rm(join(medium.storage, AUDIT_UNIT_FILE), { force: true })

    // ---- process B: only the Session log is left ----
    const second = await mountHost(medium)
    const replay = await reopen(second.ctx, id)
    const storeB = second.store!
    expect(rowsOf(storeB, replay)).toEqual([])
    const index = buildSurfaceSourceIndex(replay)
    for (const seq of passA.landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
    }
    // op2's candidate set is built exactly the way the engine builds it, and the
    // summarized nodes are not in it.
    const candidates = replay.surface.nodes.filter(seq => index.isOriginalToolResult(seq))
    for (const seq of passA.landed) expect(candidates).not.toContain(seq)
    // op1 does not redo the landed group: a real pass over its own span pays for
    // no model call, and it reports that the audit no longer agrees.
    const before = second.adapter.requests
    await runOp1({ host: second, store: storeB, session: replay, group, span: surfaceSpan(replay) })
    expect(second.adapter.requests).toBe(before)
    expect(second.warnings.join('\n')).toContain(AUDIT_DIAGNOSTIC.auditLandingUnrecorded)
    // Nothing was fabricated to replace the lost row.
    expect(rowsOf(storeB, replay)).toEqual([])
    // No recovery step invents a row for a group the document does not mention.
    expect(planAuditRecovery(rowsOf(storeB, replay), buildSurfaceSourceIndex(replay), 'instance-B')).toEqual([])

    // Positive control: the loss does not disable the pass. A NEW raw run is
    // summarized normally, so op1 still runs under the safe policy.
    const fresh = seedToolRuns(replay, 2)
    const freshGroup = groupOver(replay, spanOf(fresh))
    const passB = await runOp1({ host: second, store: storeB, session: replay, group: freshGroup, span: spanOf(fresh) })
    expect(passB.landed).toHaveLength(2)
    expect(second.adapter.requests).toBe(before + 1)
    const freshIndex = buildSurfaceSourceIndex(replay)
    for (const seq of passB.landed) expect(freshIndex.entry(seq).kind).toBe('tool-summary')
    const rowsAfter = rowsOf(storeB, replay)
    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0]!.status).toBe('success')
    expect(rowsAfter[0]!.fingerprint).toBe(engineGroupFingerprint(replay, freshGroup))
  })

  it('reports a real last-write-wins overwrite by another writer instead of reading it as "no work happened"', async () => {
    const medium = await newMedium('dsh-b62-lww-')
    const id = SessionId('b62-lww')

    // Two process images open the same single-layout document BEFORE either
    // writes. The storage contract exposes no revision, etag, or reload (B1's
    // `blocked-specific-api` gap), so the second writer publishes its own
    // in-memory document and the first writer's row is gone from the medium.
    const first = await mountHost(medium)
    const second = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const passA = await runOp1({ host: first, store: first.store!, session, group, span: spanOf(steps) })
    expect(passA.landed).toHaveLength(2)
    expect(Object.values(await rowsOnMedium(medium))).toHaveLength(1)

    await second.store!.open(rowFixture({
      requestId: 'other-writer-1',
      sessionId: 'some-other-session',
      createdAt: 7,
      fingerprint: 'f'.repeat(64),
      sourceSeqs: [1 as SessionSeq],
      status: 'open',
      attempt: 1,
      ownerId: 'another-instance',
    }))
    // The whole-document overwrite is real: only the other writer's row is left.
    const overwritten = Object.values(await rowsOnMedium(medium))
    expect(overwritten).toHaveLength(1)
    expect(overwritten[0]!.sessionId).toBe('some-other-session')
    await first.close()
    await second.close()

    // ---- restart: the Session log still owns every classification ----
    const third = await mountHost(medium)
    const replay = await reopen(third.ctx, id)
    const store = third.store!
    const index = buildSurfaceSourceIndex(replay)
    for (const seq of passA.landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.canCompactHistory(seq, 1, true)).toBe(true)
    }
    expect(rowsOf(store, replay)).toEqual([])
    // The loss is reported by the engine, and no work is redone.
    const before = third.adapter.requests
    await runOp1({ host: third, store, session: replay, group, span: surfaceSpan(replay) })
    expect(third.adapter.requests).toBe(before)
    expect(third.warnings.join('\n')).toContain(AUDIT_DIAGNOSTIC.auditLandingUnrecorded)
    // The foreign row is never adopted, repaired, or rewritten by this session.
    expect(rowsOf(store, replay)).toEqual([])
    expect(planAuditRecovery(rowsOf(store, replay), buildSurfaceSourceIndex(replay), 'instance-C')).toEqual([])
    expect(Object.keys(await rowsOnMedium(medium))).toEqual(['other-writer-1'])
  })

  it('fails closed when the audit document cannot be read, and op1 refuses to run without it', async () => {
    const medium = await newMedium('dsh-b62-damaged-')
    const id = SessionId('b62-damaged')

    // A real summary first, so this case has a classification to protect.
    const first = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const passA = await runOp1({ host: first, store: first.store!, session, group, span: spanOf(steps) })
    expect(passA.landed).toHaveLength(2)
    await first.close()

    const document = join(medium.storage, AUDIT_UNIT_FILE)
    const corruptions: Array<{ readonly name: string; readonly text: string; readonly refusal: RegExp }> = [
      {
        name: 'not JSON at all',
        text: '{ "tables": ',
        refusal: /file is not valid JSON/,
      },
      {
        name: 'a record outside the schema',
        text: `${JSON.stringify({
          unit: { name: AUDIT_DOMAIN, version: 1 },
          global: null,
          tables: { audit: { 'row-1': { requestId: 'row-1', status: 'weird' } } },
        }, null, 2)}\n`,
        refusal: /does not match its schema/,
      },
      {
        name: 'a document stamped with another unit version',
        text: `${JSON.stringify({ unit: { name: AUDIT_DOMAIN, version: 9 }, global: null, tables: { audit: {} } }, null, 2)}\n`,
        refusal: /stored version 9 != expected 1/,
      },
    ]

    for (const corruption of corruptions) {
      await writeFile(document, corruption.text)
      // Each damaged medium gets its own image: the failed open reserves the
      // domain name for the facility that attempted it.
      const damaged = await mountHost(medium, { skipStore: true })
      await expect(openToolGroupAuditStore(damaged.ctx)).rejects.toThrow(corruption.refusal)
      const replay = await reopen(damaged.ctx, id)
      // Classification is untouched by the unreadable document...
      const index = buildSurfaceSourceIndex(replay)
      for (const seq of passA.landed) expect(index.entry(seq).kind).toBe('tool-summary')
      // ...the engine has no audit store at all, so op1 spends nothing...
      const before = damaged.adapter.requests
      await runOp1({ host: damaged, store: undefined, session: replay, group, span: surfaceSpan(replay) })
      expect(damaged.adapter.requests).toBe(before)
      // ...op2 keeps working from the Session classification, and the probe
      // reports no semantic debt it could not act on.
      expect(replay.surface.nodes.filter(seq => index.isOriginalToolResult(seq)))
        .not.toContain(passA.landed[0]!)
      expect(probeDebt(replay, undefined, damaged.warnings)).toBe('none')
    }
  })
})

describe('B6.2 audit write failures are reported and bounded', () => {
  it('absorbs one transient audit write failure through the real store and still commits success', async () => {
    const medium = await newMedium('dsh-b62-transient-')
    const id = SessionId('b62-transient')
    const host = await mountHost(medium, {
      backend: 'flaky-json',
      prepare: ctx => { registerFlakyAuditBackend(ctx) },
    })
    const session = host.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const pass = await runOp1({ host, store: host.store!, session, group, span: spanOf(steps) })
    expect(pass.landed).toHaveLength(2)
    // The injected failure happened BELOW the store, and the store's bounded
    // retry absorbed it: the attempt ends in a durable success.
    const rows = rowsOf(host.store!, session)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('success')
    expect(rows[0]!.replacementSeqs).toEqual(pass.landed)
    expect(host.warnings.join('\n')).not.toContain(AUDIT_DIAGNOSTIC.auditWriteFailed)
    const onMedium = Object.values(await rowsOnMedium(medium))
    expect(onMedium).toHaveLength(1)
    expect(onMedium[0]!.status).toBe('success')
  })

  it('keeps a landed reduction on the Session log when every audit write is rejected, and bounds unpaid attempts', async () => {
    const medium = await newMedium('dsh-b62-unwritable-')
    const id = SessionId('b62-unwritable')

    // ---- an unavailable audit cannot cancel the reduction ----
    const first = await mountHost(medium)
    const session = first.create(id, medium.sessions)
    const steps = seedToolRuns(session, 2)
    const group = groupOver(session, spanOf(steps))
    const fingerprint = engineGroupFingerprint(session, group)
    const storeA = storeWithRejectedWrites(first.store!)
    const passA = await runOp1({ host: first, store: storeA, session, group, span: spanOf(steps) })
    expect(passA.landed).toHaveLength(2)
    expect(first.warnings.join('\n')).toContain(AUDIT_DIAGNOSTIC.auditWriteFailed)
    expect(first.warnings.join('\n')).toContain('the landed reduction keeps its durable Session provenance')
    // The reduction is durable and typed by the Session log alone.
    const index = buildSurfaceSourceIndex(session)
    for (const seq of passA.landed) expect(index.entry(seq).kind).toBe('tool-summary')
    expect(sessionLandedReductions(index, fingerprint)).toEqual(passA.landed)
    // A second pass over the same span pays for no second model call.
    await runOp1({ host: first, store: storeA, session, group, span: surfaceSpan(session) })
    expect(first.adapter.requests).toBe(1)
    await first.close()

    // ---- the attempt ledger bounds model spend when nothing can be recorded ----
    const second = await mountHost(medium)
    const replay = await reopen(second.ctx, id)
    const fresh = seedToolRuns(replay, 2)
    const freshGroup = groupOver(replay, spanOf(fresh))
    const storeB = storeWithRejectedWrites(second.store!)
    // ONE receiver for all three passes, exactly like the production engine
    // (one per agent session): the degraded-attempt ledger is keyed on it.
    const engineB = engineFor(second, storeB)
    second.adapter.failWith = 'injected model stream failure'
    const freshPass: PassOptions = { host: second, store: storeB, session: replay, group: freshGroup, span: spanOf(fresh) }
    for (let attempt = 0; attempt < TOOL_GROUP_AUDIT_MAX_ATTEMPTS; attempt += 1) {
      await engineB.summarize(freshPass)
    }
    expect(second.adapter.requests).toBe(TOOL_GROUP_AUDIT_MAX_ATTEMPTS)
    expect(second.warnings.join('\n')).toContain('attempt failed without an audit row')
    // The next pass is refused before any model call, with the reason reported.
    await engineB.summarize(freshPass)
    expect(second.adapter.requests).toBe(TOOL_GROUP_AUDIT_MAX_ATTEMPTS)
    expect(second.warnings.join('\n')).toContain(AUDIT_DIAGNOSTIC.attemptsExhausted)
    // Nothing was invented: no landed reduction, no durable row, and the attempt
    // run is still selectable originals rather than a fabricated summary.
    const after = buildSurfaceSourceIndex(replay)
    for (const step of fresh) expect(after.isOriginalToolResult(step.resultSeq)).toBe(true)
    expect(rowsOf(second.store!, replay)).toEqual([])
  })
})
