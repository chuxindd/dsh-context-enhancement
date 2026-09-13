/**
 * B5.1 回归 · Stable 注入固定槽位（E08 对照：append 累积 → 单节点 replacement）
 *
 * 实验问题（唯一）
 * ----------------
 * B5.1 把模型可见的 Stable Task State 注入从 DSH 的 append-only runtime context
 * 改成**插件自己拥有的固定槽位节点**之后，重复 E08 的同一场景（连续提交多个内容
 * 不同的 revision，每个 revision 之后执行一次真实 step），是否（a）每个 step 的
 * 模型可见请求里只有**一个**slot 节点、且只呈现**当前** revision；（b）surface 上
 * 始终只有 1 个可见 slot 节点，旧节点被真实 `surfaceOp.replace` 遮蔽；（c）注入
 * 字节 / token-meter 归因**不再随 revision 数增长**；（d）DSH 自己的 runtime-context
 * 快照节点数为 **0**（E08 的累积通道已空）；（e）持久 store 仍然只有最新一份 stable，
 * 且日志里没有任何事件被删除。
 *
 * 判定规则（运行前固定）
 * ----------------------
 *   fixed        = 20 个内容不同的 revision，每个之后恰好一次真实 step：
 *                  每步请求恰好 1 条 slot 消息且 revision header 只含当前 revision；
 *                  surface 可见 slot 节点恒为 1；第 k(≥2) 个 slot 节点是一次
 *                  replacement（`sourceEventSeqs = [上一节点]`，start=end=上一节点），
 *                  记录 oldRevision/newRevision + digest + generation，generation 严格递增；
 *                  注入字节/ token 平坦（容差内）；store 恒为 1 份最新 stable；
 *                  DSH runtime-context 快照节点数 = 0；日志包含全部 slot 节点（无删除）。
 *   not-fixed    = 任一步出现 2 个及以上可见 slot 节点，或请求里出现更早 revision 的
 *                  header，或注入 token 随 revision 单调增长。
 *   inconclusive = fixture / route / AgentLoop 无法产出证据（此时不声称任何结论）。
 *
 * 层级与 real / fake 边界与 E08 一致（见 `审计资料/实验结果/E08-Stable注入累积/README.md`）：
 *   REAL = TaskStateBasicService（生产调度/折叠/校验/权威 put/audit）、本插件真实的
 *          `task-state-prompt` 消费者、真实持久 storage domain（落在本目录内）、
 *          SessionStore / SystemPrompt / ToolRuntime / AgentRegistry /
 *          SessionProjectionRegistry / LlmRuntime / TokenMeter，以及从被审计 DSH
 *          checkout 以原生 ESM import() 载入的**真实 DSH AgentLoop**；
 *   FAKE = 唯一 LLM 是脚本化 adapter（不产出 provider usage，token 数字只来自真实
 *          token-meter 的固定启发式定价）。
 *
 * 本 spec 不修改任何生产源码、现有 tests、既有 harness、package.json、vitest.config.ts、
 * lib、tgz 或其他实验目录；全部产物只写在本目录内。
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
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../../../src/task-state-basic.ts'
import type { TaskStateBasicConfig, TaskStateStable } from '../../../src/task-state.ts'
import * as TaskStatePrompt from '../../../src/task-state-prompt.ts'
import { buildSurfaceSourceIndex } from '../../../src/internal/compaction/source-index.ts'

// ---------------------------------------------------------------------------
// 固定实验常量
// ---------------------------------------------------------------------------

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
/** 真实持久 task-state domain 根目录（落在本实验目录内）。 */
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')
/**
 * 真实 JSON backend 写出的 domain 文档。B4 的 clean-break 把 domain 文件名升到
 * `…_v2.json`，所以这里**按目录发现**而不是硬编码，并把真实文件名记入 ledger。
 */
function domainFilePath(): string {
  const fallback = join(STORAGE_ROOT, 'context_enhancement_task_state_v2.json')
  try {
    const found = readdirSync(STORAGE_ROOT)
      .filter(name => name.startsWith('context_enhancement_task_state') && name.endsWith('.json'))
      .sort()
    return found.length === 0 ? fallback : join(STORAGE_ROOT, found[found.length - 1]!)
  } catch {
    return fallback
  }
}
const LEDGER_PATH = join(OUT_DIR, 'b51-ledger.json')

const SESSION_ID = SessionId('b51-fixed-slot-regression')

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

/** 内容不同的 Stable revision 个数，每个之后一次真实 step（验收：20）。 */
const REVISION_COUNT = 20
/** 每次 revision 追加的合格人类事件数（部署阈值 minEvents = 20，恰好跨阈值一次）。 */
const SEEDS_PER_REVISION = 20

/** 被审计的 DSH checkout（固定基线 HEAD a66e4702）。 */
const DSH_ROOT = 'C:\\Users\\chuxi\\Documents\\trae_projects\\code\\deepseek-harness'
const AGENT_LOOP_LIB = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'lib', 'index.js')
const AGENT_LOOP_SRC_DIR = join(DSH_ROOT, 'packages', 'core', 'agent-loop', 'src')

/** 本插件 slot 节点的来源标识（来自生产 contract）。 */
const SLOT_SOURCE_KIND = TaskStatePrompt.TASK_STATE_SLOT_SOURCE_KIND
const SLOT_ID = TaskStatePrompt.TASK_STATE_SLOT_ID
/** DSH 自己写 runtime-context 快照时使用的来源标识（E08 的累积通道）。 */
const SNAPSHOT_SOURCE_PLUGIN = '@deepseek-ai/dsh-system-prompt'
/** 插件 renderer 为每个 revision 写出的 header。 */
const HEADER_RE = /Durable task state \(revision (\d+), source event (\d+), digest ([0-9a-f]+)\)/u
const COMMIT_DEADLINE_MS = 20_000
const STEP_DEADLINE_MS = 30_000
const TEST_TIMEOUT_MS = 300_000
/** 注入 token 平坦判定容差：max - min ≤ max(24, min 的 10%)。 */
const FLAT_TOKEN_TOLERANCE_ABS = 24
const FLAT_TOKEN_TOLERANCE_RATIO = 0.10

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** UTF-8 字节数。 */
function bytesOf(text: string): number {
  return encoder.encode(text).byteLength
}

/** 字符串 SHA-256（hex）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 文件 SHA-256（hex），不可读时 null。 */
function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** 只读解析 DSH checkout 的 HEAD。 */
function dshHead(): string | null {
  try {
    const head = readFileSync(join(DSH_ROOT, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return head
    return readFileSync(join(DSH_ROOT, '.git', head.slice(4).trim()), 'utf8').trim()
  } catch {
    return null
  }
}

/** 轮询一个谓词直到成立或超时。 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 5): Promise<boolean> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
  return true
}

/** 一条模型可见消息的文本。 */
function messageText(message: unknown): string {
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { readonly type: string; readonly text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/** 一条消息的 source 记录。 */
function messageSource(message: unknown): Record<string, unknown> | undefined {
  const source = (message as { readonly source?: unknown }).source
  return typeof source === 'object' && source !== null ? source as Record<string, unknown> : undefined
}

/** 该消息是否是本插件的 Stable slot 节点。 */
function isSlotMessage(message: unknown): boolean {
  return messageSource(message)?.['kind'] === SLOT_SOURCE_KIND
}

/** 该消息是否是 DSH 自己写的 runtime-context 快照。 */
function isDshSnapshotMessage(message: unknown): boolean {
  const source = messageSource(message)
  return source?.['kind'] === 'plugin' && source['plugin'] === SNAPSHOT_SOURCE_PLUGIN
}

/** 一条消息的紧凑视图。 */
function messageView(message: unknown, index: number): Record<string, unknown> {
  const text = messageText(message)
  const source = messageSource(message)
  const header = HEADER_RE.exec(text)
  return {
    index,
    role: String((message as { readonly role?: unknown }).role ?? 'unknown'),
    sourceKind: source?.['kind'] === undefined ? null : String(source['kind']),
    slotId: source?.['slotId'] === undefined ? null : String(source['slotId']),
    generation: typeof source?.['generation'] === 'number' ? Number(source['generation']) : null,
    revision: typeof source?.['revision'] === 'number' ? Number(source['revision']) : null,
    isSlot: isSlotMessage(message),
    isDshRuntimeContextSnapshot: isDshSnapshotMessage(message),
    chars: text.length,
    bytes: bytesOf(text),
    revisionHeader: header === null ? null : Number(header[1]),
    sourceCursorHeader: header === null ? null : Number(header[2]),
    textHash: sha256(text).slice(0, 16),
    earlierRevisionHeaders: [...text.matchAll(new RegExp(HEADER_RE.source, 'gu'))]
      .map(match => Number(match[1])),
  }
}

// ---------------------------------------------------------------------------
// 唯一 LLM：脚本化 fake adapter（与 E08 同构）
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly index: number
  readonly kind: 'task-state' | 'agent-loop'
  readonly purpose: string | null
  readonly messageCount: number
  readonly messages: readonly Record<string, unknown>[]
  readonly slotMessageCount: number
  readonly slotBytes: number
  readonly dshSnapshotMessageCount: number
  readonly revisionHeadersInSlotText: readonly number[]
  readonly maxRevisionHeaderInSlotText: number | null
  readonly totalTextBytes: number
  readonly systemBytes: number
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: RecordedRequest[] = []
  private taskStateCalls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = (options as { readonly purpose?: unknown }).purpose
    const kind: RecordedRequest['kind'] = purpose === 'task-state' ? 'task-state' : 'agent-loop'
    const messages = (options.messages ?? []) as readonly unknown[]
    const views = messages.map((message, index) => messageView(message, index))
    const slotViews = views.filter(view => view['isSlot'] === true)
    const slotHeaders = slotViews.flatMap(view =>
      (view['earlierRevisionHeaders'] as readonly number[] | undefined) ?? [])
    const inputText = messages.map(messageText).join('')
    const systemText = typeof (options as { readonly system?: unknown }).system === 'string'
      ? String((options as { readonly system?: unknown }).system)
      : ''
    const text = kind === 'task-state'
      ? this.candidateFor(inputText)
      : `B5.1 assistant reply ${this.requests.filter(row => row.kind === 'agent-loop').length + 1}: no tool call, the turn ends after one step.`
    this.requests.push({
      index: this.requests.length,
      kind,
      purpose: purpose === undefined ? null : String(purpose),
      messageCount: messages.length,
      messages: views,
      slotMessageCount: slotViews.length,
      slotBytes: slotViews.reduce((sum, view) => sum + Number(view['bytes']), 0),
      dshSnapshotMessageCount: views.filter(view => view['isDshRuntimeContextSnapshot'] === true).length,
      revisionHeadersInSlotText: slotHeaders,
      maxRevisionHeaderInSlotText: slotHeaders.length === 0 ? null : Math.max(...slotHeaders),
      totalTextBytes: bytesOf(inputText),
      systemBytes: bytesOf(systemText),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** 结构合法、内容每次不同的候选 JSON。 */
  private candidateFor(inputText: string): string {
    const seqs = [...inputText.matchAll(/"seq":\s*(\d+)/gu)].map(match => Number(match[1]))
    const maxSeq = seqs.length === 0 ? -1 : Math.max(...seqs)
    this.taskStateCalls += 1
    const marker = `B51-CALL-${this.taskStateCalls}-THROUGH-SEQ-${maxSeq}`
    return JSON.stringify({
      facts: [
        { content: `B51 durable marker ${marker}: the folded window ended at session event ${maxSeq}.` },
        { content: `B51 padding ${marker}: ${'p'.repeat(160)}` },
      ],
      decisions: [{ content: `B51 decision ${marker}` }],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `B51 objective ${marker}`,
        currentFocus: `B51 focus ${marker}`,
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
}

// ---------------------------------------------------------------------------
// Session / surface 观测
// ---------------------------------------------------------------------------

/** 在 surface 上追加一条直接人类 user/message，返回其 seq。 */
function appendUser(session: Session, text: string): number {
  return Number(session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq)
}

/** 一个 slot 节点在日志与 surface 上的形态。 */
interface SlotNodeView {
  readonly seq: number
  readonly visibleOnSurface: boolean
  readonly surfaceOp: string
  readonly coveredSeqs: readonly number[]
  readonly generation: number | null
  readonly revision: number | null
  readonly previousRevision: number | null
  readonly previousGeneration: number | null
  readonly digest: string | null
  readonly renderedRevisionHeader: number | null
  readonly bytes: number
  readonly textHash: string
}

/** 日志里全部 slot 节点（按日志顺序）。 */
function slotNodes(session: Session): SlotNodeView[] {
  const onSurface = new Set(session.surface.nodes.map(node => Number(node)))
  const out: SlotNodeView[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { readonly source?: Record<string, unknown> }).source
    if (source?.['kind'] !== SLOT_SOURCE_KIND) continue
    const text = messageText(event.data)
    const header = HEADER_RE.exec(text)
    const op = (event as { readonly surfaceOp?: unknown }).surfaceOp
    out.push({
      seq: Number(event.seq),
      visibleOnSurface: onSurface.has(Number(event.seq)),
      surfaceOp: op === undefined ? 'undefined' : typeof op === 'string' ? op : 'replace',
      coveredSeqs: ((event as { readonly sourceEventSeqs?: readonly unknown[] }).sourceEventSeqs ?? []).map(Number),
      generation: typeof source['generation'] === 'number' ? Number(source['generation']) : null,
      revision: typeof source['revision'] === 'number' ? Number(source['revision']) : null,
      previousRevision: typeof source['previousRevision'] === 'number' ? Number(source['previousRevision']) : null,
      previousGeneration: typeof source['previousGeneration'] === 'number' ? Number(source['previousGeneration']) : null,
      digest: source['digest'] === undefined ? null : String(source['digest']),
      renderedRevisionHeader: header === null ? null : Number(header[1]),
      bytes: bytesOf(text),
      textHash: sha256(text).slice(0, 16),
    })
  }
  return out
}

/** 日志里全部 DSH runtime-context 快照节点（E08 的累积通道）。 */
function dshSnapshotNodes(session: Session): Record<string, unknown>[] {
  const onSurface = new Set(session.surface.nodes.map(node => Number(node)))
  const out: Record<string, unknown>[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const data = event.data as { readonly content?: unknown; readonly source?: unknown }
    const source = data.source as { readonly kind?: unknown; readonly plugin?: unknown } | undefined
    if (source?.kind !== 'plugin' || source.plugin !== SNAPSHOT_SOURCE_PLUGIN) continue
    const text = messageText({ content: data.content })
    out.push({
      seq: Number(event.seq),
      visibleOnSurface: onSurface.has(Number(event.seq)),
      surfaceOp: (event as { readonly surfaceOp?: unknown }).surfaceOp ?? null,
      bytes: bytesOf(text),
      firstLine: text.split('\n', 1)[0] ?? '',
    })
  }
  return out
}

/** 日志里全部 replacement surface 事件。 */
function replacementEvents(session: Session): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const event of session.snapshotEvents()) {
    const op = (event as { readonly surfaceOp?: unknown }).surfaceOp
    if (op === undefined || typeof op === 'string') continue
    const record = op as { readonly op?: unknown; readonly start?: unknown; readonly end?: unknown }
    if (record.op !== 'replace') continue
    out.push({
      seq: Number(event.seq),
      type: String(event.type),
      start: Number(record.start),
      end: Number(record.end),
      sourceEventSeqs: ((event as { readonly sourceEventSeqs?: readonly unknown[] }).sourceEventSeqs ?? []).map(Number),
      isSlot: ((event.data as { readonly source?: Record<string, unknown> }).source?.['kind']) === SLOT_SOURCE_KIND,
    })
  }
  return out
}

/** 持久 store 文档的紧凑视图。 */
interface StoreView {
  readonly read: boolean
  readonly domainFile: string
  readonly domainFileBytes: number | null
  readonly stableRecordCountForSession: number | null
  readonly stableRevision: number | null
  readonly stableSourceCursor: number | null
  readonly auditRowCount: number | null
}

function readStore(): StoreView {
  const domainFile = domainFilePath()
  let raw: string
  try {
    raw = readFileSync(domainFile, 'utf8')
  } catch {
    return {
      read: false,
      domainFile: relative(process.cwd(), domainFile),
      domainFileBytes: null,
      stableRecordCountForSession: null,
      stableRevision: null,
      stableSourceCursor: null,
      auditRowCount: null,
    }
  }
  const doc = JSON.parse(raw) as {
    readonly tables?: {
      readonly sessions?: Record<string, { readonly stable?: { readonly revision?: number; readonly sourceCursor?: number } }>
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
    stableRecordCountForSession: Object.values(sessions)
      .filter(entry => entry.stable !== undefined).length,
    stableRevision: stable?.revision === undefined ? null : Number(stable.revision),
    stableSourceCursor: stable?.sourceCursor === undefined ? null : Number(stable.sourceCursor),
    auditRowCount: Object.keys(doc.tables?.audit ?? {}).length,
  }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

async function mountComposition(AgentLoop: unknown): Promise<{ ctx: Context; adapter: RecordingAdapter }> {
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
  await ctx.plugin(TaskStateBasicService, CONFIG)
  await ctx.plugin(TaskStatePrompt, { maxBytes: PROMPT_MAX_BYTES })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  if (AgentLoop !== null) await ctx.plugin(AgentLoop as never, { agents: [] })
  return { ctx, adapter }
}

/** 等待 agent 回到 idle。 */
function waitForIdle(
  ctx: Context,
  agent: { readonly status: string },
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`agent did not return to idle within ${timeoutMs} ms (status ${agent.status})`))
    }, timeoutMs)
    const dispose = ctx.on('agent/status', (payload: { readonly agent?: unknown; readonly status?: unknown }) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// 实验
// ---------------------------------------------------------------------------

describe('B5.1 · Stable 注入固定槽位（E08 对照回归）', () => {
  it('20 个 revision × 1 次真实 step：模型可见 slot 恒为 1、只呈现当前 revision、旧节点被 replacement 遮蔽、注入成本平坦', async () => {
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })

    const errors: { stage: string; message: string }[] = []
    const recordError = (stage: string, error: unknown): void => {
      errors.push({ stage, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    }

    // ---- phase 0: 真实 DSH AgentLoop（唯一的非依赖模块） -------------------
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
      agentLoopModule.mountError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    // ---- phase 1: 装配 ----------------------------------------------------
    let composition: { ctx: Context; adapter: RecordingAdapter } | null = null
    try {
      composition = await mountComposition(agentLoopModule.imported ? AgentLoop : null)
    } catch (error: unknown) {
      recordError('mount', error)
    }

    const iterations: Record<string, unknown>[] = []
    let surfaceRoute = { available: false, reason: 'not attempted', agentId: String(SESSION_ID) }
    let session: Session | undefined

    if (composition !== null) {
      const { ctx, adapter } = composition
      try {
        if (agentLoopModule.imported) {
          const loop = (ctx as unknown as {
            readonly agentLoop: { create: (id: SessionId, options: Record<string, unknown>) => unknown }
          }).agentLoop
          const agent = loop.create(SESSION_ID, { provider: PROVIDER, model: MODEL }) as {
            readonly session: Session
            readonly status: string
            followup: (message: unknown) => void
          }
          session = agent.session
          surfaceRoute = { available: true, reason: 'AgentLoop mounted', agentId: String(SESSION_ID) }

          for (let k = 1; k <= REVISION_COUNT; k += 1) {
            const record: Record<string, unknown> = {
              iteration: k,
              seeds: null,
              commit: null,
              step: null,
              slot: null,
              runtimeContext: null,
              modelRequest: null,
              tokenMeter: null,
              sourceIndex: null,
              store: null,
              cumulative: null,
            }
            const previous = iterations[iterations.length - 1] as Record<string, unknown> | undefined
            const previousRevision = previous === undefined
              ? 0
              : Number((previous['commit'] as Record<string, unknown>)['revisionAfter'] ?? 0)

            // 1. 20 个合格人类事件（跨过 minEvents 阈值恰好一次）
            const callsBefore = adapter.taskStateRequests().length
            const seedSeqs: number[] = []
            for (let j = 1; j <= SEEDS_PER_REVISION; j += 1) {
              seedSeqs.push(appendUser(
                session,
                `B51 seed ${k}.${j}: durable-window content marker B51-K${k}-J${j} (batch ${j}).`,
              ))
            }
            record['seeds'] = { count: seedSeqs.length, firstSeq: seedSeqs[0], lastSeq: seedSeqs[seedSeqs.length - 1] }

            // 2. 真实 worker 提交一个新的、内容不同的 revision
            const committed = await waitUntil(
              () => (ctx.taskState.getStable(SESSION_ID)?.revision ?? 0) > previousRevision,
              COMMIT_DEADLINE_MS,
            )
            const stableBeforeStep = ctx.taskState.getStable(SESSION_ID)
            if (!committed) recordError(`iteration${k}.commit`, new Error('no new stable revision within the deadline'))
            record['commit'] = {
              trigger: 'session/event observer → worker（生产路径）',
              revisionBefore: previousRevision,
              revisionAfter: stableBeforeStep?.revision ?? null,
              sourceCursor: stableBeforeStep?.sourceCursor ?? null,
              digest: stableBeforeStep?.digest ?? null,
              taskStateModelCalls: adapter.taskStateRequests().length - callsBefore,
            }

            // 3. 一次真实 step：assemble → project → pre-step → 请求
            const requestBefore = adapter.agentRequests().length
            const idle = waitForIdle(ctx, agent, STEP_DEADLINE_MS)
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: `B51 step ${k}: one assembly/step after revision ${stableBeforeStep?.revision ?? '?'}.` }],
              source: { kind: 'user' },
            }))
            let stepError: string | null = null
            try {
              await idle
            } catch (error: unknown) {
              stepError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
              recordError(`iteration${k}.step`, error)
            }
            const agentRequests = adapter.agentRequests()
            const request = agentRequests[agentRequests.length - 1]
            record['step'] = {
              trigger: 'agent.followup → 一次 preStep（assemble + project + pre-step waterfall）→ 一次模型请求 → turn 结束',
              error: stepError,
              agentStatus: agent.status,
              agentRequestsThisIteration: agentRequests.length - requestBefore,
            }

            // 4. slot 层：日志 / surface / replacement
            const nodes = slotNodes(session)
            const visible = nodes.filter(node => node.visibleOnSurface)
            const replacements = replacementEvents(session)
            const current = nodes[nodes.length - 1]
            const previousNode = nodes[nodes.length - 2]
            record['slot'] = {
              slotNodesInLog: nodes.length,
              visibleSlotNodes: visible.length,
              visibleSlotSeqs: visible.map(node => node.seq),
              visibleSlotRevisions: visible.map(node => node.revision),
              visibleSlotRenderedRevisionHeaders: visible.map(node => node.renderedRevisionHeader),
              currentSlotSeq: current?.seq ?? null,
              currentSlotSurfaceOp: current?.surfaceOp ?? null,
              currentSlotGeneration: current?.generation ?? null,
              currentSlotRevision: current?.revision ?? null,
              currentSlotDigest: current?.digest ?? null,
              currentSlotCoveredSeqs: current?.coveredSeqs ?? null,
              currentSlotBytes: current?.bytes ?? null,
              replacementCoversPreviousNode: previousNode === undefined || current === undefined
                ? null
                : current.surfaceOp === 'replace'
                  && current.coveredSeqs.length === 1
                  && current.coveredSeqs[0] === previousNode.seq
                  && current.previousRevision === previousNode.revision
                  && current.previousGeneration === previousNode.generation
                  && current.generation === (previousNode.generation ?? -1) + 1,
              previousNodeStillInLog: previousNode === undefined ? null : true,
              previousNodeStillVisible: previousNode === undefined ? null : previousNode.visibleOnSurface,
              slotNodeDetails: nodes,
            }

            // 5. DSH runtime-context 通道（E08 的累积通道必须为空）
            const dshNodes = dshSnapshotNodes(session)
            record['runtimeContext'] = {
              dshSnapshotNodesInLog: dshNodes.length,
              dshSnapshotNodesVisible: dshNodes.filter(node => node['visibleOnSurface'] === true).length,
              dshSnapshotNodeDetails: dshNodes,
              assemblyRenderedBytes: bytesOf(renderContextSnapshot(await ctx.systemPrompt.assemble(
                assembleContextFor(agent as never, new AbortController().signal),
              ))),
              surfaceNodes: session.surface.nodes.length,
              logEvents: session.snapshotEvents().length,
              surfaceReplaceGeneration: (session.surface as { readonly replaceGeneration?: unknown }).replaceGeneration ?? null,
              replacementEventCount: replacements.length,
              replacementEvents: replacements,
            }

            // 6. 该 step 的模型可见请求（关键证据）
            const messages = (request?.messages ?? []) as readonly Record<string, unknown>[]
            const slotMessages = messages.filter(message => message['isSlot'] === true)
            const headersInSlotText = slotMessages.flatMap(message =>
              (message['earlierRevisionHeaders'] as readonly number[] | undefined) ?? [])
            const expectedRevision = stableBeforeStep?.revision ?? null
            const allHeadersInRequest = messages.flatMap(message =>
              (message['earlierRevisionHeaders'] as readonly number[] | undefined) ?? [])
            record['modelRequest'] = {
              requestIndex: request?.index ?? null,
              messageCount: request?.messageCount ?? null,
              slotMessageCount: request?.slotMessageCount ?? null,
              slotBytes: request?.slotBytes ?? null,
              dshSnapshotMessageCount: request?.dshSnapshotMessageCount ?? null,
              slotRevisionHeaders: [...new Set(headersInSlotText)].sort((a, b) => a - b),
              allRevisionHeadersInRequest: [...new Set(allHeadersInRequest)].sort((a, b) => a - b),
              allRevisionHeaderCountInRequest: allHeadersInRequest.length,
              presentedRevision: request?.maxRevisionHeaderInSlotText ?? null,
              presentsExactlyCurrentRevision: expectedRevision !== null
                && headersInSlotText.length === 1
                && headersInSlotText[0] === expectedRevision,
              onlyCurrentRevisionAnywhereInRequest: expectedRevision !== null
                && allHeadersInRequest.length === 1
                && allHeadersInRequest[0] === expectedRevision,
              olderRevisionHeaderPresent: expectedRevision !== null
                && allHeadersInRequest.some(header => header < expectedRevision),
              totalTextBytes: request?.totalTextBytes ?? null,
              systemBytes: request?.systemBytes ?? null,
              messages,
            }

            // 7. 真实 token-meter 归因（只对当前可见 slot 节点）
            let meterView: Record<string, unknown> | null = null
            try {
              const measurement = ctx.tokenMeter.measure(session)
              const visibleSeqs = new Set(visible.map(node => Number(node.seq)))
              const injectionNodes = measurement.nodes.filter(node => visibleSeqs.has(Number(node.seq)))
              meterView = {
                logRevision: Number(measurement.logRevision),
                baselineKind: measurement.baseline.kind,
                surfaceTokens: measurement.surfaceTokens,
                totalTokens: measurement.totalTokens,
                nodeCount: measurement.nodes.length,
                injectionNodeCount: injectionNodes.length,
                injectionTokens: injectionNodes.reduce((sum, node) => sum + node.tokens, 0),
                injectionHeuristicTokens: injectionNodes.reduce((sum, node) => sum + node.heuristicTokens, 0),
              }
            } catch (error: unknown) {
              recordError(`iteration${k}.tokenMeter`, error)
            }
            record['tokenMeter'] = meterView

            // 8. 来源索引分类（验收第 7 条）
            try {
              const index = buildSurfaceSourceIndex(session)
              const visibleSeq = visible[0]?.seq
              record['sourceIndex'] = visibleSeq === undefined
                ? null
                : {
                  visibleSlotKind: index.entry(visibleSeq as never).kind,
                  visibleSlotCoverageKind: index.replacementCoverage(visibleSeq as never)?.kind ?? null,
                  visibleSlotCoverageSeqs: index.replacementCoverage(visibleSeq as never)?.coveredSeqs ?? null,
                  canCompactHistoryMinReentry1: index.canCompactHistory(visibleSeq as never, 1),
                  canCompactHistoryMinReentry1Immediate: index.canCompactHistory(visibleSeq as never, 1, true),
                }
            } catch (error: unknown) {
              recordError(`iteration${k}.sourceIndex`, error)
            }

            // 9. 持久 store（必须仍然只有一份最新 stable）
            record['store'] = readStore()

            // 10. 累计项
            record['cumulative'] = {
              visibleSlotNodes: visible.length,
              visibleSlotBytes: visible.reduce((sum, node) => sum + node.bytes, 0),
              modelVisibleSlotMessages: request?.slotMessageCount ?? null,
              modelVisibleSlotBytes: request?.slotBytes ?? null,
              meterInjectionTokens: meterView === null ? null : meterView['injectionTokens'],
              slotNodesInLog: nodes.length,
            }
            iterations.push(record)
          }
        } else {
          surfaceRoute = {
            available: false,
            reason: agentLoopModule.mountError ?? 'AgentLoop module did not load',
            agentId: String(SESSION_ID),
          }
        }
      } catch (error: unknown) {
        recordError('drive', error)
      }
    }

    // ---- 判据（运行前固定）与 verdict -------------------------------------
    const complete = iterations.filter(record =>
      record['modelRequest'] !== null && record['slot'] !== null)
    const revisions = complete.map(record =>
      Number((record['commit'] as Record<string, unknown>)['revisionAfter'] ?? -1))
    const distinctRevisions = [...new Set(revisions)]
    const visibleNodeCounts = complete.map(record =>
      Number((record['slot'] as Record<string, unknown>)['visibleSlotNodes'] ?? -1))
    const generations = complete.map(record =>
      Number((record['slot'] as Record<string, unknown>)['currentSlotGeneration'] ?? -1))
    const injectionTokens = complete.map(record => record['tokenMeter'] === null
      ? null
      : Number((record['tokenMeter'] as Record<string, unknown>)['injectionTokens']))
    const injectionBytes = complete.map(record =>
      Number((record['modelRequest'] as Record<string, unknown>)['slotBytes'] ?? -1))
    const oneVisibleSlotEveryStep = complete.length === REVISION_COUNT
      && visibleNodeCounts.every(count => count === 1)
    const oneSlotMessageEveryRequest = complete.every(record =>
      Number((record['modelRequest'] as Record<string, unknown>)['slotMessageCount']) === 1)
    const presentsOnlyCurrentRevision = complete.every(record =>
      (record['modelRequest'] as Record<string, unknown>)['presentsExactlyCurrentRevision'] === true
      && (record['modelRequest'] as Record<string, unknown>)['olderRevisionHeaderPresent'] === false)
    /**
     * 最强形式的第 2 条判据：请求里**任何**消息的文本中，revision header 恰好只有一个，
     * 且就是该 step 已提交的 revision（旧 revision 文本既不在 surface 上，也不在请求里）。
     */
    const onlyCurrentRevisionAnywhereInRequest = complete.every(record =>
      (record['modelRequest'] as Record<string, unknown>)['onlyCurrentRevisionAnywhereInRequest'] === true)
    const chainIsReplacement = complete.every((record, index) =>
      index === 0 || (record['slot'] as Record<string, unknown>)['replacementCoversPreviousNode'] === true)
    const generationsStrictlyIncreasing = generations.length === REVISION_COUNT
      && generations.every((generation, index) => index === 0 ? generation === 1 : generation === generations[index - 1]! + 1)
    const dshChannelEmpty = complete.every(record =>
      Number((record['runtimeContext'] as Record<string, unknown>)['dshSnapshotNodesInLog']) === 0)
    const storeHoldsOneLatest = complete.length > 0 && complete.every(record => {
      const store = record['store'] as Record<string, unknown>
      const commit = record['commit'] as Record<string, unknown>
      return store['read'] === true
        && Number(store['stableRecordCountForSession']) === 1
        && Number(store['stableRevision']) === Number(commit['revisionAfter'])
    })
    const nothingDeleted = complete.every((record, index) =>
      Number((record['slot'] as Record<string, unknown>)['slotNodesInLog']) === index + 1
      && (record['slot'] as Record<string, unknown>)['previousNodeStillInLog'] !== false)
    const knownTokenValues = injectionTokens.filter((value): value is number => value !== null)
    const minInjectionTokens = knownTokenValues.length === 0 ? null : Math.min(...knownTokenValues)
    const maxInjectionTokens = knownTokenValues.length === 0 ? null : Math.max(...knownTokenValues)
    const injectionFlat = knownTokenValues.length === complete.length
      && minInjectionTokens !== null && maxInjectionTokens !== null
      && (maxInjectionTokens - minInjectionTokens)
        <= Math.max(FLAT_TOKEN_TOLERANCE_ABS, minInjectionTokens * FLAT_TOKEN_TOLERANCE_RATIO)
    const injectionBytesFlat = injectionBytes.length === REVISION_COUNT
      && Math.max(...injectionBytes) - Math.min(...injectionBytes) <= Math.max(64, Math.min(...injectionBytes) * 0.10)
    const growth = complete.map((record, index) => ({
      iteration: Number(record['iteration']),
      revision: revisions[index] ?? -1,
      visibleSlotNodes: visibleNodeCounts[index] ?? -1,
      modelVisibleSlotMessages: Number((record['modelRequest'] as Record<string, unknown>)['slotMessageCount'] ?? -1),
      modelVisibleSlotBytes: injectionBytes[index] ?? -1,
      presentedRevision: (record['modelRequest'] as Record<string, unknown>)['presentedRevision'] ?? null,
      slotGeneration: generations[index] ?? -1,
      slotSurfaceOp: (record['slot'] as Record<string, unknown>)['currentSlotSurfaceOp'] ?? null,
      dshSnapshotNodes: Number((record['runtimeContext'] as Record<string, unknown>)['dshSnapshotNodesInLog'] ?? -1),
      meterInjectionTokens: injectionTokens[index] ?? null,
      storeStableRevision: Number((record['store'] as Record<string, unknown>)['stableRevision'] ?? -1),
    }))
    const routeWorked = errors.length === 0
    const evidenceComplete = routeWorked
      && surfaceRoute.available
      && complete.length === REVISION_COUNT
      && distinctRevisions.length === REVISION_COUNT
      && oneVisibleSlotEveryStep
      && oneSlotMessageEveryRequest
      && chainIsReplacement
      && storeHoldsOneLatest
    const verdict = !evidenceComplete
      ? 'inconclusive'
      : presentsOnlyCurrentRevision
        && onlyCurrentRevisionAnywhereInRequest
        && generationsStrictlyIncreasing
        && dshChannelEmpty
        && nothingDeleted
        && injectionFlat
        && injectionBytesFlat
        ? 'fixed'
        : 'not-fixed'

    const ledger = {
      experiment: 'B5.1-stable-injection-fixed-slot-regression',
      question: 'B5.1 之后重复 E08 场景：连续 N 个内容不同的 stable revision、每个之后一次真实 step，模型可见的 Stable 注入是否只有一个固定槽位节点、只呈现当前 revision、旧节点被 replacement 遮蔽、注入成本不再增长、DSH runtime-context 通道为空？',
      verdictRule: 'fixed = 20 个 revision 各一次真实 step：每步请求恰好 1 条 slot 消息且只含当前 revision header；surface 可见 slot 节点恒为 1；第 k≥2 个 slot 节点是对上一节点的 replacement（sourceEventSeqs=[上一节点]，记录 oldRevision/newRevision/generation）；generation 严格递增；注入字节与 token 归因平坦（容差）；store 恒为 1 份最新 stable；DSH runtime-context 快照节点数 = 0；日志无删除。not-fixed = 任一步出现 ≥2 个可见 slot 节点，或请求含更早 revision header，或注入 token 随 revision 增长。inconclusive = fixture/route 未能产出证据。',
      measurement: 'REAL TaskStateBasicService（ctx.plugin，部署配置）+ REAL task-state-prompt 消费者（固定槽位）+ REAL 持久 storage domain（Storage+StorageJson+StorageDomain，root 在本目录）+ REAL SessionStore/SystemPrompt/ToolRuntime/AgentRegistry/SessionProjectionRegistry/LlmRuntime/TokenMeter + REAL DSH AgentLoop（从被审计 checkout 以原生 ESM import() 载入）。FAKE：唯一 LLM 是脚本化 adapter，不产出 provider usage，token 数字只来自真实 token-meter 的固定启发式定价。',
      baseline: {
        dshCommit: agentLoopModule.dshHead,
        note: 'B5.1 相对 E08 基线（插件 cf034b4b）**故意**改变了 production src：本目录 README 记录逐文件 sha256 漂移。',
      },
      command: 'pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/B5.1-E08修复后回归/b51-e08-regression.spec.ts --reporter=verbose',
      components: {
        agentLoop: agentLoopModule,
        promptConsumer: {
          module: 'src/internal/task-state/prompt/index.ts（经 src/task-state-prompt.ts 子路径挂载）',
          slotSourceKind: SLOT_SOURCE_KIND,
          slotId: SLOT_ID,
          reservedContext: 'task-state:snapshot（模板保留、变量恒为空串）',
          maxBytes: PROMPT_MAX_BYTES,
        },
        provider: { module: 'src/task-state-basic.ts（ctx.plugin）', config: CONFIG },
      },
      config: {
        ...CONFIG,
        promptMaxBytes: PROMPT_MAX_BYTES,
        revisionCount: REVISION_COUNT,
        seedsPerRevision: SEEDS_PER_REVISION,
        route: { provider: PROVIDER, model: MODEL, adapter: 'scripted fake（无 provider usage）' },
        sessionId: String(SESSION_ID),
        flatTokenTolerance: { absolute: FLAT_TOKEN_TOLERANCE_ABS, ratio: FLAT_TOKEN_TOLERANCE_RATIO },
      },
      surfaceRoute,
      iterations,
      growth,
      criteria: {
        fixedBeforeRun: true,
        routeWorked,
        surfaceIterations: complete.length,
        distinctStableRevisions: distinctRevisions.length,
        oneVisibleSlotEveryStep,
        oneSlotMessageEveryRequest,
        presentsOnlyCurrentRevision,
        onlyCurrentRevisionAnywhereInRequest,
        chainIsReplacement,
        generationsStrictlyIncreasing,
        dshChannelEmpty,
        storeHoldsOneLatest,
        nothingDeleted,
        injectionFlat,
        injectionBytesFlat,
        minInjectionTokens,
        maxInjectionTokens,
        evidenceComplete,
        verdict,
      },
      storeFinal: readStore(),
      verdict,
      errors,
      limitations: [
        'fake LLM：唯一模型是脚本化 adapter（task-state 请求返回固定结构候选 JSON，内容每次不同；agent 请求返回一段文本）。它不产出 `usage`，因此 provider token / 真实计费量 / 真实摘要语义均未测量；token 数字来自真实 dsh-token-meter 的固定启发式定价。',
        '模型路由被替换：部署 route（deepseek-official/deepseek-v4-flash）下注册的是 fake adapter，不是真实 provider。',
        'DSH AgentLoop 从被审计 checkout 的构建产物 lib/index.js 以原生 ESM import() 载入；其 sha256 记入 ledger.components.agentLoop。若该声明与实际不符，surface 层证据不成立。',
        '未挂载任何压缩插件：因此没有测“压缩遮蔽 slot 后重建”的真实端到端路径（该路径由 tests/task-state-prompt-fixed-slot.spec.ts 用真实 surface replacement 覆盖）。',
        '每次 revision 的 20 个人类 seed 由 fixture 直接 append 以跨过 minEvents=20 阈值；真实会话中这些事件来自人类与模型，数量与节奏不同。',
        'token 归因只统计**当前可见 slot 节点**的启发式 token；不含主线程压缩、其他插件注入或真实 provider 计费。',
        '“通过”只表示 fixture 断言通过，且只回答本文件第 1 节那一个问题。',
      ],
    }

    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    // ---- 结构性断言（fixture 按设计运行） ---------------------------------
    expect(agentLoopModule.imported, agentLoopModule.mountError ?? 'AgentLoop import failed').toBe(true)
    expect(errors).toEqual([])
    expect(iterations.length).toBe(REVISION_COUNT)
    expect(distinctRevisions.length).toBe(REVISION_COUNT)
    expect(oneVisibleSlotEveryStep).toBe(true)
    expect(oneSlotMessageEveryRequest).toBe(true)
    expect(presentsOnlyCurrentRevision).toBe(true)
    expect(onlyCurrentRevisionAnywhereInRequest).toBe(true)
    expect(chainIsReplacement).toBe(true)
    expect(generationsStrictlyIncreasing).toBe(true)
    expect(dshChannelEmpty).toBe(true)
    expect(storeHoldsOneLatest).toBe(true)
    expect(nothingDeleted).toBe(true)
    expect(injectionFlat).toBe(true)
    expect(injectionBytesFlat).toBe(true)
    expect(verdict).toBe('fixed')
  }, TEST_TIMEOUT_MS)
})
