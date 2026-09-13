# 20 Stable 输入·触发 与 Goal/TODO 差异（对照理想方案 §3.9–3.10、§5.1–5.2）

> 工作区：`C:\Users\chuxi\Documents\trae_projects\code\dsh-context-enhancement`（133 项未提交变更，只读）。
> 本轮**未修改/未格式化/未构建/未测试/未安装/未还原**任何既有文件，未运行实例、未看 watcher、未读用户 settings、未派生子代理；只新增本文件。
> 已读前置：`审计资料/工作区基线.json`、`审计资料/00-工作区基线与构建产物.md`、`审计资料/01-插件装配与配置生效链.md`、`理想化落地方案.md`、`调查资料/10-插件架构与DSH集成地图.md`、`调查资料/17`、`调查资料/04`、`调查资料/15`。DSH 未重新调查。
> 分类标记：【确认差异】当前设计与方案要求语义不同；【等价实现】机制不同但满足同一要求；【参数差异】仅取值/缺省不同；【需实验确认】静态不可判；【构建产物差异】同一设计在构建产物中不同。

## 0. 范围与文件

- 论题：Stable Task State 的**输入、触发、Goal/TODO 权威关系**（不含 compaction、不含 control/GUI、不含 client）。
- 核心实现/配置/测试文件 21 个（≤18 实现/配置 + 测试交叉验证）：
  实现：`src/internal/task-state/basic/{service,worker,batch,filter,host,prompt,config,domain,types,update}.ts`、`src/internal/task-state/contract/types.ts`、`src/internal/task-state/prompt/{index,render}.ts`、`src/task-state-prompt.ts`、`cordis.patch.yml`、`presets/contextual/agent.cordis.yml`、`package.json`。
  构建产物核对：`lib/task-state-basic.js`（export `./task-state-basic` 所指）。
  测试交叉验证：`tests/task-state-{filter,worker,batch,long-session,restart-recovery,host,update,prompt}.spec.ts`。

## 1. 结论速览

1. **权威关系**：插件侧对 Goal/TODO 事实确无第二写权限——`src/**` 无 `ctx.goals` / `append('goal…')` / `append('todo…')`；但 stable 契约**没有 `goalView` / `todoView` 承载位**，从不在提交时由 Host 覆盖（`理想化落地方案.md` §5.1:479 要求 "Host 在提交时覆盖 goalView/todoView"）→ 目标叙事与 TODO 视图完全由辅助模型自由累积。**这是"旧目标叙事保留"的根因之一。**
2. **触发**：只有一条路径 `pendingEligible >= minEvents`（`worker.ts:158`）。无 urgent 分类、无 `urgentDebounceMs`、无 `startupBacklogUpdate`（§3.10:185-202、§5.2:500-506）→ goal/change 与 todo/write 在计数上与普通进展事件**等权**（各 1），goal 完成/阻塞或 TODO 整表替换后要再等最多 19 个有效事件才提交快照。**这是"旧目标叙事保留"的第二根因。**
3. **空 TODO 表**：`filter.ts:463` 丢弃 `{todos:[]}` → 不计阈值、不进投影、不推进游标，"清空待办"对插件不可见（§3.10:201、§8:673 明确要求采集并清空 todoView）。
4. **startup backlog**：worker 构造期把 `pendingEligible` 初始化为真实可投影积压数（`worker.ts:108`），但**没有任何后续调度**（全仓 `maybeSchedule` 唯一非测试调用点是 `service.ts:423` 的事件 observer）→ resume/restart 后若 stable cursor 之上有积压而**没有新事件**，一次 wave 都不会开（§5.2:504、§8:676）。
5. **infeasible**：单事件超整帧即终态失败，**不派发、不推进游标、不自发重试**（`batch.ts:111-118`、`worker.ts:193-202`）→ 该事件卡在游标之上；§5.2:506 要求"进入确定性降级投影，不允许永久卡住 cursor"。当前设计无降级路径。
6. 等价实现（不少于 6 项）：goal/change 全快照不再二次累积；clear 墓碑被采集；非空 TODO 整表采集；失败保留旧 stable 且不重放同一窗口；active 期间的需求合并为一个 follow-up wave；cursor 单调 + 生命周期栅栏。
7. 旧叙事保留的直接判定：**D2 / D3 / D5** 是主因（结构缺位），**D1 / D4 / D8** 是延迟（时效）因。详见 §3、§4。

## 2. 权威关系矩阵（§3.9:174-183、§5.1:441-479）

| # | 分类 | 理想要求 | 当前设计（路径·符号·行） | 证据 | 影响 | 需实验 |
|---|---|---|---|---|---|---|
| A1 | 【确认差异】 | Stable 可引用 Goal/TODO，但不得形成可独立漂移的第二权威（§3.9:183） | `TaskStateStable` 无 `goalView`/`todoView` 字段；视图语义全部落在模型可自由改写的 `continuation.currentObjective/currentFocus/openWork/nextActions`（`contract/types.ts:153-174`；`basic/prompt.ts:34-45` 允许模型输出这四个字段） | `contract/types.ts:153-174`、`basic/prompt.ts:40-45`、`basic/prompt.ts:55` | 目标叙事可独立漂移；模型不回写 goal 事实但可长期保留与 goal 不符的表述 | 否（静态） |
| A2 | 【确认差异】 | Goal/TODO view 由**最新权威事件**确定，Host 提交时覆盖（§5.1:479） | 提交入口 `commitStable(content, …)` 只拼装 `schemaVersion/revision/filterVersion/sourceCursor/digest + content`，**无任何 Host 侧视图覆盖**（`basic/host.ts:233-253`） | `basic/host.ts:233-253`、`basic/update.ts:425-434` | 即使 goal 已 clear/complete，stable 也不被强制改写；只能等模型自发改写 | 否 |
| A3 | 【确认差异】 | todoView 含 `status: current / cleared / none`（§5.1:460-464） | 只有 `todoReferences[{seq, content}]`，**无 status、无 sourceSeq 权威指针、无清空表达**（`contract/types.ts:106-111`） | `contract/types.ts:106-111`、`prompt/render.ts:82-87`（渲染为 "TODO references:" 平铺列表） | "当前 TODO 未知/已清空"无法表达，注入面呈现为仍然有效 | 否 |
| A4 | 【确认差异】 | Stable 中的目标视图按最新 goal revision **替换**，不追加多个目标叙事（§3.10:202） | 投影捕获 `goal.id`/`goal.revision`（`filter.ts:385-386`），但 `revision` 只作投影文本喂给模型；已提交 stable 无 goal 身份字段，也无"新 revision 覆盖旧叙事"的机制 | `filter.ts:374-403`、`basic/prompt.ts:89-111`（`contentOfStable` 无 goal 字段） | 同一 Session 内多次 create/complete 后，历史目标叙事可被模型保留在 facts/continuation | 否 |
| A5 | 【等价实现】 | 插件不写 Goal/TODO 权威 | 只读事件；`src/**` 无 `ctx.goals`、`append('goal`、`append('todo`；todo 只存引用 | `调查资料/17` §8（复核 `filter.ts:11-15` 自述只读） | 对 Goal/TODO **事实不构成双权威** | 否 |
| A6 | 【等价实现】 | goal revision 变化由权威侧驱动 | 插件不比较 revision、不做去重/乱序检测（`filter.ts:386` 仅抄录）；DSH 侧 CAS 由 `packages/goal/**` 负责 | `filter.ts:386`、`调查资料/04` §2 | 与 A4 不冲突：缺的是"替换机制"，不是"比较逻辑" | 否 |
| A7 | 【确认差异】 | 人工/GUI 路径不得修复或固化陈旧引用 | `resolveManualContent` 对 `evidence`/`todoReferences` **原样保留**（`basic/service.ts:759-760`） | `basic/service.ts:759-760` | 人工编辑无法清除陈旧 TODO 引用/陈旧目标叙事 | 否 |

## 3. 触发路径矩阵（§3.10:185-202、§5.2:481-506）

| # | 分类 | 理想要求 | 当前设计（路径·符号·行） | 证据 | 影响 | 需实验 |
|---|---|---|---|---|---|---|
| B1 | 【确认差异】 | urgent = `goal/change`（含 clear）+ `todo/write`（含空表）+ 用户明确纠正/撤销；urgent **不等 minEvents**（§3.10:190-199、§8:672） | 唯一触发：`maybeSchedule()` 只判 `pendingEligible < minEvents` 即返回（`worker.ts:156-164`）；`observe()` 对一切可投影 eligible 事件 `+1`（`worker.ts:139-142`，经 `service.ts:411-421` 两道过滤） | `worker.ts:139-164`、`service.ts:409-425` | goal 完成/阻塞、TODO 整表替换后，stable 仍可能滞后最多 19 个事件才刷新；**旧目标叙事在此期间持续注入** | 是（量化延迟分布） |
| B2 | 【确认差异】 | 事件分 Authority / Progress 两类（§5.2:485-486） | `ELIGIBLE_TYPES` 仅一维白名单（13 类，`filter.ts:502-522`），**无类别/优先级维度**；`TaskStateFilteredEvent` 只带 `seq/type/fields` | `filter.ts:502-522`、`basic/types.ts`（过滤事件类型） | urgent 通道的实现无落点；需在 filter 或 service 增类别判定 | 否 |
| B3 | 【确认差异】 | 多个连续 urgent 可短时间 debounce/coalesce，debounce 后立即 wave（§3.10:200、§5.2:503、§7:638 `urgentDebounceMs 200`） | **无定时器、无 debounce**；调度只有事件后 `queueMicrotask(maybeSchedule)`（`service.ts:422-424`）；当前"合并"只体现为水位快照 + 单飞 | `service.ts:422-424`、`worker.ts:171-176`（launch 时快照 `windowEnd = pending`） | urgent 突发目前退化为"等阈值"；一旦补 urgent，仍需 debounce 才能把多次 goal/todo 写合并为一 wave | 是（补 urgent 后的突发合并行为） |
| B4 | 【确认差异】 | `startupBacklogUpdate: true`：stable cursor 之后存在 eligible backlog 时主动 schedule 一次（§5.2:504、§8:676、§7:644） | worker 构造期**读取**积压数（`this.pendingEligible = this.env.eligibleCount(...)`，`worker.ts:106-108`），但构造后无调度；`runtimeFor`（`service.ts:339-379`，含 387-397 的 stable 播种）不触发 wave；`maybeSchedule` 全仓非测试调用点只有 `service.ts:423` | `worker.ts:103-109`、`service.ts:403-425`、`service.ts:188-195`（启动播种循环） | resume/restart 后若无新事件：stable 永远停在旧 revision，旧叙事无更新也无 stale 标记 | 是（resume 后无新事件场景） |
| B5 | 【等价实现】 | active 期间新需求合并为一个 follow-up wave（§5.2:505） | `followUpRequested` 置位 + 提交后最多一个 trailing；trailing 不级联；失败不自调度（水位保留） | `worker.ts:71`、`worker.ts:229-251`、`worker.ts:284-290` | 满足"合并为一个 follow-up"；与 §5.2 的差异仅在于触发源（阈值 vs urgent） | 否 |
| B6 | 【等价实现】 | 观测者同步只抬水位并 microtask（§5.3:512） | `observe()` 同步 + `queueMicrotask(maybeSchedule)`；observer 栈内不做 append/flush/model/storage | `service.ts:418-424`、`worker.ts:132-142` | 一致 | 否 |
| B7 | 【参数差异】 | §7 基线：`minEvents 20 / maxEvents 200 / maxInputBytes 60000 / maxOutputTokens 4000 / timeoutMs 120000 / maxInfraRetries 2`（§7:636-643） | 部署值逐项相同（`cordis.patch.yml:44-56`）；`maxEvents>=minEvents` 有校验（`basic/config.ts:69-71`、`service.ts:102-114`） | `cordis.patch.yml:44-56`、`basic/config.ts:17-71` | 无参数差异；但**缺** `urgentDebounceMs`/`startupBacklogUpdate`/`multiInstanceMode`（见 B1/B3/B4/F3） | 否 |
| B8 | 【确认差异】 | 用户"明确纠正目标或撤销既有决策"是 urgent 来源（§3.10:193） | 无任何检测点：既无事件类型（撤销/纠正无独立事件），也无 `user/message` 内容启发式；`directHumanKind` 只区分 `user`/`goal`（`filter.ts:291-299`） | `filter.ts:291-299`、`basic/prompt.ts:29-58`（system 不含权威判定） | "用户中途改目标"只能靠普通阈值延迟到达 stable | 是（是否需要，取决于产品定义） |

## 4. Cursor / 窗口 / 降级矩阵（§5.2:488-506、§5.4:530-536）

| # | 分类 | 理想要求 | 当前设计（路径·符号·行） | 证据 | 影响 | 需实验 |
|---|---|---|---|---|---|---|
| C1 | 【等价实现】 | cursor 单调、只随成功提交推进 | `sourceCursor = 最后折叠 eligible seq`（`update.ts:425`）；失败/infeasible 不推进（`worker.ts:284-290`、`worker.ts:193-202`）；`committedCursor` 只读已发布指针（`service.ts:353`） | `update.ts:425-434`、`worker.ts:284-302` | 一致 | 否 |
| C2 | 【等价实现】 | 窗口端点用高水位快照，运行期到达的事件属于下一 wave | `pending` 为最高观测 seq（含非 eligible），launch 时快照 `windowEnd = pending`（`worker.ts:171-176`）；`foldBatchWindow` 只取 `cursor < seq <= windowEnd`（`batch.ts:97-99`） | `worker.ts:64-68,171-185`、`batch.ts:97-99` | 一致 | 否 |
| C3 | 【确认差异】 | infeasible 单事件进入**确定性降级投影**，不允许永久卡住 cursor（§5.2:506） | 单事件（或 base 单独）超 `maxInputBytes` → `kind:'infeasible'`，worker 记 error、`recomputeEligible()`、**return，不派发、不推进、不自发重试**（`batch.ts:90-95,111-118`；`worker.ts:193-202`） | `batch.ts:111-118`、`worker.ts:193-202`；测试仅断言 `kind==='infeasible'`（`tests/task-state-batch.spec.ts:80-118`） | 超大 `goal/change`（objective 截断后仍超帧）或超大 `todo/write` 会让该窗口**每次重折都失败**→ 该事件之上的所有进展都不再提交，stable 永久停在旧 revision；**旧目标叙事永久保留** | 是（构造大事件验证是否永久停滞，还是被后续窗口带走） |
| C4 | 【确认差异】 | 冲突后重读 stable、重新折叠未处理窗口（§5.4:534）；stable CAS 不被违反（§8:674） | `putStable` 是 `sessions.put(id, record)` 整条替换，**不比较 expectedRevision**（`service.ts:519-541`）；仅生命周期栅栏 + 内存乐观检查（`service.ts:529-533`；`editStable` 的 `current.revision !== expectedRevision`，`service.ts:629-631`） | `service.ts:519-541`、`service.ts:629-631` | 单进程内由 `chain` 串行化而安全；跨进程/多实例无 CAS（承接 §3.11/§3.12，非本专题核心） | 是（多实例） |
| C5 | 【等价实现】 | 每次提交前检查 live session identity 与 lifecycle | `putStable` 校验 `ctx.sessions.get(id) === session`；lifecycle 失配拒绝覆盖；发布只认 `runtime.session === live` | `service.ts:519-533`、`service.ts:544-552`、`service.ts:764-772` | 一致 | 否 |
| C6 | 【参数差异】 | §3.11 固定支持级别：`singleWriterOnly` 声明 / SQLite 记录级 / fail-closed（§3.11:204-212） | domain 为 `layout:'single'`（`basic/domain.ts:37-45`），无 writer 租约、无 second-writer 拒绝、无模式声明 | `basic/domain.ts:37-45` | 与本专题"输入/触发"相邻但**超出 Goal/TODO 语义**；登记为参数/后端差异，交多实例专题综合 | 否 |

## 5. Goal/TODO 输入采集矩阵（§3.10:201、§5.1:452-464）

| # | 分类 | 理想要求 | 当前设计（路径·符号·行） | 证据 | 影响 | 需实验 |
|---|---|---|---|---|---|---|
| D1 | 【确认差异】 | 空 TODO 表必须被采集，表达"当前 TODO 已清空"（§3.10:201、§8:673） | `if (!Array.isArray(todos) \|\| todos.length === 0) return undefined` → `filterEvent === null` → `service.ts:415` 直接返回：不计阈值、不投影、不进 `includedSeqs` | `filter.ts:460-471`、`service.ts:411-421`；测试 `tests/task-state-filter.spec.ts:229-230` 明确断言 `toBeNull()` | 清空待办对 stable 不可见；旧 `todoReferences` 在下一次成功提交前仍被渲染为有效（`render.ts:82-87`） | 否 |
| D2 | 【确认差异】 | 空 TODO 表"推进 stable 并清空 todoView"（§8:673） | 既无 todoView（A3），也无"清空"语义；且空表事件因 D1 连 `sourceCursor` 都不推进 | `filter.ts:463`、`batch.ts:101-102`（`filtered === null` 即 `continue`） | "清空"永远不能成为 stable 的已提交事实 | 否 |
| D3 | 【确认差异】 | todoView 由最新权威事件确定（§5.1:479） | `todoReferences` 由模型在候选里给出，Host 只校验"`seq` 是否落在本窗口 `includedSeqs`"，窗外即 quarantine 丢弃（`host.ts:172-182`）；**无"最新一次 todo/write 覆盖旧引用"的强制** | `host.ts:172-182`、`basic/prompt.ts:54`（指令："only durable todo lists already shown in the projection"） | 若模型重复 echo 旧 `todoReferences` 且旧 seq 恰好又落进本窗口，陈旧 TODO 可长期驻留；模型是唯一裁决者 | 是（观察真实会话中陈旧引用寿命） |
| D4 | 【等价实现】 | `todo/write` 整表替换语义被保留 | 非空表逐项采 `{content(≤stateBytes), status}`，整表一条投影（`filter.ts:464-470`）；与 `调查资料/04` §3 的全表替换一致 | `filter.ts:460-471`、`调查资料/04` §3 | 一致（无 id、无 diff 正是原生语义） | 否 |
| D5 | 【确认差异】 | Goal/TODO view 为 stable 的一等字段，注入按"当前 Goal → 当前 TODO → …"优先级渲染（§5.6:547-553） | stable 无 goalView/todoView；渲染顺序为 header → continuation（含模型写的 currentObjective）→ 四表 → Evidence → TODO references（`render.ts:44-89`）；**没有"当前 Goal"段** | `render.ts:44-90`、`basic/types.ts`（stable 内容结构） | 模型看到的"当前目标"是辅助模型的历史表述，而非权威 goal 快照；与 `调查资料/17` §8"任务叙事二次表述"风险同源 | 否 |
| D6 | 【确认差异】 | 注入记录 `staleness`，cursor 落后 eligible high-water 时显示 stale marker（§5.6:555） | 头行恒为 `revision/sourceCursor/digest`，唯一的标记是长度截断 `TASK_STATE_TRUNCATION_MARKER`（`render.ts:16,46`）；无时效标记 | `render.ts:16,44-47,111-120` | 陈旧快照看起来与新鲜快照无异；结合 D1/B1 会让"旧目标/旧 TODO"难以被模型识别为过期 | 否 |
| D7 | 【等价实现】 | goal/change 全快照、含 clear 墓碑；无 goal 不虚构 | 全快照投影 `operation/goal{id,revision,phase,objective,maxGoalRounds,roundsStarted,blockedReason.code}`；`clear` 早返回 `{operation:'clear'}`；非对象/无 goal → `undefined` → 不入投影不计阈值 | `filter.ts:374-403`、`filter.ts:377`；测试 `tests/task-state-filter.spec.ts:423-429` | 与 `调查资料/04` §1-2 一致 | 否 |
| D8 | 【确认差异】 | 大变更（如一次写 40 条 TODO、goal revision 跳变）即时生效 | goal/change 与 todo/write 各计 **1**，与载荷、revision 跳变幅度、列表长度无关（`worker.ts:139-142`）；`maxEvents/maxInputBytes` 只截窗口不触发（`batch.ts:100,111-120`） | `worker.ts:139-164`、`batch.ts:100-120` | 与 B1 同源：越大的权威变更越可能因占用预算而**推迟**后续提交（`调查资料/17` Q4 已证） | 是 |

## 6. 构建产物差异核对（仅核对 export 所指 lib 是否承载同一设计）

| # | 分类 | 证据 | 结论 |
|---|---|---|---|
| E1 | 【无差异】 | `lib/task-state-basic.js`：`:417` `operation === "clear"`、`:487` `todos.length === 0`、`:887/:915` `"infeasible"`、`:1443/:1472` `pendingEligible` 初始化与 `+= 1`、`:1485-1487` `maybeSchedule` 阈值、`:1985` `runtime.worker.maybeSchedule()` | 与 `src` 同设计、同行号语义一一对应 |
| E2 | 【无差异】 | 全 `lib/**` 检索 `urgentDebounceMs` / `startupBacklogUpdate` / `goalView` / `todoView`：**0 命中** | 差异不是"src 有而 lib 无"，而是两侧都缺 |
| E3 | 【参数差异】 | 基线 hash：`lib/task-state-basic.js = 6BF1AD71…`、`src/task-state-basic.ts = 93F18075…`，与 `工作区基线.json` 一致 | 本专题无构建产物差异 |

## 7. 等价实现汇总（不只是差异）

1. **不写回 Goal/TODO**：`src/**` 无 `ctx.goals`/`append('goal`/`append('todo`（A5）。
2. **goal/change 全快照 + clear 墓碑 + 畸形丢弃**（D7，`filter.ts:374-403`）。
3. **非空 TODO 整表采集**（D4，`filter.ts:464-470`）。
4. **cursor 单调、失败不推进、不重放同一窗口**（C1/B5，`update.ts:425`、`worker.ts:284-290`、`worker.ts:229-251`）。
5. **active 期需求合并为一个 follow-up + 至多一个 trailing + trailing 不级联**（B5，`worker.ts:246-251`）。
6. **observer 栈只抬水位，模型/存储/append 均在栈外**（B6，`service.ts:418-424`）。
7. **生命周期栅栏 + 发布只认 live session**（C5，`service.ts:519-552`）。
8. **窗外引用 quarantine 而非整候选失败**：防止 stable 永久冻结在旧 revision（`host.ts:153-182`，设计意图与 §8:676 同向；但与 D3 结合会保留陈旧 TODO 引用，是**权衡而非纯缺陷**）。
9. **审计失败不回滚 stable、repair 不重跑模型**（`update.ts:461-489`、`service.ts:232-258`）。

## 8. 影响结论：哪些差异会导致"旧目标叙事保留"

| 层级 | 差异 ID | 机制 | 后果 |
|---|---|---|---|
| 结构缺位（决定性） | **A1、A2、A4、D5** | stable 没有 goalView，也没有 Host 提交时覆盖 | 目标叙事由辅助模型自由累积/改写；权威 goal 与注入叙事之间无强制对齐 |
| 结构缺位（决定性） | **A3、D1、D2、D3** | 无 todoView.status；空表丢弃；引用由模型裁决 | "TODO 已清空/已变化"无法成为 stable 事实；旧 TODO 引用可在注入面继续显示 |
| 时效延迟（放大器） | **B1、B2、B8、D8** | 无 urgent 分类与 debounce；goal/todo 与普通事件等权 | goal 完成/阻塞或 TODO 替换后，快照滞后最多 19 个事件 |
| 停滞与不可撤销 | **C3、D6** | infeasible 无降级 → cursor 永久卡住；注入无 stale marker | 一旦卡住，旧叙事**永久**保留且看不出过期 |
| 人工路径 | **A7、D3** | manual edit 原样保留 evidence/todoReferences | 无法通过 GUI 修正陈旧叙事 |
| 相邻（非本专题裁决） | **C4、C6** | 无 stable CAS、`single` 布局无 single-writer 声明 | 多实例下"旧叙事覆盖新叙事"风险（承接 §3.11–3.12） |

## 9. 需实验确认项（静态不可判，共 7 项）

| 实验 ID | 关联差异 | 验证内容 | 建议观测点 |
|---|---|---|---|
| EXP-1 | B1 / D8 | 真实会话中 goal/change 或 todo/write 之后，stable 刷新延迟（事件数、wall time、token）分布 | `context_enhancement_task_state.sessions[..].stable.revision/sourceCursor` 与 Session 事件序的差值 |
| EXP-2 | B3 | 补 urgent 后，连续 goal/todo 突发是否被合并为一次 wave（debounce 窗口内） | worker `launch('threshold')` 次数 vs urgent 事件数 |
| EXP-3 | B4 | resume/restart 后 stable cursor 之上存在积压且**无新事件**时，是否永不提交 | 启动后 N 分钟内 `revision` 是否变化；仅 `session/event` 触发可复现 |
| EXP-4 | C3 | 构造单事件超 `maxInputBytes`（如超长 objective 的 goal/change、数百条 TODO）后，后续事件能否带走该窗口 | 是否出现 `revision` 长期不变 + 周期 `infeasible` error 日志 |
| EXP-5 | D3 | 真实会话中陈旧 `todoReferences` 的驻留寿命（模型是否持续 echo） | 连续若干 revision 的 `todoReferences` seq 集合变化 |
| EXP-6 | B8 | 用户中途改目标（"别再做了/改做 X"）是否需要独立 urgent 通道 | 该类消息到 stable 刷新的延迟 |
| EXP-7 | C4 / C6 | 双进程同 `$DSH_HOME` 下是否出现整文档 LWW 覆盖 | 两次并发 put 后的 `revision` 与内容一致性 |

## 10. Baseline drift 检查（依据 `审计资料/工作区基线.json`）

| 项 | 基线 | 本次结束实测 | 结果 |
|---|---|---|---|
| `git status --porcelain` 总数 | 133 | **134** | 仅 +1，为本轮新增 `审计资料/20-长期状态输入触发与GoalTodo差异.md`（`?? 审计资料/` 计数内） |
| Modified | 102 | **102** | 一致 |
| Untracked | 31 | **32** | +1 = 上述新增审计文档 |
| `package.json` SHA-256 | `20454835…6702E9` | 同 | 一致 |
| `pnpm-lock.yaml` | `385431F7…C135F4` | 同 | 一致 |
| `src/index.ts` | `5F53AEAB…413F20B` | 同 | 一致 |
| `cordis.patch.yml` | `95E8C9C0…268FE` | 同 | 一致 |
| `理想化落地方案.md` | `12734F96…92435` | 同 | 一致 |
| `src/compaction-basic.ts` | `5585C60D…6B653` | 同 | 一致 |
| `src/task-state-basic.ts` | `93F18075…85F3C3` | 同 | 一致 |
| `src/tool-result-pruner.ts` | `BF126FF0…25DE1` | 同 | 一致 |
| `src/internal/compaction/config.ts` | `C8801BA4…960F8E` | 同 | 一致 |
| `lib/index.js` | `921F8F66…A20510` | 同 | 一致 |
| `lib/compaction-basic.js` | `4718F3AD…CBC0D1` | 同 | 一致 |
| `lib/task-state-basic.js` | `6BF1AD71…060825A` | 同 | 一致 |
| `lib/tool-result-pruner.js` | `5E8D5CB5…CA1F1C9` | 同 | 一致 |
| `dsh-context-enhancement-0.1.10.tgz` | `BE9DE3DE…65A7E40` | 同 | 一致 |
| `src/**` 最新 mtime | 2026-09-11T09:44:06 | 同（`src/compaction-basic.ts`） | 一致 |
| `lib/**` 最新 mtime | 2026-09-11T09:49:09 | 同 | 一致 |
| DSH 工作区 | commit `a66e470`, dirty 0 | 未触碰 | 一致 |

**结论：原有源码/配置/构建产物零漂移（仅新增本审计文档 1 项）。**

## 11. 供综合矩阵引用的差异 ID

| ID | 一句话 | 分类 | 主证据 | 需实验 |
|---|---|---|---|---|
| `DIF-STABLE-GOALVIEW-MISSING` | stable 无 goalView，Host 提交不覆盖目标视图 | 确认差异 | `contract/types.ts:153-174`、`host.ts:233-253` | 否 |
| `DIF-STABLE-TODOVIEW-MISSING` | stable 无 todoView（无 status/sourceSeq） | 确认差异 | `contract/types.ts:106-111` | 否 |
| `DIF-STABLE-MANUAL-KEEPS-STALE-REFS` | 人工编辑原样保留陈旧引用 | 确认差异 | `service.ts:759-760` | 否 |
| `DIF-GOAL-REVISION-NO-REPLACE` | goal revision 不驱动叙事替换 | 确认差异 | `filter.ts:385-386`、`prompt.ts:89-111` | 否 |
| `DIF-TRIGGER-NO-URGENT-CLASS` | 无 Authority/Progress 分类，goal/todo 与普通事件等权 | 确认差异 | `filter.ts:502-522`、`worker.ts:139-164` | 是 |
| `DIF-TRIGGER-NO-URGENT-BYPASS` | urgent 事件仍需等 `minEvents` | 确认差异 | `worker.ts:156-164` | 是 |
| `DIF-TRIGGER-NO-DEBOUNCE` | 无 `urgentDebounceMs`/coalesce 定时器 | 确认差异 | `service.ts:422-424` | 是 |
| `DIF-TRIGGER-NO-STARTUP-BACKLOG` | 启动/resume 积压不主动 schedule | 确认差异 | `worker.ts:103-109`、`service.ts:403-425` | 是 |
| `DIF-TRIGGER-NO-USER-CORRECTION` | 无"用户撤销/纠正"检测点 | 确认差异 | `filter.ts:291-299` | 是 |
| `DIF-TODO-EMPTY-DROPPED` | `{todos:[]}` 被 filter 丢弃 | 确认差异 | `filter.ts:463` | 否 |
| `DIF-TODO-EMPTY-NO-CLEAR` | 空表不能推进 stable / 清空 todoView | 确认差异 | `filter.ts:463`、`batch.ts:101-102` | 否 |
| `DIF-TODO-REFS-MODEL-OWNED` | todoReferences 由模型裁决，无最新表强制覆盖 | 确认差异 | `host.ts:172-182`、`prompt.ts:54` | 是 |
| `DIF-INFEASIBLE-NO-DEGRADE` | infeasible 无降级，cursor 可永久卡住 | 确认差异 | `batch.ts:111-118`、`worker.ts:193-202` | 是 |
| `DIF-INJECT-NO-STALENESS` | 注入无 staleness marker | 确认差异 | `render.ts:16,44-47` | 否 |
| `DIF-INJECT-NO-CURRENT-GOAL-SLOT` | 渲染无"当前 Goal"槽位与优先级 | 确认差异 | `render.ts:44-89` | 否 |
| `DIF-STABLE-NO-CAS` | `putStable` 无 expectedRevision CAS | 确认差异 | `service.ts:519-541` | 是 |
| `DIF-DOMAIN-SINGLE-NO-LEASE` | `layout:'single'`，无 single-writer 声明/租约 | 参数差异 | `domain.ts:37-45` | 是 |
| `DIF-CONFIG-MISSING-STABLE-KEYS` | 缺 `urgentDebounceMs`/`startupBacklogUpdate`/`multiInstanceMode` | 参数差异 | `config.ts:17-29`、`cordis.patch.yml:44-56` | 否 |
| `EQ-NO-GOAL-TODO-WRITEBACK` | 插件零回写 Goal/TODO | 等价实现 | `filter.ts:11-15` | 否 |
| `EQ-GOAL-SNAPSHOT-CLEAR-TOMBSTONE` | goal/change 全快照 + clear 墓碑 | 等价实现 | `filter.ts:374-403` | 否 |
| `EQ-TODO-WHOLE-LIST-CAPTURE` | 非空 TODO 整表采集 | 等价实现 | `filter.ts:460-471` | 否 |
| `EQ-CURSOR-MONOTONIC-NO-REPLAY` | cursor 单调、失败不重放同窗口 | 等价实现 | `update.ts:425`、`worker.ts:229-251,284-290` | 否 |
| `EQ-FOLLOWUP-SINGLE-WAVE` | active 期合并为一个 follow-up + 至多一个 trailing | 等价实现 | `worker.ts:246-251` | 否 |
| `EQ-OBSERVER-DEFERS-WORK` | observer 只抬水位 + microtask | 等价实现 | `service.ts:418-424` | 否 |
| `EQ-LIFECYCLE-FENCE` | 生命周期栅栏 + 仅 live session 发布 | 等价实现 | `service.ts:519-552,764-772` | 否 |
| `EQ-OUT-OF-WINDOW-QUARANTINE` | 窗外引用 quarantine 而非整候选失败 | 等价实现 | `host.ts:153-182` | 否 |
| `EQ-AUDIT-NEVER-ROLLS-BACK-STABLE` | 审计失败不回滚 stable、repair 不重跑模型 | 等价实现 | `update.ts:461-489` | 否 |

---

**本轮未做的事**：未构建、未测试、未启动任何服务、未看 watcher/运行实例/用户 settings、未修改任何既有文件（仅新增本文件）、未派生子代理、未重新调查 DSH。因此本文差异均属**静态设计语义**判定，§9 的实验项需真实会话观测才能定论。
