# DSH Goal 与 Todo 长期状态 — 源码事实库

> 来源：`packages/goal/**`、`packages/todo/tool-todo/**` 及必要直接依赖一层。
> 仅陈述源码行为，不判断现有故障，不调查插件 Checkpoint 或会话摘要。

---

## 1. 权威实体、事件、服务、状态字段

### Goal
- **实体**（`packages/goal/goal/src/types.ts:16-84`）：
  - `GoalId = Branded<'GoalId'>` (line 16)
  - `GoalRef { id, revision }` (line 19-24)
  - `GoalSnapshot extends GoalRef { objective, phase, blockedReason?, maxGoalRounds }` (line 59-68)
  - `GoalView` — 同 GoalSnapshot + `roundsStarted, createdAt, updatedAt, activation` (line 74-83)
  - `GoalProjection` — 同 GoalView 去 activation (line 91-100)
  - `GoalProjectionState { current: GoalProjection|null, seenGoalIds, failure }` (line 103-110)
- **事件**（`packages/goal/goal/src/domain.ts:61-68`）：
  - `'goal/change': GoalChangeMeta`（完整快照或清除墓碑）
  - `user/message` 中 `source.kind === 'goal'` 表示 admitted 的 goal round (domain.ts:47-53)
- **服务接口**（`packages/goal/goal/src/runtime.ts:240-627`）：
  - `ctx.goals.create(agent, {objective, maxGoalRounds?}) → GoalView` (line 301)
  - `ctx.goals.edit(agent, ref, {objective?, maxGoalRounds?}) → GoalView` (line 327)
  - `ctx.goals.pause(agent, ref) → GoalView` (line 349)
  - `ctx.goals.resume(agent, ref) → GoalView` (line 361)
  - `ctx.goals.complete(agent, ref) → GoalView` (line 388)
  - `ctx.goals.block(agent, ref, reason) → GoalView` (line 407)
  - `ctx.goals.clear(agent, ref) → GoalRef` (line 431)
  - `ctx.goals.get(agent) → GoalView|undefined` (line 275)
  - `ctx.goals.disarm(agent) → GoalView|undefined` (line 287)
- **状态字段**：见 GoalSnapshot / GoalView；phase ∈ `{'active','paused','blocked','complete'}` (types.ts:44-48)
- **纯 fold 验证**（`packages/goal/goal/src/fold.ts:271-349`）：每 `goal/change` 事件全量替换，`user/message` 仅当 source 为 goal 且匹配当前 goal 时 advance `roundsStarted`。

【已证实】

### Todo
- **实体**（`packages/todo/tool-todo/src/types.ts:21-26`）：
  - `TodoItem { content: string, status: 'pending'|'in_progress'|'completed' }` — 无 id
  - 整个列表 `TodoItem[]`，按最新写全量替换
- **事件**（types.ts:28-33）：
  - `'todo/write': { todos: TodoItem[] }`
- **工具**（`packages/todo/tool-todo/src/index.ts:146-222`）：
  - `todo_write` 工具，execute 调用 `exec.agent.session.append('todo/write', {todos})` (line 210)
- **状态投影**（index.ts:134-145）：
  - key `'todos'`, stateVersion: 2, `init() → null`, `apply` 对 `todo/write` 返回全列表，对 `turn/start` 返回 null，其余原样返回。
- 【已证实】

---

## 2. Goal 各操作的精确语义与 revision 变化

**所有非 create 操作**先通过 `expectCurrent(state, ref)` 做 CAS（`runtime.ts:454-463`）：ref.id 必须等于 current.id，ref.revision 必须等于 current.revision；否则抛 `GOAL_STALE_REVISION`。

| 操作 | 允许的入态 | 出态 | revision | 触发字段变化 |
|---|---|---|---|---|
| `create` | 无 goal 或 current.phase === 'complete' | active | 1 | objective, maxGoalRounds, createdAt=updatedAt=now, activation=armed |
| `edit` | 任意（不含 clear 后） | 同入态 | +1 | 按 request 可选替换 objective/maxGoalRounds；phase 与 blockedReason 不变 |
| `pause` | active | paused | +1 | phase=paused, activation=disarmed |
| `resume` | active(paused 也可), paused, blocked | active | +1 | phase=active, activation=armed；要求 roundsStarted < maxGoalRounds |
| `complete` | active/paused/blocked | complete | +1 | phase=complete, activation=disarmed |
| `block` | active | blocked | +1 | phase=blocked, blockedReason=resolved, activation=disarmed |
| `clear` | 有 current | null (墓碑) | +1 | 不保留 goal，仅写 `cleared` 墓碑；后续 `get()` 返回 undefined |

- `edit` 是全量替换而非增量：构造时先展开 current，再 spread request 覆盖字段（runtime.ts:334-339）。
- `pause`/`block` 会同时 `disarm`；`create`/`resume` 会 `arm`。`disarm()` 方法只改内存不写事件（goal.spec.ts:217-229 已证实）。
- `commitSnapshot` 使用 `Math.max(Date.now(), state.updatedAt)` 保证时间单调（runtime.ts:550-552）。
- `resume` 在 `current.phase === 'active' && activation === 'armed'` 时抛 `GOAL_INVALID_TRANSITION`（runtime.ts:370-372）。

【已证实】

---

## 3. TODO 更新语义

- **全表替换**：每次 `todo_write` 写入完整的 `TodoItem[]`，无增量字段（tool-todo/src/index.ts:138-140）。
- **删除表达**：新列表不包含该 item（即整个 list 不含对应 content 行）。
- **状态变化**：同一条 content 在下一快照里 status 不同即视为变更（pending→in_progress→completed）。
- **重复检测**：`toTodoList` 拒绝重复 content（index.ts:100-101）。
- **并行 in_progress**：由 config `allowParallelInProgress` 控制；false 时 >1 条 in_progress 抛错（index.ts:107-109）。
- **Invariants**：不限制 in_progress 数量（invariant.ts:22-23 明确说明），只校验 content 非空、已 trim、唯一、status 合法。

【已证实】

---

## 4. Session 关联、恢复与独立 Checkpoint

### Goal
- **注册**：`GoalService` 在构造时调用 `ctx.sessionProjections.register(goalProjectionDefinition)` (runtime.ts:258)，`stateVersion: 6` (runtime.ts:169)。
- **Session 绑定**：每个 `session/created` 事件（seq===0）为新建 session 初始化 cell (projection/src/index.ts:209-219)。
- **恢复**：重启时由 `SessionProjectionCache.hydratePrepared()` 调用 `ctx.sessionProjections.hydrate(session, checkpoint, events, baseSeq)` (projection-cache/src/index.ts:171-193)；checkpoint 行 `ver` 匹配则跳过已折叠前缀，否则冷读重 fold。
- **独立 checkpoint？**：goal 没有单独的持久化 checkpoint；依赖 `session-projection-cache` 将每个 unit 的状态作为 `(sessionId, key, ver, seq, val)` 行存储到 `session_projcache` domain (projection-cache/src/index.ts:84-384)。
- **crash 安全**：cache write 在 `sessions.flush(session)` **之后**（projection-cache/src/index.ts:205-221），所以 cache 落后于 event log 永远不会产生幻影值。

### Todo
- 同理，`tool-todo` 注册 `key:'todos'`，`stateVersion: 2` (tool-todo/src/index.ts:134-145)。
- 恢复路径相同，checkpoint 也是同一 `session_projcache` domain。

【已证实】

---

## 5. Agent 新一轮请求如何读取/注入 goal/todo

**目标状态**：goal/todo 不自动出现在系统提示或模型历史里。模型通过**工具调用**读写它们：

- **读 goal**：`get_goal` 工具（tool-goal/src/index.ts:194-204）→ `ctx.goals.get(execution.agent)`。
- **写 goal**：`create_goal` / `update_goal` 工具（index.ts:206-336）。
- **读 todo**：无专用 read 工具；模型依赖自身记忆或 `todo_write` 返回的 `counts` 确认。
- **写 todo**：`todo_write` 工具（tool-todo/src/index.ts:146-222）。

**自动 goal round 注入**（goal-round-driver/src/index.ts:76-444）：
- 当 `goal.phase === 'active' && goal.activation === 'armed'` 且 `roundsStarted < maxGoalRounds`，driver 在 agent 进入 idle 后自动构造一条 `user/message`（source.kind==='goal', round=roundsStarted+1），通过 `agent.followup(message)` 投入 inbox。
- pre-step hook 校验 reservation 是否仍匹配当前 goal revision（index.ts:349-414）。
- **不进入系统提示**，只在 session 事件日志中作为 `user/message` 出现，被 SurfaceManager 折叠进模型历史。

**新一轮启动时**（agent-loop/src/index.ts:426-443, 726-774）：
- `resumeWith` → `persistence.prepare` → `SessionPreparation` → `setupAndPublish`。
- 恢复流程：JSONL backend 加载事件 → `SessionProjectionCache.hydratePrepared` 恢复 projection cells → agent loop 启动后 goal/todo 状态已是最新投影值（projection.spec.ts:163-204 fork 继承测试已证实）。
- **激活状态**：重启后 goal 的 `activation` 必然是 `'disarmed'`（goal.spec.ts:163-180 已证实；tool-goal 的 guidance 也提到 "After session resume or fork, an active goal is disarmed"）。

【已证实】

---

## 6. 更新的权限、阶段、revision/CAS 校验与失败行为

- **所有写入**均经过 `prepareMutation(agent)` → `assertLive(agent)` 验证 agent 是当前 live 实例（runtime.ts:448-471）。
- **CAS ref**：`expectCurrent(state, ref)` 比对 id 与 revision 完全一致；不匹配抛 `GOAL_STALE_REVISION`（runtime.ts:454-463）。
- **edit 权限**：工具层 `requireDirectHuman(ctx, execution)` 强制要求 turn 内有 `source.kind==='user'` 的 root agent 消息（authority.ts:99-102）。
- **complete/block 权限**：`completionAuthority` 允许 direct human 或 matching goal round（authority.ts:110-116）。
- **blocked 阈值**：默认 `blockedAfterConsecutiveRounds=3`，工具层在 roundsStarted 不足时拒绝（tool-goal/src/index.ts:298-304）。
- **失败行为**：
  - 非法 transition → `GOAL_INVALID_TRANSITION`
  - 非法 block reason → `GOAL_INVALID_BLOCK_REASON`
  - 非法 objective → `GOAL_INVALID_OBJECTIVE`
  - 非法 maxGoalRounds → `GOAL_INVALID_MAX_ROUNDS`
  - 非法 edit payload → `GOAL_INVALID_EDIT`
  - goal 已存在 → `GOAL_ALREADY_EXISTS`
  - 无 goal → `GOAL_NOT_FOUND`
  - agent 非 live → `GOAL_AGENT_NOT_LIVE`
- **错误传播**：`GoalError extends HarnessError`，含稳定 code 字符串（runtime.ts:20-28）。
- **投影失败隔离**：`applyGoalProjection` catch 后写入 `failure` 字符串，不抛；后续 `state()` 读时若 failure !== null 才 throw（runtime.ts:146-159, 474-479）。

【已证实】

---

## 7. Restart / Resume / Fork / 多实例行为

### 已证实
- **Fork**：子 session 继承父 session 的全部事件；goal projection 的 `init(header, inheritedEventCount)` 会 fold 整个 inherited 前缀，goal 状态（含 roundsStarted）正确传递，但 `activation = 'disarmed'`（goal.spec.ts:182-204）。
- **Resume 恢复**：goal 通过 projection cache checkpoint 或冷 fold 恢复，phase、revision、roundsStarted 均正确；activation 为 disarmed（goal.spec.ts:163-180）。
- **disarm 不写事件**：`ctx.goals.disarm(agent)` 只改内存，不 append 事件（goal.spec.ts:217-229）。
- **HMR/服务卸载**：`GoalService` fiber dispose 时从 registry 移除，projection key 消失；重新挂载后从 checkpoint/log 恢复（goal.spec.ts:231-249, projection.spec.ts:239-246）。
- **tool-goal 工具 rearm**：resume/restart 后需 `update_goal action=resume` 才能 rearm（tool-goal.spec.ts:411-428 已证实）。
- **goal-round-driver 重启**：plugin 重新 mount 时会 `disarm` 所有现有 agent 的 activation（driver/src/index.ts:417-421），防止跨实例意外继续。

### 不能证实
- **多实例并发**：文档未说明不同 DSH 进程对同一 session 的并发写行为。
- **Web GUI 中的 goal/todo 持久化**：超出限定范围，未调查。
- **跨进程 session 共享**：无源码证据。

---

## 8. Goal 与 Todo 是否自动联动

- **源码中无联动**：
  - `packages/goal/**` 中无任何 `todo` 引用（grep 已清空）。
  - `packages/todo/**` 中无任何 `goal` 引用（grep 已清空）。
- Goal 和 todo 是完全独立的两个 projection unit，各自监听不同的事件类型（`goal/change` vs `todo/write`）。
- **工具描述中提到 todo**：`todo_write` 的 description 列举了 subagent/background command 等用法，但未绑定 goal；`create_goal` 的描述也未提及 todo。
- **结论**：TODO 大幅变化不会改 goal；goal 更新也不会改 todo。两者只在模型侧通过工具调用协同，代码层面无耦合。

【已证实】

---

## 供后续代理直接引用的摘要

| 问题 | 核心结论 |
|---|---|
| goal 实体 | `GoalSnapshot {id,revision,objective,phase,maxGoalRounds,blockedReason?}` + `GoalView` (+`roundsStarted,createdAt,updatedAt,activation`) |
| goal 事件 | `goal/change` 全快照；`user/message` source.kind==='goal' 推进 roundsStarted |
| todo 实体 | `TodoItem {content,status}`，列表整体替换 |
| todo 事件 | `todo/write {todos: TodoItem[]}` |
| revision 变化 | 每次写入 +1；create 固定为 1 |
| edit 语义 | 全量浅拷贝 + spread 覆盖目标字段；phase/blockedReason 不可变 |
| TODO 删除 | 从列表中省略该 content 行 |
| Session 关联 | 每个 session 一个 `GoalProjectionState` cell，由 projection registry 驱动 |
| 恢复机制 | `session-projection-cache` 持久化 checkpoint，restore 时 vet 版本后 fold 尾部 |
| Agent 注入 | 无自动注入；通过 `get_goal`/`create_goal`/`update_goal`/`todo_write` 工具读写 |
| 权限模型 | edit/pause/resume 需 direct human；complete/block 可额外由 goal round 授权 |
| CAS | ref.id+ref.revision 必须匹配当前；否则 `GOAL_STALE_REVISION` |
| Restart 后 | activation 必为 disarmed，需手动 resume 才可继续 |
| Fork 继承 | roundsStarted 继承，activation disarmed |
| goal↔todo 联动 | 无 |

## 交给其他任务的问题

1. **`goal/changed` 事件的 Scope 分发**：`@deepseek-ai/dsh-scope` 如何过滤 agent-scoped listener？这影响 multi-agent 场景下 goal 通知的隔离性（待深挖：`dsh-scope` 包）。
2. **`turnBoundary` 投影如何与 goal 授权联动**：authority 依赖 `openTurnStartSeq`，但其定义在 `dsh-agent-loop` 内部；跨 agent-loop 实例的行为待查。
3. **Web GUI 对 goal/todo 投影的实时消费**：当前仅证实 host 端 `ctx.sessionProjections.snapshot()` API，browser cell 的消费链路未查看。
4. **Checkpoint 与 JSONL 的原子性边界**：projection cache 的 fail-soft write 与 session event log 的 fsync 之间存在窗口，crash 一致性细节需查 `session-persistence-jsonl` coordinator。

---

*文件数：约 14 个实现文件被阅读/引用。*