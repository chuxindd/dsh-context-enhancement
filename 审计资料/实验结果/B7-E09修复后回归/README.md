# B7 · E09 修复后回归（fork/resume 对照）

> 状态：**已完成**。历史 `审计资料/实验结果/E09-ForkResume/`（判定 `not-reproduced`）**逐字节未改**（16/16 产物仍匹配其 `artifact-hashes.json`）；本目录是 B7 唯一的 E09 相关写入位置。
> 目的：把 E09 的 spec **原样**复制过来重跑，用"post-fix vs **B7 被中和的对照**"两次运行做归因，证明 B7 对 E09 观测面的真实影响，并把"E09 脚本这次已经观测不到的东西"用等价的**post-fix 对照观测**补上。
> 基线：插件 HEAD `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`（dirty 179 行）；DSH checkout HEAD `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，`git status --porcelain` **0 行**（本批次未修改 DSH）。

---

## 1. 运行命令

```powershell
# 1) E09 spec 的逐字节副本（sha256 与历史文件相同）
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/B7-E09修复后回归/b7-e09-regression.spec.ts --reporter=verbose

# 2) post-fix 对照观测（同一真实栈，读 live audit 表 + v2 域）
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/B7-E09修复后回归/b7-e09-counterpart.spec.ts --reporter=verbose
```

- 工作目录：`C:\Users\chuxi\Documents\trae_projects\code\dsh-context-enhancement`
- 副本与历史 spec 的 sha256 **都是** `D8D5B940F94D5D9D5BCE7040663A40484B9FD9055C84E56EC03A28A52C820538`（`Copy-Item` 原样复制，未改一行）。
- spec 内部的 `OUT_DIR` 取自身目录，因此 `tmp-storage/`、`tmp-sessions/`、`e09-ledger.json` 全部落在本目录，历史目录零写入。

## 2. 三次运行

| 运行 | 树的状态 | 结果 | ledger |
| --- | --- | --- | --- |
| 历史 E09（2026-09-12，其 README/ledger 记录） | 当天的 dirty 树：**没有** B5 fixed slot、持久域仍是 **v1** | `Test Files 1 passed / Tests 1 passed`，3 次通过运行 | `../E09-ForkResume/e09-ledger.json` |
| post-fix（B7 生效） | 当前树 | `1 failed / 1 passed`，失败点 = 第 **1586** 行（`requestSnapshotTexts` 里没有 `revision 1, source event 5`） | `ledger-postfix.json`（run1）、`e09-ledger.json`（run2，规范副本）、`ledger-postfix-run2.json` |
| control（**B7 被中和**） | 当前树 + `sessionInheritedPrefix()` 临时改为 `return null`（运行后立即还原） | 与 post-fix **同一点、同一信息**失败（第 1586 行） | `ledger-control-preb7.json` |

- 原始输出：`vitest-output-run1.txt`、`vitest-output-run2.txt`（post-fix）、`vitest-output-control-preb7.txt`（control）。
- E09 spec 在**任何断言之前**先落盘 ledger（spec 第 1575 行），所以即使断言失败，A–E 全部阶段的观测仍然完整 —— 下面的对照全部读 ledger 字段。

## 3. 归因（最重要的一节）

### 3.1 post-fix 与 control 的差异 = **零**（结构级）

对 `ledger-postfix.json` 与 `ledger-control-preb7.json` 做整棵 JSON 树的逐叶子比较：

```
differing paths total: 74 | volatile-only: 74 | non-volatile: 0
```

74 条差异全部是易变字段：进程/阶段时间戳（`openedAt`/`closedAt`/`createdAt`）、由 Host **每次提交新铸 entry id** 决定的 digest/hash、以及产物字节数。**没有一条**是行为字段。

> 证据补充：同一份 post-fix 代码连跑两次，`stageA.stable.digest` 也不同（`5a7282ea…` vs `3e936877…`，两次 facts 文本逐字相同）—— digest 覆盖的是含 entry id 的 content，所以它本身就是 run-volatile，不能用它做跨运行比较。

### 3.2 那么差异来自哪里：**不是 B7**，而是 E09 之后才落地的两件事

| 观测面 | 历史 E09 | post-fix | control | 归因 |
| --- | --- | --- | --- | --- |
| `stageB2.assemblyLayer.renderedChars` | `411` | `0` | `0` | **B5 fixed slot**：快照不再走变量替换，保留位渲染为空，文本改由插件自己的 slot 节点承载 |
| 真实请求里 `task_state_snapshot` 文本 | 出现在 runtime-context 节点中 | 不再出现（节点被替换为 "Current runtime context: none."） | 同 | 同上（这就是第 1586 行断言失败的原因） |
| `criteria.R3_noCrossSessionReference` | `true` | `false` | `false` | **v1→v2 域 clean break**：E09 脚本读的是 `context_enhancement_task_state.json`（v1，已退役），取不到记录，R3 因此判 false；`anyReproduced`/`verdict` 因此变成 `true`/`inconclusive` |
| `stageE.domainFileBytes` / `auditRowCount` | `20059` / `4` | 空 / `0` | 空 / `0` | 同上（当前 provider 写 `context_enhancement_task_state_v2.json`） |
| `parentCursorAfterAppend` / `childInheritedCount` / `childOwnCursor` / child resume `firstLiveSeq` | `28` / `29` / `33` / `34` | `29` / `30` / `34` / `35` | `29` / `30` / `34` / `35` | **+1 位移**：B5 的 slot 节点在 fork 之前多写了一个表面事件；post-fix 与 control 完全一致 ⇒ 与 B7 无关 |

**结论：这份 E09 脚本在当前树上观测不到 B7。** 它读的域文件已退役，而它读注入文本的那条路径已被 B5 改掉；两次运行（B7 生效 / B7 中和）逐字段一致即是证明。

### 3.3 判定面（E09 的 R1–R4）

| 判据 | 历史 | post-fix | control |
| --- | --- | --- | --- |
| R1 `resume` 是否丢失/重绑 stable | false（未复现） | false | false |
| R2 child 是否共享父 stable | false（未复现） | false | false |
| R3 跨 Session 引用 | false（未复现） | **true（因 v1 域读取失效，不是真实跨引用）** | true（同） |
| R4 边界取自 `firstLiveSeq` 而非 durable 切口 | false（未复现） | false | false |

R1/R2/R4 在 B7 之后**仍然是 not-reproduced**；R3 的翻转在 B7 中和的对照里同样出现，且成因是"退化"（读不到文档）而不是"发现真实交叉引用"，因此**不被记为本批次（或任何批次）复现出的缺陷**。spec 第 1633 行的 `expect(verdict).toBe('not-reproduced')` 因第 1586 行先失败而未被求值 —— 判定以上表读 ledger 的 `criteria` 为准。

## 4. post-fix 对照观测：child 首批窗口（`b7-e09-counterpart.spec.ts`）

历史 E09 唯一直接观测 B7 目标行为的字段是 `stageE.childFirstCommitIncludedSeqs`；它今天读不到了（§3.2）。本文件用**同一套真实栈**复现 A/C/E 阶段并把等价观测写进 `e09-counterpart.json`：

| 观测 | 历史（pre-B7） | post-fix（B7） |
| --- | --- | --- |
| child 首批窗口 `includedSeqs` | `[1,2,3,5,11,13,19,21,24,25,26,28,31,32,33]`（12 个**继承** eligible 事件 + 3 个自己的） | `[6,7,8]`（**只有自己的**；继承前缀 0 个） |
| 继承前缀 eligible 事件 | 全部被折叠为 child 的 live 事实 | `[1,2,3]` 一个都不进窗口（`childFirstWindowInheritedSeqCount = 0`） |
| child 首批 `base` | `-1`（等价于"从日志头开始"） | `null` |
| child stable 上的边界标记 | 无（只能靠 `cursor = -1` 隐式推断） | `{source:'fork-prefix', ownBoundarySeq:4, inheritedThroughSeq:3, parentSession:'e09-counterpart-parent'}`，且**同一标记**同时落在 open audit 行与 **v2 域里的 durable 记录**上 |
| child 自己的 revision/cursor | 自己的 revision 1 / cursor 33 | 自己的 revision 1 / cursor 8（≥ 边界） |

该 spec 的判定（运行前固定、运行时断言）：
`inheritedInWindow == []`、`min(includedSeqs) ≥ cut`、`base === null`、`request.inherited.ownBoundarySeq === cut`、`stable.inherited.ownBoundarySeq === cut`、`durable record.inherited == live stable.inherited`。
运行结果：`Test Files 1 passed (1) / Tests 1 passed (1)`。

## 5. 产物清单

| 文件 | 内容 |
| --- | --- |
| `b7-e09-regression.spec.ts` | E09 spec 的逐字节副本（sha256 与历史一致），头部注明本目录用途 |
| `b7-e09-counterpart.spec.ts` | post-fix 对照观测 spec（真实 SessionStore/fork/JSONL/storage v2 域/service + 脚本化 adapter） |
| `e09-ledger.json` | 副本规范运行（post-fix）的完整 ledger |
| `ledger-postfix.json` / `ledger-postfix-run2.json` | post-fix 的两次运行 ledger（用于证明 digest 的 run-volatility） |
| `ledger-control-preb7.json` | **B7 被中和**的对照运行 ledger |
| `vitest-output-run1.txt` / `vitest-output-run2.txt` / `vitest-output-control-preb7.txt` / `vitest-output-counterpart.txt` | 原始 verbose 输出 |
| `e09-counterpart.json` | post-fix child 首批窗口对照观测 |
| `comparison.json` | 三树（历史 / post-fix / control）逐字段对照 + 归因 + 结构级差异统计 |
| `tmp-storage/`、`tmp-sessions/` | 副本运行的真实域文档与 JSONL 会话日志（副本自己的路径，历史目录不受影响） |

## 6. 与历史 E09 的关系（纪律核对）

- 历史目录 16 个产物逐个重算 sha256：**16/16 与 `artifact-hashes.json` 一致，0 改变、0 缺失**（含 `e09-fork-resume.spec.ts`、两份 ledger、两份 vitest 输出、tmp 产物）。
- 本目录没有修改、重写或删除历史 E09 的任何文件；副本运行写到的是副本自己的 `OUT_DIR`。
- 历史的判定 `not-reproduced` 保持不变：B7 只改"child 首批窗口的覆盖范围"，它的验收证据在 `tests/task-state-fork-bootstrap.spec.ts`（8 个覆盖项）与本目录第 4 节。
