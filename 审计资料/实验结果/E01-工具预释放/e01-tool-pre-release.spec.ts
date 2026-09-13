/**
 * E01 · 工具区预释放 / tool-zone pre-release (L1, fake token meter + fake LLM +
 * temporary Session + REAL temporary storage domain)
 *
 * EXPERIMENT QUESTION (the only one)
 * ----------------------------------
 * When a REAL temporary storage domain makes `toolGroupAuditStore` available,
 * does the 40%–70% tool-maintenance tier actually perform tool-group
 * summarization (op①) on qualifying complete tool groups — and is that path
 * mutually exclusive with tool pruning (op②)?
 *
 * WHY THIS SPEC EXISTS (E00 阶段评审 §4.2 第 5 条 / §6 第 5 条)
 * ------------------------------------------------------------
 * The first-round harness (`../harness/compaction-harness.ts`) hard-codes
 * `toolGroupAuditStore: undefined` and a no-op `summarizeToolGroups`, so under it
 * op① can NEVER run: `compactIfNeeded` line ~451 gates on `this.toolGroupAuditStore`
 * being defined. The E00 review therefore rejected that fixture as evidence for
 * tool summarization and required: "应使用临时 storage，或者明确只测裁剪分支".
 * This spec uses temporary storage.
 *
 * The harness file is NOT modified (it is read-only for this experiment). It also
 * cannot be consumed as-is for this route, because neither its engine seam nor its
 * fixture handle exposes or accepts an audit store. E01 therefore reuses the
 * harness PATTERN — a plain engine object holding the production `config` and a
 * fake `ctx`, with every production seam invoked through
 * `BasicCompactionEngine.prototype` — inside this E01-local spec only, and adds
 * exactly the two seams the harness stubbed out:
 *
 *   - `toolGroupAuditStore`  = the REAL store from `openToolGroupAuditStore(ctx)`,
 *                              backed by a real `dsh-storage` hub + JSON backend +
 *                              domain facility rooted INSIDE this E01 directory;
 *   - `summarizeToolGroups`  = the REAL `BasicCompactionEngine.prototype.summarizeToolGroups`.
 *
 * Nothing in `src/`, `tests/`, `package.json`, `vitest.config.ts`, `lib/`, the tgz,
 * the harness or any other experiment directory is touched.
 *
 * REAL in this spec
 * -----------------
 * - the storage hub: `Storage` + `StorageJson` + `StorageDomain`, mounted in the
 *   restart-recovery order, at a temporary root inside this E01 directory;
 * - `openToolGroupAuditStore(ctx)` and therefore the durable
 *   `context_enhancement_tool_group_summary` domain and its `audit` table;
 * - `summarizeToolGroups`: group selection (`selectToolGroups` + the engine's own
 *   `toolGroupSelectionOptions`), fingerprinting, audit open/finish, the stability
 *   assertion, `summarizeToolGroup`'s route/cap checks, `replaceToolGroup` (per-node
 *   shrink guard + shadow-price protocol) and `commitToolGroupSuccess`;
 * - `compactIfNeeded` (the real entry point, `trigger='pressure'`), `zones`,
 *   `envelopeBudget`, `envelopeZoneBudget`, `sourceIndex`, `retainedTailFloorTokens`;
 * - the op② call site: the real candidate computation
 *   (`zones.tool.slice(startIndex).filter(index.isOriginalToolResult)`) and the real
 *   `pruneSession` invocation with its `onReplacement` bookkeeping.
 *
 * FAKE in this spec
 * -----------------
 * - the token meter: every price is `ceil(codePoints / 4)` chosen by this fixture, so
 *   a "token" here is NOT a provider token (`E = 0`);
 * - the LLM: a scripted adapter that answers ONLY the tool-group summary call with a
 *   structurally valid, strictly smaller summary. Its `usage` is absent.
 *
 * VERDICT RULE (fixed before the run)
 * -----------------------------------
 * As fixed by the E01 protocol:
 *   reproduced      = op① really executed against the real store, committed a durable
 *                     replacement, AND op② did not process that same successful group
 *                     (while op② was demonstrably live on other tool-zone work);
 *   not-reproduced  = the route ran end to end but those conditions do not all hold;
 *   inconclusive    = the fixture/runner/storage mount could not produce the evidence;
 *   design-confirmed = static-design evidence only, no dynamic ledger.
 * The plan document (`审计资料/32-运行时复现实验方案.md` §5 E01) fixes a DIFFERENT
 * reading of `reproduced` (the defect: qualifying candidates with no replacement, a
 * candidate crossing zones, or a successful summary being pruned). Both are computed
 * into the ledger (`criteria.verdictFromCriteria` and `criteria.planSection5Verdict`)
 * so neither reading has to be inferred. A normal tool/result replacement is NEVER
 * counted as tool-summary evidence: only a `success` audit record written through the
 * real store, whose `replacementSeqs` are on the surface, counts.
 *
 * FIXTURE SHAPE (fixture tokens, NOT provider tokens)
 * ---------------------------------------------------
 *   contextWindow 100 000 -> tool watermark 40% (40 000), forget watermark 70%
 *   (70 000), pressure trigger 80% (80 000); forget boundary 50% (50 000);
 *   retained tail R0 = 20 000 (20%); reserve 8 192 + margin 2 048.
 *   turn 1 (completed): 5 x assistant/message x 2 000          = 10 000  (forget zone)
 *   turn 2 (completed): 3 complete tool groups + 4 spacers      = 30 000  (tool zone)
 *     each group: 2 x (assistant tool-call 55 + tool/result 2 000) = 4 110
 *     spacer S1 2 000 | S2 1 000 | S3 1 000 | S4 13 670
 *   turn 3 (completed): 1 x assistant/message x 12 000          = 12 000
 *   turn 4 (OPEN)     : 1 x assistant/message x  8 000          =  8 000
 *   -> total 60 000 fixture tokens = 60.0% of the window: inside 40%–70%, BELOW the
 *      70% forget watermark, so the pass may only govern the tool zone.
 *   Three groups qualify; `maxGroupsPerPass = 2` (production default) means op①
 *   summarizes the two oldest and the third stays raw — which is what makes the op②
 *   exclusion check non-vacuous.
 *
 * See `../harness/compaction-harness.ts` (read-only, unmodified) for the shared
 * seam pattern and `../../E03-压力抖动/` for this experiment line's ledger style.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'

import { BasicCompactionEngine } from '../../../src/compaction-basic.ts'
import { openToolGroupAuditStore } from '../../../src/internal/compaction/tool-group-audit-store.ts'
import type { ToolGroupAuditStore } from '../../../src/internal/compaction/tool-group-audit-store.ts'
import { servedReplacementSeqs } from '../../../src/internal/compaction/tool-group-audit.ts'
import type { ToolGroupAuditRecord } from '../../../src/internal/compaction/tool-group-audit.ts'
import { buildSurfaceSourceIndex } from '../../../src/internal/compaction/source-index.ts'
import type { SurfaceSourceIndex } from '../../../src/internal/compaction/source-index.ts'
import { selectToolGroups } from '../../../src/internal/compaction/tool-groups.ts'
import type { ToolGroup, ToolGroupSelectionOptions } from '../../../src/internal/compaction/tool-groups.ts'
import { compactSurfaceRegion } from '../../../src/internal/compaction/region.ts'
import { summarizeWithLlm } from '../../../src/internal/compaction/summarizer.ts'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../../../src/internal/compaction/config.ts'
import type { SurfaceZones } from '../../../src/internal/compaction/zones.ts'

// ---------------------------------------------------------------------------
// Fixed policy / fixture constants
// ---------------------------------------------------------------------------

const CONTEXT_WINDOW = 100_000
/** `floor(contextWindow * toolMaintenanceRatio 0.40)` — the tool-stage gate. */
const TOOL_WATERMARK_TOKENS = 40_000
/** `floor(contextWindow * forgetMaintenanceRatio 0.70)` — ordinary maintenance gate. */
const FORGET_WATERMARK_TOKENS = 70_000
/** `floor(contextWindow * pressureRatio 0.80)`. */
const PRESSURE_THRESHOLD_TOKENS = 80_000
/** `floor(contextWindow * forgetBoundaryRatio 0.50)`. */
const FORGET_BOUNDARY_TOKENS = 50_000
/** `floor(contextWindow * recentRatio 0.20)`. */
const RETAIN_TOKENS = 20_000

/** Fixture character-per-token rule. NOT a provider token (see header). */
const CHARS_PER_TOKEN = 4

/** The session lifecycle identity the real audit store filters on. */
const CREATED_AT = 1_700_000_000_000

const PROVIDER = 'mock-route'
const MODEL = 'mock-model'
const ROUTE = { provider: PROVIDER, model: MODEL }

const HISTORY_TURN = 1
const TOOL_TURN = 2
const LAST_COMPLETED_TURN = 3
const OPEN_TURN = 4

/** Turn 1: the forget zone, exactly 10 000 tokens. */
const HISTORY_STEPS = 5
const HISTORY_STEP_TOKENS = 2_000
/** Each tool group: 2 results of 2 000 tokens + 2 calls of 55 tokens. */
const RESULTS_PER_GROUP = 2
const RESULT_CHARS = 8_000
const CALL_COMMAND_CHARS = 200
const GROUP_TOKENS = RESULTS_PER_GROUP * (RESULT_CHARS / CHARS_PER_TOKEN)
  + RESULTS_PER_GROUP * 55
/** Turn 2 spacers, chosen so the tool zone is exactly 30 000 tokens. */
const SPACER_1_TOKENS = 2_000
const SPACER_2_TOKENS = 1_000
const SPACER_3_TOKENS = 1_000
const GROUPS = 3
const TOOL_ZONE_TOKENS = 30_000
const SPACER_4_TOKENS = TOOL_ZONE_TOKENS
  - SPACER_1_TOKENS - SPACER_2_TOKENS - SPACER_3_TOKENS - GROUPS * GROUP_TOKENS
const LAST_COMPLETED_TOKENS = 12_000
const OPEN_TURN_TOKENS = 8_000

const EXPECTED_TOTAL_TOKENS = HISTORY_STEPS * HISTORY_STEP_TOKENS
  + TOOL_ZONE_TOKENS + LAST_COMPLETED_TOKENS + OPEN_TURN_TOKENS

/** Production default `toolGroupSummarizer.maxGroupsPerPass`. */
const MAX_GROUPS_PER_PASS = 2
/** Fraction of the original text the E01 fake pruner keeps. */
const PRUNER_KEEP_RATIO = 0.1

const SURFACE = { surfaceOp: 'append' as const }
const INPUT_MARKER = 'INPUT:\n'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const LEDGER_PATH = join(OUT_DIR, 'e01-ledger.json')
const STORAGE_ROOT = join(OUT_DIR, 'tmp-storage')

// ---------------------------------------------------------------------------
// Fixture pricing (fixture tokens only)
// ---------------------------------------------------------------------------

/** Code points of every text-bearing part of one message content array. */
function contentTextLength(content: readonly unknown[]): number {
  let chars = 0
  for (const raw of content) {
    const block = raw as {
      readonly type?: string
      readonly text?: string
      readonly name?: string
      readonly arguments?: string
      readonly content?: unknown
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length
      continue
    }
    if (block.type === 'tool-call') {
      chars += (block.name?.length ?? 0) + (block.arguments?.length ?? 0)
      continue
    }
    if (block.type === 'tool-result') {
      const inner = block.content
      if (typeof inner === 'string') chars += inner.length
      else if (Array.isArray(inner)) chars += contentTextLength(inner)
    }
  }
  return chars
}

/** The fixture's own estimator: `ceil(codePoints / 4)`, at least 1. */
function estimateMessage(message: { readonly content: readonly unknown[] }): number {
  return Math.max(1, Math.ceil(contentTextLength(message.content) / CHARS_PER_TOKEN))
}

/** `RESULT-<label> ` + filler, exactly `chars` code points long. */
function resultText(label: string, chars: number): string {
  const prefix = `RESULT-${label} `
  return prefix + 'G'.repeat(Math.max(1, chars - prefix.length))
}

// ---------------------------------------------------------------------------
// The scripted tool-group summary adapter (the ONLY LLM call in this spec)
// ---------------------------------------------------------------------------

interface GroupSummaryRequestRecord {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number | undefined
  readonly purpose: string | undefined
  readonly sessionId: string | undefined
  readonly inputChars: number
  readonly inputTokens: number
  readonly group: {
    readonly sourceSeqs: readonly number[]
    readonly toolResultSeqs: readonly number[]
    readonly callIds: readonly string[]
    readonly turn: number
    readonly estimatedTokens: number
  }
  readonly itemCount: number
  readonly outputChars: number
  readonly outputTokens: number
  readonly outputText: string
  readonly parsedSummaryItems: number
}

/**
 * Answers the tool-group summary request with a structurally valid, strictly
 * smaller `ToolGroupSummary` derived from the request's own `INPUT` payload.
 * Facts are copied verbatim out of the source text so the production
 * `assertFactsBelongToInput` provenance check really runs.
 */
class ToolGroupSummaryAdapter extends LlmAdapter {
  readonly requests: GroupSummaryRequestRecord[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages
      .flatMap(message => message.content as readonly ContentBlock[])
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    const at = text.lastIndexOf(INPUT_MARKER)
    if (at < 0) throw new Error('E01 fixture: tool-group summary request carries no INPUT payload')
    const input = JSON.parse(text.slice(at + INPUT_MARKER.length)) as {
      readonly group: GroupSummaryRequestRecord['group']
      readonly items: readonly {
        readonly sourceSeq: number
        readonly callId?: string
        readonly role: 'tool-call' | 'tool-result'
        readonly content: string
      }[]
    }
    const items = input.items.map(item => {
      const match = /RESULT-[A-Za-z0-9_-]+/.exec(item.content)
      const fact = item.role === 'tool-result'
        ? match?.[0]
        : item.content.split(' ')[0]
      return {
        sourceSeq: item.sourceSeq,
        ...item.callId === undefined ? {} : { callId: item.callId },
        summary: `distilled ${item.role} at seq ${item.sourceSeq}`,
        facts: fact === undefined || fact.length === 0 ? [] : [fact],
        files: [] as string[],
        identifiers: [] as string[],
        errors: [] as string[],
        unresolved: [] as string[],
      }
    })
    const body = JSON.stringify({
      version: 1,
      groupSummary: `tool group of ${items.length} nodes reduced before the history pass`,
      items,
      groupErrors: [],
      unresolved: [],
    })
    this.requests.push({
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      purpose: options.purpose,
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      inputChars: text.length,
      inputTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
      group: input.group,
      itemCount: input.items.length,
      outputChars: body.length,
      outputTokens: Math.ceil(body.length / CHARS_PER_TOKEN),
      outputText: body,
      parsedSummaryItems: items.length,
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// ---------------------------------------------------------------------------
// Ledger row shapes
// ---------------------------------------------------------------------------

interface ZoneRow {
  readonly forgetStartIndex: number
  readonly forgetEndIndex: number
  readonly forgetTokens: number
  readonly toolStartIndex: number
  readonly toolEndIndex: number
  readonly toolTokens: number
  readonly recentStartIndex: number
  readonly toolStartSeq: number | null
  readonly toolEndSeq: number | null
  readonly recentTokens: number
  readonly retainedTailTokens: number
  readonly forgetBoundaryTokens: number
  readonly summarizerInputCapTokens: number
}

interface CandidateGroupRow {
  readonly index: number
  readonly startSeq: number
  readonly endSeq: number
  readonly startPosition: number
  readonly endPosition: number
  readonly sourceSeqs: readonly number[]
  readonly toolResultSeqs: readonly number[]
  readonly callIds: readonly string[]
  readonly estimatedTokens: number
  readonly fullyInsideToolZone: boolean
}

interface PruneCallRow {
  readonly call: number
  readonly olderRange: { readonly start: number; readonly end: number } | null
  readonly candidateSeqs: readonly number[]
  readonly candidateSourceKinds: readonly string[]
  readonly pruned: readonly {
    readonly originalSeq: number
    readonly replacementSeq: number
    readonly charsBefore: number
    readonly charsAfter: number
  }[]
  readonly charsRemoved: number
  readonly op1ShadowedSeqsVisibleAtEntry: readonly number[]
  readonly op1ReplacementSeqsVisibleAtEntry: readonly number[]
  readonly surfaceKindsAtEntry: Readonly<Record<string, number>>
  readonly zonesAtEntry: ZoneRow | null
  readonly overlapWithOp1Sources: readonly number[]
  readonly overlapWithOp1Replacements: readonly number[]
}

/** Project one production zone partition into a ledger row. */
function zoneRow(zones: SurfaceZones, retainedTailTokens: number, forgetBoundaryTokens: number, cap: number): ZoneRow {
  return {
    forgetStartIndex: zones.forget?.startIndex ?? -1,
    forgetEndIndex: zones.forget?.endIndex ?? -1,
    forgetTokens: zones.forget?.tokens ?? 0,
    toolStartIndex: zones.tool?.startIndex ?? -1,
    toolEndIndex: zones.tool?.endIndex ?? -1,
    toolTokens: zones.tool?.tokens ?? 0,
    recentStartIndex: zones.recent?.startIndex ?? -1,
    toolStartSeq: zones.tool === null ? null : Number(zones.tool.startSeq),
    toolEndSeq: zones.tool === null ? null : Number(zones.tool.endSeq),
    recentTokens: zones.recent?.tokens ?? 0,
    retainedTailTokens,
    forgetBoundaryTokens,
    summarizerInputCapTokens: cap,
  }
}

/** Every `compaction/prune` shadowed seq currently in the session log, in order. */
function shadowedSeqsOf(session: Session): number[] {
  const seqs: number[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'compaction/prune') continue
    for (const seq of event.data.shadowedSeqs) seqs.push(Number(seq))
  }
  return seqs
}

/** Count one label per current surface node for the ledger. */
function kindCounts(labels: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1
  return counts
}

/** Sorted intersection of two number lists. */
function intersection(left: readonly number[], right: readonly number[]): number[] {
  const other = new Set(right)
  return [...new Set(left)].filter(value => other.has(value)).sort((a, b) => a - b)
}

/** Recursively list regular files under one directory, relative to `base`. */
function listFiles(base: string, dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) listFiles(base, full, out)
    else out.push(relative(base, full))
  }
  return out
}

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

describe('E01 · tool-zone pre-release with a REAL toolGroupAuditStore', () => {
  it('runs one 40%–70% tool maintenance and records whether op① commits and stays out of op②', async () => {
    const sessionId = `e01-tool-pre-release-${randomUUID()}`
    const limitationNotes: string[] = [
      'token 是 fixture 计价（code points / 4），不是 provider token；E = 0，无真实 system prompt / 工具 schema / runtime envelope。可迁移的是比例形状，不是绝对数字。',
      'fake LLM：只验证结构、请求/输出体积与缩减关系，不验证摘要语义质量；facts 由 fixture 从源文本中逐字复制以满足生产 provenance 断言。',
      'summary 的 usage 未观测（fake adapter 不产生 usage），故 provider token 与真实计费量不可得。',
      '触发口径为 trigger="pressure"（生产同一入口同时承载 40%/70% 与 80% 两档）；本 fixture 只构造 40%–70% 档，未触发 overflow recovery。',
      '真实 DSH 会话中工具组的形状、大小分布、以及真实会话是否达到 40%–70% 档从未被本实验测量；本实验构造的是"合格完整工具组位于工具区"这一条件。',
      '单进程、单 Session、单次维护调用：不代表真实调度下的触发频率、并发或重启行为。',
      'toolGroupAuditStore 由 E01 目录内的临时 JSON storage domain 提供（真实 dsh-storage 组件 + 真实 openToolGroupAuditStore），不是生产 $DSH_HOME 下的实例。',
      'op②（裁剪）由 fixture 的 fake pruner 实现：它按生产候选集与 onReplacement 协议被调用，用于观测互斥性，不是生产 ToolResultPruner 的字节。',
      'E01 的 engine 是 harness 的 seam 模式（plain object + BasicCompactionEngine.prototype），不是通过 ctx.plugin 挂载的真实 BasicCompactionEngine 实例；真实的是 op①/op② 方法体、zones/budget、以及 storage domain。',
    ]

    // ---- temporary storage INSIDE this E01 directory ----------------------
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })

    const ctx = new Context()
    let storageMounted = false
    let storageError: string | null = null
    let store: ToolGroupAuditStore | undefined
    let storeError: string | null = null
    const mountOrder: string[] = []

    try {
      await ctx.plugin(LlmRuntime)
      mountOrder.push('LlmRuntime')
      const adapter = new ToolGroupSummaryAdapter()
      ctx.llm.registerAdapter([PROVIDER], adapter)
      // restart-recovery mount order: hub -> JSON backend -> domain facility.
      await ctx.plugin(Storage)
      mountOrder.push('Storage')
      await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
      mountOrder.push(`StorageJson(root=${relative(process.cwd(), STORAGE_ROOT)})`)
      await ctx.plugin(StorageDomain, { backend: 'json' })
      mountOrder.push('StorageDomain(backend=json)')
      storageMounted = true

      try {
        store = await openToolGroupAuditStore(ctx)
      } catch (error: unknown) {
        storeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }

      // ---------------------------------------------------------------------
      // Fixture session: a real Session with an explicit lifecycle createdAt so
      // the real audit store's `recordsForSession(sessionId, createdAt)` filter
      // can match its own records.
      // ---------------------------------------------------------------------
      const session = Session.create(SessionId(sessionId), [], {
        version: 0,
        id: SessionId(sessionId),
        createdAt: CREATED_AT,
        isSeeded: false,
      })
      session.append('request/header', {
        header: { config: { provider: PROVIDER, model: MODEL } },
        reason: 'initial',
      })

      const appendAssistantText = (turn: number, step: number, chars: number): SessionSeq =>
        session.append('assistant/message', {
          turn,
          step,
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'text', text: 'H'.repeat(chars) }],
            source: { kind: 'model', provider: PROVIDER, model: MODEL },
          }),
        }, SURFACE).seq

      const appendToolCall = (turn: number, step: number, callId: string, commandChars: number): SessionSeq =>
        session.append('assistant/message', {
          turn,
          step,
          message: createMessage({
            role: 'assistant',
            content: [{
              type: 'tool-call',
              id: ToolCallId(callId),
              name: 'bash',
              arguments: JSON.stringify({ command: 'C'.repeat(commandChars) }),
            }],
            source: { kind: 'model', provider: PROVIDER, model: MODEL },
          }),
        }, SURFACE).seq

      const appendToolResult = (turn: number, step: number, callId: string, label: string, chars: number): SessionSeq =>
        session.append('tool/result', {
          turn,
          step,
          message: createToolResultMessage({
            callId: ToolCallId(callId),
            content: [{ type: 'text', text: resultText(label, chars) }],
            isError: false,
          }),
        }, SURFACE).seq

      // turn 1 (completed) — the forget zone
      session.append('turn/start', { turn: HISTORY_TURN })
      for (let step = 1; step <= HISTORY_STEPS; step += 1) {
        appendAssistantText(HISTORY_TURN, step, HISTORY_STEP_TOKENS * CHARS_PER_TOKEN)
      }
      session.append('turn/end', { turn: HISTORY_TURN, reason: { kind: 'completed' } })

      // turn 2 (completed) — the tool zone: 3 complete, qualifying tool groups
      session.append('turn/start', { turn: TOOL_TURN })
      const groupLabels = ['A', 'B', 'C'] as const
      const groupSeqRecords: { label: string; sourceSeqs: number[]; toolResultSeqs: number[] }[] = []
      let toolStep = 0
      appendAssistantText(TOOL_TURN, ++toolStep, SPACER_1_TOKENS * CHARS_PER_TOKEN)
      for (const label of groupLabels) {
        const sourceSeqs: number[] = []
        const toolResultSeqs: number[] = []
        for (let member = 1; member <= RESULTS_PER_GROUP; member += 1) {
          const callId = `e01-${label}${member}`
          sourceSeqs.push(Number(appendToolCall(TOOL_TURN, ++toolStep, callId, CALL_COMMAND_CHARS)))
          toolResultSeqs.push(Number(appendToolResult(TOOL_TURN, toolStep, callId, `${label}${member}`, RESULT_CHARS)))
        }
        groupSeqRecords.push({ label, sourceSeqs, toolResultSeqs })
        if (label === 'A') appendAssistantText(TOOL_TURN, ++toolStep, SPACER_2_TOKENS * CHARS_PER_TOKEN)
        if (label === 'B') appendAssistantText(TOOL_TURN, ++toolStep, SPACER_3_TOKENS * CHARS_PER_TOKEN)
      }
      appendAssistantText(TOOL_TURN, ++toolStep, SPACER_4_TOKENS * CHARS_PER_TOKEN)
      session.append('turn/end', { turn: TOOL_TURN, reason: { kind: 'completed' } })

      // turn 3 (completed, the retained last completed turn)
      session.append('turn/start', { turn: LAST_COMPLETED_TURN })
      appendAssistantText(LAST_COMPLETED_TURN, 1, LAST_COMPLETED_TOKENS * CHARS_PER_TOKEN)
      session.append('turn/end', { turn: LAST_COMPLETED_TURN, reason: { kind: 'completed' } })

      // turn 4 (OPEN, the retained current turn)
      session.append('turn/start', { turn: OPEN_TURN })
      appendAssistantText(OPEN_TURN, 1, OPEN_TURN_TOKENS * CHARS_PER_TOKEN)

      // ---------------------------------------------------------------------
      // The fake meter: prices every CURRENT surface node from its own message.
      // Replacement nodes are priced by the same rule, so unlike the shared
      // harness a landed replacement is not priced 0.
      // ---------------------------------------------------------------------
      const measure = (target: Session = session): TokenMeasurement => {
        const nodes = target.surface.nodes.map(seq => {
          const event = target.eventAt(seq)
          const message = (event?.data as { message?: { content: readonly unknown[] } } | undefined)?.message
          const tokens = message === undefined ? 0 : estimateMessage(message)
          return { seq, tokens, heuristicTokens: tokens }
        })
        const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
        return {
          totalTokens: surfaceTokens,
          surfaceTokens,
          nodes,
          logRevision: 0,
          baseline: { kind: 'estimated' as const, tokens: 0 },
          surfaceDeltaTokens: surfaceTokens,
        } as unknown as TokenMeasurement
      }

      // ---------------------------------------------------------------------
      // The fake pruner (op②): records every call, then reduces every candidate
      // exactly like the shared harness's pruner does.
      // ---------------------------------------------------------------------
      const pruneCalls: PruneCallRow[] = []
      let zonesAtPruneEntry: ZoneRow | null = null
      const pruneShadowedBefore: number[][] = []
      const fakePruner = {
        config: { thresholdChars: 8_000 },
        measureMessageText: (content: readonly ContentBlock[]) => contentTextLength(content),
        pruneSession: (
          target: Session,
          pruneOptions: {
            readonly olderRange?: { readonly start: SessionSeq; readonly end: SessionSeq }
            readonly candidateSeqs?: readonly SessionSeq[]
            readonly onReplacement?: (entry: { replacementSeq: SessionSeq }) => void
          },
        ) => {
          const shadowedAtEntry = shadowedSeqsOf(target)
          pruneShadowedBefore.push(shadowedAtEntry)
          const candidates = [...(pruneOptions.candidateSeqs ?? [])].map(Number)
          const index = surfaceIndex(target)
          const kindsAtEntry = target.surface.nodes.map(seq => surfaceLabel(target, index, seq))
          // The exact post-op① geometry op② is handed: op① has already rewritten
          // the surface and this is the fresh partition the engine re-derived.
          const measuredAtEntry = measure(target)
          const zoneBudgetAtEntry = prototype.envelopeZoneBudget.call(engine, target, measuredAtEntry, spec)
          const budgetAtEntry = prototype.envelopeBudget.call(engine, target, measuredAtEntry, spec)
          zonesAtPruneEntry = zoneRow(
            prototype.zones.call(engine, target, measuredAtEntry, spec),
            zoneBudgetAtEntry.retainedTailTokens,
            zoneBudgetAtEntry.forgetBoundaryTokens,
            budgetAtEntry.summarizerInputCapTokens,
          )
          const pruned: {
            originalSeq: number
            replacementSeq: number
            charsBefore: number
            charsAfter: number
          }[] = []
          let charsRemoved = 0
          for (const seq of pruneOptions.candidateSeqs ?? []) {
            const event = target.eventAt(seq)
            if (event?.type !== 'tool/result') continue
            const originalContent = event.data.message.content
            const blockIndex = originalContent.findIndex(block => block.type === 'tool-result')
            if (blockIndex === -1) continue
            const charsBefore = contentTextLength(originalContent)
            const kept = Math.max(64, Math.floor(charsBefore * PRUNER_KEEP_RATIO))
            const text = `[pruned] ${'p'.repeat(Math.max(1, kept - 9))}`
            // Mirror `src/tool-result-pruner.ts` / `replaceToolGroup`: the
            // replacement must PRESERVE the message identity and block structure.
            // (An `id`-minting `createToolResultMessage` would be rejected by the
            // Session's own guard, which allows a tool/result rewrite to change
            // "only content".)
            const reduced = originalContent.map((messageBlock, index) =>
              index === blockIndex
                ? { ...messageBlock, content: [{ type: 'text' as const, text }] }
                : messageBlock) as typeof originalContent
            const message = freezeMessage({ ...event.data.message, content: reduced })
            target.append('compaction/prune', {
              shadowedRange: { start: seq, end: seq },
              shadowedSeqs: [seq],
              shadowedTokenCount: estimateMessage(event.data.message),
            })
            const replacement = target.append('tool/result', {
              ...event.data,
              message,
            }, {
              surfaceOp: { op: 'replace' as const, start: seq, end: seq },
              sourceEventSeqs: [seq],
            })
            pruned.push({
              originalSeq: Number(seq),
              replacementSeq: Number(replacement.seq),
              charsBefore,
              charsAfter: text.length,
            })
            charsRemoved += charsBefore - text.length
            pruneOptions.onReplacement?.({ replacementSeq: replacement.seq })
          }
          pruneCalls.push({
            call: pruneCalls.length + 1,
            olderRange: pruneOptions.olderRange === undefined
              ? null
              : { start: Number(pruneOptions.olderRange.start), end: Number(pruneOptions.olderRange.end) },
            candidateSeqs: candidates,
            candidateSourceKinds: candidates.map(seq => {
              const event = target.eventAt(seq as SessionSeq)
              return event === undefined ? 'missing' : surfaceLabel(target, index, seq as SessionSeq)
            }),
            pruned,
            charsRemoved,
            op1ShadowedSeqsVisibleAtEntry: [...new Set(shadowedAtEntry)],
            op1ReplacementSeqsVisibleAtEntry: [
              ...new Set(servedReplacementSeqs(storeRecords()).map(Number)),
            ],
            surfaceKindsAtEntry: kindCounts(kindsAtEntry),
            zonesAtEntry: zonesAtPruneEntry,
            overlapWithOp1Sources: [],
            overlapWithOp1Replacements: [],
          })
          return { pruned, charsRemoved }
        },
      }

      // ---------------------------------------------------------------------
      // Engine seam: the harness pattern, with op① wired to the REAL store and
      // the REAL production method.
      // ---------------------------------------------------------------------
      const config = resolveConfig({
        auto: false,
        toolGroupSummarizer: { enabled: true },
        maxMaintenanceBatches: 1,
        maxPressureBatches: 2,
      })
      const spec = resolveCompactSpec(resolveTargetPolicy(config, ROUTE), CONTEXT_WINDOW)

      const regionCalls: { start: number; end: number }[] = []
      const resultEvents: (string | null)[] = []
      const invocationErrors: string[] = []

      const engine = {
        config,
        ctx: {
          tokenMeter: { measure, estimateMessage },
          llm: {
            resolveModelInfo: async () => ({ context: { contextWindow: CONTEXT_WINDOW } }),
            stream: (generateOptions: GenerateOptions) => ctx.llm.stream(generateOptions),
          },
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
          get: (key: string) => (key === 'toolResultPruner' ? fakePruner : undefined),
        },
        // The two seams the shared harness stubs out — here they are REAL.
        toolGroupAuditStore: store,
        toolGroupAuditStorePromise: Promise.resolve(),
        summaryRequests: 0,
        pressureStops: new WeakMap(),
        compactRegion: async (start: SessionSeq, end: SessionSeq, owner: Agent, signal?: AbortSignal) => {
          regionCalls.push({ start: Number(start), end: Number(end) })
          return compactSurfaceRegion(
            {
              meter: { measure, estimateMessage },
              summarize: (input, summarizeAgent, summarizeSignal) =>
                summarizeWithLlm(
                  ctx,
                  { summarizationProvider: PROVIDER, summarizationModel: MODEL, maxTokens: config.maxTokens },
                  input,
                  summarizeAgent,
                  summarizeSignal,
                ),
            },
            owner.session,
            start,
            end,
            owner,
            { owner: 'current-turn', stability: 'whole-surface' },
            signal,
          )
        },
      }

      const seams = engine as unknown as Record<string, unknown>
      const prototype = BasicCompactionEngine.prototype as unknown as {
        zones: (session: Session, priced: TokenMeasurement, spec: unknown) => SurfaceZones
        envelopeBudget: (session: Session, priced: TokenMeasurement, spec: unknown) => { summarizerInputCapTokens: number }
        envelopeZoneBudget: (session: Session, priced: TokenMeasurement, spec: unknown) => { retainedTailTokens: number; forgetBoundaryTokens: number }
        sourceIndex: (session: Session) => SurfaceSourceIndex
        toolGroupSelectionOptions: (
          olderRange: { start: SessionSeq; end: SessionSeq },
          inputCapTokens: number | undefined,
          index: SurfaceSourceIndex,
          session?: Session,
        ) => ToolGroupSelectionOptions
        toolGroupFingerprint: (session: Session, group: ToolGroup) => string
        cappedMaxGroupTokens: (maxGroupTokens: number, inputCapTokens: number | undefined) => number
        summarizeToolGroups: (
          agent: Agent,
          target: { provider: string; model: string },
          policy: unknown,
          olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
          signal: AbortSignal,
          roundReplacements: Set<SessionSeq>,
          inputCapTokens?: number,
        ) => Promise<void>
        compactIfNeeded: (agent: Agent, trigger: string, signal: AbortSignal) => Promise<unknown>
        commitToolGroupSuccess: (
          store: ToolGroupAuditStore,
          requestId: string,
          patch: { rawOutput: unknown; summary: unknown; replacementSeqs: readonly SessionSeq[] },
        ) => Promise<void>
      }

      seams['zones'] = (session: Session, priced: TokenMeasurement) => prototype.zones.call(engine, session, priced, spec)
      seams['envelopeBudget'] = (session: Session, priced: TokenMeasurement) =>
        prototype.envelopeBudget.call(engine, session, priced, spec)
      seams['envelopeZoneBudget'] = (session: Session, priced: TokenMeasurement) =>
        prototype.envelopeZoneBudget.call(engine, session, priced, spec)
      seams['sourceIndex'] = (session: Session) => prototype.sourceIndex.call(engine, session)
      seams['toolGroupSelectionOptions'] = (
        olderRange: { start: SessionSeq; end: SessionSeq },
        inputCapTokens: number | undefined,
        index: SurfaceSourceIndex,
        session?: Session,
      ) => prototype.toolGroupSelectionOptions.call(engine, olderRange, inputCapTokens, index, session)
      seams['toolGroupFingerprint'] = (session: Session, group: ToolGroup) =>
        prototype.toolGroupFingerprint.call(engine, session, group)
      seams['cappedMaxGroupTokens'] = (maxGroupTokens: number, inputCapTokens: number | undefined) =>
        prototype.cappedMaxGroupTokens.call(engine, maxGroupTokens, inputCapTokens)
      seams['summarizeToolGroups'] = (
        agent: Agent,
        target: { provider: string; model: string },
        policy: unknown,
        olderRange: { startSeq: SessionSeq; endSeq: SessionSeq } | null,
        signal: AbortSignal,
        roundReplacements: Set<SessionSeq>,
        inputCapTokens?: number,
      ) => prototype.summarizeToolGroups.call(
        engine, agent, target, policy, olderRange, signal, roundReplacements, inputCapTokens,
      )
      seams['hasPendingToolIntermediateWork'] = () => 'none'
      seams['internalFindFirstToolStageDebtIndex'] = () => null
      seams['pressurePassTerminated'] = () => false
      seams['stopEnvelopeBudgetPass'] = () => {}
      seams['logPressureStop'] = () => {}
      seams['commitToolGroupSuccess'] = (
        targetStore: ToolGroupAuditStore,
        requestId: string,
        patch: { rawOutput: unknown; summary: unknown; replacementSeqs: readonly SessionSeq[] },
      ) => prototype.commitToolGroupSuccess.call(engine, targetStore, requestId, patch)

      const storeRecords = (): readonly ToolGroupAuditRecord[] => store === undefined
        ? []
        : store.recordsForSession(sessionId, CREATED_AT)

      const surfaceIndex = (target: Session): SurfaceSourceIndex =>
        buildSurfaceSourceIndex(target, servedReplacementSeqs(storeRecords()))

      const surfaceLabel = (target: Session, index: SurfaceSourceIndex, seq: SessionSeq): string => {
        const event = target.eventAt(seq)
        if (event === undefined) return 'missing'
        if (event.type === 'tool/result') {
          const entry = index.entries.get(seq)
          return `tool/result:${entry?.kind ?? 'unindexed'}`
        }
        if (event.type === 'assistant/message') {
          return event.data.message.content.some(block => block.type === 'tool-call')
            ? 'assistant/tool-call'
            : 'assistant/text'
        }
        return event.type
      }

      const agent = { session, options: ROUTE } as unknown as Agent

      // ---- pre-run geometry and the actor's OWN candidate selection --------
      const before = measure()
      const zonesBefore = prototype.zones.call(engine, session, before, spec)
      const zoneBudgetBefore = prototype.envelopeZoneBudget.call(engine, session, before, spec)
      const budgetBefore = prototype.envelopeBudget.call(engine, session, before, spec)
      const indexBefore = prototype.sourceIndex.call(engine, session)
      const candidateGroups = zonesBefore.tool === null
        ? []
        : selectToolGroups(session, prototype.toolGroupSelectionOptions.call(
          engine,
          { start: zonesBefore.tool.startSeq, end: zonesBefore.tool.endSeq },
          budgetBefore.summarizerInputCapTokens,
          indexBefore,
          session,
        ))
      const candidateGroupRows: CandidateGroupRow[] = candidateGroups.map((group, index) => ({
        index,
        startSeq: Number(group.startSeq),
        endSeq: Number(group.endSeq),
        startPosition: group.startPosition,
        endPosition: group.endPosition,
        sourceSeqs: group.sourceSeqs.map(Number),
        toolResultSeqs: group.toolResultSeqs.map(Number),
        callIds: [...group.callIds],
        estimatedTokens: group.estimatedTokens,
        fullyInsideToolZone: zonesBefore.tool !== null
          && group.startPosition >= zonesBefore.tool.startIndex
          && group.endPosition <= zonesBefore.tool.endIndex,
      }))

      // ---- the single tool maintenance invocation --------------------------
      let resultSummary: string | null = null
      try {
        zonesAtPruneEntry = null
        const result = await prototype.compactIfNeeded.call(engine, agent, 'pressure', new AbortController().signal)
        resultSummary = result === null ? 'null' : 'compaction-result'
        resultEvents.push(resultSummary)
      } catch (error: unknown) {
        resultSummary = null
        invocationErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      }

      // ---- post-run geometry and durable audit state -----------------------
      const after = measure()
      const zonesAfter = prototype.zones.call(engine, session, after, spec)
      const budgetAfter = prototype.envelopeBudget.call(engine, session, after, spec)
      const records = storeRecords()
      const servedSeqs = servedReplacementSeqs(records).map(Number)
      const indexAfter = buildSurfaceSourceIndex(session, servedReplacementSeqs(records))
      const allShadowedAfter = shadowedSeqsOf(session)
      // op①'s shadowed source nodes, taken two independent ways: the shadow-price
      // events already durable at op②'s entry, and the REAL audit records' group
      // source seqs narrowed to their tool/result members.
      const op1ShadowedSeqsAtPruneEntry = [...new Set(pruneShadowedBefore.flat())].sort((a, b) => a - b)
      const op1ShadowedSeqsFromStore = [...new Set(
        records.flatMap(record => record.sourceSeqs.map(Number)),
      )].filter(seq => session.eventAt(seq as SessionSeq)?.type === 'tool/result').sort((a, b) => a - b)
      const op1ShadowedSeqs = op1ShadowedSeqsFromStore.length > 0
        ? op1ShadowedSeqsFromStore
        : op1ShadowedSeqsAtPruneEntry
      const op2ShadowedSeqs = allShadowedAfter.filter(seq => !op1ShadowedSeqsAtPruneEntry.includes(seq))
      const op1ReplacementSeqs = [...new Set(servedSeqs.filter(seq => session.surface.nodes.includes(seq as SessionSeq)))]
      const prunerCandidates = pruneCalls.flatMap(call => call.candidateSeqs)
      const prunerPrunedSeqs = pruneCalls.flatMap(call => call.pruned.map(entry => entry.originalSeq))

      // Fill in the per-call exclusion fields now that op①'s seqs are known.
      for (const call of pruneCalls) {
        const mutable = call as unknown as {
          op1ShadowedSeqsVisibleAtEntry: number[]
          overlapWithOp1Sources: number[]
          overlapWithOp1Replacements: number[]
        }
        mutable.overlapWithOp1Sources = intersection(call.candidateSeqs, op1ShadowedSeqs)
        mutable.overlapWithOp1Replacements = intersection(call.candidateSeqs, op1ReplacementSeqs)
      }

      const afterSurface = session.surface.nodes.map(seq => ({
        seq: Number(seq),
        label: surfaceLabel(session, indexAfter, seq),
        tokens: estimateMessage(
          (session.eventAt(seq)?.data as { message?: { content: readonly unknown[] } }).message
            ?? { content: [] },
        ),
      }))

      // ---- criteria (fixed before the run) ---------------------------------
      const successRecords = records.filter(record => record.status === 'success')
      const openWithReplacements = records.filter(record =>
        record.status === 'open' && (record.replacementSeqs?.length ?? 0) > 0)
      const op1Executed = candidateGroupRows.length > 0 && adapter.requests.length > 0
      const op1CommittedReplacement = op1ShadowedSeqs.length > 0
        && op1ReplacementSeqs.length > 0
        && (successRecords.length > 0 || openWithReplacements.length > 0)
      const storeRealAndDurable = store !== undefined && records.length > 0
      const op2Live = pruneCalls.length > 0
      const op2SawOtherToolZoneWork = prunerCandidates.length > 0
      const op2TouchedOp1Group = intersection(
        [...prunerCandidates, ...prunerPrunedSeqs],
        [...op1ShadowedSeqs, ...op1ReplacementSeqs],
      )

      const routeFailed = !storageMounted || store === undefined || storeError !== null
      const verdictFromCriteria = routeFailed || invocationErrors.length > 0
        ? 'inconclusive'
        : (op1Executed && op1CommittedReplacement && storeRealAndDurable && op2Live
            && op2SawOtherToolZoneWork && op2TouchedOp1Group.length === 0)
          ? 'reproduced'
          : 'not-reproduced'

      // The plan document's own §5 E01 reading of `reproduced` (the defect).
      const planNoReplacementDespiteCandidates = candidateGroupRows.length > 0 && op1ReplacementSeqs.length === 0
      const planCandidatesOutOfZone = candidateGroupRows.some(group => !group.fullyInsideToolZone)
      const planSuccessfulSummaryPruned = op2TouchedOp1Group.length > 0
      const planSection5Verdict = planNoReplacementDespiteCandidates || planCandidatesOutOfZone || planSuccessfulSummaryPruned
        ? 'reproduced'
        : 'not-reproduced'

      // ---- durable storage evidence on disk --------------------------------
      await ctx.fiber.dispose().catch(() => {})
      const storageFiles = listFiles(STORAGE_ROOT, STORAGE_ROOT)
      const storageFileDigests = storageFiles.map((path) => {
        const raw = readFileSync(join(STORAGE_ROOT, path), 'utf8')
        return { path, bytes: raw.length, prefix: raw.slice(0, 400) }
      })

      const ledger = {
        experiment: 'E01-tool-pre-release',
        measurement: 'fake token meter (fixture tokens: ceil(codePoints/4)), fake LLM, temporary Session, REAL temporary dsh-storage domain + REAL toolGroupAuditStore',
        invokedAs: "BasicCompactionEngine.prototype.compactIfNeeded(engineSeam, agent, 'pressure', signal)",
        harnessPolicy: {
          sharedHarness: '审计资料/实验结果/harness/compaction-harness.ts',
          modified: false,
          reusedAsIs: false,
          reason: 'the shared harness hard-codes toolGroupAuditStore: undefined and a no-op summarizeToolGroups, and exposes neither its engine seam nor a store parameter, so op① can never run under it; E01 reuses its seam PATTERN in this E01-local spec instead (see E00 §4.2.5 / §6.5)',
          prunerOptionReused: false,
          prunerOptionNote: 'the harness `pruner` option builds its replacement with createToolResultMessage(...), which mints a FRESH message id (dsh-llm createMessage). The Session guard for a tool/result surface rewrite allows the replacement to change "only content", so that construction is rejected with `tool/result surface replacement may change only content` — observed directly in this run\'s first attempt. E01 therefore builds its pruner replacement the way BOTH production writers do (src/tool-result-pruner.ts and src/internal/compaction/tool-group-replacement.ts): freezeMessage({ ...original, content: reduced }).',
        },
        storage: {
          mountOrder,
          mounted: storageMounted,
          mountError: storageError,
          tempRootRelative: relative(process.cwd(), STORAGE_ROOT),
          backend: 'json',
          domain: 'context_enhancement_tool_group_summary',
          domainVersion: 1,
          storeOpened: store !== undefined,
          storeError,
          auditRecordsReturned: records.length,
          auditRecords: records.map(record => ({
            requestId: record.requestId,
            status: record.status,
            provider: record.provider,
            model: record.model,
            lifecycleCreatedAt: record.lifecycle?.createdAt ?? null,
            sourceSeqs: record.sourceSeqs.map(Number),
            replacementSeqs: (record.replacementSeqs ?? []).map(Number),
            fingerprint: record.fingerprint,
            error: record.error ?? null,
            summaryItems: record.summary === undefined ? null : record.summary.items.length,
          })),
          filesOnDisk: storageFileDigests,
        },
        policy: {
          contextWindow: CONTEXT_WINDOW,
          toolMaintenanceWatermarkTokens: TOOL_WATERMARK_TOKENS,
          forgetMaintenanceWatermarkTokens: FORGET_WATERMARK_TOKENS,
          pressureThresholdTokens: PRESSURE_THRESHOLD_TOKENS,
          forgetBoundaryTokens: FORGET_BOUNDARY_TOKENS,
          retainTokens: RETAIN_TOKENS,
          responseReserveTokens: config.responseReserveTokens,
          safetyMarginTokens: config.safetyMarginTokens,
          maxTokens: config.maxTokens,
          toolGroupSummarizer: config.toolGroupSummarizer,
          trigger: 'pressure',
          note: "the harness passes trigger='pressure'; in production that same entry point carries the 40%/70% and 80% tiers, and the 40%-70% branch is what E01 exercises",
        },
        fixture: {
          sessionId,
          lifecycleCreatedAt: CREATED_AT,
          totalTokens: before.totalTokens,
          totalRatio: before.totalTokens / CONTEXT_WINDOW,
          envelopeTokens: before.totalTokens - before.surfaceTokens,
          turnLayout: [
            `turn ${HISTORY_TURN} (completed): ${HISTORY_STEPS} x assistant x ${HISTORY_STEP_TOKENS} = ${HISTORY_STEPS * HISTORY_STEP_TOKENS}`,
            `turn ${TOOL_TURN} (completed): ${GROUPS} tool groups x ${GROUP_TOKENS} + spacers ${SPACER_1_TOKENS}/${SPACER_2_TOKENS}/${SPACER_3_TOKENS}/${SPACER_4_TOKENS} = ${TOOL_ZONE_TOKENS}`,
            `turn ${LAST_COMPLETED_TURN} (completed): 1 x assistant x ${LAST_COMPLETED_TOKENS}`,
            `turn ${OPEN_TURN} (OPEN): 1 x assistant x ${OPEN_TURN_TOKENS}`,
          ],
          groupSeqRecords,
          pricingRule: `fixture code points / ${CHARS_PER_TOKEN} — fixture tokens, NOT provider tokens; E = 0`,
        },
        zonesBefore: zoneRow(
          zonesBefore,
          zoneBudgetBefore.retainedTailTokens,
          zoneBudgetBefore.forgetBoundaryTokens,
          budgetBefore.summarizerInputCapTokens,
        ),
        candidateGroups: candidateGroupRows,
        toolMaintenance: {
          invocationCount: 1,
          invocationErrors,
          returned: resultSummary,
          tier: before.totalTokens >= TOOL_WATERMARK_TOKENS && before.totalTokens < FORGET_WATERMARK_TOKENS
            ? 'tool-maintenance-40-70'
            : 'outside-40-70',
          semanticCompactionSpansCommitted: regionCalls.length,
          summaryRequests: adapter.requests,
          op1ShadowedSourceSeqs: op1ShadowedSeqs,
          op1ShadowedSourceSeqsFromStore: op1ShadowedSeqsFromStore,
          op1ShadowedSourceSeqsAtPruneEntry: op1ShadowedSeqsAtPruneEntry,
          op1ReplacementSeqs,
          allShadowedSeqsAfterRun: allShadowedAfter,
        },
        prunePass: {
          started: pruneCalls.length > 0,
          calls: pruneCalls,
          prunerCandidates: prunerCandidates,
          prunerPrunedOriginalSeqs: prunerPrunedSeqs,
          prunerCreatedReplacements: pruneCalls.flatMap(call => call.pruned.map(entry => entry.replacementSeq)),
          op2OwnShadowedSeqs: op2ShadowedSeqs,
          overlapCandidatesWithOp1Sources: intersection(prunerCandidates, op1ShadowedSeqs),
          overlapCandidatesWithOp1Replacements: intersection(prunerCandidates, op1ReplacementSeqs),
          op1GroupSeqSets: groupSeqRecords,
        },
        after: {
          totalTokens: after.totalTokens,
          surfaceTokens: after.surfaceTokens,
          netReleasedTokens: before.totalTokens - after.totalTokens,
          netReleaseRatio: (before.totalTokens - after.totalTokens) / before.totalTokens,
          zonesAfter: zoneRow(
            zonesAfter,
            prototype.envelopeZoneBudget.call(engine, session, after, spec).retainedTailTokens,
            prototype.envelopeZoneBudget.call(engine, session, after, spec).forgetBoundaryTokens,
            budgetAfter.summarizerInputCapTokens,
          ),
          surface: afterSurface,
          surfaceLabelCounts: kindCounts(afterSurface.map(node => node.label)),
        },
        criteria: {
          fixedBeforeRun: true,
          verdictRule: 'reproduced = op① really executed against the real store, committed a durable replacement, and op② did not process that same successful group (while op② was demonstrably live on other tool-zone work)',
          op1Executed,
          op1CommittedReplacement,
          storeRealAndDurable,
          op2Live,
          op2SawOtherToolZoneWork,
          op2TouchedOp1Group,
          routeFailed,
          verdictFromCriteria,
          planSection5Criteria: {
            definition: '工具区有合格候选却无 replacement，或候选越区、成功摘要又被裁剪，则 reproduced',
            noReplacementDespiteCandidates: planNoReplacementDespiteCandidates,
            candidateGroupsOutOfZone: planCandidatesOutOfZone,
            successfulSummaryPruned: planSuccessfulSummaryPruned,
            verdict: planSection5Verdict,
          },
        },
        limitations: limitationNotes,
      }

      writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

      // ---- structural invariants (the fixture ran as designed) -------------
      expect(storageError).toBeNull()
      expect(storeError).toBeNull()
      expect(store).toBeDefined()
      expect(before.totalTokens).toBe(EXPECTED_TOTAL_TOKENS)
      expect(before.totalTokens).toBe(60_000)
      expect(before.totalTokens / CONTEXT_WINDOW).toBeGreaterThanOrEqual(0.4)
      expect(before.totalTokens / CONTEXT_WINDOW).toBeLessThanOrEqual(0.7)
      expect(ledger.toolMaintenance.tier).toBe('tool-maintenance-40-70')

      // The zone partition must sit exactly as designed: forget 10 000 (turn 1),
      // tool 30 000 (turn 2), recent 20 000 (turns 3+4).
      expect(zonesBefore.forget?.tokens).toBe(10_000)
      expect(zonesBefore.tool?.tokens).toBe(30_000)
      expect(zonesBefore.recent?.tokens).toBe(20_000)
      expect(zonesBefore.tool?.startIndex).toBe(zonesBefore.forget === null ? 0 : zonesBefore.forget.endIndex + 1)

      // Three complete qualifying groups live inside the tool zone; the actor's
      // own selection is capped at the production maxGroupsPerPass.
      expect(candidateGroupRows.length).toBe(MAX_GROUPS_PER_PASS)
      expect(candidateGroupRows.every(group => group.fullyInsideToolZone)).toBe(true)
      expect(candidateGroupRows.every(group =>
        group.toolResultSeqs.length >= config.toolGroupSummarizer.minGroupResults)).toBe(true)
      expect(candidateGroupRows.every(group =>
        group.estimatedTokens >= config.toolGroupSummarizer.minGroupTokens
        && group.estimatedTokens <= config.toolGroupSummarizer.maxGroupTokens)).toBe(true)

      // The 40%-70% tier must not commit any semantic history compaction.
      expect(regionCalls.length).toBe(0)
      expect(resultSummary).toBe('null')

      // ---- E01 verdict criteria -------------------------------------------
      expect(invocationErrors).toEqual([])
      expect(op1Executed).toBe(true)
      expect(op1CommittedReplacement).toBe(true)
      expect(storeRealAndDurable).toBe(true)
      expect(adapter.requests.length).toBe(op1ReplacementSeqs.length / RESULTS_PER_GROUP)
      expect(successRecords.length).toBeGreaterThanOrEqual(1)
      // The two independent derivations of op①'s shadowed sources agree.
      expect(op1ShadowedSeqsFromStore).toEqual(op1ShadowedSeqsAtPruneEntry)
      expect(op1ShadowedSeqs.length).toBe(MAX_GROUPS_PER_PASS * RESULTS_PER_GROUP)

      // op② ran and was live on remaining tool-zone originals...
      expect(op2Live).toBe(true)
      expect(op2SawOtherToolZoneWork).toBe(true)
      // ...but never touched the group op① had already summarized.
      expect(op2TouchedOp1Group).toEqual([])
      expect(ledger.prunePass.overlapCandidatesWithOp1Sources).toEqual([])
      expect(ledger.prunePass.overlapCandidatesWithOp1Replacements).toEqual([])

      // The replacements carry REAL tool-summary provenance from the store.
      const replacementKinds = op1ReplacementSeqs.map(seq =>
        indexAfter.entries.get(seq as SessionSeq)?.kind ?? 'unindexed')
      expect(replacementKinds.every(kind => kind === 'tool-summary')).toBe(true)

      // before/after totals both fell and the release is real.
      expect(after.totalTokens).toBeLessThan(before.totalTokens)
      expect(ledger.after.netReleasedTokens).toBeGreaterThan(0)

      expect(verdictFromCriteria).toBe('reproduced')
    } finally {
      await ctx.fiber.dispose().catch(() => {})
    }
  }, 120_000)
})
