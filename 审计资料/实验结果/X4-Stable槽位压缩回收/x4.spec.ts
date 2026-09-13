/**
 * X4 · Stable 固定槽位被真实压缩遮蔽后的回收与重建
 *
 * 实验问题（唯一）
 * ----------------
 * B5.1 已证明 fixed-slot 在无压缩介入时每个 step 可见槽位恒为 1。
 * X4 要验证：当真实 BasicCompactionEngine 在真实边界把 slot 节点选入 span
 * 并通过 semantic summary replacement 覆盖后，下一合法 pre-step 能否发现 slot
 * 不在 surface 并安全重建一个新 generation 的 slot？连续 ≥3 轮"遮蔽→重建"
 * 后以下不变量是否仍然成立：
 *   1. 可见 slot = 1（每轮重建后）
 *   2. generation 严格递增
 *   3. source-index 把重建 slot 分类为 `task-state-slot`
 *   4. injection tokens 不随循环数线性累积
 *   5. compaction replacement 不把 slot 文本自反馈进 history summary
 *   6. retained tail / tool pairing 未被破坏
 *
 * 判定规则（运行前固定）
 * ----------------------
 *   routeWorked  := engine 可用（真实挂载的 BasicCompactionEngine 实例）
 *                   且 至少一次真实 compaction 调用返回可观测结果
 *                   （result ≠ null、span 非空、surface 上出现 replacement 事件、
 *                     被遮蔽 span 确实包含当时可见的 slot、且调用后 slot 不再可见）
 *   completeCycle := 该 cycle 的 compaction 是 observed，且下一合法 pre-step
 *                     真实重建出恰好 1 个可见 slot（generation 大于被遮蔽的那个）
 *   fixed         := routeWorked 且 completeCycle ≥ 3 且全部不变量成立
 *   still-reproduced := routeWorked 且 evidence 充分（≥3 个 completeCycle 所需条件已具备）
 *                       但不变量被破坏
 *   inconclusive  := routeWorked 为假，或 completeCycle < 3（fixture / route / compaction
 *                       未能产出足够证据；此分支不声称任何结论，0 cycle 永不 fixed）
 *
 * REAL in this spec
 * -----------------
 * - REAL `TaskStateBasicService`（调度/折叠/校验/权威 put/audit）
 * - REAL `dsh-context-enhancement/task-state-prompt` 消费者（slot 维护）
 * - REAL `BasicCompactionEngine`（本 bundle 的压缩后端，`auto: false`，显式插件挂载）
 * - REAL 持久化 storage domain（落在本目录 tmp-storage/ 内）
 * - REAL `SessionStore` / `SystemPrompt` / `LlmRuntime` / `TokenMeter` /
 *   `SessionProjectionRegistry` / `ToolRuntime` / `AgentRegistry`
 * - REAL DSH `AgentLoop`（从被审计 checkout a66e4702 以原生 ESM import() 载入）
 * - REAL `agent/pre-step` waterfall、REAL token meter 定价、REAL 区域选择
 *   （`selectCompactableRange`）、REAL 摘要替换事务。
 *
 * FAKE in this spec
 * -----------------
 * - 唯一 LLM 是脚本化 adapter，不产出 provider usage；token 数字来自真实 token-meter
 *   的固定启发式定价（fixture token，不冒充 provider token）。
 * - 该 adapter 声明一个 fixture context capacity（`context.contextWindow`），
 *   这是 adapter 拥有的元数据，不是 provider 事实。
 * - compaction 通过 `compactNow` 触发（官方 manual / idle-session 路径），
 *   而非等待自动压力触发；`auto: false` 使自动路径完全不参与。
 *
 * attempt 2 修复说明（不得丢失 attempt-1 证据）
 * --------------------------------------------
 * attempt-1 的 COMPACTION_CONFIG 携带了一个 schema 不存在的键
 * `contextWindowOverride`。`resolveConfig` 的严格键检查抛出
 * `BasicCompactionConfig: unknown key "contextWindowOverride"`，而 fixture 用
 * `catch { /* ignore *\/ }` 吞掉了它 —— engine 从未挂载，`ctx.get('compaction')`
 * 返回 undefined，fixture 走进 "Compaction engine not available" 分支，0 cycle。
 * attempt-2：(a) 删除非法键并把 context capacity 交给 adapter 的 `resolveModel`
 * 声明；(b) 挂载失败不再被吞掉，错误原文写入 ledger 与 errors；
 * (c) `routeWorked` 改为“engine 可用 且 ≥1 次真实 compaction 有可观测结果”。
 *
 * 本 spec 不修改任何生产源码 / tests / package / lib / tgz / 历史实验目录。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../../../src/task-state-basic.ts'
import type { TaskStateBasicConfig } from '../../../src/task-state.ts'
import * as TaskStatePrompt from '../../../src/task-state-prompt.ts'
import { BasicCompactionEngine } from '../../../src/compaction-basic.ts'
import type { BasicCompactionConfig } from '../../../src/compaction-basic.ts'
import { buildSurfaceSourceIndex } from '../../../src/internal/compaction/source-index.ts'
import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '../../../src/internal/compaction/tool-pairing.ts'
import { selectCompactableRange } from '../../../src/internal/compaction/region.ts'

// ---------------------------------------------------------------------------
// 固定实验常量
// ---------------------------------------------------------------------------

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')
const LEDGER_PATH = join(OUT_DIR, 'x4-ledger.json')
const RESULT_PATH = join(OUT_DIR, 'result.json')
const HASHES_PATH = join(OUT_DIR, 'hashes.json')

const SESSION_ID = SessionId('x4-compaction-slot-rebuild')

/** 部署 route（presets/contextual + cordis.patch.yml）。 */
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

/** 部署 `task-state-basic` 配置（cordis.patch.yml，host plane）。 */
const CONFIG: TaskStateBasicConfig = {
  provider: PROVIDER,
  model: MODEL,
  minEvents: 20,
  maxEvents: 200,
  maxInputBytes: 60_000,
  maxOutputTokens: 4_000,
  timeoutMs: 120_000,
  maxInfraRetries: 2,
  maxEntriesPerKind: 50,
  maxEntryBytes: 4_000,
  maxListItems: 40,
}

/** 部署 `task-state-prompt` 字节预算（presets/contextual）。 */
const PROMPT_MAX_BYTES = 8_000

/**
 * fixture 的 model context capacity，由 fake adapter 的 `resolveModel` 声明。
 * 它 NOT 是 compaction 插件配置键（`BasicCompactionConfig` 没有该键）。
 */
const MODEL_CONTEXT_WINDOW = 4_000

/**
 * 压缩引擎配置：auto=false 以便本 spec 手动控制触发时机；
 * toolGroupSummarizer 关闭避免 tool-group 路径干扰。
 * 注意：这里只能出现 `BasicCompactionConfig` 真实存在的键
 * （见 `src/internal/compaction/config.ts` 的 `BASIC_COMPACT_CONFIG_KEYS`）。
 */
const COMPACTION_CONFIG: BasicCompactionConfig = {
  auto: false,
  toolGroupSummarizer: { enabled: false },
  minReentryTurns: 1,
  maxMaintenanceBatches: 1,
  maxPressureBatches: 2,
  targetBatchTokens: 800,
  maxBatchTokens: 1_200,
}

/** 内容不同的 Stable revision 循环数（验收：≥3）。 */
const CYCLE_COUNT = 4
/** 每个 cycle 在 compaction 前追加的合格人类事件数（跨过 minEvents=20 阈值）。 */
const SEEDS_PER_CYCLE = 20
/** 每个 cycle 额外跑的 step 数（让 slot 后面有真实 dialogue 尾巴）。 */
const WARMUP_STEPS_PER_CYCLE = 2

/** 被审计的 DSH checkout（固定基线 HEAD a66e4702）。 */
const DSH_ROOT = 'C:\\Users\\chuxi\\Documents\\trae_projects\\code\\deepseek-harness'
const AGENT_LOOP_LIB = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'lib', 'index.js')
const AGENT_LOOP_SRC_DIR = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'src')

/** 本插件 slot 节点的来源标识（来自生产 contract）。 */
const SLOT_SOURCE_KIND = TaskStatePrompt.TASK_STATE_SLOT_SOURCE_KIND
/** DSH 自己写 runtime-context 快照时使用的来源标识。 */
const SNAPSHOT_SOURCE_PLUGIN = '@deepseek-ai/dsh-system-prompt'
/** 插件 renderer 为每个 revision 写出的 header（用于 slot 自反馈检测）。 */
const HEADER_RE = /Durable task state \(revision \d+, source event \d+, digest [0-9a-f]+\)/u
const COMMIT_DEADLINE_MS = 20_000
const STEP_DEADLINE_MS = 30_000
const TEST_TIMEOUT_MS = 600_000
/** 注入 token 平坦判定容差。 */
const FLAT_TOKEN_TOLERANCE_ABS = 24
const FLAT_TOKEN_TOLERANCE_RATIO = 0.10

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function bytesOf(text: string): number { return encoder.encode(text).byteLength }
function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }
function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { readonly cause?: unknown }).cause
    return cause === undefined
      ? `${error.name}: ${error.message}`
      : `${error.name}: ${error.message} ← ${errorText(cause)}`
  }
  return String(error)
}
function dshHead(): string | null {
  try {
    const head = readFileSync(join(DSH_ROOT, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return head
    return readFileSync(join(DSH_ROOT, '.git', head.slice(4).trim()), 'utf8').trim()
  } catch { return null }
}
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 5): Promise<boolean> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
  return true
}
function messageText(message: unknown): string {
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { readonly type: string; readonly text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text).join('')
}
function messageSource(message: unknown): Record<string, unknown> | undefined {
  const source = (message as { readonly source?: unknown }).source
  return typeof source === 'object' && source !== null ? source as Record<string, unknown> : undefined
}
function isDshSnapshotMessage(message: unknown): boolean {
  const source = messageSource(message)
  return source?.['kind'] === 'plugin' && source['plugin'] === SNAPSHOT_SOURCE_PLUGIN
}

// ---------------------------------------------------------------------------
// 唯一 LLM：脚本化 fake adapter
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly index: number
  readonly kind: 'task-state' | 'agent-loop' | 'compaction'
  readonly purpose: string | null
  readonly messageCount: number
  readonly slotMessageCount: number
  readonly dshSnapshotMessageCount: number
  readonly totalTextBytes: number
  readonly systemBytes: number
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: RecordedRequest[] = []
  private taskStateCalls = 0
  private compactionCalls = 0
  /** 本 adapter 声明的 context capacity（fixture 元数据，不是 provider 事实）。 */
  readonly contextWindow = MODEL_CONTEXT_WINDOW

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = (options as { readonly purpose?: unknown }).purpose as string | undefined
    const kind: RecordedRequest['kind'] = purpose === 'task-state' ? 'task-state'
      : purpose === 'compaction' ? 'compaction' : 'agent-loop'
    const messages = (options.messages ?? []) as readonly unknown[]
    const inputText = messages.map(messageText).join('')
    const systemText = typeof (options as { readonly system?: unknown }).system === 'string'
      ? String((options as { readonly system?: unknown }).system) : ''

    if (kind === 'task-state') this.taskStateCalls += 1
    else if (kind === 'compaction') this.compactionCalls += 1

    const text = kind === 'task-state'
      ? this.candidateFor(inputText)
      : kind === 'compaction'
        ? `## Compaction checkpoint ${this.compactionCalls}: summary of earlier conversation.\n${'c'.repeat(200)}`
        : `X4 assistant reply ${this.requests.filter(row => row.kind === 'agent-loop').length + 1}: no tool call, the turn ends.`

    const slotViews = (messages as readonly { readonly source?: { readonly kind?: unknown } }[])
      .filter(m => m.source?.kind === SLOT_SOURCE_KIND)
    const dshViews = (messages as readonly unknown[]).filter(isDshSnapshotMessage)

    this.requests.push({
      index: this.requests.length,
      kind,
      purpose: purpose ?? null,
      messageCount: messages.length,
      slotMessageCount: slotViews.length,
      dshSnapshotMessageCount: dshViews.length,
      totalTextBytes: bytesOf(inputText),
      systemBytes: bytesOf(systemText),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private candidateFor(inputText: string): string {
    const seqs = [...inputText.matchAll(/"seq":\s*(\d+)/gu)].map(match => Number(match[1]))
    const maxSeq = seqs.length === 0 ? -1 : Math.max(...seqs)
    this.taskStateCalls += 1
    const marker = `X4-CALL-${this.taskStateCalls}-THROUGH-SEQ-${maxSeq}`
    return JSON.stringify({
      facts: [
        { content: `X4 durable marker ${marker}: the folded window ended at session event ${maxSeq}.` },
        { content: `X4 padding ${marker}: ${'p'.repeat(160)}` },
      ],
      decisions: [{ content: `X4 decision ${marker}` }],
      constraints: [],
      risks: [],
      evidence: [],
      continuation: {
        currentObjective: `X4 objective ${marker}`,
        currentFocus: `X4 focus ${marker}`,
        openWork: [],
        nextActions: [],
      },
    })
  }

  agentRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'agent-loop')
  }
  taskStateRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'task-state')
  }
  compactionRequests(): readonly RecordedRequest[] {
    return this.requests.filter(row => row.kind === 'compaction')
  }
  lastAgentRequest(): RecordedRequest | null {
    const rows = this.agentRequests()
    return rows.length === 0 ? null : rows[rows.length - 1]!
  }
}

// ---------------------------------------------------------------------------
// Session / surface 观测
// ---------------------------------------------------------------------------

function appendUser(session: Session, text: string): number {
  return Number(session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq)
}

interface SlotNodeView {
  readonly seq: number
  readonly visibleOnSurface: boolean
  readonly surfaceOp: string
  readonly generation: number | null
  readonly revision: number | null
  readonly previousRevision: number | null
  readonly previousGeneration: number | null
  readonly coveredSeqs: readonly number[]
  readonly sourceEventSeqs: readonly number[]
  readonly bytes: number
  readonly textHash: string
  readonly textChars: number
  /** 真实 token-meter 定价（fixture 启发式，不是 provider token）。 */
  readonly tokens: number | null
  /** renderer header 是否出现在该 slot 文本里（自反馈检测用）。 */
  readonly hasHeader: boolean
}

interface SurfaceSnapshot {
  readonly surfaceNodes: number
  readonly surfaceSeqs: readonly number[]
  readonly replaceGeneration: number
  readonly logEvents: number
  readonly surfaceTokens: number
  readonly totalTokens: number
  readonly slotsInLog: number
  readonly visibleSlotCount: number
  readonly visibleSlot: SlotNodeView | null
  readonly slotGenerationsInLog: readonly (number | null)[]
}

/**
 * 全部 slot 节点（含已被遮蔽的历史节点）+ 真实 token-meter 定价。
 * token 定价来自 `ctx.tokenMeter.measure()`，只对仍在 surface 上的节点有值。
 */
function slotNodes(session: Session, ctx: Context | undefined): SlotNodeView[] {
  const onSurface = new Set(session.surface.nodes.map(node => Number(node)))
  let priced = new Map<number, number>()
  if (ctx !== undefined) {
    try {
      const measurement = ctx.tokenMeter.measure(session)
      priced = new Map(measurement.nodes.map(node => [Number(node.seq), Number(node.tokens)]))
    } catch { priced = new Map() }
  }
  const out: SlotNodeView[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { readonly source?: Record<string, unknown> }).source
    if (source?.['kind'] !== SLOT_SOURCE_KIND) continue
    const text = messageText(event.data)
    const op = (event as { readonly surfaceOp?: unknown }).surfaceOp
    out.push({
      seq: Number(event.seq),
      visibleOnSurface: onSurface.has(Number(event.seq)),
      surfaceOp: op === undefined ? 'undefined' : typeof op === 'string' ? op : 'replace',
      generation: typeof source['generation'] === 'number' ? Number(source['generation']) : null,
      revision: typeof source['revision'] === 'number' ? Number(source['revision']) : null,
      previousRevision: typeof source['previousRevision'] === 'number' ? Number(source['previousRevision']) : null,
      previousGeneration: typeof source['previousGeneration'] === 'number' ? Number(source['previousGeneration']) : null,
      coveredSeqs: ((source['coveredSeqs'] as readonly unknown[] | undefined) ?? []).map(Number),
      sourceEventSeqs: ((event as { readonly sourceEventSeqs?: readonly unknown[] }).sourceEventSeqs ?? []).map(Number),
      bytes: bytesOf(text),
      textHash: sha256(text).slice(0, 16),
      textChars: text.length,
      tokens: priced.get(Number(event.seq)) ?? null,
      hasHeader: HEADER_RE.test(text),
    })
  }
  return out
}

function surfaceSnapshot(session: Session, ctx: Context | undefined): SurfaceSnapshot {
  let surfaceTokens = -1
  let totalTokens = -1
  let measured: readonly { readonly seq: unknown; readonly tokens: unknown }[] = []
  if (ctx !== undefined) {
    try {
      const measurement = ctx.tokenMeter.measure(session)
      surfaceTokens = Number(measurement.surfaceTokens)
      totalTokens = Number(measurement.totalTokens)
      measured = measurement.nodes as never
    } catch { /* 记录 -1 表示无法测量 */ }
  }
  void measured
  const slots = slotNodes(session, ctx)
  const visible = slots.filter(node => node.visibleOnSurface)
  return {
    surfaceNodes: session.surface.nodes.length,
    surfaceSeqs: session.surface.nodes.map(Number),
    replaceGeneration: session.surface.replaceGeneration,
    logEvents: session.snapshotEvents().length,
    surfaceTokens,
    totalTokens,
    slotsInLog: slots.length,
    visibleSlotCount: visible.length,
    visibleSlot: visible.length === 1 ? visible[0]! : null,
    slotGenerationsInLog: slots.map(node => node.generation),
  }
}

interface ReplacementView {
  readonly seq: number
  readonly type: string
  readonly start: number
  readonly end: number
  readonly sourceEventSeqs: readonly number[]
  readonly isHistorySummary: boolean
  readonly bytes: number
  readonly textHash: string
  readonly containsSlotHeader: boolean
  readonly containsSlotTextHash: string | null
}

/** 在给定 seq 之后出现的 surface replacement 事件（真实 surface 关系）。 */
function replacementEventsAfter(session: Session, afterSeq: number): ReplacementView[] {
  const out: ReplacementView[] = []
  for (const event of session.snapshotEvents()) {
    if (Number(event.seq) <= afterSeq) continue
    const op = (event as { readonly surfaceOp?: unknown }).surfaceOp
    if (op === undefined || typeof op === 'string') continue
    const record = op as { readonly op?: unknown; readonly start?: unknown; readonly end?: unknown }
    if (record.op !== 'replace') continue
    const text = messageText(event.data)
    const source = (event.data as { readonly source?: Record<string, unknown> }).source
    out.push({
      seq: Number(event.seq),
      type: String(event.type),
      start: Number(record.start),
      end: Number(record.end),
      sourceEventSeqs: ((event as { readonly sourceEventSeqs?: readonly unknown[] }).sourceEventSeqs ?? []).map(Number),
      isHistorySummary: event.type === 'user/message' && source?.['kind'] === 'plugin',
      bytes: bytesOf(text),
      textHash: sha256(text).slice(0, 16),
      containsSlotHeader: HEADER_RE.test(text),
      containsSlotTextHash: null,
    })
  }
  return out
}

function dshSnapshotNodes(session: Session): Record<string, unknown>[] {
  const onSurface = new Set(session.surface.nodes.map(node => Number(node)))
  const out: Record<string, unknown>[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const data = event.data as { readonly content?: unknown; readonly source?: unknown }
    const source = data.source as { readonly kind?: unknown; readonly plugin?: unknown } | undefined
    if (source?.kind !== 'plugin' || source.plugin !== SNAPSHOT_SOURCE_PLUGIN) continue
    out.push({
      seq: Number(event.seq),
      visibleOnSurface: onSurface.has(Number(event.seq)),
      surfaceOp: (event as { readonly surfaceOp?: unknown }).surfaceOp ?? null,
      bytes: bytesOf(messageText({ content: data.content })),
    })
  }
  return out
}

interface StoreView {
  readonly read: boolean
  readonly domainFile: string
  readonly domainFileBytes: number | null
  readonly stableRecordCountForSession: number | null
  readonly stableRevision: number | null
  readonly auditRowCount: number | null
}

function domainFilePath(): string {
  const fallback = join(STORAGE_ROOT, 'context_enhancement_task_state_v2.json')
  try {
    const found = readdirSync(STORAGE_ROOT)
      .filter(name => name.startsWith('context_enhancement_task_state') && name.endsWith('.json'))
      .sort()
    return found.length === 0 ? fallback : join(STORAGE_ROOT, found[found.length - 1]!)
  } catch { return fallback }
}

function readStore(): StoreView {
  const domainFile = domainFilePath()
  let raw: string
  try { raw = readFileSync(domainFile, 'utf8') } catch {
    return { read: false, domainFile: relative(process.cwd(), domainFile), domainFileBytes: null,
      stableRecordCountForSession: null, stableRevision: null, auditRowCount: null }
  }
  const doc = JSON.parse(raw) as {
    readonly tables?: {
      readonly sessions?: Record<string, { readonly stable?: { readonly revision?: number } }>
      readonly audit?: Record<string, unknown>
    }
  }
  const sessions = doc.tables?.sessions ?? {}
  const record = sessions[String(SESSION_ID)]
  const stable = record?.stable
  return {
    read: true,
    domainFile: relative(process.cwd(), domainFile),
    domainFileBytes: statSync(domainFile).size,
    stableRecordCountForSession: Object.values(sessions).filter(e => e.stable !== undefined).length,
    stableRevision: stable?.revision === undefined ? null : Number(stable.revision),
    auditRowCount: Object.keys(doc.tables?.audit ?? {}).length,
  }
}

// ---------------------------------------------------------------------------
// 装配（真实插件挂载）
// ---------------------------------------------------------------------------

interface EngineMount {
  readonly module: string
  readonly config: BasicCompactionConfig
  readonly mounted: boolean
  readonly serviceName: string
  readonly constructorName: string | null
  readonly isBasicCompactionEngine: boolean
  readonly pluginError: string | null
  readonly fiberState: number | null
}

interface Composition {
  readonly ctx: Context
  readonly adapter: RecordingAdapter
  readonly engine: BasicCompactionEngine | undefined
  readonly engineMount: EngineMount
  readonly services: Record<string, boolean>
}

async function mountComposition(AgentLoop: unknown): Promise<Composition> {
  const ctx = new Context()
  const adapter = new RecordingAdapter()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // 真实挂载：BasicCompactionEngine 作为 cordis 插件提供 `ctx.compaction`。
  // 挂载错误绝不被吞掉 —— 它必须进入 ledger 的 errors。
  // 注意：`ctx.plugin()` 返回的是 thenable fiber（没有 `.catch`），因此只能用
  // try/catch 包住 `await`。
  let pluginError: string | null = null
  let fiberState: number | null = null
  let fiber: unknown = null
  try {
    fiber = await ctx.plugin(BasicCompactionEngine, COMPACTION_CONFIG)
  } catch (error: unknown) {
    pluginError = errorText(error)
  }
  if (fiber !== null) fiberState = Number((fiber as unknown as { readonly state?: unknown }).state ?? -1)

  await ctx.plugin(TaskStateBasicService, CONFIG)
  await ctx.plugin(TaskStatePrompt, { maxBytes: PROMPT_MAX_BYTES })
  if (AgentLoop !== null) await ctx.plugin(AgentLoop as never, { agents: [] })

  const service = ctx.get('compaction') as BasicCompactionEngine | undefined
  const probe = (name: string): boolean => {
    try { return ctx.get(name as never) !== undefined } catch { return false }
  }
  const engineMount: EngineMount = {
    module: 'src/compaction-basic.ts',
    config: COMPACTION_CONFIG,
    mounted: service !== undefined,
    serviceName: 'compaction',
    constructorName: service === undefined
      ? null
      : (service as unknown as { constructor?: { name?: string } }).constructor?.name ?? null,
    isBasicCompactionEngine: service !== undefined && service instanceof BasicCompactionEngine,
    pluginError,
    fiberState,
  }
  return {
    ctx,
    adapter,
    engine: service,
    engineMount,
    services: {
      llm: probe('llm'),
      sessions: probe('sessions'),
      tokenMeter: probe('tokenMeter'),
      storageDomain: probe('storageDomain'),
      taskState: probe('taskState'),
      agentLoop: probe('agentLoop'),
      compaction: service !== undefined,
    },
  }
}

/** 等待 agent 回到 idle（真实 `agent/status` 事件；payload 由 agentEvents 注入 agent）。 */
function waitForIdle(ctx: Context, agent: { readonly status: string }, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`agent did not return to idle within ${timeoutMs} ms (status ${agent.status})`))
    }, timeoutMs)
    const dispose = ctx.on('agent/status', (payload: { readonly agent?: unknown; readonly status?: unknown }) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      clearTimeout(timer); dispose(); resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// 实验
// ---------------------------------------------------------------------------

describe('X4 · Stable 固定槽位压缩遮蔽回收', () => {
  it('连续 4 轮真实压缩遮蔽→真实 pre-step 重建：可见 slot 恒=1、generation 严格递增、source-index 分类正确', async () => {
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })

    const errors: { stage: string; message: string }[] = []
    const recordError = (stage: string, error: unknown): void => {
      errors.push({ stage, message: errorText(error) })
    }

    // ---- phase 0: DSH AgentLoop -----------------------------------------
    const agentLoopModule = {
      path: AGENT_LOOP_LIB,
      sha256: sha256File(AGENT_LOOP_LIB),
      srcHashes: {
        'agent.ts': sha256File(join(AGENT_LOOP_SRC_DIR, 'agent.ts')),
        'runtime-context.ts': sha256File(join(AGENT_LOOP_SRC_DIR, 'runtime-context.ts')),
      },
      dshHead: dshHead(),
      imported: false,
      mountError: null as string | null,
    }
    let AgentLoop: unknown = null
    try {
      const loaded = await import(/* @vite-ignore */ pathToFileURL(AGENT_LOOP_LIB).href) as { default?: unknown }
      AgentLoop = loaded.default ?? null
      agentLoopModule.imported = AgentLoop !== null
    } catch (error: unknown) {
      agentLoopModule.mountError = errorText(error)
    }

    // ---- phase 1: 装配 --------------------------------------------------
    let composition: Composition | null = null
    try {
      composition = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    } catch (error: unknown) {
      recordError('mount', error)
    }

    const cycles: Record<string, unknown>[] = []
    let surfaceRoute = { available: false, reason: 'not attempted', agentId: String(SESSION_ID) }
    let engineMount: EngineMount = {
      module: 'src/compaction-basic.ts', config: COMPACTION_CONFIG, mounted: false,
      serviceName: 'compaction', constructorName: null, isBasicCompactionEngine: false,
      pluginError: null, fiberState: null,
    }
    let services: Record<string, boolean> = {}
    let engineAvailable = false
    let agentIdString = String(SESSION_ID)
    let storeQuiesced = false

    if (composition !== null) {
      engineMount = composition.engineMount
      services = composition.services
      if (engineMount.pluginError !== null) recordError('mount.compaction', new Error(engineMount.pluginError))

      const { ctx, adapter, engine } = composition
      engineAvailable = engine !== undefined && engineMount.isBasicCompactionEngine

      if (engineAvailable) {
        try {
          const loop = (ctx as unknown as {
            readonly agentLoop: { create: (id: SessionId, options: Record<string, unknown>) => unknown }
          }).agentLoop
          if (loop === undefined) throw new Error('ctx.agentLoop is not available')
          const agent = loop.create(SESSION_ID, { provider: PROVIDER, model: MODEL }) as {
            readonly session: Session
            readonly status: string
            readonly id: unknown
            followup: (message: unknown) => void
          }
          const session = agent.session
          agentIdString = String(agent.id ?? SESSION_ID)
          surfaceRoute = {
            available: true,
            reason: `AgentLoop + BasicCompactionEngine mounted (${engineMount.constructorName}, auto=false)`,
            agentId: agentIdString,
          }

          /** 跑一个真实 turn（真实 pre-step waterfall + 真实模型请求）。 */
          const runStep = async (label: string): Promise<Record<string, unknown>> => {
            const requestsBefore = adapter.agentRequests().length
            const idle = waitForIdle(ctx, agent, STEP_DEADLINE_MS)
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: label }],
              source: { kind: 'user' },
            }))
            let stepError: string | null = null
            try { await idle } catch (error: unknown) {
              stepError = errorText(error)
              recordError(`${label}.step`, error)
            }
            const request = adapter.agentRequests().length > requestsBefore
              ? adapter.agentRequests()[adapter.agentRequests().length - 1]!
              : null
            const snapshot = surfaceSnapshot(session, ctx)
            return {
              label,
              error: stepError,
              requestIndex: request === null ? null : request.index,
              requestMessageCount: request === null ? null : request.messageCount,
              requestSlotMessageCount: request === null ? null : request.slotMessageCount,
              requestDshSnapshotMessageCount: request === null ? null : request.dshSnapshotMessageCount,
              requestTotalTextBytes: request === null ? null : request.totalTextBytes,
              surface: snapshot,
            }
          }

          for (let c = 1; c <= CYCLE_COUNT; c += 1) {
            const record: Record<string, unknown> = { cycle: c }
            const cycleErrorsBefore = errors.length

            // ---- 1. 追加合格人类事件并等待新 Stable revision --------------
            const stableBefore = ctx.taskState.getStable(SESSION_ID)
            const callsBefore = adapter.taskStateRequests().length
            const seedSeqs: number[] = []
            let seedBytes = 0
            for (let j = 1; j <= SEEDS_PER_CYCLE; j += 1) {
              const text = `X4 cycle ${c} seed ${j}: durable-content marker X4-C${c}-J${j}.`
              seedBytes += bytesOf(text)
              seedSeqs.push(appendUser(session, text))
            }
            const committed = await waitUntil(
              () => (ctx.taskState.getStable(SESSION_ID)?.revision ?? 0) > (stableBefore?.revision ?? 0),
              COMMIT_DEADLINE_MS,
            )
            if (!committed) recordError(`cycle${c}.commit`, new Error('no new stable revision within deadline'))
            const stableAfter = ctx.taskState.getStable(SESSION_ID)
            record['seeds'] = {
              count: seedSeqs.length,
              firstSeq: seedSeqs[0],
              lastSeq: seedSeqs[seedSeqs.length - 1],
              utf8Bytes: seedBytes,
            }
            record['stable'] = {
              beforeRevision: stableBefore?.revision ?? null,
              afterRevision: stableAfter?.revision ?? null,
              committed,
              sourceCursor: stableAfter?.sourceCursor ?? null,
              digest: stableAfter?.digest === undefined ? null : String(stableAfter.digest).slice(0, 16),
              taskStateLlmCalls: adapter.taskStateRequests().length - callsBefore,
              taskStateRequestCount: adapter.taskStateRequests().length,
            }

            // ---- 2. 真实 warmup steps：pre-step 真实创建/replace slot -----
            const warmupSteps: Record<string, unknown>[] = []
            for (let w = 1; w <= WARMUP_STEPS_PER_CYCLE; w += 1) {
              warmupSteps.push(await runStep(`X4 warmup ${c}.${w}`))
            }
            record['warmupSteps'] = warmupSteps

            // ---- 3. before 快照 -------------------------------------------
            const before = surfaceSnapshot(session, ctx)
            const beforeLogSeq = session.seq - 1
            const beforeVisibleSlot = before.visibleSlot
            const beforeRequests = adapter.agentRequests().length
            const beforeCompactionRequests = adapter.compactionRequests().length
            record['before'] = before

            // ---- 4. 真实 compaction（manual compactNow，idle-session 路径）-
            let compactionResult: Record<string, unknown>
            if (beforeVisibleSlot === null) {
              compactionResult = {
                attempted: false,
                reason: 'no visible slot before compaction; the cycle cannot witness shadowing',
              }
            } else {
              const planned = (() => {
                try {
                  return selectCompactableRange(session, ctx.tokenMeter.measure(session), 0)
                } catch (error: unknown) { return { error: errorText(error) } }
              })()
              const plannedRange = planned !== null && 'start' in (planned as object)
                ? { start: Number((planned as { start: unknown }).start), end: Number((planned as { end: unknown }).end) }
                : null
              try {
                const result = await engine.compactNow(agent as never, new AbortController().signal)
                const after = surfaceSnapshot(session, ctx)
                const replacements = replacementEventsAfter(session, beforeLogSeq)
                const replacement = replacements.length === 0 ? null : replacements[replacements.length - 1]!
                const shadowedSeqs = result === null
                  ? []
                  : ((result as { readonly shadowedSeqs?: readonly unknown[] }).shadowedSeqs ?? []).map(Number)
                const range = result === null
                  ? null
                  : (result as { readonly shadowedRange?: { readonly start?: unknown; readonly end?: unknown } }).shadowedRange
                const slotTextHash = beforeVisibleSlot.textHash
                compactionResult = {
                  attempted: true,
                  error: null,
                  returned: result !== null,
                  plannedRange,
                  plannedRangeContainsSlot: plannedRange !== null
                    && beforeVisibleSlot.seq >= plannedRange.start
                    && beforeVisibleSlot.seq <= plannedRange.end,
                  shadowedSeqCount: shadowedSeqs.length,
                  shadowedSeqs: shadowedSeqs.slice(0, 40),
                  shadowedRange: range === null ? null : { start: Number(range.start), end: Number(range.end) },
                  shadowedTokenCount: result === null
                    ? null : Number((result as { readonly shadowedTokenCount?: unknown }).shadowedTokenCount ?? -1),
                  slotSeqShadowed: shadowedSeqs.includes(beforeVisibleSlot.seq),
                  replacementSeq: replacement === null ? null : replacement.seq,
                  replacementType: replacement === null ? null : replacement.type,
                  replacementSurfaceOp: replacement === null ? null : { op: 'replace', start: replacement.start, end: replacement.end },
                  replacementSourceEventSeqs: replacement === null ? null : replacement.sourceEventSeqs,
                  replacementCitesSlot: replacement === null
                    ? null : replacement.sourceEventSeqs.includes(beforeVisibleSlot.seq),
                  replacementIsHistorySummary: replacement === null ? null : replacement.isHistorySummary,
                  replacementBytes: replacement === null ? null : replacement.bytes,
                  replacementTextHash: replacement === null ? null : replacement.textHash,
                  replacementContainsSlotHeader: replacement === null ? null : replacement.containsSlotHeader,
                  replacementCount: replacements.length,
                  surfaceGenerationBefore: before.replaceGeneration,
                  surfaceGenerationAfter: after.replaceGeneration,
                  surfaceNodesBefore: before.surfaceNodes,
                  surfaceNodesAfter: after.surfaceNodes,
                  slotVisibleBeforeCompaction: before.visibleSlotCount,
                  slotVisibleAfterCompaction: after.visibleSlotCount,
                  slotSeqAfterCompaction: after.visibleSlot?.seq ?? null,
                  oldSlotStillInLog: slotNodes(session, ctx).some(node => node.seq === beforeVisibleSlot.seq),
                  compactionRequestCount: adapter.compactionRequests().length - beforeCompactionRequests,
                  compactionLlmCalls: adapter.compactionRequests().length,
                  agentRequestsBefore: beforeRequests,
                  agentRequestsAfter: adapter.agentRequests().length,
                  surfaceAfter: after,
                  // retained tail / tool pairing 在 compaction 之后立刻测量
                  // （rebuild step 之前的 surface 才是「压缩后」的 surface）。
                  retainedTail: (() => {
                    try {
                      const nodes = session.surface.nodes
                      const lastAfter = nodes.length === 0 ? null : Number(nodes[nodes.length - 1]!)
                      const lastBefore = before.surfaceSeqs.length === 0
                        ? null : before.surfaceSeqs[before.surfaceSeqs.length - 1]!
                      return {
                        beforeLastSeq: lastBefore,
                        afterLastSeq: lastAfter,
                        tailPreserved: lastBefore !== null && lastAfter === lastBefore,
                        headCutBalanced: nodes.length === 0
                          ? null : toolPairingBalancedBefore(session, nodes[0]!),
                        allCutsBalancedAfter: nodes.every(seq => toolPairingBalancedAfter(session, seq)),
                        surfaceNodesBefore: before.surfaceNodes,
                        surfaceNodesAfter: nodes.length,
                        surfaceSeqsAfter: after.surfaceSeqs,
                      }
                    } catch (error: unknown) {
                      recordError(`cycle${c}.retainedTail`, error)
                      return null
                    }
                  })(),
                  // 可观测结果 = 真实调用返回非空 result + span 非空 + surface 出现 replacement
                  // + 被遮蔽 span 含当时可见 slot + 调用后该 slot 不再可见
                  observed: result !== null
                    && shadowedSeqs.length > 0
                    && replacement !== null
                    && shadowedSeqs.includes(beforeVisibleSlot.seq)
                    && after.visibleSlotCount === 0,
                  replacementTextIsNotSlotText: replacement === null || replacement.textHash !== slotTextHash,
                }
              } catch (error: unknown) {
                recordError(`cycle${c}.compaction`, error)
                compactionResult = {
                  attempted: true,
                  error: errorText(error),
                  returned: false,
                  plannedRange,
                  observed: false,
                  surfaceGenerationBefore: before.replaceGeneration,
                  surfaceGenerationAfter: session.surface.replaceGeneration,
                }
              }
            }
            record['compaction'] = compactionResult

            // ---- 5. 下一合法 pre-step：真实重建 ---------------------------
            const rebuildStep = await runStep(`X4 rebuild step ${c}: trigger rebuild after compaction.`)
            const rebuildSnapshot = rebuildStep['surface'] as SurfaceSnapshot
            const shadowedSlotSeq = (compactionResult['shadowedSeqs'] as number[] | undefined) ?? []
            const shadowedSlotGeneration = beforeVisibleSlot === null
              ? null
              : (() => {
                const found = slotNodes(session, ctx).find(node => node.seq === beforeVisibleSlot.seq)
                return found?.generation ?? null
              })()
            const rebuiltSlot = rebuildSnapshot.visibleSlot
            const rebuildObserved = compactionResult['observed'] === true
              && rebuildSnapshot.visibleSlotCount === 1
              && rebuiltSlot !== null
              && shadowedSlotGeneration !== null
              && (rebuiltSlot.generation ?? -1) > shadowedSlotGeneration
              && rebuiltSlot.seq !== beforeVisibleSlot?.seq
            record['rebuild'] = {
              ...rebuildStep,
              shadowedSlotSeq: beforeVisibleSlot?.seq ?? null,
              shadowedSlotGeneration,
              shadowedSlotSeqList: shadowedSlotSeq,
              rebuiltSlotSeq: rebuiltSlot?.seq ?? null,
              rebuiltSlotGeneration: rebuiltSlot?.generation ?? null,
              rebuiltSlotRevision: rebuiltSlot?.revision ?? null,
              rebuiltSlotPreviousRevision: rebuiltSlot?.previousRevision ?? null,
              rebuiltSlotPreviousGeneration: rebuiltSlot?.previousGeneration ?? null,
              rebuiltSlotSurfaceOp: rebuiltSlot?.surfaceOp ?? null,
              rebuiltSlotCoveredSeqs: rebuiltSlot?.coveredSeqs ?? null,
              rebuiltSlotSourceEventSeqs: rebuiltSlot?.sourceEventSeqs ?? null,
              rebuiltSlotBytes: rebuiltSlot?.bytes ?? null,
              rebuiltSlotTextHash: rebuiltSlot?.textHash ?? null,
              oldShadowedSlotStillInLog: beforeVisibleSlot === null
                ? null
                : slotNodes(session, ctx).some(node => node.seq === beforeVisibleSlot.seq && !node.visibleOnSurface),
              observed: rebuildObserved,
            }

            // ---- 6. source-index 分类 --------------------------------------
            try {
              const index = buildSurfaceSourceIndex(session)
              const visSeq = rebuiltSlot?.seq
              const slotsNow = slotNodes(session, ctx)
              record['sourceIndex'] = visSeq === undefined
                ? null
                : {
                  visibleSlotKind: index.entry(visSeq as never).kind,
                  visibleSlotCoverageKind: index.replacementCoverage(visSeq as never)?.kind ?? null,
                  visibleSlotCoverageSeqs: index.replacementCoverage(visSeq as never)?.coveredSeqs ?? null,
                  canCompactHistory: index.canCompactHistory(visSeq as never, 1),
                  canCompactHistoryImmediate: index.canCompactHistory(visSeq as never, 1, true),
                  slotInLogCount: slotsNow.length,
                  kindsBySeq: slotsNow.map(node => ({
                    seq: node.seq,
                    visible: node.visibleOnSurface,
                    kind: index.entries.get(node.seq as never)?.kind ?? null,
                  })),
                }
            } catch (error: unknown) {
              recordError(`cycle${c}.sourceIndex`, error)
              record['sourceIndex'] = null
            }

            // ---- 7. store ---------------------------------------------------
            record['store'] = readStore()

            // ---- 9. cumulative ---------------------------------------------
            const injTokens = rebuiltSlot?.tokens ?? -1
            record['cumulative'] = {
              visibleSlotNodes: rebuildSnapshot.visibleSlotCount,
              slotGeneration: rebuiltSlot?.generation ?? null,
              injectionTokens: injTokens,
              slotBytes: rebuiltSlot?.bytes ?? null,
              slotTextChars: rebuiltSlot?.textChars ?? null,
              surfaceTokens: rebuildSnapshot.surfaceTokens,
              totalTokensAfterRebuild: rebuildSnapshot.totalTokens,
              dshSnapshotNodesInLog: dshSnapshotNodes(session).length,
              containsSlotHeader: rebuiltSlot?.hasHeader ?? null,
              compactionLlmCallsTotal: adapter.compactionRequests().length,
              agentLlmCallsTotal: adapter.agentRequests().length,
              totalSurfaceNodes: rebuildSnapshot.surfaceNodes,
              totalLogEvents: rebuildSnapshot.logEvents,
              replaceGeneration: rebuildSnapshot.replaceGeneration,
            }
            record['errors'] = errors.slice(cycleErrorsBefore)
            cycles.push(record)
          }

          // 最后一个 step 可能又触发了一轮 task-state 后台波次（threshold + trailing）；
          // 等它落地再读 store，否则 storeFinal 可能读到在途快照（本 fixture 不 dispose
          // 整个 Context）。稳定的判定窗口取 1.5 s：真实 worker 的 commit 路径包含持久化
          // put，400 ms 的窗口会在波次落地前误判为已静默。
          {
            const deadline = Date.now() + 20_000
            let previous = ''
            let stableSince = Date.now()
            while (Date.now() < deadline) {
              const view = readStore()
              const key = `${view.stableRevision}/${view.auditRowCount}/${view.domainFileBytes}`
              if (key !== previous) { previous = key; stableSince = Date.now() }
              else if (Date.now() - stableSince >= 4_000) { storeQuiesced = true; break }
              await new Promise<void>(resolve => setTimeout(resolve, 40))
            }
          }
        } catch (error: unknown) {
          recordError('drive', error)
        }
      } else {
        surfaceRoute = {
          available: false,
          reason: engineMount.pluginError !== null
            ? `compaction plugin mount failed: ${engineMount.pluginError}`
            : agentLoopModule.imported
              ? 'ctx.compaction did not resolve to a BasicCompactionEngine after real plugin mount'
              : agentLoopModule.mountError ?? 'AgentLoop module did not load',
          agentId: agentIdString,
        }
        recordError('route', new Error(surfaceRoute.reason))
      }
    }

    // ---- 判据与 verdict ---------------------------------------------------
    const cycleOf = (rec: Record<string, unknown>, key: string): Record<string, unknown> =>
      (rec[key] ?? {}) as Record<string, unknown>
    const compactionOf = (rec: Record<string, unknown>): Record<string, unknown> =>
      cycleOf(rec, 'compaction')
    const rebuildOf = (rec: Record<string, unknown>): Record<string, unknown> =>
      cycleOf(rec, 'rebuild')
    const cumulativeOf = (rec: Record<string, unknown>): Record<string, unknown> =>
      cycleOf(rec, 'cumulative')

    const compactionAttempts = cycles.filter(rec => compactionOf(rec)['attempted'] === true).length
    const observedCompactions = cycles.filter(rec => compactionOf(rec)['observed'] === true).length
    const complete = cycles.filter(rec =>
      compactionOf(rec)['observed'] === true && rebuildOf(rec)['observed'] === true)
    const completeCycles = complete.length

    /** routeWorked ≡ engine 可用 且 ≥1 次真实 compaction 返回可观测结果。 */
    const routeWorked = engineAvailable && observedCompactions >= 1

    const generations = complete.map(rec => Number(rebuildOf(rec)['rebuiltSlotGeneration'] ?? -1))
    const visibleCounts = complete.map(rec => Number(rebuildOf(rec)['surface'] === undefined
      ? -1
      : (rebuildOf(rec)['surface'] as SurfaceSnapshot).visibleSlotCount))
    const injTokensList = complete.map(rec => Number(cumulativeOf(rec)['injectionTokens'] ?? -1))
    const sourceIndexKinds = complete.map(rec =>
      (rec['sourceIndex'] as Record<string, unknown> | null)?.['visibleSlotKind'] ?? null)
    const selfFeedback = complete.filter(rec =>
      compactionOf(rec)['replacementContainsSlotHeader'] === true)
    const requestSlotCounts = complete.map(rec => Number(rebuildOf(rec)['requestSlotMessageCount'] ?? -1))
    const retainedTailOk = complete.every(rec => {
      const tail = compactionOf(rec)['retainedTail'] as Record<string, unknown> | null
      return tail !== null
        && tail['tailPreserved'] === true
        && tail['allCutsBalancedAfter'] === true
    })

    const allOneVisibleSlot = completeCycles > 0 && visibleCounts.every(count => count === 1)
    const generationsStrictlyIncreasing = completeCycles >= 3
      && generations.every((generation, index) =>
        index === 0 ? generation >= 1 : generation > generations[index - 1]!)
    const allTaskStateSlotKind = completeCycles > 0 && sourceIndexKinds.every(kind => kind === 'task-state-slot')
    const injectionFlat = completeCycles >= 3
      && injTokensList.every(tokens => tokens >= 0)
      && Math.max(...injTokensList) - Math.min(...injTokensList)
        <= Math.max(FLAT_TOKEN_TOLERANCE_ABS, Math.min(...injTokensList) * FLAT_TOKEN_TOLERANCE_RATIO)
    const dshChannelEmpty = completeCycles > 0 && complete.every(rec =>
      Number(cumulativeOf(rec)['dshSnapshotNodesInLog'] ?? -1) === 0
      && Number(rebuildOf(rec)['requestDshSnapshotMessageCount'] ?? -1) === 0)
    const noSlotSelfFeedback = completeCycles > 0 && selfFeedback.length === 0
    const requestCarriesRebuiltSlot = completeCycles > 0 && requestSlotCounts.every(count => count === 1)

    const evidenceComplete = routeWorked && completeCycles >= 3
    const allInvariants = allOneVisibleSlot
      && generationsStrictlyIncreasing
      && allTaskStateSlotKind
      && injectionFlat
      && dshChannelEmpty
      && noSlotSelfFeedback
      && requestCarriesRebuiltSlot
      && retainedTailOk

    const verdict = !evidenceComplete
      ? 'inconclusive'
      : allInvariants ? 'fixed' : 'still-reproduced'

    const ledger = {
      experiment: 'X4-stable-slot-compaction-recovery',
      attempt: 2,
      question: '当真实 compaction 覆盖 slot 节点后，下一合法 pre-step 能否安全重建？连续多轮后不变量是否成立？',
      verdictRule: 'routeWorked = engine 可用（真实挂载的 BasicCompactionEngine）且 ≥1 次真实 compaction 调用返回可观测结果；completeCycle = observed compaction + 下一真实 pre-step 重建出恰好 1 个代次更高的可见 slot；fixed = routeWorked 且 completeCycle ≥ 3 且全部不变量成立；still-reproduced = 证据充分但不变量被破坏；inconclusive = routeWorked 为假或 completeCycle < 3（0 cycle 永不 fixed）。',
      measurement: 'REAL TaskStateBasicService + REAL TaskStatePrompt + REAL BasicCompactionEngine(auto:false，显式插件挂载) + REAL DSH AgentLoop(a66e4702) + REAL agent/pre-step waterfall + REAL token meter 定价 + REAL 持久 storage。FAKE：唯一 LLM 为脚本化 adapter，无 provider usage；adapter 声明 fixture context capacity。',
      baseline: { pluginCommit: 'cf034b4b', dshCommit: agentLoopModule.dshHead },
      command: 'pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/X4-Stable槽位压缩回收/x4.spec.ts --reporter=verbose',
      artifacts: {
        attempt1Ledger: 'attempt-1-ledger.json',
        attempt1VitestOutput: 'attempt-1-vitest-output.txt',
        attempt1Verdict: 'inconclusive',
        attempt1RootCause: 'BasicCompactionConfig: unknown key "contextWindowOverride" 被 `catch {}` 吞掉 → ctx.get(\'compaction\') === undefined → surfaceRoute.available=false，0 cycle；同时 criteria.routeWorked 被误设为 errors.length === 0 的判据 bug。',
      },
      components: {
        agentLoop: agentLoopModule,
        promptConsumer: { module: 'src/internal/task-state/prompt/index.ts', slotSourceKind: SLOT_SOURCE_KIND },
        compaction: engineMount,
        provider: { module: 'src/task-state-basic.ts', config: CONFIG },
      },
      services,
      config: {
        ...CONFIG,
        promptMaxBytes: PROMPT_MAX_BYTES,
        modelContextWindow: MODEL_CONTEXT_WINDOW,
        cycleCount: CYCLE_COUNT,
        seedsPerCycle: SEEDS_PER_CYCLE,
        warmupStepsPerCycle: WARMUP_STEPS_PER_CYCLE,
        compactionConfig: COMPACTION_CONFIG,
      },
      surfaceRoute,
      engineAvailable,
      cycles,
      criteria: {
        fixedBeforeRun: true,
        engineAvailable,
        routeWorked,
        compactionAttempts,
        observedCompactions,
        completeCycles,
        allOneVisibleSlot,
        generationsStrictlyIncreasing,
        allTaskStateSlotKind,
        injectionFlat,
        dshChannelEmpty,
        noSlotSelfFeedback,
        requestCarriesRebuiltSlot,
        retainedTailOk,
        evidenceComplete,
        verdict,
      },
      storeFinal: readStore(),
      storeQuiesced,
      storeFinalNote: 'storeFinal 在全部 cycle 测量完成、并给后台 task-state 波次 4 s 静默窗口之后读取。每个 cycle 自己的 store 视图（cycles[].store）才是该 cycle 的证据。生产 worker 在 cycle 4 的 threshold commit 之后还会跑一个 trailing 波次；由于本 fixture 用即时 fake LLM 连续驱动 step，该 trailing 波次是否在 teardown 前完成提交是**时序相关**的（多次运行观察到 stableRevision 为 4 或 5）。该 revision 出现在全部 4 轮测量之后、且其后的 slot 维护只发生在下一次真实 agent/pre-step（本实验不再触发），因此不进入任何 cycle 判据；每轮的 stable 修订号在多次运行中恒为 1,2,3,4。',
      verdict,
      errors,
      limitations: [
        'fake LLM：唯一模型是脚本化 adapter，不产出 provider usage；token 数字来自真实 dsh-token-meter 的固定启发式定价（fixture token，不冒充 provider token）。',
        '模型路由被替换：部署 route 下注册的是 fake adapter。',
        'adapter 声明的 context capacity（context.contextWindow）是 fixture 元数据，不是 provider 事实；本实验的 manual compactNow 路径不读取它（`compactNow` 以 retainTokens=0 规划 span，`resolveCompactSpec` 不在该路径上）。',
        'compaction 通过 `compactNow` 触发（真实 manual / idle-session 路径），而非等待自动压力触发；`auto:false` 使自动路径完全不参与，因此本实验不评估自动压力/forget 几何，也不评估紧凑阈值。',
        'fixture 不产生 tool-call/tool-result，因此 tool-pairing 检查恒为 trivially balanced；retained-tail 检查因此只覆盖「压缩后 surface 的每个 cut 平衡」与「压缩前最后一个 surface 节点在压缩后仍是最后一个节点」两条。',
        'ledger 的 `plannedRange` 由生产只读 planner `selectCompactableRange(session, measure, 0)` 复算，用于证明「规划阶段就已包含 slot」；它不是驱动手段，真实 span 仍来自 `compactNow` 的返回值与 surface replacement 事件。',
        '两次独立运行的 ledger 不是逐字节相同：真实 TaskStateBasicService 为每条 entry mint 随机 UUID，因此 stable digest 与 slot 文本 hash 每次不同。结构性证据（session seq / shadowed SeqCount / replacement seq / rebuilt seq / generation / token 计数 / 全部判据）两次运行逐字段一致；差异逐字段清单见 tmp/determinism-report.txt。',
        '重建路径（无可见 slot 分支）提交的 slot 节点不带 previousRevision/previousGeneration（生产实现对被遮蔽的前驱不发 lineage 指针，因为它在 surface 上已不可见），因此 lineage 单调性只能由 generation 与 log 内最高 generation 体现。',
        '生产 worker 在最后一次 threshold commit 之后还会跑一个 trailing 波次；本 fixture 几乎不留空闲时间，因此该波次是否在 teardown 前完成提交是时序相关的（多次运行观察到 storeFinal.stableRevision 为 4 或 5）。它出现在全部 cycle 测量之后、且不再触发 agent/pre-step，因此不进入任何判据；逐 cycle 观察到的 committed revision 恒为 1,2,3,4。详见 storeFinalNote。',
        'DSH AgentLoop 从被审计 checkout 以原生 ESM import() 载入；其 sha256 记入 ledger.components.agentLoop。',
        '"通过"只表示 fixture 断言通过，且只回答本文件第 1 节那一个问题。',
      ],
    }

    // 先写 ledger 再断言（判定规则运行前固定）
    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    writeFileSync(RESULT_PATH, `${JSON.stringify({
      experiment: ledger.experiment,
      attempt: 2,
      verdict,
      surfaceRoute,
      criteria: ledger.criteria,
      errors,
      sourceDrift: {
        agentLoopLibSha256: agentLoopModule.sha256,
        agentLoopSrcHashes: agentLoopModule.srcHashes,
        dshHead: agentLoopModule.dshHead,
      },
    }, null, 2)}\n`, 'utf8')

    expect(agentLoopModule.imported, agentLoopModule.mountError ?? 'AgentLoop import failed').toBe(true)
    expect(engineMount.pluginError, `BasicCompactionEngine plugin mount failed: ${engineMount.pluginError}`).toBeNull()
    expect(engineAvailable, 'ctx.compaction did not resolve to a BasicCompactionEngine').toBe(true)
    expect(routeWorked, 'routeWorked requires an available engine and ≥1 observed real compaction result').toBe(true)
    expect(errors).toEqual([])
    expect(completeCycles).toBeGreaterThanOrEqual(3)
    expect(allOneVisibleSlot).toBe(true)
    expect(generationsStrictlyIncreasing).toBe(true)
    expect(allTaskStateSlotKind).toBe(true)
    expect(injectionFlat).toBe(true)
    expect(dshChannelEmpty).toBe(true)
    expect(noSlotSelfFeedback).toBe(true)
    expect(requestCarriesRebuiltSlot).toBe(true)
    expect(retainedTailOk).toBe(true)
    expect(verdict).toBe('fixed')
  }, TEST_TIMEOUT_MS)
})
