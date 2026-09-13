# DSH 原生 Goal/Todo 变更 → 插件长期状态 传播链审计

> 审计对象：本仓库（`dsh-context-enhancement`）当前未提交工作树，只读。
> 原生侧事实（`goal/change` 事件、`ctx.goals.*`、`todo_write` 全表替换、projection key、恢复路径）**不重新调查**，一律引用 `调查资料/04-Goal与Todo长期状态.md`（下称 **04**）。
> 本文件只回答「原生 Goal/Todo 的变化怎样进入插件长期状态（task-state stable）并回到模型」。
> 证据标记：【已证实】= 有源码/测试行号；【待深挖】= 有间接证据但未闭环；【未找到】= 范围内无证据。
> 范围：核心实现 16 个文件（含测试交叉验证 7 个），依赖只追一层。

---

## 0. 结论速览（7 个封闭问题）

| # | 问题 | 结论 | 判定 |
|---|---|---|---|
| 1 | 是否观察 `goal/change` | **观察**：`goal/change` 在插件事件白名单内，按「全快照」投影；`goal/change{operation:'clear'}` 只投影 `{operation:'clear'}` | 【已证实】 |
| 2 | TODO 全表替换如何采集 | 每个 `todo/write` 事件按**完整列表**采集（`content` + `status`，逐项字节截断），无 diff、无 id、无跨事件合并；**空列表被丢弃**，故「清空 TODO」在插件侧不可见 | 【已证实】 |
| 3 | 是否计入有效事件 | **计入**：只有 `isEligibleType` 通过 **且** `filterEvent` 非空的事件才 `observe(+1)`；两者都按事件计数，与载荷大小无关 | 【已证实】 |
| 4 | 大变更是否立即触发 | **不触发**。触发条件只有「未提交游标之上的可投影有效事件数 ≥ `minEvents`」，无尺寸/权重/紧急通道；`maxEvents`、`maxInputBytes` 只是窗口上限，本身不触发 | 【已证实】 |
| 5 | 合并语义是否允许替换/取消/删除/supersede | **允许**：候选输出是**整份内容全量替换**；「取消/删除」= 省略该条目；「supersede」= 丢掉旧 id 重新提交无 id 条目；echo 旧 id 必须逐字携带原内容，否则 Host 抛错。**但 supersede 只能是模型在候选里显式表达，插件不做语义比对** | 【已证实】 |
| 6 | 提交后注入缓存 | 插件侧**无缓存**：每次 prompt 装配同步读已提交指针（1 次 `getStable`），逐属性全量渲染。唯一的「缓存/去重」在 DSH 侧 `RuntimeContextProjection`（文本相同则不再注入新快照） | 【已证实】 |
| 7 | DSH Goal 与插件长期状态是否形成双权威 | **不构成对 Goal/Todo 事实的双权威**（插件从不回写 `goal`/`todo`，插件里的 `todoReferences` 是指向 DSH 事件的序列引用而非内容权威）；但**构成对"当前任务叙事"的第二次表述**，且该表述被注入模型 history 后不会因原生状态变化而被撤销 | 【已证实】+风险 |

---

## 1. 传播链（端到端，含路径行号）

```
DSH 原生写             插件读取                    计数                提交               注入
goal/change ─┐
todo/write ──┼→ filter.ts case → 投影 JSON ─→ worker.observe(+1) ─→ 阈值 minEvents ─→ 辅助模型全量重写 ─→ putStable ─→ prompt/render 注入 history
其他 12 类 ──┘   (ELIGIBLE_TYPES)                 (pendingEligible)     (foldBatchWindow)   (commitStable)      (systemPrompt)
```

| 环节 | 位置 | 说明 |
|---|---|---|
| 事件白名单 | `src/internal/task-state/basic/filter.ts:502-522` | `ELIGIBLE_TYPES` 含 `goal/change`、`todo/write` |
| 永不入投影 | `src/internal/task-state/basic/filter.ts:525-529` | `NEVER_ELIGIBLE` |
| 观察者 | `src/internal/task-state/basic/service.ts:409-425` | `ctx.on('session/event', …, { global: true })`：先 `isEligibleType`，再 `filterEvent !== null`，然后 `worker.observe(seq)` + `queueMicrotask(maybeSchedule)` |
| 计数 | `src/internal/task-state/basic/worker.ts:139-147` | `observe()` 抬高 `pending` 并把 `pendingEligible += 1`；不区分事件类型 |
| 阈值 | `src/internal/task-state/basic/worker.ts:156-164` | `if (this.pendingEligible < this.minEvents) return` |
| 窗口折叠 | `src/internal/task-state/basic/batch.ts:76-139` | `foldBatchWindow`，`maxEvents` / `maxInputBytes` 双上限 |
| 更新+提交 | `src/internal/task-state/basic/worker.ts:254-307`、`update.ts:147-207`、`update.ts:352-460` | 一次辅助 LLM 调用 → `normalizeCandidate` → `commitStable` → `putStable` |
| 指针发布 | `src/internal/task-state/basic/service.ts:543-566`、`service.ts:764-778` | `publishCommitted` / `getStable` |
| 注入 | `src/internal/task-state/prompt/index.ts:58-77` + `prompt/render.ts:106-121` | `{{task_state_snapshot}}`，`order: 125` |
| 落进 history | DSH 侧 `packages/core/agent-loop/src/agent.ts:239-248`、`runtime-context.ts:64-75`（仅作依赖，引用不展开） | 只在渲染文本变化时追加一条 user-role 快照 |

---

## 2. Q1 —— 是否观察 `goal/change`【已证实】

- `filter.ts:508` 把 `'goal/change'` 列入 `ELIGIBLE_TYPES`；`service.ts:411` 与 `service.ts:477` 都走 `isEligibleType`，因此原生 `goal/change` 会被计数。
- 投影语义（`filter.ts:374-403`）：**全快照**，不保留增量。字段：
  - `operation`（沿用原生操作名，原样透传，`filter.ts:383`）；
  - `goal.id`、`goal.revision`、`goal.phase`（只在类型匹配时保留，`filter.ts:385-387`）；
  - `goal.objective` 走 `boundField(..., limits.stateBytes)`（默认 2000 字节，`filter.ts:51-62`）；
  - `goal.maxGoalRounds`（`filter.ts:389-391`）；
  - `roundsStarted` 从事件顶层读取并挂在 `goal` 之下（`filter.ts:392-397`）；
  - `blockedReason` 只保留 `code` 字符串（`filter.ts:398-400`）。
- `clear` 特例：`filter.ts:377` 命中 `operation === 'clear'` 时**立即返回** `{kind:'goal/change', operation:'clear'}`，即目标被清除的信息会进入投影，但**不带任何被清除目标的字段**（无 id、无 objective）。
- `goal/change` 的 `data` 不是对象、或非 clear 且 `data.goal` 不是对象 → 返回 `undefined` → `filterEvent` 返回 `null` → **既不投影也不计数**（`filter.ts:375-379`）。测试：`tests/task-state-filter.spec.ts:423-427`（`data:'no'` → null；`{operation:'resume'}` 无 goal → null；`clear` → 非 null）。
- 与 04 的一致性：04 记载 `goal/change` 是"完整快照或清除墓碑"、`revision` 每次写 +1、`phase ∈ {active,paused,blocked,complete}`。插件投影与之一致，**没有**消费 04 中提到的 `user/message{source.kind:'goal'}` 之外的 goal 字段（该 message 由 `filter.ts:291-299` 以 `kind:'goal-continuation'` 形式单独采集，不是 goal 状态）。
- 【未找到】插件对 `goal/change` 的 `revision` 做任何比较/去重/乱序检测：`revision` 只是抄进投影文本交给辅助模型，插件自身没有 goal 状态机。

---

## 3. Q2 —— TODO 全表替换如何采集【已证实】

- 采集点：`filter.ts:460-471`。要求 `data.todos` 是**非空数组**；逐项产出 `{content: boundField('todo/write.content', …, stateBytes), status: stringField(todo.status)}`。
- **无 id、无 diff、无跨事件比较**：插件不计算"新增/删除/状态迁移"，每个 `todo/write` 都是"当时的完整列表"这一条事实。空数组被丢弃。
- 为什么必须整表采集：04 §3 记载原生 `todo_write` 每次写入完整 `TodoItem[]`，无增量字段、无 id。插件因此**只能**整表采集；若某次写入在窗口内多次，模型收到的是多条完整列表（后者在语义上可覆盖前者，但由模型自行判断）。
- 逐项截断而非整表截断：每个 `content` 独立吃 `stateBytes`（默认 2000 字节），**没有列表总字节上限**；总字节由窗口预算 `maxInputBytes` 兜底（`batch.ts:110-120`）。所以一次写 200 条长 TODO 会把窗口撑到预算上限，可能触发 `kind:'infeasible'`（见 Q3/Q4）。
- **【已证实】清空语义丢失**：`filter.ts:463` `if (!Array.isArray(todos) || todos.length === 0) return undefined`；测试 `tests/task-state-filter.spec.ts:229-230` 明确断言 `{todos: []}` → `null`。
  原生侧是否会产生空表写入：`deepseek-harness/packages/todo/tool-todo/src/index.ts:92-110` 的 `toTodoList` 对 `args.todos` 逐项校验，**未拒绝空数组**；`invariant.ts:22-56` 也不要求非空。故 `todo_write({todos: []})` 是合法原生事件（"清空全部待办"），但它：
  1. 不进 `pendingEligible`（因 `filterEvent === null`，`service.ts:415`）；
  2. 不构成任何投影事实，辅助模型永远看不到"列表被清空"。
  后果链条：插件 stable 里此前的 `todoReferences` 会在下一次更新时因 seq 越界被隔离丢弃（`host.ts:172-182`、`update.ts:400-423`），但**丢弃本身也只发生在下一次真正提交的窗口里**；在下一次提交之前，stable 与注入文本仍然显示"已过期但看起来仍有效"的 TODO 引用（见 Q6）。
- 过期引用不是错误：`host.ts:153-159` 注释显式说明"折叠窗口之外的引用被隔离而非致命"，`update.ts:416-419` 记 warn 日志。这是防止 stable 永久冻结在旧 revision 的补偿设计。

---

## 4. Q3 —— 是否计入有效事件【已证实】

计数判定与原生 Goal/Todo **无关**，只看插件自己的过滤函数：

1. `service.ts:411`：`if (!isEligibleType(event.type)) return`；
2. `service.ts:415`：`if (filterEvent({type, seq, data}) === null) return`（注释 `service.ts:412-414` 明确："空投影的事件绝不能抬高阈值"）；
3. `service.ts:421`：`runtime.worker.observe(event.seq)` → `worker.ts:139-142` `pendingEligible += 1`。

补充事实：

- 每次事件在观察路径上会被过滤**两次**（`service.ts:411` + `service.ts:415`，`filterEvent` 内部 `filter.ts:558` 再判一次 `isEligibleType`），是纯函数、无副作用，只影响 CPU，不影响正确性。
- `eligibleEventCount`（`service.ts:471-482`）在需要重算时把**同一套**判据在整条 log 上重跑一遍，保证增量计数与真实 log 一致（`worker.ts:144-147, 241, 302`）。
- `goal/change` 与 `todo/write` 各算 **1** 个事件，与载荷大小、`revision` 跳变幅度、列表长度无关。一次 `revision +5` 的 goal 编辑、或一次写入 40 条 TODO 的 `todo_write`，对阈值的贡献都是 1。
- 计数按 Session 隔离：`service.ts:416-417` 要求 `runtime.session === session`；`runtimeFor` 还用 `createdAt`/`cwd` 做生命周期栅栏（`service.ts:311-339`）。
- 【未找到】任何"高影响事件加权/立即优先"的计数变体（无 `isHighImpact`、无 priority、无 force 标志）。

---

## 5. Q4 —— 大变更是否立即触发【已证实】

**不会。** 触发路径只有一条，且是纯计数阈值：

- `worker.ts:156-164` `maybeSchedule()`：`if (this.pendingEligible < this.minEvents) return` → 否则 `launch('threshold')`。
- 调用时机仅两处：`service.ts:422-424`（每个可投影有效事件后的 microtask）、`worker.ts:243 / 250`（上一轮提交后的补跑）。
- `minEvents` 无默认值，必须由部署显式给出（`config.ts:56`、`config.ts:17-29` 的 `CONFIG_KEYS`）；当前 composition 取 **20**（`cordis.patch.yml:48`），上限 `maxEvents: 200`（`cordis.patch.yml:49`）。测试用小值（`tests/task-state-long-session.spec.ts:97` `minEvents: 4`）。
- `maxEvents` / `maxInputBytes` **只限制单窗口**（`batch.ts:100`、`batch.ts:111-120`，注释 `types.ts:22-23` "never by itself triggers a batch"），不触发新窗口。
- 无定时器、无周期轮询：唯一的异步调度是阈值 + microtask（`service.ts:422`）。`worker.ts:12-23` 的"wave"模型说明：阈值触发一次、可补一次 trailing、失败不自动重试。
- 尺寸相关的**唯一**分支是窗口折叠：
  - 单事件塞不进整帧 → `kind:'infeasible'`（`batch.ts:111-118`），`worker.ts:193-202` 记 `error` 日志、**不派发模型、不推进游标**，且**不自发重试**（只有后续活动再次越过阈值才会重折）。此时该超大 `goal/change` 或 `todo/write` 就**卡在游标之上**。
  - 窗口中途超预算 → `break`（`batch.ts:119`），剩下的进下一波。因为游标只推进到已折叠的最后一个 seq（`update.ts:425`、`batch.ts:123`），下一波仍能折到它。
- 【已证实】因此「一次巨大的 TODO 列表替换」不会更快进入长期状态，反而因为占据窗口预算而**推迟**后续事件的提交。
- 【未找到】任何"目标 phase 变为 blocked/complete 即立即提交"的紧急路径。

---

## 6. Q5 —— 合并语义：替换 / 取消 / 删除 / supersede【已证实】

合并发生在**辅助模型输出 → Host 归一化**这一层，语义是"整份内容全量替换 + id 回声约定"：

- 指令层（`prompt.ts:29-58` `TASK_STATE_SYSTEM_INSTRUCTION`，逐字固定并被审计行记录）：
  - `prompt.ts:49` 新条目**省略 id**，Host 铸造带前缀 id；
  - `prompt.ts:50` 沿用旧条目**必须逐字回声其既有 id**；
  - `prompt.ts:51` **"An entry you remove entirely disappears"** —— 删除/取消 = 在候选里省略；并且"内容变了就丢 id 重加新条目"（即 supersede 的规范写法）；
  - `prompt.ts:55` `continuation` 与 TODO 分离："TODO stays separate and is only referenced, never merged into these fields"。
- 基线层：上一份 stable 的**内容**（不含 Host 提交元数据）随帧发给模型（`prompt.ts:69-86` `frameProjection` → `contentOfStable`，`prompt.ts:88-111`）。
- 校验层（`host.ts:65-213` `normalizeCandidate`）——允许与拒绝的精确边界：
  - 无 id → 铸造新 id（`host.ts:120-124`）；
  - echo 未知 id → 抛错（`host.ts:128-130`）；
  - 同一 id 在整份候选中重复（跨 kind 也算）→ 抛错（`host.ts:131-134`，注释 `host.ts:107-109`）；
  - echo 的 id 落进错误 kind 列表 → 抛错（`host.ts:138-140`）；
  - **echo id 但改了内容 → 抛错**（`host.ts:143-147`），注释要求"改内容就丢 id 加新条目"；
  - 引用类字段：`evidence` / `todoReferences` 的 `seq` 必须落在本窗口 `includedSeqs` 内，否则**隔离丢弃 + 保留其余字段**（`host.ts:161-182`），不使整份候选失败（理由见 `types.ts:87-98` 与 `update.ts:413-423`）；
  - 列表容量上限 `maxListItems` / `maxEntriesPerKind` / `maxEntryBytes` 越界即抛错（`host.ts:169-188`、`host.ts:100-101`）。
- 提交层：`commitStable` 铸 `revision = base.revision + 1`、`sourceCursor = 最后一个已折叠 seq`（`update.ts:152`、`update.ts:425-434`），整体替换该 Session 的稳定记录（`worker.ts:339-342` → `service.ts` `putStable`）。**没有**条目级增量补丁。
- 用户手改路径也是"全量替换"，但保留引用：`service.ts:721-762` `resolveManualContent` 只接受 facts/decisions/constraints/risks/continuation，内容相同的条目复用旧 id（`service.ts:743-744`），`evidence` 与 `todoReferences` **原样保留**（`service.ts:759-760`）。所以人工编辑**不能**修正被清空 TODO 造成的陈旧引用。
- 【待深挖】"supersede" 的质量完全依赖辅助模型是否正确执行 `prompt.ts:50-51`；插件不做语义比对，也没有"旧条目是否被新条目取代"的检查。若模型 echo 旧 id 并想表达内容演进，会被 `host.ts:143-147` 直接判失败（整轮候选作废，见 `update.ts:402-412`）。

---

## 7. Q6 —— 提交后注入与缓存【已证实】

插件侧读取链：

- 注册：`prompt/index.ts:60-76`，`ctx.systemPrompt.context({name:'task-state:snapshot', order:125, text:'{{task_state_snapshot}}'})` + `ctx.systemPrompt.variable('task_state_snapshot', …)`。
- 每次装配读取：`prompt/index.ts:68-76`，用 `context.agent?.session.id` 取 `ctx.get('taskState')?.getStable(sessionId)`；`getStable` → `service.ts:774-778` → `publishedStable`（`service.ts:764-772`）直接返回**内存中的已提交指针**，同步、无 IO、无 await。
- 渲染：`render.ts:106-121`，`linesOf`（`render.ts:44-90`）**逐属性**重建全文：header（revision / sourceCursor / digest，`render.ts:45-47`）→ continuation（`render.ts:48-66`）→ Facts/Decisions/Constraints/Risks/EVIDENCE/TODO REFERENCES（`render.ts:68-88`，TODO 段在第 82-87 行）。超预算时从尾部整行丢弃并追加固定标记（`render.ts:111-120`、`render.ts:16`）。
- **插件侧无任何缓存**：没有按 revision/seq 缓存渲染结果、没有增量 diff、没有上次注入文本的记忆。测试 `tests/task-state-prompt.spec.ts:131-150` 明确断言"每次装配恰好一次 `getStable`，第二次装配再次调用"——即**每次请求都重新读、重新渲染**。
- 「无 stable 时贡献空串」：`prompt/index.ts:74` `if (stable === undefined) return ''`；测试 `tests/task-state-prompt.spec.ts:152-155`。即**首次提交之前，插件对模型完全不可见**（只有阈值跨过并成功提交后才有内容）。
- 真正的"缓存/去重"在 **DSH 侧**（引用依赖，未展开）：`packages/core/agent-loop/src/runtime-context.ts:64-75` `RuntimeContextProjection.project` 只在渲染文本与上一次保留值不同时才产生新快照，`agent.ts:239-248` 把它作为 user-role 消息追加进本步消息；`packages/core/system-prompt/src/index.ts:290` 的文案是"This snapshot supersedes earlier runtime-context snapshots"。
- 由此得到两个传播性质：
  1. **延迟**：注入不发生在提交瞬间，而是发生在下一次模型步的装配（`agent.ts:239`）。
  2. **不可撤销**：旧快照一旦进入 history 就留在 history；只有当渲染文本发生变化时才会追加新快照去覆盖语义。若 stable 未提交（阈值未到、`infeasible`、辅助请求失败），模型继续看到旧快照且**没有任何"已过期"标记**（只有超出字节预算时才有 `TASK_STATE_TRUNCATION_MARKER`，`render.ts:16`，那是长度标记而非时效标记）。
- 【未找到】插件内部任何"提交后立即推送/唤醒模型/追加事件"的机制：辅助更新是旁路 LLM 调用（`update.ts:229-254`，`purpose:'task-state'`、`source.kind:'plugin'`），不写 Session 事件、不唤醒 agent loop。

---

## 8. Q7 —— DSH Goal 与插件长期状态是否形成双权威【已证实】

**对 Goal/Todo 事实本身：不构成双权威。**

- 插件**从不回写** goal/todo：全仓 `grep` `append('goal` / `append('todo` / `ctx.goals` 在 `src/**` 内**零命中**；插件只在过滤器里**读**事件（`filter.ts:11-15` 注释自述"reads plugin-owned event vocabulary … through a widened JSON view"）。
- 插件对 goal 派生出的 `GoalProjectionState` 一类状态**不存在**：`roundsStarted`、`phase`、`blockedReason` 只是被复制进辅助请求的投影文本（`filter.ts:385-400`），插件不保存、不比较、不驱动任何行为。因此 04 §1 的 goal 权威仍在 `packages/goal/**`。
- 插件对 TODO 只保存**引用**（`todoReferences: {seq, content}`，`types.ts:121-122`、`spec.ts:70-75`、`host.ts:172-182`），其中 `seq` 指向 DSH 权威事件；`content` 是**为了可读而抄录的副本**（`prompt.ts:54` 要求模型给出"bounded readable content"）。这是唯一的"内容副本"面，且被 `host.ts:174-177` 的窗口校验约束。渲染时两者一并显示（`render.ts:82-87`：`- <content> (session event <seq>)`）。
- 单一权威链：`sourceCursor` 单调，只随成功提交推进（`update.ts:425`、`batch.ts:123`），失败/不可行时不推进（`worker.ts:284-290`、`worker.ts:193-202`）；恢复时以存储记录为准（`service.ts:387-397`）。
- 存在**第二条写入路径**但不产生第二权威：GUI 编辑（`control/service.ts:98-106` → `service.ts` `editStable`）用 `revision` CAS（冲突返回 `{ok:false, code:'conflict'}`，`service.ts:688-695`），最终仍写同一个 stable 指针。

**构成风险的边缘（本报告判定为"表述层双重来源"，不是权威冲突）：**

1. 插件 stable 的 `continuation.currentObjective` / `openWork` / `nextActions` 是**模型对同一任务的第二套表述**，与 DSH goal 的 `objective` 无同步关系（虽然二者共享**同一个原生模型**作为产出者：04 规定 goal 由模型通过 `create_goal`/`update_goal` 工具写，插件由辅助 LLM 写）。**没有任何源码把二者对齐或交叉校验**（`src/**` 无 goal 字段与 continuation 字段的比较逻辑）。
2. 注入面不对称：goal/todo 原生实现**不自动进入系统提示**（04 §5），只有插件快照自动进入（`prompt/index.ts:60-76`）。所以在模型眼中，插件快照是更"顺手"的任务状态来源，而它的时效性只由阈值与辅助模型决定（Q4/Q6）。
3. 陈旧窗口（Q2 清空 TODO + Q6 不可撤销）会让模型同时看到：原生工具可读的真实 TODO（无读工具，模型得靠自身记忆）与插件快照里的旧 `todoReferences`。这是本次审计发现的**最具体的双来源不一致场景**，且修复面不在 goal/todo 侧。

---

## 9. 与 04 文档的接口约定（引用，不重查）

| 04 的结论（原文位置） | 插件侧对接点 | 一致性 |
|---|---|---|
| `goal/change` 为完整快照或清除墓碑（04 §1） | `filter.ts:374-403`，clear 走独立早返回 | 一致 |
| `revision` 每次写 +1（04 §2） | 仅抄录进投影（`filter.ts:386`），不参与插件逻辑 | 一致（插件不依赖 CAS） |
| `todo/write {todos: TodoItem[]}` 全表替换、无 id（04 §3） | `filter.ts:460-471` 整表采集 | 一致 |
| TODO 删除 = 从列表省略（04 §3） | 插件在新表里看不到被删条目；但**空表被 `filter.ts:463` 丢弃**，因此"删到空"看不见 | **差异（插件侧丢语义）** |
| goal/todo 无自动注入，仅工具读写（04 §5） | 插件快照走 `systemPrompt` 注入（`prompt/index.ts`），与原生不同面 | 补充事实 |
| goal↔todo 无联动（04 §8） | 插件把二者放进**同一个**辅助投影与同一份 stable | 一致（插件只是并列，无联动逻辑） |
| 恢复：session-projection-cache 持久化 goal/todo（04 §4） | 插件用自己的 storage domain（`domain.ts:37-44`），不读该 cache | 两套独立持久化，见 §8 |

---

## 10. 供后续代理直接引用的结论摘要

| 问题 | 结论（可直接引用） |
|---|---|
| goal/change 是否被观察 | 是。`ELIGIBLE_TYPES` 含 `'goal/change'`（`filter.ts:508`），全快照投影（`filter.ts:374-403`），`clear` 只留 operation（`filter.ts:377`） |
| goal 投影字段 | `operation` + `goal{id?,revision?,phase?,objective(≤stateBytes),maxGoalRounds?,roundsStarted?,blockedReason?.code?}`；非对象/无 goal → 不投影不计数 |
| todo 全表如何采集 | 每个 `todo/write` 采整表 `{content(≤stateBytes), status}`（`filter.ts:460-471`）；无 id、无 diff、无事件间比较 |
| 空 TODO 表 | `{todos:[]}` → `filterEvent` 返回 `null`（`filter.ts:463`；测试 `task-state-filter.spec.ts:229-230`）→ 不计阈值、不进投影；原生侧空表合法（`tool-todo/src/index.ts:92-110`）→ **"清空待办"对插件不可见** |
| 有效事件判定 | `isEligibleType && filterEvent !== null`（`service.ts:411,415`）→ `observe(+1)`（`worker.ts:139-142`）；goal/change 与 todo/write 各算 1，与大小无关 |
| 大变更是否立即触发 | 否。唯一触发是 `pendingEligible >= minEvents`（`worker.ts:156-164`）；部署值 20（`cordis.patch.yml:48`）；无尺寸/优先级/紧急通道 |
| maxEvents/maxInputBytes 角色 | 仅窗口上限（`batch.ts:100,111-120`），不触发；单事件超预算 → `infeasible`，不派发、不推进游标、不自发重试（`worker.ts:193-202`） |
| 合并语义 | 整份内容全量替换；沿用条目 echo 原 id 且内容必须逐字相同（`host.ts:143-147`）；删除/取消 = 省略（`prompt.ts:51`）；改内容 = 丢 id 重加（supersede） |
| 引用类字段 | `evidence` / `todoReferences` 的 `seq` 必须在本窗口 `includedSeqs` 内，否则隔离丢弃（`host.ts:161-182`、`update.ts:413-423`） |
| 提交 | `revision = base+1`、`sourceCursor = 最后折叠 seq`（`update.ts:152,425-434`）；失败保留旧 stable（`worker.ts:284-290`） |
| 提交后注入 | 每次 prompt 装配同步读 `getStable` 并**全量重渲染**（`prompt/index.ts:68-76`、`render.ts:106-121`）；测试证明无缓存（`task-state-prompt.spec.ts:131-150`）；首个 stable 之前贡献空串（`prompt/index.ts:74`） |
| 注入的落点 | 动态 runtime context（`order:125`）→ DSH `RuntimeContextProjection` 仅在文本变化时追加 user-role 快照（`agent-loop/src/runtime-context.ts:64-75`、`agent.ts:239-248`） |
| 双权威 | 对 goal/todo 事实**否**（插件零回写：`src/**` 无 `append('goal`/`append('todo`/`ctx.goals`）；todo 只存 `{seq,content}` 引用）。风险在"任务叙事二次表述 + 注入不可撤销" |
| 手工编辑 | 走同一 stable 的 `revision` CAS（`service.ts:688-695`），保留 `evidence`/`todoReferences`（`service.ts:759-760`），因此**无法**修正陈旧 TODO 引用 |

---

## 11. 交给其他任务的问题

1. **空 `todo/write` 的语义缺口（最高优先）**：`filter.ts:463` 丢弃空表，导致"清空全部待办"这一合法原生操作在插件侧完全不可观测。需确认：这是刻意设计（视清空为无信息量）还是缺陷？若要修，最小改动面是 `filter.ts:463` + `host.ts` 的 todo 引用语义 + 注入文案时效标记（`render.ts`），**涉及 3 个文件的契约变更**，超出本审计范围。
2. **`infeasible` 窗口的停滞风险**：超大 `goal/change`（objective 截断后仍超整帧）或超大 `todo/write` 会让窗口不可行，而 `worker.ts:193-202` 明确"不自发重试"。需查：后续事件继续累积时该事件是否必然被后续窗口带走（`maxEvents: 200`、`maxInputBytes: 60000` 下的实际概率），以及是否存在永久停滞（每次重折都在同一事件上失败）。
3. **注入无时效标记**：`render.ts` 只有长度截断标记（`TASK_STATE_TRUNCATION_MARKER`），没有"本快照依据的 source event 之后又发生了 N 个未折叠事件"的提示。是否需要在 header（`render.ts:45-47`）加入滞后提示，属于设计决策，需与 `压缩方案4.md` 基线对齐。
4. **goal 与 continuation 的对齐**：需要确认是否存在产品意图让 `continuation.currentObjective` 跟踪 DSH goal 的 `objective`（目前完全独立，二者由不同调用方产生）。若要跟踪，需要引入 goal 读取路径，会打破"插件不消费 `ctx.goals`"的现状（现为 `src/**` 零引用）。
5. **`user/message{source.kind:'goal'}` 的采集边界**：`filter.ts:291-299` 把 goal round 文本记成 `kind:'goal-continuation'` 并消耗 `userMessageBytes`（4000）。需与 04 §5 的 goal-round-driver 行为对齐，确认自动 goal round 是否会以高频方式抬高阈值（每轮 +1）。
