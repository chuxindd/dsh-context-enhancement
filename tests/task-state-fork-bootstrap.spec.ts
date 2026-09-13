/**
 * B7 · fork child cursor/bootstrap 契约（own-events boundary）
 *
 * SCOPE (B7 only)
 * ---------------
 * 本 spec 只证明 PLAN §9 选定的**一种**产品语义，不把另一种写成失败：
 *
 * - 选定 **语义 A**：child 从自己的 own-events 边界独立重建。`inheritedEventCount`
 *   是继承边界的唯一 durable 来源（`firstLiveSeq` 只是本进程构造事实）；child 没有
 *   自己的记录时 cursor 起点是 `inheritedEventCount - 1`（不是 `-1`），继承前缀
 *   **不重复折叠**成 child 的 live 事实；child 的 committed stable 与 open audit 行
 *   携带 `inherited` 标记（来源 + covered range）；任何落在 live 边界之内的覆盖声明
 *   被**拒绝**（fail closed），绝不被信任。
 * - 未选的 **语义 B**（父 stable 一次性 bootstrap）在 `审计资料/B7-实施记录.md` §2.3
 *   记录了拒绝理由，不在此处作为失败断言。
 *
 * WHAT IS REAL HERE
 * -----------------
 * REAL `SessionStore`（含真实 `ctx.sessions.fork`）、REAL JSONL Session 持久化
 * （REAL `sessionPersistence.prepare` → `sessions.enter` → `sessions.announce` 恢复）、
 * REAL `Storage` + `StorageJson` + `StorageDomain` durable 域、REAL `LlmRuntime` +
 * scripted adapter、REAL `TaskStateBasicService`（调度 / filter / fold / 校验 / 权威
 * put / committed 指针 / lifecycle fence / terminal verdict）、REAL `SystemPrompt` +
 * `task-state-prompt` 消费者（`agent/pre-step` waterfall 派发）、REAL compaction 归约
 * 写入（`selectToolGroups` + `buildToolGroupSummaryInput` + `replaceToolGroup`，provenance
 * 由生产编码器写出）。
 *
 * EMULATED：只有模型本身（scripted adapter，不产出 usage），以及 slot 测试中复刻
 * `packages/core/agent-loop/src/agent.ts` 的两行 loop 顺序（pre-step → append claimed →
 * derive request），与 `tests/task-state-prompt-fixed-slot.spec.ts` 完全一致。
 *
 * 覆盖（用户固定 8 项，逐项在 describe 标题里点名）：
 * 1 `inheritedEventCount` 与 `firstLiveSeq` 不相等（fork 时相等、resume 后不等）；
 * 2 inherited eligible events 被历史 replacement 遮蔽；
 * 3 parent/child 相同与不同 stable；
 * 4 child 不得复用 parent 的内存 cursor/slot/terminal/audit ownership；
 * 5 resume 同 ID 与 fork 新 ID 分开；
 * 6 child 首批不把 inherited prefix 当新 live 事实；新 live event 推进新 generation；
 * 7 task-state slot：child 从自己的日志重建，不共享 parent slot；
 * 8 compaction source index / reentry 不误把 inherited replacement 当 live source。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import TaskStateBasicService from '../src/task-state-basic.ts'
import type { TaskStateStable } from '../src/task-state.ts'
import * as TaskStatePrompt from '../src/task-state-prompt.ts'
import type { TaskStateBasicConfig } from '../src/internal/task-state/basic/types.ts'
import { filterEvent, isEligibleType } from '../src/internal/task-state/basic/filter.ts'
import { isOwnSlotNode } from '../src/internal/task-state/prompt/index.ts'
import { rowsForLifecycle } from '../src/internal/task-state/contract/audit.ts'
import type { TaskStateAuditRecord } from '../src/internal/task-state/contract/audit.ts'
import { TASK_STATE_SLOT_SOURCE_KIND } from '../src/internal/task-state/contract/index.ts'
import type { TaskStateSlotSource } from '../src/internal/task-state/contract/index.ts'
import { buildSurfaceSourceIndex } from '../src/internal/compaction/source-index.ts'
import { selectToolGroups } from '../src/internal/compaction/tool-groups.ts'
import type { ToolGroup } from '../src/internal/compaction/tool-groups.ts'
import { replaceToolGroup } from '../src/internal/compaction/tool-group-replacement.ts'
import { buildToolGroupSummaryInput } from '../src/internal/compaction/tool-group-summary.ts'
import type { ToolGroupSummary } from '../src/internal/compaction/tool-group-summary.ts'

// ---------------------------------------------------------------------------
// Fixed fixture constants
// ---------------------------------------------------------------------------

const PARENT_ID = SessionId('b7-fork-parent')
const CHILD_ID = SessionId('b7-fork-child')
/** Explicit parent lifecycle epoch, so the fork child's store-minted cut differs. */
const CREATED_AT = 1_700_000_000_000
const DOMAIN_FILE = 'context_enhancement_task_state_v2.json'
const MAX_BYTES = 8_000
const PROVIDER = 'current-route'
const MODEL = 'current-model'
const PRUNE_THRESHOLD = 64
const SUMMARY_PRICE = 1
const ORIGINAL_PRICE = 100

const BASE_CONFIG: TaskStateBasicConfig = {
  provider: PROVIDER,
  model: MODEL,
  minEvents: 1,
  maxEvents: 20,
  maxInputBytes: 100_000,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  maxInfraRetries: 0,
  maxEntriesPerKind: 10,
  maxEntryBytes: 2_000,
  maxListItems: 8,
}

/** One candidate body reused for BOTH lifecycles (coverage item 3, "same stable"). */
const SAME_CANDIDATE = JSON.stringify({
  facts: [{ content: 'identical candidate body for parent and child' }],
  decisions: [],
  constraints: [],
  risks: [],
  evidence: [],
  todoReferences: [],
  continuation: {
    currentObjective: 'identical objective',
    currentFocus: 'identical focus',
    openWork: [],
    nextActions: [],
  },
})

// ---------------------------------------------------------------------------
// Fixtures: scripted adapter, mounts, session builders
// ---------------------------------------------------------------------------

/** Scripted auxiliary adapter: one fixed body, or one derived from the folded watermark. */
class ForkAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Fixed candidate body; when unset the body is derived from the framed watermark. */
  fixed: string | undefined

  constructor(fixed?: string) {
    super()
    this.fixed = fixed
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.fixed ?? candidateThrough(frameWatermark(options))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Highest `"seq":N` the deterministic frame shows, or -1. */
function frameWatermark(options: GenerateOptions): number {
  const text = options.messages
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
  let highest = -1
  for (const match of text.matchAll(/"seq":\s*(\d+)/gu)) highest = Math.max(highest, Number(match[1]))
  return highest
}

/** One structurally valid candidate whose content depends on the folded watermark. */
function candidateThrough(watermark: number): string {
  return JSON.stringify({
    facts: [{ content: `folded through seq ${watermark}` }],
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: [],
    continuation: {
      currentObjective: `probe window-through-${watermark}`,
      currentFocus: 'b7 fork contract',
      openWork: [],
      nextActions: [],
    },
  })
}

/** One candidate whose committed content is far larger than any tiny input budget. */
function hugeFactsCandidate(count: number, bytes: number): string {
  return JSON.stringify({
    facts: Array.from({ length: count }, (_unused, index) => ({
      content: `big fact ${index} ${'x'.repeat(bytes)}`,
    })),
    decisions: [],
    constraints: [],
    risks: [],
    evidence: [],
    todoReferences: [],
    continuation: {
      currentObjective: 'oversized base',
      currentFocus: 'b7 terminal ownership',
      openWork: [],
      nextActions: [],
    },
  })
}

/** One mounted real composition. */
interface Mounted {
  readonly ctx: Context
  readonly adapter: ForkAdapter
  readonly sessionRoot: string
  readonly storageRoot: string
  readonly held: Array<{ preparation: unknown; detach: () => void }>
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Mount the base stack: sessions + JSONL persistence + storage domain + LLM route. */
async function mountBase(
  root: string,
  adapter: ForkAdapter,
  overrides: Partial<TaskStateBasicConfig>,
): Promise<Mounted & { config: TaskStateBasicConfig }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root, 'sessions'),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return {
    ctx,
    adapter,
    sessionRoot: join(root, 'sessions'),
    storageRoot: join(root, 'storage'),
    held: [],
    config: { ...BASE_CONFIG, ...overrides },
  }
}

/** Mount the base stack plus the real provider (and optionally the real slot consumer). */
async function mountComposition(options: {
  readonly root: string
  readonly adapter: ForkAdapter
  readonly overrides?: Partial<TaskStateBasicConfig>
  readonly prompt?: boolean
}): Promise<Mounted> {
  const mounted = await mountBase(options.root, options.adapter, options.overrides ?? {})
  await mounted.ctx.plugin(TaskStateBasicService, mounted.config)
  if (options.prompt === true) {
    await mounted.ctx.plugin(SystemPrompt)
    await mounted.ctx.plugin(TaskStatePrompt, { maxBytes: MAX_BYTES })
  }
  return mounted
}

/** Create a fresh temporary root tracked for teardown. */
async function newRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-b7-${label}-`))
  roots.push(root)
  return root
}

/** Poll one predicate until it holds or the deadline elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`b7 fork spec: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Close one process completely: drain the JSONL writer, release resumes, dispose. */
async function closeProcess(mounted: Mounted): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  for (const handle of mounted.held.splice(0)) {
    handle.detach()
    releasePreparation(handle.preparation)
  }
  await mounted.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(mounted.ctx), 1)
}

/** Release one held preparation through its `Symbol.dispose` protocol. */
function releasePreparation(preparation: unknown): void {
  const dispose = (preparation as Record<PropertyKey, unknown> | undefined)?.[Symbol.dispose as unknown as PropertyKey]
  if (typeof dispose === 'function') (dispose as () => void).call(preparation)
}

/** Resume one durable Session through the production persistence idiom. */
async function resume(mounted: Mounted, id: SessionId): Promise<Session> {
  const persistence = (mounted.ctx as unknown as {
    sessionPersistence: { prepare: (id: SessionId) => Promise<unknown> }
  }).sessionPersistence
  const preparation = await persistence.prepare(id)
  const session = (preparation as { readonly session: Session }).session
  const detach = mounted.ctx.sessions.enter(session)
  mounted.ctx.sessions.announce(session)
  mounted.held.push({ preparation, detach })
  return session
}

/** Create one Session with the fixed parent lifecycle epoch. */
function createParent(mounted: Mounted, id: SessionId = PARENT_ID): Session {
  return mounted.ctx.sessions.create(id, {
    meta: { cwd: mounted.storageRoot, createdAt: CREATED_AT },
  })
}

/** Append one direct human user/message. */
function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append one model assistant/message. */
function appendAssistant(session: Session, turn: number, step: number, text: string): number {
  return session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' }).seq
}

/** Append one complete sealed turn; every appended seq in order. */
function appendTurn(session: Session, turn: number, text: string): number[] {
  return [
    session.append('turn/start', { turn }).seq,
    appendUser(session, text),
    appendAssistant(session, turn, 1, `${text} (assistant)`),
    session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq,
  ]
}

/** Append one tool-call + tool-result pair on the surface. */
function addToolStep(
  session: Session,
  turn: number,
  step: number,
  callId: string,
  text: string,
): { callSeq: number; resultSeq: number } {
  const callSeq = session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'bash', arguments: `--file ${callId}.ts` }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' }).seq
  const resultSeq = session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
  return { callSeq, resultSeq }
}

/** Append one sealed turn whose middle is a tool call + result. */
function appendToolTurn(
  session: Session,
  turn: number,
  callId: string,
  resultText: string,
  userText: string,
): { turnSeqs: number[]; callSeq: number; resultSeq: number } {
  const start = session.append('turn/start', { turn }).seq
  const user = appendUser(session, userText)
  const step = addToolStep(session, turn, 1, callId, resultText)
  const end = session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq
  return { turnSeqs: [start, user, step.callSeq, step.resultSeq, end], ...step }
}

/** The pricing seam the real producers call, mirrored by this fixture. */
function estimateTokens(message: { readonly content: readonly { readonly type?: unknown }[] }): number {
  const block = message.content[0] as
    | { readonly type?: unknown; readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[] }
    | undefined
  const inner = block?.content?.[0]
  const text = inner?.type === 'text' && typeof inner.text === 'string' ? inner.text : ''
  return text.includes('[tool group summary]') ? SUMMARY_PRICE : ORIGINAL_PRICE
}

/** Select one tool group over one inclusive span. */
function groupOver(session: Session, span: { start: number; end: number }): ToolGroup {
  const groups = selectToolGroups(session, {
    olderRange: { start: SessionSeq(span.start), end: SessionSeq(span.end) },
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

/** The validated summary document a group's model call would return. */
function summaryFor(session: Session, group: ToolGroup): ToolGroupSummary {
  const input = buildToolGroupSummaryInput(session, group)
  return {
    version: 1,
    groupSummary: 'done',
    items: input.items.map(item => ({
      sourceSeq: item.sourceSeq,
      ...item.callId === undefined ? {} : { callId: item.callId },
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

/**
 * Write ONE real provenanced semantic summary over the tool-result node at
 * `sourceSeq` through the production reduction writer: the official shadow-price
 * event (carrying B6's durable provenance) immediately followed by the surface
 * replacement. Returns the landed replacement seq.
 */
function reduceWithSummary(session: Session, sourceSeq: number, span: { start: number; end: number }): number {
  const group = groupOver(session, span)
  const result = replaceToolGroup(session, group, summaryFor(session, group), { estimateTokens })
  const landed = result.replacementSeqs.find(seq => Number(seq) !== Number(sourceSeq))
  if (landed === undefined) throw new Error(`fixture: reduction over seq ${sourceSeq} did not land`)
  return Number(landed)
}

// ---------------------------------------------------------------------------
// Durable medium and runtime readers
// ---------------------------------------------------------------------------

/** Minimal structural view of the durable domain document. */
interface DomainDoc {
  tables: {
    sessions: Record<string, {
      session: { createdAt: number; cwd?: string }
      stable?: TaskStateStable
      terminal?: { kind: string; cursor: number }
    }>
    audit: Record<string, unknown>
  }
}

/** Read the durable domain document, or `null` when absent/unreadable. */
async function readDomain(storageRoot: string): Promise<DomainDoc | null> {
  try {
    return JSON.parse(await readFile(join(storageRoot, DOMAIN_FILE), 'utf8')) as DomainDoc
  } catch {
    return null
  }
}

/** Every durable audit row of one mounted composition. */
function auditRows(mounted: Mounted): TaskStateAuditRecord[] {
  const provider = mounted.ctx.get('taskState') as TaskStateBasicService
  const table = (provider as unknown as {
    auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
  }).auditTable
  if (table === undefined) return []
  return [...table.entries()].map(entry => entry[1])
}

/** The audit rows fenced to one Session's lifecycle identity. */
function rowsFor(mounted: Mounted, session: Session): TaskStateAuditRecord[] {
  return [...rowsForLifecycle(auditRows(mounted), {
    createdAt: session.header.createdAt,
    ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
  })]
}

/** Eligible, projectable seqs strictly above `cursor` (real filter math). */
function eligibleSeqsAbove(session: Session, cursor: number): number[] {
  const seqs: number[] = []
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= cursor) continue
    if (!isEligibleType(event.type)) continue
    if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) continue
    seqs.push(Number(event.seq))
  }
  return seqs
}

/** Every eligible, projectable seq strictly below one boundary (the inherited prefix). */
function inheritedEligibleSeqs(session: Session, cut: number): number[] {
  const seqs: number[] = []
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) >= cut) continue
    if (!isEligibleType(event.type)) continue
    if (filterEvent({ type: event.type, seq: event.seq, data: event.data }) === null) continue
    seqs.push(Number(event.seq))
  }
  return seqs
}

/** Wait until nothing eligible is left above the committed cursor. */
async function waitForDrained(mounted: Mounted, session: Session, timeoutMs = 8_000): Promise<void> {
  await waitUntil(() => {
    const stable = mounted.ctx.taskState.getStable(session.id)
    if (stable === undefined) return false
    return eligibleSeqsAbove(session, stable.sourceCursor).length === 0
  }, timeoutMs, `drain of ${String(session.id)}`)
}

/** Wait for one Session's committed stable. */
async function waitForStable(mounted: Mounted, id: SessionId, timeoutMs = 8_000): Promise<TaskStateStable> {
  await waitUntil(() => mounted.ctx.taskState.getStable(id) !== undefined, timeoutMs, `stable of ${String(id)}`)
  return stableOf(mounted, id)
}

/** The committed stable of one Session (never undefined for a live assertion). */
function stableOf(mounted: Mounted, target: Session | SessionId): TaskStateStable {
  // `SessionId` is a branded string, so the tag decides which accessor to read.
  const id: SessionId = typeof target === 'string' ? target : target.id
  const stable = mounted.ctx.taskState.getStable(id)
  if (stable === undefined) throw new Error(`fixture: Session "${String(id)}" holds no stable`)
  return stable
}

/** Whether every recorded window of one Session stays at or above `cut`. */
function windowsAbove(rows: readonly TaskStateAuditRecord[], cut: number): boolean {
  return rows.every(row => [...row.request.includedSeqs].every(seq => Number(seq) >= cut))
}

/** Every seq recorded by every window of one Session, in row order. */
function windowSeqs(rows: readonly TaskStateAuditRecord[]): number[] {
  return rows.flatMap(row => [...row.request.includedSeqs].map(Number))
}

/** The open-phase request data of the row that committed one revision. */
function requestOfRevision(rows: readonly TaskStateAuditRecord[], revision: number): TaskStateAuditRecord['request'] {
  const row = rows.find(candidate => candidate.request.revision === revision && candidate.finished !== undefined)
  if (row === undefined) throw new Error(`fixture: no finished audit row for revision ${revision}`)
  return row.request
}

/**
 * The finished open-phase request of one committed revision. A commit publishes
 * its stable as soon as the authority put resolves, so the row carrying the
 * wave's trigger may still be open for a moment after the pointer advanced.
 */
async function openRequest(
  mounted: Mounted,
  session: Session,
  revision: number,
): Promise<TaskStateAuditRecord['request']> {
  await waitUntil(
    () => rowsFor(mounted, session).some(row => row.request.revision === revision && row.finished !== undefined),
    2_000,
    `finished audit row for revision ${revision}`,
  )
  return requestOfRevision(rowsFor(mounted, session), revision)
}

// ---------------------------------------------------------------------------
// Slot (prompt consumer) helpers
// ---------------------------------------------------------------------------

/** One model-visible slot node as it exists in a Session log. */
interface SlotNode {
  readonly seq: number
  readonly source: TaskStateSlotSource
  readonly text: string
}

/** Whether one logged event is a Stable task-state slot node. */
function isSlotEvent(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && (event.data.source as { readonly kind?: unknown }).kind === TASK_STATE_SLOT_SOURCE_KIND
}

/** Every slot node in a Session log, in log order. */
function slotNodes(session: Session): SlotNode[] {
  const nodes: SlotNode[] = []
  for (const event of session.snapshotEvents()) {
    if (!isSlotEvent(event)) continue
    const data = event.data as {
      readonly source: TaskStateSlotSource
      readonly content?: readonly { readonly text?: string }[]
    }
    nodes.push({ seq: Number(event.seq), source: data.source, text: data.content?.[0]?.text ?? '' })
  }
  return nodes
}

/** Every slot node still ON the surface, in surface order. */
function visibleSlotNodes(session: Session): SlotNode[] {
  const bySeq = new Map(slotNodes(session).map(node => [node.seq, node]))
  return session.surface.nodes.flatMap(seq => {
    const node = bySeq.get(Number(seq))
    return node === undefined ? [] : [node]
  })
}

/** Drive ONE loop step boundary exactly as `agent.ts` does. */
async function runStep(mounted: Mounted, session: Session, turn: number, step: number): Promise<readonly Message[]> {
  const agent = { session } as unknown as Agent
  const messages: UserMessage[] = []
  const decision = await mounted.ctx.waterfall(
    'agent/pre-step',
    { agent, messages, turn, step, signal: new AbortController().signal },
    async (): Promise<PreStepDecision> => ({ kind: 'enter', messages }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  return session.deriveMessages()
}

// ---------------------------------------------------------------------------
// The shared parent prefix
// ---------------------------------------------------------------------------

/** One built parent prefix: the fork boundary and the evidence seqs inside it. */
interface ParentPrefix {
  readonly parent: Session
  readonly boundary: number
  readonly cut: number
  readonly shadowedOriginalSeq: number
  readonly inheritedReplacementSeq: number
}

/**
 * Build the parent prefix used by the fork tests:
 * turn 1 (sealed) → turn 2 with one tool step → a REAL provenanced semantic
 * summary replacing that tool result → turn 3 (sealed). The inherited prefix
 * therefore contains eligible events that a historical replacement shadows, and
 * one completed turn AFTER that replacement.
 */
async function buildParentPrefix(mounted: Mounted): Promise<ParentPrefix> {
  const parent = createParent(mounted)
  appendTurn(parent, 1, 'parent turn one')
  await waitForStable(mounted, PARENT_ID)

  const toolTurn = appendToolTurn(parent, 2, 'b7-call-1', `${'p'.repeat(PRUNE_THRESHOLD + 40)} parent tool output`, 'parent turn two runs a tool')
  const replacement = reduceWithSummary(parent, toolTurn.resultSeq, {
    start: toolTurn.callSeq,
    end: toolTurn.resultSeq,
  })
  appendTurn(parent, 3, 'parent turn three')
  await waitForDrained(mounted, parent)

  const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
  return {
    parent,
    boundary,
    cut: boundary + 1,
    shadowedOriginalSeq: Number(toolTurn.resultSeq),
    inheritedReplacementSeq: replacement,
  }
}

// ---------------------------------------------------------------------------
// 1/2/4/6 · child 首批窗口从 own-events 边界开始
// ---------------------------------------------------------------------------

describe('B7 · child 首批窗口 = 自己的事件（覆盖 1/2/4/6）', () => {
  it('fork child 无记录时：不折叠继承前缀（含被 replacement 遮蔽的 eligible 事件），base 为 null，标记记录边界', async () => {
    const root = await newRoot('prefix')
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const prefix = await buildParentPrefix(mounted)
    const parentBefore = stableOf(mounted, prefix.parent)

    // Fixture sanity: the inherited prefix really is full of eligible, projectable
    // events, including the shadowed original AND the replacement that shadows it.
    const inheritedEligible = inheritedEligibleSeqs(prefix.parent, prefix.cut)
    expect(inheritedEligible.length).toBeGreaterThanOrEqual(3)
    expect(inheritedEligible).toContain(prefix.shadowedOriginalSeq)
    expect(inheritedEligible).toContain(prefix.inheritedReplacementSeq)
    // ...and the parent really did fold inherited content into its own windows.
    expect(windowSeqs(rowsFor(mounted, prefix.parent)).filter(seq => seq < prefix.cut).length).toBeGreaterThan(0)

    const requestsBefore = mounted.adapter.requests.length
    const child = mounted.ctx.sessions.fork(prefix.parent, SessionSeq(prefix.boundary), CHILD_ID)
    // Coverage item 1 (fork half): at fork time the two DSH facts are EQUAL, so
    // the contract must rest on the durable cut alone.
    expect(Number(child.inheritedEventCount)).toBe(prefix.cut)
    expect(Number(child.firstLiveSeq)).toBe(prefix.cut)
    expect(child.header.isSeeded).toBe(true)
    expect(child.header.parentSession).toBe(PARENT_ID)

    // Coverage item 6: with no own event there is no window to fold — inherited
    // content must never become the child's startup backlog.
    await new Promise<void>(resolve => setTimeout(resolve, 120))
    expect(mounted.adapter.requests.length).toBe(requestsBefore)
    expect(mounted.ctx.taskState.getStable(CHILD_ID)).toBeUndefined()

    // The child's own live turn (turn 4 continues the inherited turn numbering).
    const ownTurn = appendTurn(child, 4, 'child turn one')
    await waitForStable(mounted, CHILD_ID)
    await waitForDrained(mounted, child)

    const childRows = rowsFor(mounted, child)
    const childStable = stableOf(mounted, child)
    const firstRequest = await openRequest(mounted, child, 1)
    const firstWindow = [...firstRequest.includedSeqs].map(Number)

    // Coverage item 1 + 4 + 6: the first window is the child's own, on no base.
    expect(firstRequest.base).toBeNull()
    expect(firstWindow.length).toBeGreaterThan(0)
    expect(firstWindow.every(seq => seq >= prefix.cut)).toBe(true)
    expect(firstWindow).toContain(ownTurn[1])
    expect(windowsAbove(childRows, prefix.cut)).toBe(true)
    expect(childStable.revision).toBe(1)
    expect(childStable.sourceCursor).toBeGreaterThanOrEqual(prefix.cut)

    // Coverage item 2: no inherited eligible seq — the shadowed original or the
    // replacement that shadows it — ever enters a child window.
    const childWindows = windowSeqs(childRows)
    for (const seq of inheritedEligible) expect(childWindows).not.toContain(seq)

    // Coverage item 1 + 6: the boundary is recorded durably, on the stable AND on
    // the open audit row, with its source and covered range.
    expect(childStable.inherited?.source).toBe('fork-prefix')
    expect(childStable.inherited?.ownBoundarySeq).toBe(prefix.cut)
    expect(childStable.inherited?.inheritedThroughSeq).toBe(prefix.cut - 1)
    expect(childStable.inherited?.parentSession).toBe(String(PARENT_ID))
    expect(firstRequest.inherited?.ownBoundarySeq).toBe(prefix.cut)
    // An unseeded lifecycle records no inherited prefix at all.
    expect(parentBefore.inherited).toBeUndefined()

    // Coverage item 4: the parent's own record and pointer are untouched, and the
    // child's digest/source cursor are its own.
    const parentAfter = stableOf(mounted, prefix.parent)
    expect(parentAfter.digest).toBe(parentBefore.digest)
    expect(parentAfter.sourceCursor).toBe(parentBefore.sourceCursor)
    expect(parentAfter.revision).toBe(parentBefore.revision)
    expect(childStable.digest).not.toBe(parentBefore.digest)

    // Coverage item 3 (different stable): the derived candidates differ.
    expect(childStable.continuation.currentObjective).not.toBe(parentBefore.continuation.currentObjective)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 3 · parent/child 相同 stable 内容
// ---------------------------------------------------------------------------

describe('B7 · parent/child stable 相同与不同（覆盖 3）', () => {
  it('两侧候选内容相同也不共享任何归属：各自铸 id、各自 digest、各自记录与审计', async () => {
    const root = await newRoot('same-content')
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(SAME_CANDIDATE), prompt: false })
    const parent = createParent(mounted)
    appendTurn(parent, 1, 'parent turn one')
    await waitForDrained(mounted, parent)
    const parentStable = stableOf(mounted, parent)

    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    appendTurn(child, 2, 'child turn one')
    await waitForDrained(mounted, child)
    const childStable = stableOf(mounted, child)

    // Same candidate body committed by both lifecycles: the content fields match…
    expect(childStable.continuation.currentObjective).toBe(parentStable.continuation.currentObjective)
    expect(childStable.facts.map(entry => entry.content))
      .toEqual(parentStable.facts.map(entry => entry.content))
    // …but every Host-owned identity is minted per lifecycle, so nothing is shared.
    expect(String(childStable.facts[0]!.id)).not.toBe(String(parentStable.facts[0]!.id))
    expect(childStable.digest).not.toBe(parentStable.digest)
    expect(childStable.sourceCursor).toBeGreaterThanOrEqual(cut)
    expect(childStable.inherited?.ownBoundarySeq).toBe(cut)
    expect(parentStable.inherited).toBeUndefined()

    const parentRows = rowsFor(mounted, parent)
    const childRows = rowsFor(mounted, child)
    expect(parentRows.length).toBeGreaterThan(0)
    expect(childRows.length).toBeGreaterThan(0)
    expect(childRows.every(row => row.session.createdAt === child.header.createdAt)).toBe(true)
    expect(parentRows.every(row => row.session.createdAt === CREATED_AT)).toBe(true)
    expect(child.header.createdAt).not.toBe(CREATED_AT)
    expect(windowsAbove(childRows, cut)).toBe(true)
    const firstRequest = await openRequest(mounted, child, 1)
    expect(firstRequest.inherited?.ownBoundarySeq).toBe(cut)
    expect(firstRequest.base).toBeNull()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 4 · terminal ownership
// ---------------------------------------------------------------------------

describe('B7 · child 不复用 parent 的 terminal verdict / cursor（覆盖 4）', () => {
  it('parent 持有 blockBaseOverBudget 时，child 的 cursor 与 verdict 仍只属于自己', async () => {
    const root = await newRoot('terminal')
    const mounted = await mountComposition({
      root,
      adapter: new ForkAdapter(hugeFactsCandidate(10, 1_900)),
      // The base a committed stable can hold (10 × ≤2 000 bytes) already exceeds
      // this budget, so the parent's NEXT wave is an infeasible base window.
      overrides: { maxInputBytes: 2_600, maxEntriesPerKind: 10, maxEntryBytes: 2_000 },
      prompt: false,
    })
    const parent = createParent(mounted)
    appendTurn(parent, 1, 'parent turn one')
    await waitForStable(mounted, PARENT_ID)
    // A second parent window whose base alone cannot fit: a durable terminal block.
    appendTurn(parent, 2, 'parent turn two')
    await waitUntil(() => mounted.ctx.taskState.getTerminal(PARENT_ID) !== undefined, 8_000, 'parent terminal verdict')
    const parentTerminal = mounted.ctx.taskState.getTerminal(PARENT_ID)
    expect(parentTerminal?.kind).toBe('blockBaseOverBudget')
    expect(mounted.ctx.taskState.getActiveTerminalBlock(PARENT_ID)).toBeDefined()

    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    expect(parentTerminal!.cursor).toBeLessThan(cut)

    appendTurn(child, 3, 'child turn one')
    await waitForStable(mounted, CHILD_ID)
    await waitForDrained(mounted, child)

    // The child never adopts the parent's verdict, its generation, or its cursor.
    expect(mounted.ctx.taskState.getTerminal(CHILD_ID)).toBeUndefined()
    expect(mounted.ctx.taskState.getActiveTerminalBlock(CHILD_ID)).toBeUndefined()
    const childStable = stableOf(mounted, child)
    const childRows = rowsFor(mounted, child)
    expect(windowsAbove(childRows, cut)).toBe(true)
    expect(childStable.sourceCursor).toBeGreaterThanOrEqual(cut)
    expect(childStable.revision).toBe(1)

    // On the durable medium the child's record carries no terminal verdict.
    const doc = await readDomain(mounted.storageRoot)
    expect(doc?.tables.sessions[String(CHILD_ID)]?.terminal).toBeUndefined()
    expect(doc?.tables.sessions[String(PARENT_ID)]?.terminal).toBeDefined()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 1/5/6 · resume 同 ID vs fork 新 ID
// ---------------------------------------------------------------------------

describe('B7 · resume 同 ID 与 fork 新 ID 分开（覆盖 1/5/6）', () => {
  it('重启后同 ID 恢复自己的 stable（0 次模型调用）；新 live 事件从自己的 base 推进新 revision', async () => {
    const root = await newRoot('resume')
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const parent = createParent(mounted)
    appendTurn(parent, 1, 'parent turn one')
    await waitForDrained(mounted, parent)
    const parentStable = stableOf(mounted, parent)
    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)

    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    appendTurn(child, 2, 'child turn one')
    await waitForDrained(mounted, child)
    const childStable = stableOf(mounted, child)
    expect(childStable.revision).toBe(1)
    await closeProcess(mounted)

    // ---- restart: the same durable medium, a NEW process -------------------
    const reopened = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const resumedParent = await resume(reopened, PARENT_ID)
    const resumedChild = await resume(reopened, CHILD_ID)

    // Coverage item 5: the same id comes back as ITS OWN lifecycle.
    expect(resumedParent.header.createdAt).toBe(CREATED_AT)
    expect(Number(resumedParent.inheritedEventCount)).toBe(0)
    expect(resumedChild.header.createdAt).not.toBe(CREATED_AT)
    expect(Number(resumedChild.inheritedEventCount)).toBe(cut)
    expect(stableOf(reopened, resumedParent).digest).toBe(parentStable.digest)
    expect(stableOf(reopened, resumedChild).digest).toBe(childStable.digest)
    expect(stableOf(reopened, resumedChild).sourceCursor).toBe(childStable.sourceCursor)
    expect(stableOf(reopened, resumedChild).inherited?.ownBoundarySeq).toBe(cut)
    expect(stableOf(reopened, resumedParent).digest).not.toBe(stableOf(reopened, resumedChild).digest)

    // Coverage item 1: after the resume the two DSH facts demonstrably differ,
    // and the contract still uses the durable fork cut.
    const firstLiveSeq = Number(resumedChild.firstLiveSeq)
    expect(firstLiveSeq).toBeGreaterThan(cut)
    expect(firstLiveSeq).not.toBe(cut)

    // Resume alone costs nothing: no wave, no model call.
    await new Promise<void>(resolve => setTimeout(resolve, 120))
    expect(reopened.adapter.requests.length).toBe(0)

    // Coverage item 6: one new live event still advances the child's own state,
    // from its OWN base, with a window entirely above the boundary.
    const beforeRevision = stableOf(reopened, resumedChild).revision
    const liveTurn = appendTurn(resumedChild, 3, 'child live turn two')
    await waitUntil(
      () => (reopened.ctx.taskState.getStable(CHILD_ID)?.revision ?? 0) > beforeRevision,
      8_000,
      'child live revision',
    )
    await waitForDrained(reopened, resumedChild)
    const advanced = stableOf(reopened, resumedChild)
    const advancedRows = rowsFor(reopened, resumedChild)
    expect(advanced.revision).toBe(beforeRevision + 1)
    expect(advanced.sourceCursor).toBeGreaterThanOrEqual(liveTurn[1]!)
    expect(windowsAbove(advancedRows, cut)).toBe(true)
    const request = await openRequest(reopened, resumedChild, advanced.revision)
    expect(request.base?.digest).toBe(childStable.digest)
    expect([...request.includedSeqs].map(Number).every(seq => seq >= cut)).toBe(true)
    expect(request.inherited?.ownBoundarySeq).toBe(cut)
    expect(advanced.inherited?.ownBoundarySeq).toBe(cut)
    // The parent lifecycle is untouched by the child's live event.
    expect(stableOf(reopened, resumedParent).digest).toBe(parentStable.digest)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 7 · slot ownership
// ---------------------------------------------------------------------------

describe('B7 · child 从自己的日志重建 slot，不共享 parent slot（覆盖 7）', () => {
  it('归属只由 durable (sessionId, lifecycleCreatedAt) 决定：内容相同的继承节点也不是自己的', async () => {
    const root = await newRoot('slot-ownership')
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(), prompt: true })
    const parent = createParent(mounted)
    appendTurn(parent, 1, 'parent turn one')
    await waitForDrained(mounted, parent)
    await runStep(mounted, parent, 1, 1)
    const parentNode = slotNodes(parent)[0]!

    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)

    // The inherited node is the parent's, in both directions.
    expect(isOwnSlotNode(parent, parentNode.source)).toBe(true)
    expect(isOwnSlotNode(child, parentNode.source)).toBe(false)
    // A node whose CONTENT identity is unchanged but whose lifecycle differs (the
    // exact shape the adopt rule must never accept) is still not this child's:
    // the child reached the same revision/digest/text, yet the parent wrote it.
    expect(isOwnSlotNode(child, {
      sessionId: parentNode.source.sessionId,
      lifecycleCreatedAt: parentNode.source.lifecycleCreatedAt,
    })).toBe(false)
    expect(isOwnSlotNode(child, {
      sessionId: String(CHILD_ID),
      lifecycleCreatedAt: CREATED_AT,
    })).toBe(false)
    expect(isOwnSlotNode(child, {
      sessionId: String(CHILD_ID),
      lifecycleCreatedAt: child.header.createdAt,
    })).toBe(true)
    expect(isOwnSlotNode(parent, {
      sessionId: parentNode.source.sessionId,
      lifecycleCreatedAt: child.header.createdAt,
    })).toBe(false)
    // Same id, different epoch: a same-id lifecycle never inherits ownership.
    expect(isOwnSlotNode(parent, {
      sessionId: String(PARENT_ID),
      lifecycleCreatedAt: child.header.createdAt,
    })).toBe(false)
  }, 60_000)

  it('继承节点永不被 child 采纳；child 自己的节点由 child lifecycle 写出且 generation 严格递增', async () => {
    const root = await newRoot('slot')
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(), prompt: true })
    const parent = createParent(mounted)
    appendTurn(parent, 1, 'parent turn one')
    await waitForDrained(mounted, parent)

    // The parent owns its own slot node (written by the parent lifecycle).
    await runStep(mounted, parent, 1, 1)
    const parentNodes = slotNodes(parent)
    expect(parentNodes.length).toBe(1)
    const parentNode = parentNodes[0]!
    expect(parentNode.source.lifecycleCreatedAt).toBe(CREATED_AT)
    expect(parentNode.source.sessionId).toBe(String(PARENT_ID))
    expect(Number(parentNode.source.revision)).toBe(stableOf(mounted, parent).revision)

    // Seal one more turn so the fork boundary carries the parent's node.
    appendTurn(parent, 2, 'parent turn two')
    await waitForDrained(mounted, parent)
    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)

    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    expect(parentNode.seq).toBeLessThan(cut)

    // The inherited node is on the child's surface, but it is NOT the child's slot:
    // before its own commit the child writes nothing and adopts nothing.
    expect(visibleSlotNodes(child).map(node => node.seq)).toContain(parentNode.seq)
    await runStep(mounted, child, 2, 1)
    expect(slotNodes(child).length).toBe(1)
    expect(TaskStatePrompt.taskStateSlotDiagnostics(mounted.ctx)
      .some(entry => entry.sessionId === String(CHILD_ID))).toBe(false)
    expect(isOwnSlotNode(child, parentNode.source)).toBe(false)
    expect(isOwnSlotNode(parent, parentNode.source)).toBe(true)

    // The child's own live turn commits its own stable; its step then rebuilds the
    // slot from its OWN log.
    appendTurn(child, 3, 'child turn one')
    await waitForStable(mounted, CHILD_ID)
    await waitForDrained(mounted, child)
    const childStable = stableOf(mounted, child)
    await runStep(mounted, child, 3, 1)

    const own = slotNodes(child).filter(node => node.seq >= cut)
    expect(own.length).toBe(1)
    const ownNode = own[0]!
    expect(ownNode.source.lifecycleCreatedAt).toBe(child.header.createdAt)
    expect(ownNode.source.sessionId).toBe(String(CHILD_ID))
    expect(Number(ownNode.source.revision)).toBe(childStable.revision)
    expect(ownNode.source.digest).toBe(childStable.digest)
    expect(Number(ownNode.source.sourceCursor)).toBe(childStable.sourceCursor)
    // The ONE node it shadowed is the inherited parent node, recorded as provenance.
    expect([...ownNode.source.coveredSeqs].map(Number)).toEqual([parentNode.seq])
    expect(ownNode.source.previousRevision).toBe(parentNode.source.revision)
    expect(ownNode.source.previousGeneration).toBe(parentNode.source.generation)
    // Generation is monotone ACROSS the inherited prefix and never restarts.
    expect(Number(ownNode.source.generation)).toBe(Number(parentNode.source.generation) + 1)
    // Exactly one model-visible node survives.
    expect(visibleSlotNodes(child).map(node => node.seq)).toEqual([ownNode.seq])
    expect(isOwnSlotNode(child, ownNode.source)).toBe(true)

    // The child's own bookkeeping is its own lifecycle, never the parent's.
    const childDiagnostics = TaskStatePrompt.taskStateSlotDiagnostics(mounted.ctx)
      .filter(entry => entry.sessionId === String(CHILD_ID))
    expect(childDiagnostics.length).toBe(1)
    expect(childDiagnostics[0]!.lifecycleCreatedAt).toBe(child.header.createdAt)
    expect(childDiagnostics[0]!.slotSeq).toBe(ownNode.seq)
    // The parent's node and lifecycle are untouched by the child's rebuild.
    const parentAfter = slotNodes(parent)
    expect(parentAfter.length).toBe(1)
    expect(parentAfter[0]!.seq).toBe(parentNode.seq)
    expect(parentAfter[0]!.source.lifecycleCreatedAt).toBe(CREATED_AT)
    expect(isOwnSlotNode(parent, ownNode.source)).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 8 · compaction source index
// ---------------------------------------------------------------------------

describe('B7 · compaction source index 不把 inherited replacement 当 live source（覆盖 8）', () => {
  it('继承前缀里的 replacement 被标为 inherited：不放宽 reentry、只数自己的 completed turn', async () => {
    const root = await newRoot('source-index')
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const parent = createParent(mounted)

    // Parent: turn 1 carries one tool step and a REAL provenanced summary over it,
    // then turn 2 seals a completed turn AFTER that replacement.
    const toolTurn = appendToolTurn(parent, 1, 'b7-index-call', `${'i'.repeat(PRUNE_THRESHOLD + 40)} indexed output`, 'parent turn one runs a tool')
    const replacement = reduceWithSummary(parent, toolTurn.resultSeq, {
      start: toolTurn.callSeq,
      end: toolTurn.resultSeq,
    })
    appendTurn(parent, 2, 'parent turn two')

    const parentIndex = buildSurfaceSourceIndex(parent)
    expect(parentIndex.ownBoundarySeq).toBe(0)
    const parentEntry = parentIndex.entry(SessionSeq(replacement))
    expect(parentEntry.kind).toBe('tool-summary')
    expect(parentEntry.inherited).toBe(false)
    expect(parentEntry.completedTurnsAfter).toBe(1)
    expect(parentIndex.canCompactHistory(SessionSeq(replacement), 1, true)).toBe(true)
    expect(parentIndex.canCompactHistory(SessionSeq(replacement), 1)).toBe(true)

    // Fork: the very same replacement is now INHERITED by the child.
    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    const childIndex = buildSurfaceSourceIndex(child)
    expect(childIndex.ownBoundarySeq).toBe(cut)
    const inheritedEntry = childIndex.entry(SessionSeq(replacement))
    // It keeps the kind its own durable provenance states…
    expect(inheritedEntry.kind).toBe('tool-summary')
    expect([...(inheritedEntry.reduction?.coveredSeqs ?? [])].map(Number)).toEqual([toolTurn.resultSeq])
    // …but it is classified as INHERITED, and never as a live source of the child.
    expect(inheritedEntry.inherited).toBe(true)
    expect(childIndex.isOriginalToolResult(SessionSeq(replacement))).toBe(false)
    // The immediate-reentry waiver is for reductions THIS lifecycle produced.
    expect(childIndex.canCompactHistory(SessionSeq(replacement), 1, true)).toBe(false)
    // Only the CHILD's own completed turns age an inherited replacement: the
    // inherited prefix's turn/end must not count (it would be 2 before this fix).
    expect(inheritedEntry.completedTurnsAfter).toBe(0)

    // The child's own reduction in its OWN log is a live source again.
    const childToolTurn = appendToolTurn(child, 3, 'b7-index-child-call', `${'c'.repeat(PRUNE_THRESHOLD + 40)} child output`, 'child turn three runs a tool')
    const ownReplacement = reduceWithSummary(child, childToolTurn.resultSeq, {
      start: childToolTurn.callSeq,
      end: childToolTurn.resultSeq,
    })
    const ownIndex = buildSurfaceSourceIndex(child)
    const ownEntry = ownIndex.entry(SessionSeq(ownReplacement))
    expect(ownEntry.kind).toBe('tool-summary')
    expect(ownEntry.inherited).toBe(false)
    expect(ownIndex.canCompactHistory(SessionSeq(ownReplacement), 1, true)).toBe(true)
    // The inherited classification is unchanged by the child's own work, and the
    // inherited node is still never relaxed by the flag. It re-enters ONLY through
    // the child's OWN completed turn, which is why minReentryTurns 1 admits it and
    // 2 does not: the inherited prefix's own turn/end events never age it.
    expect(ownIndex.entry(SessionSeq(replacement)).inherited).toBe(true)
    expect(ownIndex.entry(SessionSeq(replacement)).completedTurnsAfter).toBe(1)
    expect(ownIndex.canCompactHistory(SessionSeq(replacement), 1, true)).toBe(true)
    expect(ownIndex.canCompactHistory(SessionSeq(replacement), 2, true)).toBe(false)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// fail closed · 覆盖声明落在 live 边界之内
// ---------------------------------------------------------------------------

describe('B7 · 落在 own-events 边界之内的覆盖声明被拒绝（fail closed）', () => {
  /** Build a forked child with its own committed stable, then close the process. */
  async function seedChild(root: string): Promise<{ cut: number; digest: string; ownEligible: number[] }> {
    const mounted = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const parent = createParent(mounted)
    appendTurn(parent, 1, 'parent turn one')
    await waitForDrained(mounted, parent)
    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
    const child = mounted.ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    appendTurn(child, 2, 'child turn one')
    await waitForDrained(mounted, child)
    const stable = stableOf(mounted, child)
    const ownEligible = eligibleSeqsAbove(child, cut - 1)
    expect(ownEligible.length).toBeGreaterThan(0)
    await closeProcess(mounted)
    return { cut, digest: stable.digest, ownEligible }
  }

  /** Mutate one stored child stable in the durable domain document. */
  async function mutateChildStable(
    root: string,
    mutate: (stable: Record<string, unknown>) => void,
  ): Promise<void> {
    const path = join(root, 'storage', DOMAIN_FILE)
    const doc = JSON.parse(await readFile(path, 'utf8')) as {
      tables: { sessions: Record<string, { stable?: Record<string, unknown> }> }
    }
    const record = doc.tables.sessions[String(CHILD_ID)]
    if (record?.stable === undefined) throw new Error('fixture: child record holds no stable')
    mutate(record.stable)
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  }

  it('记录的 sourceCursor 落在继承前缀里（且无 inherited 标记）时，下一个窗口仍从自己的边界开始', async () => {
    const root = await newRoot('failclosed-cursor')
    const seeded = await seedChild(root)
    // A pre-B7-shaped record: it claims coverage INSIDE the inherited prefix (seq
    // 1 is the prefix's own user message, well below the cut) and carries no
    // boundary marker at all.
    await mutateChildStable(root, stable => {
      stable['sourceCursor'] = 1
      delete stable['inherited']
    })

    const reopened = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const child = await resume(reopened, CHILD_ID)
    expect(Number(child.inheritedEventCount)).toBe(seeded.cut)
    appendTurn(child, 3, 'child live turn two')
    await waitUntil(
      () => (reopened.ctx.taskState.getStable(CHILD_ID)?.sourceCursor ?? -1) >= seeded.cut,
      8_000,
      'clamped child commit',
    )
    await waitForDrained(reopened, child)
    const rows = rowsFor(reopened, child)
    const included = windowSeqs(rows)
    // The refused coverage claim is replaced by the live boundary: across the
    // whole lifecycle — before and after the restart — the lowest seq this child
    // ever folded is its own first eligible event, never a prefix seq.
    expect(included.length).toBeGreaterThan(0)
    expect(Math.min(...included)).toBe(seeded.ownEligible[0])
    expect(windowsAbove(rows, seeded.cut)).toBe(true)
    expect(stableOf(reopened, child).sourceCursor).toBeGreaterThanOrEqual(seeded.cut)
    // The re-derived stable states the live boundary it was fenced by.
    expect(stableOf(reopened, child).inherited?.ownBoundarySeq).toBe(seeded.cut)
  }, 120_000)

  it('inherited 标记与 live 边界冲突时，覆盖声明整体被拒绝（重解析自己的事件，仍不碰继承前缀）', async () => {
    const root = await newRoot('failclosed-marker')
    const seeded = await seedChild(root)
    // A record whose stored cursor is ABOVE the cut (so a plain floor clamp would
    // adopt it: the child already folded its own tail before the restart) but
    // whose marker names a DIFFERENT boundary.
    await mutateChildStable(root, stable => {
      stable['inherited'] = {
        source: 'fork-prefix',
        ownBoundarySeq: 10,
        inheritedThroughSeq: 9,
        parentSession: String(PARENT_ID),
      }
    })

    const reopened = await mountComposition({ root, adapter: new ForkAdapter(), prompt: false })
    const child = await resume(reopened, CHILD_ID)
    expect(Number(child.inheritedEventCount)).toBe(seeded.cut)
    appendTurn(child, 3, 'child live turn two')
    await waitUntil(
      () => (reopened.ctx.taskState.getStable(CHILD_ID)?.revision ?? 0) > 1,
      8_000,
      'child re-derived commit',
    )
    await waitForDrained(reopened, child)
    const rows = rowsFor(reopened, child)
    const included = windowSeqs(rows)
    // The mismatched claim is refused wholesale: the child re-derives from its own
    // log above the live boundary instead of trusting the stored coverage, so the
    // lowest seq it folded is again its own first eligible event.
    expect(Math.min(...included)).toBe(seeded.ownEligible[0])
    expect(windowsAbove(rows, seeded.cut)).toBe(true)
    // The re-derived stable is a NEW one over the child's own events only.
    expect(stableOf(reopened, child).digest).not.toBe(seeded.digest)
    expect(stableOf(reopened, child).inherited?.ownBoundarySeq).toBe(seeded.cut)
  }, 120_000)
})
