# 15-插件会话摘要与 Checkpoint 更新链（task-state stable 权威链）

> 只读审计；未修改插件源码，未运行破坏性命令，未启动服务器，未派生子代理。
> 方向基线：`压缩方案4.md`（仅方向，不作实现证据）。DSH 已落库事实复用 `调查资料/00`、`01`、`02`、`03`、`04`，不再重查。
> 本专题 = 插件会话摘要（task-state stable）+ 插件 compaction checkpoint 的数据模型与更新链；磁盘多实例细节不在本任务内（交 16）。
> 约束：核心实现/测试 ≤20 文件，直接依赖 ≤2 层。

## 0. 先行结论：两个“摘要”不是一回事

- 【已证实】本插件同时存在两条摘要链：
  1. `task-state-basic` 的 durable stable：`TaskStateStable`，权威存储在 storage-domain `context_enhancement_task_state`，从不写入 Session log。
  2. `compaction-basic` 的 checkpoint：`user/message` replacement（`compactCheckpointSource`），写入 Session log 并参与 surface 折叠。
- 【已证实】task-state 系列声明 NO SessionEventMap：`src/internal/task-state/contract/index.ts:10-12`、`src/internal/task-state/basic/service.ts:22-25`、`src/task-state.ts:10-12`。审计词表只活在 provider 的 storage-domain 表中，卸载后旧 Session 仍可被 rc.1 读取。
- 【已证实】compaction checkpoint 的 `user/message` 反而不进入 task-state 输入：`filter.ts:291-299` 仅接受 `source.kind==='user'/'goal'`，而 checkpoint 的 source 为 `kind:'plugin'`（`src/internal/compaction/region.ts:442-444`，判定见 `src/internal/compaction/source-index.ts:115`），故 `directHumanKind` 返回 undefined 并被丢弃。这是两条链的隔离点。

## 1. 实体与存储（权威数据模型）

- 【已证实】`TaskStateStable`（`src/internal/task-state/contract/types.ts:153-174`）：
  `schemaVersion, revision(正整数单调), filterVersion, sourceCursor, digest, facts/decisions/constraints/risks(带 Host-minted id), evidence[{seq,note}], todoReferences[{seq,content}], continuation{currentObjective,currentFocus,openWork,nextActions}`。
- 【已证实】`TaskStateCandidate`（`types.ts:131-145`）：同 stable 内容但 entry `id?` 可选；新条目省略 id，沿用条目原样 echo id。
- 【已证实】`TaskStateRecord`（`types.ts:180-185`；schema `spec.ts:172-175` strict）：`{session: TaskStateSessionIdentity, stable}`。
- 【已证实】`TaskStateSessionIdentity`（`types.ts:31-36`）：`{createdAt, cwd?}`，用于 lifecycle fence。
- 【已证实】domain 声明（`src/internal/task-state/basic/domain.ts:37-45`）：`name='context_enhancement_task_state', version=1, layout='single'`，表 `sessions: SessionId->TaskStateRecord`、`audit: RequestId->TaskStateAuditRecord`。`single` 使损坏/不兼容整体大声失败而非读成空介质（`domain.ts:1-16` 注释）。
- 【已证实】owner 为 `TaskStateBasicService`（`src/internal/task-state/basic/service.ts:98-127`）：`inject=['storageDomain','sessions','llm']`，持有 `sessionsTable/auditTable:117-118`，`runtimes: Map<SessionId,SessionRuntime>:119`，`committedListeners:127`。`Service.init:139-196` 打开 domain 并设 domain dispose effect（`167-179`）。
- 【已证实】audit 行（`src/internal/task-state/contract/audit.ts:112-123`）：一请求一行，key=`requestId`，`{requestId,time,session,request: open, finished?}`；open 为完整 pre-dispatch 证据，finished 为 success/failure/manual/repair 之一（`types.ts:278-320`）。
- 【已证实】lifecycle fence 三处：`lifecycleOf: service.ts:86-91` 取 `header.createdAt/cwd`；`recordFor:455-465` 失配返回 undefined；`putStable:519-541` 若既有 record 属另一 lifecycle 则抛错拒绝覆盖。内存发布亦只认 `runtime.session===live`（`publishedStable:765-772`，`publishCommitted:544-552`）。
- 【已证实】compaction checkpoint 实体（对照用，非 stable）：`summarizeCompaction: region.ts:433-460` 构造 `checkpointMessage=createUserMessage({source: compactCheckpointSource(...)})`；`commitCompactionBody:503-541` 先 append `compaction/summary{shadowedRange,shadowedSeqs,shadowedTokenCount,...}` 再 append `user/message` 带 `surfaceOp:{replace,start,end}` 与 `sourceEventSeqs=[start,summary,...shadowed]`。

## 2. 输入事件筛选、cursor、批次

- 【已证实】`ELIGIBLE_TYPES`（`src/internal/task-state/basic/filter.ts:502-522`，版本 `filter-v2:24`）共 13 种：
  `user/message, assistant/message, tool/call, tool/result, turn/end, goal/change, todo/write, plan/mode, command/run, request/header, agent-preset/selected, compaction/start, compaction/end`。
- 【已证实】`NEVER_ELIGIBLE`（`525-529`）：`task-state/update-request, task-state/update-finished, context-enhancement/task-state-committed` 永不进入；注释称 audit 已不在 Session 事件中实现，名字仅作保留防线（`531-539`）。
- 【已证实】`compaction/summary` 被故意排除（`517-519` 注释）；`command/done` 故意缺席（`491-494` 注释：无 name 且结果已被 goal/plan/todo 权威事件覆盖）。
- 【已证实】各投影要点（`projectEvent:284-499`）：user 仅 `user/goal` 且非空（`291-299`，goal 记 `goal-continuation`）；assistant 排除 `interrupted` 与空文本（`301-309`）；tool/call 参数 JSON leaf 化（`311-327`，leaf 规则 `152-187`）；tool/result 取首个 `tool-result` 块 text + error name/code + meta leaves（`328-369`）；`turn/end` 投 turn+reason（`370-373`）；`goal/change` 投 operation/clear 或 goal{id,revision,phase,objective, maxGoalRounds,roundsStarted,blockedReason.code}（`374-402`）；`request/header` 仅 `initial/resume/change` 且 provider+model 非空（`404-431`，`series` 跳过）；`agent-preset/selected` 仅非空 preset（`432-441`）；`compaction/start/end` 投 compactionId+turn/error（`443-459`）；`todo/write` 空表丢弃（`460-471`）；`plan/mode{active}`（`472-475`）；`command/run` 仅 `goal/plan/compact`（`476-490`）。
- 【已证实】有界性：`DEFAULT_FILTER_FIELD_LIMITS:51-62`（user 4k/assistant 2k/args 2k/result 4k 等）；`MAX_JSON_ARRAY_ITEMS=8, MAX_JSON_DEPTH=6:75-76`；二进制 leaf 正则丢弃（`72,140-144`）；`boundField` 截断留痕（经 `bytes.ts`）。
- 【已证实】cursor = “最后折叠的 eligible seq”（`batch.ts:33-35`；`types.ts:52-55`）。`foldBatchWindow(events,base,cursor,windowEndSeq,budget): batch.ts:76-82` 只看 `cursor<seq<=windowEndSeq`；投影为空则跳过且不推进 endpoint（`101-102,121-123`）；`includedSeqs` 升序，`sourceCursor`=末个（`122-123`）。
- 【已证实】批次预算约束的是完整 frame（含 base+events+truncation+wrapper）：先算空 frame（`90-95`），逐事件试加并重算 `frameProjection` 字节（`108-110`）；`maxEvents` 截断（`100`）；base 独超或首事件即超报 `infeasible`（`91-94,111-117`）；无可折叠报 `empty`（`128`）。
- 【已证实】已提交 cursor 之上“可投影数”每次用真 filter 重算：`eligibleEventCount: service.ts:471-482`（type+`filterEvent!==null` 双检）；worker 启动与每次 settle 后 `recomputeEligible`（`worker.ts:145-147,241,302`）。

## 3. 触发与并发排队

- 【已证实】三 observers（`service.ts:401-452`）：`session/created` 建 runtime；`session/event` 仅当 `isEligibleType` 且 `filterEvent!==null` 才 `worker.observe(seq)` 并 `queueMicrotask(maybeSchedule)`，注释强调 observer 栈内不做 append/flush/model/storage（`418-424`）；`session/disposed` 关闭并 dispose worker。
- 【已证实】worker 单飞 wave（`src/internal/task-state/basic/worker.ts:52-79` 头注释+字段）：`pending` 为最高 eligible seq 水位，`pendingEligible` 为阈值计数，`active` 单飞，`followUpRequested` 为运行期追波标志，`chain` 串行所有 cycle，`controller` 取消在途请求。
- 【已证实】`observe:139-143` 只抬水位+计数；`maybeSchedule:156-164` 仅当 `pendingEligible>=minEvents` 且非 active 才 `launch('threshold')`，运行中只置 flag。
- 【已证实】`launch:171-226` 在启动瞬间快照 `windowEnd=pending`，取 `committedCursor/readBase/liveSession`，`foldBatchWindow(snapshotEvents,...)`；empty 重算后停止（`186-192`），infeasible 记 error 日志且不重试（`193-201`），否则 `active=true` 并挂 `chain` 跑 `performBatch`。
- 【已证实】`settleCycle:229-251`：仅 committed 可续；failed 永不自调度（水位保留待下次合法 wave）；committed threshold 最多带一个 trailing；trailing 永不级联（提交后若仍 `>=minEvents` 则开新 threshold，否则等 later activity）。
- 【已证实】`enqueueMutation:122-130` 把 control 面 `editStable` 串到同一 `chain` 后；dispose 关 admission、中止 controller、await chain（`354-360`）。
- 【已证实】部署默认（`cordis.patch.yml:44-56`）：`provider deepseek-official, model deepseek-v4-flash, minEvents 20, maxEvents 200, maxInputBytes 60000, maxOutputTokens 4000, timeoutMs 120000, maxInfraRetries 2, maxEntriesPerKind 50, maxEntryBytes 4000, maxListItems 40`。`maxEvents>=minEvents` 与正整数校验见 `config.ts:43-73`；Service Config schema 见 `service.ts:102-114`。
- 【已证实】路由解析（`service.ts:343-348`）：batch 启动时取 live session `requestHeader().config`，无路由回落到部署 `provider/model`。infra 重试仅 `TRANSIENT_LLM/TIMEOUT`（`worker.ts:410-413`），`attemptWithRetry:310-329` 上限 `maxInfraRetries`，backoff `250*2^n` 封顶 4s（`416-426`）。

## 4. 模型合并 prompt（collect-and-merge 一次调用）

- 【已证实】system 钉死（`src/internal/task-state/basic/prompt.ts:29-58`）：durable updater；输出 ONLY 一 JSON（facts/decisions/constraints/risks/evidence/todoReferences/continuation）；新条目省略 id，沿用 echo 原 id 且禁改内容/前缀；四表去重；evidence 只能引投影列出的 seq；todoReferences 只记投影中 durable list；TODO 永不并入 continuation；小字符串；禁 fence/工具调用。
- 【已证实】frame（`prompt.ts:69-86`）：`{previousStable: contentOfStable(base)|null, filterVersion, inputSchemaVersion=1, events[{seq,type,fields}], truncation}`；`contentOfStable:89-112` 剥掉 revision/cursor/digest 等 commit 元数据。`INPUT_SCHEMA=1, STABLE_SCHEMA=1:18-21`。
- 【已证实】调用装配（`src/internal/task-state/basic/update.ts:229-254`）：单条 user message（projection 全文，`source:{kind:'plugin',plugin:'dsh-context-enhancement/task-state-basic'}`）+ `system` + `maxTokens` + `sessionId` + 本地 `purpose:'task-state'`（rc.1 GenerateOptions 联合封闭故单点 cast，注释 `24-29,93-103`）经 `ctx.llm.stream`，`BlockAssembler` 收集完整未截断 blocks+usage+finish；`deadline(signal,timeoutMs):182`，码 `task-state-basic/update-timeout:59`。

## 5. stable / candidate / audit 三态

- 【已证实】schema 层（`src/internal/task-state/contract/spec.ts`）：candidate `141-144`（id 可选）；stable content `151-154` + stable `161-169`（每 entry 必 id + `rejectDuplicateIds:92-113`）；record strict `172-175`。
- 【已证实】audit open/finished 构造（`audit.ts:138-166`）：`openAuditRow(requestId,session,request)`；`finishAuditRow` 同行只填一次，已 settle 不可变，唯 `repair->success` 允许后补完整证据（`160-165`）。timeline/certified/repair 选用 `deriveAuditTimeline:192-209, highestCertifiedRevision:218-227, selectRepairRow:241-254, rowsForLifecycle:262-269`。
- 【已证实】一次 attempt 序列（`update.ts:147-207`）：`requestId='ts-'+uuid:151`，`targetRevision=base+1:152` → await `putOpenAudit`（失败即 `AUDIT` request 失败且永不 dispatch：`156-180`）→ stream/collect（`186-194`）→ terminal finish 检查（`196-200`）→ `commitFromOutput:202`。
- 【已证实】`commitFromOutput:352-490`：禁 image（`360-363`）、禁空文本（`364-367`）、JSON.parse（`373-384`）、`parseCandidate`（`386-397`）、`normalizeCandidate`+quarantine warn（`400-423`）、`commitStable(normalized,1,targetRevision,filter-v2,lastIncludedSeq)`（`425-434`）、`putStable`（`450-460`）、`onCommitted`（`464`）、`putFinishedAudit{success,revision,sourceCursor,llmStreamCall:true,rawOutput,usage?,finish:{stop}}`（`466-476`）；finished 写失败则 `auditGap:true`+warn（`477-488`）。

## 6. 校验提交（Host 语义 + 权威 put）

- 【已证实】`normalizeCandidate`（`src/internal/task-state/basic/host.ts:84-213`）：按 `maxEntriesPerKind` 计数（`90-101`）；echo id 必须存在于 base、全局唯一、前缀与所在表一致、内容逐字相等（`103-150`），否则整 candidate `SEMANTIC` 失败；新条目 mint `fact-/decision-/constraint-/risk-<uuid>`（`53-56,120-124`）；evidence/todo seq 不在 `includedSeqs` 则 quarantine 丢弃+回调（`160-182`，类型 `basic/types.ts:93-98`），防“旧 stable 引用永远卡死未来更新”；全部按 `maxEntryBytes/maxListItems` bound（`152-194`）；`digestOf=SHA256(JSON content):220-222`；`commitStable` 再过 `taskStateStableSchema:233-254`。
- 【已证实】权威提交 `putStable: service.ts:519-541` 为 sessions 表 replace；`publishCommitted:544-552` 仅 authority put resolve 后更新内存指针并 `notifyCommitted:555-567`。finished audit 永远在 put 之后（update 注释 `13-22`），故 finished 失败不回滚 stable。
- 【已证实】`finishOpenAudit: service.ts:287-308` 严匹配：仍 open、同 key、同 lifecycle、同 revision，success/repair 还需 revision+cursor 双等，否则原样保留。
- 【已证实】手动 edit 同样走“open→put→publish→finish”：`editStable:594-718` 乐观 revision（`629-631`），`resolveManualContent:721-762` 按内容复用既有 id、新内容 mint、保留 `evidence/todoReferences`，open 行 `route manual-edit/maxTokens 0`（`645-658`），提交后 finish `outcome:'manual'`（`697-701`），冲突/三段 liveness 检查（`611-623,664-676,683-695`），码 `unavailable/not-found/conflict/invalid`。
- 【已证实】启动/活体 repair 永不重跑模型不编造输出：`reconcileRepair:232-258` 仅当 `highestCertified<stable.revision` 才 `selectRepairRow` 填 `repair{revision,sourceCursor}`；无 open 行则 warn 并保持 uncertified 但 stable 仍权威（`241-250`）；活体 `scheduleAuditRepair:265-284` 同理经 `trackRepair/drainRepairs:199-216` 与 dispose 衔接（`167-179`）。

## 7. 主 Agent 读取注入

- 【已证实】`task-state-prompt`（`src/task-state-prompt.ts:54-73`）：注册 `systemPrompt.context{name:'task-state:snapshot',order:125,text:'{{task_state_snapshot}}'}` + `variable('task_state_snapshot', ctx=> getStable(session.id)->render)`；`inject=['systemPrompt']` 且不注入 `taskState`，无 provider 时挂载仍干净（`29-34`）；变量值不二次扫描 `{{...}}`（`43-44`）。
- 【已证实】`renderTaskStateSnapshot`（`src/internal/task-state/prompt/render.ts:106-121`）：纯函数，只读 stable+预算；头行恒为 `revision/sourceCursor/digest`（`44-47`），continuation 优先于长表（`36-42`），尾部整行丢弃+固定 marker（`16,111-120`），首行都放不下返回空串（`119`）。entry id 不渲染，只渲染 content；evidence/todo 渲染 `note/content + (session event seq)`（`76-87`）。
- 【已证实】读 API 同步无 IO：`TaskStateService.getStable: contract/index.ts:76-83`；实现 `service.ts:775-778`（disabled 即 undefined）。control 面经 `subscribeCommitted:588-591` 推 `update` 帧，baseline 拉全量 `getStable`（`src/internal/task-state/control/service.ts:75-116`）；`edit` 转调 `editStable`（`99-106`）。

## 8. 失败行为一览

- 【已证实】码表 `TaskStateBatchErrorCode`（`src/internal/task-state/basic/types.ts:121-135`）：`NO_ELIGIBLE_EVENTS/NO_SESSION/SERVICE_DISPOSED/NO_ROUTE/BUDGET/TIMEOUT/ABORTED/TRANSIENT_LLM/PARSE/SCHEMA/SEMANTIC/STORAGE/AUDIT/UNEXPECTED`；stage 8 种（`139-141`）。
- 【已证实】stream 分类（`update.ts:257-305`）：session abort→ABORTED；deadline→TIMEOUT；thrown code 仅 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT` 算 TRANSIENT（`313-315`）；finish `max-tokens→PARSE, tool-calls→SEMANTIC, error/aborted` 按信号映射。
- 【已证实】`BUDGET(empty/infeasible)` 在 worker 层终结、不开请求、不推进 cursor（`worker.ts:182-201`）；失败 cycle 已落的 finished 审计保留，pending 水位不动待下波（`284-289,229-234`）；`performBatch` 调度器级抛错转 `UNEXPECTED`（`208-217`）。
- 【已证实】domain 打不开则整 provider 永久 disabled：无 stable、无 observer/worker、不二次 open、不调模型修复（`service.ts:148-165`，头注释 `11-20`）。

## 9. goal / todo 事件是否进入

- 【已证实】进入，但只作有界引用：`goal/change` 投影（`filter.ts:374-402`，含 `roundsStarted` 注释 `392-394`）；`user/message[source.kind==='goal']` 记 `goal-continuation`（`297`）；`todo/write` 投全表 content+status（`460-471`）。
- 【已证实】stable 不拥有 TODO：`todoReferences` 仅 `{seq,content}`（`types.ts:106-111`），prompt 禁并入 continuation（`prompt.ts:55`），manual edit 原样保留（`service.ts:759-760`）；evidence 仅 `{seq,note}`（`types.ts:93-98`），跨窗引用被 quarantine 而非致命（`host.ts:160-182`）。
- 【已证实】不得等同 DSH Goal：DSH Goal 是 `goal/change` 全快照 + `roundsStarted` + armed/disarmed 轮驱（见 `04-Goal与Todo长期状态.md`），task-state stable 是另一 storage-domain 的合并摘要；两者事件有交集（输入），权威与写路径完全分离。

## 10. 范围内未覆盖/未找到

- 【待深挖】Loader 归一化后的实际生效 config（本任务只证实 `cordis.patch.yml:44-56` 默认与 `config.ts/Service.Config` 校验；两层外未追 Loader 覆盖链）。
- 【待深挖】`order:125` 在 DSH system-prompt assemble 中的最终相对位置（只证实注册值，未追 `system-prompt` 组装实现，属两层外）。
- 【未找到】插件内名为 Checkpoint 的 task-state 存储：`checkpoint*` 命中全在 compaction 侧（`region/summarizer/zones/selection-guard/source-index`）；task-state 侧权威词为 stable/candidate/record/audit，无 checkpoint 表。
- 磁盘多实例/跨进程语义按任务要求不展开，交 16。

## 供后续代理直接引用的结论摘要

1. 权威 = `context_enhancement_task_state.sessions[SessionId]={session{createdAt,cwd},stable}`；`stable{revision+1链,sourceCursor=末个eligible seq,digest,filter-v2,四表+evidence/todoReferences+continuation}`；`audit[requestId]={open,finished?}` 只诊断/重放。
2. 输入 = 13 类 eligible 经 `filter-v2` 投影（user/goal 才收 user 文本；`compaction/summary`、`command/done`、task-state 自身事件明确排除；compaction checkpoint 因 plugin source 被 user 投影丢弃）。
3. 推进 = `pending水位 + pendingEligible>=minEvents(默认20)` 开一 wave，快照 `windowEnd` 后单飞跑 `foldBatchWindow(maxEvents 200/maxInputBytes 60k)`；成功最多带一个 trailing，失败不自调度。
4. 合并 = 钉死 system + `frame{previousStable,filterVersion,inputSchema 1,events,truncation}` 单次 `ctx.llm.stream(purpose task-state)`，`BlockAssembler` 收全量。
5. 提交 = open 落盘→stream→parse→schema→Host 语义（echo id 三检+新 id mint+窗外引用 quarantine）→sessions put→publish→finished；finished 丢只记 `auditGap`+repair，永不回滚。
6. 读取 = 主 Agent 经 `systemPrompt order:125 {{task_state_snapshot}}` 同步 `getStable` 渲染；control 经 `subscribeCommitted` 推流；manual edit 走同表乐观 revision。
7. goal/todo 进入输入但只存引用；绝不等同 DSH Goal；checkpoint 一词只属 compaction replacement，不属 task-state 存储。

## 交给其他任务的问题

1. 交 16：`context_enhancement_task_state` storage-domain 在双进程同 `$DSH_HOME` 下的并发 put/update 语义与 lifecycle fence 是否足够（本任务未查磁盘/多实例实现）。
2. 交 compaction/pressure 任务：task-state 批次默认 `minEvents 20` 与 compaction 压力阈值的相互作用（task-state 不感知 pressure，compaction 不感知 stable；长会话下摘要与裁剪的重复覆盖评估）。
3. 交 Web/控制面任务：`subscribeCommitted` baseline+update 流在重连/迟挂载下的 hydration（`runtimeFor:387-397` 已有 startup seed 通知，Web 侧是否依赖它需核验）。
4. 交াজার配置任务：Loader 对 `task-state-basic` config 的归一化覆盖链（本任务止于 `cordis.patch.yml` 默认与 `config.ts` 校验）。

*检查实现/契约文件数：19（domain, filter, batch, update, service, worker, prompt, host, config, basic/types, contract{index,types,spec,audit}, task-state, task-state-basic, task-state-prompt, prompt/render, control/service, compaction/region 部分行）；事实库复用 5 篇（00/01/02/03/04）。*
