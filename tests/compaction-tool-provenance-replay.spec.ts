/**
 * B6.1 — durable tool-reduction provenance recovered from the Session log alone.
 *
 * R-P2-3: the ONLY authority for "this `tool/result` replacement is a semantic
 * tool SUMMARY rather than a deterministic PRUNE" used to be the
 * `context_enhancement_tool_group_summary` audit document (`layout: 'single'`).
 * Losing that document silently downgraded an already-committed summary to
 * `tool-pruned` — never `original` (the safety floor held) but not equivalent,
 * and the whole classification sat one whole-document LWW overwrite (E10) away
 * from being wrong.
 *
 * B6.1 moves the authority into the Session log. Every reduction this package
 * lands writes a validated, digest-bound provenance record into the Session
 * event that the shared shadow-price protocol already places immediately before
 * the replacement, so a restarted or replayed Session classifies its surface
 * with NO audit at all. The audit keeps its §3.7 role — model requests,
 * diagnostics and work scheduling — and can now only ever make a classification
 * STRICTER: an audit claim that disagrees with the durable Session provenance
 * fails closed to `unknown-replacement`.
 *
 * Why the provenance rides the shadow-price event and not the replacement's own
 * `data`, and why no new Session event type exists — the DSH surface replacement
 * contract (read at `a66e4702047846cdaa10c66c9d3df3951f5ea70d`, checkout
 * unmodified):
 *
 * - `assertToolResultRewrite` (`dsh-session/surface`) requires a `tool/result`
 *   surface replacement to be deep-equal to the shadowed node in EVERYTHING
 *   except `message.content[0].content`, so an extra provenance field on the
 *   replacement is rejected as "may change only content".
 * - `Session.append()` takes no `ignorable` flag, and the persistence read path
 *   (`KNOWN_SESSION_EVENT_TYPES`, generated from the harness's own vocabulary)
 *   refuses any event type outside that set which is not marked `ignorable`. A
 *   plugin-owned Session event type would therefore make every Session this
 *   package touched unreadable after a restart — strictly worse than the defect
 *   being fixed — so the provenance must ride an OFFICIAL event.
 * - The official `compaction/prune` data type is a closed interface member and
 *   TypeScript rejects widening it by module augmentation (`TS2717: subsequent
 *   property declarations must have the same type`). The additive field is
 *   therefore carried by the writer's own widened payload type and re-validated
 *   from the logged JSON by the classifier, its only reader.
 *
 * Covered here: the write side for BOTH reduction paths, a real JSONL restart
 * with no audit at all, a foreign/damaged provenance failing closed, originals
 * and the other replacement kinds never being misread, the official
 * shadow-price protocol staying byte-shape compatible, and the op1/op2
 * exclusion the provenance must uphold after a restart.
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPreparation, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { ToolResultPruner } from '../src/tool-result-pruner.ts'
import { resolveConfig as resolvePrunerConfig } from '../src/internal/compaction/pruner-config.ts'
import { resolveConfig, resolveTargetPolicy } from '../src/internal/compaction/config.ts'
import {
  REDUCTION_PROVENANCE_PRODUCER,
  REDUCTION_PROVENANCE_VERSION,
  buildSurfaceSourceIndex,
  reductionProvenance,
  shadowPriceWithProvenance,
} from '../src/internal/compaction/source-index.ts'
import type { ReductionProvenance, SurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import { buildToolGroupSummaryInput } from '../src/internal/compaction/tool-group-summary.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'
import type { ToolGroupAuditRecord } from '../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditStore } from '../src/internal/compaction/tool-group-audit-store.ts'
import { TASK_STATE_SLOT_ID, TASK_STATE_SLOT_SOURCE_KIND } from '../src/internal/task-state/contract/index.ts'

const SURFACE = { surfaceOp: 'append' as const }
const SUMMARY_PRICE = 1
const ORIGINAL_PRICE = 100
const PRUNE_THRESHOLD = 64

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The pricing seam both real producers call, mirrored by the fixtures: a landed
 * summary prices strictly below the node it shadows, an original prices high.
 */
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

/** One closed assistant tool-call + result pair on the surface. */
function addToolStep(
  session: Session,
  turn: number,
  step: number,
  callId: string,
  text: string,
): { callSeq: SessionSeq; resultSeq: SessionSeq } {
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
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, SURFACE).seq
  return { callSeq, resultSeq }
}

/** One prompt plus `count` over-budget tool steps. */
function toolSession(
  id: string,
  count: number,
  options: { readonly splitAfter?: number } = {},
): { session: Session; steps: Array<{ callSeq: SessionSeq; resultSeq: SessionSeq }> } {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), SURFACE)
  const steps: Array<{ callSeq: SessionSeq; resultSeq: SessionSeq }> = []
  for (let index = 0; index < count; index += 1) {
    const inSecondRun = options.splitAfter !== undefined && index >= options.splitAfter
    if (inSecondRun && index === options.splitAfter) {
      // A later turn breaks the tool run, so a fixture can summarize one
      // complete run and leave another run raw for the deterministic pruner.
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'next prompt' }],
        source: { kind: 'user' },
      }), SURFACE)
    }
    steps.push(addToolStep(
      session,
      inSecondRun ? 2 : 1,
      index + 1,
      `call-${index + 1}`,
      `${'x'.repeat(PRUNE_THRESHOLD + 40)} result ${index + 1}`,
    ))
  }
  return { session, steps }
}

/** Select one tool group over an inclusive span, for the fixtures here. */
function groupOver(session: Session, span: { start: SessionSeq; end: SessionSeq }): ToolGroup {
  const groups = selectToolGroups(session, {
    olderRange: span,
    minGroupResults: 1,
    minGroupChars: 1,
    minGroupTokens: 1,
    maxGroupTokens: 100_000,
    maxGroups: 1,
    estimateTokens: () => 1,
  })
  const group = groups[0]
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

/** The sealed provenance payload of the event immediately before one node. */
function provenanceBefore(session: Session, seq: SessionSeq): ReductionProvenance {
  const price = session.eventAt((seq - 1) as SessionSeq)
  if (price?.type !== 'compaction/prune') {
    throw new Error(`fixture: seq ${seq} has no adjacent shadow-price event`)
  }
  const raw = (price.data as { provenance?: unknown }).provenance
  if (raw === undefined) throw new Error(`fixture: seq ${seq} carries no provenance`)
  return raw as ReductionProvenance
}

/** The text of one landed replacement node, as the model would read it. */
function replacementText(session: Session, seq: SessionSeq): string {
  const event = session.eventAt(seq)
  if (event?.type !== 'tool/result') throw new Error(`fixture: seq ${seq} is not a tool result`)
  const block = event.data.message.content[0]
  return block?.type === 'tool-result' && block.content[0]?.type === 'text' ? block.content[0].text : ''
}

// ---------------------------------------------------------------------------
// Real engine pass: the op1 (semantic summary) path end to end
// ---------------------------------------------------------------------------

class ScriptAdapter extends LlmAdapter {
  constructor(private text: string) { super() }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  setText(text: string): void { this.text = text }
}

/** Structural view of the engine orchestration under test. */
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

interface EngineHarness {
  readonly session: Session
  readonly group: ToolGroup
  readonly landed: readonly SessionSeq[]
  readonly records: readonly ToolGroupAuditRecord[]
}

/**
 * Run the REAL op1 pass over one two-result group: real `summarizeToolGroups`
 * orchestration, real `replaceToolGroup`, a scripted LLM, and a plain in-memory
 * audit store (B6.1 is about the Session side, so nothing here fails).
 */
async function runEngineSummary(label: string): Promise<EngineHarness> {
  const host = new Context()
  const adapter = new ScriptAdapter('{}')
  await host.plugin(LlmRuntime)
  host.llm.registerAdapter(['route'], adapter)

  const { session, steps } = toolSession(label, 2)
  const first = steps[0]!
  const last = steps[1]!
  const group = groupOver(session, { start: first.callSeq, end: last.resultSeq })
  adapter.setText(JSON.stringify(summaryFor(session, group)))

  const records: ToolGroupAuditRecord[] = []
  const store: ToolGroupAuditStore = {
    open: async record => { records.push(record) },
    finish: async (requestId, update) => {
      const index = records.findIndex(record => record.requestId === requestId)
      if (index < 0) throw new Error(`fixture: no audit record ${requestId}`)
      records[index] = update(records[index]!)
    },
    recordsForSession: () => records,
    close: async () => {},
  }
  const ctx = {
    llm: host.llm,
    tokenMeter: { estimateMessage: estimateTokens },
    logger: { warn: () => {} },
  }
  const base = resolveConfig({})
  const engine = Object.assign(Object.create(BasicCompactionEngine.prototype) as Record<string, unknown>, {
    config: {
      ...base,
      toolGroupSummarizer: {
        ...base.toolGroupSummarizer,
        minGroupResults: 1,
        minGroupChars: 1,
        minGroupTokens: 1,
        maxGroupTokens: 100_000,
        maxGroupsPerPass: 1,
      },
    },
    ctx,
    toolGroupAuditStorePromise: Promise.resolve(),
    toolGroupAuditStore: store,
  }) as unknown as EngineInternals
  const roundReplacements = new Set<SessionSeq>()
  await engine.summarizeToolGroups(
    { session } as unknown as Agent,
    { provider: 'route', model: 'model' },
    resolveTargetPolicy(base, { provider: 'route', model: 'model' }),
    { startSeq: first.callSeq, endSeq: last.resultSeq },
    new AbortController().signal,
    roundReplacements,
  )
  const success = records.find(record => record.status === 'success')
  if (success === undefined) throw new Error('fixture: the engine pass committed no successful audit record')
  return { session, group, landed: [...roundReplacements], records }
}

// ---------------------------------------------------------------------------
// Real JSONL restart
// ---------------------------------------------------------------------------

const contexts: Context[] = []
const roots: string[] = []
/** Resume ownership to release before each Context is disposed. */
const resumeOwnership = new WeakMap<Context, Array<() => void>>()

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    for (const release of resumeOwnership.get(ctx) ?? []) release()
    await ctx.fiber.dispose().catch(() => {})
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Mount the real Session store over the real durable JSONL medium. */
async function mountSessions(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', writeBatchMaxDelayMs: 1 })
  return ctx
}

/** Every persisted session log under one root, as raw text. */
async function storedLogs(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
  return Promise.all(files.map(entry => readFile(join(entry.parentPath, entry.name), 'utf8')))
}

/**
 * Reopen one stored Session through the production resume idiom: the real
 * persistence service reads, validates, and freezes the durable log, and the
 * store publishes it. No audit domain exists anywhere in this spec, so a correct
 * classification here can only come from the Session log itself.
 */
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

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('B6.1 provenance is written into the Session log by both reduction paths', () => {
  it('records a validated, group-identified provenance for every semantic summary the real engine lands', async () => {
    const { session, group, landed, records } = await runEngineSummary('b61-summary-write')
    expect(landed).toHaveLength(group.toolResultSeqs.length)
    const fingerprint = engineGroupFingerprint(session, group)
    // The identity written into the Session is the SAME durable fingerprint the
    // audit schedules its work under, so later recovery can correlate them.
    expect(records[0]!.fingerprint).toBe(fingerprint)

    for (const [index, replacementSeq] of landed.entries()) {
      const provenance = provenanceBefore(session, replacementSeq)
      expect(provenance.producer).toBe(REDUCTION_PROVENANCE_PRODUCER)
      expect(provenance.schemaVersion).toBe(REDUCTION_PROVENANCE_VERSION)
      expect(provenance.kind).toBe('tool-summary')
      // The covered range is the exact node this replacement stands for; the
      // source set is the whole tool group's durable event range.
      expect(provenance.coveredSeqs).toEqual([group.toolResultSeqs[index]!])
      expect(provenance.sourceEventSeqs).toEqual([...group.sourceSeqs])
      expect(provenance.groupId).toBe(fingerprint)
      // The replace generation observed immediately before this node landed.
      expect(provenance.generation).toBe(index)
      expect(provenance.digest).toMatch(/^[0-9a-f]{64}$/)
    }

    // The classifier reads that record — with no audit passed in at all.
    const index = buildSurfaceSourceIndex(session)
    for (const seq of landed) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
      expect(index.replacementCoverage(seq)).toEqual({
        kind: 'tool-summary',
        coveredSeqs: [provenanceBefore(session, seq).coveredSeqs[0]!],
      })
    }
  })

  it('records a group-free provenance for every deterministic prune the real pruner lands', () => {
    const { session, steps } = toolSession('b61-prune-write', 2)
    const candidates = [steps[0]!.resultSeq, steps[1]!.resultSeq]
    const result = pruner().pruneSession(session, { candidateSeqs: candidates })
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual(candidates)

    for (const [index, entry] of result.pruned.entries()) {
      const provenance = provenanceBefore(session, entry.replacementSeq)
      expect(provenance.producer).toBe(REDUCTION_PROVENANCE_PRODUCER)
      expect(provenance.kind).toBe('tool-pruned')
      expect(provenance.coveredSeqs).toEqual([entry.originalSeq])
      expect(provenance.sourceEventSeqs).toEqual([entry.originalSeq])
      // A model-free prune has no tool group and says so instead of inventing one.
      expect(provenance.groupId).toBeNull()
      expect(provenance.generation).toBe(index)
      expect(provenance.digest).toMatch(/^[0-9a-f]{64}$/)
    }
    const index = buildSurfaceSourceIndex(session)
    for (const entry of result.pruned) {
      expect(index.entry(entry.replacementSeq).kind).toBe('tool-pruned')
    }
  })
})

describe('B6.1 a restarted Session classifies its surface with no audit at all', () => {
  it('keeps both reduction kinds across a real JSONL restart and a brand-new source index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-b61-replay-'))
    roots.push(root)
    const id = SessionId('b61-restart')
    const first = await mountSessions(root)
    const session = first.sessions.create(id, { meta: { cwd: root } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prompt' }],
      source: { kind: 'user' },
    }), SURFACE)
    // Two turns, so the summarized run and the pruned run are separate tool
    // runs (the selection unit is a complete same-turn run).
    const steps: Array<{ callSeq: SessionSeq; resultSeq: SessionSeq }> = []
    for (let index = 0; index < 3; index += 1) {
      if (index === 2) {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'next prompt' }],
          source: { kind: 'user' },
        }), SURFACE)
      }
      steps.push(addToolStep(session, index < 2 ? 1 : 2, index + 1, `restart-${index + 1}`, `${'y'.repeat(PRUNE_THRESHOLD + 40)} out ${index + 1}`))
    }

    // op1: the semantic group reduction over the two oldest results.
    const group = groupOver(session, { start: steps[0]!.callSeq, end: steps[1]!.resultSeq })
    const summarized = replaceToolGroup(session, group, summaryFor(session, group), { estimateTokens })
    expect(summarized.replacementSeqs).toHaveLength(2)
    // op2: the deterministic prune of the untouched third result, with its
    // candidate set built exactly the way the engine builds it.
    const liveIndex = buildSurfaceSourceIndex(session)
    const candidateSeqs = session.surface.nodes.filter(seq => liveIndex.isOriginalToolResult(seq))
    expect(candidateSeqs).toEqual([steps[2]!.resultSeq])
    const pruned = pruner().pruneSession(session, { candidateSeqs })
    expect(pruned.pruned).toHaveLength(1)
    const prunedSeq = pruned.pruned[0]!.replacementSeq
    const eventCount = session.snapshotEvents().length

    await first.sessions.flush(session)
    await first.fiber.dispose()

    // The durable bytes themselves carry the provenance: this is the medium a
    // later process reads, not process memory.
    const logs = (await storedLogs(root)).join('\n')
    expect(logs).toContain(REDUCTION_PROVENANCE_PRODUCER)
    expect(logs).toContain('"provenance"')
    expect(logs).toContain('tool-summary')
    expect(logs).toContain('tool-pruned')

    // Restart: a NEW Context over the same medium, no audit store, no engine,
    // no `servedReplacementSeqs` — only the validated durable log.
    const second = await mountSessions(root)
    const replay = await reopen(second, id)
    // The production resume path appends exactly one `session/end-seed` boundary
    // marker at the tail of the inherited prefix; every durable event before it
    // is the log this Session wrote, unchanged.
    const replayedEvents = replay.snapshotEvents()
    expect(replayedEvents.slice(0, eventCount).map(event => event.type))
      .toEqual(session.snapshotEvents().map(event => event.type))
    expect(replayedEvents.at(-1)!.type).toBe('session/end-seed')
    expect(replayedEvents).toHaveLength(eventCount + 1)
    expect([...replay.surface.nodes]).toEqual([...session.surface.nodes])

    const index = buildSurfaceSourceIndex(replay)
    for (const seq of summarized.replacementSeqs) {
      expect(index.entry(seq).kind).toBe('tool-summary')
      expect(index.isOriginalToolResult(seq)).toBe(false)
      // Both kinds stay relaxable under the pressure tier's immediate-reentry
      // flag and deferred under the ordinary completed-turn rule.
      expect(index.canCompactHistory(seq, 1, true)).toBe(true)
      expect(index.canCompactHistory(seq, 1)).toBe(false)
    }
    expect(index.entry(prunedSeq).kind).toBe('tool-pruned')
    expect(index.canCompactHistory(prunedSeq, 1, true)).toBe(true)
    // The replaced originals left the surface; the prompt is still an original.
    expect(replay.surface.nodes).not.toContain(steps[0]!.resultSeq)
    expect(index.isOriginalToolResult(steps[0]!.resultSeq)).toBe(false)
    expect(index.entry(replay.surface.nodes[0]!).kind).toBe('original')

    // The same durable log under three different audit claims: the audit can
    // never change a kind, because it is a diagnostic and never a type authority.
    const claimed = buildSurfaceSourceIndex(replay, summarized.replacementSeqs)
    for (const seq of summarized.replacementSeqs) expect(claimed.entry(seq).kind).toBe('tool-summary')
    expect(claimed.entry(prunedSeq).kind).toBe('tool-pruned')
    const unclaimed = buildSurfaceSourceIndex(replay, [])
    for (const seq of summarized.replacementSeqs) expect(unclaimed.entry(seq).kind).toBe('tool-summary')
    expect(unclaimed.entry(prunedSeq).kind).toBe('tool-pruned')
    // A corrupted audit that claims the PRUNED node as a served summary
    // contradicts the durable provenance, so that node fails closed.
    expect(buildSurfaceSourceIndex(replay, [prunedSeq]).entry(prunedSeq).kind).toBe('unknown-replacement')
    expect(buildSurfaceSourceIndex(replay, [prunedSeq]).entry(summarized.replacementSeqs[0]!).kind)
      .toBe('tool-summary')

    // Invariant 3 (op1's successful group is not op2 work again) survives the
    // audit loss: the summarized nodes are no longer selectable originals.
    const selectable = selectToolGroups(replay, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      maxGroups: 4,
      estimateTokens: () => 1,
      isEligibleResult: seq => index.isOriginalToolResult(seq),
    })
    const selectableResults = selectable.flatMap(candidate => [...candidate.toolResultSeqs])
    for (const seq of summarized.replacementSeqs) expect(selectableResults).not.toContain(seq)
  })
})

describe('B6.1 a missing, foreign, or damaged provenance fails closed', () => {
  /** Append a hand-built shadow price (provenance absent or arbitrary) plus one replacement. */
  function replaceWithShadowPrice(
    session: Session,
    sourceSeq: SessionSeq,
    provenance: unknown,
  ): SessionSeq {
    const event = session.eventAt(sourceSeq)
    if (event?.type !== 'tool/result') throw new Error('fixture: source is not a tool result')
    const shadowedTokenCount = 10
    session.append('compaction/prune', provenance === undefined
      ? { shadowedRange: { start: sourceSeq, end: sourceSeq }, shadowedSeqs: [sourceSeq], shadowedTokenCount }
      : shadowPriceWithProvenance(sourceSeq, shadowedTokenCount, provenance as ReductionProvenance))
    return session.append('tool/result', event.data, {
      surfaceOp: { op: 'replace', start: sourceSeq, end: sourceSeq },
      sourceEventSeqs: [sourceSeq],
    }).seq
  }

  function expectFailClosed(index: SurfaceSourceIndex, seq: SessionSeq, sourceSeq: SessionSeq): void {
    expect(index.entry(seq).kind).toBe('unknown-replacement')
    expect(index.isOriginalToolResult(seq)).toBe(false)
    // Never relaxed by the pressure flag...
    expect(index.canCompactHistory(seq, 1, true)).toBe(false)
    // ...and never reported as the original it shadowed.
    expect(index.replacementCoverage(seq)).toEqual({
      kind: 'unknown-replacement',
      coveredSeqs: [sourceSeq],
    })
  }

  it('reports a replacement with no shadow price, and one with the official shadow price but no provenance, as unknown', () => {
    const bare = toolSession('b61-unknown-bare', 1)
    const bareSource = bare.steps[0]!.resultSeq
    const bareEvent = bare.session.eventAt(bareSource)
    if (bareEvent?.type !== 'tool/result') throw new Error('fixture: source is not a tool result')
    const bareReplacement = bare.session.append('tool/result', bareEvent.data, {
      surfaceOp: { op: 'replace', start: bareSource, end: bareSource },
      sourceEventSeqs: [bareSource],
    }).seq
    expectFailClosed(buildSurfaceSourceIndex(bare.session), bareReplacement, bareSource)

    // A THIRD-PARTY producer that logs the official shadow price but no
    // provenance — the harness's own rc.1 pruner included — keeps the protected
    // classification: shadow-price adjacency alone is not proof of what the
    // replacement holds.
    const foreign = toolSession('b61-unknown-foreign', 1)
    const foreignSource = foreign.steps[0]!.resultSeq
    const foreignReplacement = replaceWithShadowPrice(foreign.session, foreignSource, undefined)
    expectFailClosed(buildSurfaceSourceIndex(foreign.session), foreignReplacement, foreignSource)
    // An audit claim cannot upgrade it either: the audit is diagnostic, never a
    // type authority.
    expectFailClosed(
      buildSurfaceSourceIndex(foreign.session, new Set([foreignReplacement])),
      foreignReplacement,
      foreignSource,
    )
    // The official shadow price still prices the node, so failing closed costs
    // classification and never metering.
    const price = foreign.session.eventAt((foreignReplacement - 1) as SessionSeq)
    expect(price?.type).toBe('compaction/prune')
  })

  it('reports a damaged or self-inconsistent provenance as unknown instead of guessing a kind', () => {
    const mutations: Array<{ label: string; mutate: (base: ReductionProvenance, sourceSeq: SessionSeq) => unknown }> = [
      {
        label: 'tampered kind with a stale digest',
        mutate: base => ({ ...base, kind: 'tool-summary', groupId: 'invented-group' }),
      },
      {
        label: 'a tool summary without a group identity',
        mutate: base => ({ ...base, kind: 'tool-summary', groupId: null }),
      },
      {
        label: 'a covered range that disagrees with the official shadow price',
        mutate: (base, sourceSeq) => ({ ...base, coveredSeqs: [sourceSeq - 1] }),
      },
      {
        label: 'a source set rewritten without re-binding the digest',
        mutate: base => ({ ...base, sourceEventSeqs: [...base.sourceEventSeqs, base.coveredSeqs[0]! - 1] }),
      },
      { label: 'an unknown producer marker', mutate: base => ({ ...base, producer: 'someone-else' }) },
      { label: 'an unknown schema version', mutate: base => ({ ...base, schemaVersion: REDUCTION_PROVENANCE_VERSION + 1 }) },
      { label: 'a digest that no longer binds the content', mutate: base => ({ ...base, digest: 'f'.repeat(64) }) },
      { label: 'a truncated payload', mutate: base => ({ producer: base.producer, kind: base.kind }) },
      { label: 'a non-object payload', mutate: () => 'tool-pruned' },
    ]
    for (const [caseIndex, testCase] of mutations.entries()) {
      const { session, steps } = toolSession(`b61-damaged-${caseIndex}`, 1)
      const sourceSeq = steps[0]!.resultSeq
      const original = session.eventAt(sourceSeq)
      if (original?.type !== 'tool/result') throw new Error('fixture: source is not a tool result')
      const base = reductionProvenance({
        kind: 'tool-pruned',
        coveredSeqs: [sourceSeq],
        sourceEventSeqs: [sourceSeq],
        groupId: null,
        generation: 0,
        content: original.data.message.content,
      })
      const replacement = replaceWithShadowPrice(session, sourceSeq, testCase.mutate(base, sourceSeq))
      expectFailClosed(buildSurfaceSourceIndex(session), replacement, sourceSeq)
    }
  })

  it('conflict-fences an audit claim that disagrees with the durable provenance', () => {
    const { session, steps } = toolSession('b61-audit-conflict', 1)
    const pruned = pruner().pruneSession(session, { candidateSeqs: [steps[0]!.resultSeq] })
    const prunedSeq = pruned.pruned[0]!.replacementSeq
    // The Session says prune; a corrupted (whole-document LWW) audit claims a
    // summary. Two independent durable sources that disagree must not be
    // resolved by trusting the writable one.
    expect(buildSurfaceSourceIndex(session).entry(prunedSeq).kind).toBe('tool-pruned')
    expect(buildSurfaceSourceIndex(session, new Set([prunedSeq])).entry(prunedSeq).kind)
      .toBe('unknown-replacement')
  })
})

describe('B6.1 originals and the other replacement kinds are never misclassified', () => {
  it('keeps untouched originals original and never reads a shadow price as content provenance', () => {
    const { session, steps } = toolSession('b61-originals', 3)
    const index = buildSurfaceSourceIndex(session)
    for (const step of steps) {
      expect(index.entry(step.resultSeq).kind).toBe('original')
      expect(index.isOriginalToolResult(step.resultSeq)).toBe(true)
      expect(index.canCompactHistory(step.resultSeq, 1)).toBe(true)
      expect(index.replacementCoverage(step.resultSeq)).toEqual({ kind: 'original', coveredSeqs: null })
    }

    // A shadow price whose own replacement is a plain APPEND (no surface
    // replacement) must not turn the appended node into a reduction: nothing
    // about the appended node changed, and the price event describes another
    // node entirely.
    session.append('compaction/prune', {
      shadowedRange: { start: steps[0]!.resultSeq, end: steps[0]!.resultSeq },
      shadowedSeqs: [steps[0]!.resultSeq],
      shadowedTokenCount: 10,
    })
    const appended = session.append('tool/result', {
      turn: 1,
      step: 9,
      message: createToolResultMessage({
        callId: ToolCallId('appended'),
        content: [{ type: 'text', text: `${'z'.repeat(PRUNE_THRESHOLD + 40)} appended` }],
        isError: false,
      }),
    }, SURFACE).seq
    const appendedIndex = buildSurfaceSourceIndex(session)
    expect(appendedIndex.entry(appended).kind).toBe('original')
    expect(appendedIndex.isOriginalToolResult(appended)).toBe(true)

    // A landed prune removes exactly the node it shadowed and leaves every
    // surviving original's kind and identity intact.
    const replaced = pruner().pruneSession(session, { candidateSeqs: [steps[0]!.resultSeq] })
    const afterIndex = buildSurfaceSourceIndex(session)
    expect(session.surface.nodes).not.toContain(steps[0]!.resultSeq)
    expect(afterIndex.entry(replaced.pruned[0]!.replacementSeq).kind).toBe('tool-pruned')
    expect(afterIndex.entry(steps[1]!.resultSeq).kind).toBe('original')
    expect(afterIndex.entry(steps[2]!.resultSeq).kind).toBe('original')
  })

  it('keeps the non-tool replacement kinds on their own durable provenance', () => {
    const { session, steps } = toolSession('b61-other-kinds', 1)
    const prompt = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'later prompt' }],
      source: { kind: 'user' },
    }), SURFACE).seq
    const slot = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'slot' }],
      source: {
        kind: TASK_STATE_SLOT_SOURCE_KIND,
        slotId: TASK_STATE_SLOT_ID,
        sessionId: 'b61-other-kinds',
        lifecycleCreatedAt: session.header.createdAt,
        generation: 1,
        revision: 1,
        digest: 'd',
        sourceCursor: 0,
        coveredSeqs: [],
      },
    }), SURFACE).seq
    const checkpoint = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(CompactionId('b61-checkpoint')),
    }), {
      surfaceOp: { op: 'replace', start: steps[0]!.resultSeq, end: steps[0]!.resultSeq },
      sourceEventSeqs: [steps[0]!.resultSeq],
    }).seq

    const index = buildSurfaceSourceIndex(session)
    expect(index.entry(prompt).kind).toBe('original')
    expect(index.entry(slot).kind).toBe('task-state-slot')
    expect(index.entry(checkpoint).kind).toBe('history-summary')
    expect(index.replacementCoverage(slot)).toEqual({ kind: 'task-state-slot', coveredSeqs: null })
    // None of them is a tool result, so none is an original tool result — and in
    // particular the tool summary never absorbs the other kinds.
    expect(index.isOriginalToolResult(prompt)).toBe(false)
    expect(index.isOriginalToolResult(slot)).toBe(false)
    expect(index.isOriginalToolResult(checkpoint)).toBe(false)
  })
})

describe('B6.1 op1 and op2 stay mutually exclusive on provenance alone', () => {
  it('never offers a freshly summarized node to the same pass or to a later audit-free pass', () => {
    // Run 1 (two results) is summarized; run 2 keeps three raw results, one of
    // which this pass prunes — so the later selection must be precise rather
    // than blanket-excluding everything that is not the original.
    const { session, steps } = toolSession('b61-same-pass', 5, { splitAfter: 2 })
    const group = groupOver(session, { start: steps[0]!.callSeq, end: steps[1]!.resultSeq })
    const summarized = replaceToolGroup(session, group, summaryFor(session, group), { estimateTokens })
    expect(summarized.replacementSeqs).toHaveLength(2)

    // op2 inside the SAME pass: the candidate set is rebuilt from a fresh index
    // exactly like the engine does. A freshly landed summary is not eligible —
    // not because a round-local set says so, but because its durable provenance
    // says it is a summary.
    const index = buildSurfaceSourceIndex(session)
    const candidateSeqs = session.surface.nodes.filter(seq => index.isOriginalToolResult(seq))
    expect(candidateSeqs).toEqual([steps[2]!.resultSeq, steps[3]!.resultSeq, steps[4]!.resultSeq])
    for (const seq of summarized.replacementSeqs) expect(candidateSeqs).not.toContain(seq)
    const pruned = pruner().pruneSession(session, { candidateSeqs: [steps[2]!.resultSeq] })
    expect(pruned.pruned.map(entry => entry.originalSeq)).toEqual([steps[2]!.resultSeq])
    for (const seq of summarized.replacementSeqs) {
      expect(replacementText(session, seq)).toContain('[tool group summary]')
    }

    // A later pass that lost the audit entirely builds its eligibility from the
    // Session log alone. It excludes BOTH reduction kinds this package landed
    // (the run-1 summaries and the run-2 prune) and still offers the raw
    // originals, so the exclusion is precise rather than a blanket refusal.
    const afterIndex = buildSurfaceSourceIndex(session)
    const selectable = selectToolGroups(session, {
      minGroupResults: 1,
      minGroupChars: 1,
      minGroupTokens: 1,
      maxGroupTokens: 100_000,
      maxGroups: 4,
      estimateTokens: () => 1,
      isEligibleResult: seq => afterIndex.isOriginalToolResult(seq),
    })
    const selectableResults = selectable.flatMap(candidate => [...candidate.toolResultSeqs])
    expect([...selectableResults].sort((left, right) => left - right))
      .toEqual([steps[3]!.resultSeq, steps[4]!.resultSeq])
    for (const seq of summarized.replacementSeqs) expect(selectableResults).not.toContain(seq)
    expect(selectableResults).not.toContain(pruned.pruned[0]!.replacementSeq)
  })
})

describe('B6.1 the durable provenance is additive to the official event', () => {
  it('leaves the official shadow-price fields and the replacement shape exactly as the protocol requires', () => {
    const { session, steps } = toolSession('b61-protocol-shape', 2)
    const result = pruner().pruneSession(session, { candidateSeqs: [steps[0]!.resultSeq] })
    const entry = result.pruned[0]!
    const price = session.eventAt((entry.replacementSeq - 1) as SessionSeq)
    if (price?.type !== 'compaction/prune') throw new Error('fixture: no adjacent shadow price')
    // The official fields are untouched and still satisfy the package invariant;
    // the provenance is one additive key beside them.
    expect(Object.keys(price.data).sort()).toEqual(['provenance', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount'])
    expect(price.data.shadowedRange).toEqual({ start: entry.originalSeq, end: entry.originalSeq })
    expect(price.data.shadowedSeqs).toEqual([entry.originalSeq])
    expect(Number.isSafeInteger(price.data.shadowedTokenCount)).toBe(true)

    const replacement = session.eventAt(entry.replacementSeq)
    if (replacement?.type !== 'tool/result') throw new Error('fixture: replacement is not a tool result')
    const original = session.eventAt(entry.originalSeq)
    if (original?.type !== 'tool/result') throw new Error('fixture: source is not a tool result')
    // A `tool/result` replacement may change ONLY its content, so the provenance
    // cannot hide in the replacement's own data — every other field is byte-equal.
    expect(replacement.surfaceOp).toEqual({ op: 'replace', start: entry.originalSeq, end: entry.originalSeq })
    expect(replacement.sourceEventSeqs).toEqual([entry.originalSeq])
    expect(replacement.data.message.source).toEqual(original.data.message.source)
    expect(replacement.data.turn).toBe(original.data.turn)
    expect(replacement.data.step).toBe(original.data.step)
    expect(replacement.data.meta).toEqual(original.data.meta)
  })

  it('binds each digest to the replacement content it describes', () => {
    const { session, steps } = toolSession('b61-digest-binding', 1)
    const sourceSeq = steps[0]!.resultSeq
    const original = session.eventAt(sourceSeq)
    if (original?.type !== 'tool/result') throw new Error('fixture: source is not a tool result')
    const input = {
      kind: 'tool-pruned' as const,
      coveredSeqs: [sourceSeq],
      sourceEventSeqs: [sourceSeq],
      groupId: null,
      generation: 0,
    }
    const base: ReductionProvenance = reductionProvenance({ ...input, content: original.data.message.content })
    // Same payload, DIFFERENT content: the digest must differ, which is what
    // makes mutating one without the other detectable at read time.
    const other = reductionProvenance({ ...input, content: [{ type: 'text', text: 'a completely different body' }] })
    expect(other.digest).not.toBe(base.digest)
    expect(other.digest).toMatch(/^[0-9a-f]{64}$/)
    // The same input encodes to the same digest (the classifier can recompute it).
    const repeated = reductionProvenance({ ...input, content: original.data.message.content })
    expect(repeated).toEqual(base)
    // A landing writes the digest of the content it actually appends, which is
    // the pruned body rather than the original one.
    const landed = pruner().pruneSession(session, { candidateSeqs: [sourceSeq] })
    const provenance = provenanceBefore(session, landed.pruned[0]!.replacementSeq)
    expect(provenance.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(provenance.digest).not.toBe(base.digest)
  })
})
