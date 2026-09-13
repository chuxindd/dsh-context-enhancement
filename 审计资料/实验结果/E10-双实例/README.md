# E10 · 双实例 storage 覆盖实验

## 0. 一句话结论

**两个独立 OS 进程、同一个临时 storage domain 同时打开时，整文档 last-write-wins 覆盖、
同 revision 无 CAS 分叉、已提交数据在介质上被静默顶掉、外部变更对已打开实例不可见
—— 这四件事都被实测复现（verdict = `reproduced`）；audit 行没有整体丢失，存储层也没有
发出任何冲突信号（这两条为 `false`，同样是实测结论）。**

判定为 `reproduced` 的**主要依据**是 `C2`：两个进程从**同一个已提交 revision 3** 出发，
各自把**不同的 payload** 写成 **revision 4**，两次 `put` 都返回成功，介质上只留下后写者
的 payload —— 存储层从不跨进程比较 revision，因此没有任何 CAS/冲突拒绝。
`C1`/`C3`/`C4` 在阶段 1 给出补充证据：已提交的 key 会被另一个实例的整文档写**整条抹掉**。

---

## 1. 本次实验要回答的唯一问题

> 两个独立的 DSH / storage host 实例**同时**使用同一个临时 storage domain 时，
> 是否会发生：**整文档 last-write-wins 覆盖** / **revision 分叉** / **audit 丢失** /
> **外部变更不可见**？

本目录只回答这一个问题。E01–E09 的代码与结果在本实验中**只读引用、未被修改**。

---

## 2. 运行方式（唯一允许的命令）

```pwsh
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E10-双实例/e10-dual-instance.spec.ts --reporter=verbose
```

* 运行器统计（本轮）：`Test Files 1 passed (1)` / `Tests 1 passed (1)`，duration 2.81s，
  用例本体 2391ms。
* 原始 verbose 输出：`vitest-output-run1.txt`。
* 实验专用 vitest 配置 `审计资料/实验结果/harness/vitest.experiment.config.ts`
  与既有 harness **均未被修改**；没有改动生产源码、既有测试、`package.json`、
  `vitest.config.ts`、`lib/`、tgz 或任何其他实验目录。

**这是真实的多操作系统进程实验**：`realOsMultiProcess.isRealOsMultiProcess = true`。
vitest 进程用 `node:child_process.spawn` 启动 **6 个独立 node 进程**，每个进程各自创建
一个 Cordis Context 并挂载真实的 `Storage` / `StorageJson` / `StorageDomain`。
没有端口、没有 socket、没有命名管道；**不是**同进程内的顺序挂载，也不是"两个 Context 降级"方案。

| 进程句柄 | 代 | 角色 | 实测 pid | 退出码 |
| --- | --- | --- | --- | --- |
| A (gen1) | 1 | 实例 A（阶段 1） | 6340 | 0 |
| B (gen1) | 1 | 实例 B（阶段 1） | 54880 | 0 |
| S (gen2) | 2 | 播种者（只写 SEED-r3 后即退出） | 44740 | 0 |
| A (gen2) | 2 | 实例 A（阶段 2，全新进程） | 49260 | 0 |
| B (gen2) | 2 | 实例 B（阶段 2，全新进程） | 41956 | 0 |
| C (gen3) | 3 | 第三个全新进程（只读读回） | 61668 | 0 |

6 个句柄的父进程都是同一个 vitest 进程（ppid = 51736），`aliveAtHarvest` 全为 `false`，
`commandCount = 37`，`errors = []`，`globalDeadlineHit = false`。

> **pid 复用说明**：Windows 会很快回收 pid，6 个进程句柄在本机只观测到 4 个不同 pid。
> 因此可靠性依据**不是**"pid 全不相同"，而是：每个句柄由各自的 `process.pid` 自报 +
> 各自的 `startedAt`（见 `realOsMultiProcess.workers[]`），并且**同一阶段内并发的两个
> 进程 pid 一定不同**（`distinctPidsWithinOnePhase`，A/B 在阶段 1 与阶段 2 各得一组不同 pid）。

---

## 3. 真实 / 假 的边界（必须明说）

**真实的部分**

* 每个实例都是**独立的 OS 进程**，各自一个真实 Cordis `Context`。
* 真实 `Storage` hub + 真实 `@deepseek-ai/dsh-storage-json`（`layout: 'single'`）+ 真实
  `@deepseek-ai/dsh-storage-domain`（三者的 `lib/index.js` SHA-256 记录在
  `e10-ledger.json → components`）。
* 真实**生产域**：`context_enhancement_task_state` v1，`layout: 'single'`，表 `sessions`
  与 `audit`；规格由 `src/internal/task-state/basic/domain.ts` 直接 import
  （`domainSourceSha256 = dba64f32…`），记录由真实 zod schema 构造并**双向校验**
  （写前构造时校验、读回后再次校验）。
* 每条 `put` 落盘后都记录**磁盘文档 sha256 与磁盘 key 集合**，并在全程结束后由 spec 侧
  独立重新解析磁盘文档复核（`specSideValidation`，与 worker 的推断路径不共享）。

**假的部分**

* **没有任何 LLM / adapter / 真实会话**参与：本实验的问题纯粹关于存储介质，
  因此不引入模型层（记录按真实 schema 形状构造，不是"随便塞的 JSON"）。
* 真实 `$HOME/.dsh`、当前 8080 GUI、现有会话、当前 profile **全程未被访问**。
  所有 storage 根 / 命令目录都在本实验目录内，worker 侧有硬性 `assertInsideE10()`
  断言（越界即 `exit 97`），并且会校验 import 到的域规格名必须等于
  `context_enhancement_task_state`（否则 `exit 96`）。
* 没有启动任何替代 GUI 的服务器。

---

## 4. 临时目录与命令协议

| 项目 | 位置 |
| --- | --- |
| storage 根 | `审计资料/实验结果/E10-双实例/tmp-storage/run-<runId>/` |
| 域文档 | `…/tmp-storage/run-<runId>/context_enhancement_task_state.json` |
| 控制目录 | `审计资料/实验结果/E10-双实例/tmp-control/run-<runId>/` |
| 时间线 | `审计资料/实验结果/E10-双实例/worker-process.log` |
| 账本 | `审计资料/实验结果/E10-双实例/e10-ledger.json` |

`runId` 每次运行随机（本轮 `b85f8dd0`），因此不同轮次的临时目录互不污染。

**命令通道是按"代"分开的文件协议**：每个 worker 只读自己那一代的
`tmp-control/run-<id>/commands-gen<N>.jsonl`，逐条 claim → 执行 → 把响应原子改名发布到
`tmp-control/run-<id>/responses-gen<N>/<id>--<label>.json`。

> 分代是**必要的**，这一点本身是首轮实测到的真实缺陷：同名实例在阶段 2 被重启后，
> 若共用一条命令文件，新进程会把上一代的残留命令重放一遍（首轮出现 9 条
> `no response (timeout or worker exit)`）。

---

## 5. 交错（interleaving）的控制方式与它做不到的事

* 编排者（spec）在**命令粒度**上串行发出并等待响应；谁先写谁后写由 worker 侧的
  `claim` / `putStartedAt` / `putSettledAt` 实测时间戳证明，而不是假设。
* 阶段 2 使用**屏障**：两个进程各写一个 `*.go` 文件后阻塞轮询，编排者删掉两个文件后
  两个进程同时放行。实测 `arrivalDeltaMs = 1ms`（aArrivedAt 1789226298492 /
  bArrivedAt 1789226298493）。
* **做不到的事（明确记录，不猜）**：单次 `putRecord` → `writeAtomic` 内部
  （临时文件 → fsync → rename）的**子操作级交错无法通过 storage API 强制**。
  本实验因此只能保证"两条 `put` 在进程级并发、落盘窗口重叠"，并用实测时间戳证明重叠；
  介质内部更细的交错没有被断言，也没有被当作证据使用。
  * 佐证：阶段 2 中 A 的 `putStartedAt 1789226298522 / putSettledAt 1789226298529`，
    B 为 `…553 / …557` —— 两次写在同一毫秒级的窗口内完成，且都成功返回。

---

## 6. 步骤与实测结果

### 阶段 1（同一临时 root，初始为空；A/B 同时打开）

| 步骤 | 实测结果 | 判据 |
| --- | --- | --- |
| A、B 各自打开同一域（文档不存在） | 两侧内存视图均空、`viewSha256` 相同、`domainFileExistedAtOpen = false` | 起点相同 |
| A 写 Session A（`A-t1`, rev 1） | 磁盘出现 `e10-session-a`，`diskSessionKeysAfter = [e10-session-a]` | A 的提交已落介质 |
| B 读自己的视图（外部变更可见性） | `bInProcessSessionKeys = []`、`bSeesAKeyInMemory = false`、`bGetAKeyResult.present = false`，而 `bDiskReadSeesAKey = true`；`bMemoryEqualsDisk = false` | **C4 外部变更不可见** |
| B 写 Session B（`B-t1`, rev 1） | 落盘后 `diskSessionKeysAfter = [e10-session-b]`，`aKeySurvivedOnDiskAfterBWrite = false` | **C1 整文档覆盖**（A 已提交的 key 被整条抹掉） |
| A 基于旧快照把 Session A 更新到 rev 2（`A-t2`） | `aSeesBKeyInMemory = false`、`aDiskReadSeesBKey = true`；落盘后 `diskSessionKeysAfter = [e10-session-a]`，`bKeySurvivedOnDiskAfterAWrite = false` | **C1 + C3**（B 已提交的数据被静默顶掉，双方都不知道） |
| audit 表同 key 交错（A 先提交 open 行 → B 写同一行 → A 再读） | 两次 `put` 都成功（A 的落盘 sha `e91bdff1…`，B 的落盘 sha `2649b337…`）；A 读回的是**自己那一行**（rev 1，`rowSha256 = 392438be…`），B 内存里是**自己的行**（`rowSha256 = 6684e9e9…`）；`instancesDisagreeOnSameAuditRow = true` | **C5 = false**（audit 行没有整体丢失），但两实例对同一行读值不一致 |
| 清空前的介质快照 | `diskSha256 = 2649b337…`，`sessionKeys = [e10-session-b]`，`auditKeys = [ts-e10-shared-audit-row]`，`aAlive/bAlive = true`（gen 均为 1） | 阶段 1 结论的唯一可信介质依据 |

**覆盖清单（`coverageLossBeforeWipe`，逐条来自实测）**

1. B 写 `e10-session-b` 时，介质上已有的已提交 key `e10-session-a` 消失。
2. A 写 `e10-session-a` 时，介质上已有的已提交 key `e10-session-b` 消失。

> 这就是"整文档覆盖"的直接证据：**不是**推理，而是"写之前已提交的 key 并集"减去
> "该次写之后的磁盘 key 集合"得到的非空差集。

### 阶段 2（清空介质、重启 A/B 为全新进程，做同 revision 分叉）

为避免阶段 1 的"陈旧内存视图"混淆分叉判定，先清空 `tmp-storage` 根，由**独立的播种进程 S**
写入唯一记录 `e10-session-fork`（`SEED-r3`, rev 3）并退出；随后 A、B 作为**全新进程**
同时打开同一域。

| 观测 | 实测值 |
| --- | --- |
| 两侧打开时读到的种子 revision | `aSeedRevision = 3`、`bSeedRevision = 3` |
| 两侧看到的种子记录是否同一条 | `sameSeedRecordHash = true` |
| 分叉前是否确实同起点 | `aAndBSawSameRevisionBeforeFork = true` |
| 屏障 | `arrivalDeltaMs = 1` |
| A 的写 | `ok = true`，`payloadRevision = 4`，`payloadDigest = E10-DIGEST-A-r4-fork`，`conflictRejected = false` |
| B 的写 | `ok = true`，`payloadRevision = 4`，`payloadDigest = E10-DIGEST-B-r4-fork`，`conflictRejected = false` |
| 两个 payload 是否不同 | `payloadsDiffer = true` |
| 存储层是否给出冲突信号 | `noConflictSignalFromStorageLayer = true`（即**没有任何**冲突/告警） |
| 各自读回 | A 读回自己的 payload（rev 4），B 读回自己的 payload（rev 4）——两个实例对同一 key 同 revision 持有**不同值** |
| 介质最终值 | `finalMedium.sessionKeys = [e10-session-fork]`，`sha256 = c4b588d7…`，值为 B 的 payload |

`revisionFork` 账本条目明确写着：
`conflictSignal: 'none — both puts resolved successfully; the storage layer never compares revisions across processes'`。

### 阶段 3（只读读回）

第三个全新进程 C 打开同一域：`cSeesSessionKeys = [e10-session-fork]`，
`cSeesForkKeyRevision = 4`，`cSeesForkKeyDigest = E10-DIGEST-B-r4-fork`，
`cInspectDiskSha256` 与 spec 侧独立计算的 `domainFileSha256` 一致（`c4b588d7…`）；
`unitHeader = { name: 'context_enhancement_task_state', version: 1 }`；
`sessionsValid = [{ key: 'e10-session-fork', valid: true }]`，`matchesLiveSpecIdentity = true`。
也就是说：**介质本身是合法文档，坏掉的只是"两个实例各自的内存真相"**。

---

## 7. 判定表

| 判据 | 结果 | 依据 |
| --- | --- | --- |
| C1 整文档 last-write-wins 覆盖 | **true** | `coverageLossBeforeWipe` 两条擦除记录 |
| C2 同 revision 分叉且无 CAS | **true** | 两个实例同起点 rev 3 → 各自 rev 4 不同 payload，两次 put 都成功，无冲突信号 |
| C3 已提交数据在介质上被静默丢失 | **true** | 阶段 1 中 `e10-session-a` / `e10-session-b` 被对方顶掉；阶段 2 中种子 payload 被 A 的写取代 |
| C4 外部变更对已打开实例不可见 | **true** | B 内存空 vs 磁盘有 A 的 key；A 内存看不到 B 的 key |
| C5 audit 行跨实例整体丢失 | **false** | 介质上仍存在 `ts-e10-shared-audit-row`（`instancesDisagreeOnSameAuditRow = true` 是另一件事，见 §6） |
| C6 存储层给出冲突/告警 | **false** | 全部 `put` 均 `ok = true`；`errors = []` |

`verdict = reproduced`（`reproduced = C1 || C2`）。
`verdictRule`、`criteria`、全部原始响应都写在 `e10-ledger.json` 里。

> **重要限定**：`coverageLoss` 是按**介质代际**分两段计算的
> （`coverageLossBeforeWipe` / `coverageLossAfterWipe`），因为阶段 2 前介质被清空过。
> 阶段 2 之后的介质只含 `e10-session-fork` 一条记录，因此那一代里的"擦除"表现为
> **同 key 的 payload 被取代**（`committedPayloadsAtFinalMedium`），而不是 key 消失。
> 两段结论必须分开阅读，不能把阶段 1 的擦除数量直接套到阶段 2 的介质上。

---

## 8. 与静态审计发现的对应关系

| 静态发现（源码/文档） | 本实验的运行时对应物 |
| --- | --- |
| `storage-json` 的 `single` 布局：内存状态为权威，整文档通过 `writeAtomic`（临时文件 + fsync + rename）整体重发 | 每次 `put` 之后磁盘 key 集合会被**整体替换**；阶段 1 的两条擦除记录 |
| `storage-json/src/atomic.ts` 注释：一个 unit 文件"每进程恰好一个写者、last-write-wins 是正确的" | 两个进程各持一个写者身份时该前提失效 → C1 |
| `single-unit.ts`：写不做排队、内存状态权威 | 实例读的是自己的内存（C4），落盘以整文档为准（C1） |
| `storage-domain`：读走内存、每个域一条写链、**没有跨进程 CAS/revision 比较** | 阶段 2 同 revision 分叉且 `conflictRejected = false`（C2） |
| 真实域 `context_enhancement_task_state` v1 声明 `layout: 'single'`，表 `sessions`/`audit` 同属一个 unit | `sessions` 与 `audit` 在**同一个文档**里，因此一个表的写会重发整文档 |

---

## 9. 限制（读者必须知道的）

1. **子操作级交错不可控**（见 §5）：只能保证命令级交错 + 落盘窗口重叠，并用实测时间戳证明。
2. **没有 LLM/adapter**：本实验不覆盖模型层行为，只覆盖存储介质行为。
3. **单机单文件系统**：两个进程在同一台 Windows 机器、同一 NTFS 卷上；`rename` 的原子性
   语义与网络文件系统 / 容器共享卷不同，本实验不对那些环境作断言。
4. **阶段 2 的介质只有一条记录**：那一代的"覆盖"只能观测为同 key payload 取代，
   不能观测为 key 消失（见 §7 的限定）。
5. **audit 结论较弱**：只测了 1 个 audit key，因此"audit 行是否被整文档覆盖丢掉"只能看
   它是否还在（`C5 = false`）；本实验**没有**测"多 key audit 表被整文档覆盖后丢行"，
   这一点保持未验证，不做推断。
6. **本机 pid 复用**导致"6 个句柄 4 个 pid"，已用 `startedAt` + 各自自报 `process.pid` 替代。
7. **测试时长极短（约 2.4s）**：这是"窗口重叠"的实测事实，不构成对更长时间运行的统计断言。

---

## 10. sourceDrift（运行前后的源码漂移检查）

* git HEAD 前后一致：`cf034b4bce6141bb95b590f5ed7fa66f8727daa2`
  （`git-head-before.txt` / `git-head-after.txt`）。
* `git status` 前后**逐行完全相同**（各 134 行，新增 0 行、删除 0 行）。
  这 134 行改动（`lib/**`、`src/**`、`tests/**`、`CHANGELOG.md`、tgz 等）是**运行前就存在**的，
  不是本实验造成的。`审计资料/` 在 git 里是未跟踪目录（`?? 审计资料/`），
  所以本次新增的实验产物不会出现在改动清单里。
* 342 项基线哈希（`审计资料/实验结果/E-baseline-hashes.json`）在**运行前与运行后**均为
  **342 declared / 342 match / 0 mismatch / 0 missing**
  （`hash-check-before.json` / `hash-check-after.json`）。
* 额外 mtime 扫描：仓库内（排除 `node_modules`、`.git`、`审计资料`）最近 3 小时内
  **没有任何文件被修改**（`drift-check-after.json`，
  `baselineTouchedWithinLast3h = 0`、`filesOutsideAuditDirModifiedWithinLast3h = 0`）。
* 结论：`driftOutsideAuditDir = false`；`审计资料` 目录下的新增**不属于**漂移。

---

## 11. 目录内文件

| 文件 | 说明 |
| --- | --- |
| `README.md` | 本文件 |
| `result.json` | 结构化结论（含 `experiment`/`baseline`/`command`/`verdict`/`observations`/`matchedStaticFindings`/`limitations`/`sourceDrift`/`testSummary`） |
| `e10-dual-instance.spec.ts` | 编排者（唯一 spec；两个独立 OS 进程的实际驱动） |
| `e10-storage-worker.mts` | 极简 storage host（独立 node 进程；`assertInsideE10` 越界即退出） |
| `e10-ledger.json` | 完整实测账本（每个命令的原始响应、时间戳、磁盘 sha256/key 集合） |
| `vitest-output-run1.txt` | 原始 verbose 运行输出 |
| `worker-process.log` | 6 个进程的 claim/respond 时间线 |
| `worker-*-gen*-{stdout,stderr}.log` | 每个进程的 stdio（全为空 = 无异常输出） |
| `hash-check-before.json` / `hash-check-after.json` | 342 项基线哈希前后核对 |
| `git-head-before.txt` / `git-head-after.txt` | git HEAD 前后 |
| `git-status-before.txt` / `git-status-after.txt` | git status 前后（逐行相同） |
| `drift-check-after.json` | 漂移检查明细 |
| `tmp-storage/run-b85f8dd0/` | 临时 storage 根（含唯一域文档，本轮 runId） |
| `tmp-control/run-b85f8dd0/` | 按代分开的命令/响应通道 |

本轮 6 个 worker 进程**全部退出（exit code 0）**，`aliveAtHarvest` 全为 `false`，
`globalDeadlineHit = false`，`commandCount = 37`，`errors = []`。
