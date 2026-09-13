# E07 · 重启积压（重启后 cursor 以上的 eligible 积压是否被 startup 主动处理？）

> 实验问题（唯一）：当 stable 已提交且 `sourceCursor = N`，日志中已存在高于 `N` 但从未被折叠的 **filter eligible** 事件，进程在 worker 更新之前关闭；随后用**相同持久 storage、相同 session id** 恢复运行且**不追加任何新事件**时，启动是否会主动发现该积压并更新 stable？
>
> 判定（协议实验前固定）：**`reproduced`** —— 积压存在（高于 cursor、数量 ≥ `minEvents`），重启后无新事件、在 2 010 ms 窗口内 stable/cursor 完全不变且**零模型请求**，随后追加**恰好一个**新 eligible 事件时才发生更新，且该次更新的折叠窗口包含整个重启前积压。
>
> 层级：L2（真实持久 storage domain + 真实 JSONL Session 持久化 + 真实 resume + 真实 `TaskStateBasicService`；仅 LLM 为 fake）。
> 基线：插件 `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`（实验前后一致），DSH `a66e4702`，342/342 核心文件 SHA-256 一致，`git status` 前后逐行一致。

---

## 1. 准确命令

```bash
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E07-重启积压/e07-restart-backlog.spec.ts --reporter=verbose
```

`vitest-output.txt` = 最终交付运行（exit 0）；`vitest-output-run1.txt` = 同代码的确定性复跑（同样 1 passed）。两次原始输出：

```text
 ✓ 审计资料/实验结果/E07-重启积压/e07-restart-backlog.spec.ts > E07 · restart backlog (does startup discover an unprocessed tail?) > reopens the same durable storage and session with an unprocessed eligible tail and never folds it until a new event arrives 3310ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  3.89s (tests 3.31s)
```

产物：

| 文件 | 内容 |
| --- | --- |
| `e07-restart-backlog.spec.ts` | 本实验唯一 spec（1 个用例，1 次完整四阶段流程） |
| `e07-ledger.json` | 逐项账本：三个阶段进程的 lifecycle/identity、stable/cursor 前后、积压 seq/kind/数量、reopen 时间、采样窗口、requests、durable audit 行、criteria、verdict、limitations |
| `vitest-output.txt` / `vitest-output-run1.txt` | vitest 原始 verbose 输出（交付运行 + 确定性复跑） |
| `tmp-storage/context_enhancement_task_state.json` | 真实 storage domain 落盘文档（**最终 10 321 B**；阶段 3 关闭时 5 351 B / 1 条 audit 行，阶段 4 提交后 2 条）：`sessions` 表 stable 记录 + `audit` 行 |
| `tmp-sessions/…/e07-restart-backlog/session.jsonl` | 真实 JSONL Session 日志（**最终 2 160 B / 11 个事件**；阶段 3 关闭时 1 831 B / 9 个事件；阶段 4 恢复后 10 个事件，其中 2 个为恢复关闭标记） |
| `hash-check-before.json` / `hash-check-after.json` | 342 个核心文件 SHA-256 核对（`E-baseline-hashes.json`） |
| `git-head-before.txt` / `git-head-after.txt` / `git-status-before.txt` / `git-status-after.txt` | 执行前后 HEAD 与 `git status --short` |
| `artifact-hashes.json` | 本目录产物自身 SHA-256 |

## 2. 持久化与重启步骤（四阶段，逐字对应协议）

三个「进程」= 同一 vitest 进程内**顺序**挂载并**完整 dispose** 的三个 Cordis Context（任一时刻只有一个存活）；每个阶段都完整关闭 storage/JSONL 句柄，下一阶段从磁盘重新打开。storage 根 `tmp-storage/`、JSONL 根 `tmp-sessions/`、session id `e07-restart-backlog`、lifecycle `{createdAt: 1700000000000, cwd: <E07>/tmp-storage}` 全程不变。

### 阶段 1（进程 P1）：提交 stable，cursor = N

```text
ctx.plugin(SessionStore / JsonlSessionPersistence / Storage / StorageJson / StorageDomain / LlmRuntime)
ctx.plugin(TaskStateBasicService, CONFIG)          // minEvents = 1
ctx.sessions.create('e07-restart-backlog', { meta: { cwd, createdAt } })
append: turn/start(1) seq0 · user/message seq1 · assistant/message seq2 · turn/end(1) seq3
```

结果：worker 由生产 `session/event` 观察者开波，**1 次**模型请求（fake adapter 记录的 `windowSeqs = [1,2,3]`），提交 **revision 1 / sourceCursor 3**；durable audit 行 `targetRevision 1`、`includedSeqs [1,2,3]`、`outcome success`。随后 `ctx.fiber.dispose()`（关闭阶段）。

### 阶段 2（进程 P2）：在 cursor 之上追加积压，且关闭前未被任何 worker 处理

```text
挂载 host 栈（同上）但【不挂载 TaskStateBasicService】
resume: ctx.sessionPersistence.prepare(id) → ctx.sessions.enter(s) → ctx.sessions.announce(s)
append: turn/start(2) seq5 · user/message seq6 · assistant/message seq7 · turn/end(2) seq8
再挂载 TaskStateBasicService → 其 init 为已 live 的 Session 建 runtime
```

追加发生在「provider 尚未挂载」的窗口内（生产 domain open / 挂载次序窗口；provider 自身 init 用 `createdDuringOpen` 覆盖该窗口）。因此：

- 积压 = **seq 6,7,8**，filter kind = `user` / `assistant` / `turn/end`，数量 **3 ≥ minEvents = 1**，全部 > cursor 3；
- 追加期间与追加后 `requestsAfterSettle = 0`（**没有任何 worker 观测过这批事件**，零模型请求）；
- provider 挂载后播种出 durable stable（**revision 1 / cursor 3，digest 与 P1 逐字节相同**），随后 1 200 ms settle 内 stable 仍为 cursor 3。

### 阶段 3：完整 dispose/关闭

P2 的 `ctx.fiber.dispose()` 完成（detach Session → 释放 preparation → 关闭 fiber），磁盘上：`sessions` 表 stable = revision 1 / cursor 3，`audit` 表 1 行（阶段 1 的 success 行），Session 日志 9 个事件（`session.jsonl` 1 831 B，domain 文档 5 351 B）。

### 阶段 4（进程 P3）：相同 storage、相同 session id 恢复，**不追加新事件**

```text
挂载 host 栈 → resume（persistence.prepare → enter → announce）→ 再挂载 TaskStateBasicService（init 播种 runtime）
不追加任何事件，采样 2 010 ms（0/100/250/500/1000/1500/2000 ms）
然后追加【恰好一个】新 eligible 事件（user/message seq10）
```

reopen 时刻：日志 = 阶段 3 关闭时的 9 个事件 + 恢复路径追加的 1 个 `session/end-seed` 关闭标记（seq9，**非 eligible**），积压仍是 **seq 6,7,8**（与关闭前逐 seq 相同）；恢复出的 stable 仍是 **revision 1 / cursor 3**，digest 与 P1 逐字节相同。追加新事件后日志共 11 个事件（`session.jsonl` 2 160 B），磁盘 domain 文档 10 321 B、`sessions` 表 stable = revision 2 / cursor 10、`audit` 表 2 行（均 success）。

## 3. 判定与证据

| 判据 | 观测 | 结果 |
| --- | --- | --- |
| 积压存在且 ≥ `minEvents` | seq 6,7,8（3 个 eligible）vs `minEvents = 1`，全部 > cursor 3 | ✅ |
| 关闭前未被处理 | P2 全程 `requestsAfterSettle = 0`；磁盘 audit 仍 1 行；stable 仍 cursor 3 | ✅ |
| 重启后旧 stable 成功恢复 | P3 恢复出 revision 1 / cursor 3，`digest` 与 P1 **完全相同**（`ecd082e2…`），注入文本 hash 相同（`2e95c950`，312 字符） | ✅ 但这**不算**积压被处理 |
| 无新事件时 startup 不处理积压 | 2 010 ms 内 7 次采样：`revision 1 / cursor 3 / eligibleAboveCursor 3 / adapterRequests 0`；磁盘 audit 行数恒为 1；`startupWaveTriggered = false` | ✅ |
| 追加新事件后才处理 | 追加 1 个 `user/message`（seq10）→ **1 次**模型请求 `windowSeqs [6,7,8,10]` → 新 stable **revision 2 / cursor 10**；durable audit 行 `base {rev 1, cursor 3}`、`includedSeqs [6,7,8,10]`、`outcome success` | ✅ |

```text
verdict = reproduced
backlog 存在 且 ≥ minEvents；重启后无新事件 → 窗口内不处理（零请求、零 audit 行）
且恰好一个新 eligible 事件才触发更新，其折叠窗口包含整个重启前积压
```

**为什么这个结论不受「积压未达阈值」解释的污染**：`minEvents = 1` 是生产允许的最小阈值（工作区自带的 `tests/task-state-restart-recovery.spec.ts` 与 `tests/task-state-long-session.spec.ts` 的 restart 用例同样用 1）。3 ≥ 1 意味着重启后的 worker 在构造时就已算出「高于 cursor 的 eligible 数量 3 已满足阈值」（`src/internal/task-state/basic/worker.ts:108`），窗口内不发生的唯一原因是**启动路径从未调用 `maybeSchedule()`**——源码中它的唯一调用点是 `session/event` 观察者（`src/internal/task-state/basic/service.ts:409-425`，`:423`）。本实验的 fixture **从未**构造 `TaskStateWorker`，也从未手调 `observe/maybeSchedule/performBatch`：本次运行中所有波次都由生产观察者路径触发。

## 4. 真实 / fake 边界

**真实**：`Storage` + `StorageJson` + `StorageDomain`（真实域 `context_enhancement_task_state`，文件落在本 E07 目录内）；`SessionStore`；`JsonlSessionPersistence`（真实落盘 artifact，`compression: none`）；真实 resume 惯用法 `ctx.sessionPersistence.prepare(id)` → `ctx.sessions.enter()` → `ctx.sessions.announce()`；真实 `TaskStateBasicService`（`ctx.plugin`：调度、单飞、批折叠、prompt frame、候选校验、权威 put、audit 行、启动播种与 repair 全部为生产代码）；真实 filter 数学（`isEligibleType` + `filterEvent`）判定 eligible；真实 `renderTaskStateSnapshot` 生成注入文本。

**fake**：唯一 LLM 是脚本化 `LlmAdapter`，每个请求回一段结构合法的候选 JSON（内容回显它看到的最高 seq），并记录每次请求（时间、`windowSeqs`、输入/输出字符数）。它**不产生 `usage`**，因此本实验不测量 provider token、计费量或真实摘要语义。

**共享 harness 未被修改**：`审计资料/实验结果/harness/` 下任何文件都未改动，也未按原样复用——原因与 E01 类似：`harness/task-state-harness.ts` 的 fixture 用的是**内存** stable store 与 worker environment，既无真实 storage/JSONL，也无真实 dispose/reopen 能力；本实验真正需要的「真实持久化 + 真实重开」只能由生产 API（上面的 resume 惯用法）驱动，而这套惯用法在 DSH 自身的持久化契约测试与工作区自带的 `tests/task-state-restart-recovery.spec.ts` 中就是既有模式。因此 E07 复用**模式**而非文件，全部封装在本目录的 spec 内。

**没有修改/触碰**：生产 `src/`、现有 `tests/`、任何 harness、`package.json`、`vitest.config.ts`、`lib`、tgz、其他实验目录；未使用真实 `$HOME/.dsh`、未访问任何现有会话、未占用 8080、未启动 Web/多实例。

## 5. 一条附带发现：恢复路径会追加一个**非 eligible** 关闭标记

每次从已关闭日志恢复时，持久化路径都会在末尾追加一个 `session/end-seed`（本实验各 1 个，逐次累积：P2 恢复后 1 个、P3 恢复后 2 个）。实测该类型**不在** `ELIGIBLE_TYPES` 中（`closeMarkerEligible = false`），因此它不会自己变成「把积压折叠掉的那个新事件」。这也意味着「重启后不追加新事件」在本实验中是严格成立的：重启只带来非 eligible 标记，eligible 尾部与关闭前逐 seq 相同（`backlogAtReopen.sameSeqsAsBeforeClose = true`）。

日志必须**平衡**（以 `turn/end` 收尾）才会只得到这一个标记；本实验的两个 turn 都是完整闭合的，`logRestoredExactly` 判据同时核对了「恢复日志 = 关闭时日志 + 恰好 1 个标记」，若恢复路径凭空补出 eligible 事件（如崩溃修复补 `turn/end`），该判据会失败并转 `inconclusive`。

## 6. 与静态审计差异的对应

| 静态差异 | 本实验动态对应 |
| --- | --- |
| `审计资料/22-长期状态存储恢复与多实例差异.md` §E12【确认差异】「`startupBacklogUpdate` 缺失：重启后积压不会自行成批」；同文 §X6 待验证项「重启后存在 cursor 之上 ≥ `minEvents` 积压、无新事件」 | 本实验即 X6 的运行后果量化：3 ≥ 1 的积压在重启后 2 010 ms 内**零请求零 audit 行**，直到新增 1 个 eligible 事件才被折叠；配置 schema 中确实没有 `startupBacklogUpdate`（本实验未新增该键） |
| `审计资料/23-长期状态Worker与注入差异.md` §D8【确认差异】「startup/resume backlog 不会自行开波，必须等下一个 eligible event」 | 已动态确认；并额外坐实 `maybeSchedule` 唯一调用点在 `session/event` 观察者内 |
| `审计资料/22-…` §E11【等价实现】「启动播种存在且语义正确：不折、不调模型、不重放未完成更新」 | 同时被证实：三个进程恢复出的 stable `digest` 与注入文本 hash **完全相同**，启动零模型调用（`adapterRequests = 0`） |

## 7. fake 与实验设计限制

1. `minEvents = 1`（生产最小值）：更大阈值只会让「startup 不处理」更容易成立；真实部署取值未经本实验测量。
2. 积压的产生方式：在 provider 挂载**之前**向已恢复的 Session 追加一个完整 turn（生产 domain open / 挂载次序窗口）。真实断电场景还可能是「波次在飞行中进程退出」或「波次失败留下尾巴」；这两种 provenance **未测**，它们会产生相同的存储状态，但本实验不宣称已覆盖。
3. 三个阶段是同一 vitest 进程内顺序挂载/销毁的三个 Cordis Context，**不是三个操作系统进程**；但每个阶段的 storage/JSONL 句柄都已完整关闭并从磁盘重开，且任一时刻只有一个 Context 存活。
4. 恒等项：单 Session、单 lifecycle、单次重启；未测多 Session、多实例、fork/resume、真实 DSH 进程退出竞态、审计 repair 路径（本实验的 audit 表始终只有 success 行）。
5. 2 010 ms 的等待窗口比 worker 的微任务调度窗口高约三个数量级，但它仍是**有限**窗口：本实验证明的是「窗口内不发生」，不是「永不发生」。
6. 注入文本 hash 只用来证明「恢复后未变、新事件后已变」；不测量真实 prompt assembly 的可见节点数、注入预算或 token 归因。renderer 的 entry id 含随机 UUID，故 hash 只在**同一次运行内**可比较。
7. 等待窗口内「无新 audit 行」来自直接读磁盘文档（JSON 后端逐次 put 落盘），是对 adapter 请求计数的补充而非替代。
8. 「通过」只表示 fixture 断言通过，不代表理想方案通过，也不代表用户现象不存在；本实验只回答第 1 节的那一个问题。

## 8. sourceDrift

```text
执行前：342/342 核心 src/lib/tests/config/tgz SHA-256 与 E-baseline-hashes.json 一致（mismatch = 0）
执行后：342/342 一致（mismatch = 0）
git status --short：执行前后逐行完全相同（134 行）
git HEAD：前后同为 cf034b4bce6141bb95b590f5ed7fa66f8727daa2
本次新增文件全部位于 审计资料/实验结果/E07-重启积压/（审计资料 整体为未跟踪目录，故 git status 行未变化）
```

`sourceDrift = false`。未修改生产源码、现有 tests、任何 harness、`package.json`、`vitest.config.ts`、`lib`、tgz 或 E01–E06/E08–E10 任何文件；未构建、未安装、未启动 DSH/GUI；未访问真实 `$HOME/.dsh` 或任何现有会话；未占用 `127.0.0.1:8080`；未启动多进程。

### 关于本实验自身的失败运行

交付的 `vitest-output.txt` 来自最后一次成功运行。此前两次红色运行都只是 **E07 spec 自身的判据缺陷**（把恢复路径追加的 `session/end-seed` 关闭标记漏算进「恢复日志应等于关闭时日志」的期望里），已在本目录内修正；修正过程中未触碰任何生产文件，且该标记正是第 5 节记录的附带发现。
