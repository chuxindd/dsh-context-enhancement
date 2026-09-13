# X4 · Stable 固定槽位压缩遮蔽回收实验

> 范围：**只执行 X4**。挂载当前真实 task-state fixed-slot + 当前真实 compaction，验证槽位被压缩遮蔽后的安全回收与重建。
> 依据：`审计资料/42-文件级修复PLAN.md` §7（B5.2b）；`审计资料/B5.1-实施记录.md`；`审计资料/B5.2a-实施记录.md`。
> 状态：**完成（attempt 2）**。
> 最终 verdict：**`fixed`**（4 个真实「压缩遮蔽 → 重建」循环，全部不变量成立）。
> attempt 1 的 verdict 是 `inconclusive`，其原始证据保留为 `attempt-1-ledger.json` / `attempt-1-vitest-output.txt`。

---

## 1. 实验问题（唯一）

B5.1 已证明固定槽位在**无压缩介入**时的 replacement 行为（20 revision 可见槽位恒为 1）。
X4 要回答的问题是：当真实 compaction 在真实边界把 slot 节点选入 span 并覆盖（通过 `surfaceOp:replace` 折叠进 history-summary checkpoint），下一合法 `agent/pre-step` 是否能**发现 slot 不在 surface 并安全重建**一个新 generation 的 slot？以及连续多轮"遮蔽→重建"后不变量是否仍然成立。

## 2. 判定规则（运行前固定，attempt 2 修正）

```
routeWorked   := engine 可用（真实挂载的 BasicCompactionEngine 实例，fiber state = ACTIVE）
                 且 至少一次真实 compaction 调用返回可观测结果
                 （result ≠ null、shadowed span 非空、surface 上确实出现 replacement 事件、
                   被遮蔽 span 包含当时可见的 slot seq、且调用后 slot 不再可见）

completeCycle := 该 cycle 的 compaction 是 observed，且下一合法真实 pre-step
                 重建出恰好 1 个可见 slot，其 generation 大于被遮蔽的那个

fixed             = routeWorked 且 completeCycle ≥ 3 且全部不变量成立
still-reproduced  = 证据充分（routeWorked 且 ≥3 轮）但不变量被破坏
inconclusive      = routeWorked 为假，或 completeCycle < 3

不变量：可见 slot = 1；generation 严格递增；source-index 分类 = task-state-slot；
       injection tokens 平坦（|max-min| ≤ max(24, 10%·min)）；
       replacement 不含 slot renderer header（无 slot 文本自反馈）；
       重建后的请求恰好携带 1 条 slot 消息；
       retained tail 保持、压缩后 surface 每个 cut tool-pairing 平衡。
```

**0 cycle 永不 `fixed`**：`fixed` 的前置条件是 `routeWorked` 且 `completeCycle ≥ 3`，两者都要求真实可观测证据。

### 2.1 attempt 1 的两个判据 bug（已修）

1. `criteria.routeWorked` 被写成 `errors.length === 0`（= `true`）。在 surfaceRoute 完全不可用、0 cycle 的运行里它依然为 `true`，与"路由可用"无关。
2. `allTaskStateSlotKind` / `dshChannelEmpty` 在空 `cycles` 数组上取 `[].every(...) === true`，是真空真（vacuous truth）。

attempt 2 中三者都改为**必须有非空证据**才能为 `true`。

---

## 3. attempt 1 为什么拿不到 engine（根因，已实测）

attempt-1 的 ledger 记录 `surfaceRoute.available=false`、reason `Compaction engine not available (auto mode may have interfered)`、`cycles: []`、0 cycle。实测根因**不是** auto 模式干扰：

1. fixture 的 `COMPACTION_CONFIG` 携带了一个 schema 中**不存在**的键 `contextWindowOverride`。
   `BasicCompactionEngine` 的构造路径调用 `resolveConfig()`，其严格键检查（`BASIC_COMPACT_CONFIG_KEYS`，见 `src/internal/compaction/config.ts`）抛出：
   ```
   Error: BasicCompactionConfig: unknown key "contextWindowOverride"
   ```
   （cordis 把它记为 fiber state 3 = FAILED。）
2. fixture 用 `catch { /* ignore */ }` 把这个错误**完全吞掉**，然后检查 `ctx.get('compaction')` → `undefined` → 走进 `else` 分支，reason 猜成 "auto mode may have interfered"，0 cycle，且 `errors` 为空数组（所以 `routeWorked` 那个 bug 判据还返回了 `true`）。

诊断探针原文保留在 `tmp/attempt-2-rootcause-probe.txt`；关键两行：

```
[mount-BasicCompactionEngine] error=Error: BasicCompactionConfig: unknown key "contextWindowOverride" fiberState=null
[after BasicCompactionEngine] fibers: ... | BasicCompactionEngine#3!Error: BasicCompactionConfig: unknown key "contextWindowOverride"
[agent-loop] inject=["agents","sessions","llm","tools","systemPrompt","sessionProjections"] name=AgentLoop
```

第三行同时证明：**DSH `AgentLoop` 插件本身不提供 `ctx.compaction`**（它的 inject 列表里没有 `compaction`），所以 fixture 必须自己真实挂载 compaction provider —— 而它之前实际挂载失败了。

### 3.1 attempt 2 的修复

| 修复 | 内容 |
| --- | --- |
| 非法配置键 | 从 `COMPACTION_CONFIG` 删除 `contextWindowOverride`；context capacity 改由 fake adapter 的 `resolveModel()` 以 `context: { contextWindow }` 声明（这是 adapter 拥有的元数据，不是插件配置键） |
| 静默失败 | 挂载改为 `try/catch` 记录错误原文（注意：`ctx.plugin()` 返回 thenable fiber，没有 `.catch`，必须用 try/catch + `await`）；`engineMount.pluginError` 进入 ledger 与 `errors`，并断言必须为 `null` |
| engine 真伪 | `engineAvailable = ctx.get('compaction') instanceof BasicCompactionEngine`，并把 `constructorName`、`fiberState`、7 个依赖服务可用性全部写进 ledger |
| 判据一致性 | `routeWorked` 重新定义为 §2 的语义；空数组不再产生真空真 |

未使用任何伪造手段：没有直接调用私有方法、没有伪造 replacement、没有手工遮蔽 slot。compaction 的 span 来自真实 `compactNow`，遮蔽关系来自真实 `surfaceOp:replace` 事件与 `sourceEventSeqs`。

---

## 4. 挂载组件与关键配置

### 4.1 挂载组件

| 组件 | 类型 |
| --- | --- |
| `TaskStateBasicService` | 真实 provider（`src/task-state-basic.ts`） |
| `TaskStatePrompt` | 真实 slot 维护消费者（`src/task-state-prompt.ts`） |
| `BasicCompactionEngine` | 真实压缩引擎（`src/compaction-basic.ts`，**显式 cordis 插件挂载**，`auto: false`） |
| `SessionStore` / `SystemPrompt` / `LlmRuntime` / `TokenMeter` / `SessionProjectionRegistry` / `ToolRuntime` / `AgentRegistry` / `Storage` / `StorageJson` / `StorageDomain` | 真实 DSH 核心 |
| 唯一 LLM | 脚本化 `LlmAdapter`（不产出 provider usage，token 由真实 token-meter 启发式定价） |
| DSH AgentLoop | 从被审计 checkout（`a66e4702`，sha256 记录在 ledger）以原生 ESM `import()` 载入 |

### 4.2 关键配置

- `modelContextWindow = 4000`（由 fake adapter 的 `resolveModel()` 声明）
- `task-state-basic`：`minEvents=20`、`maxEvents=200`、`maxInputBytes=60000`、`maxEntriesPerKind=50`、`maxEntryBytes=4000`（= 部署 `cordis.patch.yml`）
- `task-state-prompt`：`maxBytes=8000`（= `presets/contextual`）
- `BasicCompactionEngine`：`auto=false`、`toolGroupSummarizer.enabled=false`、`minReentryTurns=1`、`maxMaintenanceBatches=1`、`maxPressureBatches=2`、`targetBatchTokens=800`、`maxBatchTokens=1200`
- 每 cycle：20 条合格人类事件（跨过 `minEvents=20`）+ 2 个 warmup step
- **本实验不设 pressure/forget 几何旋钮**：走的是真实 `compactNow`（manual / idle-session 路径），它以 `retainTokens = 0` 规划 span，因此 slot 是否被选中不依赖 `contextWindow` 或阈值；`resolveCompactSpec` 不在该路径上。保留 `targetBatchTokens` 等只是为了 ledger 记录真实配置。

### 4.3 每 cycle 流程

1. **Build**：追加 20 条合格人类事件 → 等待真实 worker 提交新的 Stable revision（`ctx.taskState.getStable().revision` 前进）
2. **Warmup**：2 次真实 step（真实 `agent/pre-step` waterfall → `TaskStatePrompt` 真实创建/replace slot → 真实模型请求 → turn 结束）
3. **Compact**：idle session 上真实 `compaction.compactNow(agent, signal)` —— 真实区域选择、真实摘要事务、真实 surface replacement
4. **Rebuild**：下一真实 step 的 `agent/pre-step` 发现 slot 不在 surface → 真实重建（`surfaceOp: 'append'`，generation +1）
5. **Verify**：source-index 分类、真实 token-meter 定价的 injection tokens、generation 单调性、retained tail / tool pairing

---

## 5. attempt 2 结果（verdict = `fixed`）

`criteria`（完整见 `x4-ledger.json` → `criteria`）：

| 判据 | 值 |
| --- | --- |
| `engineAvailable` | `true`（`constructorName = BasicCompactionEngine`，`fiberState = 2`，`pluginError = null`） |
| `routeWorked` | `true` |
| `compactionAttempts` / `observedCompactions` | `4` / `4` |
| `completeCycles` | `4` |
| `allOneVisibleSlot` | `true` |
| `generationsStrictlyIncreasing` | `true` |
| `allTaskStateSlotKind` | `true` |
| `injectionFlat` | `true` |
| `dshChannelEmpty` | `true` |
| `noSlotSelfFeedback` | `true` |
| `requestCarriesRebuiltSlot` | `true` |
| `retainedTailOk` | `true` |
| `evidenceComplete` | `true` |
| `errors` | `[]` |
| **verdict** | **`fixed`** |

持久化（store）证据：

| 字段 | 值 |
| --- | --- |
| `cycles[].store`（**该 cycle 的证据**） | 逐 cycle 均为 `read/stableRevision/auditRowCount = true/1/1 · true/2/2 · true/3/3 · true/4/4`（= 每 cycle 一次真实 commit，`cycles[].stable.afterRevision = 1,2,3,4`） |
| `storeFinal` | 本次运行为 `read=true`、`stableRevision=5`、`auditRowCount=5`（含测量后落地的 trailing 波次；多次运行取 4 或 5，见 §7.3 末） |
| `storeQuiesced` | `true`（测试结束前给后台 task-state 波次 4 s 静默窗口，避免读在途快照） |

### 5.1 逐 cycle 证据（`x4-ledger.json` → `cycles[]`）

| cycle | seeds seq | stable rev | compaction: shadowed nodes (span) | replacement seq (op / cites slot) | surface 可见 slot | rebuild seq / gen | 重建请求 slot 数 | source-index kind | injection tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0–19 | 1 | 24（[0–40]） | 51（replace[0–40]，srcSeqs 含 38） | 1 → **0** | 56 / gen 3 | 1 | `task-state-slot` | 172 |
| 2 | 67–86 | 2 | 28（[51–106]） | 117（replace[51–106]，srcSeqs 含 104） | 1 → **0** | 122 / gen 6 | 1 | `task-state-slot` | 172 |
| 3 | 133–152 | 3 | 28（[117–172]） | 183（replace[117–172]，srcSeqs 含 170） | 1 → **0** | 188 / gen 9 | 1 | `task-state-slot` | 174 |
| 4 | 199–218 | 4 | 28（[183–238]） | 249（replace[183–238]，srcSeqs 含 236） | 1 → **0** | 254 / gen 12 | 1 | `task-state-slot` | 174 |

每 cycle 完整记录（均为实测值，不是推算）：

- **before surface**：`surfaceNodes` 25/29/29/29、`replaceGeneration` 1/4/7/10、真实 token-meter `surfaceTokens` 669/900/902/902、可见 slot `{seq, generation, revision, surfaceOp:'replace', tokens}`
- **compaction**：`plannedRange`（生产只读 planner `selectCompactableRange(session, measure, 0)` 复算）与实际 `shadowedSeqs`、`shadowedRange`、`shadowedTokenCount`（648/879/881/881）、`slotSeqShadowed=true`
- **replacement**：`replacementSeq`、`replacementSurfaceOp`、`replacementSourceEventSeqs`（含 slot seq ⇒ `replacementCitesSlot=true`）、`replacementIsHistorySummary=true`、`replacementContainsSlotHeader=false`（无 slot 文本自反馈）
- **after**：`slotVisibleAfterCompaction=0`、`surfaceNodes` 25→2（每轮压缩后 surface = `[checkpoint, retained tail]`）、`surfaceGeneration` +1
- **retained tail**：`tailPreserved=true`、`allCutsBalancedAfter=true`（压缩后 surface 每个 cut 平衡）
- **rebuild**：`rebuiltSlotSurfaceOp='append'`（无可见 slot 分支的真实 append，`coveredSeqs` 为空）、`shadowedSlotStillInLog=true`（旧节点保留在 log）
- **request**：重建后该 step 的真实请求 `messageCount=4`、`slotMessageCount=1`、`requestDshSnapshotMessageCount=0`
- **cumulative**：`visibleSlotNodes=1`、`surfaceTokens` 403/403/405/405（压缩确实释放了 token：669→403）、`cumulative.dshSnapshotNodesInLog=0`（DSH runtime-context 快照通道为空，slot 不借道该通道）

### 5.2 结论

连续 4 轮真实「压缩遮蔽 → 真实 pre-step 重建」中：

- 每次真实 `compactNow` 都把当时的可见 slot 节点选入 shadowed span，并通过真实 `surfaceOp:replace` 事件遮蔽它（replacement 的 `sourceEventSeqs` 显式引用 slot seq）；
- 下一合法 `agent/pre-step` 在 surface 上看不到 slot 后**安全重建**，可见 slot 恒为 1，generation 严格递增（2→3、5→6、8→9、11→12）；
- 重建 slot 被 `buildSurfaceSourceIndex` 分类为 `task-state-slot`，且重建后的真实请求恰好携带 1 条 slot 消息（旧 revision header 不可见）；
- injection tokens 在 4 轮中为 172/172/174/174（极差 2，远小于容差），不随循环数线性累积；
- compaction 摘要文本不含 slot renderer header，retained tail 保持且 tool pairing 平衡。

因此 **verdict = `fixed`**（仅针对 §1 那一个问题）。

---

## 6. 产出文件

| 文件 | 内容 |
| --- | --- |
| `x4.spec.ts` | attempt-2 实验 spec（不修改生产代码） |
| `x4-ledger.json` | attempt-2 逐 cycle 账本（**先写 ledger 再断言**） |
| `result.json` | attempt-2 判定摘要 + sourceDrift |
| `vitest-output.txt` | attempt-2 最终 vitest 运行输出 |
| `hashes.json` | 生产关键文件 pre/post SHA-256（**381 个路径**：src/tests/lib/presets/scripts/assets + 根配置 + tgz；pre/post 差异 0） |
| `attempt-1-ledger.json` | **attempt-1 原始失败证据**（verdict=inconclusive，0 cycle） |
| `attempt-1-vitest-output.txt` | **attempt-1 原始失败输出**（`expected 0 to be greater than or equal to 3`） |
| `README.md` | 本文件 |
| `tmp-storage/` | 真实持久化存储（每次运行前清空重建） |
| `tmp/attempt-2-rootcause-probe.txt` | 根因探针原文（证明 `unknown key "contextWindowOverride"` 与 AgentLoop inject 列表） |
| `tmp/run-a-ledger.json` | 用于确定性比较的第一次运行 ledger |
| `tmp/determinism-report.txt` | 两次独立运行的逐字段差异报告 |
| `tmp/hashes-pre.json` | 运行前采集的 SHA-256 快照 |
| `tmp/workspace-tests.txt` | 工作区自带测试套件（`tests/**`）的回归统计 |

## 7. 测试统计与 source drift

### 7.1 测试统计

| 运行 | 结果 |
| --- | --- |
| X4 实验 spec（experiment config） | **Test Files 1 passed (1) / Tests 1 passed (1)**，0 failed；耗时约 4.7 s（tests）/ 5.7 s（total）——其中约 4 s 是后台 task-state 波次的静默等待 |
| X4 实验 spec 独立复跑 | 1 passed (1)；结构逐字段一致（见 §7.3） |
| 工作区自带套件（`pnpm exec vitest run`，`tests/**/*.spec.ts`） | **Test Files 56 passed / 1 failed（57）· Tests 518 passed / 1 failed（519）**，耗时 48.25 s —— 完整输出 `tmp/workspace-tests.txt` |

工作区套件那 1 个失败与本实验无关，且是**会话开始前就存在**的产物一致性问题：

```
FAIL tests/artifact-parity.spec.ts > Artifact Parity (lib/ and dsh-context-enhancement-0.1.10.tgz vs src)
     > verifies lib/client.js contains patched module id
AssertionError: unpatched package id must not remain
```

证据：该断言只读 `lib/client.js`（预构建产物）。`hashes.json` 覆盖 `lib/**`（239 个路径）且 pre/post 差异为 **0**；mtime 检查显示 `lib/` 下没有任何文件在本会话被写入（§7.2）。本实验只写 `审计资料/实验结果/X4-Stable槽位压缩回收/` 内的文件，从未修改 src/tests/package/lib/tgz/历史实验/DSH checkout。

运行命令（记录在 ledger 的 `command` 字段）：

```
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/X4-Stable槽位压缩回收/x4.spec.ts --reporter=verbose
```

### 7.2 source drift = 0

`hashes.json` 覆盖 **381 个生产关键文件**的 SHA-256：`src/**` + `tests/**` + `lib/**` + `presets/**` + `scripts/**` + `assets/**` + 仓库根配置（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`vitest.config.ts`、`tsconfig*.json`、`tsdown.config.ts`、`cordis.patch.yml`、`README*.md`、`CHANGELOG.md`、`LICENSE`、`CONTRIBUTING.md`、`THIRD_PARTY_NOTICES.md`、`理想化落地方案.md`）+ `dsh-context-enhancement-0.1.10.tgz`。

- **pre/post 差异路径数 = 0**（`hashes.json.prePostIdentical = true`）
- 基线来自 `tmp/hashes-pre.json`（会话开始、任何写入之前采集）
- mtime 独立复核：`src` / `tests` / `lib` / `presets` / `scripts` / `assets` / `docs` 下**没有任何文件**在基线之后被写入（0 个），仓库根目录同样 0 个
- 历史实验目录（`E00`–`E10`、`B3`–`B5.1`、`harness/`）未改动
- **DSH checkout 未改动**：`HEAD = a66e4702047846cdaa10c66c9d3df3951f5ea70d`（与 attempt 1 相同），`packages/core/agent-loop/lib/index.js` sha256 = `a9142d46163d961ed5774ad544cb997da2197fefca5684ec820060dd50c1c935`（与 attempt 1 相同），`agent.ts` / `runtime-context.ts` 的 src hash 也相同；DSH `agent-loop` 目录下 0 个文件在基线之后被写入

### 7.3 确定性

两次独立运行（各自清空并重建 `tmp-storage`、全新 cordis Context、全新 AgentLoop 实例）逐字段递归比较：**仅 24 个叶子字段不同，全部是 content digest**。

1. **content digest（24 个）**：`stable.digest`、slot `textHash`、`rebuiltSlotTextHash`。
   原因：真实 `TaskStateBasicService` 每次 commit 都为每条 entry mint 随机 UUID（`randomUUID`），因此渲染出的 slot 文本与 stable digest 每次运行必然不同。这是真实 provider 行为，不是机制不确定性。

**结构性证据逐字段一致**：全部 session seq、shadowed span、replacement seq、rebuild seq/generation、token 计数、逐 cycle store 视图（`read/rev/rows = true/1/1 · true/2/2 · true/3/3 · true/4/4`）、`storeFinal`、`storeQuiesced`、全部判据取值（两次运行的 `criteria` 逐字段相同）。

- 完整逐字段差异清单与两次运行对照：`tmp/determinism-report.txt`
- 第一次运行的 ledger：`tmp/run-a-ledger.json`

#### 已知的时序相关项（不是判据的一部分）

生产 task-state worker 在 cycle 4 的 threshold commit 之后还会跑一个 **trailing 波次**。本 fixture 用即时 fake LLM 连续驱动 step、几乎没有空闲时间，因此该 trailing 波次是否在 teardown 之前完成提交是**时序相关**的：同一 spec 版本的 11 次独立运行中共观察到两种取值 —— `storeFinal.stableRevision = 4`（8 次）与 `5`（3 次），`auditRowCount` 同步为 4/5。

- 该 revision 出现在**全部 4 轮测量之后**；
- 其后的 slot 维护只发生在下一次真实 `agent/pre-step`，而本实验不再触发新的 step；
- 因此它**不进入任何 cycle 判据**，也不影响 verdict；
- 每个 cycle 自己观察到的 committed revision 在全部运行中恒为 `1, 2, 3, 4`。

`storeFinalNote` 字段在 ledger 中记录了这一说明。

---

## 8. 限制与边界（诚实边界）

- fixture token ≠ provider token；token 数字来自真实 `dsh-token-meter` 的固定启发式定价（`CHARS_PER_TOKEN = 4`）。
- 未挂载真实 provider；路由被替换为 fake adapter，摘要文本是脚本化常量。因此本实验**不评估摘要质量**，只评估遮蔽/重建机制。
- adapter 声明的 `context.contextWindow` 是 fixture 元数据，不是 provider 事实；本实验的 `compactNow` 路径不读取它。
- 本实验走 **manual `compactNow`（idle-session 路径）**，`auto: false` 使自动压力路径完全不参与；因此**不评估**自动压力阈值、forget/tool/recent 分区几何或 `maxPressureBatches` 批量策略。
- fixture 不产生 tool-call/tool-result，因此 tool-pairing 检查恒为 trivially balanced；retained-tail 检查只覆盖「压缩后每个 cut 平衡」+「压缩前最后一个 surface 节点在压缩后仍是最后一个节点」。
- ledger 的 `plannedRange` 由生产只读 planner 复算，用于证明规划阶段就已包含 slot；它不驱动任何东西，真实 span 来自 `compactNow` 返回值与 surface replacement 事件。
- 重建路径（无可见 slot 分支）提交的 slot 不带 `previousRevision`/`previousGeneration`（被遮蔽的前驱在 surface 上已不可见，生产实现不发 lineage 指针），因此 lineage 单调性只由 generation 与 log 内最高 generation 体现。
- 本 fixture 不 dispose 整个 cordis Context（该 cordis 版本的根 fiber 没有全局 stop，`root.dispose()` 实为 restart）。测试结束前会给后台 task-state 波次一个 4 s 静默窗口（`storeQuiesced`），但生产 worker 的 trailing 波次是否在 teardown 前提交仍是时序相关的（见 §7.3 末）；这不影响任何 cycle 判据。
- 已修复的 `routeWorked` 语义意味着：**engine 不可用或 0 次可观测 compaction ⇒ `inconclusive`**，此时不会声称任何结论。
- "通过"只表示 fixture 断言通过，且只回答本文件第 1 节那一个问题。
