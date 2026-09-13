/**
 * B7 · E09 对照观测（**post-fix**，只写本目录）
 *
 * 为什么需要这个文件
 * ------------------
 * 历史 `审计资料/实验结果/E09-ForkResume/`（判定 not-reproduced）的关键观测
 * `stageE.childFirstCommitIncludedSeqs = [1,2,3,5,11,13,19,21,24,25,26,28,31,32,33]`
 * （12 个继承前缀 eligible 事件 + 3 个自己的事件）是从 **v1 持久域文档**
 * `context_enhancement_task_state.json` 读出的。当前工作树的 provider 已改用
 * **v2** 域（`context_enhancement_task_state_v2.json`），因此把 E09 spec **逐字节**
 * 复制到本目录后，它的域读取路径取不到记录（stage E 全为 null），无法再观测该窗口。
 * 历史 E09 目录按纪律**一字未改**。
 *
 * 本 spec 用同一套**真实**栈复现 E09 的 A/C/E 阶段，并把等价观测写成
 * `e09-counterpart.json`，使 post-fix 的 child 首批窗口与历史值可以直接对照：
 *
 *   历史（pre-B7）：child 首批窗口 = 12 个继承 eligible 事件 + 3 个自己的事件
 *   post-fix（B7） ：child 首批窗口 = 只有自己的事件（继承前缀 0 个），base = null
 *
 * 真实组件：`SessionStore`（含真实 `ctx.sessions.fork`）、真实 JSONL Session 持久化、
 * 真实 `Storage`+`StorageJson`+`StorageDomain`（v2 域）、真实 `LlmRuntime` + 脚本化
 * adapter、真实 `TaskStateBasicService`。唯一 fake 是模型本身。
 *
 * 判定（运行前固定）：post-fix 契约 = child 首批窗口内不存在任何 seq <
 * `inheritedEventCount` 的 eligible 事件，`base` 为 null，且 durable stable 携带
 * `inherited.ownBoundarySeq === inheritedEventCount`。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskStateBasicService from '../../../src/task-state-basic.ts'
import type { TaskStateStable } from '../../../src/task-state.ts'
import { filterEvent, isEligibleType } from '../../../src/internal/task-state/basic/filter.ts'
import { rowsForLifecycle } from '../../../src/internal/task-state/contract/audit.ts'
import type { TaskStateAuditRecord } from '../../../src/internal/task-state/contract/audit.ts'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = join(OUT_DIR, 'tmp-counterpart-storage')
const SESSION_ROOT = join(OUT_DIR, 'tmp-counterpart-sessions')
const LEDGER_PATH = join(OUT_DIR, 'e09-counterpart.json')
const DOMAIN_FILE = 'context_enhancement_task_state_v2.json'
const PARENT_ID = SessionId('e09-counterpart-parent')
const CHILD_ID = SessionId('e09-counterpart-child')
const CREATED_AT = 1_700_000_000_000
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

/** Historical E09 observation this run is compared against (pre-B7 behaviour). */
const HISTORICAL_CHILD_FIRST_WINDOW = [1, 2, 3, 5, 11, 13, 19, 21, 24, 25, 26, 28, 31, 32, 33]

class ScriptAdapter extends LlmAdapter {
  readonly calls: string[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    this.calls.push(createHash('sha256').update(text).digest('hex').slice(0, 16))
    const body = JSON.stringify({
      facts: [{ content: 'E09 counterpart durable marker (folded window ended here).' }],
      decisions: [],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: 'E09 counterpart objective',
        currentFocus: 'E09 counterpart focus',
        openWork: [],
        nextActions: [],
      },
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Poll one predicate until it holds or the deadline elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`E09 counterpart: ${label} did not settle in time`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

/** Append one complete sealed turn; every appended seq in order. */
function appendTurn(session: Session, turn: number, text: string): number[] {
  return [
    session.append('turn/start', { turn }).seq,
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq,
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} (assistant)` }],
        source: { kind: 'model', provider: PROVIDER, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq,
    session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq,
  ]
}

/** Eligible, projectable seqs strictly below one boundary (the inherited prefix). */
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

describe('B7 · E09 对照：post-fix child 首批窗口只含自己的事件', () => {
  afterAll(() => {
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    rmSync(SESSION_ROOT, { recursive: true, force: true })
  })

  it('records the post-fix counterpart observation beside the historical E09 value', async () => {
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
    rmSync(SESSION_ROOT, { recursive: true, force: true })
    mkdirSync(STORAGE_ROOT, { recursive: true })
    mkdirSync(SESSION_ROOT, { recursive: true })

    const ctx = new Context()
    const adapter = new ScriptAdapter()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: SESSION_ROOT, compression: 'none', writeBatchMaxDelayMs: 1 })
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: STORAGE_ROOT })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(TaskStateBasicService, {
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
    })

    const parent = ctx.sessions.create(PARENT_ID, { meta: { cwd: SESSION_ROOT, createdAt: CREATED_AT } })
    const parentTurn = appendTurn(parent, 1, 'E09 counterpart parent turn one')
    await waitUntil(() => ctx.taskState.getStable(PARENT_ID) !== undefined, 8_000, 'parent first commit')
    const parentStable = ctx.taskState.getStable(PARENT_ID) as TaskStateStable

    const boundary = Number(parent.snapshotEvents().at(-1)!.seq)
    const child = ctx.sessions.fork(parent, SessionSeq(boundary), CHILD_ID)
    const cut = Number(child.inheritedEventCount)
    const childStableBeforeOwnEvents = ctx.taskState.getStable(CHILD_ID) ?? null
    const inheritedEligible = inheritedEligibleSeqs(parent, cut)

    const childTurn = appendTurn(child, 2, 'E09 counterpart child turn one')
    await waitUntil(() => ctx.taskState.getStable(CHILD_ID) !== undefined, 8_000, 'child first commit')
    await waitUntil(() => {
      const stable = ctx.taskState.getStable(CHILD_ID)
      return stable !== undefined && child.snapshotEvents()
        .filter(event => Number(event.seq) > stable.sourceCursor)
        .every(event => !isEligibleType(event.type))
    }, 8_000, 'child drain')
    const childStable = ctx.taskState.getStable(CHILD_ID) as TaskStateStable

    // The live audit table, fenced to the child lifecycle, is the post-fix
    // counterpart of E09's durable-domain child rows.
    const table = (ctx.get('taskState') as unknown as {
      auditTable?: { entries: () => IterableIterator<[string, TaskStateAuditRecord]> }
    }).auditTable
    const readChildRows = (): TaskStateAuditRecord[] => {
      const rows = table === undefined ? [] : [...table.entries()].map(entry => entry[1])
      return [...rowsForLifecycle(rows, {
        createdAt: child.header.createdAt,
        ...child.header.cwd === undefined ? {} : { cwd: child.header.cwd },
      })]
    }
    // The commit publishes its stable as soon as the authority put resolves; the
    // finished audit phase of that same row lands a moment later.
    await waitUntil(
      () => readChildRows().some(row => row.finished !== undefined),
      2_000,
      'child finished audit row',
    )
    const childRows = readChildRows()
    const firstRow = childRows.find(row => row.finished !== undefined)
    const includedSeqs = firstRow === undefined ? [] : [...firstRow.request.includedSeqs].map(Number)
    const inheritedInWindow = includedSeqs.filter(seq => seq < cut)
    const ownInWindow = includedSeqs.filter(seq => seq >= cut)
    const parentRowTotal = (table === undefined ? 0 : [...table.entries()].length)

    const doc = existsSync(join(STORAGE_ROOT, DOMAIN_FILE))
      ? JSON.parse(readFileSync(join(STORAGE_ROOT, DOMAIN_FILE), 'utf8')) as {
        tables: { sessions: Record<string, { stable?: TaskStateStable & { inherited?: unknown } }> }
      }
      : null
    const durableChildRecord = doc?.tables.sessions[String(CHILD_ID)] ?? null

    const observation = {
      experiment: 'B7 · E09 修复后对照（post-fix child first window）',
      invokedBy: '审计资料/实验结果/B7-E09修复后回归/b7-e09-counterpart.spec.ts',
      historical: {
        source: '审计资料/实验结果/E09-ForkResume/e09-ledger.json → stages.stageE.childFirstCommitIncludedSeqs',
        domainFile: 'context_enhancement_task_state.json (v1, retired in the current tree)',
        childFirstCommitIncludedSeqs: HISTORICAL_CHILD_FIRST_WINDOW,
        note: 'pre-B7: the child had no record, so its committed cursor started at -1 and its first window folded the WHOLE inherited prefix (12 inherited eligible seqs) plus its own turn',
      },
      postFix: {
        childInheritedCount: cut,
        childFirstLiveSeqAtFork: Number(child.firstLiveSeq),
        parentStableCursorAtFork: parentStable.sourceCursor,
        childStableBeforeOwnEvents,
        childFirstWindowIncludedSeqs: includedSeqs,
        childFirstWindowInheritedSeqCount: inheritedInWindow.length,
        childFirstWindowOwnSeqCount: ownInWindow.length,
        childFirstWindowBaseIsNull: firstRow?.request.base === null,
        childFirstWindowInheritedMarker: firstRow?.request.inherited ?? null,
        childFirstCursor: childStable.sourceCursor,
        childFirstRevision: childStable.revision,
        childStableInheritedMarker: childStable.inherited ?? null,
        inheritedPrefixEligibleSeqCount: inheritedEligible.length,
        inheritedPrefixEligibleSeqs: inheritedEligible,
        ownTurnSeqs: childTurn.map(Number),
        durableChildStableCursor: durableChildRecord?.stable?.sourceCursor ?? null,
        durableChildStableInherited: durableChildRecord?.stable?.inherited ?? null,
        auditRowsChild: childRows.length,
        auditRowsParent: parentRowTotal - childRows.length,
        taskStateModelCalls: adapter.calls.length,
      },
    }
    writeFileSync(LEDGER_PATH, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')

    // ---- post-fix contract (fixed before the run) ---------------------------
    expect(inheritedEligible.length).toBeGreaterThan(0)
    expect(childStableBeforeOwnEvents).toBeNull()
    expect(Number(child.firstLiveSeq)).toBe(cut)
    expect(includedSeqs.length).toBeGreaterThan(0)
    expect(inheritedInWindow).toEqual([])
    expect(ownInWindow.length).toBeGreaterThan(0)
    expect(Math.min(...includedSeqs)).toBeGreaterThanOrEqual(cut)
    expect(firstRow?.request.base).toBeNull()
    expect(firstRow?.request.inherited?.ownBoundarySeq).toBe(cut)
    expect(childStable.inherited?.ownBoundarySeq).toBe(cut)
    expect(childStable.sourceCursor).toBeGreaterThanOrEqual(cut)
    expect(durableChildRecord?.stable?.inherited).toEqual(childStable.inherited)

    await ctx.fiber.dispose()
  }, 120_000)
})
