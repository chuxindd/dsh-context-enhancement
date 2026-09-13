# B4.2 · E05/E06 修复后回归（同 fixture 对照）

> 被对照的两个实验问题（与历史目录逐字相同）：
> - **E05**：`goal/change` 把 Goal A 换成语义完全不同的 Goal B 后，是否会在 `minEvents`（部署值 20）之外触发一次独立更新，并让注入叙事跟随新 Goal？
> - **E06**：合法空 `todo/write({todos: []})` 是否会被 filter 投影、是否会触发更新、是否会让已清空的列表从提交态与注入中消失？

本目录是 B4.2（Goal/TODO 权威视图 + urgent 触发）的**同 fixture 修复后对照**。它**不改写、不覆盖、不移动** `E05-Goal大改/`、`E06-Todo清空/` 与共享 `harness/` 中的任何文件：这些文件只被**读取（import）**与**哈希**，其 SHA-256 记录在 `b42-ledger.json` 的 `sourceDrift.historicalFixturesUntouched`。

---

## 1. 结论（一句话）

**同一 fixture、同一 `minEvents = 20`、同一候选 JSON、同一 fake 环境：E05 原状为「Goal A → Goal B 之后只走阈值调度时零波次、注入仍为 Goal A」；E06 原状为「合法空 todo/write 不可投影、清空后旧列表继续注入」。B4.2 修复后，同一 1 事件窗口在 urgent 请求下各折叠一波（durable trigger 实测 `urgent`），提交态携带权威 `goalView`/`todoView`，注入改为新 Goal / 明确的 cleared。**

对照差量只有一个：**被测量的代码版本**。

---

## 2. 运行方式与产出

```bash
# 修复后同 fixture 对照（本目录）
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts \
  审计资料/实验结果/B4.2-E05E06修复后回归/b42-e05e06-regression.spec.ts --reporter=verbose

# 历史 spec（未修改）在修复后的判决翻转证据
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts \
  审计资料/实验结果/E05-Goal大改/e05-goal-change.spec.ts \
  审计资料/实验结果/E06-Todo清空/e06-todo-clear.spec.ts --reporter=verbose
```

| 文件 | 说明 |
| --- | --- |
| `b42-e05e06-regression.spec.ts` | 对照 spec（4 个 phase + 1 个只读凭据检查；同 fixture、同配置、同候选 JSON；仅 LLM 为 fake） |
| `b42-ledger.json` | 结构化账本（逐 phase 的 `controlWithoutUrgent` / `afterAuthorityFact` / `triggers` / `criteria` / `verdict`，加 `sourceDrift` 与限制） |
| `vitest-output.txt` | 交付运行原始 verbose 输出（5 passed） |
| `vitest-output-historical-postfix.txt` | 历史 E05/E06 spec 在修复后的原始 verbose 输出（7 failed / 1 passed） |
| `README.md` | 本文件 |

---

## 3. 与前后的判决对照（同一 spec、同一 fixture）

| 实验 | 修复前（基线 `cf034b4`，见 `E00-首轮实验阶段评审.md`） | 修复后（历史 spec 未改，直接跑） | 修复后（本目录同 fixture 对照） |
| --- | --- | --- | --- |
| E05 Goal 大改 | 3/3 通过（= 确认缺陷：不走独立 urgent、旧叙事可继续注入） | 1 passed / 2 failed（Case A 只断言 projection，故仍通过） | `e05-replacement` + `e05-clear` 两个 phase 全部判据为真，`trigger = urgent` |
| E06 TODO 清空 | 5/5 通过（= 确认缺陷：空列表不可观察、清空零影响） | 0 passed / 5 failed | `e06-write-clear` + `e06-clear-only` 两个 phase 全部判据为真，`trigger = urgent` |

历史 spec 断言的是**缺陷本身**（“没有 urgent 触发 / 空列表被丢弃 / 渲染无法表达 cleared”），所以修复后它们必须失败：**判决翻转就是前后差量**，这与 E05/E06 目录中的文件是否被修改无关（它们一个字节都没被改）。

---

## 4. 关键结果（原始数字）

### 4.1 E05 `e05-replacement`（Goal A → Goal B，`minEvents = 20`）

| 观测点 | 对照（只 `schedule()` = 历史 E05 路径） | 加生产 observer 的 urgent 请求后 |
| --- | --- | --- |
| 波次 | **0**（`waveRan = false`） | 1（cycles 1 → 2） |
| 模型请求数 | 1 | **2** |
| stable revision | 1 | **2** |
| `goalView.status` | `none` | **`current`（goal-b / revision 3）** |
| 注入含 Goal A objective | **true** | **false** |
| 注入含 Goal B objective | false | **true** |
| 该波次折叠的 seq | — | `[20]`（**1 个事件 < 20**） |
| 实测 trigger | — | **`urgent`** |

修复后注入（原文）：

```text
Durable task state (revision 2, source event 20, digest d432eb7d…).
Current goal: Abandon the font work entirely and migrate the billing service to Postgres.
Goal identity: goal goal-b, revision 3, phase active
Current focus: working on goal B
```

### 4.2 E05 `e05-clear`（Goal clear，`minEvents = 1`）

- `goalView = { status: "cleared" }`，注入为 `Current goal: cleared (no authoritative goal is set).`
- 提交态里模型叙事**仍然**写着 Goal B（`narrativeStillSaysGoalB = true`），而注入里**不再出现** B 的 objective 与 `goal goal-b`：权威视图压过叙事。
- trigger 序列：`threshold, urgent, urgent`；清空那一波折叠 `[2]`（1 个事件）。

### 4.3 E06 `e06-write-clear`（写入 A → 合法清空，`minEvents = 20`）

| 观测点 | 对照（只 `schedule()` = 历史 E06 Case B 路径） | 加 urgent 请求后 |
| --- | --- | --- |
| 空 `todo/write` 投影 | `{kind: 'todo/write', status: 'cleared', todos: []}`（修复前为 **null**） | 同 |
| 波次 | **0** | 1（cycles 2 → 3） |
| `todoView.status` | `current`（旧列表仍"有效"） | **`cleared`（sourceSeq = 清空 seq）** |
| `todoReferences` | `[20:first durable item [pending]; second durable item [in_progress]]` | **`[]`** |
| 注入含旧条目 | **true** | **false** |
| 注入文本 | `TODO references:` + 旧条目 | `TODO list: cleared (the authoritative list is empty).` |
| 实测 trigger | — | **`urgent`** |

### 4.4 E06 `e06-clear-only`（`minEvents = 1`，渲染层能否表达 cleared）

- 写入那一波与清空那一波实测 trigger 都是 `urgent`；
- 清空后注入：`TODO list: cleared (the authoritative list is empty).`，且**不再**出现 `stale item` 与 `TODO references:`；
- `digest` 从 `052b053b…` 变为 `0698a7cb…`：清空是真实内容变化，不是"看起来一样"。

### 4.5 判据（`b42-ledger.json` → `criteria`）

`allPhasesFixed = true`（4/4 phase 的 `criteria` 全为 true）· `noWaveWithoutTheUrgentRequest = true`（3 个 phase 的对照点都实测 `waveRan = false`）· `historicalFixturesUntouched = true` · `verdict = "fixed"`。

---

## 5. 这个结论不能被哪些解释污染

1. **不是 fixture 自己触发的**：对照点（只 `schedule()`）在同一 fixture、同一 seq 上实测 `waveRan = false`；波次只出现在补上生产 observer 的 urgent 请求之后。
2. **不是"新增事件顺便折叠"**：urgent 波次折叠的窗口只有 1 个 seq（就是那条 authority fact），`minEvents` 为 20（或 1）时阈值都不可能解释它。
3. **不是配置不同**：`BASELINE_CONFIG`（`minEvents = 20`，`maxEvents = 200`）与 E05/E06 逐字相同；`minEvents = 1` 的两个 phase 也与历史 Case C 一致。
4. **不是候选 JSON 变了**：`candidateEchoing` 与历史完全相同（含它写出的 `todoReferences`）；修复后该字段已不在候选契约里，被 schema 丢弃 —— 这本身就是差量之一，见 §6。
5. **不是介质不同**：本对照与 E05/E06 一样使用 harness 的内存 worker 环境；durable storage / durable audit 的语义由 `tests/` 的两个新 spec 覆盖（§7）。
6. **不是重放/重复计数**：每个 phase 的 `staleByEligibleEvents` 结束时为 0，`launches` 与 `cycles` 一致，无重复波次。

---

## 6. 装置事实（必须明说的两处模拟）

1. **urgent 请求的那一步是补上的**：harness 自己持有 `TaskStateWorker`、**不挂载** provider，因此生产的 `session/event` observer 不存在。`worker.observe(seq)` 已由 harness 的 `appendGoal`/`appendTodo` 同步完成；本 spec 用 `requestUrgentLikeProduction()` 在一个 microtask 上补上 observer 唯一缺失的 `worker.maybeScheduleUrgent(seq)`（与 `service.ts` 的时序一致：先在同步栈上 `observe`，再在 microtask 上调度）。
2. **trigger 是旁路记录的**：harness ledger 把 `trigger` 硬编码为 `'threshold'`（且 harness 为只读文件），因此本 spec 在 worker 自己的 `performBatch(trigger, window)` 调用点包一层转发来记录**真实** trigger（`threshold,urgent,…`）。没有改任何生产代码，也没有改 harness。

---

## 7. 生产链路证据（不在本目录，但在同一修复上）

本对照用 fake 环境回答"波次是否发生、折叠了什么、提交态与注入是什么"。以下问题只能由真 provider 回答，见：

| 问题 | 证据 |
| --- | --- |
| durable audit 的 trigger 是否为 `urgent`，且与 `startup`/`threshold`/`trailing`/`manual` 可区分 | `tests/task-state-goal-authority.spec.ts`（16 tests，真 `TaskStateBasicService` + 真 storage/domain） |
| 同步 append 栈上是否零模型/零存储工作 | 同上 + `tests/task-state-todo-authority.spec.ts`（13 tests） |
| 模型伪造的 `goalView`/`todoView`/`todoReferences` 是否无法回灌 | 同上 |
| 缺权威视图的 durable 记录是否 fail-closed（clean break） | `tests/task-state-goal-authority.spec.ts` 的 clean-break 用例 |

---

## 8. 限制

1. LLM 为 fake adapter：不测模型质量、token 与真实时延；只测"是否发生波次、折叠了什么、提交态与注入是什么"。
2. 本对照不覆盖 B5 固定槽位注入、B1 artifact parity 与 E01–E10 的历史结论；E05/E06 的历史 spec 与 harness 未被修改，其"修复前通过"的记录来自 `审计资料/实验结果/E00-首轮实验阶段评审.md`（基线 `cf034b4`）。
3. `verdict = fixed` 只表示该 fixture 的判据全部成立，**不代表**理想方案整体达成，也不代表用户侧现象消失。
4. 未构建、未安装、未启动 DSH/GUI；未访问真实 `$HOME/.dsh`、任何既有会话或 8080；未修改 `lib/`、tgz、`package.json`、`vitest.config.ts` 或任何其他实验目录。
5. 引用内容的上限沿用 `maxEntryBytes`（2 000）与 `maxListItems`（8）：超长/超量列表会被截断，本对照未覆盖该边界下的 cleared 语义（由 `tests/` 的边界用例覆盖）。
