/**
 * B5.2a · Stable fixed-slot 注入的独立预算 I、staleness 标记和请求/compaction token ledger 对账
 *
 * SPEC REQUIREMENTS
 * -----------------
 * 1. 预算 I 的单一配置/解析来源；maxBytes 与 maxTokens (I) 独立约束，支持真实 tokenMeter / estimateMessage 与保守 fallback；
 * 2. CJK 与 token/byte 差异覆盖；
 * 3. 权威最小表示（Goal/TODO 视图优先且不可被删除，超预算 typed fail closed/block）；
 * 4. 优先级截断（Evidence < Decisions/Facts < Constraints/Risks < Continuation < Authoritative Goal/TODO）；
 * 5. stale → fresh 转换（cursor 落后 eligible high-water 显示 stale marker，catch-up 后恢复 fresh）；
 * 6. compaction 安全预算 G 扣除当前可见 slot I / 实际注入 tokens（避免双扣）；
 * 7. provider usage 有/无两条对账路径进入 ledger；
 * 8. 预算变化触发 generation 单调递增的 replacement；
 * 9. 20 revisions token 平坦（slot 不线性累积）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '../src/compaction-basic.ts'
import { TaskStateBasicService } from '../src/task-state-basic.ts'
import { TaskStateEntryId, type TaskStateStable } from '../src/task-state.ts'
import * as TaskStatePrompt from '../src/task-state-prompt.ts'
import {
  TASK_STATE_STALE_MARKER,
  isTaskStateSlotSource,
} from '../src/internal/task-state/contract/index.ts'
import type { TaskStateSlotSource } from '../src/internal/task-state/contract/index.ts'
import {
  renderTaskStateSlot,
  resolveInjectionBudget,
} from '../src/internal/task-state/prompt/render.ts'
import {
  resolveEnvelopeBudget,
  resolveEnvelopeZoneBudget,
} from '../src/internal/compaction/envelope-budget.ts'

// ---------------------------------------------------------------------------
// Harness Fixture
// ---------------------------------------------------------------------------

class ScriptedAdapter extends LlmAdapter {
  calls = 0
  customPayload?: Record<string, unknown>

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const text = JSON.stringify(this.customPayload ?? {
      facts: [{ content: `fact ${this.calls}` }],
      decisions: [{ content: `decision ${this.calls}` }],
      constraints: [],
      risks: [],
      evidence: [],
      todoReferences: [],
      continuation: {
        currentObjective: `objective ${this.calls}`,
        currentFocus: `focus ${this.calls}`,
        openWork: [],
        nextActions: [],
      },
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly adapter: ScriptedAdapter
  readonly root: string
  promptFiber: { dispose: () => Promise<void> }
  turn: number
  step: number
}

let roots: string[] = []
let contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(options: {
  root: string
  sessionId: string
  createdAt: number
  promptConfig?: TaskStatePrompt.TaskStatePromptConfig
}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(options.root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TaskStateBasicService, {
    provider: 'current-route',
    model: 'current-model',
    minEvents: 1,
    maxEvents: 10,
    maxInputBytes: 100_000,
    maxOutputTokens: 4_000,
    timeoutMs: 5_000,
    maxInfraRetries: 0,
    maxEntriesPerKind: 10,
    maxEntryBytes: 2_000,
    maxListItems: 8,
  })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['current-route'], adapter)
  const promptFiber = await ctx.plugin(TaskStatePrompt, options.promptConfig ?? { maxBytes: 8_000, maxTokens: 512 })
  const session = ctx.sessions.create(SessionId(options.sessionId), {
    meta: { cwd: options.root, createdAt: options.createdAt },
  })
  return {
    ctx,
    session,
    agent: { session } as unknown as Agent,
    adapter,
    root: options.root,
    promptFiber: promptFiber as { dispose: () => Promise<void> },
    turn: 1,
    step: 1,
  }
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-b52a-injection-'))
  roots.push(root)
  return root
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('composition did not settle in time')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

function appendHuman(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

async function runStep(harness: Harness): Promise<{
  readonly requestMessages: readonly Message[]
  readonly preStepDecision: PreStepDecision
}> {
  const turn = harness.turn
  const step = harness.step
  harness.step += 1
  const decision = await harness.ctx.waterfall(
    'agent/pre-step',
    { agent: harness.agent, messages: [], turn, step, signal: new AbortController().signal },
    async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const msg of decision.messages) {
      harness.session.append('user/message', msg, { surfaceOp: 'append' })
    }
  }
  const requestMessages = harness.session.deriveMessages()
  harness.turn += 1
  harness.step = 1
  return { requestMessages, preStepDecision: decision }
}

function isSlotEvent(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && isTaskStateSlotSource((event.data as { readonly source?: unknown }).source)
}

function slotSourceOf(event: SessionEvent): TaskStateSlotSource {
  return (event.data as { readonly source: TaskStateSlotSource }).source
}

function visibleSlots(session: Session): SessionEvent[] {
  const nodes: SessionEvent[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event !== undefined && isSlotEvent(event)) nodes.push(event)
  }
  return nodes
}

function makeMinimalStable(revision = 1, sourceCursor = 1): TaskStateStable {
  return {
    schemaVersion: 2,
    filterVersion: 'filter-v1',
    revision,
    sourceCursor,
    digest: 'abcdef1234567890',
    goalView: {
      status: 'current',
      objective: 'Authoritative objective of the conversation',
      goalId: 'goal-1',
      goalRevision: 1,
      phase: 'execution',
    },
    todoView: {
      status: 'current',
      items: [
        { content: 'Authoritative item 1', status: 'in_progress' },
        { content: 'Authoritative item 2', status: 'pending' },
      ],
      sourceSeq: 10,
    },
    continuation: {
      currentObjective: 'continuation objective',
      currentFocus: 'continuation focus',
      openWork: ['open task A', 'open task B'],
      nextActions: ['next action 1', 'next action 2'],
    },
    facts: [
      { id: TaskStateEntryId('fact-11111111-1111-4111-8111-111111111111'), content: 'Fact line 1' },
      { id: TaskStateEntryId('fact-22222222-2222-4222-8222-222222222222'), content: 'Fact line 2' },
    ],
    decisions: [
      { id: TaskStateEntryId('decision-33333333-3333-4333-8333-333333333333'), content: 'Decision line 1' },
    ],
    constraints: [
      { id: TaskStateEntryId('constraint-44444444-4444-4444-8444-444444444444'), content: 'Constraint line 1' },
    ],
    risks: [
      { id: TaskStateEntryId('risk-55555555-5555-4555-8555-555555555555'), content: 'Risk line 1' },
    ],
    evidence: [
      { seq: 5, note: 'Supporting note for evidence' },
    ],
    todoReferences: [],
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('B5.2a: Stable fixed-slot injection budget I & ledger reconciliation', () => {

  describe('1. Single resolution source, token vs byte difference, and CJK', () => {
    it('resolves budget I with maxBytes and maxTokens as independent bounds', () => {
      const budget1 = resolveInjectionBudget({ maxBytes: 2048 })
      expect(budget1.maxBytes).toBe(2048)
      expect(budget1.maxTokens).toBe(512) // default token budget

      const budget2 = resolveInjectionBudget({ maxBytes: 1000, maxTokens: 150 })
      expect(budget2.maxBytes).toBe(1000)
      expect(budget2.maxTokens).toBe(150)
    })

    it('demonstrates token vs byte difference for ASCII where token budget binds first', () => {
      const stable = makeMinimalStable()
      // English text: length in bytes is roughly equal to character length.
      // 1 token ~= 4 characters in heuristic.
      // If maxBytes is very large (10,000 bytes) but maxTokens is restricted (120 tokens):
      // Full text is ~180 tokens, while authoritative minimum + marker is ~101 tokens.
      const render = renderTaskStateSlot(stable, {
        maxBytes: 10_000,
        maxTokens: 120,
      })

      expect(render.blocked).toBe(false)
      expect(render.truncation).toBe(true)
      expect(render.injectionTokens).toBeLessThanOrEqual(120)
      // Even though 10,000 bytes was allowed, text was truncated because of token budget I
      expect(render.budgetTokens).toBe(120)
    })

    it('demonstrates CJK multi-byte difference where byte budget binds before token budget', () => {
      const stable: TaskStateStable = {
        ...makeMinimalStable(),
        goalView: {
          status: 'current',
          objective: '中文任务目标',
          goalId: 'goal-cjk',
          goalRevision: 1,
        },
        todoView: {
          status: 'none',
          items: [],
        },
        continuation: {
          currentObjective: '',
          currentFocus: '',
          openWork: [],
          nextActions: [],
        },
        facts: [
          { id: TaskStateEntryId('fact-cjk-1111-1111-1111-111111111111'), content: '第一条事实：中文字符每个占用3个UTF-8字节，但在Token计量中按字符计价。' },
          { id: TaskStateEntryId('fact-cjk-2222-2222-2222-222222222222'), content: '第二条事实：如果在预算判定中假装1Token等于4字节，中文字符会被错误截断。' },
        ],
      }

      // In Chinese: Header (73 bytes) + Goal (32 bytes) + Goal identity (40 bytes) = 147 bytes.
      // With truncation marker (85 bytes), minimal truncated representation is 233 bytes.
      // With facts, full text is ~450 bytes.
      // If maxBytes: 260, maxTokens: 500:
      // In tokens, full text is only ~100 tokens (well under 500).
      // Byte budget binds!
      const renderBytesBound = renderTaskStateSlot(stable, {
        maxBytes: 260,
        maxTokens: 500,
      })
      expect(renderBytesBound.blocked).toBe(false)
      expect(renderBytesBound.truncation).toBe(true)
      expect(new TextEncoder().encode(renderBytesBound.text).byteLength).toBeLessThanOrEqual(260)

      // If maxBytes: 5000, maxTokens: 75:
      // Minimal truncated representation is ~67 tokens. Full text is ~150 tokens.
      // Token budget binds!
      const renderTokensBound = renderTaskStateSlot(stable, {
        maxBytes: 5000,
        maxTokens: 75,
      })
      expect(renderTokensBound.blocked).toBe(false)
      expect(renderTokensBound.truncation).toBe(true)
      expect(renderTokensBound.injectionTokens).toBeLessThanOrEqual(75)
    })
  })

  describe('2. Authoritative minimum representation and priority truncation', () => {
    it('preserves Authoritative Goal and TODO views while dropping low-priority sections', () => {
      const stable = makeMinimalStable()
      // Full rendering contains goal, todo, continuation, facts, decisions, constraints, risks, evidence
      const fullRender = renderTaskStateSlot(stable, { maxBytes: 10_000, maxTokens: 1_000 })
      expect(fullRender.truncation).toBe(false)
      expect(fullRender.text).toContain('Current goal:')
      expect(fullRender.text).toContain('TODO list')
      expect(fullRender.text).toContain('Evidence:')
      expect(fullRender.text).toContain('Facts:')

      // Restrict token budget so that lower-priority sections must be truncated
      const truncatedRender = renderTaskStateSlot(stable, { maxBytes: 10_000, maxTokens: 120 })
      expect(truncatedRender.truncation).toBe(true)
      // Authoritative goal and todo MUST be present and not deleted
      expect(truncatedRender.text).toContain('Current goal: Authoritative objective of the conversation')
      expect(truncatedRender.text).toContain('- [in_progress] Authoritative item 1')
      expect(truncatedRender.text).toContain('- [pending] Authoritative item 2')
      // Lowest priority evidence must be dropped first
      expect(truncatedRender.text).not.toContain('Evidence:')
      // Fixed truncation marker appended
      expect(truncatedRender.text).toContain('truncated; the committed durable state remains authoritative')
    })

    it('fails closed (typed block) when even authoritative minimum representation exceeds budget I', () => {
      const stable = makeMinimalStable()
      // Budget is ridiculously small (e.g. 10 tokens), smaller than Header + Goal + TODO
      const blockedRender = renderTaskStateSlot(stable, { maxBytes: 10_000, maxTokens: 10 })

      expect(blockedRender.blocked).toBe(true)
      expect(blockedRender.staleness).toBe('blocked')
      // Must NOT inject a misleading partial Goal or half-TODO
      expect(blockedRender.text).toBe('')
      expect(blockedRender.injectionTokens).toBe(0)
    })
  })

  describe('3. Staleness marker and fresh/stale transitions', () => {
    it('marks stale when stable cursor lags behind session eligible high-water and shows stale marker', () => {
      const stable = makeMinimalStable(1, 5) // sourceCursor = 5
      // Session has eligible high-water = 12
      const render = renderTaskStateSlot(stable, {
        maxBytes: 8_000,
        maxTokens: 512,
        eligibleHighWater: 12,
      })

      expect(render.staleness).toBe('stale')
      expect(render.eligibleHighWater).toBe(12)
      expect(render.text).toContain(TASK_STATE_STALE_MARKER)
    })

    it('recovers fresh and removes stale marker once catch-up revision catches up', () => {
      // Step 1: Cursor = 5, High-water = 12 -> Stale
      const staleRender = renderTaskStateSlot(makeMinimalStable(1, 5), {
        maxBytes: 8_000,
        maxTokens: 512,
        eligibleHighWater: 12,
      })
      expect(staleRender.staleness).toBe('stale')
      expect(staleRender.text).toContain(TASK_STATE_STALE_MARKER)

      // Step 2: Catch-up revision commits with cursor = 12 >= high-water 12 -> Fresh
      const freshRender = renderTaskStateSlot(makeMinimalStable(2, 12), {
        maxBytes: 8_000,
        maxTokens: 512,
        eligibleHighWater: 12,
      })
      expect(freshRender.staleness).toBe('fresh')
      expect(freshRender.text).not.toContain(TASK_STATE_STALE_MARKER)
    })
  })

  describe('4. Compaction safe budget G deduction and ledger reconciliation', () => {
    const COMPACTION_INPUT = {
      contextWindow: 1_000,
      responseReserveTokens: 150,
      safetyMarginTokens: 50,
      instructionTokens: 20,
      summaryMaxTokens: 80,
      retainTokens: 200,
      minRetainTokens: 100,
    }

    it('deducts slot injection tokens I from G exactly once without double deduction', () => {
      // Measurement with totalTokens = 500, surfaceTokens = 400.
      // E = 500 - 400 = 100.
      // Without slot injection tokens (injectionTokens = 0):
      // G = 1000 - E(100) - R(150) - M(50) = 700.
      const budgetWithoutSlot = resolveEnvelopeBudget({ totalTokens: 500, surfaceTokens: 400 }, COMPACTION_INPUT)
      expect(budgetWithoutSlot.envelopeTokens).toBe(100)
      expect(budgetWithoutSlot.surfaceGrantTokens).toBe(700)

      // With visible slot injectionTokens = 60:
      // G = 1000 - E(100) - R(150) - M(50) - I(60) = 640.
      const budgetWithSlot = resolveEnvelopeBudget(
        { totalTokens: 500, surfaceTokens: 400 },
        { ...COMPACTION_INPUT, injectionTokens: 60 },
      )
      // E remains 100 (slot is on surface, not double-counted into envelope)
      expect(budgetWithSlot.envelopeTokens).toBe(100)
      expect(budgetWithSlot.injectionTokens).toBe(60)
      // G is reduced by exactly 60
      expect(budgetWithSlot.surfaceGrantTokens).toBe(640)
      // Summarizer cap is also reduced safely
      expect(budgetWithSlot.summarizerInputCapTokens).toBe(640 - 20 - 80)
    })

    it('deducts slot tokens in zone budget and includes in envelope-dominated trigger', () => {
      const zoneInput = {
        pressureTokens: 800,
        forgetWatermarkTokens: 700,
        forgetBoundaryTokens: 250,
        retainTokens: 200,
        minRetainTokens: 100,
        injectionTokens: 80,
      }
      const zoneBudget = resolveEnvelopeZoneBudget({ totalTokens: 500, surfaceTokens: 400 }, zoneInput)
      // E = 100
      // waterlineGrant = 700 - E(100) - I(80) = 520
      expect(zoneBudget.envelopeTokens).toBe(100)
      expect(zoneBudget.injectionTokens).toBe(80)
      expect(zoneBudget.waterlineGrantTokens).toBe(520)
    })

    it('reconciles ledger with both provider usage present and provider usage missing', async () => {
      const root = await newRoot()
      const harness = await mount({
        root,
        sessionId: 'ledger-reconcile-session',
        createdAt: 1000,
        promptConfig: { maxBytes: 8_000, maxTokens: 100 },
      })

      // Commit one human event to trigger task state
      appendHuman(harness.session, 'User request for task state generation')
      await waitUntil(() => (harness.ctx.get('taskState')?.getStable(harness.session.id)?.revision ?? 0) >= 1)

      // Pre-step maintains the slot
      await runStep(harness)

      const engine = new BasicCompactionEngine(harness.ctx, {
        pressureRatio: 0.8,
      })

      // Case A: Missing provider usage (heuristic baseline)
      const heuristicMeasurement: TokenMeasurement = {
        logRevision: SessionLogOffset(harness.session.snapshotEvents().length),
        baseline: { kind: 'estimated', tokens: 400 },
        surfaceDeltaTokens: 0,
        totalTokens: 450,
        surfaceTokens: 350,
        nodes: harness.session.surface.nodes.map(seq => ({ seq, tokens: 25, heuristicTokens: 25 })),
      }
      const ledgerHeuristic = engine.inspectLedger(harness.session, heuristicMeasurement)
      expect(ledgerHeuristic.usageBaseline).toBe(false)
      expect(ledgerHeuristic.injectionTokens).toBeGreaterThan(0)

      // Case B: Provider usage present
      const usageMeasurement: TokenMeasurement = {
        logRevision: SessionLogOffset(harness.session.snapshotEvents().length),
        baseline: { kind: 'usage', tokens: 400, usage: { inputTokens: 350, outputTokens: 50, totalTokens: 400 } },
        surfaceDeltaTokens: 0,
        totalTokens: 450,
        surfaceTokens: 350,
        nodes: harness.session.surface.nodes.map(seq => ({ seq, tokens: 25, heuristicTokens: 25 })),
      }
      const ledgerUsage = engine.inspectLedger(harness.session, usageMeasurement)
      expect(ledgerUsage.usageBaseline).toBe(true)
      expect(ledgerUsage.injectionTokens).toBeGreaterThan(0)
    })
  })

  describe('5. Monotonic generation on budget change', () => {
    it('advances generation with a replacement when injection budget changes', async () => {
      const root = await newRoot()
      const harness = await mount({
        root,
        sessionId: 'budget-change-session',
        createdAt: 2000,
        promptConfig: { maxBytes: 8_000, maxTokens: 400 },
      })

      appendHuman(harness.session, 'first instruction')
      await waitUntil(() => (harness.ctx.get('taskState')?.getStable(harness.session.id)?.revision ?? 0) >= 1)

      // Step 1: Initial slot creation
      await runStep(harness)
      const initialSlots = visibleSlots(harness.session)
      expect(initialSlots.length).toBe(1)
      const source1 = slotSourceOf(initialSlots[0]!)
      expect(source1.generation).toBe(1)
      expect(source1.budgetTokens).toBe(400)

      // Remount prompt plugin with changed budget: maxTokens = 60
      await harness.promptFiber.dispose()
      harness.promptFiber = await harness.ctx.plugin(TaskStatePrompt, { maxBytes: 8_000, maxTokens: 60 })

      // Step 2: Maintenance sees budget change, text changes -> replacement with generation = 2
      await runStep(harness)
      const replacedSlots = visibleSlots(harness.session)
      expect(replacedSlots.length).toBe(1) // exactly one visible slot
      const source2 = slotSourceOf(replacedSlots[0]!)
      expect(source2.generation).toBe(2)
      expect(source2.budgetTokens).toBe(60)
      expect(source2.truncation).toBe(true)
    })
  })

  describe('6. 20 revisions token flatness and source metadata completeness', () => {
    it('maintains exactly ONE visible slot with bounded, flat token consumption across 20 revisions', async () => {
      const root = await newRoot()
      const harness = await mount({
        root,
        sessionId: 'flatness-session',
        createdAt: 3000,
        promptConfig: { maxBytes: 8_000, maxTokens: 250 },
      })

      let lastGen = 0
      const tokenPrices: number[] = []

      for (let rev = 1; rev <= 20; rev += 1) {
        appendHuman(harness.session, `Advance event for revision ${rev}`)
        await waitUntil(() => (harness.ctx.get('taskState')?.getStable(harness.session.id)?.revision ?? 0) >= rev)

        await runStep(harness)

        // Verify exactly one slot node on surface
        const currentSlots = visibleSlots(harness.session)
        expect(currentSlots.length).toBe(1)

        const source = slotSourceOf(currentSlots[0]!)
        expect(source.generation).toBeGreaterThan(lastGen)
        lastGen = source.generation
        expect(source.revision).toBe(rev)
        expect(source.budgetTokens).toBe(250)
        expect(source.staleness).toBe('fresh')
        expect(typeof source.eligibleHighWater).toBe('number')
        expect(source.injectionTokens).toBeLessThanOrEqual(250)

        tokenPrices.push(source.injectionTokens!)
      }

      // 20 revisions: tokens should be flat (within constant budget, not growing 20x)
      const minTokens = Math.min(...tokenPrices)
      const maxTokens = Math.max(...tokenPrices)
      expect(maxTokens - minTokens).toBeLessThan(100)
    })
  })
})
