# E00 · 第一轮现有 Vitest 测试（运行时复现实验 · 第 0 步）

> 目的：在**不修改源码、不新增测试、不构建、不安装、不启动 DSH/GUI、不访问真实 `$HOME/.dsh`** 的前提下，用现有 Vitest 测试验证《审计资料/32-运行时复现实验方案.md》第一轮（E01–E06）已确认的静态判断路径。
> 本文件为审计产物，只落入本目录；未修改任何既有源码/配置/测试/产物。

---

## 1. 执行时间与执行者

| 项 | 值 |
|---|---|
| 执行日期（本地 +08:00） | 2026-09-12 |
| 运行窗口 | 17:17:17 → 17:17:45（15 次串行调用，每次约 2 s，均在 runner 启动阶段失败） |
| 落库时间 | 2026-09-12 17:18–17:20 |
| 工作目录 | `C:\Users\chuxi\Documents\trae_projects\code\dsh-context-enhancement` |
| 插件 HEAD | `cf034b4bce6141bb95b590f5ed7fa66f8727daa2` |
| DSH HEAD（未触碰） | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |

工具链（实测）：Node `v24.20.0`、pnpm `11.7.0`、vitest `4.1.11`、vite `8.2.2`、rolldown `1.2.7`（版本取自失败栈与 `package.json`）。

---

## 2. 准确命令

按要求使用工作区 package script 对应的 Vitest，**逐文件串行执行**（同一条命令模板，共 15 次）：

```powershell
pnpm exec vitest run <指定文件> --reporter=verbose
```

等效的完整批量形式（未使用；实际为逐文件调用以获得每文件独立退出码）：

```powershell
pnpm exec vitest run tests/compaction-three-zone.spec.ts tests/compaction-envelope-budget.spec.ts ... --reporter=verbose
```

- 未修改 `vitest.config.ts` 或任何配置；
- 未新增/删除测试；
- 未使用任何绕过手段（未加 `--pool`、未注入 `NODE_OPTIONS`、未打补丁、未改配置）；
- 原始输出逐文件完整落盘于同目录 `vitest-output.txt`（65,186 B / 511 行，含 15 个 START 与 15 个 EXIT 标记）。

---

## 3. 测试文件清单与每文件结果

**结论先行：15 个文件全部在 Vitest 启动阶段（加载 `vitest.config.ts` 时）失败，没有任何测试被收集或执行。因此每文件的 passed/failed/skipped 均为 0（不是"通过"，也不是"失败"）。**

| # | 文件 | 退出码 | collected | passed | failed | skipped | 失败名称 | 关键错误摘要 |
|---|---|---|---|---|---|---|---|---|
| 1 | `tests/compaction-three-zone.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | `[plugin externalize-deps] Error: spawn EPERM`（vite `optimizeSafeRealPathSync`） |
| 2 | `tests/compaction-envelope-budget.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 3 | `tests/compaction-lifecycle-scheduling.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 4 | `tests/compaction-reentry-liveness.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 5 | `tests/compaction-retained-tail-turn-semantics.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 6 | `tests/compaction-tool-group-replacement.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 7 | `tests/compaction-tool-group-audit-failure.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 8 | `tests/task-state-filter.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 9 | `tests/task-state-batch.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 10 | `tests/task-state-worker.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 11 | `tests/task-state-update.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 12 | `tests/task-state-restart-recovery.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 13 | `tests/task-state-prompt.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 14 | `tests/task-state-long-session.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |
| 15 | `tests/artifact-parity.spec.ts` | 1 | 0 | 0 | 0 | 0 | Vitest startup error | 同上 |

汇总：`filesRun=15`、`filesReachedExecution=0`、`passed=0`、`failed=0`、`skipped=0`、`exitCode=1 × 15`。

### 3.1 统一失败原文（15 次逐字一致）

```
failed to load config from C:\Users\chuxi\Documents\trae_projects\code\dsh-context-enhancement\vitest.config.ts

⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯
Error: Build failed with 1 error:

[plugin externalize-deps]
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at spawn (node:child_process:813:9)
    at Object.execFile (node:child_process:349:17)
    at exec (node:child_process:236:25)
    at optimizeSafeRealPathSync (.../vite/dist/node/chunks/node.js:2497:2)
    at windowsSafeRealPathSync (.../vite/dist/node/chunks/node.js:2483:3)
    at getRealPath (.../vite/dist/node/chunks/node.js:33260:36)
    ...
    at async loadConfigFromFile (.../vite/dist/node/chunks/node.js:36975:42)
    at async resolveConfig (.../vite/dist/node/chunks/node.js:36581:22)
    at async _createServer (.../vite/dist/node/chunks/node.js:26388:65)
    at async createVitest (.../vitest/dist/chunks/cli-api.CnMVyzaz.js:14288:18)
```

### 3.2 根因（已定位，非测试失败、非仓库缺陷）

`vite/dist/node/chunks/node.js:2497` 的 `optimizeSafeRealPathSync()` 在该函数**首次运行时无条件执行**：

```js
exec("net use", { windowsHide: true }, (error, stdout) => { if (error) return; ... })
```

`exec` 使用管道的 stdio。本会话的运行沙箱（DSH `workspace-write`，审批提示已禁用）**禁止创建管道 stdio 的子进程**，`spawn` 同步抛出 `EPERM`，异常从 `windowsSafeRealPathSync → getRealPath → 配置打包` 冒泡，导致 Vite 在加载配置前即中止；Vitest 因而连测试文件都没开始收集。

同会话内对沙箱行为的直接验证（`node -e`，未产生文件）：

| 调用方式 | 结果 |
|---|---|
| `child_process.exec("cmd /c echo hi", cb)` | **同步抛 `EPERM: spawn EPERM`** |
| `child_process.spawnSync("cmd", [...], {encoding:'utf8'})`（默认 pipe） | `error.code = EPERM` |
| `child_process.spawn("cmd", [...], {stdio:'ignore'})` | 正常 `exit 0` |

即：被拒的是**管道 stdio 的子进程**，不是文件读取、不是测试逻辑、不是仓库配置。因此这是**环境级阻塞**，与本轮要验证的预算/调度/长期状态设计无关。

> 处理纪律：本会话审批提示禁用、且本代理权限范围在启动时固定，无法申请放宽沙箱；任务书同时明确"不要修改配置以绕过"。故**未**采用任何环境 shim（如 `NODE_OPTIONS` 注入 `--import` 补丁、伪造 `exec` 失败）或 `--pool` 改写。按"记录退出码与输出后继续执行尚未运行的文件"的要求，15 个文件全部原样执行并记录。

---

## 4. 失败与跳过

- **失败（runner 级）**：15/15 文件。全部为同一条 startup error，发生在配置加载阶段，早于任务收集与 `beforeAll`。
- **失败（用例级）**：0（没有用例被执行）。
- **跳过**：0。静态扫描 15 个文件的 `it/test` 调用点共 **201 处**，`it.skip/todo/describe.skip` 命中 **0 处**（这是源码静态计数，因未运行故不代表运行时用例数）。

---

## 5. 每个文件"预定验证的静态差异"与"实际证据"

⚠️ 下表第 3 列是**依据各 spec 自身的 describe 结构与审计文档对其行号的引用**推出的"预定覆盖面"，**不是已验证结论**；第 4 列是本次实际获得的证据。两者必须分开读。

| 文件 | Spec 自身结构（describe/用例点） | 预定对应静态差异 ID | 本次实际证据 |
|---|---|---|---|
| `compaction-three-zone.spec.ts` | three-zone positional planning；pressure span planning；three-zone engine scheduling；durable source classification（33 处用例点） | `IB-08`/`IB-09`/`IB-10`（压力非有界批次、遗忘区跑工具①②、压力跨遗忘区）、`IB-E3`/`IB-E5`/`IB-E8`、`IB-13`、`TG-E9`（unknown-replacement 永不放开）、`TG-A2`（audit 依赖，文档引 `:918-935`）、`X-02`（overflow 用例 `:445-451` 传 `prune=undefined`） | 无（runner 未启动） |
| `compaction-envelope-budget.spec.ts` | envelope budget arithmetic；span planning；engine pass；configuration；envelope zone boundaries；absolute zone boundaries；partition dead zone（38） | `IB-01`（`G=W−E−R−M`，无 `I`）、`IB-02`（分界由 70% 水线授权）、`IB-20`（绝对边界覆盖 ratio）、`IB-E4` | 无 |
| `compaction-lifecycle-scheduling.spec.ts` | automatic compaction lifecycle scheduling（5） | `IB-15`（无持久 stop reason）、`C-08`/`X-01`（fake `ctx.on` 不接收 options，listener 顺序无法钉住） | 无 |
| `compaction-reentry-liveness.spec.ts` | compaction reentry liveness contract（4） | 12-#13（`minReentryTurns` 重入守卫）、`TG-D3`（`allowImmediateReentry=true` 的同 turn 放宽）、`IB-E7`（`no-progress` 记忆化） | 无 |
| `compaction-retained-tail-turn-semantics.spec.ts` | retained-tail floor real turn semantics（4） | `IB-E4`（开 turn + 最近完成 turn + 至少 2 surface turn 的尾部地板） | 无 |
| `compaction-tool-group-replacement.spec.ts` | tool group replacement（6） | `TG-E6`（逐节点严格缩减）、`TG-E7`（①②互斥/逐结果粒度）、`TG-E10`（replacement 身份靠紧邻 shadow 事件重建） | 无 |
| `compaction-tool-group-audit-failure.spec.ts` | summary evidence survives a failed audit commit（4） | `TG-A2`/`TG-A3`（audit 兼作类型权威）、`TG-B3`（失败降级与永久 `fallback`）、`IB-E7` | 无 |
| `task-state-filter.spec.ts` | event-type eligibility；filter projections；hostile payloads（41） | `DIF-TODO-EMPTY-DROPPED`（文档 20 引 `:229-230` 断言空表 `toBeNull()`）、`EQ-GOAL-SNAPSHOT-CLEAR-TOMBSTONE`、`EQ-TODO-WHOLE-LIST-CAPTURE`、`EQ-NO-GOAL-TODO-WRITEBACK`、23-E-11（自反馈排除） | 无 |
| `task-state-batch.spec.ts` | batch window folding（9） | `DIF-INFEASIBLE-NO-DEGRADE`（文档 20 引 `:80-118` 断言 `kind==='infeasible'`）、`EQ-CURSOR` 窗口端点（C2） | 无 |
| `task-state-worker.spec.ts` | task-state-basic worker（8） | `DIF-TRIGGER-NO-URGENT-BYPASS`（`pendingEligible >= minEvents`）、`DIF-TRIGGER-NO-STARTUP-BACKLOG`（B4）、`EQ-FOLLOWUP-SINGLE-WAVE` | 无 |
| `task-state-update.spec.ts` | update attempt（22） | `EQ-AUDIT-NEVER-ROLLS-BACK-STABLE`、`EQ-CURSOR-MONOTONIC-NO-REPLAY`、`EQ-FAILURE-KEEPS-PREVIOUS-STABLE`（E4） | 无 |
| `task-state-restart-recovery.spec.ts` | restart recovery (baseline/hydration contract)（10） | `E07` 重启积压 = `DIF-TRIGGER-NO-STARTUP-BACKLOG`（B4）、`EQ-LIFECYCLE-FENCE`（C5）、`DIF-STABLE-NO-CAS` 邻近面 | 无 |
| `task-state-prompt.spec.ts` | task-state prompt consumer（10） | `D3`/`P1`（注入只受 8000 字节约束、无 `I`）、`D5`（无 staleness marker）、23-E-12/E-15（无 stable/文本未变不写节点） | 无 |
| `task-state-long-session.spec.ts` | keyless long-session + replay（2） | `B1`/`D8`（权威变更滞后）、`EQ-CURSOR-MONOTONIC-NO-REPLAY`、E08 注入累积的邻近面 | 无 |
| `artifact-parity.spec.ts` | Artifact Parity (lib/ 与 `dsh-context-enhancement-0.1.10.tgz` vs src)（5） | 12-#19（三份 lib 字节不一致）、`IB-B1`/`IB-B2`、23-B1/B2（宿主执行字节 ≠ 工作区字节） | 无 |

### 5.1 "是否只能验证事件、未验证最终 surface"

**本轮无法回答该问题**：没有任何用例执行，既未产生事件级断言，也未产生 surface 级断言。

需要保留的一项**先验测试局限**（来自静态审计，供后续轮次沿用）：

- `tests/compaction-three-zone.spec.ts:340-353,560-573` 把 `summarizeToolGroups` / `hasPendingToolIntermediateWork` 打桩（文档 11 `TG-D1`），且 overflow 用例以 `recoverOverflow.call(engine, agent, undefined, signal)` 传 `prune = undefined`（文档 13 `X-02`）⇒ 即便后续能跑通，"一次 invocation 内先摘要再裁剪、候选集不含新 replacement"与"阶段 A 全表面裁剪"仍**不会**被这些用例观测到，需要新 fixture 才能覆盖最终 surface。
- `tests/compaction-lifecycle-scheduling.spec.ts` 的 fake `ctx.on(name, handler)` 不接收 options（文档 13 `C-08`）⇒ listener 相对顺序（`X-01`）在现有测试形态下不可判。

---

## 6. 测试局限（本轮特有）

1. **零测试证据**：passed/failed/skipped 全为 0，不能据此判断任何静态差异"成立/不成立"。**不得**把本轮结果读作"测试通过 ⇒ 方案正确"，也**不得**读作"测试失败 ⇒ 实现有缺陷"。
2. **阻塞点在 runner 之外**：失败发生在 `loadConfigFromFile`，与 `tests/**`、`src/**`、`vitest.config.ts` 内容无关；换任意 spec 文件结果逐字相同（已用 15 次独立调用交叉验证）。
3. **未覆盖 `lib/` 运行时字节**：`artifact-parity.spec.ts` 预定比较 `lib/` 与 tgz 对 `src` 的一致性，未执行 ⇒ 文档 12-#19 / 23-B2 的"三份 lib 不一致、宿主执行字节未知"仍只有静态证据。
4. **沙箱边界不等于真实运行环境**：本轮阻塞是**本会话沙箱**造成的；在放宽沙箱（或无管道限制的环境）中同一命令预计可正常启动。**不能**用本结果推断 DSH 运行实例行为。
5. **无 surface / 无事件观测**：本轮没有任何 maintenance ledger、stop reason、recovery level、注入节点或 stable revision 的运行时数据，方案 §4.1/§4.2 的观测账本字段全部为空。

### 6.1 解除阻塞所需的两个条件（二者任一，均需授权方决定）

- **方案 A（推荐）**：在放宽文件/进程沙箱的模式下（允许管道 stdio 子进程）重跑本文件第 2 节的命令；无需改动仓库任何文件。
- **方案 B**：若必须留在当前沙箱内，需要显式授权一次**环境级** shim（例如 `NODE_OPTIONS` 注入一个让 `exec("net use")` 直接返回错误的 preload，并按需 `--pool=threads` 规避 fork-IPC）。该 shim 不触碰仓库文件、不改变断言语义，但**改变了 runner 运行环境**，因此本轮未擅自采用。

---

## 7. 静态差异对应（本轮能说的与不能说的）

- **能说**：15 个目标测试文件确实存在于工作区（与 `审计资料/00` §1.2 的 untracked 清单一致），静态用例点 201 处、`skip/todo` 0 处；这些文件的**预定**覆盖面与 `IB-* / C-* / TG-* / DIF-* / EQ-*` 差异 ID 的映射见 §5。
- **不能说**：任何差异 ID 的动态验证状态。`IB-05/06/08/09/10/11/13`、`IB-E4/E5/E7`、`C-01/C-02`、`TG-A2/A3`、`DIF-TODO-EMPTY-*`、`DIF-INFEASIBLE-NO-DEGRADE`、`DIF-TRIGGER-NO-URGENT-BYPASS`、`DIF-TRIGGER-NO-STARTUP-BACKLOG`、`D3/P1` 等，**保持原有"确认差异（静态）"或"需实验确认"分类不变**，未因本轮获得任何升/降级。
- **重点观测项全部未取得数据**：压力多批次/退出线（`IB-05/08/10`）、三区隔离（`IB-09`）、工具摘要与裁剪互斥（`TG-E7`）、replacement 真实改面（`TG-E6/E10`）、空 TODO（`DIF-TODO-EMPTY-*`）、worker 触发（`B1/B2/B3/B4`）、restart recovery（`B4/C5`）、注入累积（`D1/D2/D3`）。

---

## 8. sourceDrift

| 项 | 基线（`审计资料/工作区基线.json` + 审计文档口径） | 运行前实测 | 运行后实测 | 判定 |
|---|---|---|---|---|
| HEAD | `cf034b4bce6141bb95b590f5ed7fa66f8727daa2` | 同 | 同 | 无漂移 |
| Modified (M) | 102 | 102 | 102 | 无漂移 |
| Untracked (??) | 31（审计文档口径为 32，增量恒为 `审计资料/`） | 32 | 32 | 无漂移 |
| 总 dirty | 133（口径同上） | 134 | 134 | 无漂移 |
| 非审计目录源码/config/lib 变化 | — | 无 | 无 | **sourceDrift = false** |

- 运行前/运行后 `git status --short` 逐项一致；untracked 清单仍为基线 29 项 + `审计资料/` + `调查资料/`（`理想化落地方案.md` 等 5 个根目录临时文件亦在基线内）。
- 本次唯一写入：`审计资料/实验结果/E00-第一轮现有测试/`（`README.md`、`result.json`、`vitest-output.txt`），属允许的新增审计产物；`node_modules/.vite` 之类缓存未进入 `git status`。
- 未执行：源码/测试/配置修改、构建、安装、`git` 写操作、DSH/GUI 启动、真实 `$HOME/.dsh` 访问、后台常驻进程。

---

## 9. 重跑结果（2026-09-12 17:27）

审批策略和运行权限变化后，使用同一工作区重新执行第一轮清单。单个探针 `tests/task-state-filter.spec.ts` 先独立确认 41/41 通过；随后 15 个指定文件一次性串行运行，输出保存为 `vitest-output-rerun.txt`。

结果：

- Test Files: **14 passed, 1 failed**
- Tests: **205 passed, 1 failed, 206 total**
- 失败文件：`tests/artifact-parity.spec.ts`
- 失败用例：`verifies lib/client.js contains patched module id`
- 失败位置：`tests/artifact-parity.spec.ts:128`
- 失败信息：`unpatched package id must not remain`
- 退出码：1
- sourceDrift：false

失败与静态审计 `审计资料/01-插件装配与配置生效链.md` 已确认的工作区 `lib/client.js` 脚手架 loader ID 残留一致。它是构建产物/装配问题，不是压缩或 Stable Task State 运行失败证据。

## 10. 动态证据边界

本轮成功运行了现有测试，但这些测试主要验证已有单元和服务级契约，不等于 E01–E10 专门实验已经完成。尤其当前输出没有提供完整的 maintenance ledger、净释放、压力退出线、真实 surface 变化、多实例覆盖量或注入累积曲线。

- `compaction-three-zone.spec.ts`、`compaction-envelope-budget.spec.ts` 等验证了部分算法路径；
- `task-state-filter.spec.ts` 动态确认了空 TODO 被丢弃等既有设计行为；
- `task-state-worker.spec.ts` 和 `task-state-restart-recovery.spec.ts` 动态确认了现有 worker/recovery 契约；
- `artifact-parity.spec.ts` 动态确认了 client 产物 ID 不一致；
- 仍需新增隔离 fixture 才能验证用户观察到的压缩抖动、净释放不足、Goal 大改延迟和双实例 LWW。

原始首次阻塞输出保留在 `vitest-output.txt`；本次真实运行输出保留在 `vitest-output-rerun.txt`。

## 11. 最终结论

**verdict = partial（现有测试已运行；动态结果部分有效）**。

本轮证实了 205 个既有断言通过，并复现了 1 个已知 artifact parity 失败；没有改变或推翻静态设计差异。它不能单独证明用户截图中的压力释放和摘要恢复现象已经复现，也不能证明理想方案已经满足。下一步应基于 `审计资料/32-运行时复现实验方案.md` 补建隔离 fixture，再执行 E01–E09。
