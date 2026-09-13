# B5.1 · Stable 注入固定槽位（E08 修复后回归）

> 实验问题（唯一）：把模型可见的 Stable Task State 注入从 DSH append-only runtime context 改成**插件自己拥有的固定槽位节点**（B5.1）之后，重复 E08 的同一场景（连续提交多个内容不同的 revision，每个 revision 之后执行一次真实 step），是否（a）每个 step 的模型可见请求里只有**一个** slot 节点、且只呈现**当前** revision；（b）Session surface 上始终只有 1 个可见 slot 节点，旧节点被真实 `surfaceOp.replace` 遮蔽；（c）注入字节 / token-meter 归因**不再随 revision 数增长**；（d）DSH 自己的 runtime-context 快照节点数为 **0**（E08 的累积通道已空）；（e）持久 store 仍然只有最新一份 stable，且日志里没有任何事件被删除。
>
> 判定（运行前固定）：**`fixed`** —— 20 个内容不同的 revision、每个之后恰好一次真实 step：每步请求恰好 1 条 slot 消息且**全请求内**的 revision header 只含当前 revision；surface 可见 slot 节点恒为 1；第 k（≥2）个 slot 节点是对上一节点的 replacement（`sourceEventSeqs = [上一节点]`，start = end = 上一节点，记录 oldRevision/newRevision + digest + generation）；generation 严格递增；注入字节与 token 归因在容差内平坦；store 恒为 1 份最新 stable；DSH runtime-context 快照节点数 = 0；日志包含全部 slot 节点（无删除）。任一条件不成立记 `not-fixed`；fixture/route 未能产出证据记 `inconclusive`。
>
> 层级：L2（真实 `TaskStateBasicService` + 真实 `task-state-prompt` 消费者 + 真实持久 storage domain + **真实 DSH AgentLoop**；仅 LLM 为 fake）。
> 基线：DSH `a66e4702047846cdaa10c66c9d3df3951f5ea70d`（= `a66e4702`，只读读出并记入 ledger）；本插件 `HEAD cf034b4b`（未提交）。与 E08 的 342 文件基线相比有 40 个文件不同：其中 **6 个是 B5.1 本次改动**（5 个 production src + `tests/task-state-prompt.spec.ts`），其余 34 个是 B5.1 **之前**已存在于工作区的 B1–B4 漂移（见第 9 节）。

---

## 1. 准确命令

```bash
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/B5.1-E08修复后回归/b51-e08-regression.spec.ts --reporter=verbose
```

`vitest-output.txt` = 最终交付运行（exit 0）：

```text
 ✓ 审计资料/实验结果/B5.1-E08修复后回归/b51-e08-regression.spec.ts > B5.1 · Stable 注入固定槽位（E08 对照回归） > 20 个 revision × 1 次真实 step：模型可见 slot 恒为 1、只呈现当前 revision、旧节点被 replacement 遮蔽、注入成本平坦 834ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  1.50s (transform 363ms, setup 0ms, import 494ms, tests 836ms, environment 0ms)
```

本 spec 全程确定性（无时间竞态：每次 commit 与每次 step 都由 `waitUntil` / `agent/status` 事件驱动，且有独立 deadline）；重复运行逐 revision 的节点数、字节、token 归因完全一致。

## 2. 产物清单

| 文件 | 内容 |
| --- | --- |
| `b51-e08-regression.spec.ts` | 本实验唯一 spec（1 个用例：20 次 revision × 1 次真实 step） |
| `b51-ledger.json` | 逐 revision 原始账本（约 2.5 MB）：seed/commit/step/slot/runtimeContext/模型请求逐消息/token-meter/sourceIndex/store/累计 + criteria + verdict |
| `vitest-output.txt` | 本 spec 的 vitest 原始 verbose 输出（最终运行，exit 0） |
| `full-suite-output.txt` | 工作区全量 `npx vitest run` 原始输出（507 用例 / 56 文件：506 passed / 1 failed = `tests/artifact-parity.spec.ts` 的既存产物漂移，见 README §9 与 `审计资料/B5.1-实施记录.md` §5.4） |
| `tmp-storage/context_enhancement_task_state_v2.json` | 真实 storage domain 落盘文档（**143 065 B**）：`sessions` 表 1 条 session 记录 / 1 份 stable（revision 20 / cursor 666）+ `audit` 表 **20** 行 |
| `b51-file-hashes.json` | B5.1 触碰的 8 个文件（含本记录）的 SHA-256 / 字节 / 行数 / mtime |
| `hash-check-after.json` | 对 E08 的 `E-baseline-hashes.json`（342 文件）逐文件核对：302 equal / 40 changed / 0 missing，含逐条差异清单 |
| `git-head.txt` / `git-status.txt` | 执行时 HEAD（`cf034b4b…`）与 `git status --short`（171 行） |
| `artifact-hashes.json` | 本目录产物自身 SHA-256（不含本文件自身） |

## 3. fixture：装配了什么（real / fake 边界）

```text
LlmRuntime · SessionStore · SessionProjectionRegistry · SystemPrompt(persona:'')
ToolRuntime · TokenMeter · AgentRegistry
Storage + StorageJson{root: <本目录>/tmp-storage} + StorageDomain{backend:'json'}   ← 真实持久域
ctx.plugin(TaskStateBasicService, 部署配置)                        ← 真实 provider
ctx.plugin(dsh-context-enhancement/task-state-prompt, {maxBytes:8000}) ← 真实消费者（固定槽位）
ctx.plugin(AgentLoop, {agents: []})                                ← 真实 DSH agent loop
ctx.llm.registerAdapter(['deepseek-official'], <scripted fake adapter>)
```

- **REAL**：`TaskStateBasicService`（生产调度、单飞、批折叠、prompt frame、候选校验、权威 put、audit 行、committed 指针）；本插件真实的 `task-state-prompt` 消费者（注册保留模板 `task-state:snapshot` + 同名变量，变量恒为空串；真正的注入走 `agent/pre-step` 上的固定槽位维护）；真实持久 storage domain（落在本目录内，可回读磁盘比对 store 与 surface）；`SessionStore`/`SystemPrompt`/`ToolRuntime`/`AgentRegistry`/`SessionProjectionRegistry`/`LlmRuntime`/`TokenMeter`；真实 token-meter 定价。
- **REAL DSH AgentLoop @0.1.2-rc.1**：从被审计的 DSH checkout（HEAD `a66e4702`）构建产物 `packages/core/agent-loop/lib/index.js` 以**原生 ESM `import()`（vite-ignore 的绝对 file URL）**载入，sha256 = `a9142d46163d961ed5774ad544cb997da2197fefca5684ec820060dd50c1c935`（`src/agent.ts` = `cc14a38d…`，`src/runtime-context.ts` = `ba960f75…`，均记入 `ledger.components.agentLoop`）。本工作区**没有**该包的任何文件被复制、改写或加入 `package.json`。该 loop 经 `ctx.sessions` 创建 Session，因此真实 provider 的 `session/created` 观察者照常为其挂 worker。
- **FAKE**：唯一 LLM 是脚本化 `LlmAdapter`，注册在部署 route（`deepseek-official` / `deepseek-v4-flash`）上。它按 `purpose` 分流：`purpose:'task-state'` → 结构合法候选 JSON（内容含每次调用唯一标记 `B51-CALL-n-THROUGH-SEQ-m`，故每次 commit 内容不同）；其余（agent loop 请求）→ 一段文本，无 tool call，因此每个 turn 恰好 **1 个 step**。它**刻意不产出 `usage` 块**（ledger `baselineKind = "estimated"`），并把每个请求的 messages 逐条记录（role / source.kind / slotId / generation / revision / 字节 / 文本 hash / 文本内全部 revision header）。
- 每轮 revision 的驱动：先 append 20 个内容不同的人类 `user/message`（部署阈值 `minEvents = 20`，恰好跨阈值一次 → 一次 commit，`taskStateModelCalls = 1`），再执行一次真实 step：`agent.followup(...)` → 真实 `preStep`（`systemPrompt.assemble` → `joinContextSections` → `RuntimeContextProjection.project` → `agent/pre-step` waterfall〔新：固定槽位维护〕）→ `session.deriveMessages()` 组请求 → fake adapter 应答 → turn 结束。

> 本 spec **不修改**生产 `src/`、现有 `tests/`、任何 harness、`package.json`、`vitest.config.ts`、`lib`、tgz 或其他实验目录（含 E08）；不复制既有 harness；不使用真实 `$HOME/.dsh`、不访问现有会话、不占用 8080、不启动 Web/多实例；全部产物只写在 `审计资料/实验结果/B5.1-E08修复后回归/`。

## 4. 逐 revision ledger（20 行，取自最终运行）

列含义：`rev` = 本次 step 前已提交的 stable revision；`日志slot节点` = 日志中全部 `source.kind='task-state-slot'` 节点数（= 已发生的 create/replacement 次数）；`surface可见` = 其中仍在 `session.surface.nodes` 上的节点数；`请求slot消息` = 该 step 模型可见请求中 slot 消息条数；`注入字节` = 请求中 slot 消息文本字节；`注入token` = 真实 token-meter 对**可见 slot 节点 seq** 的定价；`请求内revision header` = **该请求全部消息文本**中出现的 revision header 集合；`节点generation` / `节点surfaceOp` / `遮蔽范围` = 最新 slot 节点的 generation、surfaceOp 与被遮蔽的 seq（replacement 的 `sourceEventSeqs`）；`DSH快照节点` = `source.plugin='@deepseek-ai/dsh-system-prompt'` 的 runtime-context 节点数（E08 的累积通道）；`store rev` = 磁盘 domain 文档中该 session 的 stable revision。

| rev | 日志slot节点 | surface可见 | 请求slot消息 | 注入字节 | 注入token | 请求内revision header | 节点generation | 节点surfaceOp | 遮蔽范围 | DSH快照节点 | store rev |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1 | 1 | 587 | 155 | `[1]` | 1 | append | – | 0 | 1 |
| 2 | 2 | 1 | 1 | 587 | 155 | `[2]` | 2 | replace | 23 | 0 | 2 |
| 3 | 3 | 1 | 1 | 587 | 155 | `[3]` | 3 | replace | 58 | 0 | 3 |
| 4 | 4 | 1 | 1 | 594 | 157 | `[4]` | 4 | replace | 92 | 0 | 4 |
| 5 | 5 | 1 | 1 | 594 | 157 | `[5]` | 5 | replace | 126 | 0 | 5 |
| 6 | 6 | 1 | 1 | 594 | 157 | `[6]` | 6 | replace | 160 | 0 | 6 |
| 7 | 7 | 1 | 1 | 594 | 157 | `[7]` | 7 | replace | 194 | 0 | 7 |
| 8 | 8 | 1 | 1 | 594 | 157 | `[8]` | 8 | replace | 228 | 0 | 8 |
| 9 | 9 | 1 | 1 | 594 | 157 | `[9]` | 9 | replace | 262 | 0 | 9 |
| 10 | 10 | 1 | 1 | 600 | 158 | `[10]` | 10 | replace | 296 | 0 | 10 |
| 11 | 11 | 1 | 1 | 600 | 158 | `[11]` | 11 | replace | 330 | 0 | 11 |
| 12 | 12 | 1 | 1 | 600 | 158 | `[12]` | 12 | replace | 364 | 0 | 12 |
| 13 | 13 | 1 | 1 | 600 | 158 | `[13]` | 13 | replace | 398 | 0 | 13 |
| 14 | 14 | 1 | 1 | 600 | 158 | `[14]` | 14 | replace | 432 | 0 | 14 |
| 15 | 15 | 1 | 1 | 600 | 158 | `[15]` | 15 | replace | 466 | 0 | 15 |
| 16 | 16 | 1 | 1 | 600 | 158 | `[16]` | 16 | replace | 500 | 0 | 16 |
| 17 | 17 | 1 | 1 | 600 | 158 | `[17]` | 17 | replace | 534 | 0 | 17 |
| 18 | 18 | 1 | 1 | 600 | 158 | `[18]` | 18 | replace | 568 | 0 | 18 |
| 19 | 19 | 1 | 1 | 600 | 158 | `[19]` | 19 | replace | 602 | 0 | 19 |
| 20 | 20 | 1 | 1 | 600 | 158 | `[20]` | 20 | replace | 636 | 0 | 20 |

补充观测（同一账本内）：

- **最终状态**：日志 681 事件 / surface 441 节点；`surface.replaceGeneration = 19`；可见 slot 节点 seq = 670（字节 600）；其 `generation = 20`、`coveredSeqs = [636]`（= 第 19 个节点 seq）、digest 前 16 位 `1d55e5da7ae4ed8a`；第 19 个节点 `visibleOnSurface = false` 但**仍在日志里**（`previousNodeStillInLog = true`）⇒ 没有删除任何原始事实，只是被遮蔽。
- **replacement 全部由本插件产生**：19 个 replacement 事件中 `isSlot = true` 的有 19 个、非 slot 的有 0 个。
- **assembly 层**：保留模板 `task-state:snapshot` 仍注册（`assembly.contexts` 中仍有该条目），但 20 轮 `assemblyRenderedBytes = 0` ⇒ DSH 的 `RuntimeContextProjection.project('')` 从不产出节点，`DSH快照节点 = 0`（20/20 轮）。
- **token 归因**：注入 token 155→158（最大-最小 = 3，容差 = max(24, 15.5)）；注入字节 587→600（最大-最小 = 13，容差 = max(64, 58.7)）。字节的 13 B 波动来自候选标记里的数字位数（`B51-CALL-10…` 比 `B51-CALL-1…` 长），**不是**随 revision 线性增长。
- **来源索引分类**（第 20 轮实测）：可见 slot 节点的 `entry(seq).kind = 'task-state-slot'`、`replacementCoverage(seq) = { kind: 'task-state-slot', coveredSeqs: [636] }`；该节点已在 20 个 turn 之后，故 `canCompactHistory(seq, 1)` 与 `canCompactHistory(seq, 1, true)` 均为 true（年龄规则照常适用于**已知 replacement**）。更强的分类断言（`original` 与 `unknown-replacement` 的区别、`allowImmediateReentry` 不放宽本类型）由 `tests/task-state-prompt-fixed-slot.spec.ts` 承担。

## 5. 判定与证据

| 判据 | 观测 | 结果 |
| --- | --- | --- |
| 20 个内容不同的 revision | 20 个 revision（1..20），每次 commit 的候选都带唯一标记 `B51-CALL-n-THROUGH-SEQ-m`，digest 各不相同 | ✅ |
| 每个 revision 后一次真实 step | 每轮 1 次 `agent.followup` → 1 次真实 `preStep`（真实 assemble + 真实 project + 真实 AgentLoop）→ 1 次模型请求 → turn 结束；`agentRequestsThisIteration = 1` | ✅ |
| 每步请求恰好 1 条 slot 消息 | `slotMessageCount = 1`（20/20） | ✅ |
| 请求里**只有当前 revision**（不含任何旧 revision） | 请求**全部消息**文本中的 revision header 集合逐轮为 `[k]`，数量恒为 1（`onlyCurrentRevisionAnywhereInRequest = true`） | ✅ |
| surface 可见 slot 节点恒为 1 | `visibleSlotNodes = 1`（20/20），旧节点 `visibleOnSurface = false` | ✅ |
| 第 k 个节点遮蔽第 k-1 个节点 | `replacementCoversPreviousNode = true`（2..20 轮）：`surfaceOp = replace`、`coveredSeqs = [上一节点]`、`previousRevision/previousGeneration` 与上一节点一致、`generation = 上一代 + 1` | ✅ |
| generation 严格递增 1..20 | `generations = [1..20]`，无重复、无回退（含 fork/resume 单调性由单元 spec 覆盖） | ✅ |
| 注入成本不再增长 | 注入字节 587→600（Δ13 B / 容差 ≥58.7）、token 155→158（Δ3 / 容差 ≥15.5）；对照 E08 的 673→8 157 B / 177→2 139 token | ✅ |
| DSH runtime-context 通道为空 | `DSH快照节点 = 0`、`assemblyRenderedBytes = 0`（20/20） | ✅ |
| store 仍只有最新一份 stable | 磁盘 domain 文档：该 session **1** 份 stable 记录、revision 20、cursor 666；audit 表 **20** 行 | ✅ |
| 没有删除任何原始事实 | 日志含全部 20 个 slot 节点；被遮蔽节点仍在日志中（`previousNodeStillInLog = true`） | ✅ |

```text
verdict = fixed
20 个内容不同的 stable revision，每个之后恰好一次真实 step：
每步模型可见请求里恰好 1 条 Stable task-state slot 消息，且全请求内只出现当前 revision 的 header；
Session surface 上恒为 1 个可见 slot 节点，旧节点被一次真实 surfaceOp.replace 遮蔽（记录 oldRevision/newRevision、coveredSeqs、digest、generation，generation 严格递增）；
注入字节 587→600、token 归因 155→158（容差内平坦）；
DSH 自己的 runtime-context 快照节点数为 0（E08 的累积通道已空）；
持久 store 仍只有最新一份 stable（revision 20 / cursor 666 / 20 行 audit），日志中没有任何事件被删除。
```

## 6. 与 E08 的对照

同一场景（内容不同的 revision × 每个之后一次真实 step × 同一真实 AgentLoop / provider / 部署配置）下的前后对照：

| 观测 | E08（修复前，12 revision） | B5.1（修复后，20 revision） |
| --- | --- | --- |
| 注入通道 | DSH runtime-context 投影追加的 `user/message`（`source.plugin='@deepseek-ai/dsh-system-prompt'`） | 插件自己的固定槽位节点（`source.kind='task-state-slot'`） |
| 可见注入节点数 | 1,2,…,12（= revision 数） | **1**（恒定） |
| 请求中的快照/ slot 条数 | 1,2,…,12 | **1**（恒定） |
| 请求中的 revision header | `[1]`, `[1,2]`, …, `[1..12]` | `[k]`（只含当前） |
| surfaceOp | 全部 `append`（`replacementEvents = 0`、`replaceGeneration = 0`） | 首个 `append`，其后每轮一次 `replace`（19 次，`replaceGeneration = 19`） |
| 注入字节 | 673 → 8 157（线性） | 587 → 600（平坦） |
| 注入 token 归因 | 177 → 2 139（线性，占 surfaceTokens ≈22.8%） | 155 → 158（平坦） |
| DSH runtime-context 节点 | 12（旧快照仍留在请求里） | **0** |
| 持久 store | 1 份最新 stable（revision 12 / cursor 384）+ 12 行 audit | 1 份最新 stable（revision 20 / cursor 666）+ 20 行 audit |
| 旧节点 | 仍在 surface 与请求里 | 仍在**日志**里，但不在 surface、不在请求里 |

**可迁移的是形状，不是逐字节数值**：两次实验的 revision 数（12 vs 20）、seed 文本、domain 文件名（`…_task_state.json` vs `…_task_state_v2.json`，B4 clean-break）、以及被观测节点的来源种类都不同（E08 观测 DSH 快照节点，本实验观测插件 slot 节点）。因此第 5 节的字节/token 数字**不应**与 E08 的数字逐位对齐；可对齐且已被本实验直接证伪的是 E08 的两条机制性观测：*节点数 = revision 数* 与 *注入成本随 revision 线性增长*。

**本实验没有重新运行 E08 自己的 spec**：E08 的 spec 会 `rmSync` + 覆写它自己目录里的 `tmp-storage/` 与 `e08-ledger.json`，属于对历史证据的破坏性重跑。E08 目录在本轮保持**只读**（其文件哈希未纳入本轮改写；本轮新增文件全部位于本目录内）。

## 7. 限制

1. **fake LLM**：唯一模型是脚本化 adapter（task-state 请求 → 固定结构候选 JSON，内容每次不同；agent 请求 → 一段文本）。它不产出 `usage`，因此 provider token、真实计费量、真实摘要语义均未测量；账本里的 token 全部来自真实 `dsh-token-meter` 的固定启发式定价（`baselineKind = "estimated"`）。
2. **route 被替换**：部署 route（`deepseek-official` / `deepseek-v4-flash`）下注册的是 fake adapter，不是真实 provider。
3. **AgentLoop 的载入方式**：`@deepseek-ai/dsh-agent-loop@0.1.2-rc.1` 不在本工作区依赖里；本实验以原生 `import()` 读入被审计 DSH checkout（HEAD `a66e4702`）的 `packages/core/agent-loop/lib/index.js`（sha256 见第 3 节与 ledger）。若该 sha256 与审计基线不符，本实验的 surface 层证据不成立。
4. **未挂压缩**：因此没有测“压缩遮蔽 slot 后重建”的真实端到端路径（该路径由 `tests/task-state-prompt-fixed-slot.spec.ts` 用真实 `surfaceOp.replace` 遮蔽槽位来覆盖），也没有测 X4 边界漂移与回收比例（属 B5.2 范围）。
5. **每轮恰好一次 commit 依赖 `minEvents = 20`**：20 个 seed 恰好跨阈值一次；这是生产最小值以上的部署配置值。真实会话的 revision 频率与节奏不同，但“每次文本变化都是一次 replacement”的机制不受影响。
6. **20 是下限而非上限**：本实验只观察到 20 轮；未测 100/1000 轮量级，也未测多 Session / 多实例（属 E10 范围）。
7. **注入 token 只统计当前可见 slot 节点**的启发式定价；不含主线程压缩、其他插件注入或真实 provider 计费。
8. **“通过”只表示 fixture 断言通过**，且只回答第 1 节那一个问题；不代表 B5 全部验收通过（B5.2 的独立注入预算 I / X4 compaction 回收、B6/B7/B8 均未做）。

## 8. 未观测字段

| 未观测字段 | 原因 |
| --- | --- |
| provider token / 真实计费 | adapter 不产出 `usage`；`baselineKind = "estimated"` |
| 真实模型摘要语义 | 候选 JSON 是 fixture 固定结构，只保证结构合法 |
| `assembly.contexts[]` 的 `order` | assembly 输出条目只暴露 `{name, text}`（E08 第 8 节同一限制） |
| 压缩后的 slot 回收比例、三区边界漂移 | 未挂 compaction（属 B5.2 / X4） |
| 真实会话的 revision 频率、多实例、GUI 轨迹 | 全部未测 |
| fork / resume 后的槽位身份 | 本实验未测（由 `tests/task-state-prompt-fixed-slot.spec.ts` 的真 fork/真 resume 覆盖） |

## 9. sourceDrift

```text
git HEAD：cf034b4bce6141bb95b590f5ed7fa66f8727daa2（与 E08 基线同一 HEAD；未提交）
git status --short：171 行（见 git-status.txt）
DSH checkout HEAD（只读读出）：a66e4702047846cdaa10c66c9d3df3951f5ea70d = a66e4702
  · packages/core/agent-loop/lib/index.js  sha256 = a9142d46163d961ed5774ad544cb997da2197fefca5684ec820060dd50c1c935
  · packages/core/agent-loop/src/agent.ts          = cc14a38d5cf32003699a9342286b597eccf35cec79740c28552e229ead43b4f8
  · packages/core/agent-loop/src/runtime-context.ts = ba960f755d136e7da6d430ede85948c4c5282b02a8fc5a4a97375ab95e297168
与 E08 的 E-baseline-hashes.json（342 文件）逐文件核对：302 equal / 40 changed / 0 missing（见 hash-check-after.json）
  · 40 个差异文件中，6 个由 B5.1 本次改动造成：
      src/internal/task-state/prompt/index.ts   sha256 b29f424301ac5332…
      src/internal/task-state/contract/index.ts sha256 7aae1df69f88992d…
      src/internal/task-state/contract/types.ts sha256 6f123b081044bb93…
      src/task-state-prompt.ts                  sha256 1f1d41b4f6509948…
      src/internal/compaction/source-index.ts   sha256 216fbd746e855107…
      tests/task-state-prompt.spec.ts           sha256 3eab557892e8c55e…
    （完整 SHA-256 / 字节 / 行数 / mtime 见 b51-file-hashes.json）
  · 其余 34 个文件（如 src/internal/task-state/basic/*、src/internal/compaction/{config,types,zones}.ts、
    多数 tests/task-state-*.spec.ts）在 B5.1 之前就已不同于 E08 基线：它们是本工作区里
    B1–B4 的既有改动（B3 的 post-run 哈希快照与 B1–B4 实施记录可佐证），本步骤**没有**再改动它们。
本次新增文件全部位于 审计资料/实验结果/B5.1-E08修复后回归/ 与 审计资料/B5.1-实施记录.md
（审计资料 目录不在 342 文件基线内，故不影响上述逐文件核对口径）。
```

`sourceDrift = expected-and-recorded`：B5.1 **有意**修改了 5 个 production 源文件（这正是本回归要验证的对象），并同步更新了 1 个既有 spec、新增 1 个 spec 与 1 份实施记录；此外未修改任何既有 harness、`package.json`、`vitest.config.ts`、`lib`、tgz 或 E01–E10 任何历史实验目录（E08 目录保持只读）；未构建、未安装、未启动 DSH/GUI；未访问真实 `$HOME/.dsh` 或任何现有会话；未占用 `127.0.0.1:8080`；未启动多进程；DSH checkout 只被读取。

### 关于本实验自身的失败运行

本实验交付**有一次红色运行**，原因是 fixture 缺陷而非产品缺陷：首版 `readStore()` 硬编码 domain 文件名 `context_enhancement_task_state.json`（E08 时代的名），而 B4 的 clean-break 已把 domain 文件名升为 `context_enhancement_task_state_v2.json`，于是 20 轮 `store.read = false`、`storeHoldsOneLatest = false`、verdict 落 `inconclusive`（机制类判据当轮全部已为 true：可见节点恒 1、请求 slot 消息恒 1、generation 1..20、DSH 快照节点 0、token 155→158）。修复方式是把文件名改为**按目录发现**并把真实文件名记入 ledger；重跑后 verdict = `fixed`，且逐 revision 的既有数值与修复前完全一致。该缺陷只影响本目录 spec 内的 store 读取，未触碰任何生产文件。
