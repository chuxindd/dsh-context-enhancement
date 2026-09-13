# DSH Compaction 与 Surface Replacement 机制勘察

> 状态：基于 DSH 源码静态与实现事实核验。
> DSH 源码根目录：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 调查限定：`packages/compaction/**`、`packages/core/session/src/surface.ts`、Session append 直接接口及 agent hook 一层。不审计插件，不修改源码。

---

## 1. 核心问题回答与源码证据

### Q1: DSH 有哪些 compaction 实现或服务，各自入口、触发钩子与职责是什么？

- 【已证实】**四类核心服务与入口**：
  1. **服务 Seam 抽象与不变量**（`packages/compaction/compaction`）：
     - `CompactionEngine`（`src/index.ts:96-170`）：Cordis 服务 `ctx.compaction` 抽象基类，声明 `compactIfNeeded`、`compactNow`、`compactRegion` 三大操作。
     - `compaction-invariant`（`src/invariant.ts:16-19, 289-361`）：伴随插件，注入 Session 事件管道（`session/event`、`internal/dispatch`），强校验 compaction bracket 锁状态机、不跨 turn 边界、替换范围和 checkpoint 合法性。
     - `toolPairingBalancedBefore` / `toolPairingBalancedAfter`（`src/tool-pairing.ts:10-125`）：基于 `WeakMap` 维护会话 surface 的工具调用平衡状态，提供切分安全断言。
  2. **基础模型压缩引擎**（`packages/compaction/compaction-basic`）：
     - `BasicCompactionEngine`（`src/index.ts:104-430`）：主压缩实现，依赖 `llm`、`tokenMeter`、`sessions`。
     - 触发钩子：
       - `agent/pre-step`（`index.ts:148-166`）：触发自动压力压缩 `compactIfNeeded(agent, 'pressure', signal)`。
       - `agent/request-error`（`index.ts:180-224`）：在模型抛出 `CONTEXT_WINDOW_EXCEEDED_CODE` 时触发 `compactIfNeeded(agent, 'context-overflow', signal)` 并返回 `{ kind: 'retry' }`。
       - `agent/status`（`index.ts:168-170`）与 `session/event`（`index.ts:174-178`）：在 agent 空闲或收到新的 `assistant/message` 时重置 overflow 重试计数。
     - 职责：基于 `tokenMeter` 测量总 token，计算阈值，编排裁剪与摘要，通过事务替换旧历史。
  3. **模型无关工具结果裁剪服务**（`packages/compaction/compaction-tool-result-pruner`）：
     - `ToolResultPruner`（`src/index.ts:44-185`）：Cordis 服务 `ctx.toolResultPruner`。
     - 入口：`pruneSession(session: Session)`（`index.ts:136-184`）。由 `compaction-basic` 在压力或 overflow 时被动调用（`compaction-basic/src/index.ts:282, 309`）。
     - 职责：对超出字符预算的 `tool/result` 节点进行 Unicode 截断，保留 head/tail 并插入 marker，发布 `compaction/prune` 影子价格并原地替换 surface。
  4. **交互式命令入口**（`packages/compaction/command-compact`）：
     - `command-compact` 插件（`src/index.ts:10-105`）：向 `ctx.commands` 注册 `/compact`。
     - 职责：在 agent 空闲时通过 `agent.runMaintenance` 调用 `ctx.compaction.compactNow`，将底层错误转换为用户提示。

---

### Q2: 普通压力维护、手动 compact、overflow retry 的触发条件与执行顺序是什么？

- 【已证实】**普通压力维护（Pressure-driven Compaction）**：
  - **触发条件**：在 `agent/pre-step` 执行（`compaction-basic/src/index.ts:148-166`）；必须有 routed target；由 `ctx.llm.resolveModelInfo` 获取 `contextWindow`；`tokenMeter.measure(session).totalTokens >= floor(contextWindow * thresholdRatio)`（默认 ratio 0.8，`config.ts:20, 144, 305`）。
  - **执行顺序**（`index.ts:305-327`）：
    1. 若注册了 `toolResultPruner`，优先执行 `prune.pruneSession(agent.session)`。
    2. 重新计量，若 `totalTokens < thresholdTokens` 则直接结束，跳过模型摘要（`index.ts:313`）。
    3. 仍超标则进入循环（最多 `compactionRetries + 1` 轮，默认 2 次尝试）：选择范围 -> `compactRegion` -> 重新计量，达标即退出，超限抛出 Error。
- 【已证实】**手动 Compact（`/compact` / `compactNow`）**：
  - **触发条件**：用户输入 `/compact`（`command-compact/src/index.ts:62-67`）；必须在 agent 空闲状态下通过 `agent.runMaintenance` 进入（`compaction-basic/src/index.ts:376-420`）；无 open turn（`region.ts:174-177`）；无活动的 compaction lock（`region.ts:165-170`）。
  - **执行顺序**（`compaction-basic/src/index.ts:380-401`）：
    1. 忽略压力阈值，设置保留预算 `retainTokens = 0`，调用 `selectCompactableRange`。
    2. 执行 `compactSurfaceRegion`，事务所有者设为 `owner: null`（独立 standalone bracket），稳定性要求为 `selected-span`。
    3. 提交后执行 `ctx.sessions.flush(agent.session)` 强制刷盘；失败抛出 `ManualCompactionError('persistence')`。
- 【已证实】**Overflow Retry（Context Window Exceeded Recovery）**：
  - **触发条件**：`agent/request-error` 收到 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` 且未取消（`compaction-basic/src/index.ts:184`）；当前重试次数 `< policy.maxOverflowRetries`（默认 1 次，`config.ts:93`）。
  - **执行顺序**（`index.ts:185-224`）：
    1. 记录当前 surface 的 `generation = agent.session.surface.replaceGeneration`。
    2. 执行 `compactIfNeeded(..., 'context-overflow')`：先可选 prune，再强制 `retainTokens = 0` 选区压缩（`index.ts:284-291`）。
    3. 判定进展：只要 `surface.replaceGeneration > generation`（即 prune 或 summary 任何一步使表面产生耐久缩减），即使后续抛错也视为成功（`index.ts:198-209`）。
    4. 递增重试计数并返回 `{ kind: 'retry' }`，促使 `ReactLoopAgent`（`packages/core/agent-loop/src/agent.ts:392-407`）在 step 循环内重新生成请求。

---

### Q3: 候选历史如何选择：输入 surface、保留尾部/边界、安全分段、批次大小及完整工具配对怎样处理？

- 【已证实】**输入 Surface 与头锚定**：
  - 输入必须是当前会话的模型可见表面 `session.surface.nodes`，并断言与 `tokenMeter.measure(session).nodes` 严格一一对应（`compaction-basic/src/region.ts:105-112`）。
  - 压缩选区恒为**头锚定（head-anchored）**：起始索引恒为 `surfaceNodes[0]`，不允许中间抽空（`region.ts:132`）。
- 【已证实】**保留尾部（Retained Tail）计算**：
  - 尾部保留预算为 `retainTokens`（压力模式按 `retainRatio` 算，默认 0.16；overflow 与 manual 为 0，`config.ts:23, 145-147`）。
  - 从 surface 尾部向头部倒序累加节点消耗的 **`tokens`（路由模型计价值，而非固定启发式）**，直到累加和 `>= retainTokens`，锁定切分游标 `keepFromIdx`（`region.ts:116-121`）。
- 【已证实】**安全分段与完整工具配对（Tool-Pairing Balance）**：
  - 对候选切分点调用 `toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])`（`region.ts:126`；`tool-pairing.ts:111-113`）。
  - 若平衡（无跨边界的未响应 tool-call），则切分有效；
  - 若不平衡，**向前循环递减 `keepFromIdx -= 1`** 直到切分点平衡（`region.ts:124-128`）。
  - 若回退到 0（`keepFromIdx === 0`），说明整个历史都无法在不割裂工具调用的前提下切分，返回 `null` 放弃压缩（`region.ts:129`）。
  - 最终选定范围：`start = surfaceNodes[0]`，`end = surfaceNodes[keepFromIdx - 1]`（`region.ts:132-135`）。
- 【已证实】**批次大小**：
  - 无固定条数批次，单次为从 head 到安全切割点的全量连续切片。

---

### Q4: 摘要、工具裁剪或其他 replacement 如何生成；来源节点和替换范围怎样表示？

- 【已证实】**摘要生成与 KV Cache 复用**（`compaction-basic/src/summarizer.ts:25-66, 121-182`）：
  - `buildSummarizationInput` 提取 `requestHeader` 的 system/tools 以及切片内的所有派生消息（`region.ts:508-523`）。
  - 模型调用时，将固定模板 `COMPACTION_INSTRUCTION` 作为**最后一条 user 消息**拼接在历史消息之后（`summarizer.ts:146-152`），使摘要请求成为历史对话的前缀，**最大化复用 Provider 端 KV Cache**。
  - 要求生成 8 个 Markdown 段落（Primary Request, Technical Concepts, Files, Errors, Pending, Current, Next, Critical Context）。
  - 摘要结果通过 `frameSummary` 包装在 `<compacted-summary>` 标签内并附带前导说明（`summarizer.ts:189-195`）。
  - **缩减性前置校验**：估算生成结果的 token 必须严格小于原范围的 `shadowedRouteTokenCount`，否则报错终止（`region.ts:383-388`）。
- 【已证实】**工具结果裁剪生成**（`compaction-tool-result-pruner/src/index.ts:83-184`）：
  - 遍历 surface 上的 `tool/result` 节点，按 Unicode 码点计算文本长度。
  - 超过 `thresholdChars` 时，保留头 `headChars`、尾 `tailChars`，中间替换为 `PRUNE_MARKER`（`"... [pruned N characters] ..."`）。
- 【已证实】**替换范围与来源节点表示**：
  - 替换事件携带 `surfaceOp: { op: 'replace', start: SessionSeq, end: SessionSeq }`（`packages/core/session/src/surface.ts:214-217`）。`start` 与 `end` 表示 surface 位置跨度（因历史替换可能非单调，`packages/compaction/compaction/src/types.ts:107-114`）。
  - 必须声明 `sourceEventSeqs`（`surface.ts:249-253`）：Summary 包含 `[startEvent.seq, summaryEvent.seq, ...shadowedSeqs]`（`region.ts:474`）；Prune 包含 `[seq]`（`index.ts:172`）。
  - 影子价格配对：在 replace 提交的前一刻，同步紧邻追加 `compaction/summary` 或 `compaction/prune` 事件，记录 `shadowedRange`、`shadowedSeqs` 和 `shadowedTokenCount`（`region.ts:457-471`；`index.ts:162-166`）。
  - Checkpoint 来源标识：Replacement `user/message` 带有来源标头 `compactCheckpointSource(compactionId, sourceCommandId)`（`checkpoint.ts:33-42`）。

---

### Q5: 提交前有哪些 generation/version/concurrency 校验；失败是否保留原 surface？

- 【已证实】**事务级并发与有效性校验**：
  1. **Durable Lock 检查**（`region.ts:165-171, 288-300`）：倒序扫描日志，若存在未匹配 `compaction/end` 的 `compaction/start`（且未被 `session/end-seed` 废弃），抛出 `ManualCompactionError('busy')`。
  2. **Turn 边界归属**（`region.ts:173-183`；`invariant.ts:136-177`）：自动压缩必须在当前 open turn 内（`owner === openTurn`）；手动压缩必须无 open turn（`owner === null`）。
  3. **异步摘要后的稳定性断言**（`region.ts:213, 396-434`）：
     - `whole-surface`（自动压缩）：深比较当前 `meter.measure(session).nodes` 与准备阶段完全一致，任何外界写入都会触发 `SurfaceChangedError` 终止。
     - `selected-span`（手动压缩）：只要被替换范围在当前 surface 依然存在、连续、价格一致且两端平衡，允许范围外有新事件追加。
  4. **Surface Manager 底层验证**（`packages/core/session/src/surface.ts:331-357, 437-445`）：
     - `Session.append` 在落盘前执行 `surfaceManager.validateNext(event)`（`packages/core/session/src/index.ts:698`）。
     - 校验 `sourceEventSeqs` 必须完全覆盖被替换范围的所有 `shadowedSeqs`（`surface.ts:249-252`）。
     - 校验 `tool/result` 替换除了 content 外其余字段完全一致（`surface.ts:324-326`）。
- 【已证实】**失败时保留原 Surface**：
  - `Session` 为只追加日志。`SurfaceManager.nodes` 仅在合法 replacement 事件成功写入 log 后才通过 `splice` 变更（`surface.ts:378-381`）。
  - 若在 LLM 摘要、缩减检查或稳定性校验期间失败，控制流捕获异常并仅向日志追加带 `error` 的 `compaction/end` 释放锁（`region.ts:220-231`）。
  - `compaction/start` 与 `compaction/end` 均为 log-only 事件，不具有 `surfaceOp`，不改变 surface。因此**原 surface 完整保留，没有任何节点丢失或被破坏**。

---

### Q6: 一次维护的停止条件是什么；释放目标、批次 guard、重计量与 retry 分别怎样工作？

- 【已证实】**停止条件**：
  - **成功终止**：
    - 压力模式：单次或重试后 `meter.measure(session).totalTokens < spec.thresholdTokens`（`compaction-basic/src/index.ts:326`）。
    - 手动模式：完成选定范围替换并成功 flush 后终止（`index.ts:380-401`）。
    - Overflow 模式：检测到 `surface.replaceGeneration` 递增，返回 `{ kind: 'retry' }` 给 agent（`index.ts:202, 223`）。
  - **失败终止**：
    - 压力模式超过 `spec.compactionRetries` 仍超标，抛出错误记录日志，不阻断当前 turn（`index.ts:161-163, 329-332`）。
    - 无法选择平衡范围（`selectCompactableRange === null`），立即返回 null 退出（`index.ts:318`）。
    - Overflow 重试次数达到 `maxOverflowRetries` 仍失败，抛出原异常终止 turn（`index.ts:190`；`agent-loop/src/agent.ts:404-406`）。
    - `signal.aborted` 取消信号触发。
- 【已证实】**释放目标与预算**：
  - 触发门限：`thresholdTokens = floor(contextWindow * thresholdRatio)`。
  - 保留底线：`retainTokens = floor(contextWindow * retainRatio)` 或显式配置值。
- 【已证实】**重计量与 Retry 机制**：
  - 决策轨采用 `ctx.tokenMeter.measure(session)` 进行精确的 O(surface) 节点重算（`index.ts:268, 287, 311, 325`）。
  - 每次 prune 或 summary 提交后立即重新计量；若 prune 后已低于阈值则跳过模型摘要（`index.ts:313`）。
  - 压力压缩支持内部重试循环（`index.ts:316-327`）；Overflow 恢复通过 WeakMap 记录重试次数，利用 Cordis waterfall 返回 `{ kind: 'retry' }` 触发 AgentLoop 级别重试。

---

### Q7: 重启回放时 replacement 依赖哪些持久事件事实？

- 【已证实】**Surface 重建对持久事件的依赖**（`packages/core/session/src/surface.ts:331-389, 460-475`）：
  - 会话回放重构 surface 时，**仅依赖 replacement 节点本身的事件属性**：
    1. `event.surfaceOp`: 包含 `{ op: 'replace', start: SessionSeq, end: SessionSeq }`。
    2. `event.seq`: 作为替换节点插入当前内存切片位置。
    3. `event.sourceEventSeqs`: 证明该替换包含了被覆盖的全部旧节点。
    4. 回放当前状态：在回放至该事件时的 `state.nodes` 中通过 `indexOf(start)` 与 `indexOf(end)` 定位切片索引并执行 `splice`。
  - **回放解耦性**：
    - 模型可见表面重建**完全不依赖** `compaction/start`、`compaction/summary`、`compaction/end` 或 `compaction/prune` 等辅助事件。
    - 但**投影系统依赖影子价格**：增量投影（`contextPressure` / `contextBreakdown`）回放时，必须读取紧邻前置的 `compaction/summary` 或 `compaction/prune` 中的 `shadowedTokenCount` 才能正确扣除旧 token；若缺失该前置事件，投影 delta 将降级记为 0（参见 `01-Token与Pressure计量.md`）。

---

## 2. 供后续代理直接引用的结论摘要

1. **执行链与分层编排**：
   - 外部调用 `/compact` 或 AgentLoop 钩子（`agent/pre-step`、`agent/request-error`）触发 `BasicCompactionEngine`。
   - `compaction-basic` 优先调用 `toolResultPruner` 执行无模型裁剪；若未达标再调用 LLM 生成结构化摘要。
2. **KV Cache 亲和设计**：
   - 摘要调用重用了会话原本的 system、tools 和 messages，仅在末尾追加指令，最大化命中模型提供商的 Prefix KV 缓存。
3. **严格的切分平衡保证**：
   - 永远以 surface 头部第 0 个节点为起始，尾部根据 `retainTokens` 截断，并通过 `toolPairingBalancedBefore` 动态回退，保证绝不会破坏 Tool Call 与 Tool Result 的成对关系。
4. **事务锁与安全回滚**：
   - 通过日志中的 `compaction/start` / `compaction/end` 实现跨请求并发锁。
   - 提交前有严格的全表面或局部选区深比较稳定性校验。
   - 任何失败发生时，因未提交 replacement 事件，仅记录带 error 的 end 事件，原始 surface 保持绝对完整。

---

## 3. 交给其他独立任务的问题

1. **插件对 System/Tools 的动态修改对 Compaction 摘要缓存的影响**：若第三方插件在 pre-step 动态修改 system prompt 或注入内容，是否会导致 compaction 摘要请求的 KV cache 命中率下降。
2. **长历史中多轮 Compaction 的 Summary 嵌套折叠质量**：当会话极其漫长、已经包含多次 `<compacted-summary>` 时，模型的单次合并摘要能力与信息损耗评估。
3. **Tool Result Pruning 对代码执行类工具输出的破坏性**：按字符截断 head/tail 是否会破坏特定编译器或结构化输出（如大 JSON、Stacktrace），导致后续模型理解偏差。
