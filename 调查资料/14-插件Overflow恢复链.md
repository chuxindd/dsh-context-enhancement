# 插件 Overflow 分级恢复链审计

> 日期：2026-09-11
> 被审计对象（只读）：`C:\Users\chuxi\Documents\trae_projects\code\dsh-context-enhancement`
> 插件版本：`package.json` —— 0.1.x 系列（`CHANGELOG.md` 最新条目 0.1.6 / 2026-09-06）
> DSH 事实来源：`调查资料/02-Compaction与Replacement.md`（不重复调查 DSH 已落库事实）；DSH 侧仅补充 overflow 触发码与 waterfall 语义。
> 范围：只审计插件 `overflow` 分级恢复。不重复普通压力区间算法（另见 `01`/`02`），不涉及 Checkpoint 细节、不涉及 Web。
> 本次检查文件数：**15**（10 个实现文件 + 2 个测试 + 3 个文档/配置佐证）。未修改任何源码或待提交文件。
> 标记约定：**【已证实】**= 直接读到源码/行号；**【待深挖】**= 有直接证据但结论未闭合；**【未找到】**= 范围内不存在。

---

## 0. 一句话结论

插件的 overflow 恢复是**独立于普通压力路径的第二条进程内阶梯**：`agent/request-error` 收到 provider 归一化的 `CONTEXT_WINDOW_EXCEEDED` 后，先做一次**全表面原文工具结果确定性剪枝**，然后按 **forget → tool → recent** 三级"最旧优先"分批复用普通压缩事务，每一级批次用 `maxPressureBatches` 计费，每次替换后重新计量、重新分区；只有表面 `replaceGeneration` 前进才授权 `{ kind: 'retry' }`；跨区必须"上一级已无候选"；溢出状态几乎不写入普通维护的任何记忆结构（唯一例外见 §7）。

---

## 1. Provider overflow 如何识别

### 1.1 识别入口（插件侧）

- 【已证实】**处理器注册**：`src/compaction-basic.ts:306-350`，`ctx.on('agent/request-error', ...)`，仅在 `config.auto === true` 时挂载（`src/compaction-basic.ts:256` → `_registerAutomaticCompaction()` `:264`；`auto` 默认 `true`，`src/internal/compaction/config.ts:69`）。
- 【已证实】**判定条件**（`:310`）：
  `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()`。
  - `CONTEXT_WINDOW_EXCEEDED_CODE` 来自 `@deepseek-ai/dsh-llm`（`src/compaction-basic.ts:30`）。
  - 因此插件**不做任何文本嗅探**，完全依赖 provider 适配器归一化后的 `failure.code`。
- 【已证实】**识别所依赖的 DSH 侧事实**（本次只做一层确认，不重开调查）：
  - 常量定义：`packages/llm/llm/src/error.ts:25` `CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'`。
  - 文案分类器：`packages/llm/llm/src/error.ts:80-86` `isContextWindowExceededError(detail)`（多套正则：structured overflow / max context length / too large for context / exceeds model context）。
  - 适配器落码：`packages/llm/llm-deepseek/src/adapter.ts:339`、`packages/llm/llm-pi-ai/src/stream.ts:90`。
- 【已证实】**副作用先于判定**（`:311`）：`this.overflowAgents.set(agent.session, agent)` 在"是否超重试预算"之前执行，因此**任何** `CONTEXT_WINDOW_EXCEEDED` 都会把 `session → agent` 写入 WeakMap，即使本次不重试。

### 1.2 目标与预算解析（在识别之后、恢复之前）

- 【已证实】**路由目标缺失即放弃**（`:312-313`）：`routedTarget(agent.session)`（`:135-143`，读 `session.requestHeader()?.config.provider/model`）返回 `undefined` → `return next()`（保留原错误）。
- 【已证实】**按目标解析策略**（`:314`）：`resolveTargetPolicy(this.config, target)` → 得到 `maxOverflowRetries` 与 `maxPressureBatches`（`src/internal/compaction/config.ts:82-90`）。

---

## 2. 处理顺序（原始大工具结果 → 遗忘区 → 工具区 → 近区）

整条链的调用图（全部为插件源码）：

```
ctx.on('agent/request-error')                       src/compaction-basic.ts:306
  └─ compactIfNeeded(agent,'context-overflow',sig)  src/compaction-basic.ts:321 (→ override :425)
       └─ recoverOverflow(agent, prune, signal)     src/compaction-basic.ts:438-439 → :1013
            ├─ 阶段 A 确定性剪枝（全表面原文结果）    :1019-1022
            └─ 阶段 B 三级阶梯循环                    :1034-1076
                 └─ compactRegion(...)              :1061 → override :1248 → compactSurfaceRegion()
```

- 【已证实】**顺序 0：进入 overflow 分支前不做任何普通阈值判断**（`:430-440`）。`compactIfNeeded` 在 `:434` 先 `meter.measure(...)`，但 `:438-440` 立刻 `return this.recoverOverflow(...)`，这个 measurement **在 overflow 路径上不被使用**（仅 pressure 路径使用）。即 overflow 有意绕过 `toolMaintenanceRatio` / `forgetMaintenanceRatio` / `pressureRatio` 三道普通水线。
- 【已证实】**顺序 1：确定性剪枝（原始大工具结果，最先）**（`:1019-1022`）：
  - 候选 = `session.surface.nodes.filter(seq => sources.isOriginalToolResult(seq))`——**整个当前表面**，无 `olderRange`。
  - 因此 `ToolResultPruner.pruneSession` 走"无 options.olderRange"分支：`src/tool-result-pruner.ts:298-302` 把 olderSpan 展开为 `{startIndex:0, endIndex:nodes.length-1}`，`:320-323` 令**全部**命中候选 `ordinaryEligible = true`。
  - 结果：overflow 是唯一允许把**近区（含受保护尾部以外的新近内容）**里的超大原文工具结果按普通 `thresholdChars` 预算剪枝的路径；普通压力路径则显式把剪枝限制在工具区（`src/compaction-basic.ts:471-488`，注释 `:473-475`）。
  - 剪枝**不会**重复处理替代物：`isOriginalToolResult`（`src/internal/compaction/source-index.ts:81-84`）要求 `event.type === 'tool/result'` 且 kind 为 `original`，工具摘要/已剪枝结果/历史摘要 checkpoint 都被排除。
  - `hardLimitChars` 在此路径被"淹没"：所有原文结果已经是 ordinaryEligible，`pruneRecentContent` 分支（`src/tool-result-pruner.ts:336`）不会被走到。
  - 【已证实】**异常零容忍**：该调用**不在任何 try/catch 内**，且不使用 `onReplacement`。若剪枝在中途抛错（例如候选 seq 同时被移除 → `src/tool-result-pruner.ts:309`），异常直接冒泡到 `:322` 的 catch。
- 【已证实】**顺序 2：三级阶梯**（`:1034`）：
  `for (const level of ['overflow-forget', 'overflow-tool-zone', 'overflow-recent'] as const)` —— 由旧到新，跨区只允许单向前进。
  - 每级的范围来自**当场重新分区**：`:1038` `const zones = this.zones(session, current, spec)`，`:1039-1043` 取 `zones.forget` / `zones.tool` / `zones.recent`。
  - 因此"近区处理"确有其事：`zones.recent` 只可能为 `null`（范围非法才为 null；`src/internal/compaction/zones.ts:106` 对非空表面恒返回范围），**近区不再是禁区**。
- 【已证实】**近区内部的真实保护线**：近区起点由 `recentBoundaryTokens = envelopeZoneBudget.retainedTailTokens = max(Rmin, min(G, R0))` 决定（`src/compaction-basic.ts:894-901`、`src/internal/compaction/envelope-budget.ts:100,260`），`Rmin` 由 `retainedTailFloorTokens` 给出（`envelope-budget.ts:131-193`：open turn + 最后一次 completed turn + 至少 2 个 turn 的地板）。所以**最新的地板尾部永远不在任何区内**；被 overflow 触碰的只是"近区中较旧的那一段"（`selectForgetBatch` 恒从该范围最旧端开始，`zones.ts:141-154`）。

---

## 3. 恢复等级与批次预算

- 【已证实】**等级数 = 3**（`overflow-forget` / `overflow-tool-zone` / `overflow-recent`，`:1034`），顺序固定为遗忘区 → 工具区 → 近区。
- 【已证实】**每级批次上限 = `policy.maxPressureBatches`**（`:1035` `for (let batch = 0; batch < policy.maxPressureBatches; batch += 1)`）。
  - 默认 `2`；**语义**为"每个保护区、每次恢复尝试的批数"（`src/internal/compaction/types.ts:52-53` 注释；`config.ts:24,161-163`）。
  - `maxPressureBatches: 0` ⇒ 三级循环体一次都不执行 ⇒ 只剩阶段 A 剪枝（`:1077` 返回 `latest = null`）。
  - 理论单次 `recoverOverflow` 最多 `3 × maxPressureBatches` 次 `compactRegion`（默认 6）；但受 `:1037` 提前返回与各级 `break` 约束。
- 【已证实】**每批的选取器**：`:1050-1053` `selectForgetBatch(session, current, { ...zones, forget: range }, {...})`——把"当前等级范围"伪装成 `forget` 传入同一套 `planForgetBatch` 逻辑（`src/internal/compaction/zones.ts:126-167`）。
  - 批次预算 = `min(spec.targetBatchTokens, Bcap)` / `min(spec.maxBatchTokens, Bcap)`，`Bcap = envelopeBudget.summarizerInputCapTokens`（`:1049`、`src/internal/compaction/envelope-budget.ts:101-104,112`）。
  - 因此 overflow **不是**"无界全量压缩"：它仍受 `targetBatchTokens(16000)` / `maxBatchTokens(24000)` 与窗口内辅助调用输入上限的双重约束；与普通压力路径"一整个遗忘区一次语义压缩、故意不分批"（`src/compaction-basic.ts:574-583`）形成明确分工。
  - 批次边界安全由 `planForgetBatch` 内部保证：`toolPairingBalancedBefore` / `toolPairingBalancedAfter` / `stepBoundaryAfter`（`zones.ts:134,142-143,318-324`）。

---

## 4. 跨区前置条件（进入更年轻保护区的门槛）

按代码执行顺序，共 6 道：

| # | 前置条件 | 位置 | 行为 |
|---|---|---|---|
| 1 | `current.totalTokens >= spec.thresholdTokens` | `:1036-1037` | 已低于压力线 → **立即成功返回** `latest`（不再进入更年轻区） |
| 2 | 当前等级范围非 `null` | `:1039-1044` | 为 `null` → `break` 本级，进入下一级 |
| 3 | 批次可选出安全范围 | `:1050-1054` | `selectForgetBatch === null` → `break` 本级（`no-forget-range` / `unsafe-forget-start` / `oldest-unit-too-large` / `no-safe-batch-end`） |
| 4 | `canCompactHistory(seq, minReentryTurns)`（**不带** relax 标志） | `:1057-1059` | 任一节点不可重入 → `break` 本级 |
| 5 | 同级批次未用尽 | `:1035` | 用尽后按 #6 决定是否跨区 |
| 6 | **用尽最后一档时：本级是否仍有候选** | `:1062-1074` | 重新计量 + 重新分区；若本级的 `remaining` 仍能被 `selectForgetBatch` 选中 → **`return latest`，拒绝跨区** |

- 【已证实】#4 的关键差异：overflow 调用 `sourceIndex.canCompactHistory(seq, policy.minReentryTurns)`（`:1059`）**不传第三参 `allowImmediateReentry`**，默认 `false`（`src/internal/compaction/source-index.ts:85-94`）。所以：
  - `unknown-replacement`（第三方替换）恒为 `false`；
  - 已知替换（`tool-summary` / `tool-pruned` / `history-summary`）必须满足 `completedTurnsAfter >= minReentryTurns`（默认 1，`config.ts:25,164`）才可再入；
  - 而普通压力整区通道会显式传 `true` 放宽（`src/compaction-basic.ts:659`，注释 `:635-644`）。
  - 含义：**overflow 比普通压力更"尊重重入保护"**，代价是可能在本级 `break` 后进入更年轻的区（#4 的 `break` 与 #6 的 `return` 语义不同）。
- 【已证实】#6 的守卫语义（`:1062-1074`）：仅在"批次计数刚好等于 `maxPressureBatches`"的那一次替换之后评估；`remaining` 用**替换后**的新分区与新 `Bcap` 重算，若仍可选出一批则判定"本级还有活"，**不进入更年轻区**，把机会留给下一次 overflow retry（注释 `:1063-1064`）。
- 【已证实】等级顺序本身没有"回退"：一旦进入 `overflow-tool-zone`，本轮不会再回到 `overflow-forget`（外层 `for` 单向）。
- 【已证实】#4 触发的是 `break` 而非 `continue`：注释 `:1057-1058` 说明"该选区含不可立即重入的先前摘要，重试不应立刻再摘要它"；但由于是 `break`，本级剩余候选被跳过、直接评估更年轻区。#6 的"不跨区"守卫**不覆盖** #4 的 `break` 路径。

---

## 5. retry / guard / 死循环保护

### 5.1 重试计数与授权重试

- 【已证实】**预算读取与拦截**（`:315-316`）：`const retries = this.overflowRetries.get(agent) ?? 0; if (retries >= policy.maxOverflowRetries) return next()`。
  - 默认 `maxOverflowRetries = 1`（`config.ts:169`），`0` 表示第 0 次就拦截（即禁用恢复）；`z.number().step(1).min(0)` 校验（`src/compaction-basic.ts:163,184`；`config.ts:240-244`）。
  - 计数载体：`private readonly overflowRetries = new WeakMap<Agent, number>()`（`:235`）。
- 【已证实】**计数重置**（两条，缺一不可）：
  - `agent/status` → `status === 'idle'`（`:294-296`）；
  - `session/event` 且 `event.type === 'assistant/message'`（`:300-304`），配合 `overflowAgents` 反查 Agent（`:236`）。
  注释（`:298-299`）说明：即使同一 turn 内因工具调用继续发下一个请求，成功响应也算"新序列"。
- 【已证实】**授权重试的条件（成功路径）**（`:344-349`）：
  ```
  if (signal.aborted || surface.replaceGeneration <= generation) return next()
  if (result !== null) logResult(...)
  this.overflowRetries.set(agent, retries + 1)
  return { kind: 'retry' }
  ```
  - `generation` 在恢复前抓取（`:318`），因此**"表面产生了耐久替换"是重试的唯一凭据**，而不是"压缩函数返回非 null"。
  - `{ kind: 'retry' }` 且不调用 `next()`：按 DSH agent-loop 的 waterfall 约定，拥有恢复权的监听器就此接管（`packages/core/agent-loop/src/agent.ts:392-407`：`action?.kind !== 'retry'` 才 `throw LlmError`）。
- 【已证实】**单序列最多几次真正恢复**：计数字段在首次进入时 `retries = 0`，`0 >= 1` 为假 → 允许一次恢复；恢复后置 `1`。下一次 `CONTEXT_WINDOW_EXCEEDED` 命中 `1 >= 1` → `return next()`。故默认配置下**每个 overflow 序列只有一次恢复尝试**，该次尝试内部才有多达 `3 × maxPressureBatches` 个批次（§3）。

### 5.2 死循环保护清单（7 层）

1. 【已证实】重试总闸：`maxOverflowRetries`（§5.1）。
2. 【已证实】进展闸：`replaceGeneration` 必须前进才 retry（`:346`；异常路径 `:328`）。
3. 【已证实】取消闸：`signal.aborted` 在入口（`:310`）、异常路径（`:328`）、成功路径（`:345`）三处优先于重试。
4. 【已证实】压力闸：批次循环每次先测 `totalTokens < thresholdTokens` 即返回（`:1036-1037`），所以阶梯不会在达标后继续烧调用。
5. 【已证实】批次闸：每级 `maxPressureBatches`（`:1035`）。
6. 【已证实】跨区闸：本级仍有候选时拒绝跨区（`:1062-1074`）。
7. 【已证实】重入闸：`canCompactHistory` 阻止"刚生成的摘要立刻被再摘要"（`:1059`）。
- 【已证实】辅助闸（在事务内，非 overflow 专属）：稳定性断言 `whole-surface`（`src/compaction-basic.ts:1260` → `src/internal/compaction/region.ts:260-262,281`）、严格缩减断言（`region.ts` prepare/commit 链，见 `02-Compaction与Replacement.md` Q5）、耐久锁 `assertCompactionInactive`（`region.ts:356-368`，由 `compactSurfaceRegion:234-238` 与 `zones` 之外的普通路径 `assertNoActiveCompaction` 提供）。
- 【待深挖】overflow 路径**自身不调用** `assertNoActiveCompaction`（普通路径在 `src/compaction-basic.ts:443` 调）——对 overflow 的保护完全依赖 `compactSurfaceRegion` 内部的 `assertCompactionInactive`。二者是否等价（尤其在 `session/end-seed` 场景）未在本次范围内闭合。

### 5.3 与 DSH `llm-retry` 的关系（避免"谁先重试"歧义）

- 【已证实】`CONTEXT_WINDOW_EXCEEDED` **不在** DSH 默认可重试码集合内（`packages/llm/llm/src/retry-policy.ts:18-24`：`EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`），且 `llm-retry` 的 normal 模式对该码走 `return next()`（`packages/llm/llm-retry/src/index.ts:215-217`）。
- 因此不存在"llm-retry 先于插件盲目重试同一个超窗请求"的默认风险；`llm-retry` 的 `always` 模式也遵循"先问下游"（`index.ts:199-214`）。
- 【未找到】插件内**没有**对 waterfall 监听顺序的显式声明（无 `prepend`/优先级参数），顺序由 Cordis 注册序决定；本次未在 DSH 侧核对最终顺序，但结论**不依赖**顺序（两条路径都遵循 `next()` 向下传递语义）。

---

## 6. 失败保持（failure preservation）

- 【已证实】**恢复抛错但已有耐久进展**（`:322-335`）：
  `if (!signal.aborted && agent.session.surface.replaceGeneration > generation)` → `logger.warn(...)` + `overflowRetries.set(agent, retries + 1)` + `return { kind: 'retry' }`。
  - 意图（注释 `:324-327`）：模型无关的剪枝可能在后续摘要失败前已落地，这份耐久缩减本身就是可重试凭据，不能被整体丢弃。
  - 注意此处**跳过了 `compactIfNeeded` 的返回值判定**，只看 `replaceGeneration`。
- 【已证实】**恢复抛错且无进展 / 已取消**（`:336-342`）：`logger.warn(...)` + `return next()`——即"保留原始请求错误"，交给 waterfall 下游或终态（`agent.ts:404-406` 抛 `LlmError`）。
- 【已证实】**正常返回但无进展**（`:345-346`）：`return next()`，同样保留原错误；且**不增加计数**（因为 `:348` 在其后）。
  - 这带来一个可复现的边界：若 `recoverOverflow` 返回 `null` 而 `replaceGeneration` 已前进（`recoverOverflow` 本身从不追加任何事件，但阶段 A 剪枝会；`compactRegion` 成功也会），`:346` 判定"有进展"→ `logResult` 被 `result !== null` 抑制 → `:348` 置 1 → `{ kind: 'retry' }`。**【待深挖】**此时"进展来自剪枝、语义阶梯未选出任何批次"与"语义压缩成功"在使用同一重试凭据，无独立日志区分（仅 `:1060` 的 level 日志能间接体现）。
- 【已证实】**失败不改变表面**：overflow 只用两类官方事件落账——`compaction/prune`（`src/tool-result-pruner.ts:350-361`）与 compaction 事务（`src/internal/compaction/region.ts:222-324`：`compaction/start` → 摘要 → 稳定性断言 → 提交 → `compaction/end`；失败仅追加带 `error` 的 `compaction/end`，`region.ts:288-299`）。这与 `02-Compaction与Replacement.md` Q5 的"原 surface 完整保留"一致。
- 【已证实】**没有持久化的 overflow 标记**：overflow 全过程只用官方事件类型，插件不声明自定义 `SessionEventMap`（模块头注释 `:1010-1011`）。可诊断性只有 `ctx.logger.warn`（`:1060`、`:329`、`:336`）。**【待深挖】**重启后无法从日志区分"overflow 恢复发生过"，只能从 `compaction/prune` + checkpoint 事件的间隔推断。
- 【已证实】**取消优先**：三处 `signal.aborted` 检查（`:310/:328/:345`）都先于任何重试决定；`:338-341` 的日志文案区分 `cancellation prevents retry`。

---

## 7. overflow 是否污染普通维护边界

**结论：基本不污染，但有 3 处需要显式记账的耦合。** 逐项核验：

- 【已证实】**不污染压力终止 memo**：`pressureStops`（`:238`）只在普通压力路径写入 `stopEnvelopeBudgetPass`（`:986-1005`）与读取 `pressurePassTerminated`（`:963-976`）；overflow 路径全程未触碰这两个方法（`:1013-1078` 内无调用）。反向看，overflow 落地替换会改变 `session.surface.replaceGeneration` / `nodes.length` / `totalTokens`，恰好使旧 memo 失效被 `delete`（`:966-970`）——即 overflow **解除**普通路径的抑制，而不是压制。
- 【已证实】**不污染分区参数**：`zones()`（`:886-902`）与两个 envelope 预算都是**每次现算**的纯函数（`envelope-budget.ts:89-114,253-269` 无内部状态、不读写 session）；overflow 没有缓存任何边界值，普通路径每次都从新 measurement 重算。`spec` 只依赖 `resolveTargetPolicy` + `contextWindow`（`config.ts:92-124`），与 overflow 无关。
- 【已证实】**不污染重入分类**：`sourceIndex()`（`:726-734`）每次重建，`buildSurfaceSourceIndex` 从"当前表面 + 持久审计记录"重建（`source-index.ts:57-96`）。overflow 产生的 checkpoint 会被分类为 `history-summary`（`source-index.ts:99,112-116`），剪枝产物会被分类为 `tool-pruned`（`:108,119-126`）——这些都是**普通路径本来就会产生的同一类**替代物，语义没有新增通道。
- 【已证实】**耦合 A：受保护边界的放松是"有意的、单向的"**：overflow 用 `zones.recent` 作为可压缩范围（`:1043`），并用无 `olderRange` 的剪枝覆盖全表面原文结果（`:1021`）。这是 `docs/compaction-algorithm-reconciliation.md:176` 明确允许的例外（"never touch the live working set ... outside an explicit overflow ladder"，决策表第 7 行 `:286`）。但仍有一条底线未被突破：`retainedTailTokens` 的 `Rmin` 地板（open turn + 最后 completed turn + ≥2 turn，`envelope-budget.ts:131-193`）决定近区起点，最新地板尾部停留在所有区之外——**"不触碰工作集"由分区保证，而不是由等级名保证**。
- 【已证实】**耦合 B：`maxPressureBatches` 的双重身份**：该字段既是"普通维护历史的 `compactionRetries + 1` 兼容位"（`config.ts:161-163`）又是"overflow 每级批数"（`:1035`）；`compactionRetries` 与 `maxPressureBatches` 同时配置会**直接报错**（`config.ts:131-133`）。普通 70% 维护由 `maxMaintenanceBatches` 独立控制（`:536`），不受 overflow 影响（`CHANGELOG.md:38,44` 与 `types.ts:52-53` 注释互证）。
- 【已证实】**耦合 C：同一事务所有权**：overflow 使用与普通压力相同的 `compactRegion` override（`:1248-1263`），owner=`current-turn`、stability=`whole-surface`。因此 overflow 落地会推进 `replaceGeneration`，进而让**随后**的 `agent/pre-step` 压力判定在全新表面上重算（这正是设计意图：`:702-715` 的重测逻辑）。没有跨路径的锁或状态位被同时持有。
- 【已证实】**不污染工具组审计**：`summarizeToolGroups`（`:1080-1190`）在 overflow 路径上**完全不被调用**（`recoverOverflow` 内无此调用）。所以 overflow 不会写 `toolGroupAuditStore`，也就不会因审计终态（failure/fallback）永久抑制某组的后续尝试——这与普通路径在 `:458-468`/`:498-506` 的行为不同。
- 【未找到】插件中任何"overflow 专用"的持久状态、缓存或 session 投影。

---

## 8. 测试覆盖现状（只读核对）

- 【已证实】**唯一直接覆盖 overflow 的测试**：`tests/compaction-three-zone.spec.ts:445-451` `'stops overflow at the forget guard instead of entering younger zones'`。
  - 调用方式：`BasicCompactionEngine.prototype.recoverOverflow.call(engine, agent, undefined, signal)`（`:448`），即**传 `prune = undefined`**（未覆盖阶段 A 剪枝）。
  - 断言仅为：`compacted.length <= 2` 且所有被压缩位置的 `surface.nodes.indexOf(start) < 6`（`:449-450`）。
  - 该断言与实现一致：12 节点 / 120 tokens、`contextWindow=100`、`forgetBoundaryTokens=50` ⇒ forget 区 = 位置 0..4；`maxPressureBatches=2`、`thresholdTokens=80` ⇒ 第 2 批后 `totalTokens` 落到阈值下方（`:1037`）即返回。
- 【未找到】覆盖以下行为的测试：
  - 阶段 A（overflow 全表面剪枝，含"近区超大原文结果被剪"与 `hardLimitChars` 被淹没）；
  - `overflow-tool-zone` 与 `overflow-recent` 两级真正被进入（即 #6 跨区守卫的**反例**：本级候选耗尽后成功跨区）；
  - `:1062-1074` "本级仍有候选则拒绝跨区"的 return（`CHANGELOG.md:44` 声称修复过该缺陷，但无对应断言）；
  - 异常路径 `:322-335`（有耐久进展 → `{kind:'retry'}`）与 `:336-342`（保留原错误）；
  - `maxOverflowRetries` / `maxPressureBatches` 的 0 值禁用语义。
- 【已证实】`tests/compaction-lifecycle-scheduling.spec.ts:62-63,89` 只验证弱引用字段与钩子注册形态，不验证恢复行为。

---

## 9. 范围与证据边界

- 本次只追两层直接依赖：`compaction-basic.ts` → {`zones.ts`, `config.ts`, `envelope-budget.ts`, `source-index.ts`, `region.ts`, `tool-result-pruner.ts`, `types.ts`}。更深层（`summarizer.ts`、`tool-group-*`、`selection-guard.ts`）只在解释 overflow 的守卫/排除时引用其被调用点，未展开审计。
- DSH 侧只补充了 overflow 触发码与 waterfall 语义（`error.ts`、`retry-policy.ts`、`llm-retry/index.ts`、`agent-loop/agent.ts`），未重开 compaction 事实调查。
- 未运行任何测试、未构建、未启动服务器、未修改任何文件（除本报告）。

---

## 供后续代理直接引用的结论摘要

1. **识别**：overflow 唯一入口是 `ctx.on('agent/request-error')` 内 `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE` 判定（`src/compaction-basic.ts:306-310`）；插件不看文案，只信适配器归一化码（DSH `packages/llm/llm/src/error.ts:25,80-86`）。`auto:false` 时该监听器完全不挂载（`:256`）。
2. **入口副作用**：`:311` 在任何预算检查之前写 `overflowAgents`（WeakMap<Session, Agent>）；`:312-316` 依次解析 routed target、target policy、`overflowRetries`。
3. **顺序**：`compactIfNeeded('context-overflow')` → 直接 `return recoverOverflow(...)`（`:438-440`），**完全绕过 40/70/80 三道水线**，`:434` 的 measurement 在该分支被丢弃。
4. **阶段 A（最先）**：无 `olderRange` 的全表面确定性剪枝（`:1019-1022`），候选由 `isOriginalToolResult` 过滤（`source-index.ts:81-84`）；这使**全部**原文工具结果 `ordinaryEligible=true`（`tool-result-pruner.ts:298-302,320-323`），是唯一能剪"近区大结果"的路径；该调用无 try/catch、无 `onReplacement`。
5. **阶段 B（三级阶梯，由旧到新）**：`overflow-forget` → `overflow-tool-zone` → `overflow-recent`（`:1034`），每级批数上限 `policy.maxPressureBatches`（默认 2，`:1035`），每批都 `selectForgetBatch` 且预算 = `min(targetBatchTokens|maxBatchTokens, envelopeBudget.summarizerInputCapTokens)`（`:1049-1053`）；每批之后重新计量、重新分区；`maxPressureBatches=0` ⇒ 仅剩阶段 A。
6. **跨区前置条件（6 道）**：① `totalTokens >= thresholdTokens`（`:1037`，达标即成功返回）；② 等级范围非 null（`:1044`）；③ 能选出安全批次（`:1054`）；④ `canCompactHistory(seq, minReentryTurns)` 不带 relax（`:1059`，比普通压力严格）；⑤ 批次未用尽（`:1035`）；⑥ 用尽的最后一批后，若本级仍能选出候选则**拒绝跨区**并返回（`:1062-1074`）。注意 #4 是 `break`（会进入更年轻区），#6 是 `return`（不跨区）。
7. **重试授权**：`replaceGeneration > generation`（恢复前抓取，`:318`）才 `{ kind: 'retry' }`（`:344-349`）；异常但已前进同样 retry（`:328-334`）；无进展/取消一律 `next()` 保留原始错误（`:342`、`:346`）。
8. **死循环保护 7 层**：`maxOverflowRetries`（默认 1，`:316`）、`replaceGeneration` 进展闸、`signal.aborted`×3、`thresholdTokens` 达标返回、每级 `maxPressureBatches`、跨区"仍有候选"闸、`canCompactHistory` 重入闸；另有事务内的 whole-surface 稳定性断言与严格缩减断言。
9. **失败保持**：overflow 只落官方 `compaction/prune` 与 compaction 事务事件，失败仅追加带 `error` 的 `compaction/end`（`region.ts:288-299`），原 surface 完整；无自定义持久事件、无 overflow 专用标记，诊断仅 `logger.warn`（`:1060` 等）。
10. **边界污染**：`pressureStops` memo 只由普通路径读写；分区/预算/`sourceIndex` 全部每次重建；overflow 不调用 `summarizeToolGroups`。三处耦合需记账：① 近区与全表面剪枝是**有意**放松（`docs/compaction-algorithm-reconciliation.md:176,286`），底线是 `retainedTailTokens` 的 `Rmin` 地板（open turn + 最后 completed turn + ≥2 turn，`envelope-budget.ts:131-193`）把最新尾部留在所有区之外；② `maxPressureBatches` 同时是 legacy `compactionRetries+1` 的落点与 overflow 每级批数（`config.ts:131-133,161-163`），二者同配即报错；③ overflow 复用同一 `compactRegion`（owner=`current-turn`、stability=`whole-surface`），落地后必然推进 `replaceGeneration`，从而让后续普通压力在全新表面重算（设计意图）。
11. **测试现状**：只有 1 条直接测试（`tests/compaction-three-zone.spec.ts:445-451`），传 `prune=undefined`，只断言"不进更年轻区"；tool-zone/recent 两级、跨区成功、异常路径、0 值禁用语义均无覆盖。

---

## 交给其他任务的问题

1. **阶段 A 的"全表面剪枝"是否应当分级？** 它现在是 overflow 的第一刀，且覆盖近区原文结果、忽略 `hardLimitChars`、无 try/catch、无 `onReplacement`。若把它改为"先 prune 遗忘区+工具区、逼真的近区只在最后一档处理"，是否仍能保证 `replaceGeneration` 前进（即重试凭据）不丢？需要与 `tool-result-pruner` 的 owner 一起定。
2. **#4（`canCompactHistory` 不带 relax）与 #6（拒绝跨区）语义不一致的后果**：`break` 会进入更年轻区并可能摘要"刚被工具组摘要过、但尚无 completed turn"的节点吗？请给出反例构造或证明其不可达（需要 `toolGroupAuditStore` 的直接依赖，超出本次两层范围）。
3. **overflow 的可诊断性**：是否需要落一个持久标记（例如复用 `compaction/start` 的 `stage` 或审计记录）以便重启后区分"发生过 overflow 恢复"？这与"不声明自定义 SessionEventMap、卸载后旧日志仍可读"的兼容约束如何共存？
4. **`maxPressureBatches` 的双重身份**是否为应当拆分的配置债？普通维护已改用 `maxMaintenanceBatches`，overflow 却继续复用这个"每保护区批数"字段，且 `compactionRetries` 与其互斥报错。
5. **失败路径 #6（`recoverOverflow` 返回 `null` 但 `replaceGeneration` 已前进）** 是否应区分"仅剪枝成功"与"语义压缩成功"两种重试凭据？当前 `:346` 只比对 generation，`:348` 无条件计数，运维无法从日志判断究竟是哪一刀救活了请求。
