# 23 长期状态 Worker 与 Stable 注入差异（正式审计）

> 范围：**只审后台 worker 与 Stable 注入**，对照《理想化落地方案》§3.13（`理想化落地方案.md:233-243`）、§5.3（`:508-518`）、§5.6（`:545-557`），辅以 §5.2 触发/§5.5 fork。
> 不审：合并内容质量（prompt/filter 语义取舍）、存储 backend（JSON `single`/CAS/多实例）、主线程压缩算法、GUI 动态行为。
> 基线：工作树 = HEAD `cf034b4` + 102 modified / 31 untracked（`审计资料/工作区基线.json`）；DSH 侧事实只引用 `调查资料/10,15,20,21`，未重新调查 DSH。
> 证据标记：【确认差异】= 与方案条目语义不同且方案侧为固定要求；【等价实现】= 机制不同但满足同一条不变量的静态证据；【参数差异】= 只有数值/口径不同；【需实验确认】= 静态存在竞态或路径不明；【构建产物差异】= 产物与源码/部署副本不一致。
> 本文件为只读审计产物：未构建、未测试、未安装、未还原、未改任何源码或配置，仅新增本文件。核心引用文件 17 个（≤20）。

---

## 0. 结论速览

1. 后台 worker 的**生命周期、单飞、coalescing、AbortSignal、timeout/retry、dispose/HMR fence、observer 不阻塞**七项，静态证据全部指向【等价实现】（§3）。
2. 真正的【确认差异】集中在两侧：**触发面**（无 urgent、无 startup/resume backlog、infeasible 永久卡 cursor）与**注入面**（无 replacement、旧快照累积、无注入预算 I、无 `stable-state-injection` 来源类型、无 staleness marker、渲染优先级倒置）。
3. 注入面差异的根因是一条：插件只注册 `systemPrompt.context`（`src/task-state-prompt.ts:56-63`），把"节点管理"完全交给 DSH 的 runtime-context 投影，而该投影是**文本级 supersede、非行级遮蔽**（`调查资料/20:280`），故 §3.13 的 replacement 语义在当前设计里没有任何落点。
4. 自反馈排除与"无 stable/文本未变不写节点"两项由 DSH 既有语义 + 插件过滤门共同满足，属【等价实现】，但**注入节点仍被归类为 `original`**（`source-index.ts:100`），可被历史摘要回收——这既不是方案要求的"仅最新节点存在"，也不是"受保护节点"。
5. 3 项构建产物事实：工作区 `lib/` 与当前 `src` 同构；tgz 过期；宿主实际装配的是 `$DSH_HOME` 安装副本（旧构建）→ 静态审计不保证等于宿主执行字节。

---

## 1. 差异矩阵（非等价类）

| ID | 类别 | 方案条目 | 实现证据（路径:符号:行） | 一句判定 |
|---|---|---|---|---|
| D1 | 【确认差异】 | §3.13 固定槽位 replacement（`:233-243`） | `src/task-state-prompt.ts:56-63`（只 `ctx.systemPrompt.context`）；`src/task-state-prompt.ts:64-72`（`variable`）；全 src `surfaceOp` 仅 `src/tool-result-pruner.ts:359`、`src/internal/compaction/tool-group-replacement.ts:129`、`src/internal/compaction/region.ts:539` | 注入走 runtime context 追加，**无任何 replacement 节点**；节点文本也缺 lifecycle 引用（仅 `render.ts:46` 的 revision/cursor/digest） |
| D2 | 【确认差异】 | §3.13 不无限追加快照；§5.6 "只允许最新节点存在" | `src/task-state-prompt.ts:64-72`（每次 assembly 现算）；`src/internal/task-state/prompt/render.ts:106-121`（仅单次字节截断）；DSH 侧语义 `调查资料/20:121,259,280` | stable 每次变更即由 DSH 追加一条同源 `user/message`，旧节点留在 transcript，插件侧无计数、无上限、无回收 |
| D3 | 【确认差异】 | §3.13 注入受独立预算 I 限制并进入请求预算账本（`:241`）；§3.1 `G=C-O-F-E-I`（`:58`） | `presets/contextual/agent.cordis.yml:61`（只有字节 `maxBytes: 8000`）；`src/internal/compaction/config.ts:36,43`（policy 键无 I）；`src/internal/compaction/envelope-budget.ts:96-104`（`G=W-E-R-M`，无 `-I`）；`src/internal/task-state/basic/types.ts:15-38`（11 键无 `stableInjection*`）；`调查资料/20:160`（无独立可归因字段） | 注入只受字节上限约束；token 侧被混入 `surfaceTokens` 无独立归因，账本/预算公式里没有 I 项 |
| D4 | 【确认差异】 | §5.6 该节点标为 `stable-state-injection`，普通工具操作不处理，老化时只允许最新节点存在 | `src/internal/compaction/source-index.ts:13`（kind 枚举无该值）、`:98-110`（`classifyEvent`）、`:100`（非 replacement 的 `user/message` → `original`）、`:85-94`（`canCompactHistory` 对 `original` 直接 `true`）；消费者 `src/compaction-basic.ts:555,1059`；对照 `src/internal/compaction/selection-guard.ts:47-52`（只识别 compaction checkpoint） | 注入节点被当成普通 `original` 表面节点：不被工具操作处理（见 E-13），但**可被历史摘要整段折叠**，且多个旧节点可同时存在 |
| D5 | 【确认差异】 | §5.6 渲染需显示 `staleness`（`:555`） | `src/internal/task-state/prompt/render.ts:44-47`（只 revision/cursor/digest）、`:106-121`（纯函数，入参只有 stable+maxBytes）；`src/task-state-prompt.ts:64-72` | 无 stale marker：cursor 落后 eligible high-water 时模型看不到任何提示 |
| D6 | 【确认差异】 | §5.6 渲染优先级 Goal → TODO/focus → constraints/risks → decisions/facts → evidence（`:547-553`）；§5.1 goalView/todoView（`:452-464`） | `src/internal/task-state/prompt/render.ts:45-88`（continuation → facts → decisions → constraints → risks → evidence → todoReferences）；`src/internal/task-state/contract/types.ts:153-174`（stable 无 goalView/todoView，仅 `:108-110` todoReferences） | 无 Goal/TODO 视图；且 constraints/risks 排在 decisions/facts 之后，头部保留截断时**优先级倒置** |
| D7 | 【确认差异】 | §5.2 urgent（goal/change、todo/write、用户纠正）短 debounce 后立即 wave（`:500-506`）；§3.10（`:185-202`） | `src/internal/task-state/basic/service.ts:409-425`（唯一 observe 路径，无优先级判断）；`src/internal/task-state/basic/worker.ts:156-164`（仅 `pendingEligible >= minEvents`）；全 src 检索 `urgent|debounce` 命中 0（仅 `src/client/task-state-control-store.ts:180` 的 UI setTimeout） | Goal/TODO 权威变更不享有任何优先级，必须等 `minEvents`（部署值 20） |
| D8 | 【确认差异】 | §5.2 startup/resume backlog 主动 schedule 一次（`:504`）；§7 `startupBacklogUpdate: true`（`:644`） | `src/internal/task-state/basic/worker.ts:103-108`（构造时算 `pending`/`pendingEligible`）；`maybeSchedule` 唯一调用点 `src/internal/task-state/basic/service.ts:422`；`service.ts:387-397`（seed 只发布指针+repair） | restart/resume 后 cursor 以上积压**不会自行开波**，必须等下一个 eligible event（与 `调查资料/10:326` 一致） |
| D9 | 【确认差异】 | §5.2 "infeasible 单事件进入确定性降级投影，不允许永久卡住 cursor"（`:506`） | `src/internal/task-state/basic/worker.ts:193-201`（记 error 后 return，不推进 cursor、不降级）；`src/internal/task-state/basic/batch.ts:91-95,111-118` | 同一不可行窗口在每次后续 eligible 事件上被重复重折、重复 error 日志，cursor 永久停在同一位置 |
| D10 | 【确认差异】 | §3.13 fork 默认重建 + 可选父 stable 一次性 bootstrap（须标 `inherited`）；§5.5 用 `inheritedEventCount`/`ownEvents()` 定边界（`:538-543`） | 全 src 检索 `inheritedEventCount|firstLiveSeq|isSeeded` 命中 0；`src/internal/task-state/basic/service.ts:353-354`（cursor 读已发布 stable ⇒ 无记录即 -1）；`src/internal/task-state/basic/batch.ts:97-102`（只按 seq/cursor 过滤整段日志） | "新 id ⇒ 全量重建"满足默认分支，但**无 inherited 标记、无一次性 bootstrap 选择、无 own-events 边界**；继承前缀语义只能靠 cursor=-1 隐式得到 |
| P1 | 【参数差异】 | §7 `stableInjectionMaxTokens = 2000`（token，`:599`） | `presets/contextual/agent.cordis.yml:61` = `8000` **字节**（消费点 `src/task-state-prompt.ts:38,55,71`） | 单位与默认值都不同：8 KB 字节 ≈ 2k–8k token，且不由 token 预算约束 |
| P2 | 【参数差异】 | §5.3 只说"有限基础设施重试"（`:518`），未规定退避 | `src/internal/task-state/basic/worker.ts:416-426`（`min(250*2^n, 4000)`） | 退避常量是插件自定值，方案无对应项；`timeoutMs 120000`/`maxInfraRetries 2` 与 §7 一致（`:642-643`） |
| X1 | 【需实验确认】 | §8 不变量 15：dispose 后不得提交（`:680`） | `src/internal/task-state/basic/worker.ts:354-360`（`if (this.disposed) return` 提前返回）；`src/internal/task-state/basic/service.ts:432-450`（`void` 异步 dispose）、`service.ts:167-179`（effect 再 dispose 同一 worker 后 `domain.close()` 于 `:178`） | 若 `session/disposed` 的异步 dispose 在飞而插件 fiber 同时收尾，effect 侧第二次 `dispose()` 立即返回、**不等待在飞 chain**，`domain.close()` 可能早于在飞存储调用结算；写侧仍有 `isOpen`/`admissionOpen` 门（`worker.ts:335-345`、`service.ts:485-495`）挡住提交，但"close 与在飞 put 的次序"需运行观测 |
| X2 | 【需实验确认】 | §5.5 fork 边界 | `src/internal/task-state/basic/batch.ts:97-102`；`src/internal/task-state/basic/service.ts:353-354` | fork 子会话首批（cursor=-1）是否把继承前缀中**已被 replacement 遮蔽的原始事件**一并折叠，无法静态判定（`snapshotEvents()` 返回整段日志） |
| X3 | 【需实验确认】 | §3.13 旧快照累积量级 | `src/task-state-prompt.ts:64-72`；DSH `调查资料/20:121`（`retained.text === snapshot` 早退） | 同源快照节点的实际数量、是否出现"文本回退即再追加"，以及被历史摘要回收的频率，需真实会话回放 |
| X4 | 【需实验确认】 | §5.6 注入与预算对账 | `src/internal/compaction/envelope-budget.ts:96-104`；`调查资料/20:160,287` | 注入节点进入 `surfaceTokens` 后，`E=T-S` 口径下三区边界是否会因注入抖动而漂移，未量化 |
| B1 | 【构建产物差异】 | — | `lib/task-state-basic.js`（含 `worker settle failed`、`worker cycle rejected unexpectedly`、`task-state-basic/session-disposed`）；`lib/task-state-prompt.js`（含 `task-state:snapshot`、`Durable task state (revision`、`Task-state snapshot truncated`）；时间 09/11 09:49:09 晚于 src 最新 09/11 09:44:06 | 工作区 `lib/` 与本次审计的 `src/` 行为同构，无反向 drift |
| B2 | 【构建产物差异】 | — | `审计资料/00:284,294`（tgz 09/10 20:51，20 个 src 之后修改）；`工作区基线.json:67-68`（`tgzStale: true`）；`审计资料/01` §7.4（`:321`，宿主装配读 `$DSH_HOME/profiles/web/node_modules/dsh-context-enhancement` 旧构建，`lib/task-state-basic.js` 哈希不同） | 宿主执行字节 ≠ 本次审计字节；D1–D10 的静态事实**不保证**是运行实例的现状（观测项 E4） |
| B3 | 【构建产物差异】 | — | `审计资料/01` §7.3（`:311-313`）：`lib/types/**/*.js` 是 tsdown 输入、运行时不可达；`exports` 的 types 一律指 `lib/types/*.d.ts` | `lib/types/internal/task-state/**` 的 `.js` 不构成运行时注入路径，不应据其判断行为 |

---

## 2. 确认差异逐条展开

### D1 / D2 注入节点既无 replacement，也无"仅最新"回收

- 插件只做两件事：注册一个 context 模板与一个变量 provider（`src/task-state-prompt.ts:56-63`、`:64-72`）。真正写节点的是 DSH：`RuntimeContextProjection.project()` 在每 step 的 `preStep` 求值一次，**仅当文本与最近一条仍可见的同源快照不同**才追加 `user/message`（`调查资料/20:117-122`、`:259`、`:280`）。
- 因此 stable 每变一次 = transcript 多一条 full snapshot；方案 §3.13 要求"用 Session replacement 替换上一个注入节点"（`理想化落地方案.md:238`），当前实现里没有任何 `session.append(..., { surfaceOp })` 属于注入路径（D1 证据列的 3 处 `surfaceOp` 全部属 compaction/pruner）。
- 方案同时要求节点保留 revision/sourceCursor/**生命周期引用**（`:239`）。当前节点文本只有 `revision/sourceCursor/digest`（`src/internal/task-state/prompt/render.ts:46`），无 lifecycle identity ⇒ 即使未来改造成 replacement，provenance 也需补 lifecycle 字段。
- 后果（静态可推）：注入体积随 stable 更新次数单调增长，唯一回收通道是主线程历史压缩，而该通道把注入节点当 `original`（D4）。

### D3 / P1 注入预算 I 不存在

- 部署只给出 `maxBytes: 8000`（`presets/contextual/agent.cordis.yml:61`），消费点是 `src/task-state-prompt.ts:38`（schema `.required()`）、`:55`、`:71`（传给 `renderTaskStateSnapshot`）。渲染确实严格不超预算（`render.ts:106-121`，整行丢弃 + 固定 marker，`render.ts:16`）。
- 但这是**单次渲染**的字节上限，不是预算体系里的 `I`：`src/internal/compaction/config.ts:36,43` 的 policy 键集合不含任何注入项；`resolveEnvelopeBudget` 的 `G = W - E - R - M`（`envelope-budget.ts:96-99`）与 `resolveEnvelopeZoneBudget`（`:253-268`）都不扣 I。
- 归因层面同样缺失：注入的 `user/message` 是普通 surface 节点，token-meter 无按来源分类字段（`调查资料/20:160,287`），`E = T - S` 会把注入成本摊进 surface 侧，但对账时无法单独读出"注入了多少"。

### D4 注入节点在来源索引里没有身份

- `SurfaceSourceKind` 只有 5 值（`source-index.ts:13`），没有 `stable-state-injection`；`classifyEvent` 对 `user/message` 的非 replacement 节点直接返回 `original`（`:98-110`，判定点 `:100`）。
- `canCompactHistory` 对 `original` 无条件为真（`:85-94`），遗忘摘要的 span 选择逐节点调用该判定（`src/compaction-basic.ts:555,1059`）⇒ 注入节点会作为普通历史内容被折叠进 history-summary。
- 相邻的保护机制只覆盖 compaction 自己的 checkpoint：`src/internal/compaction/selection-guard.ts:47-52`（`isCompactCheckpointSource`）与 `source-index.ts:112-116`；对 task-state 注入无任何特判。
- 方案侧要求（`理想化落地方案.md:557`）是"标为 `stable-state-injection`；老化进入遗忘区时只允许最新节点存在，旧节点已由 replacement 遮蔽"——两条（标记 + 仅最新）当前都不成立；"普通工具操作不处理"这条因工具操作只吃 tool segment 而偶然成立（E-13）。

### D5 无 staleness marker

- `renderTaskStateSnapshot(stable, maxBytes)` 是纯函数（`render.ts:106`），签名里没有 session、cursor 水位或 high-water（`src/internal/task-state/prompt/types.ts:16` 只有 `maxBytes`），`src/task-state-prompt.ts:64-72` 的变量 provider 也只把 `getStable(sessionId)` 的结果递进去。
- 方案 §5.6 要求"如果 stable cursor 落后当前 eligible high-water，显示明确 stale marker"（`理想化落地方案.md:555`）。当前实现连判定所需的数据都没有接进渲染路径；`digest` 虽渲染（`render.ts:46`），但它只能证明内容一致，不能表达"落后"。

### D6 渲染优先级倒置且缺 Goal/TODO 视图

- 当前顺序：header → `currentObjective`/`currentFocus`/`openWork`/`nextActions` → Facts → Decisions → Constraints → Risks → Evidence → TODO references（`render.ts:45-88`）。
- 方案顺序：Goal → TODO 与 focus/next → constraints/risks → decisions/facts → evidence（`理想化落地方案.md:547-553`）。因截断保留头部（`render.ts:113-118`），facts/decisions 会先占字节而 constraints/risks 先被丢弃，属**可观测的优先级倒置**。
- Goal/TODO 视图整体缺失同样来自数据模型：`TaskStateStable` 无 `goalView`/`todoView` 字段（`src/internal/task-state/contract/types.ts:153-174`），`todoReferences` 只保留 `{seq,content}`（`:108-110`）。注：Goal/TODO 权威关系属 §5.1/§3.9 范围，本批次只登记"§5.6 渲染优先级"这一条可观测差。

### D7 / D8 / D9 触发面三条

- urgent：observer 是单一路径（`service.ts:409-425`），判定只有 `isEligibleType` + `filterEvent !== null`；调度判定只有 `pendingEligible >= minEvents`（`worker.ts:158`）。`goal/change`、`todo/write` 与普通事件同权，且空 TODO 表在投影层被丢弃（`filter.ts:460-471`，`调查资料/15:88`）⇒ §3.10 的两个"urgent"子项（高优先级 + 空表必须采集）都不成立。
- startup/resume backlog：worker 构造时确实算出了正确的 backlog（`worker.ts:103-108`，`pending` = 末条 seq、`pendingEligible` = `env.eligibleCount`，实现见 `service.ts:471-482`），但没有任何地方在创建后调用 `maybeSchedule`（唯一调用点 `service.ts:422` 在 `session/event` 观察者内）⇒ 积压只能等下一个 eligible 事件。
- infeasible：`launch` 内 `folded.kind === 'infeasible'` 只记 error 并 return（`worker.ts:193-201`），不推进 cursor、不做降级投影；`recomputeEligible()` 后 `pendingEligible` 仍 ≥ 阈值，故下一个 eligible 事件会再次 `launch` → 同一窗口、同一 base（无提交）→ 再次 infeasible（`batch.ts:91-95` base 独立超预算，或 `:111-118` 首事件即超）。这是**稳定的重复失败回路 + cursor 永久停滞**，与 §5.2 `:506` 明确冲突。

### D10 fork bootstrap

- 无任何 fork/继承相关代码：`inheritedEventCount`、`firstLiveSeq`、`isSeeded` 在 `src/` 内 0 命中。
- 实际语义：fork 得到新 SessionId ⇒ `recordFor()` 无记录 ⇒ `committedCursor` 返回 -1（`service.ts:353`，经 `publishedStable` 的 `?? -1`）⇒ 首批 `foldBatchWindow` 从 seq 0 起折叠整段日志（`batch.ts:97-102`，过滤条件只有 `seq > cursor` 与 `seq <= windowEndSeq`）。
- 所以"默认基于子 Session 事件重建"这一默认分支事实上成立（含继承前缀），但方案要求的三个显式能力都不存在：①`inherited` 来源标记；②"父 stable 作为一次性 bootstrap 候选"的可选路径；③用 `ownEvents()`/`inheritedEventCount` 划继承边界（`理想化落地方案.md:243`、`:541-543`）。同时因为边界缺失，继承前缀里的被遮蔽事件是否会一并进入折叠无法静态确定（X2）。

---

## 3. 等价实现对照

| ID | 方案条目 | 实现（符号:行） | 为何等价 |
|---|---|---|---|
| E-1 | §5.3 在 `agent/created` 建 runtime、用 `agent.ctx.effect` 持有 worker/AbortController（`:510-511`） | `service.ts:145,403-407`（`session/created` **global** 观察者 + `ctx.sessions.get(id) === session` 校验）；`service.ts:167-179`（provider 级 `ctx.effect` 收尾）；`worker.ts:341`（worker 由 provider 构造，闭包捕获 `session`） | DSH 内 agent id 即 session id（`调查资料/21:189`），故"per-session"= "per-agent"；owner 由 agent scope 换成 provider fiber，但每个 worker 仍闭包住具体 `Session` 对象并以 `liveSession` 做身份核对（`service.ts:349-352`） |
| E-2 | §5.3 single-flight + 合并（`:512-513`） | `worker.ts:63-75`（`open/pending/pendingEligible/active/followUpRequested/chain/controller`）、`:156-164`（运行中只置 flag）、`:229-251`（提交后至多一个 trailing，trailing 不级联） | 与 `ScheduleRuntime` 的 `requested`+单飞+串行 drain 同构（`调查资料/21:91,139`），并额外保证 trailing ≤ 1 |
| E-3 | §5.3 observer 同步只抬水位 + microtask（`:512`） | `service.ts:411-415`（先过 filter 投影门）、`:421`（`observe`）、`:422-424`（`queueMicrotask(maybeSchedule)`）；`worker.ts:139-142`（纯计数） | 观察者栈内无 append/flush/model/storage，符合 `调查资料/21:127` 的"同步只入队/置标志"姿势 |
| E-4 | §5.3 AbortController 持有 | `worker.ts:262-263`（每 cycle 新建）、`:305`（`finally` 清引用）、`:358`（dispose 时 `abort`）；`update.ts:84,182,244`（signal 进 deadline 与请求） | 自持 per-cycle controller，取消语义与 `agent.runMaintenance` 的专属 signal 等价（`调查资料/21:35`） |
| E-5 | §5.3 模型 timeout | `update.ts:182`（`deadline(signal, timeoutMs, TASK_STATE_UPDATE_TIMEOUT_CODE)`）、`:204-206`（`Symbol.dispose`）、`:265-267,322-325`（`timeoutOf` 区分本层超时）、`worker.ts:57,92`（配置） | 使用 DSH 唯一正式超时库，且以自有 code 区分本层超时（`调查资料/21:194`） |
| E-6 | §5.3 有限基础设施重试后等后续 wave（`:518`） | `worker.ts:310-329`（上限 `maxInfraRetries`，每次 fresh attempt）、`:411-413`（仅 `TRANSIENT_LLM`/`TIMEOUT`）、`:416-426`（有界退避、abort 可打断）；`update.ts:313-315`（transient code 集） | 分类与方案 §8 的"失败不阻塞、等后续 wave"一致；`ABORTED`/确定性失败不重试（`worker.ts:325`） |
| E-7 | §5.3 dispose 关准入、abort、等 chain（`:514`） | `worker.ts:354-360`（`disposed/open=false` → `abort` → `await chain`）；`service.ts:167-179`（等全部 worker）+`:175`（drain repairs）+`:178`（close domain）；`service.ts:432-450`（session 级同序） | 满足"先停准入再排空"；`调查资料/21:195` 要求的"置停+清 timer+allSettled 在飞"形态（例外见 X1） |
| E-8 | §5.3 HMR 新 runtime 不接受旧完成回调（`:516`） | `worker.ts:117-119,124-127,335-345`（`isOpen` 门 + `putStable` 前抛 `SESSION_DISPOSED_ABORT_CODE`）；`service.ts:544-552`（`expectedRuntime` 不符即丢）、`:765-772`（session 身份核对）、`:311-338`（lifecycle 失配即 dispose 旧 worker） | 等价于 `调查资料/21:116-117` 的 liveness fence（身份重查 + lifetime 拒绝），且不依赖框架等待 |
| E-9 | §5.3 提交前查 live identity/lifecycle/base revision/worker token（`:515`） | `service.ts:519-533`（live session + 既有 record lifecycle 拒绝覆盖）、`:86-91`+`:455-465`（lifecycle 派生与匹配）；base revision 由单飞 chain 保证（`worker.ts:75,124-129`，`editStable` 同链 `service.ts:607-611`） | 进程内每 session 只有一个 writer + 一条串行 chain ⇒ 无需显式 CAS 也不会从同一 base 提交两个 N+1；跨进程 CAS 属存储范围（本批次不审） |
| E-10 | §5.3 失败不注入错误状态，继续用上一 stable（`:518`） | `update.ts:450-460`（put 失败 → `STORAGE` 失败，不写 stable）、`:466-489`（finished audit 失败只标 `auditGap`，不回滚）、`worker.ts:284-290`（失败不推进水位）；`render.ts:106`（渲染只读已发布 stable） | 无任何"错误快照/降级状态"进入模型可见文本；`getStable` 始终返回最近成功版本（`service.ts:775-778`） |
| E-11 | §3.13 注入节点不得成为 stable 输入（`:242`） | `filter.ts:221-228`（`directHumanKind` 只接受 `source.kind === 'user'`/`'goal'`）、`:291-299`；`service.ts:415`（`filterEvent === null` 的事件不计入阈值）；注入快照 source = `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt', form:'snapshot'}`（`调查资料/20:120`） | 注入节点虽为 `user/message`，投影层因 source 非 user/goal 直接丢弃 ⇒ 结构上不可能自反馈；比"按事件名排除"更强的白名单 |
| E-12 | §3.13 本 step 无 stable 或文本未变则不写节点（`:240`） | `src/task-state-prompt.ts:65-71`（无 session/无 provider 时返回 `''`）；DSH 侧 `joinContextSections` 空文本 + `project` 的 `retained.text === snapshot` 早退（`调查资料/20:100,121`） | 空渲染不产生节点；文本未变不新增同源节点。责任分工与方案不同（插件不参与判定），但该不变量的两个分支都成立 |
| E-13 | §5.6 普通工具操作不处理该节点（`:557`） | `src/internal/compaction/tool-segments.ts:17-20`（runtime-context 快照打断 tool segment，非其成员）、`:68`；`source-index.ts:81-84`（`isOriginalToolResult` 只认 `tool/result`） | 注入节点永远不在工具组/裁剪候选内 ⇒ 工具操作不会碰它（但历史摘要会，见 D4） |
| E-14 | §3.13 replacement 保留 revision/cursor（`:239`） | `render.ts:46`（`Durable task state (revision N, source event S, digest D)`） | 三个字段随节点呈现；缺 lifecycle 引用（已计入 D1） |
| E-15 | §5.6 注入读取最新 stable，无独立缓存（`调查资料/15:77`） | `src/task-state-prompt.ts:69-70`（每次 assembly 同步 `ctx.get('taskState')?.getStable(sessionId)`） | 同步无 IO、无插件侧缓存，stable 变更在下一个 step 的 assembly 立即可见 |
| E-16 | §5.3"受监管 job 或自持单飞 runtime"二选一（`:513`） | 自持单飞 runtime：`worker.ts:52-79`、`:204-226`；未使用 `ctx.jobs`/`runMaintenance`（全 src 检索仅 `src/compaction-basic.ts:1283` 使用 `runMaintenance`，属压缩侧） | 方案的"或"分支被显式满足，且避免 `runMaintenance` 非 idle 同步抛错与 `ctx.jobs` owner 上限抛错（`调查资料/21:141,190`） |
| E-17 | §5.5 resume 同 id 新 lifecycle 不覆盖旧记录（`:540`） | `service.ts:519-533`（lifecycle 不符即抛）、`:455-465`（`recordFor` 失配返回 undefined）、`:311-338`（runtime 身份失配重建） | resume 的同 id 新 lifecycle 会走"拒绝覆盖 + 重建 runtime"，等价于方案的 identity fence |

---

## 4. 需实验确认（静态不可判）

| ID | 观测目标 | 最小观测点 | 为什么静态不可判 |
|---|---|---|---|
| X1 | `session/disposed` 在飞的 worker dispose 与 provider fiber 收尾的次序；`domain.close()` 是否可能先于在飞 audit/stable 存储调用结算 | 打点 `worker.ts:354-360` 的两次调用时序与 `service.ts:178` 的 `domain.close()`；观察是否出现 dispose 期"存储调用晚于 close"的告警 | 二次 `dispose()` 提前返回是确定性代码事实（`worker.ts:355`），但两个异步路径的相对次序取决于 fiber 卸载与观察者的调度，源码不可判 |
| X2 | fork 子会话首批是否折叠继承前缀中的**被遮蔽**原始事件 | 造 fork 会话（含 replacement），dump `foldBatchWindow` 的 `includedSeqs` | `snapshotEvents()` 是否含全部历史事件、以及 filter 是否关心 surface 成员关系，属运行语义 |
| X3 | 同源注入节点累积曲线与回收情况 | 真实会话回放，统计 `source.kind==='plugin' && form==='snapshot'` 的 surface 节点数与 stable 更新次数 | `project()` 的 `retained` 回放/增量维护仅在运行时成立（`调查资料/20:121`） |
| X4 | 注入体积对三区边界/压力口径的实际影响 | 同会话对比"开/关 task-state-prompt"的 `totalTokens`/`surfaceTokens` 与边界 | `E=T-S` 中注入落在 S 侧，偏移量级属量化问题（`调查资料/20:287`） |

---

## 5. 未覆盖 / 边界声明

- 合并内容质量（`src/internal/task-state/basic/prompt.ts` 措辞、`host.ts` 语义校验强度、filter 字段取舍）不在本批次。
- 存储 backend、CAS、多实例、审计 repair 的事务性不在本批次（仅在 E-9 处声明"进程内单飞替代 CAS"这一等价性）。
- 主线程压缩算法（三区、批次、overflow 等级）不在本批次；引用 `src/internal/compaction/**` 只为判定**注入节点的身份与保护**。
- GUI/客户端不审：`src/client/**`、`src/internal/task-state/control/**` 未纳入证据。
- 未重新调查 DSH；DSH 侧结论一律引用 `调查资料/10,15,20,21`。

### 5.1 委托审计维度 → 判定索引（11 项全覆盖）

| 委托维度 | 判定 | 主要证据 |
|---|---|---|
| runtime owner | 【等价实现】E-1 | `service.ts:403-407,167-179`；`worker.ts:341` |
| single-flight / coalescing | 【等价实现】E-2 | `worker.ts:156-164,229-251` |
| AbortSignal | 【等价实现】E-4 | `worker.ts:262,305,358`；`update.ts:182,244` |
| dispose / HMR fence | 【等价实现】E-7/E-8；残留竞态 【需实验确认】X1 | `worker.ts:354-360`；`service.ts:544-552,311-338` |
| event observer 不阻塞 | 【等价实现】E-3 | `service.ts:411-424` |
| 模型 timeout / retry | 【等价实现】E-5/E-6；退避常量 【参数差异】P2 | `update.ts:182,265-267`；`worker.ts:310-329,416-426` |
| 固定注入节点 replacement | 【确认差异】D1（含生命周期引用缺失） | `src/task-state-prompt.ts:56-72`；`调查资料/20:280` |
| 注入预算 | 【确认差异】D3 + 【参数差异】P1 | `agent.cordis.yml:61`；`envelope-budget.ts:96-104` |
| 旧快照累积 | 【确认差异】D2/D4；量级 【需实验确认】X3 | `render.ts:106-121`；`source-index.ts:100` |
| 自反馈排除 | 【等价实现】E-11 | `filter.ts:221-228,291-299`；`service.ts:415` |
| fork bootstrap | 【确认差异】D10；继承前缀遮蔽 【需实验确认】X2 | `service.ts:353-354`；`batch.ts:97-102` |

**本批次读取/引用的实现与配置文件（17 个，另加 2 个产物字符串探针，合计 ≤20）**：`src/internal/task-state/basic/{worker,service,update,filter,batch,types}.ts`、`src/internal/task-state/prompt/{render,types}.ts`、`src/task-state-prompt.ts`、`src/internal/task-state/contract/types.ts`（grep）、`src/internal/compaction/{source-index,envelope-budget,selection-guard,tool-segments,config}.ts`、`src/compaction-basic.ts`（grep 行号）、`presets/contextual/agent.cordis.yml`、`lib/task-state-basic.js` + `lib/task-state-prompt.js`（字符串探针）。

---

## 6. 结束核对（baseline）

| 项 | 基准（`审计资料/工作区基线.json`） | 本次审计结束 | 判定 |
|---|---|---|---|
| modified | 102 | 102 | 一致 |
| untracked | 31 | 32（唯一增量 = `审计资料/`，前序审计目录；本文件落在同一目录内） | 仅审计产物，非源码/配置 |
| total dirty | 133 | 134 | 差值 = 审计目录 |
| modified 清单内容 | 00 §1.3 的 20 个 src 文件 + lib/tests/docs/root | 逐项比对一致（含 20 个 src） | 无源码/配置 drift |
| DSH 工作区 | dirty 0（`审计资料/00:364`） | 未触碰 | 一致 |

- 本批次**未**构建、未运行测试、未安装、未还原、未修改任何既有文件；唯一写入 = 本文件。
- 结论：**无源码/配置 drift**；`审计资料/` 目录的新增属审计产物增长，其内容的基线解释见 §1 的 B2 行（供后续批次按同一口径对账）。
