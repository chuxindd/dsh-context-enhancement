# 13 Overflow 与 Replacement 事务差异（正式审计）

> 基准时刻：2026-09-11 10:00+08:00（`审计资料/工作区基线.json`）
> 对象：当前工作区**静态设计与实现语义**（`src/**` 为主）。不审运行实例、watcher、用户 settings，不重开 DSH 调查。
> 对照：`理想化落地方案.md` §3.8 / §4.7 / §6（并引 §2 原则 5/7/9、§3.4、§8 不变量 6，仅在解释影响时引用）。
> 前置已读：`审计资料/00-工作区基线与构建产物.md`、`审计资料/01-插件装配与配置生效链.md`、`理想化落地方案.md`、`调查资料/10`（集成地图，经 01 引用核对）、`调查资料/14`、`调查资料/02`、`调查资料/06`。
> 本轮未构建、未测试、未格式化、未修改任何既有文件；仅新增本文件。
> 分类：【确认差异】= 与理想要求冲突或缺失；【等价实现】= 机制不同但满足同一安全目标；【参数差异】= 同一机制不同取值/授权面；【需实验确认】= 静态不可判；【构建产物差异】= src 与 lib 语义不一致。

---

## 0. 结论速览

1. **恢复阶梯自身（§4.7 level 0–3 的次序、每级重新计量/重新分区、跨级证明、generation 授权、失败保持）在 src 中是完整实现的**，唯一未被实现的是 §3.8 第 1 项要求的"**分区**裁剪"——阶段 A 是**全表面一次裁剪**，因此 level 3 的近区授权实际上被前置弱化了。【确认差异 C-01/C-02】
2. **近区三级授权中的 `hardLimitChars` 在当前装配下未配置（`undefined`）**，且阶段 A 的全表面裁剪让 `pruneRecentContent` 分支不可达 ⇒ 近区既无字符上限、也不经过"`overflow-recent` 才处理"的门。这是本轮影响面最大的一条。【确认差异 C-02 + 参数差异 P-01】
3. **恢复等级只在 `logger.warn` 中存在，没有任何持久记录**（无 Session 事件、无 audit 记录、无 stop reason 账本）⇒ 违反 §6.1「recovery level 必须可恢复」与 §3.14 账本要求。【确认差异 C-05】
4. **`maxOverflowRetries = 1` 把整条阶梯当作"一次恢复尝试"计费**，单次 overflow 序列只能买到最多 `3 × maxPressureBatches` 个批次，且无法在同一次恢复内完成"逐级放宽"的完整链。【参数差异 P-02】
5. 事务/bracket、lifecycle/generation 稳定性、source-index 分类、失败保持、generation retry 判定，全部有**等价实现**（§2，E-01…E-12）；其中"overflow 不预检 compaction 锁"由 `compactSurfaceRegion` 内部等价覆盖。【等价实现 E-08】
6. `agent/request-error` 的 listener 顺序（与 `llm-retry`）在 src 中**无 `prepend`**，静态不可判，且唯一相关测试的 fake `ctx.on` 不接收 options ⇒ 只能作设计边界与实验项。【确认差异 C-08（设计边界）+ 需实验 X-01】
7. `lib/compaction-basic.js:9347-9398` 与 `src` 的 `recoverOverflow` 逐句一致 ⇒ 本专题**无构建产物差异**。
8. baseline 无漂移（§5）。

---

## 1. 逐条差异矩阵

| ID | 理想要求（章节） | 当前设计（路径:行 / 符号） | 分类 | 证据 | 影响 | 需实验 |
|---|---|---|---|---|---|---|
| C-01 | §3.8-1：overflow 裁剪**先只处理遗忘区与工具区**的原始大工具结果；近区留到第 4 步 | `src/compaction-basic.ts:1019-1022` `recoverOverflow()` 阶段 A：`prune.pruneSession(session, { candidateSeqs: surface.nodes.filter(isOriginalToolResult) })`——**无 `olderRange`** ⇒ `src/tool-result-pruner.ts:298-302` 把 olderSpan 展开为 `{0, nodes.length-1}`，`:320-323` 使**全部**原文结果 `ordinaryEligible = true` | 【确认差异】 | 实现逐句（含 `src/tool-result-pruner.ts:334-336` 的 `ordinaryEligible ? pruneMessageContent : pruneRecentMessageContent` 分流） | level 0 的边界等于"全表面"，`§3.8` 的分区顺序在第一步即被越过；近区原文结果按普通 `thresholdChars(8192)` 被裁，而非按 `hardLimitChars`；level 3 的"近期恢复"授权因此名存实亡（近区早已被动过） | 否（源码可判） |
| C-02 | §3.8-5：近区原始工具结果**只有**超过 `hardLimitChars` **或**已进入 `overflow-recent` 才可处理（§8 不变量 6） | 同 C-01：近区原文结果在阶段 A 被 `ordinaryEligible=true` 处理，`pruneRecentContent`（`src/tool-result-pruner.ts:136-138`、`:154-155`）**在该路径永不被走到**；同时 `hardLimitChars` 在当前 preset 未配置（`presets/contextual/agent.cordis.yml:181-186` 仅有 threshold/head/tail）⇒ `undefined` | 【确认差异】+【参数差异 P-01】 | 见 C-01 证据 + preset 行 | 近区保护退化为"无字符上限、无等级门"；`hardLimitChars`（方案 §7「必须配置模型安全值」）缺失使该门不可用 | 否 |
| C-03 | §4.7 每级有独立 batch guard、stop reason；§3.14 记录 `stopReason / guard / recoveryLevel` | `src/compaction-basic.ts:1035` `for (batch = 0; batch < policy.maxPressureBatches; …)` 对三级**共用同一预算**；`recoverOverflow` 内无 stop reason、无 guard 计数落账（仅 `:1060` 一行 `logger.warn`） | 【确认差异】 | 逐句 | overflow 的停止原因无法与普通 pressure 的 typed verdict（`pressureStops`/`stopEnvelopeBudgetPass`，`:963-1005`）对账；"每级独立 guard"只有隐含的 `batch` 计数 | 否 |
| C-04 | §6.1：`recovery level` 必须可从 Session 日志恢复（不能只存在独立 storage audit） | `src/compaction-basic.ts:1060` 仅 `this.ctx.logger.warn(\`context-overflow recovery level ${level}, batch ${batch+1}\`)`；全路径只落官方 `compaction/prune`（`src/tool-result-pruner.ts:350-361`）与 compaction bracket（`src/internal/compaction/region.ts:259`、`:285`、`:293`），**无自定义事件、无 metadata** | 【确认差异】 | 逐句 + 全文件无 `SessionEventMap` 声明 | 重启/离线回放无法判定"此 surface 经 overflow 哪个等级恢复"；与 `调查资料/14 §6` 记录一致（该文标【待深挖】，本轮以源码定值为【确认差异】） | 否 |
| C-05 | §4.7：`only when no safe forget candidate → level 2`、`only when tool zone exhausted → level 3`；§3.8 尾：每次跨级必须证明前一级"无安全候选**或已达到本次 guard**"并**持久记录等级** | 跨级证明在 `src/compaction-basic.ts:1062-1074` 实现（末批后重计量/重分区，`remaining` 仍可选 ⇒ `return latest` 拒绝跨区）；但 `:1059` 的 `canCompactHistory` 失败走 `break`（**跳过**该守卫直接进入更年轻区），`等级`本身无持久记录 | 【确认差异】（仅"持久记录"部分）+【等价实现 E-04】（证明逻辑） | `:1054`、`:1059`、`:1062-1074` | 结构前提被证明，但审计面不可核验；`:1059` 的 `break` 使"更年轻区被进入"缺少可与 `remaining` 守卫区分的记录 | 否 |
| C-06 | §4.7：`generation advanced => retry, else propagate original error`；每次 retry 必须区分"仅剪枝成功"与"语义压缩成功"（§3.14 净释放口径） | `:318` 抓 `generation`；`:328-334` 异常但 `replaceGeneration > generation` ⇒ 计数并 `{kind:'retry'}`（不区分进展来源）；`:345-349` 正常返回仅比对 generation，`result !== null` 只影响日志（`:347`） | 【确认差异】（仅"区分进展来源"部分）+【等价实现 E-05】（授权判定） | `:318`、`:328-334`、`:344-349` | 阶段 A 部分落地后语义阶梯抛错，会被当作"恢复成功"重试；运维无法从日志判定是哪一刀救活请求（与 `调查资料/14 §6` 的待深挖项一致） | 否 |
| C-07 | §4.7 顺序：`request-error → capture generation → level 0…`；§3.8-1 的裁剪范围由分区决定 | `src/compaction-basic.ts:438-440`：`trigger === 'context-overflow'` **先** `return this.recoverOverflow(…)`，`:1019-1022` 阶段 A 在 `:1023-1028`（`routedTarget` / `resolveModelInfo` / `resolveCompactSpec`）**之前**执行 ⇒ 目标缺失、`context` 缺失、`contextWindow` 非法（`TargetPressureConfigError`）时，**表面已被改写**后才放弃 | 【确认差异】 | 逐句 | "先证明再动手"的顺序被反转；配置缺失的会话仍会被 overflow 裁剪一次 | 否 |
| C-08 | §4.7 的 overflow 状态机挂在 `request-error` seam（`调查资料/06 Q5/Q8`：seam 正确） | `src/compaction-basic.ts:306` `ctx.on('agent/request-error', …)` **无 `prepend`**；`:294`/`:300` 两个计数重置监听同样无 `prepend`；`:291` 的 `agent/pre-step` 亦无 | 【确认差异】（设计边界） | `:274`、`:294`、`:300`、`:306`；`tests/compaction-lifecycle-scheduling.spec.ts:51-54` 的 fake `ctx.on(name, handler)` **不接收 options**，故测试也无法钉住顺序 | 若部署把 `CONTEXT_WINDOW_EXCEEDED` 配入 `llm-retry.retryableCodes` 且 `llm-retry` 位于外层，overflow 恢复**永不进入**；静态不可判 | 是（X-01） |
| P-01 | §7：`hardLimitChars` 必须配置模型安全值；校验 `hardLimitChars > thresholdChars` | 未配置 ⇒ `undefined` ⇒ `pruneRecentContent` 直接 `return null`（`src/tool-result-pruner.ts:137-138`） | 【参数差异】 | `presets/contextual/agent.cordis.yml:183-186`；`src/tool-result-pruner.ts:79`（`.default(undefined)`） | 近区唯一的内容上限关闭；与 C-02 叠加后近区无字符门 | 否 |
| P-02 | §4.7 level 0–3 逐级放宽；每级有独立 guard | `maxOverflowRetries` 默认 `1`（`src/internal/compaction/config.ts:169`，无 preset 覆盖 ⇒ 静态生效值 1），`:315-316` 在**进入阶梯前**一次性拦截；计数只在 idle（`:294-296`）或新的 `assistant/message`（`:300-304`）清零 | 【参数差异】 | `:315-316`、`:294-304`、`config.ts:169`；`types.ts:44-45`（`0` 禁用语义） | 单次 overflow 序列只能走"一次恢复尝试"，其内部最多 `3 × maxPressureBatches` 个批次；若末批后仍高于阈值，下一次 `CONTEXT_WINDOW_EXCEEDED` 直接 `next()`，整条阶梯无法在一次恢复内完成 | 是（X-04） |
| P-03 | §3.8-1：level 0 只处理遗忘区/工具区**原始大**结果 | 阶段 A 的候选集由 `isOriginalToolResult` 过滤（`src/internal/compaction/source-index.ts:81-84`），不设 `minChars/minTokens` 门槛；`maxPressureBatches = 0` 时语义阶梯整体关闭但阶段 A 仍然执行 | 【参数差异】 | `:1019-1022`、`config.ts:24`、`config.ts:161-163` | "关闭语义恢复"不等于"关闭 overflow 恢复"；阶段 A 的候选面与实际收益无下界约束 | 是（X-04） |
| E-01 | §4.7 `request-error CONTEXT_WINDOW_EXCEEDED` 识别 | `:310` `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE \|\| signal.aborted ⇒ next()`；不做文本嗅探，`auto` 默认 `true`（`config.ts:69`） | 【等价实现】 | `:306-310`、`config.ts:69` | 与方案一致（依赖适配器归一化码） | 否 |
| E-02 | §4.7 `capture generation` | `:318` `const generation = agent.session.surface.replaceGeneration`（恢复前抓取） | 【等价实现】 | `:318` | 一致 | 否 |
| E-03 | §4.7 level 0→1→2→3 次序、只向更年轻方向前进 | `:1034` `for (const level of ['overflow-forget','overflow-tool-zone','overflow-recent'])`，无回退；每批 `:1036` 重测、`:1038` 重分区、`:1049` 重算 envelope；`:1037` 达标即 `return latest` | 【等价实现】 | `:1034-1053` | 与 §4.7 状态图同构（层级"3"对"recent"），且满足 §3.5"每批后重计量" | 否 |
| E-04 | §4.7 `only when no safe forget candidate / tool zone exhausted` | `:1044` 范围 `null ⇒ break`；`:1054` `selectForgetBatch === null ⇒ break`；`:1062-1074` 末批后重分区，`remaining` 仍可选 ⇒ `return latest`（拒绝跨区） | 【等价实现】 | `:1044`、`:1054`、`:1062-1074` | 跨级证明的实质存在（C-05 只差"持久记录"与 `:1059` 的 `break` 语义） | 否 |
| E-05 | §4.7 `generation advanced => retry, else propagate` | `:345-346` `signal.aborted \|\| replaceGeneration <= generation ⇒ next()`；`:348-349` 置计数 + `{kind:'retry'}` | 【等价实现】 | `:344-349`；`调查资料/06 Q5`（retry 使 `deriveMessages()` 重跑，replacement 被新请求采用） | 授权凭据与理想一致 | 否 |
| E-06 | §4.7 每级 batch guard（`maxPressureBatches` 语义） | `:1035` 每级批数上限 `policy.maxPressureBatches`；`types.ts:52-53` 注释明确为"每保护区、每次恢复尝试的批数"；`config.ts:131-133` 与 legacy `compactionRetries` 互斥报错 | 【等价实现】 | `:1035`、`config.ts:161-163` | 与历史实现的兼容映射被显式化，不产生歧义 | 否 |
| E-07 | §4.7 近区处理不是永久授权（仅本次恢复） | 近区仅在 level 3 的 `selectForgetBatch` 调用中出现（`:1043`、`:1050`），无任何状态位持久放松；普通 pressure 路径仍只走 `planForgetBatch`（`:543-549`）与 tool 区裁剪（`:471-488`） | 【等价实现】 | `:1043`、`:471-488`、`:543-549`；`docs/compaction-algorithm-reconciliation.md` 决策表（经 `调查资料/14 §7` 引用） | "授权不越轮"成立（但见 C-01：授权被阶段 A 前置削弱） | 否 |
| E-08 | §4.7 事务/bracket：overflow 也必须持有互斥锁 | `recoverOverflow` 自身**不调** `assertNoActiveCompaction`（普通路径在 `:443` 调），但每批进入 `compactRegion` → `:1254` `compactSurfaceRegion` → `src/internal/compaction/region.ts:233-238` `inspectCompactionEntryState` + `assertCompactionInactive`，`:247-250` 要求 open turn 作为 owner | 【等价实现】 | `:1248-1263`、`region.ts:233-251`、`region.ts:356-368` | 锁被事务入口等价覆盖；差别仅在"何时报 busy"（每批前 vs 恢复前），不改变安全性 | 否 |
| E-09 | §4.3/§4.7 `transaction/bracket`：`compaction/start`→摘要→稳定性断言→提交→`compaction/end` | `region.ts:259` start、`:271-281` prepare+summarize+`assertWholeSurfaceUnchanged`（`:463-472` 深比较 meter nodes）、`:283` commit、`:285` end；overflow 以 `:1260` `{owner:'current-turn', stability:'whole-surface'}` 复用 | 【等价实现】 | `region.ts:222-324`、`:463-472`、`:1248-1263` | 与 §4.2-3/§6 提交校验一致 | 否 |
| E-10 | §6.1 source 类型可从 Session 恢复（不由 audit 单独决定） | `source-index.ts:57-96` 由 `surfaceOp` / `compaction/prune` 邻接 / checkpoint source 重建 `original/tool-pruned/history-summary/unknown-replacement`；audit 只用于 `tool-summary` 增益（`:98-110`、`compaction-basic.ts:726-734`） | 【等价实现】 | `source-index.ts:98-126`、`compaction-basic.ts:726-734` | 分类不依赖模型文本；audit 丢失不会把 tool-summary 误判为 original（`servedReplacementSeqs` + open 记录兜底，`:729-732`） | 否 |
| E-11 | §4.7/§2-7 失败保持：原 surface 完整、保留原始错误 | 异常且无进展 ⇒ `:336-342` `logger.warn` + `next()`；正常返回但 generation 未前进 ⇒ `:345-346` `next()`；事务失败仅追加带 `error` 的 `compaction/end`（`region.ts:288-299`），替换仅在 append 成功后 `splice`（`调查资料/02 Q5`） | 【等价实现】 | `:322-346`、`region.ts:288-299` | 与 §4.7 尾「propagate original error」一致 | 否 |
| E-12 | §3.5 区域隔离是普通维护的硬约束（不因 overflow 反向污染） | overflow 不经 `pressureStops`/`stopEnvelopeBudgetPass`（`:963-1005` 只被普通路径调用）；`zones()`/两个 envelope 预算为每次现算纯函数（`:886-902`、`:910-922`、`:929-944`）；overflow 不调用 `summarizeToolGroups` | 【等价实现】 | 逐句 + `调查资料/14 §7` | "overflow 不反向污染普通维护"成立（§2-9） | 否 |
| E-13 | §3.6 step/tool 边界重建，不靠 payload 猜测截断步骤 | 批次端点由 `toolPairingBalancedBefore/After` 与 `stepBoundaryAfter`（`src/internal/compaction/zones.ts:134`、`:142-143`、`:318-331`）共同裁定；分区边界 `boundaryFromTail`（`:364-366`）向历史侧回退直到平衡 | 【等价实现】 | `zones.ts:126-157`、`:318-331`、`:350-367` | 不完整安全 span 时返回 `blocked` 而非截断，符合 §3.6 尾句 | 否 |
| E-14 | §3.4/§4.7 每语义批次必须有安全边界与进展 | `region.ts` 提交前的严格缩减断言 + 事务稳定性断言；overflow 每批后由 `:1065` 重测驱动下一批/返回 | 【等价实现】 | `region.ts:280-287`；`compaction-basic.ts:1062-1074` | 批次不得放大 surface 的保证与理想一致 | 否 |
| E-15 | §6.1 `本轮排除和最早重入 turn` 可恢复 | `:1055-1059` 以 `canCompactHistory(seq, minReentryTurns)`（`allowImmediateReentry` 默认 `false`，`source-index.ts:85-94`）在**每批前**现算排除；不缓存也不持久 | 【等价实现】 | `:1055-1059`、`source-index.ts:85-94`（与普通压力 `:659` 显式传 `true` 形成对照） | 重入保护在 overflow 比普通压力更严格，且排除规则随 surface 重建 | 否 |
| X-01 | §4.7 seam 可用性（前置于状态机） | `:306` 无 `prepend` ⇒ 与 `llm-retry` 的相对位置由装载序决定；`调查资料/06 Q4` 已证两者均无 `prepend`，默认 `retryableCodes` 不含该码 | 【需实验确认】 | C-08 证据 + `调查资料/06 Q4` | 静态只能证明"默认配置下两条路径都 `next()`"；真实 profile 的最终顺序与 `--patch`/settings 合并值需进程观测 | 是 |
| X-02 | §4.7 level 2/3 真实可达性与跨区成功 | 唯一直接测试 `tests/compaction-three-zone.spec.ts:445-451` 以 `recoverOverflow.call(engine, agent, undefined, signal)` 传入 **`prune = undefined`**（阶段 A 完全未覆盖），只断言 `compacted.length <= 2` 与所有被压缩位置 `< 6` | 【需实验确认】 | 该测试行 + `grep` 结果：全 `tests/` 无 `overflow-tool-zone`/`overflow-recent`/`CONTEXT_WINDOW_EXCEEDED` 断言（`tests/compaction-lifecycle-scheduling.spec.ts:97` 只钉注册名） | 跨区成功分支（`:1062-1074` 判 null 后落到更年轻区）无行为验证；等级持久化也无可验证载体 | 是 |
| X-03 | §4.7 异常路径与进展来源区分 | `:322-335` 的"异常但已前进 ⇒ retry"无测试；`tests/` 无 `replaceGeneration` 相关的 overflow 断言 | 【需实验确认】 | 同上 grep | C-06 的实际后果（何时把部分剪枝当成功）只能由运行证据确认 | 是 |
| X-04 | §4.7/§7 `maxOverflowRetries`/`maxPressureBatches` 的 `0` 值禁用语义 | `maxOverflowRetries = 0` ⇒ `:316` 恒 `next()`（恢复关闭）；`maxPressureBatches = 0` ⇒ `:1035` 循环体不执行，但**阶段 A 仍执行** | 【需实验确认】 | `:316`、`:1019-1022`、`:1035`；`types.ts:44-45`、`:52-53` | "禁用语义恢复"的静态含义已明确，但"0 值下是否仍改写 surface"需要一次最小实验才能作为验收不变量固定 | 是 |
| B-01 | §4.7/§3.8 的 overflow 设计是否被 lib 承载 | `lib/compaction-basic.js:9347-9398` 的 `recoverOverflow` 与 `src/compaction-basic.ts:1013-1078` 逐句一致（含 `:9351` 无 `olderRange` 的全表面裁剪、`:9360-9364` 三级阶梯、`:9383-9395` 跨区守卫）；`export "./compaction-basic" → lib/compaction-basic.js` | 【构建产物差异】**未发现** | 对比阅读 + `lib/compaction-basic.js` 正则命中 `recoverOverflow|overflow-forget|overflow-tool-zone|overflow-recent|maxPressureBatches` | lib 承载同一设计；本专题不需要额外产物层差异说明 | 否 |

说明：`tests/compaction-recent-hard-limit.spec.ts:78-123` 覆盖的 `hardLimitChars` 语义（`pruner(HARD_LIMIT).pruneSession(session, {olderRange: {start: old, end: old}})` 时"近区超大结果仍被裁、介于两阈值之间的近区结果保持原样"）是**普通路径**（有 `olderRange`）的行为，与 §3.8-5 不矛盾，故计入【等价实现】面（E-16：近区硬上限机制本身存在且有测试），但它不覆盖 C-01/C-02 所指的 overflow 阶段 A 路径。

---

## 2. 与 §4.7 状态图的逐格对照（便于综合矩阵引用）

| §4.7 步骤 | 实现位置 | 结论 |
|---|---|---|
| `request-error CONTEXT_WINDOW_EXCEEDED` | `src/compaction-basic.ts:306-310` | E-01 |
| `capture generation` | `:318` | E-02 |
| `level 0: prune original large results in forget+tool zones` | `:1019-1022` | **C-01/C-02**（范围=全表面，不分分区） |
| `remeasure; recovered => retry` | `:1036-1037` | E-03（达标即 `return latest`） |
| `level 1: bounded forget batches` | `:1039-1040`、`:1050-1053` | E-03/E-04/E-06 |
| `only when no safe forget candidate` | `:1044`、`:1054`、`:1062-1074` | E-04（`break`/`return` 语义见 C-05） |
| `level 2: bounded oldest tool-zone history batches` | `:1041-1042` | E-03/E-04 |
| `only when tool zone exhausted` | `:1062-1074` | E-04 |
| `level 3: recent recovery — hard-limit tool pruning first` | `:1043`（`zones.recent` 作批次范围）；"hard-limit first"**无对应步骤**（阶段 A 已前置） | **C-02** + P-01 |
| `then bounded oldest recent span as final action` | `:1050` `selectForgetBatch`（最旧端，`zones.ts:141-154`） | E-03（受 Rmin 地板保护：`envelope-budget.ts:131-193`、`:260`） |
| `generation advanced => retry, else propagate original error` | `:344-349`、`:336-342` | E-05/E-11（区分进展来源见 C-06） |
| `每一级都有独立 batch guard、stop reason 和持久 recovery level` | `:1035`（共用预算）、无 stop reason、无持久 level | **C-03/C-04/C-05** + P-02 |
| `近区处理不是普通 replacement 的永久授权` | `:1043` 仅在 level 3；无持久放松位 | E-07（被 C-01 前置削弱） |

---

## 3. 测试覆盖现状（只读核对，用于"是否需实验"判定）

- 直接覆盖 overflow：仅 `tests/compaction-three-zone.spec.ts:445-451`（`prune=undefined`，只断言"不进更年轻区"）。
- 未覆盖：阶段 A 全表面裁剪；`overflow-tool-zone`/`overflow-recent` 两级被真正进入；`:1062-1074` 跨区守卫的**反例**；`:322-335`/`:336-342` 异常路径；`:316` 与 `:1035` 的 0 值语义。
- `tests/compaction-lifecycle-scheduling.spec.ts:89-106` 只钉"注册了哪四个 hook"，其 fake `ctx.on`（`:51-54`）不接收 options ⇒ 无 listener 相对顺序的静态或测试约束（C-08/X-01）。

---

## 4. 本轮审计边界

- 以 `src` 业务设计为主（18 个实现/配置/测试文件：`src/compaction-basic.ts`、`src/tool-result-pruner.ts`、`src/internal/compaction/{zones,region,config,types,source-index,envelope-budget,pruner-config}.ts`、`presets/contextual/agent.cordis.yml`、`tests/{compaction-three-zone,compaction-recent-hard-limit,compaction-lifecycle-scheduling}.spec.ts`、`lib/compaction-basic.js`（仅为 export 指向核对）、以及被引用的 `docs/compaction-algorithm-reconciliation.md` 结论（经 `调查资料/14` 转引，未重复调查）。
- 未审：Stable Task State / task-state 侧（§5、§3.9-3.13）、tool-group 语义摘要的内部算法（§4.4，仅涉及其对 overflow 的耦合）、GUI 展示（§3.14 的 UI 要求）、运行实例与 watcher。
- 未做：构建、测试、安装、格式化、修改既有文件、派生子代理。

---

## 5. Baseline drift 检查（审计结束时）

| 项 | baseline（`工作区基线.json` / `00`） | 本次结束时 | 判定 |
|---|---|---|---|
| HEAD commit | `cf034b4bce6141bb95b590f5ed7fa66f8727daa2` | 同 | 无漂移 |
| Modified (M) | 102 | 102 | 无漂移 |
| Untracked (??) | 31 | 32 | +1 = 本轮新增 `审计资料/13-Overflow与Replacement差异.md`（不计 drift） |
| 总 dirty | 133 | 134 | +1 = 同上 |
| `package.json` SHA-256 | `20454835…6702E9` | 同 | 无漂移 |
| `pnpm-lock.yaml` SHA-256 | `385431F7…C135F4` | 同 | 无漂移 |
| `src/index.ts` SHA-256 | `5F53AEAB…13F20B` | 同 | 无漂移 |
| `cordis.patch.yml` SHA-256 | `95E8C9C0…12268FE` | 同 | 无漂移 |
| `理想化落地方案.md` SHA-256 | `12734F96…92435` | 同 | 无漂移 |
| `src/compaction-basic.ts` SHA-256 | `5585C60D…46B653` | 同 | 无漂移 |
| `src/task-state-basic.ts` SHA-256 | `93F18075…E485F3C3` | 同 | 无漂移 |
| `src/tool-result-pruner.ts` SHA-256 | `BF126FF0…1025DE1` | 同 | 无漂移 |
| `src/internal/compaction/config.ts` SHA-256 | `C8801BA4…0960F8E` | 同 | 无漂移 |

**结论：原有源码/配置未漂移；唯一新增文件为本审计文档。**

---

## 6. 供综合矩阵引用的差异 ID

- 确认差异（8）：`C-01` 阶段 A 全表面裁剪越过分区、`C-02` 近区双门失效、`C-03` 无每级独立 guard/stop reason、`C-04` recovery level 无持久记录、`C-05` 跨级"持久记录等级"缺失（+`:1059` break 语义）、`C-06` 进展来源不区分、`C-07` 阶段 A 先于目标/预算解析、`C-08` request-error listener 无 `prepend`（设计边界）。
- 参数差异（3）：`P-01` `hardLimitChars` 未配置、`P-02` `maxOverflowRetries=1` 使阶梯单次化、`P-03` 阶段 A 无候选量下界且 `maxPressureBatches=0` 仍执行。
- 等价实现（16）：`E-01`…`E-16`（识别、generation 抓取、三级次序、跨级证明、retry 授权、每级批数、近区非永久授权、事务锁、bracket、source 重建、失败保持、不反向污染普通维护、step/tool 边界、缩减与稳定性、重入排除、近区硬上限机制）。
- 需实验（4）：`X-01` listener 顺序、`X-02` level 2/3 可达性与跨区反例、`X-03` 异常路径、`X-04` 0 值禁用语义。
- 构建产物差异：`B-01` **未发现**（`lib/compaction-basic.js:9347-9398` ≡ `src/compaction-basic.ts:1013-1078`）。
