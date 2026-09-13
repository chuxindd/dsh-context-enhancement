# E01 · 工具区预释放（真实 toolGroupAuditStore 下的操作① 与操作② 互斥）

> 实验问题（唯一）：当使用真实临时 storage domain 使 `toolGroupAuditStore` 可用时，40%–70% 工具维护档是否会对合格完整工具组执行工具摘要（操作①），以及该路径是否与工具裁剪（操作②）互斥？
>
> 判定（E01 协议，实验前固定）：**`reproduced`** —— 操作① 真实执行并提交了持久 replacement，且操作② 未处理同一成功组（同时操作② 在工具区其他原始结果上确实活跃）。
>
> 同一实验按方案文档 §5 E01 的**缺陷口径**判定为 **`not-reproduced`**（无「有候选却无 replacement」、无「候选越区」、无「成功摘要又被裁剪」）。两个口径都写进 `result.json` 与 ledger，避免二次解释。
>
> 层级：L1（fake TokenMeter + fake LLM + 临时 Session）+ **真实临时 dsh-storage domain**（位于本 E01 目录内，随机 session id）。
> 基线：插件 `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`（实验前后一致），DSH `a66e4702`，342/342 核心文件 hash 一致，`git status` 前后逐行一致。

---

## 1. 准确命令

```bash
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E01-工具预释放/e01-tool-pre-release.spec.ts --reporter=verbose
```

原始输出：`vitest-output.txt`（最后一次成功运行，exit 0）。

```text
 ✓ 审计资料/实验结果/E01-工具预释放/e01-tool-pre-release.spec.ts > E01 · tool-zone pre-release with a REAL toolGroupAuditStore > runs one 40%–70% tool maintenance and records whether op① commits and stays out of op② 57ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  726ms (tests 59ms)
```

产物：

| 文件 | 内容 |
| --- | --- |
| `e01-tool-pre-release.spec.ts` | 本实验唯一 spec（1 个用例，1 次运行） |
| `e01-ledger.json` | 逐项账本：storage 挂载/审计记录、策略、fixture、运行前后 zones、候选组、摘要请求/输出、replacement、shadowed 源、操作② 调用、判据 |
| `vitest-output.txt` | vitest 原始 verbose 输出 |
| `tmp-storage/context_enhancement_tool_group_summary.json` | 真实 storage domain 落盘的单文档（6352 字节），保留作为持久性证据 |
| `hash-check-before.json` / `hash-check-after.json` | 342 个核心文件 SHA-256 核对（`E-baseline-hashes.json`） |
| `git-status-before.txt` / `git-status-after.txt` / `git-head-before.txt` / `git-head-after.txt` | 执行前后 git 状态与 HEAD |
| `artifact-hashes.json` | 本目录产物自身的 SHA-256 |

## 2. 为什么本实验没有复用共享 harness（要求 1 的边界）

`harness/compaction-harness.ts` **未做任何修改**，但它也**无法按原样复用**到本条路线上，原因是硬编码的：

```ts
toolGroupAuditStore: undefined,
summarizeToolGroups: async () => {},
```

而 `src/compaction-basic.ts` 的门槛是 `if (!this.config.toolGroupSummarizer.enabled || this.toolGroupAuditStore === undefined) return`（`:787`、`:832`）与 `const store = this.toolGroupAuditStore; if (store === undefined) return`（`:1092-1093`）。在共享 harness 之下操作① 永远不可能执行——这正是 E00 阶段评审 §4.2 第 5 条拒绝它的理由，§6 第 5 条要求「应使用临时 storage」。

harness 的 fixture 既未暴露 engine seam，也不接受 store 参数，所以 E01 复用它的**模式**（plain engine object 持有生产 `config` + fake `ctx`，每个生产 seam 经 `BasicCompactionEngine.prototype` 调用），把两个被打了桩的 seam 换成真实实现，全部封装在本 E01 spec 内。按任务纪律，本实验**没有**为了完成任务去改 harness。

另外记录一条实测事实：共享 harness 的 `pruner` 选项用 `createToolResultMessage(...)` 构造 replacement，而该工厂（`dsh-llm` 的 `createMessage`）会铸造**新的 message id**；Session 对 `tool/result` surface replacement 的守卫只允许改变 `content`，因此会抛：

```text
Error: tool/result surface replacement may change only content
```

（本次首次运行直接观测到该错误。）E01 的 fake pruner 因此按两条**生产写入路径**（`src/tool-result-pruner.ts:340-361` 与 `src/internal/compaction/tool-group-replacement.ts`）的方式构造 replacement：`freezeMessage({ ...original, content: reduced })`。

## 3. storage 挂载方式（要求 2）

按 `tests/task-state-restart-recovery.spec.ts` 的挂载顺序，全部落在本 E01 目录内：

```ts
const ctx = new Context()
await ctx.plugin(LlmRuntime)
ctx.llm.registerAdapter(['mock-route'], new ToolGroupSummaryAdapter())
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: '审计资料/实验结果/E01-工具预释放/tmp-storage' })
await ctx.plugin(StorageDomain, { backend: 'json' })
const store = await openToolGroupAuditStore(ctx)   // 真实 store，未伪造
```

结果（`e01-ledger.json` → `storage`）：

- `mounted = true`、`storeOpened = true`、`mountError = null`、`storeError = null`；
- 域 `context_enhancement_tool_group_summary`（version 1，`layout:'single'`）；
- 落盘文件 `tmp-storage/context_enhancement_tool_group_summary.json`，**6352 字节**，`ctx.fiber.dispose()` 之后仍可读出；
- `openToolGroupAuditStore(ctx)` 返回的 store 直接作为 engine seam 的 `toolGroupAuditStore`，`toolGroupAuditStorePromise = Promise.resolve()`；`summarizeToolGroups` 指向**真实** `BasicCompactionEngine.prototype.summarizeToolGroups`。

边界合规：未使用真实 `$HOME/.dsh`、未访问现有会话、未占用 8080、未启动多进程；session id 为 `e01-tool-pre-release-<uuid>`（随机）。

## 4. Fixture（fixture token，**非** provider token）

`contextWindow = 100 000`，生产默认水位：tool 40%（40 000）、forget 70%（70 000）、pressure 80%（80 000）、forget 边界 50%（50 000）、`retainTokens = 20 000`、reserve 8 192 + margin 2 048（信封 `E = 0`）。

| 位置 | 内容 | fixture token |
| --- | --- | --- |
| turn 1（已完成）= **遗忘区** | 5 × assistant/message × 2 000 | 10 000 |
| turn 2（已完成）= **工具区** | 3 个完整工具组 × 4 110 + spacer 2 000/1 000/1 000/13 670 | 30 000 |
| turn 3（已完成）= 近区 | 1 × assistant/message × 12 000 | 12 000 |
| turn 4（**OPEN**）= 近区 | 1 × assistant/message × 8 000 | 8 000 |
| 合计 | | **60 000 = 60.0%** |

- 三个组 A/B/C 各为 `2 ×（assistant/tool-call 55 + tool/result 2 000）= 4 110`：`toolResultTextLength = 16 000 ≥ minGroupChars 12 000`，`estimatedTokens 4 110 ∈ [minGroupTokens 2 000, maxGroupTokens 12 000]`，`2 ≥ minGroupResults 2`，且**整组位于工具区内**。
- `maxGroupsPerPass = 2`（生产默认）→ 操作① 只摘要最旧的两组（A、B），第 3 组 C 保持原始，**这正是让操作② 的排除检验非空转的原因**。
- 近区完整保留当前 turn（turn 4 全部在近区内）。
- fake LLM 只回答工具组摘要请求，输出由请求自身 `INPUT` 载荷导出的结构化 `ToolGroupSummary`（facts 逐字取自来源文本，因此生产 `assertFactsBelongToInput` 真的执行了）。输出 705 字符 = 177 fixture token，对 4 110 token 的组是**严格缩减**。
- 计价规则：fixture 文本码点 / 4（`CHARS_PER_TOKEN = 4`），replacement 节点同样按自身 message 计价（不像共享 harness 那样计 0）。

`e01-ledger.json` → `zonesBefore`：遗忘 10 000（position 0-4）、工具 **30 000**（position 5-20，seq 10-25）、近区 **20 000**、`retainedTailTokens = 20 000`、`summarizerInputCapTokens = 81 117`。

## 5. 账本摘要

（完整机器可读版本见 `e01-ledger.json`；token 单位均为 fixture token。）

### 5.1 调用前后

| 项 | 值 |
| --- | --- |
| 调用 | `BasicCompactionEngine.prototype.compactIfNeeded(engineSeam, agent, 'pressure', signal)` × 1 |
| 档位 | `tool-maintenance-40-70`（60 000 ≥ 40 000 且 < 70 000） |
| 返回值 | `null` |
| 语义历史压缩跨度提交数 | **0** |
| before total / surface | 60 000 / 60 000 |
| after total / surface | **48 568** / 48 568 |
| 净释放 | 11 432（19.05%） |

### 5.2 操作①（工具摘要）

| 组 | sourceSeqs | toolResultSeqs | callIds | estimatedTokens | position | 请求输入 | 请求输出 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 11,12,13,14 | 12,14 | e01-A1,A2 | 4 110 | 6-9 | 17 733 字符 ≈ 4 434 | 705 字符 = 177 |
| B | 16,17,18,19 | 17,19 | e01-B1,B2 | 4 110 | 11-14 | 17 735 字符 ≈ 4 434 | 705 字符 = 177 |

- 两次请求 `purpose = compaction`、`maxTokens = 1 200`、`provider/model = mock-route/mock-model`。
- 落盘 replacement：`33, 35`（组 A）、`37, 39`（组 B）——每组 4 110 → 2 × 42 = 84 fixture token。
- shadowed 源：`12, 14, 17, 19`——由两条独立路径取得且**一致**：真实 audit 记录的 `sourceSeqs` ∩ tool/result，以及操作② 入口处已存在的 `compaction/prune` 事件。
- 真实 audit 记录 **2 条，均为 `status = success`**（`summaryItems = 4`，`error = null`）。
- 4 个 replacement 的 `sourceKind` 均为 **`tool-summary`**（来自真实 store 的 `servedReplacementSeqs`，不是影子价格推断的 `tool-pruned`）——这是「确实是操作① 而非普通裁剪」的关键证据。

### 5.3 操作②（工具裁剪）

| 项 | 值 |
| --- | --- |
| 是否启动 | **是**（1 次 `pruneSession`） |
| 入口时 zones | 遗忘 2 000 / 工具 **30 168** / 近区 20 000（工具区 seq 4-25） |
| `olderRange` | 4-25 |
| 候选集 | **[22, 24]**（第 3 组 C 的原始 tool/result，`candidateSourceKinds` 均为 `tool/result:original`） |
| 候选 ∩ 操作① shadowed 源（12/14/17/19） | **[]** |
| 候选 ∩ 操作① replacement（33/35/37/39） | **[]** |
| 实际裁剪 | 22 → 41、24 → 43（8 000 → 800 字符，`charsRemoved = 14 400`） |
| 结果归类 | 41/43 = `tool-pruned` |

### 5.4 运行后表面来源类型

```text
assistant/text: 11    assistant/tool-call: 6
tool/result:tool-summary: 4（seq 33/35/37/39）    tool/result:tool-pruned: 2（seq 41/43）
```

## 6. 判定

实验前固定的判据（`e01-ledger.json` → `criteria`）：

| 判据 | 结果 |
| --- | --- |
| `op1Executed`（有合格候选且真实发出摘要请求） | `true` |
| `op1CommittedReplacement`（落盘 replacement + 真实 success/open 审计记录） | `true` |
| `storeRealAndDurable`（store 存在且返回记录，磁盘有域文档） | `true` |
| `op2Live`（操作② 确实被调用） | `true` |
| `op2SawOtherToolZoneWork`（操作② 有非空候选，排除非空转） | `true` |
| `op2TouchedOp1Group`（候选/裁剪 ∩ 操作① 成功组） | `[]` |
| `verdictFromCriteria` | **`reproduced`** |

方案文档 §5 E01 的缺陷口径：

| 缺陷条件 | 结果 |
| --- | --- |
| 工具区有合格候选却无 replacement | `false` |
| 候选越区 | `false`（2 个候选组 `fullyInsideToolZone` 均为 true） |
| 成功摘要又被裁剪 | `false`（交集为空） |
| `planSection5Verdict` | **`not-reproduced`** |

**结论**：真实 store 可用时，40%–70% 工具维护档**确实**对合格完整工具组执行操作①（两次真实摘要调用、4 个 replacement、2 条 `success` 审计记录、来源类型 `tool-summary`），并且该操作与操作② **互斥**——操作② 的候选集恰为工具区内尚未摘要的原始结果，与操作① 的成功组完全不相交，同时操作② 在该候选上确实活跃。该档**不提交任何语义历史压缩**（`regionCalls = 0`，返回 `null`）。

## 7. 限制

1. token 是 fixture 计价（码点 / 4），**不是** provider token；`E = 0`，无真实 system prompt / 工具 schema / runtime envelope。可迁移的是比例与调度形状，不是绝对数字。
2. fake LLM 只验证结构、请求/输出体积与缩减关系，不验证摘要语义质量；facts 由 fixture 逐字复制以满足生产 provenance 断言。
3. 摘要调用 `usage` 未观测；方案 §4.1 账本中的 `model` / `outputReserve` / `framingReserve` 未采集。
4. 入口为 `trigger='pressure'`（生产同一入口同时承载 40%/70% 与 80% 两档）；本 fixture 只构造 40%–70% 档，因此断言的是「该档不提交语义历史压缩」，而不是「pressure 档不会压缩」。
5. 真实会话中工具组的形状/大小分布、以及真实会话是否或多久进入 40%–70% 档，本实验**未测量**；本实验构造的是「合格完整工具组位于工具区」这一条件本身。
6. 单进程、单 Session、单次维护调用；不代表真实调度下的触发频率、并发、重启或跨实例行为。
7. store 是 E01 目录内的临时 JSON storage domain（真实组件 + 真实域规范），不是生产 `$DSH_HOME` 实例，也未验证多实例/单文档覆盖。
8. 操作② 是 fixture 的 fake pruner：候选集构造方式与 `onReplacement` 协议按生产，但字节不是生产 `ToolResultPruner`；保留比例是 fixture 取值。
9. engine 是 harness 的 seam 模式（plain object + prototype 方法），不是通过 `ctx.plugin` 挂载的真实 `BasicCompactionEngine` 实例；真实的是操作①/② 方法体、zones/envelope 预算、真实 Session 与真实 storage domain。
10. `candidateGroupsOutOfZone = false` 只说明本 fixture 的 3 个组都在区内，**不能**推断真实会话不会出现跨界组（`TG-D2` 仍未解决）。
11. 本实验「通过」只表示 fixture 断言通过，**不**表示理想方案通过，也**不**表示用户观察到的现象不存在；它只回答本文件开头的那一个问题。

## 8. 与静态差异的对应

| 静态 ID | 关系 |
| --- | --- |
| `TG-D1`（需实验确认：①②接续缺端到端用例） | **本实验补上该端到端观测**：同一次 invocation 内先摘要后裁剪，候选集不含新 replacement |
| `TG-E7`（①落盘→非 original；未落盘→仍可裁剪） | 动态确认（逐结果粒度成立） |
| `TG-E9`（候选只取 `isOriginalToolResult`） | 动态确认 |
| `TG-A2` / `TG-A3`（`tool-summary` 身份仅来自独立 audit） | 机制动态确认：replacement 被判为 `tool-summary` 正是因真实 store 的 `servedReplacementSeqs`；同一批节点也带紧邻影子价格事件（store 缺席时会判为 `tool-pruned`）。降级比例未量化 |
| `TG-E5`（模型输出结构化 + 来源校验） | 动态确认（`parseToolGroupSummary` + `assertFactsBelongToInput` 真的执行） |
| `TG-E6`（严格缩减） | 动态确认（4 110 → 84） |
| `TG-E4` / `TG-B4`（信封收窄 + 码点口径） | 动态确认（`inputCapTokens = 81 117` 未收窄 4 110 的组） |
| `TG-E2`（组来源为 original） | 动态确认 |
| `TG-D2`（跨界组无人区） | **未覆盖**（本 fixture 刻意把组都放在区内） |
| `TG-B3`（`fallback` 永久终态） | **未覆盖**（两次摘要均成功，未触发失败路径） |

## 9. sourceDrift

```text
执行前：342/342 核心 src/lib/tests/config/tgz SHA-256 与 E-baseline-hashes.json 一致（mismatch = 0）
执行后：342/342 一致（mismatch = 0）
git status --short：执行前后逐行完全相同（134 行）
git HEAD：前后同为 cf034b4bce6141bb95b590f5ed7fa66f8727daa2
本次新增文件全部位于 审计资料/实验结果/E01-工具预释放/（审计资料 整体仍为未跟踪目录，故 git status 行未变化）
```

`sourceDrift = false`。未修改生产源码、现有 tests、harness、`package.json`、`vitest.config.ts`、`lib`、tgz、E00/E02/E03/E04/E05/E06 任何文件；未构建、未安装、未启动 DSH/GUI，未访问真实 `$HOME/.dsh` 或任何现有会话，未占用 8080，未启动多进程。

### 关于本实验自身的两次失败运行

交付的 `vitest-output.txt` 来自最后一次成功运行（exit 0）。此前两次失败的运行都是 **E01 spec 自身的缺陷**，且都只在 E01 目录内修正，未触碰任何生产文件：

1. seam 缺少 `commitToolGroupSuccess` 绑定 → `TypeError: this.commitToolGroupSuccess is not a function`；
2. fake pruner 用 `createToolResultMessage` 铸造新 message id，被 Session 守卫拒绝 → `tool/result surface replacement may change only content`（见 §2）。
