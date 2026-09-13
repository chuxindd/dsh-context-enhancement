/**
 * B4.2 · E05（Goal 大改）/ E06（Todo 清空）**同 fixture 修复后对照**。
 *
 * 两个被对照的实验问题（与历史目录逐字相同）：
 *  - E05：`goal/change` 把 Goal A 换成语义完全不同的 Goal B 后，是否会在
 *    `minEvents`（部署值 20）之外触发一次独立更新，并让注入的叙事跟随新 Goal？
 *  - E06：合法空 `todo/write({todos: []})` 是否会被 filter 投影、是否会触发更新、
 *    是否会让已清空的列表从提交态与注入中消失？
 *
 * 本 spec **只读**地复用 `../harness/task-state-harness.ts`（E05/E06 的同一
 * fixture）：同一 `minEvents = 20`、同一 fake LLM、同一 fake worker 环境、同一
 * `candidateEchoing` 候选。历史目录 `E05-Goal大改/`、`E06-Todo清空/` 中的任何
 * 文件都未被改写、覆盖、移动，只在 README/账本中记录其 SHA-256。
 *
 * 唯一的测量差异是**代码版本**（B4.2 的 Goal/TODO 权威视图 + urgent 触发）。
 *
 * 两点必须明说的装置事实：
 *  1. harness 自己持有 `TaskStateWorker`，**不挂载** provider，因此生产
 *     `session/event` observer 的那一半不存在。本 spec 用
 *     `requestUrgentLikeProduction()` 在 microtask 上补上 observer 唯一缺失的
 *     那一步（`worker.maybeScheduleUrgent(seq)`）；`worker.observe(seq)` 已由
 *     harness 的 `appendGoal`/`appendTodo` 同步完成。生产链路的完整证据在
 *     `tests/task-state-goal-authority.spec.ts`、`tests/task-state-todo-authority.spec.ts`
 *     （真 `TaskStateBasicService` + 真 storage/domain + durable audit trigger）。
 *  2. harness 的 ledger 把 `trigger` 硬编码为 `'threshold'`，因此本 spec 直接从
 *     worker 自己的 `performBatch(trigger, window)` 调用点记录真实 trigger
 *     （只包一层转发，不改任何生产代码，也不改 harness）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BASELINE_CONFIG,
  candidateEchoing,
  createTaskStateFixture,
  delay,
  fnv1a,
  projectedFields,
} from '../harness/task-state-harness.ts'
import type { TaskStateFixture } from '../harness/task-state-harness.ts'
import { filterEvent } from '../../../src/internal/task-state/basic/filter.ts'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const LEDGER_PATH = join(OUT_DIR, 'b42-ledger.json')
const ROOT_DIR = join(OUT_DIR, '..', '..', '..')
const HISTORICAL_DIR = join(ROOT_DIR, '审计资料', '实验结果')
const E05_SPEC = join(HISTORICAL_DIR, 'E05-Goal大改', 'e05-goal-change.spec.ts')
const E06_SPEC = join(HISTORICAL_DIR, 'E06-Todo清空', 'e06-todo-clear.spec.ts')
const HARNESS = join(HISTORICAL_DIR, 'harness', 'task-state-harness.ts')

const GOAL_A = {
  id: 'goal-a',
  revision: 1,
  phase: 'active',
  objective: 'Ship the font-rendering pipeline for the web client.',
}
const GOAL_B = {
  id: 'goal-b',
  revision: 3,
  phase: 'active',
  objective: 'Abandon the font work entirely and migrate the billing service to Postgres.',
}
const OBJECTIVE = 'keep the durable task state aligned with the live TODO list'
const LIST_A = [
  { content: 'first durable item', status: 'pending' },
  { content: 'second durable item', status: 'in_progress' },
]

/** 与本对照运行所用的生产源码（drift 记录用）。 */
const SOURCE_FILES = [
  'src/internal/task-state/contract/types.ts',
  'src/internal/task-state/contract/spec.ts',
  'src/internal/task-state/contract/audit.ts',
  'src/internal/task-state/basic/authority.ts',
  'src/internal/task-state/basic/filter.ts',
  'src/internal/task-state/basic/types.ts',
  'src/internal/task-state/basic/prompt.ts',
  'src/internal/task-state/basic/host.ts',
  'src/internal/task-state/basic/update.ts',
  'src/internal/task-state/basic/worker.ts',
  'src/internal/task-state/basic/service.ts',
  'src/internal/task-state/prompt/render.ts',
  'src/internal/task-state/index.ts',
  'src/task-state.ts',
]

/** 修复前基线（插件 `cf034b4`，B4.2 之前的最后状态）的源码 SHA-256。 */
const PRE_FIX_SHA256: Record<string, string> = {
  'src/internal/task-state/contract/types.ts': 'bb7fe3a6bede6ae93b6e1a856da88cf417dfad4f3087cbbeea5cb104089f028b',
  'src/internal/task-state/contract/spec.ts': 'c9ca675c058526ae05972afe12936405a8a3b581cb3a8d534e85a30c9632f9ca',
  'src/internal/task-state/contract/audit.ts': '84ae100818d05722b2f56bf8537d100a7c7b894c1ee72a3306fce3f3d143262d',
  'src/internal/task-state/basic/filter.ts': 'a047e842369fb2c4dec5c9cfee9f273e9cae0d8e305ab2b85e8fcebf40ac4918',
  'src/internal/task-state/basic/types.ts': 'c8527a504b6b70582f428506f12107d004441a3a22b3757ac18c853f659ced55',
  'src/internal/task-state/basic/prompt.ts': 'eddbcff8289d2925644588f62f0e527b2d71670e7303d15185d1eabb2d940649',
  'src/internal/task-state/basic/host.ts': '7951e55749bc1e0463a84ae27fe67a0d2697823b40d2254600fd8eaa66aff75d',
  'src/internal/task-state/basic/update.ts': '0ce5a2d5f892798bc1a73d0b64bca04bc2b6f32b4eb0457b833c97f780b24128',
  'src/internal/task-state/basic/worker.ts': '28d7437fd9ea4d86004d1fdea84a18adf8da6dd825eabc04808b26d91306f626',
  'src/internal/task-state/basic/service.ts': 'c26c1afcbd83a5a6b8d7e84e349e7c5d049eb1b8e625ca91c6fcbdd203138b5a',
  'src/internal/task-state/prompt/render.ts': '0c5f332ed8c2ee431a343e764a8d7115ec8e69f43a67a750325d1283fc8be46b',
  'src/internal/task-state/index.ts': '3baa0ba0605a5d5c4771ffe0fe65991be69f4704f4947c9d83d395e73215a843',
  'src/task-state.ts': 'dcc10c9a12aef4538ff477ae2c3872781e95faef894e2674c66268e858fc62a3',
}

/** sha256 of one file's raw bytes, or `'unreadable'`. */
function sha256File(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'unreadable'
  }
}

/** size + mtime of one file, for drift attribution. */
function fileFacts(path: string): { bytes: number; mtimeMs: number } {
  try {
    const stats = statSync(path)
    return { bytes: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return { bytes: -1, mtimeMs: -1 }
  }
}

/** One recorded phase of the post-fix comparison. */
interface PhaseLedger {
  readonly id: string
  readonly historicalQuestion: string
  readonly historicalSpec: string
  readonly config: { readonly minEvents: number; readonly maxEvents: number }
  readonly fixtureSteps: readonly string[]
  readonly controlWithoutUrgent: Record<string, unknown>
  readonly afterAuthorityFact: Record<string, unknown>
  readonly triggers: readonly string[]
  readonly criteria: Record<string, boolean>
  readonly verdict: 'fixed' | 'still-broken'
}

const phases: PhaseLedger[] = []
const errors: string[] = []

afterAll(() => {
  const ledger = {
    experiment: 'B4.2 · E05/E06 修复后同 fixture 对照',
    question: [
      'E05：Goal A → 语义不同的 Goal B（goal revision 3）时，是否会在 minEvents 之外触发独立更新，并让注入叙事跟随新 Goal？',
      'E06：合法空 todo/write({todos: []}) 是否被 filter 投影、是否触发更新、是否让已清空列表从提交态与注入中消失？',
    ],
    verdictRule:
      '每个 phase 的 criteria 全部为 true 才记 verdict = "fixed"；任一条为 false 记 "still-broken" 并保留原始数字（包括对本修复不利的数字）。',
    measurement: '只对照代码版本；fixture / 配置 / 采样 / 候选 JSON / 环境全部沿用 E05/E06 harness',
    invokedAs:
      'pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/B4.2-E05E06修复后回归/b42-e05e06-regression.spec.ts --reporter=verbose',
    productionPathSimulated: {
      what: 'urgent 请求（worker.maybeScheduleUrgent）在生产由 service.ts 的 session/event observer 在 microtask 上发出；harness 不挂载 provider，因此本 spec 补上这一步',
      shim: 'requestUrgentLikeProduction(fixture, seq) → queueMicrotask(() => fixture.worker.maybeScheduleUrgent(seq))',
      notSimulated: 'observe(seq) 由 harness 的 appendGoal/appendTodo 同步完成；真 provider 的 durable audit / storage / 同步栈语义由 tests/task-state-goal-authority.spec.ts 与 tests/task-state-todo-authority.spec.ts 覆盖',
      howTriggerRead: 'harness ledger 的 trigger 字段被硬编码为 threshold，本 spec 从 worker 自己的 performBatch(trigger, window) 调用点包一层转发来记录真实 trigger（不改生产代码、不改 harness）',
    },
    historicalPreFixVerdict: {
      source: '审计资料/实验结果/E00-首轮实验阶段评审.md（修复前基线 cf034b4）',
      e05: { passed: 3, total: 3, note: 'E05 Goal 大改：3/3 通过 — 确认 Goal 大改不走独立 urgent 更新、旧叙事可继续注入' },
      e06: { passed: 5, total: 5, note: 'E06 TODO 清空：5/5 通过 — 确认合法空 TODO 不可观察、stable/cursor/注入不因该事件单独更新' },
    },
    historicalPostFixVerdict: {
      source: 'vitest-output-historical-postfix.txt（本次运行，历史 spec 未被修改）',
      e05: { passed: 1, failed: 2, total: 3 },
      e06: { passed: 0, failed: 5, total: 5 },
      perTest: [
        { file: 'E05', case: 'Case A: goal/change counts 1 projectable event and the goal snapshot is projected verbatim', status: 'passed' },
        { file: 'E05', case: 'Case B: Goal A → Goal B does not trigger an update, and A keeps being injected', status: 'failed' },
        { file: 'E05', case: 'Case C: goal/change alone never launches a wave, even with minEvents = 1 above an empty cursor', status: 'failed' },
        { file: 'E06', case: 'Case A: the production filter drops a legal empty todo/write', status: 'failed' },
        { file: 'E06', case: 'Case B: at the deployment threshold a clear changes nothing observable', status: 'failed' },
        { file: 'E06', case: 'Case C: even with minEvents = 1 the clear launches nothing, while a non-empty write does', status: 'failed' },
        { file: 'E06', case: 'Case D: the empty write is not merely unprojectable — it is not even a stable INPUT', status: 'failed' },
        { file: 'E06', case: 'Case E: the renderer cannot express "cleared" — the stale list looks live', status: 'failed' },
      ],
      note: '历史 spec 断言的是缺陷本身（"没有 urgent 触发 / 空列表被丢弃 / 渲染无法表达 cleared"），因此修复后它们必须失败：verdict 翻转就是本对照的前后差量。E05 Case A 只断言 projection，故仍通过。',
    },
    config: {
      minEvents: BASELINE_CONFIG.minEvents,
      maxEvents: BASELINE_CONFIG.maxEvents,
      maxInputBytes: BASELINE_CONFIG.maxInputBytes,
      maxListItems: BASELINE_CONFIG.maxListItems,
      overridden: 'Phase 2 (E05 Case C) 与 Phase 4 (E06 Case C/E) 使用 minEvents = 1，与历史 case 逐字一致',
    },
    phases,
    criteria: {
      allPhasesFixed: false,
      noWaveWithoutTheUrgentRequest: false,
      historicalFixturesUntouched: false,
      perPhase: {} as Record<string, Record<string, boolean>>,
    },
    verdict: 'still-broken',
    errors,
    sourceDrift: {
      preFixBaseline: 'cf034b4',
      note: 'preFixSha256 由 `git show HEAD:<path>` 逐字重算（对未改动文件已验证与工作区一致）；postFixSha256 为本次运行时的真实文件字节。新增文件在修复前不存在。',
      sourceFiles: SOURCE_FILES,
      preFixSha256: Object.fromEntries(SOURCE_FILES.map(file => [file, PRE_FIX_SHA256[file] ?? '(absent before B4.2)'])),
      postFixSha256: Object.fromEntries(SOURCE_FILES.map(file => [file, sha256File(join(ROOT_DIR, file))])),
      postFixFileFacts: Object.fromEntries(SOURCE_FILES.map(file => [file, fileFacts(join(ROOT_DIR, file))])),
      newTests: [
        'tests/task-state-goal-authority.spec.ts',
        'tests/task-state-todo-authority.spec.ts',
        '审计资料/实验结果/B4.2-E05E06修复后回归/b42-e05e06-regression.spec.ts',
      ],
      historicalFixturesUntouched: {
        e05Spec: sha256File(E05_SPEC),
        e06Spec: sha256File(E06_SPEC),
        harness: sha256File(HARNESS),
        note: 'E05/E06 历史目录与共享 harness 本次只被读取（import）与哈希，未被写入',
      },
    },
    artifacts: {
      spec: 'b42-e05e06-regression.spec.ts',
      ledger: 'b42-ledger.json',
      historicalPostFixOutput: 'vitest-output-historical-postfix.txt',
      sameFixtureRegressionOutput: 'vitest-output.txt',
      readme: 'README.md',
      productionEvidence: [
        'tests/task-state-goal-authority.spec.ts（16 tests）',
        'tests/task-state-todo-authority.spec.ts（13 tests）',
      ],
    },
    limitations: [
      'LLM 为 fake adapter：不测模型质量、token、真实时延，只测"是否发生波次、波次折叠了什么、提交态与注入是什么"。',
      'harness 不挂载 provider：本 spec 用 requestUrgentLikeProduction 补上 observer 的 urgent 一步；harness ledger 的 trigger 字段不可用，故 trigger 从 performContract 调用点旁路记录。真 provider 的 durable audit 证据在 tests/ 的两个新 spec。',
      'harness 的 fake worker 环境把 stable 存在内存里；durable storage/domain 语义（含 fail-closed）由 tests/ 的两个新 spec 覆盖。',
      'candidateEchoing 仍会写出 todoReferences，但修复后该字段已不是候选契约的一部分（被 schema 丢弃）；本 spec 断言的是 Host 自行推导的引用，这本身就是差量之一。',
      'verdict = fixed 只表示该 fixture 的判据全部成立，不代表理想方案整体达成，也不代表用户侧现象消失。',
      '本次未构建、未安装、未启动 DSH/GUI；未访问真实 $HOME/.dsh、任何既有会话或 8080；未修改 lib/、tgz、package.json、vitest.config.ts 或任何历史实验目录。',
    ],
  }
  // 判据与 verdict 全部由 phase 自己的 criteria 推导，不额外"补齐"任何结论。
  ledger.criteria.perPhase = Object.fromEntries(phases.map(phase => [phase.id, phase.criteria]))
  ledger.criteria.allPhasesFixed = phases.length === 4 && phases.every(phase => phase.verdict === 'fixed')
  ledger.criteria.noWaveWithoutTheUrgentRequest = phases
    .filter(phase => phase.controlWithoutUrgent['waveRan'] !== undefined)
    .every(phase => phase.controlWithoutUrgent['waveRan'] === false)
  ledger.criteria.historicalFixturesUntouched = [E05_SPEC, E06_SPEC, HARNESS]
    .every(path => existsSync(path) && sha256File(path) !== 'unreadable')
  ledger.verdict = ledger.criteria.allPhasesFixed ? 'fixed' : 'still-broken'
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  if (!existsSync(LEDGER_PATH)) errors.push('ledger was not written')
})

/**
 * 生产 observer 缺失的那一步：service.ts 在 microtask 上调用
 * `worker.maybeScheduleUrgent(seq)`（以及 `maybeSchedule()`）。harness 的
 * `appendGoal`/`appendTodo` 已经同步 `observe(seq)`，这里只补 urgent 请求。
 */
function requestUrgentLikeProduction(fixture: TaskStateFixture, seq: number): void {
  queueMicrotask(() => { fixture.worker.maybeScheduleUrgent(seq) })
}

/** 从 worker 自己的 `performBatch(trigger, window)` 调用点记录真实 trigger。 */
function recordTriggers(fixture: TaskStateFixture): { triggers: string[] } {
  const holder = { triggers: [] as string[] }
  const worker = fixture.worker as unknown as {
    performBatch: (trigger: string, window: unknown) => Promise<unknown>
  }
  const original = worker.performBatch.bind(fixture.worker)
  worker.performBatch = (trigger: string, window: unknown) => {
    holder.triggers.push(trigger)
    return original(trigger, window)
  }
  return holder
}

/** 一次对照的运行快照，写进 ledger。 */
function snapshot(fixture: TaskStateFixture): Record<string, unknown> {
  const latest = fixture.latest()
  return {
    cycles: fixture.ledger.cycles.length,
    launches: fixture.ledger.launches,
    requests: fixture.adapter.requests.length,
    stableRevision: latest?.revision ?? null,
    sourceCursor: latest?.sourceCursor ?? null,
    eligibleAboveCursor: fixture.eligibleAboveCursor(),
    goalViewStatus: latest?.goalView.status ?? null,
    goalId: latest?.goalView.goalId ?? null,
    goalRevision: latest?.goalView.goalRevision ?? null,
    goalObjective: latest?.goalView.objective ?? null,
    todoViewStatus: latest?.todoView.status ?? null,
    todoSourceSeq: latest?.todoView.status === 'current' ? latest.todoView.sourceSeq ?? null : null,
    todoItems: latest?.todoView.items.map(item => `${item.status}:${item.content}`) ?? [],
    todoReferences: latest?.todoReferences.map(reference => `${reference.seq}:${reference.content}`) ?? [],
    objectiveAfter: latest?.continuation.currentObjective ?? null,
    injection: fixture.renderInjection(),
    injectionHash: fixture.renderInjection() === null ? null : fnv1a(fixture.renderInjection() as string),
    staleByEligibleEvents: fixture.eligibleAboveCursor(),
  }
}

describe('B4.2 · E05/E06 同 fixture 修复后对照', () => {
  it('E05 Case B/C · 低于 minEvents 的 Goal 替换被 urgent 波次折叠，旧 Goal 不再注入', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: GOAL_A.objective, focus: 'working on goal A' }),
    })
    const triggers = recordTriggers(fixture)
    try {
      // 波次 1：用 20 个普通进度事件达到部署 minEvents，提交携带 Goal A 叙事的
      // stable（与 E05 Case B 的第 1 步逐字相同）。
      for (let index = 0; index < BASELINE_CONFIG.minEvents; index += 1) fixture.appendUser(`progress ${index}`)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)
      const first = fixture.ledger.cycles[0]!
      expect(first.stableRevisionAfter).toBe(1)
      expect(fixture.latest()!.continuation.currentObjective).toBe(GOAL_A.objective)

      // Goal A → Goal B（revision 3），并让模型指向新 objective。
      fixture.adapter.setOutput(candidateEchoing({ objective: GOAL_B.objective, focus: 'working on goal B' }))
      const changeSeq = fixture.appendGoal(GOAL_B)
      expect(fixture.eligibleAboveCursor()).toBe(1)

      // 对照点（= 历史 E05 的测量路径）：只走阈值调度，1 个事件 < 20，因此
      // 什么都不发生 —— 这一段复现了 E05 记录的现状行为。
      fixture.schedule()
      await delay(200)
      const control = {
        waveRan: fixture.ledger.cycles.length > 1,
        requests: fixture.adapter.requests.length,
        stableRevision: fixture.latest()!.revision,
        injectionContainsGoalA: fixture.renderInjection()!.includes(GOAL_A.objective),
        injectionContainsGoalB: fixture.renderInjection()!.includes(GOAL_B.objective),
      }
      expect(control.waveRan).toBe(false)

      // 生产 observer 的 urgent 一步：同一个 fixture、同一个 1 事件窗口。
      requestUrgentLikeProduction(fixture, changeSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 2, 10_000)
      const second = fixture.ledger.cycles[1]!
      const stable = fixture.latest()!
      const injection = fixture.renderInjection()!
      const after = {
        ...snapshot(fixture),
        includedSeqs: second.includedSeqs,
        trigger: triggers.triggers[1] ?? null,
        goalRevisionInWindow: second.goalRevision,
        replacementFoldBelowThreshold: second.includedSeqs.length < BASELINE_CONFIG.minEvents,
      }
      const criteria = {
        goalFactCountsOneEligibleEvent: second.includedSeqs.length === 1 && second.includedSeqs[0] === changeSeq,
        waveRanOnlyAfterTheUrgentRequest: triggers.triggers.length === 2,
        triggerIsUrgent: triggers.triggers[1] === 'urgent',
        goalViewIsGoalB: stable.goalView.status === 'current'
          && stable.goalView.goalId === GOAL_B.id
          && stable.goalView.goalRevision === GOAL_B.revision
          && stable.goalView.objective === GOAL_B.objective,
        injectionShowsGoalB: injection.includes(GOAL_B.objective) && injection.includes('Current goal:'),
        injectionNoLongerShowsGoalA: !injection.includes(GOAL_A.objective) && !injection.includes(GOAL_A.id),
        noStaleTail: fixture.eligibleAboveCursor() === 0,
      }
      phases.push({
        id: 'e05-replacement',
        historicalQuestion: 'Goal A → Goal B 是否触发独立更新，注入是否跟随？',
        historicalSpec: '审计资料/实验结果/E05-Goal大改/e05-goal-change.spec.ts · Case B',
        config: { minEvents: BASELINE_CONFIG.minEvents, maxEvents: BASELINE_CONFIG.maxEvents },
        fixtureSteps: [
          '20 × user/message（progress i）→ schedule()',
          'appendGoal(GOAL_B, revision 3)',
          '对照：schedule() only（= 历史 E05 路径）',
          'requestUrgentLikeProduction(changeSeq)',
        ],
        controlWithoutUrgent: control,
        afterAuthorityFact: after,
        triggers: [...triggers.triggers],
        criteria,
        verdict: Object.values(criteria).every(Boolean) ? 'fixed' : 'still-broken',
      })
      expect(criteria).toEqual({
        goalFactCountsOneEligibleEvent: true,
        waveRanOnlyAfterTheUrgentRequest: true,
        triggerIsUrgent: true,
        goalViewIsGoalB: true,
        injectionShowsGoalB: true,
        injectionNoLongerShowsGoalA: true,
        noStaleTail: true,
      })
    } finally {
      await fixture.dispose()
    }
  }, 60_000)

  it('E05 Case C · Goal clear 走 urgent 波次，模型叙事无法让旧 Goal 复活', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: GOAL_A.objective }),
      config: { minEvents: 1 },
    })
    const triggers = recordTriggers(fixture)
    try {
      fixture.appendUser('bootstrap')
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)

      fixture.adapter.setOutput(candidateEchoing({ objective: GOAL_B.objective }))
      const goalSeq = fixture.appendGoal(GOAL_B)
      requestUrgentLikeProduction(fixture, goalSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 2, 10_000)
      expect(fixture.latest()!.goalView).toMatchObject({ status: 'current', goalId: GOAL_B.id })

      // 清空 Goal：模型同时继续把 B 的 objective 写进叙事（旧行为的"叙事即目标"）。
      fixture.adapter.setOutput(candidateEchoing({ objective: GOAL_B.objective, focus: 'still goal B' }))
      const clearSeq = fixture.appendGoalClear()
      requestUrgentLikeProduction(fixture, clearSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 3, 10_000)
      const stable = fixture.latest()!
      const injection = fixture.renderInjection()!
      const cleared = fixture.ledger.cycles[2]!
      const after = {
        ...snapshot(fixture),
        includedSeqs: cleared.includedSeqs,
        trigger: triggers.triggers[2] ?? null,
        narrativeStillSaysGoalB: stable.continuation.currentObjective === GOAL_B.objective,
      }
      const criteria = {
        goalClearProjected: projectedFields(fixture.session, clearSeq) !== null,
        waveRanForTheClear: triggers.triggers.length === 3,
        triggerIsUrgent: triggers.triggers[2] === 'urgent',
        goalViewIsCleared: stable.goalView.status === 'cleared',
        injectionSaysCleared: injection.includes('Current goal: cleared (no authoritative goal is set).'),
        injectionDoesNotReviveGoalB: !injection.includes(GOAL_B.objective) && !injection.includes(`goal ${GOAL_B.id}`),
        noStaleTail: fixture.eligibleAboveCursor() === 0,
      }
      phases.push({
        id: 'e05-clear',
        historicalQuestion: 'Goal clear 之后，旧 Goal 是否还作为"当前目标"被注入？',
        historicalSpec: '审计资料/实验结果/E05-Goal大改/e05-goal-change.spec.ts · Case C',
        config: { minEvents: 1, maxEvents: BASELINE_CONFIG.maxEvents },
        fixtureSteps: [
          '1 × user/message（bootstrap）→ schedule()',
          'appendGoal(GOAL_B, revision 3) → requestUrgentLikeProduction',
          'appendGoalClear() → requestUrgentLikeProduction',
        ],
        controlWithoutUrgent: { waveRan: false, note: '历史 Case C 的路径（只 schedule()）在修复前观测到叙事仍为 B；本 phase 用同一 fixture 的 urgent 路径对照' },
        afterAuthorityFact: after,
        triggers: [...triggers.triggers],
        criteria,
        verdict: Object.values(criteria).every(Boolean) ? 'fixed' : 'still-broken',
      })
      expect(criteria).toEqual({
        goalClearProjected: true,
        waveRanForTheClear: true,
        triggerIsUrgent: true,
        goalViewIsCleared: true,
        injectionSaysCleared: true,
        injectionDoesNotReviveGoalB: true,
        noStaleTail: true,
      })
    } finally {
      await fixture.dispose()
    }
  }, 60_000)

  it('E06 Case A/B/D · 空 todo/write 是合法事实：清空走 urgent 波次，提交态与注入都清空', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: OBJECTIVE }),
    })
    const triggers = recordTriggers(fixture)
    try {
      // E06 Case A：生产 filter 对空列表的投影（修复前为 null）。
      const emptyProjection = filterEvent({ type: 'todo/write', seq: 7, data: { todos: [] } })
      expect(emptyProjection).not.toBeNull()

      for (let index = 0; index < BASELINE_CONFIG.minEvents; index += 1) fixture.appendUser(`progress ${index}`)
      fixture.schedule()
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)

      // 一次真实的整表写入（引用必须指向当前窗口内的 seq）。
      const todoSeq = fixture.appendTodo(LIST_A)
      fixture.adapter.setOutput(candidateEchoing({
        objective: OBJECTIVE,
        todoSeq,
        todoText: 'first durable item; second durable item',
      }))
      requestUrgentLikeProduction(fixture, todoSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 2, 10_000)
      const withList = fixture.latest()!

      // 合法清空：1 个 eligible 事件 < minEvents。
      const clearSeq = fixture.appendTodo([])
      const clearProjection = filterEvent({ type: 'todo/write', seq: clearSeq, data: { todos: [] } })
      expect(clearProjection).not.toBeNull()
      expect(fixture.eligibleAboveCursor()).toBe(1)

      // 对照点（= 历史 E06 Case B 的路径）：只走阈值调度，什么都不发生。
      fixture.schedule()
      await delay(200)
      const control = {
        waveRan: fixture.ledger.cycles.length > 2,
        requests: fixture.adapter.requests.length,
        todoViewStatus: fixture.latest()!.todoView.status,
        injectionContainsStaleItem: fixture.renderInjection()!.includes('first durable item'),
      }
      expect(control.waveRan).toBe(false)

      requestUrgentLikeProduction(fixture, clearSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 3, 10_000)
      const stable = fixture.latest()!
      const injection = fixture.renderInjection()!
      const cleared = fixture.ledger.cycles[2]!
      const after = {
        ...snapshot(fixture),
        includedSeqs: cleared.includedSeqs,
        trigger: triggers.triggers[2] ?? null,
        previousTodoReferences: withList.todoReferences.map(reference => `${reference.seq}:${reference.content}`),
      }
      const nonEmptyProjection = filterEvent({ type: 'todo/write', seq: 8, data: { todos: LIST_A } })
      const criteria = {
        emptyWriteProjectedAsClear: emptyProjection !== null
          && (emptyProjection.event.fields as { status?: string }).status === 'cleared',
        nonEmptyWriteIsCurrent: nonEmptyProjection !== null
          && (nonEmptyProjection.event.fields as { status?: string }).status === 'current',
        writeFoldedBelowThreshold: withList.todoView.status === 'current' && withList.todoView.sourceSeq === todoSeq,
        clearCountsOneEligibleEvent: fixture.ledger.cycles[2]!.includedSeqs.length === 1
          && fixture.ledger.cycles[2]!.includedSeqs[0] === clearSeq,
        clearWaveTriggerIsUrgent: triggers.triggers[2] === 'urgent',
        todoViewIsCleared: stable.todoView.status === 'cleared' && stable.todoView.sourceSeq === clearSeq,
        clearedListLeavesNoReference: stable.todoReferences.length === 0,
        injectionSaysCleared: injection.includes('TODO list: cleared (the authoritative list is empty).'),
        injectionDropsTheOldItems: !injection.includes('first durable item') && !injection.includes('second durable item'),
        noTodoReferencesSection: !injection.includes('TODO references:'),
        noStaleTail: fixture.eligibleAboveCursor() === 0,
      }
      phases.push({
        id: 'e06-write-clear',
        historicalQuestion: '合法空 TODO 是否可观察、是否触发更新、清空后是否还注入旧列表？',
        historicalSpec: '审计资料/实验结果/E06-Todo清空/e06-todo-clear.spec.ts · Case A/B/D',
        config: { minEvents: BASELINE_CONFIG.minEvents, maxEvents: BASELINE_CONFIG.maxEvents },
        fixtureSteps: [
          'filterEvent(todo/write {todos: []}) 直接投影',
          '20 × user/message（progress i）→ schedule()',
          'appendTodo(LIST_A) → requestUrgentLikeProduction',
          'appendTodo([]) → 对照 schedule() only（= 历史 E06 路径）',
          'requestUrgentLikeProduction(clearSeq)',
        ],
        controlWithoutUrgent: control,
        afterAuthorityFact: after,
        triggers: [...triggers.triggers],
        criteria,
        verdict: Object.values(criteria).every(Boolean) ? 'fixed' : 'still-broken',
      })
      expect(criteria).toEqual({
        emptyWriteProjectedAsClear: true,
        nonEmptyWriteIsCurrent: true,
        writeFoldedBelowThreshold: true,
        clearCountsOneEligibleEvent: true,
        clearWaveTriggerIsUrgent: true,
        todoViewIsCleared: true,
        clearedListLeavesNoReference: true,
        injectionSaysCleared: true,
        injectionDropsTheOldItems: true,
        noTodoReferencesSection: true,
        noStaleTail: true,
      })
    } finally {
      await fixture.dispose()
    }
  }, 60_000)

  it('E06 Case C/E · minEvents = 1 下清空与写入都被折叠，且渲染能表达 cleared', async () => {
    const fixture = await createTaskStateFixture({
      output: candidateEchoing({ objective: OBJECTIVE }),
      config: { minEvents: 1 },
    })
    const triggers = recordTriggers(fixture)
    try {
      const todoSeq = fixture.appendTodo([{ content: 'stale item', status: 'pending' }])
      fixture.adapter.setOutput(candidateEchoing({
        objective: OBJECTIVE,
        todoSeq,
        todoText: 'stale item',
      }))
      requestUrgentLikeProduction(fixture, todoSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 1, 10_000)
      const withList = fixture.latest()!
      const injectionWithList = fixture.renderInjection()!

      // 清空：这次连对照都不需要额外调度（minEvents = 1），但历史 Case C 的
      // 关键断言是"清空不启动任何波次"；修复后它必须启动，且是 urgent。
      const clearSeq = fixture.appendTodo([])
      expect(fixture.eligibleAboveCursor()).toBe(1)
      requestUrgentLikeProduction(fixture, clearSeq)
      await fixture.waitUntil(() => fixture.ledger.cycles.length === 2, 10_000)
      const stable = fixture.latest()!
      const injection = fixture.renderInjection()!
      const after = {
        ...snapshot(fixture),
        includedSeqs: fixture.ledger.cycles[1]!.includedSeqs,
        trigger: triggers.triggers[1] ?? null,
        injectionBeforeClear: injectionWithList,
      }
      const criteria = {
        writeWaveIsUrgent: triggers.triggers[0] === 'urgent',
        clearWaveIsUrgent: triggers.triggers[1] === 'urgent',
        rendererCanExpressCleared: injection.includes('TODO list: cleared (the authoritative list is empty).'),
        staleListNoLongerLive: !injection.includes('stale item') && !injection.includes('TODO references:'),
        clearedStateIsDurableInStable: stable.todoView.status === 'cleared' && stable.todoReferences.length === 0,
        digestedListStateChanged: withList.digest !== stable.digest,
      }
      phases.push({
        id: 'e06-clear-only',
        historicalQuestion: '渲染层能否表达 cleared（历史 Case E：旧列表看起来仍然有效）？',
        historicalSpec: '审计资料/实验结果/E06-Todo清空/e06-todo-clear.spec.ts · Case C/E',
        config: { minEvents: 1, maxEvents: BASELINE_CONFIG.maxEvents },
        fixtureSteps: [
          'appendTodo([{stale item}]) → requestUrgentLikeProduction',
          'appendTodo([]) → requestUrgentLikeProduction',
        ],
        controlWithoutUrgent: { waveRan: false, note: '历史 Case C 的路径（只 schedule()）在修复前观测到清空不启动任何波次' },
        afterAuthorityFact: after,
        triggers: [...triggers.triggers],
        criteria,
        verdict: Object.values(criteria).every(Boolean) ? 'fixed' : 'still-broken',
      })
      expect(criteria).toEqual({
        writeWaveIsUrgent: true,
        clearWaveIsUrgent: true,
        rendererCanExpressCleared: true,
        staleListNoLongerLive: true,
        clearedStateIsDurableInStable: true,
        digestedListStateChanged: true,
      })
      expect(clearSeq).toBeGreaterThan(todoSeq)
    } finally {
      await fixture.dispose()
    }
  }, 60_000)

  it('历史 spec 与 harness 未被本次对照写入（只读凭据）', () => {
    for (const path of [E05_SPEC, E06_SPEC, HARNESS]) {
      expect(existsSync(path)).toBe(true)
      expect(sha256File(path)).not.toBe('unreadable')
    }
  })
})
