# 插件架构与 DSH 集成地图

> 目的：汇总“调查 DSH”阶段形成的事实，说明当前插件怎样接入 DSH，以及下一阶段推导可靠落地方案时必须遵守的边界。
>
> 本文是架构地图，不是修复 PLAN，也不把《压缩方案4》的默认参数机械视为最终真理。
>
> 证据来源：`00`–`09`、`11`–`21` 调查文档及其中列出的源码路径。专题文档比本文更详细；若摘要冲突，以更窄范围、更新且直接核验源码的专题为准。

---

## 1. 方法与结论边界

本阶段采用的路线是：

```text
《压缩方案4》提供目标方向与设计基线
        ↓
调查 DSH 的真实数据、生命周期、可变更 seam 与持久化能力
        ↓
调查当前插件如何使用这些能力
        ↓
形成统一集成地图
        ↓
下一阶段再独立推导 DSH 落地方案
        ↓
之后才将合理落地方案与当前插件比较并形成缺陷/修复 PLAN
```

本文不会因当前插件已经实现某种行为，就把该行为当成合理方案；也不会仅凭方案文档与代码有差异，就直接判定代码缺陷。

---

## 2. DSH 核心事实地图

### 2.1 权威事件、可见历史与模型请求

```text
Session append-only event log
        │
        ├─ SurfaceManager 折叠 append / replace
        │      └─ 当前 surface nodes
        │              └─ Session.deriveMessages()
        │                      └─ 模型可见历史 messages
        │
        ├─ Session projections 同步 fold
        ├─ Session persistence write-behind → JSONL/Zstd
        └─ session/event 同步观察者（不可重入 append）

每个 Agent step：
claim signal
→ systemPrompt.assemble（一次）
→ runtime-context 投影
→ agent/pre-step
→ user/message 入日志
→ renderPrompt（一次）
→ retry loop：deriveMessages → agent/request → prepareCall → llm/stream
→ assistant/tool 事件入日志
```

关键约束：

1. Session 日志是原始权威事实；模型历史是 surface 折叠后的派生结果。
2. 修改既有历史的正规通道是追加带 `surfaceOp.replace` 和 `sourceEventSeqs` 的事件，不能直接篡改冻结后的请求 messages。
3. `system-prompt/assemble` 和 `agent/pre-step` 在 retry loop 之前；retry 只重派生 messages 与重跑请求链，不重做 assembly 或工具执行。
4. `agent/request` 只允许修改调用配置；`llm/stream` 接收到深冻结请求，属于包裹流而非合法修改历史的 seam。
5. `agent/request-error` 加 `{kind:'retry'}` 是 overflow 恢复的正规入口。

来源：`00`、`02`、`06`、`20`。

### 2.2 请求预算账本

DSH 的一次模型请求至少包括：

```text
system prompt sections
+ runtime contexts（最终成为 user-role surface messages）
+ Session surface messages
+ tool schemas
+ tool additionalContexts
+ provider framing（核心侧无精确独立计量）
+ output reserve / maxTokens
```

计量和时序约束：

- TokenMeter 的 `surfaceTokens` 表示当前 surface；`totalTokens` 还包含 system/tools 等信封成本。
- `contextWindow` 来自模型 metadata，经 `request/context` 投影；TokenMeter 自身不以它为输入。
- runtime context 与插件注入混入 message/surface token，没有独立可归因字段。
- system/tools 在 usage anchor 有效时可用 provider usage 校准；anchor 失效时退回启发式估算。
- pre-step 阶段拿不到最终 output reserve；`maxTokens` 在 buildRequest 内形成。
- DSH 内核没有统一的上下文注入预算、截断或拒绝机制。
- 动态内容放入 contexts 不会像改变 sections/tools 那样击穿 usage anchor，但旧 context 快照会留在 transcript，文本变化即追加新消息，必须靠 replacement/压缩回收。

来源：`01`、`05`、`20`。

### 2.3 Hook 与生命周期边界

| 能力 | 正规 seam | 持久性/边界 |
|---|---|---|
| 读取当前历史 | `agent.session` surface / `deriveMessages()` / snapshots | 读取当前内存 Session |
| 变更既有历史 | `session.append(surfaceOp.replace)` | 持久事件；重启可回放 |
| 接纳/拒绝当前用户输入 | `agent/pre-step` | 接纳后成为持久 `user/message` |
| 注入长期上下文 | `systemPrompt.context()`、`agent.inject()`、pre-step decision | contexts 最终进入 transcript；需管理累积 |
| 修改模型调用参数 | `agent/request` | 仅本次请求配置 |
| 包裹模型流 | `llm/stream` | 请求只读；可观察/包装响应 |
| overflow 恢复 | `agent/request-error` → `{kind:'retry'}` | retry 重建 messages，不重做 assembly |
| 工具处理 | pre/around/post/result waterfalls | durable `tool/result` 在 `tools/result` 之后入日志 |

Cordis 只有 `prepend`，没有通用 priority；listener 装载顺序会影响 waterfall。链外层不调用 `next()` 会吞掉内层。HMR reload 不保证等待旧 fiber 完成，后台回调必须自带 liveness fence。

来源：`06`、`21`。

### 2.4 持久化、投影与多实例

DSH 存在两类不同基础设施：

1. **Session persistence**：Header + append-only event records，write-behind，恢复连续前缀，可修复 torn tail 与 orphaned turn。
2. **Storage domain**：通用 KV domain；默认 JSON backend，把一个 domain 写成 `$DSH_HOME/storages/<name>.json`。

核心边界：

- Session replacement 作为普通事件持久化，重启时由 surface fold 重建。
- 两个 DSH 进程共享同一 Session 文件时，没有跨进程文件锁、CAS 或变更通知。
- 默认 JSON storage domain 只保证单次调用原子、resolve 即耐久和进程内写链串行；没有跨进程锁、revision/CAS、watcher 或 refresh。
- JSON `single` layout 每次写整文档，跨进程为 last-write-wins，可能静默覆盖无关记录。
- 已实现但默认未接线的 SQLite backend 提供记录级写与 SQLite 锁，但忙锁立即失败，跨进程变更观察仍不在能力范围。
- Session projection 可作为“事件驱动 + 纯同步 fold + plain JSON”的派生状态恢复设施；projection cache 仅是加速层，不是权威状态。
- 在线 `agentLoop.resume` 不使用 observation 路径已经 hydrate 的 projection cache；首次 `stateOf` 可能全量 fold 日志。
- Projection apply 抛错可能持续毒化 key；cache checkpoint 写失败后静默会话可能不自愈；projection 同样没有跨进程失效通知。

来源：`03`、`07`、`08`。

### 2.5 Fork、Resume 与身份

- Create：新 id、新 Session 对象、新日志。
- Load/inspect：同 id、同日志，不一定发布 live Session。
- Resume：同 id、同日志，创建新的 live Session；orphaned turn 可被修复后写盘。
- Fork：新 id、新日志；复制父日志安全前缀的深拷贝，不是 surface 快照。
- Fork 前缀包含原始节点和 replacement 节点；继承 seq 与父保持对齐。
- `inheritedEventCount` 表示继承段边界；`firstLiveSeq` 不能替代它。
- Goal activation 是进程内状态，fork/resume 后 disarmed。
- `SessionId` 只命名存储槽，不足以唯一识别生命周期。稳定状态需要至少结合 `{createdAt,cwd,isSeeded,inheritedEventCount}` 一类 identity fence。
- Fork 没有自动复制独立长期摘要实体；若摘要按 SessionId 存储，子会话继承策略必须显式定义。

来源：`04`、`09`。

### 2.6 后台任务与关闭

可用原语：

- `ctx.jobs.start`：owner 销毁时 cancel + await；owner 有并发上限。
- `agent.runMaintenance`：仅 idle Agent 可启动，失败不污染主 Agent。
- `ctx.effect` / `ctx.on` / Service：随 fiber 生命周期注销；dispose 可等待异步 disposer。
- `dsh-timeout`：通过 AbortSignal 实现 deadline/watchdog。
- ScheduleRuntime 是“requested 标志 + 单飞 + 串行 drain + liveness recheck”的现成范式，但不是通用全局队列服务。

限制：

- 没有 Session 级 AbortSignal；活动 signal 主要绑定 Agent turn 或 maintenance。
- 核心没有通用 per-session mutex、队列或 coalescing 服务，需要业务层自建。
- `session/event` 同步监听器中不可同步 append；应只置标志/入队，再异步处理。
- HMR 可能让旧任务与新 fiber 短暂并存，必须检查 signal、owner identity 和 runtime identity。
- 进程退出只有有限 grace period，后台 stable 提交需明确取消与收尾边界。

来源：`06`、`21`。

---

## 3. 当前插件模块地图

插件代码分为两个主模块和若干桥接/前端模块。

```text
src/index.ts
├─ compaction-basic.ts
│  ├─ internal/compaction/config.ts
│  ├─ envelope-budget.ts / zones.ts / region.ts
│  ├─ source-index.ts / tool-pairing.ts / tool-segments.ts
│  ├─ tool-groups.ts / tool-group-summarizer.ts
│  ├─ tool-group-replacement.ts
│  ├─ tool-group-audit.ts / audit-store.ts / domain.ts
│  └─ tool-result-pruner.ts + src/tool-result-pruner.ts
│
├─ task-state-basic.ts / task-state.ts
│  ├─ internal/task-state/basic/{service,worker,filter,batch,update,host,prompt,domain}.ts
│  ├─ internal/task-state/contract/**
│  ├─ task-state-prompt.ts + prompt/render.ts
│  └─ task-state-control.ts / client stores
│
├─ effect-projection.ts
└─ client/ContextEnhancementView.tsx + locales.ts
```

### 3.1 两条“摘要”链必须区分

| 链 | 权威实体 | 存储位置 | 是否改变 surface | 用途 |
|---|---|---|---|---|
| 主线程 compaction checkpoint | `user/message` replacement + `compaction/summary` | Session log | 是 | 降低当前模型历史体积 |
| task-state stable | `TaskStateStable` + audit | storage domain | 否；通过 runtime context 注入 | 保存长期任务叙事与继续执行信息 |

二者被有意隔离：compaction checkpoint 的 source 为 plugin，不进入 task-state 的 user 输入投影。

来源：`15`。

---

## 4. 主线程压缩集成数据流

### 4.1 入口和调度

```text
agent/pre-step
→ resolve routed target / contextWindow
→ tokenMeter.measure(totalTokens, surfaceTokens, per-node tokens)
→ envelope budget（T、S、E=T-S、窗口与预留）
→ partitionSurfaceZones（当前位置索引）
→ 按 40% / 70% / 80% 档执行维护

agent/request-error(CONTEXT_WINDOW_EXCEEDED)
→ recoverOverflow
→ 若 replaceGeneration 前进，返回 retry

/compact
→ compactNow（仍保留旧 retained-tail 路径）
```

插件的触发口径和分区口径不同：触发用 `totalTokens`，surface 分区用 `surfaceTokens` 和每节点路由 token，信封成本 `E=T-S` 用于把总窗口比例转换为可用于 surface 的绝对预算。

### 4.2 三区与批次

- 三区依据当前 surface 位置，不依赖 seq 单调或事件条数。
- 边界从尾部累计 token，并向历史方向调整到工具配对和 step 安全切口。
- 近区还有 open turn、最近完成 turn 和最少 surface turn 的尾部地板。
- 普通遗忘批次从最老端开始，目标/最大预算默认 16k/24k，并受 summarizer 输入上限收窄。
- replacement 后操作级重新计量、重新划区；工具组循环内部不逐组重计量。
- 压力档不是有限多个普通遗忘批次，而是一次 whole-zone span；严格缩减断言只要求至少减少 1 token。

### 4.3 工具组和裁剪

```text
当前区域中的完整 tool segment
→ 同 turn + burst 连续 + 首尾配对平衡
→ 阈值与完整请求可容纳校验
→ LLM 工具组摘要 replacement
→ 重测、重划区、重建 source index
→ 仅 original tool/result 进入确定性裁剪
```

- 方案文档中的五值逐组/逐结果分类未作为类型和返回值实现；互斥主要由持久 provenance/source-index 实现。
- 裁剪调用均传显式候选集合，普通路径不是全表无差别扫描；overflow 第一阶段是例外，会扫描全 surface 的原始大工具结果。
- 同轮 replacement 通过 round-local 集合、批次 break/veto 和 source-index 重入规则排除。

### 4.4 遗忘摘要提交

```text
选择 [start,end] surface span
→ 构建摘要请求
→ 校验 framed summary < shadowed route tokens
→ compaction transaction / bracket
→ append compaction/summary（shadowed range/seq/token）
→ append user/message replacement
→ SurfaceManager 折叠
```

事务提交前检查 surface 稳定、turn 边界和工具配对；失败不替换原 surface。replacement 作为 Session 事件持久化，重启可确定性重放。

### 4.5 Overflow

```text
阶段 A：全 surface 原始大工具结果确定性裁剪
阶段 B1：overflow-forget
阶段 B2：overflow-tool-zone
阶段 B3：overflow-recent
每级有限批次、每批重测；只有前一级无安全候选/已耗尽才跨区
```

恢复完全绕过普通 40/70/80 水线。是否 retry 以 `replaceGeneration` 是否前进为凭据。

来源：`11`–`14`、`18`。

---

## 5. 长期 task-state 集成数据流

### 5.1 输入和调度

```text
session/event 同步观察者
→ filter-v2 投影 eligible event
→ 只 observe 水位并 queueMicrotask
→ per-session worker：pending seq + pendingEligible
→ pendingEligible >= minEvents（默认 20）
→ foldBatchWindow(previousStable + bounded events)
→ 单飞 LLM collect-and-merge
```

输入覆盖 user/assistant/tool/turn、goal/change、todo/write、部分 command/request/compaction 生命周期事件。task-state 自身事件和 compaction summary 被排除。

worker 的语义是单飞、串行 chain 和一次 trailing wave；失败不推进 cursor，也不会主动反复重试，等待后续合法活动。

### 5.2 候选、提交和读取

```text
open audit 落盘
→ LLM candidate JSON
→ parse/schema
→ Host 语义校验（echo id、mint id、窗口证据 quarantine）
→ sessions[SessionId] put stable
→ publish 内存 stable
→ finish audit（失败可后续 repair，不回滚 stable）

每次 system prompt assembly
→ 同步 getStable
→ render bounded snapshot（continuation 优先）
→ order 125 runtime context
→ 文本变化时追加 user-role 快照到 transcript
```

stable 是任务叙事状态，不是 DSH Goal 的副本。Goal/TODO 只是输入事实；插件不回写原生 Goal/TODO。

### 5.3 持久化和回放

- `context_enhancement_task_state` 和工具摘要 audit 都是 storage-domain `single` JSON 文档。
- 每个 Session 只有一条 task-state record，使用 `{createdAt,cwd}` lifecycle fence；没有服务端 revision/cursor CAS。
- 重启后 storage 播种 stable 指针，不重跑模型；Session seed 不发 `session/event`，因此不会重复更新。
- 重启后 cursor 以上积压不会自动启动 batch，需等待下一个 eligible event。
- 同 `$DSH_HOME` 的两个进程各自缓存整份 JSON；互相不可见，并会以整文档 LWW 覆盖对方记录。

### 5.4 Goal/TODO 传播

- `goal/change` 按全快照投影并计一个 eligible event。
- `todo/write` 按整表投影并计一个事件，变化大小不影响触发优先级。
- 大幅变更不会立即触发；仍需累计达到 `minEvents`。
- 合法的空 TODO 表被过滤为 null，因此“清空所有 TODO”不会进入 task-state。
- Candidate 合并可通过省略删除条目；改内容需丢弃旧 id 并新建，但这依赖模型正确表达。
- 注入每次读取最新 stable，无额外插件缓存；然而旧 runtime context 快照仍留在 transcript，直到主线程 replacement 回收。

来源：`15`–`17`、`20`。

---

## 6. Web 与可观测性地图

```text
TokenMeter contextPressure projection
→ Session controller wire
→ client projection store
→ ContextMeter
    used = projectedTokens ?? pressureTokens
    total = contextWindow
    percent = round(used / total * 100)

compaction/summary
→ trajectory definition / CompactionItem
→ “已压缩 N 条历史记录（约 N tokens）”
```

- Web 的百分比在前端计算。
- `N 条` 是 `shadowedSeqs.length`；`N tokens` 是被遮蔽节点 `heuristicTokens` 之和。
- 该 token 数不是压缩输入、摘要输出或净释放量。
- UI 不区分工具摘要、工具裁剪、遗忘摘要和 overflow 等来源。
- 压缩前后 surface token、触发阈值、三区边界、停止原因没有作为完整持久轨迹记录；事件 replay 可以重建部分事实，但无法直接复原调度决策。

来源：`05`、`18`。

---

## 7. 当前实现与 DSH 能力之间的关键接缝

| 接缝 | 当前插件做法 | DSH 边界 | 下一阶段必须决策 |
|---|---|---|---|
| 压缩触发 | pre-step + request-error | 合法且 retry 语义明确 | 压力目标与批次策略是否合理 |
| 历史替换 | Session replacement | 正规、可持久回放 | 边界/来源/重入不变量 |
| 工具摘要 provenance | Session replacement + storage audit | Session 与 storage 非原子 | 是否应只依赖日志内可恢复事实 |
| 长期状态权威 | storage-domain stable | 单进程缓存、跨进程 LWW | 多实例安全存储与冲突模型 |
| 长期状态注入 | systemPrompt context → runtime user message | 文本变更会永久追加到 transcript | 注入频率、预算、旧快照回收 |
| 后台更新 | 自建 per-session worker | DSH 无通用 coalescing；session/event 不可重入 | owner、取消、单飞、重启积压 |
| Fork/Resume | stable 按 SessionId + 部分 identity fence | fork 新 id，resume 同 id 新 lifecycle object | 子会话继承/独立/清空策略 |
| Goal/TODO | 事件投影 + 阈值 batch | 原生 goal/todo 是独立权威 | 大变更优先级与撤销语义 |
| 多实例 | 无协调 | Session 与 storage 均缺跨进程协调 | 明确支持范围或增加协调层 |
| 可观测性 | UI 只显示影子估算 | TokenMeter 有多种口径 | 建立可验证 token 账本和停止原因 |

---

## 8. 已知高风险事实，但暂不作为最终缺陷裁决

以下事实已经足以成为下一阶段重点约束，但是否为缺陷需经过“合理落地方案 → 当前实现”的正式对照：

1. 压力档允许一次 whole-zone 语义压缩，不使用普通 target/max batch；单次净释放可以只有 1 token。
2. `70%+` 路径会在遗忘区执行工具操作，压力 span 可跨工具区，与方案文档的严格区域隔离不同。
3. 步界判断依赖事件 payload 的 turn/step；部分 user/checkpoint message 缺少该元数据，存在保护盲区。
4. 工具摘要五值分类没有显式实现，但 provenance 仍实现了核心互斥的一部分。
5. overflow 第一阶段直接扫描全 surface 原始大工具结果，包括近区。
6. 长期 stable 采用跨进程不安全的整文档 JSON storage；同 home 多实例可能静默覆盖。
7. stable 与 audit 是两次非原子 put；repair 只补审计，不回滚 stable。
8. 大幅 Goal/TODO 更新不优先触发；空 TODO 清空事件被忽略。
9. runtime context 快照会累积在 transcript，而插件没有独立注入 token 归因。
10. 当前轨迹显示的“约 N tokens”不是净释放，无法解释压力抖动。
11. 测试对多个验收不变量仅验证事件或 mock 路径，没有完整验证最终 surface、串联失败和多实例。

---

## 9. 材料间口径差异与证据优先级

1. `04` 对 Goal/TODO projection 恢复的描述需要用 `08` 补充：projection cache 可加速 observe/list，但在线 Agent resume 仍可能首次全量 fold。
2. `05` 曾在限定范围内未找到截图中的详细压缩文案；`18` 扩大到 DSH `ui-chat` 后已定位其来自 DSH 核心。以 `18` 为准。
3. `15` 将长期状态称 stable，明确不应与 compaction checkpoint 混称。本文统一采用：
   - “主线程 checkpoint/replacement”指 Session compaction；
   - “task-state stable”指长期状态。
4. `21` 子代理关闭消息对文件行数有差异；以落库文件实际内容为准，不影响源码结论。
5. 插件审计文档中的“设计冲突”只表示与《压缩方案4》字面约束不同，最终合理性留待落地方案阶段判定。

---

## 10. “调查 DSH”阶段退出检查

| 必须回答的问题 | 当前状态 | 主要证据 |
|---|---|---|
| 模型上下文怎样形成与计量 | 已回答 | 00、01、20 |
| 插件何时可安全读取/修改 surface | 已回答 | 02、06 |
| replacement 如何持久和回放 | 已回答 | 02、03、09 |
| 长期状态可用哪些持久化原语 | 已回答 | 07、08 |
| 重启、多实例与 fork 的一致性边界 | 已回答 | 03、07、08、09 |
| 后台更新如何绑定生命周期 | 已回答 | 21 |
| Goal/TODO 如何传播 | 已回答 | 04、17 |
| 主 Agent 怎样读取和注入稳定状态 | 已回答 | 15、20 |
| overflow 与普通维护的合法 seam | 已回答 | 06、14 |
| 关键行为怎样记录和验证 | 已回答现状及缺口 | 05、18、19 |

### 判定

材料已经足以进入“推导 DSH 落地方案”阶段。仍有少量运行时量化问题——例如真实 token 分布、压力抖动、多实例覆盖规模、step 边界盲区可达性——但它们不阻塞架构推导，应作为后续验证实验，而不是继续扩大静态源码调查。

---

## 11. 下一阶段应产出的内容

下一阶段不是直接修代码，而应形成一份独立的 DSH 落地方案，至少包含：

1. 统一上下文预算模型和三区边界公式；
2. 普通维护、压力维护与 overflow 状态机；
3. 工具摘要/裁剪/遗忘批次的 provenance 与同轮隔离；
4. replacement 事务、重入与 fork/resume 语义；
5. task-state 权威模型、Goal/TODO 高优先级变更语义；
6. 单实例与多实例支持边界，以及选用的持久化后端；
7. 后台 worker 的 owner、single-flight、coalescing、timeout、dispose；
8. runtime context 注入预算和旧快照回收；
9. 持久可观测 token 账本、停止原因和净释放指标；
10. 与《压缩方案4》的保留、修订和参数校准项。

该方案完成后，才能对当前插件形成正式差异矩阵、缺陷清单与修复 PLAN。
