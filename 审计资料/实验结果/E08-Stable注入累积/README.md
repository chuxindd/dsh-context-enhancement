# E08 · Stable 注入累积（连续 revision 后，旧快照是 append 累积还是被固定槽位/replacement 替换？）

> 实验问题（唯一）：连续生成多个内容不同的 Stable Task State revision，并在**每次 revision 之后执行一次 prompt assembly/step**，旧 Stable 快照是否通过 runtime context 追加持续累积，还是被固定槽位/replacement 替换？
>
> 判定（协议实验前固定）：**`reproduced`** —— 至少 10 个内容不同的 revision 后，旧快照（a）仍在 Session surface 上可见，（b）仍出现在**之后每一次 step 的模型可见请求**里，（c）注入节点数 / 字节 / token-meter 归因随 revision 数持续增长，且（d）**没有任何 replacement 操作覆盖过旧快照**，同时（e）持久 stable store 里仍然只有**一份最新**记录。只证明 renderer 文本变化、不证明旧文本确实被再次注入，不得标 `reproduced`。
>
> 层级：L2（真实 TaskStateBasicService + 真实 prompt consumer + 真实 assembly/render + 真实持久 storage domain + 真实 DSH AgentLoop；仅 LLM 为 fake）。
> 基线：插件 `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`（实验前后一致），DSH `a66e4702047846cdaa10c66c9d3df3951f5ea70d`（= `a66e4702`，由 DSH checkout 的 `.git` 只读读出并记入 ledger），342/342 核心文件 SHA-256 一致，`git status --short` 前后逐行一致（134 行）。

---

## 1. 准确命令

```bash
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E08-Stable注入累积/e08-stable-injection.spec.ts --reporter=verbose
```

`vitest-output.txt` = 最终交付运行（exit 0）；`vitest-output-run1.txt` = 同代码确定性复跑（同样 1 passed）。两次原始输出：

```text
 ✓ 审计资料/实验结果/E08-Stable注入累积/e08-stable-injection.spec.ts > E08 · stable injection accumulation (append vs fixed slot/replacement) > commits 12 content-different revisions with one real step each and reports whether old snapshots stay model-visible 800ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  1.41s (transform 390ms, setup 0ms, import 431ms, tests 801ms, environment 0ms)
```

（复跑：657 ms / 1 passed。本 spec 每一对可比复跑账本中，逐 revision 的节点数 / 字节 / token 归因完全一致；`logEvents` 的差异仅等于同期被去掉的 `usage` chunk 数。）

## 2. 产物清单

| 文件 | 内容 |
| --- | --- |
| `e08-stable-injection.spec.ts` | 本实验唯一 spec（1 个用例，12 次 revision × 1 次真实 step） |
| `e08-ledger.json` | 逐 revision 原始账本（约 1.04 MB）：seed/commit/assembly/surface/模型请求逐消息/token-meter/store/累计，含 criteria 与 verdict |
| `vitest-output.txt` / `vitest-output-run1.txt` | vitest 原始 verbose 输出（最终运行 + 确定性复跑） |
| `tmp-storage/context_enhancement_task_state.json` | 真实 storage domain 落盘文档（**72 021 B**）：`sessions` 表 1 条 session 记录 / 1 份 stable（revision 12 / cursor 384）+ `audit` 表 **12** 行（每次 commit 一行） |
| `hash-check-before.json` / `hash-check-after.json` | 342 个核心文件 SHA-256 核对（`E-baseline-hashes.json`），前后 mismatch = 0 |
| `git-head-before.txt` / `git-head-after.txt` / `git-status-before.txt` / `git-status-after.txt` | 执行前后 HEAD 与 `git status --short`（逐行一致） |
| `artifact-hashes.json` | 本目录产物自身 SHA-256 |

`e08-ledger.json` 同时充当 token ledger：每次 revision 的注入节点 token 归因与该 step 的 `surfaceTokens` 都在其中。

## 3. fixture：装配了什么（real / fake 边界）

```text
LlmRuntime · SessionStore · SessionProjectionRegistry · SystemPrompt(persona:'')
ToolRuntime · TokenMeter · AgentRegistry
Storage + StorageJson{root: <E08>/tmp-storage} + StorageDomain{backend:'json'}   ← 真实持久域
ctx.plugin(TaskStateBasicService, 部署配置)        ← 真实 provider（worker/filter/batch/校验/权威 put/audit）
ctx.plugin(dsh-context-enhancement/task-state-prompt, {maxBytes: 8000})           ← 真实 prompt consumer
ctx.plugin(AgentLoop, {agents: []})                ← 真实 DSH agent loop（见下）
ctx.llm.registerAdapter(['deepseek-official'], <scripted fake adapter>)
```

- **REAL**：`TaskStateBasicService`（生产调度、单飞、批折叠、prompt frame、候选校验、权威 put、audit 行、committed 指针）；插件自己的 `task-state-prompt` 消费者（`ctx.systemPrompt.context({name:'task-state:snapshot', order:125, text:'{{task_state_snapshot}}'})` + 同名变量）；`renderTaskStateSnapshot` / `renderContextSnapshot` / `systemPrompt.assemble()`；真实持久 storage domain（落在本 E08 目录内，可回读磁盘比对 store 与 surface）；`SessionStore`/`SystemPrompt`/`ToolRuntime`/`AgentRegistry`/`SessionProjectionRegistry`/`LlmRuntime`/`TokenMeter`。
- **REAL DSH AgentLoop @0.1.2-rc.1**：从被审计的 DSH checkout（HEAD `a66e4702`）构建产物 `packages/core/agent-loop/lib/index.js` 以**原生 ESM `import()`（vite-ignore 的绝对 file URL）**载入，sha256 = `a9142d46163d961ed5774ad544cb997da2197fefca5684ec820060dd50c1c935`；其 `src/agent.ts` / `src/runtime-context.ts` 的 sha256 与读取到的 DSH HEAD 一并记在 `ledger.components.agentLoop`。本工作区**没有**该包的任何文件被复制、改写或加入 `package.json`：它只是被读入内存。该 loop 经 `ctx.sessions.prepare/create` 创建 Session，因此 provider 的 `session/created` 观察者照常为其挂 worker。
- **FAKE**：唯一 LLM 是脚本化 `LlmAdapter`，注册在部署 route（`deepseek-official` / `deepseek-v4-flash`）上。它按 `purpose` 分流：`purpose:'task-state'` → 结构合法候选 JSON（内容含每次调用唯一标记 `E08-CALL-n-THROUGH-SEQ-m`，故每次 commit 内容不同）；其余（agent loop 请求）→ 一段文本，无 tool call，因此每个 turn 恰好 **1 个 step**。它**刻意不产出 `usage` 块**，所以没有任何 provider token 数字进入 token-meter 的 baseline 锚点（ledger 中 `baselineKind = "estimated"`）；它把每个请求的 messages 逐条记录（role / source.kind / source.plugin / source.form / sections / revision header / 字节数 / 文本 hash / 是否 runtime-context 快照）。
- 每轮 revision 的驱动：先 append 20 个内容不同的人类 `user/message`（部署阈值 `minEvents = 20`，故恰好跨阈值一次 → 生产 `session/event` 观察者调度一次 wave → 一次 commit，ledger `taskStateModelCalls = 1`），再执行一次真实 step：`agent.followup(...)` → `preStep`（`systemPrompt.assemble` → `RuntimeContextProjection.project` → 若文本变化则在 `turn()` 中 `session.append('user/message', message, {surfaceOp:'append'})`）→ 用 `session.deriveMessages()` 组请求 → fake adapter 应答 → turn 结束。

> 该 spec **不修改**生产 `src/`、现有 `tests/`、任何 harness、`package.json`、`vitest.config.ts`、`lib`、tgz 或其他实验目录；不复制既有 harness；不使用真实 `$HOME/.dsh`、不访问现有会话、不占用 8080、不启动 Web/多实例；全部产物只写在 `审计资料/实验结果/E08-Stable注入累积/`。

## 4. 逐 revision ledger（12 行，取自最终运行）

列含义：`rev` = 本次 step 之前已提交的 stable revision；`cursor` = 其 `sourceCursor`；`注入节点` = surface 上可见的 runtime-context 快照节点数（`source.kind='plugin' && plugin='@deepseek-ai/dsh-system-prompt'`，全部 `surfaceOp = append`、`source.form = 'snapshot'`、`sections = ['task-state:snapshot']`）；`surface/log` = `session.surface.nodes` / `session.snapshotEvents()` 节点数；`请求消息/快照` = 该 step 模型可见请求的消息总数 / 其中 runtime-context 快照条数；`注入字节` = 请求中全部快照文本字节；`注入 token` = 真实 token-meter 对**可见快照节点 seq** 的定价之和；`store` = 磁盘 domain 文档中该 session 的 stable revision；`旧快照仍可见` = 上一 revision 的快照节点是否仍在 surface 上。

| rev | cursor | 注入节点 | surface/log | 请求消息/快照 | 注入字节 | 注入 token | 请求中 revision header | replacement | store | 旧快照仍可见 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 19 | 1 | 23 / 35 | 22 / 1 | 673 | 177 | `[1]` | 0 | 1 | –（无旧快照） |
| 2 | 54 | 2 | 46 / 68 | 45 / 2 | 1 346 | 354 | `[1,2]` | 0 | 2 | ✅ |
| 3 | 87 | 3 | 69 / 101 | 68 / 3 | 2 019 | 531 | `[1,2,3]` | 0 | 3 | ✅ |
| 4 | 120 | 4 | 92 / 134 | 91 / 4 | 2 699 | 709 | `[1..4]` | 0 | 4 | ✅ |
| 5 | 153 | 5 | 115 / 167 | 114 / 5 | 3 379 | 887 | `[1..5]` | 0 | 5 | ✅ |
| 6 | 186 | 6 | 138 / 200 | 137 / 6 | 4 059 | 1 065 | `[1..6]` | 0 | 6 | ✅ |
| 7 | 219 | 7 | 161 / 233 | 160 / 7 | 4 739 | 1 243 | `[1..7]` | 0 | 7 | ✅ |
| 8 | 252 | 8 | 184 / 266 | 183 / 8 | 5 419 | 1 421 | `[1..8]` | 0 | 8 | ✅ |
| 9 | 285 | 9 | 207 / 299 | 206 / 9 | 6 099 | 1 599 | `[1..9]` | 0 | 9 | ✅ |
| 10 | 318 | 10 | 230 / 332 | 229 / 10 | 6 785 | 1 779 | `[1..10]` | 0 | 10 | ✅ |
| 11 | 351 | 11 | 253 / 365 | 252 / 11 | 7 471 | 1 959 | `[1..11]` | 0 | 11 | ✅ |
| 12 | 384 | 12 | 276 / 398 | 275 / 12 | 8 157 | 2 139 | `[1..12]` | 0 | 12 | ✅ |

补充观测（同一账本内）：

- **快照节点 seq**：25, 61, 95, 129, 163, 197, 231, 265, 299, 333, 367, 390（每轮 +34 左右），全部 `visibleOnSurface = true`、`surfaceOp = append`、`source.form = 'snapshot'`、`sourceSectionNames = ['task-state:snapshot']`。
- **1:1 hash 对应**：每个 step 的模型请求中快照消息的文本 hash 集合与 surface 可见快照节点的文本 hash 集合**逐次完全相同**（`modelRequestHashesMatchVisibleNodes = true`，12/12 轮）⇒ 请求里就是这些节点本身，不是"renderer 又能渲染出别的文本"。
- **token-meter 归因**：rev 12 时 `nodeCount 276`、`surfaceTokens 9 378`、`totalTokens 9 394`、`injectionNodeCount 12`、`injectionTokens 2 139`（节点启发式定价之和）。注入占 `surfaceTokens` 约 **22.8%**。
- **assembly 层**：每次 assembly 的 `contexts` 中名为 `task-state:snapshot` 的贡献条目 **恰好 1 个**，其渲染值只含**当前** revision（`renderedRevisionHeaders` = `[rev]`，12 轮均如此），单次渲染 **673–686 B**（预算 8 000 B，远未触及截断）。assembly 条目对外只暴露 `{name, text}` 两个字段（`order` 未在 assembly 输出中暴露，见第 8 节）。
- **store 与 surface 的分离**：磁盘 domain 文档中该 session 始终只有 **1 份 stable 记录**（revision 1→12 覆盖式更新，`stableRecordCountForSession = 1`），audit 表随 revision 增长到 12 行；而 surface 上的注入节点从 1 增长到 12。**"store 只有最新一份"与"模型可见面在累积"两者同时成立、互不矛盾。**

## 5. 判定与证据

| 判据 | 观测 | 结果 |
| --- | --- | --- |
| ≥ 10 个内容不同的 revision | 12 个 revision（1..12），每次 commit 的候选内容都带唯一标记 `E08-CALL-n-THROUGH-SEQ-m`，digest 各不相同 | ✅ |
| 每个 revision 后执行一次真实 assembly/step | 每轮 1 次 `agent.followup` → 1 次 `preStep`（真实 `assemble` + 真实 `project`）→ 1 次模型请求 → turn 结束；`stepAgentRequests = 1` | ✅ |
| 旧快照仍在 surface 可见 | 可见注入节点数 = 1,2,…,12（= revision 数），`previousSnapshotSeqStillVisible = true`（2..12 轮），无一次消失 | ✅ |
| 旧文本**被再次注入**（关键，非仅 renderer 变化） | 第 k 次 step 的模型请求含 k 条快照消息，revision header 为 `[1..k]`，且与可见节点文本 hash 1:1 相同 | ✅ |
| 无 replacement / 无固定槽位替换 | 12 轮 `replacementEvents = 0`、`surfaceReplaceGeneration = 0`；surface 节点来源种类只有 `user/message:original` 与 `assistant/message:original`（无 `replacement:*`） | ✅ |
| 累计注入成本持续增长 | 注入节点 1→12；注入字节 673→8 157 B；token-meter 归因 177→2 139 token，单调递增 | ✅ |
| store 与 surface 分离 | store 始终 1 份最新 stable（revision 12 / cursor 384）；同刻 surface 上有 12 个快照节点 | ✅ |

```text
verdict = reproduced
连续 12 个内容不同的 stable revision，每次 revision 后执行一次真实 assembly/step：
旧快照既留在 Session surface 上，也留在之后每一次模型可见请求里（revision header 1..k、文本 hash 1:1 对应），
注入节点数/字节/token 归因线性增长（约 680 B / 约 178 token 每条），
且没有任何 replacement 覆盖旧节点，同时 store 里始终只有最新一份。
```

**两层结论（回答"追加累积 vs 固定槽位/replacement 替换"时必须分开说）：**

1. **assembly 层是固定槽位**：`task-state:snapshot` 只有一个贡献条目，每次 assembly 只渲染**当前** stable（rev 12 的 assembly 渲染值只含 revision 12）。所以注入量**不是**靠一次 assembly 里塞多份快照增长的。
2. **runtime-context / surface 层是追加累积，没有任何 replacement**：DSH `RuntimeContextProjection` 在文本变化时产出一条新 `user/message`，`ReactLoopAgent.turn()` 用 `{surfaceOp:'append'}` 追加它，旧节点不被覆盖（`replaceGeneration = 0`，`replacementEvents = 0`），因此模型请求里的快照条数从 1 单调涨到 12。**"固定槽位"只存在于 assembly 的贡献注册处，没有落到 session 节点管理上**——这正是 §3.13 要求"用 replacement 替换上一个注入节点"在实现里没有落点的动态表现（对应静态差异 D1/D2）。

**预算口径的附带结论**：`maxBytes: 8000` 只约束**单次渲染**（实测 673–686 B），不约束累积成本；rev 12 时 12 个节点合计 8 157 B / 2 139 token 已超过单次渲染预算，而账本里的累积项（`I`）不存在（对应 D3/P1）。

## 6. 与静态审计差异的对应

| 静态差异 / 待验证项 | 出处 | 本实验的动态对应 | 一致度 |
| --- | --- | --- | --- |
| **D1** 注入走 runtime context 追加，**无任何 replacement 节点**；§3.13 的"固定槽位 replacement"没有落点 | `审计资料/23-长期状态Worker与注入差异.md` §2 D1（表行 `D1`、§"D1 / D2 注入节点既无 replacement…"） | 12 轮注入节点全部 `surfaceOp = append`；`replacementEvents = 0`、`surfaceReplaceGeneration = 0`；表面节点来源种类无 `replacement:*` | ✅ 动态确认 |
| **D2** "stable 每变一次 = transcript 多一条 full snapshot"，注入体积随 stable 更新次数单调增长，唯一回收通道是主线程压缩 | 同上 §"D1 / D2" | 12 个 revision → 12 条 full snapshot 节点同时可见；注入字节/ token 单调增长；本实验未挂任何压缩插件，故窗口内**零回收** | ✅ 动态确认（累积曲线已量化） |
| **X3（需实验确认）** "同源注入节点累积曲线与回收情况：统计 `source.kind==='plugin' && form==='snapshot'` 的 surface 节点数与 stable 更新次数" | 同上 §5 X3 行、§表行 `X3` | 直接回答：节点数 = revision 数（1..12），每条约 680 B；`source.form = 'snapshot'` 已逐节点记录；window 内无回收 | ✅ 本轮已回答（无压缩稳态） |
| **D3 / P1** 注入没有独立预算 `I`；`maxBytes` 只是单次渲染字节上限 | 同上 §"D3 / P1 注入预算 I 不存在" | 单次渲染 673–686 B < 8 000 B；但 12 节点累计 8 157 B 已越过单次预算，说明预算约束的是"一次渲染"而非"累积注入" | ✅ 动态一致（预算语义已量化） |
| **D3** "token-meter 无按来源分类字段，对账时无法单独读出注入了多少" | 同上 §"D3 / P1"；`调查资料/20-DSH上下文注入与请求预算.md:287` | token-meter 只给 `nodes[].{seq,tokens,heuristicTokens}`；本实验只能**自己按节点 seq 与快照节点集合求交**才能得到 `injectionTokens`（rev 12 = 2 139）——正是"无来源字段"的动态表现 | ✅ 动态一致 |
| **调查资料/20 §10.2** "runtime context 是**文本级 supersede**，不是行级遮蔽：旧快照永远留在 transcript 里累积计费，只有文本完全相同时才不新增" | `调查资料/20-…:280` | 12 轮文本各不相同 → 12 次追加；旧节点全部保留在 surface 与请求中 | ✅ 动态确认 |
| **调查资料/20 §10.1** 唯一"每步一次"的注入窗口是 step 开头的 `system-prompt/assemble` | `调查资料/20-…:279` | 每轮恰好一次 assembly 生效，且该 step 的请求立即带上新快照 | ✅ 动态确认 |
| **D4** 注入节点在来源索引里是 `original`（无 `stable-state-injection` 身份），可被历史摘要折叠 | 同上 §"D4 注入节点在来源索引里没有身份" | 注入节点在**本实验自己的** surface 来源分类里同样是 `user/message:original`（无特殊 op / 无保护标记）；但"可被 history-summary 折叠"这半条**未测**（未挂压缩） | ◐ 部分一致（折叠路径未测） |
| **E-11 / E-13** 注入节点不自反馈（filter 只接受 `source.kind==='user'/'goal'`）；工具操作不处理它 | 同上 §4 表 `E-11`、`E-13` | 与本实验一致但非定向测试：每轮 20 个 seed 才跨阈值，注入快照自身从未把 `taskStateModelCalls` 推高（12 轮均为 1）——与"投影层丢弃 plugin 来源"相符 | ◐ 间接一致（非定向测试） |
| **E-15** 每次 assembly 同步读最新 stable，无插件侧缓存 | 同上 §4 表 `E-15` | 每次 step 的 assembly 渲染值只含**当前** revision，且新快照在同一次 step 的请求里已出现 | ✅ 动态确认 |
| **D5** 渲染文本无 staleness marker | 同上 §"D5 无 staleness marker" | 渲染值只有 `revision / source event / digest` 三字段，未出现任何"落后/陈旧"标记；本实验未构造落后场景，故只作一致性观察 | ◐ 一致性观察 |
| **X4（需实验确认）** 注入体积对三区边界/压力口径的漂移 | 同上 §5 X4 行 | 本实验给出输入量级（rev 12：注入 2 139 / surface 9 378 token），**边界漂移本身未测**（未挂压缩） | ◻ 未测（仅量级） |

## 7. fake 与实验设计限制

1. **fake LLM**：唯一模型是脚本化 adapter（task-state 请求返回固定结构候选 JSON，agent 请求返回一段文本）。它**不产出 `usage`**，因此 provider token、真实计费量、真实摘要语义都不存在；账本里的 token 全部来自真实 `dsh-token-meter` 的**固定启发式定价**（`baselineKind = "estimated"`），不是 provider 计量。
2. **route 被替换**：部署 route（`deepseek-official` / `deepseek-v4-flash`）下注册的是 fake adapter，不是真实 provider。
3. **AgentLoop 的载入方式**：`@deepseek-ai/dsh-agent-loop@0.1.2-rc.1` 不在本工作区依赖里；本实验以原生 `import()` 读入被审计 DSH checkout（HEAD `a66e4702`）的 `packages/core/agent-loop/lib/index.js`（sha256 见第 3 节与 ledger）。它由该 checkout 自身解析依赖；本工作区未新增/复制该包的任何文件。若该 sha256 与审计基线不符，本实验的 surface 层证据不成立（**这是本实验最强的前置假设**）。
4. **12 轮 / 单 Session / 单 route**：未测真实会话的 revision 频率与节奏；fixture 的 20 个人类 seed 事件是 fixture 造出来的（真实会话中来自人类与模型），它们同时抬高了 `surfaceTokens` 基线——因此**不要**把本实验的 `注入/surfaceTokens ≈ 22.8%` 当成真实会话占比；可迁移的是**注入侧的绝对量级**（每条约 680 B / 约 178 token，随 revision 线性累加）。
5. **window 内零回收**：本实验**没有挂载任何压缩插件**（DSH 官方 `compaction` / 本 bundle 的 `compaction-basic`），所以测到的是"无压缩介入时的注入累积稳态"，**不是**"压缩之后还残留多少"。旧节点被 history-summary 折叠的比例（D4 的第二半、X4）仍未测。
6. **每轮恰好一次 commit 依赖 `minEvents = 20`**：20 个 seed 恰好跨阈值一次；这是生产最小值以上的部署配置值（`cordis.patch.yml` 的 20/200/50/4000/40 全部照抄）。若真实部署阈值更高，每轮到达 commit 的节奏不同，但**每次文本变化的注入都是 append**这一机制不受影响。
7. **12 是下限而非上限**：11 轮的线性外推（约 680 B / 178 token 每轮）是**观测区间内的拟合**，不是对无限轮次的外推担保；未测 100 轮量级。
8. **收益不到 1 秒的 fixture 不代表生产时延**：storage/LLM 都是本地即时返回；本实验不测量任何时延、调度抖动或真实存储竞争。
9. **"通过"只表示 fixture 断言通过**，不代表理想方案通过，也不代表用户现象存在或不存在；本实验只回答第 1 节那一个问题，且只覆盖 runtime-context 注入链路的单一分支（`form = 'snapshot'` 的 `user/message`）。

## 8. 未观测字段

| 未观测字段 | 原因 / 现状 |
| --- | --- |
| provider token、计费量、真实 usage 锚点 | adapter 不产出 `usage`；`tokenMeter.baselineKind = "estimated"` |
| 真实模型的摘要语义 | candidate JSON 是 fixture 固定结构，只保证结构合法 |
| `assembly.contexts[]` 的 `order` | assembly 输出条目只暴露 `{name, text}`（`contributionFieldsExposedByAssembly = ["name","text"]`），故 `order = 125` 只能引注册源码（`src/task-state-prompt.ts:61`），本实验无法从 assembly 输出侧确认 |
| 压缩后的回收比例（D4 第二半 / X4） | 未挂载 compaction；`replacementEvents = 0` 是本 window 的事实，不是"永不发生" |
| 三区边界/压力口径的漂移 | 需要压缩链路参与，本轮未测（只给了注入 token 绝对量级） |
| 真实会话的 revision 频率、fork/resume、多实例、多 Session | 全部未测（属 E09/E10 范围） |
| 注入节点在真实 GUI 轨迹/账本里的呈现 | 未启动 Web/GUI，未读取任何真实会话 |

## 9. sourceDrift

```text
执行前：342/342 核心 src/lib/tests/package.json/vitest.config.ts/tgz SHA-256 与 E-baseline-hashes.json 一致（mismatch = 0，missing = 0）
执行后：342/342 一致（mismatch = 0，missing = 0）
git status --short：执行前后逐行完全相同（134 行）
git HEAD：前后同为 cf034b4bce6141bb95b590f5ed7fa66f8727daa2
DSH checkout HEAD（只读读出）：a66e4702047846cdaa10c66c9d3df3951f5ea70d = a66e4702
本次新增文件全部位于 审计资料/实验结果/E08-Stable注入累积/（审计资料 目录不在 342 文件基线内，且整体为未跟踪目录，故 git status 行未变化）
```

`sourceDrift = false`。未修改生产源码、现有 tests、任何既有 harness、`package.json`、`vitest.config.ts`、`lib`、tgz 或 E01–E07/E09–E10 任何文件；未构建、未安装、未启动 DSH/GUI；未访问真实 `$HOME/.dsh` 或任何现有会话；未占用 `127.0.0.1:8080`；未启动多进程；DSH checkout 只被读取（`lib/index.js` 与 `src/agent.ts`/`src/runtime-context.ts` 的 sha256 记入 ledger）。

### 关于本实验自身的失败运行

本次交付**没有红色运行**：首次运行即通过。过程中对 spec 做过三次证据加强（① 去掉 adapter 的合成 `usage` 块，避免 fixture token 进入 baseline 锚点；② 增加逐节点详情与"请求快照 hash ↔ surface 节点 hash"1:1 交叉校验；③ 记录 `source.form` / `sections` 来源字段），每次加强后都重跑并与加强前的逐 revision 数值逐项核对一致（节点数、字节、token 归因完全一致；`logEvents` 的差别仅等于被去掉的 `usage` chunk 数，属预期）。所有加强都只发生在本目录的 spec 内，未触碰任何生产文件。
