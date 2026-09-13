# B4.1 · E07 修复后回归（同 fixture 对照）

> 实验问题（唯一，与 `审计资料/实验结果/E07-重启积压/e07-restart-backlog.spec.ts` 完全相同）：
> 当 stable 已提交且 `sourceCursor = N`，日志中已存在高于 `N` 但从未被折叠的 **filter eligible** 事件，进程在 worker 更新之前关闭；随后用**相同持久 storage、相同 session id、相同 lifecycle** 恢复运行且**不追加任何新事件**时，启动是否会主动发现该积压并更新 stable？

本目录是 B4.1（startup backlog 修复）的**同 fixture 修复后对照**。它**不改写、不覆盖、不移动** E07 历史目录中的任何文件；E07 的 `e07-ledger.json` 与 `e07-restart-backlog.spec.ts` 只被**读取**（读取其 verdict / criteria / startupWindow，以及记录其 SHA-256 作为对照凭据）。

---

## 1. 结论（一句话）

**同一 fixture、同一配置、同一采样窗口，E07 原状为「重启后 2 010 ms 内零请求、零新 audit 行」（`verdict = reproduced`）；B4.1 修复后为「启动在 `firstWaveSampleOffsetMs = 100 ms` 自行发起恰好一波请求，把 cursor 之上的全部积压 `[6,7,8]` 折叠进 revision 2，durable audit 行的 `trigger = "startup"`」（`verdict = fixed`）。**

对照差量只有一个：**被测量的代码版本**（B4.1 新增的启动积压检查 + contract 层 `trigger` 字段）。

---

## 2. 运行方式与产出

```bash
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts \
  审计资料/实验结果/B4.1-E07修复后回归/b41-e07-regression.spec.ts --reporter=verbose
```

| 文件 | 说明 |
| --- | --- |
| `b41-e07-regression.spec.ts` | 对照 spec（同 fixture、四阶段、真实持久介质；仅 LLM 为 fake） |
| `b41-ledger.json` | 结构化结果账本（含 `comparison.e07` 并排基线块、逐样本 `startupWindow`、`criteria`、`verdict`、`sourceDrift`） |
| `vitest-output.txt` | 交付运行原始 verbose 输出（1 passed） |
| `vitest-output-run1.txt` | 同代码确定性复跑（1 passed） |
| `tmp-storage/`、`tmp-sessions/` | 运行期**真实**持久介质（每次运行从干净根重建；保留为证据，不参与跨次 hash 比较） |

---

## 3. 与 E07 的 fixture 一致性（逐项相同）

| 维度 | E07 | 本对照 |
| --- | --- | --- |
| session id | `e07-restart-backlog` | 同 |
| lifecycle | `{createdAt: 1700000000000, cwd: <目录>/tmp-storage}` | 同（仅目录前缀不同） |
| config | `minEvents = 1`，其余部署形态默认 | 同（逐字段相同） |
| 阶段数/角色 | P1 提交基线 → P2 未挂载 provider 时追加积压 → 介质校验 → 重开不追加 | 同 |
| 基线 | revision 1 / cursor 3 | 同 |
| 积压 | seq `6,7,8`（`turn/start` 4 不计；kind = user/assistant/turn-end） | 同 |
| 采样偏移 | `[0,100,250,500,1000,1500,2000] ms` | 同 |
| worker 手动调用 | 从不构造 `TaskStateWorker`，从不手调 `observe/maybeSchedule/performBatch` | 同（且从不手调 `maybeScheduleStartup`） |

唯一差异：**代码版本**。`b41-ledger.json` 的 `comparison` 块把 E07 账本的 verdict/criteria/startupWindow 与本次结果并排写明。

---

## 4. 关键结果（原始数字）

### 4.1 修复后启动窗口（`startupWindow.samples`）

| offset (ms) | stableRevision | sourceCursor | eligibleAboveCursor | adapterRequests | auditRowsOnDisk |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | 3 | 3 | 0 | 1 |
| 100 | **2** | **8** | 3 | **1** | **2** |
| 250 | 2 | 8 | 3 | 1 | 2 |
| 500 | 2 | 8 | 3 | 1 | 2 |
| 1 000 | 2 | 8 | 3 | 1 | 2 |
| 1 500 | 2 | 8 | 3 | 1 | 2 |
| 2 000 | 2 | 8 | 3 | 1 | 2 |

- `requestCountDuringWindow = 1`，`requestWindowsDuringWindow = [[6,7,8]]`；
- `startupWaveTriggered = true`，`firstWaveSampleOffsetMs = 100`；
- `startupTriggerFromDurableAudit = "startup"`（revision 2 的 audit 行 `baseRevision = 1 / baseCursor = 3`）；
- 对比 E07 基线：`waitMs = 2010`、7 个样本 revision 恒为 1、`requestCountDuringWindow = 0`、`noStartupWave = true`。

### 4.2 恢复与积压处理的分离（`stages.stage4.publications`）

| 发布序 | revision | sourceCursor | 该刻已发生的模型请求数 |
| --- | --- | --- | --- |
| 1 | 1（存储中的基线） | 3 | **0** |
| 2 | 2（startup 折叠积压） | 8 | 1 |
| 3 | 3（对照事件触发） | 10 | 2 |

即：**先服务可发布的基线（0 请求），再让 startup 提交新 revision**，两者在时间与请求计数上都可区分。

### 4.3 对照事件（恰好 1 个新 eligible 事件）

- 追加 1 个 `user/message`（seq 10）后：请求窗口 `[[6,7,8], [10]]`，最终 revision 3 / cursor 10；
- `includedSeqsFromDurableAuditRow = [10]`：积压已在启动期折叠，新事件只折叠自己——与 E07 的 `[6,7,8,10]`（积压被迫等到新事件才被折叠）形成直接对照。

### 4.4 判据（`criteria`，全部 true → `verdict = "fixed"`）

`backlogNonEmpty` · `backlogCountMeetsMinEvents` · `backlogAboveCursor` · `backlogUntouchedWhileUnmounted` · `baselineServedFromStoredRecord` · `durableAtResumeAtBaseline` · `startupWaveTriggered` · `startupWaveWithinWindow` · `startupWaveFoldedWholeBacklog` · `startupWaveWindowIsTheBacklog` · `startupTriggerRecorded` · `backlogSurvivedEveryReopen` · `noNewEligibleActivityBeforeTheWindow` · `controlEventTriggeredUpdate` · `controlWindowContainsBacklog` · `routeWorked` · `evidenceComplete` · `noErrors`。

---

## 5. 这个结论不能被哪些解释污染

1. **不是「未达阈值」**：`minEvents = 1`，积压 3 ≥ 1，与 E07 相同。
2. **不是 fixture 自己触发的**：本对照从不构造 worker、从不手调任何调度方法；观测到的唯一波次由生产路径（`runtimeFor` 在恢复后入队的 microtask → `maybeScheduleStartup`）发起。
3. **不是「新增事件顺便折叠」**：窗口内没有任何追加；`session/end-seed` 关闭标记经真实 filter 判定为 **not eligible**（`stage4.restoreMarker.eligible = false`），重开只加该标记，eligible 尾巴逐次一致（`backlogSurvivedEveryReopen = true`）。
4. **不是介质不同**：阶段 3 重新打开同一持久介质并确认积压 `[6,7,8]` 原样存在、durable session record 仍是 revision 1 / cursor 3。
5. **不是重放/重复计数**：构造期初始积压计数与 observer 重放不再重复累加（`worker.ts` 的 `countedThrough` 边界），因此 `minEvents = 4` 时 3 个积压**不会**误触发波次（见 `tests/task-state-startup-backlog.spec.ts` 的子阈值用例）。

---

## 6. 限制

1. 本对照只回答 E07 的第 1 节问题；**不覆盖** B5 固定槽位注入、Goal/TODO 权威契约（B4.2），也**不改** E01–E10 任何历史结论。
2. LLM 为 fake adapter：没有 provider token、usage、真实网络时延；「波次是否发生」可测，「模型质量」不可测。
3. 四个「进程」是同一 vitest 进程内**顺序**挂载并**完整 dispose** 的独立 Cordis Context，**不是**操作系统进程；每个阶段的 storage/JSONL 句柄都已完整关闭并从磁盘重开。
4. storage 介质是真实 JSON 文档后端（`StorageJson`），不是 SQLite，也不是多实例并发介质；**B1 的 blocked-upstream（多实例）结论不受本对照影响**。
5. `injectionHash` 只证明「恢复后未变、新事件后已变」；renderer entry id 含随机 UUID，故 hash 只在同一次运行内可比较。
6. `verdict = fixed` 只表示该 fixture 的判据全部成立，**不代表**理想方案整体达成，也不代表用户侧现象消失。
7. 本对照未构建、未安装、未启动 DSH/GUI；未访问真实 `$HOME/.dsh`、任何既有会话或 8080；未修改 `lib/`、tgz、`package.json`、`vitest.config.ts` 或任何其他实验目录。
