# E03 · 压力抖动（一工具一压缩）

> 实验问题（唯一）：在当前工作区 pressure path 下，连续追加一个典型 tool/result 后，下一次维护是否再次触发，是否出现"一个工具调用一次压缩"的抖动迹象？
>
> 判定：**`reproduced`**（连续 5 次相邻维护之间都只有 1 个新增 tool/result，且每次维护都确实提交了 replacement）。
>
> 层级：L1（fake TokenMeter + fake LLM + 临时 Session，无真实进程、无真实 `$HOME/.dsh`）。
> 基线：插件 `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`（git HEAD，实验前后一致），DSH `a66e4702`，worktree 工作树 hash 342/342 一致。

---

## 1. 准确命令

```bash
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E03-压力抖动/e03-pressure-thrash.spec.ts --reporter=verbose
```

原始输出：`vitest-output.txt`。

```text
 ✓ 审计资料/实验结果/E03-压力抖动/e03-pressure-thrash.spec.ts > E03 · pressure thrashing: one typical tool/result per maintenance > runs 1 initial + 5 cycle maintenance invocations and records every ledger field 26ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  657ms (tests 27ms)
```

产物：

| 文件 | 内容 |
| --- | --- |
| `e03-pressure-thrash.spec.ts` | 本实验唯一 spec（1 个用例，1 次运行） |
| `e03-ledger.json` | 6 次 maintenance 的逐条账本 + 相邻间隔（gaps）+ 判据（criteria） |
| `vitest-output.txt` | vitest 原始 verbose 输出 |
| `hash-check-before.json` / `hash-check-after.json` | 342 个核心文件 SHA-256 核对（`E-baseline-hashes.json`） |
| `git-status-before.txt` / `git-status-after.txt` / `git-head-before.txt` / `git-head-after.txt` | 执行前后 git 状态与 HEAD |

harness 复用情况（要求 1）：**可以复用，未做任何修改**。`harness/compaction-harness.ts` 的 `createCompactionFixture(...).run('pressure')` 直接调用真实 `BasicCompactionEngine.prototype.compactIfNeeded(agent, 'pressure', signal)`，内部走真实 `planPressureSpan` / `planForgetBatch` / `envelopeBudget` / `envelopeZoneBudget` / `pressurePassTerminated` 与真实 `compactSurfaceRegion`（prepare → 真实 `summarizeWithLlm` → 严格缩减断言 → bracket → surface generation）。因此本实验既没有重写 harness，也没有新增 harness 文件。

## 2. Fixture（fixture token，**非** provider token）

`contextWindow = 100 000`，生产默认水位：tool 40%（40 000）、forget 70%（70 000）、pressure 80%（80 000）；`retainTokens = 20 000`；`responseReserveTokens = 8 192`、`safetyMarginTokens = 2 048`；`targetBatchTokens = 16 000`、`maxBatchTokens = 24 000`、`maxMaintenanceBatches = 1`（harness 固定传入，未改动）。fixture 的 envelope `E = 0`（fake meter 令 `totalTokens == surfaceTokens`）。

| 位置 | 内容 | fixture token |
| --- | --- | --- |
| turn 1（已完成） | 31 × assistant/message × 2 000 | 62 000 |
| turn 2（最后完成 turn） | 3 × (tool-call 1 000 + tool-result 4 000) | 15 000 |
| turn 3（**OPEN**） | 1 × (tool-call 1 000 + tool-result 4 000) | 5 000 |
| 合计 | | **82 000 = 82%** |

每个周期：向 OPEN turn 追加 **1 个 tool-call（1 000）+ 1 个 tool-result（4 000）**（同一个新 step，即"一个模型步 + 一次工具执行"），随后执行下一次 pre-step maintenance。tool/result 4 000 fixture token 落在方案要求的 3K–8K 区间内，`tool/result` 节点计数每周期恰好 1。共 1 次初始维护 + 5 个周期 = **6 次 maintenance**（≥4 周期）。

价格规则：fixture 文本字符数 / 4（`CHARS_PER_TOKEN = 4`，harness 自定），**不是** provider token，也不含真实 system/tools/runtime envelope。

## 3. 每周期账本

（`e03-ledger.json` 为完整机器可读版本；下表为摘要，净释放与 headroom 单位均为 fixture token。）

| maintenance | 距上次新增 tool/result | before total | 选中跨度（surface 位置 / token / source kinds） | summary 请求（in/out token） | after total | 净释放（ratio） | headroom（fixture / 计入 framed checkpoint） | stop reason | generation | 档位 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1（初始） | 0 | 82 000 | [0,1] / 4 000 / 2×assistant/message | 1（4 451 / 278） | 78 000 | 4 000（4.88%） | 2 000 / 1 637 | `[]` | 0→1 | pressure |
| #2 | 1 | 83 000 | [0,2] / 4 000 / user/message(上一 checkpoint)+2×assistant | 1（4 814 / 301） | 79 000 | 4 000（4.82%） | 1 000 / 614 | `[]` | 1→2 | pressure |
| #3 | 1 | 84 000 | [0,3] / 6 000 / checkpoint+3×assistant | 1（6 837 / 428） | 78 000 | 6 000（7.14%） | 2 000 / 1 487 | `[]` | 2→3 | pressure |
| #4 | 1 | 83 000 | [0,2] / 4 000 / checkpoint+2×assistant | 1（4 963 / 310） | 79 000 | 4 000（4.82%） | 1 000 / 605 | `[]` | 3→4 | pressure |
| #5 | 1 | 84 000 | [0,3] / 6 000 / checkpoint+3×assistant | 1（6 846 / 428） | 78 000 | 6 000（7.14%） | 2 000 / 1 487 | `[]` | 4→5 | pressure |
| #6 | 1 | 83 000 | [0,2] / 4 000 / checkpoint+2×assistant | 1（4 964 / 310） | 79 000 | 4 000（4.82%） | 1 000 / 605 | `[]` | 5→6 | pressure |

每周期追加量恒为 5 000 fixture token（tool-call 1 000 + tool-result 4 000），每周期总账：

```text
after(维护 k) + 5 000 = before(维护 k+1) → 再次 ≥ 80 000 → 维护再次提交一个 replacement
78 000/79 000 → 83 000/84 000 → 78 000/79 000 → 83 000/84 000 → ...
```

其他账本字段（要求 3 全覆盖）：before total/surface/envelope、三区 before（forget/tool/recent/retainedTail）、选中跨度 start/end index + token + source kinds + source seqs、summary 请求数与输入/输出（字符与 fixture token）与输出文本前缀、after total/surface、净释放与比率、headroom、stop reason、surface generation before/after、两次维护间新增 tool/result 数、`shadowedNodes`、`zonesAfterCall`、surface kind 计数。

补充观察（同样出自账本）：

1. **退出点贴近触发线，而不是 0.70**：每次维护后总量停在 78 000–79 000（78%–79%），headroom 只有 1 000–2 000 fixture token，远小于下一典型 tool/result（4 000）。这正是"一个工具调用一次压缩"的直接成因：赤字尺寸跨度只把请求压回触发线以下，任何大于 headroom 的新内容都会立刻把它推回 80%。
2. **每次只有 1 次语义调用、只提交 1 个 replacement**：6 次维护的 `summary.requests` 全为 1，generation 增量全为 1，`stopReasons` 全为空 → 不存在同一调用内的重试/多批次（这一点与 E02 一致，E03 只用于解释"下一次维护为什么还会来"）。
3. **净释放比率 4.8%–7.1%**，全部低于理想方案的 `netReleaseRatio ≥ 0.15`（IB-06 定义的最小净收益），但当前实现没有任何 low-yield 判定，全部照常提交并计费。
4. **从 #2 起跨度起点恒为 surface index 0，且 source kinds 第一个节点是 `user/message`**，即上一轮刚落地的 checkpoint 被下一轮再次折进新跨度（pressure path 对已知 history-summary 放开 `minReentryTurns`）。每轮头部因此净减少 4 000–6 000 fixture token，而 retained tail 因 OPEN turn 变长每轮增加 5 000：tool 区 30 000 → 6 000、recent 区 20 000 → 45 000。该 fixture 的头部空间是有限的，本实验只跑了 5 个周期。
5. **辅助调用输入 ≈ 净释放量**：4 451/4 814/6 837/4 963/6 846/4 964 fixture token 的摘要输入（fixture 计价，含被重放的 checkpoint 与跨度内容），对应释放 4 000/4 000/6 000/4 000/6 000/4 000。即"付费规模接近释放规模"（真实 provider 侧可用 KV cache 复用前缀，故不能直接等同于真实账单，见限制）。

## 4. 判定

判据在实验前固定（spec 头部注释与 `criteria` 字段）：

- `reproduced` = 连续至少 3 次相邻维护之间只有 1 个新增 tool/result，且维护确实提交 replacement；
- `not-reproduced` = 完整多周期账本存在但不满足上述连续条件；
- `inconclusive` = fixture/runner 无法产出证据；
- `design-confirmed` = 只有静态设计证据、无动态账本。

观测结果：

```text
gaps = 5（#1→#2、#2→#3、#3→#4、#4→#5、#5→#6）
每个 gap：addedToolResults = 1，laterMaintenanceCommittedReplacement = true
thrashStreak = 5（≥3）
headroomGapStreak = 5（每个 gap 的前一次维护 headroom 1 000–2 000 < 4 000 典型 tool/result）
criteria.completeLedger = true
verdictFromCriteria = "reproduced"
```

**判定：`reproduced`。** 注意本判定是"受控 L1 复现"：它证明当前 pressure path 在"每次维护后 headroom < 下一典型工具结果预算"的会话形状下会每来一个 tool/result 就再压缩一次，而不证明真实用户会话的工具结果分布一定满足该形状（见第 6 节）。

本实验不使用 E02 已反证的"整区一次"假设：E03 完全不依赖 whole-zone 表述，只验证 repeated invocation 与 headroom。E02 目录未被读取以外的任何方式触碰，也未修改。

## 5. 静态差异对应

| 静态项 | 出处 | E03 的动态证据 | 证据等级 |
| --- | --- | --- | --- |
| `IB-R2`「压力档收敛性」（【需实验确认】：需测量贴近 80% 时会话的释放轮数、low-yield 出现频率、是否长期抖动在 80% 附近） | `审计资料/10-预算调度与三区差异.md:135`；`IB-05:83`、`IB-06:84`、`IB-10:93` 的"是（IB-R2…）" | 6 次维护后总量在 78 000–84 000 之间反复，5 个连续单工具间隔全部再次提交；每次退出点 78%–79% | 受控动态复现（fixture token） |
| `IB-05`「无 `pressureExitRatio`；压力档退出目标是赤字尺寸前缀」 | `10:83`；`config.ts:29-37`（无该键）、`compaction-basic.ts:450,526,569` | 每次维护后总量 78 000/79 000，未回落到 70%，与"退出目标是当前缺口"一致 | 受控动态支持 |
| `IB-06`「只有严格缩减断言；低收益批次会被提交并计费；`no-progress` 只在完全未下降时生效」 | `10:84`；`region.ts:449-454`；`compaction-basic.ts:707-714` | 6 次提交的 `netReleaseRatio` = 4.8%–7.1%（理想要求 ≥0.15），`stopReasons` 全空，无任何 low-yield 记录 | 受控动态支持 |
| `IB-08`「压力档为单次跨度语义调用，不受 `targetBatchTokens/maxBatchTokens` 约束」 | `10:91` | 每次调用 `summary.requests = 1`、generation +1；跨度 4 000/6 000 与 batch 预算无关（也与 E02 的赤字尺寸结论一致） | 受控动态支持 |
| `IB-10`「本调用内不重试，靠下一个 pre-step 重新规划」 | `10:93`；`compaction-basic.ts:704-715` | 每个 pre-step 都重新规划并再次付费；连续 5 个 pre-step 均提交 | 受控动态支持 |
| `IB-09`（遗忘区跑工具①②）、`IB-07`（净释放无账本） | `10:92`、`10:85` | **本 fixture 未覆盖**：没有 pruner、`toolGroupAuditor` store 为 undefined，被测跨度内也没有工具对；净释放由本实验在 fixture 侧重建 | 未验证（E01 范围） |

## 6. fake 限制（必须随判定一起引用）

1. **token 是 fixture 计价**（字符数 / 4），不是 provider token，也不含真实 system prompt / 工具 schema / runtime envelope；`E = 0`。可迁移的是**比例形状**（退出点落在触发线下约 2–3% 窗口、典型 tool/result 约占窗口 4%），不是绝对数字。
2. **replacement checkpoint 在 fixture meter 中计 0**：harness 只对 `append()` 过的节点定价，`compactSurfaceRegion` 落入的 checkpoint 不在价格表内，故 `netReleasedTokens` 等于跨度价（= 净释放上界）。账本另给出按生产规则重算的 `framedCheckpointTokens`（`estimateMessage(frameSummary(summary))` = 363/386/513/395/513/395）与 `derivedHeadroomWithFramedCheckpointTokens`（1 637/614/1 487/605/1 487/605）：headroom 更小，**抖动结论在计入真实 checkpoint 价格后依然成立**，且这一偏差只会让抖动更强、不会更弱。
3. **fake LLM**：只验证结构、请求/输出体积与缩减关系，不验证摘要语义质量；摘要输出按 `inputChars/16` 生成填充文本。
4. **`toolGroupAuditStore = undefined`、无 pruner、`hasPendingToolIntermediateWork = 'none'`**：本实验只测 70%/80% 档门槛与 pressure 跨度提交，不测工具组摘要、裁剪与 tool-stage debt 否决路径。
5. **"典型 tool/result" 由实验设定**：4 000 fixture token / 100 000 窗口。真实会话中工具结果分布是否大于维护后 headroom 没有被本实验测量；`reproduced` 的前提是"典型工具结果 > 维护后 headroom"，这是本实验**构造**的条件，不是实测分布。
6. 单进程、单 Session、无并发维护、无重启：不代表真实调度下 pre-step 的实际触发频率。

## 7. 未观测字段（写 null 或标注来源）

| 字段 | 状态 | 原因 |
| --- | --- | --- |
| provider token / 真实 usage | 未观测 | fake adapter 不产生 usage；`summary.inputTokens/outputTokens` 均为 fixture 计价 |
| `netReleasedTokens` 的"真实"值 | 上界 | 见限制 2；真实值 = 跨度价 − framed checkpoint 价（账本可推导） |
| `envelopeTokens` | 恒为 0 | fixture meter 令 `totalTokens == surfaceTokens`，无真实 envelope 分量 |
| `recoveryLevel`（overflow 档） | 未观测 | 本实验只走 `trigger='pressure'`，未触发 overflow |
| `no-progress` / `low-yield` / veto stop reason | 未观测（均为空数组） | 6 次维护全部正常提交，未走到否决路径；"当前实现没有 low-yield 判定"本身是静态事实 |
| `model` / `outputReserve` / `framingReserve`（方案 §4.1 账本字段） | 未观测 | harness 未在 ledger 中暴露；`resolveModelInfo` 由 fixture 固定返回 `contextWindow`，`maxTokens` 等预算只作为内部 cap 使用 |
| 真实 DSH 会话中的触发频率、工具结果分布 | 未观测 | L1 fake 实验边界之外（需真实回放） |

## 8. sourceDrift

```text
执行前：342/342 核心 src/lib/tests/config/tgz SHA-256 与 E-baseline-hashes.json 一致（mismatch = 0）
执行后：342/342 一致（mismatch = 0）
git status --short：执行前后逐行完全相同（134 行）
git HEAD：前后同为 cf034b4bce6141bb95b590f5ed7fa66f8727daa2
本次新增/修改文件全部位于 审计资料/实验结果/E03-压力抖动/（审计资料 整体仍为未跟踪目录，故 git status 行未变化）
```

`sourceDrift = false`。未修改生产源码、现有 tests、`package.json`、`vitest.config.ts`、`lib`、tgz、其他实验目录或 harness 文件；未构建、未安装、未启动 DSH/GUI，未访问真实 `$HOME/.dsh` 或任何现有会话。
