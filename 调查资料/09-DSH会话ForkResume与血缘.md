# DSH Session create / load / resume / fork / seed / lineage / delegation 真实语义

> 状态：基于 DSH 源码静态核验（只读，未改 DSH）。
> 源码根：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 范围：core Session 的 create/fromRestore/seed/fork metadata；session store/host/controller 的 create/load/resume/fork 入口；agent-loop resume；delegation/subagent 建会话的直接调用层。goal 仅作继承语义引用。
> 不重复：持久化 backend 内部、compaction 算法、token、storage domain、Web 组件、当前插件。
> 标注约定：【已证实】源码直接可读；【待深挖】有线索未闭环；【未找到】限定范围内无实现。

---

## 0. Lineage 数据流图

```
                        ┌─────────────────────────── durable ───────────────────────────┐
                        │ $DSH_HOME/sessions/--<cwd-slug>--/<encode(id)>/session.jsonl   │
                        └───────────────────────────────────────────────────────────────┘
                                          ▲ header 首行 = SessionHeader(version,id,createdAt,cwd,
                                          │        parentSession?, seedLength?, origin?, delegationDepth, agentPreset?)
                                          │          seedLength ⇄ isSeeded + inheritedEventCount
   ┌── CREATE (真正新会话) ────────────────┴──────────────────────────────────────────────┐
   │ AgentLoop.create() 242/L652 → ctx.sessions.prepare(id,{meta:cwd})                    │
   │   → new Session(id, seed=undefined, header{isSeeded:false}, inherited=0)             │
   │   → firstLiveSeq=0, 无 end-seed 标记                                                  │
   │   → publish(): sessions.enter→announce → agent/created → agent/session-start(startup) │
   │   → 新 Session 对象 + 新 id + 新 log + 新磁盘文件                                     │
   └──────────────────────────────────────────────────────────────────────────────────────┘

   ┌── RESUME (重启/重开同一 id) ─────────────────────────────────────────────────────────┐
   │ AgentLoop.resume() L717 → resumeWith L726 → persistence.prepare(id)  coord L811     │
   │   ├─ ctx.sessions.get(id) !== undefined → throw "cannot prepare … while it is live"  │
   │   └─ prepareCore(id) coord L1066                                                     │
   │        backend.loadStored → (meta,inheritedEventCount,events)                        │
   │        closers = interruptedTurnClosers(storedEvents)  ← 物理补救 open turn          │
   │        balanced = storedEvents ++ closers                                            │
   │        ctx.sessions.prepare(id,{seed:balanced, meta, inheritedEventCount,            │
   │                                seedSource:'persistence'})                            │
   │          → Session.fromRestore(...) (index.ts L505, 零拷贝接管+冻结)                 │
   │        commitPrepared L1113 → commitRepair(磁盘闭合) / state.cursor=len, materialized │
   │   → 同一个 id + 同一磁盘文件；新 Session 对象；inheritedEventCount 保留原 fork 值     │
   │   → 构造函数追加 session/end-seed（除非末尾已有）index.ts L575                        │
   │   → publish → session/created(seq≠0) → projection cell 懒建 → agent/session-start(resume)│
   └──────────────────────────────────────────────────────────────────────────────────────┘

   ┌── FORK (SessionStore.fork L1145) ────────────────────────────────────────────────────┐
   │ source 必须是 live store 实例 (_resolveForkSource L1205, 否则 SESSION_NOT_LIVE)      │
   │ _forkSeed L1162: boundary 默认 = 最后一个事件 seq；必须 seq 连续存在；                 │
   │   选中切片最后一个 turn/start|turn/end 若是 turn/start → OPEN_TURN 拒绝               │
   │   seed = snapshotEvents(0, boundary+1)  ← 浅拷贝数组（同一批 frozen 事件引用）        │
   │   → this.create(childId,{seed, inheritedEventCount: seed.length,                      │
   │        meta:{cwd 继承, parentSession: source.id, isSeeded:true}})                     │
   │   → Session.create(mode='snapshot') 逐事件 snapshotJsonValue + deepFreeze = 深拷贝    │
   │   → 新 id + 新 log（seq 从 0 起，与父 seq 空间完全对齐）+ 新磁盘文件 + parentSession  │
   └──────────────────────────────────────────────────────────────────────────────────────┘

   ┌── DELEGATION (subagent) ─────────────────────────────────────────────────────────────┐
   │ one-shot: tool-subagent → provider(start) → subagent-in-process-driver               │
   │   childId = randomUUID()（无 "session-" 前缀）L113                                  │
   │   childSessionMeta(parent,childDepth,isSeeded)  child-agent.ts L138                   │
   │     = {cwd:父cwd, agentPreset:父live预设, parentSession:父id, isSeeded,               │
   │        origin:'subagent', delegationDepth: delegationDepthOf(父)+1}                   │
   │   spawn: seed=undefined                        fork: seed=父"完成turn前缀" L48-54     │
   │   → ctx.agents.create({sessionId, meta, seed?, inheritedEventCount?, setup})          │
   │   continuable: 同构，另加 seedDescriptorTurn(childId, prepared.seed, descriptor)      │
   │     → inheritedEventCount = prepared.seed?.length ?? 0 （descriptor 属于子自有）      │
   │   cold resume: ctx.agents.resume({resumeSessionId: childId}) — 不再走 provider        │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 四类入口各自产生/复用哪个 Session 对象、id、log

- 【已证实】**create**：`AgentLoop.create` → `SessionStore.prepare`（`core/session/src/index.ts:927-953`）→ `Session.create`（`index.ts:486-493`，mode=`'snapshot'`）。产生**新 Session 对象 + 新 id + 新 log**。id 省略时 store 铸造 `session-<n>`（`index.ts:930`）。磁盘文件首次 append 时才物化（coordinator `createCore` 纯惰性，`coordinator.ts:738-743`、`:1489`）。
- 【已证实】**重启 load**：`PersistenceCoordinator.load(id)`（`coordinator.ts:847-866`）。**不产生 live Session**：走 `prepareCore` → `ctx.sessions.prepare(seedSource:'persistence')` 造一个**未发布**的 detached Session，随后 `preparations.discard(reservation)`，只把 `reservation.source.inspection`（meta + balanced events）交给调用者。同一 id 的**磁盘文件被复用**。若该 id 当前 live，则 `loadLiveSnapshot`（`:1153-1168`）**直接复用内存对象**并先 `flush`。
- 【已证实】**agent resume**：`AgentLoop.resume`（`agent-loop/src/index.ts:717-723`）→ `resumeWith`（`:726-774`）→ `persistence.prepare(id)`（`coordinator.ts:811-838`）→ **产生新的 live Session 对象**（由 `Session.fromRestore` 构造，`core/session/src/index.ts:505-512`），**id 与磁盘文件复用**，且 `inheritedEventCount` 复用持久化值（`preparation.ts:20-48` 只是所有权包装）。发布路径 `setupAndPublish`（`:689-709`）→ `prepare` → `publish`（`:621-625`：`sessions.enter` + `agents.enter` + `announce`）。
- 【已证实】**fork**：`SessionStore.fork`（`index.ts:1145-1160`）→ `this.create(childId, {seed, inheritedEventCount, meta})`。**新 Session 对象、新 id、新 log、新磁盘文件**；父 Session 完全不受影响（子事件深拷贝，测试断言 `child.snapshotEvents()[1] !== source.snapshotEvents()[1]`，`tests/fork.spec.ts:85-91`）。
- 【已证实】**同 id 重复发布被硬拒**：`SessionStore.enter`（`index.ts:982-983`）“session … already exists”；`AgentRegistry.enter`（`core/agent/src/index.ts:476`）“agent … is already registered”；coordinator `createCore`（`:729-737`）拒绝已 tracked 或磁盘已有该 id。

## 2. fork 的 seed：复制 / 共享引用 / surface 快照？包含哪些事件与 replacement

- 【已证实】**是逐事件深拷贝，不是共享引用，也不是 surface 快照**：
  - `_forkSeed` 返回 `session.snapshotEvents(0, boundary+1)`（`index.ts:1192`）——这是 `Object.freeze([...this.log])` 的**浅拷贝**，元素仍是父的同一批 frozen 事件对象（`index.ts:600-609`）。
  - `Session.create`（mode=`'snapshot'`）对每个事件执行 `snapshotJsonValue(source)` 深拷贝 + `deepFreeze`（`index.ts:535`、`:552`），因此子 Session 的 log 与父**不共享任何对象**。
  - 复制的是**原始事件日志**，不是折叠后的可见 surface：`surfaceOp:'append'`、`surfaceOp:{op:'replace'}`、`sourceEventSeqs`、以及被遮蔽的原始节点**全部原样进入子 log**，子再通过 `SurfaceManager.validateNext` 逐个重放重建自己的 surface（`index.ts:547-551`）。不是“只复制可见消息”。
- 【已证实】**fork 边界**：`boundary` 为**含端**的源 seq；缺省 = 最后一个事件。边界必须是连续存在的 seq（`INVALID_BOUNDARY`，`index.ts:1185-1191`）；切片中最后一个 `turn/start|turn/end` 若是 `turn/start` → `OPEN_TURN` 拒绝（`:1193-1200`）。因此**允许**在闭合 turn 之后追加的 log-only 事件（如 `test/log-only`，fork.spec.ts:101-114），**禁止**任何停在 open turn 内的切片。
- 【已证实】**seed 后构造追加 `session/end-seed`**：`index.ts:575-577`。它位于 seed 之后（`seq = seed.length`），属于子自有事件（`firstLiveSeq = seed.length`，`:555`）。
- 【已证实】**replacement 仍需自洽**：子继承的是原始日志，含 replace 节点的 `start`/`end`/`sourceEventSeqs`（`surface.ts:220-253`、`:255-276` 校验：`sourceEventSeqs` 必须覆盖全部被遮蔽节点且全部指向更早 seq）。seq 空间因“复制到 0..boundary”而与父完全一致，所以这些引用在子中依然成立。
- 【待深挖】**边界切在 replace 节点的“被遮蔽区间之内而 replace 节点之外”时**，子会继承原始节点但不继承替换节点，从而子模型历史与父在同一 seq 前缀上**分叉**。源码未做防护，未找到针对该场景的显式拒绝或测试。
- 【已证实】Web 侧 fork 语义与 core 不同：`session-controller/commands.ts:188-281` 自行选址——以 `turn/end` 为锚，再把 cut 向后推进到下一个 `turn/start` 之前（`:229-232`），然后 `ctx.agents.create({seed: slice(0,cut), inheritedEventCount: cut, meta:{parentSession, isSeeded:true, cwd, agentPreset}})`。它**不写 `origin:'subagent'`、不写 `delegationDepth`**。

## 3. parentSession / seedLength / origin / delegationDepth 语义

- 【已证实】**`parentSession`**：`SessionHeader.parentSession`（`types.ts:105-106`）=“本会话 fork 自哪个 session（seed lineage）”。**仅记录直接父**，不记录祖先；创建时由 `fork`（父 id）或 `childSessionMeta`（`child-agent.ts:148`）写入；resume 时原样保留（测试 `agent-loop/tests/resume.spec.ts:606`）。**不表示父必须存活**（无附加校验）。
- 【已证实】**`seedLength` 是物理字段，逻辑上是 2 个值**：`SessionHeader` 里**没有** `seedLength`——`validateSessionHeader` 显式拒绝（`index.ts:99-101`）。JSONL header 有 `seedLength?: number`（`format.ts:53`）；`toHeaderLine` 写 `...header.isSeeded ? { seedLength: cut } : {}`（`format.ts:84`），`fromHeaderLine` 反解为 `isSeeded: line.seedLength !== undefined` + `inheritedEventCount: line.seedLength ?? 0`（`format.ts:107-112`）。故：**`seedLength` = `inheritedEventCount`（fork 继承前缀长度，持久化冗余保存），其存在性 = `isSeeded`**。逻辑层真名是 `Session.inheritedEventCount`（`index.ts:446`）。
- 【已证实】**`isSeeded` / `inheritedEventCount` 不变量**：seeded 必须有显式 seed 且必须给 count（`index.ts:557-562`）；unseeded 的 count 必须为 0（`:564-566`）；count 不得超过 log 长度（`:567-569`）。`ownEvents()` = `snapshotEvents(inheritedEventCount)`（`:615-617`），`isOwnSeq(seq)` = `seq >= inheritedEventCount && seq < this.seq`（`:624-626`）。
- 【已证实】**`firstLiveSeq` ≠ `inheritedEventCount`**：`firstLiveSeq` 是**本次进程构造 seed 的长度**（`index.ts:455-475`）。resume 时 seed 是**整个存储日志**，所以 `firstLiveSeq = storedLog.length`，而 `inheritedEventCount` 仍是原 fork 值（`agent-loop/tests/resume.spec.ts:591-609` 明确验证这一点）。`firstLiveSeq` 不持久化，用 `session/end-seed` 事件投影。
- 【已证实】**`origin`**：仅允许 `'subagent'`（`index.ts:125-127`）。语义自文档为“子代理会话的粗粒度产品分类，是展示元数据，不是可续期证明”（`types.ts:112-116`）。由 delegation 唯一写入（`child-agent.ts:152`）；Web fork 不写。
- 【已证实】**`delegationDepth`**：缺省（=0）为顶层，子 = 父深度 + 1（`types.ts:117-122`）。**单调地板**：`delegationDepthOf(agent) = Math.max(header.delegationDepth ?? 0, options.subagentDepth ?? 0)`（`subagent/src/depth.ts:28-36`），注释明确“持久化是为了让递归预算在重启/resume 后仍生效；若只存运行时深度，resumed child 会被重置为顶层”。`resolveChildDepth` 以它为底 +1 并做 `maxDepth` 上限（`child-agent.ts:49-58`）。
- 【已证实】`agentPreset` 也是 durable header 字段（`types.ts:123-129`），创建时从父的 **live scope** 读取而非 header（`child-agent.ts:144`）；resume 时 Web 端 `assertPresetUnchanged` 校验一致性（`session-controller/src/agent.ts:511-518`）。
- 【已证实】**`origin:'subagent'` 的会话被 Web 普通地址拒绝**：`history.ts:273-285` 对 `address.kind==='session'` 且 `header.origin==='subagent'` 抛 `session/agent-busy`；子会话必须提供 `parentSessionId` 且必须严格等于 header 的 `parentSession`。

## 4. projection 与 goal/todo 在 fork 时怎样继承或重算；activation/disarm 来源

- 【已证实】**projection 一律“从头重算”，没有 fork 偏移**：`ProjectionDefinition.init(header, inheritedEventCount)`（`session-projection/src/index.ts:62`），但 goal 与 todo 都忽略第二参数：
  - goal：`init: () => ({current:null, seenGoalIds:[], failure:null})`（`goal/src/index.ts:165`），`stateVersion 6`，apply 只认 `goal/change` 与 `source.kind==='goal'` 的 `user/message`（`:146-159`）。
  - todo：`init: () => null`，apply 只认 `todo/write` 与 `turn/start`（`tool-todo/src/index.ts:134-145`）。
  - 因此 fork 子会话把**整段继承日志 0..inheritedEventCount-1 完整 fold 一遍**，goal 的 phase/revision/roundsStarted 正确继承（`goal/tests/goal.spec.ts:182-204`）。
- 【已证实】**cell 建立有两条路径**：`session/created` 只在 `session.seq === 0` 时初始化（`session-projection/src/index.ts:209-219`）——即**只对真正新会话**；fork/resume 的 session 在 announce 时 `seq !== 0`，cell 走懒路径 `cellFor`（`:615-629`，full fold）或 `hydrate`（`:552-595`，checkpoint + 尾部增量）。
- 【已证实】**hydrate 只发生在读侧**：`hydratePrepared` 唯一生产调用点是 `session-query/src/observation.ts:198`（`observeSession`）。agent-loop resume **不**走 session-query，因此恢复后 goal/todo 由 `cellFor` 冷 fold 整个日志（或由 Web/subagent 先 observe 触发 hydrate）。checkpoint 身份校验：`(createdAt, cwd, isSeeded, inheritedEventCount)`（`session-projection-cache/src/index.ts:354-382`），**不含自增 token、只有 createdAt 毫秒**。
- 【已证实】**activation 是进程内状态，不在日志里**：`GoalRuntimeState` 存在 `WeakMap<Session, …>`（`goal/src/index.ts:248`）；`agent/session-start` 边沿一律 `activation='disarmed'`（`:255-257`）；`disarm()` 只改内存不写事件（`:287-292`）；只有 `goal/change` 事件在 append 时才由 `pendingActivation` 决定 arm/disarm（`:259-266`）。
  ⇒ **fork 与 resume 后 activation 必然是 disarmed**（与 04 文档一致）；**继承的是 durable goal 状态（phase/revision/roundsStarted），继承不到的是 arm 授权**，需人工 `update_goal action=resume` 重新 arm。
- 【已证实】goal-round-driver 在 plugin mount 时 disarm 所有现有 agent（`goal-round-driver/src/index.ts:417-421`）——跨实例防线，与 session 无关。
- 【待深挖】todo 的 `turn/start` 会清空投影（`tool-todo/src/index.ts:140`），而 fork 子会话的继承前缀末尾通常是 `turn/end`，故子初始 todo 为**最后一次写入的列表**；此结论由 fold 语义直接推出，未找到专门断言该场景的测试。

## 5. source seq / sourceEventSeqs / cursor 在 child 中是否仍有效

- 【已证实】**仍然有效**。理由链：
  1. fork 复制 `0..boundary`，且 `Session` 强制 `seq === index`（`index.ts:541-543`、`:693`），所以子的 seq 空间是父前缀的**恒等映射**；
  2. `SurfaceManager.validateNext` 在子构造时逐个重放，`planSurfaceEvent` 只要求 `event.seq === expectedSeq`（`surface.ts:338-340`）且 `sourceEventSeqs` 引用更早事件（`surface.ts:245-247`）——两者在前缀拷贝下不动；
  3. 因此父的 replace 节点在子中仍遮蔽同一批 seq，`deriveMessages()` 对同一前缀返回相同消息（`agent-loop/tests/resume.spec.ts:684-685` 用 `Session.create(replay).deriveMessages()` 与 resumed 会话比对相等）。
- 【已证实】**子自有新 replace 可以引用继承前缀**：因为约束是“`start`/`end` 必须是**当前 surface 中的节点 seq**”（`surface.ts:259-276`），继承折叠出的 surface 正好提供这些节点。
- 【已证实】**`cursor` 的两种含义别混**：
  - `PersistenceCoordinator` 的 `state.cursor` = **已持久化事件数**（`:784-799`，append 时断言 `event.seq === state.cursor + i`），与 fork 无关；
  - `SessionObservation.cursor` = 观察 cut（`events.at(-1)?.seq ?? -1`，`observation.ts:137`），用于 Web 增量 follow；
  - **恢复后的 `attachPrepared` 要求三个值严格相等**：`state.cursor === source.inspection.events.length` 且 `session.firstLiveSeq === state.cursor`（`coordinator.ts:1377-1381`），否则报 “preparation no longer matches its persistence state”。
- 【已证实】**子会话中“继承段”不是自有段**：`session-query` 的 subagent 校验要求 descriptor 投影的 `identity.seq >= inheritedEventCount`（`session-controller/src/history.ts:294`），即**继承前缀上的任何事件都不算子的自有状态**；`continuation.ts:998` 折叠 descriptor 时明确 `source.events.slice(source.inheritedEventCount)`，注释说明“fork seed 会重放父日志，可能携带**祖先**的 descriptor，必须只折子自有后缀”。

## 6. resume 对 orphaned/open turn、inbox、running agent 的处理

- 【已证实】**orphaned/open turn → 合成闭合器**：`prepareCore`（`coordinator.ts:1079-1087`）对读出的日志调用 `interruptedTurnClosers`（`core/session/src/repair.ts:29-135`），补出合成 `tool/result`（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`）、`step/end`、`turn/end{reason:{kind:'interrupted'}}`，`balanced = stored ++ closers` 作为 `fromRestore` 的 seed；`commitPrepared`（`:1123-1127`）发现 `tornMarker` 或 `closers` 非空时调 `backend.commitRepair` **把闭合器真正写盘**并让本次准备作废重来（`return undefined`）。合成事件 time 复用最后一条真实事件时间（`repair.ts:93-133`）。
- 【已证实】**live 会话不允许被 load/prepare**：
  - `coordinator.load` 遇到 live → `loadLiveSnapshot`，若内存日志存在 open turn 则**直接报错**“cannot load session … while its live turn is open; use the live Session or wait for the turn to close”（`:1160-1162`）；
  - `coordinator.prepare` 在循环前后两次检查 live 并抛 “cannot prepare session … while it is live”（`:814-816`、`:824-827`）；
  - 端到端断言见 `agent-loop/tests/resume.spec.ts:211-230`（live agent 持 open turn 时 resume 被拒；turn 关闭后 load 正常）。
- 【已证实】**running agent 的 resume 语义**：Session 层任何 prepare 都被 live 检查拦截；Agent 层 `AgentRegistry.enter` 以 id 为唯一碰撞边界（`core/agent/src/index.ts:476`）。因此**同一 id 不能同时存在两个 live 生命周期**；resume 只对“已不在 store 中的 id”有意义。
- 【已证实】**inbox 在 resume 后由日志重放**：`Inbox` 构造时遍历 `session.ownEvents()` 中所有 `agent/inbox/spliced` 并 `apply`（`core/agent/src/inbox.ts:32-40`）。resume 时 `firstLiveSeq`/`inheritedEventCount` 全为整段日志，所以**重启前挂起的 pending 消息会重新变为 pending**（`resume.spec.ts:616-650` 验证 `a2.inbox.nextStep` 仍含该消息，并在下一次 turn 中进入模型历史）。
- 【未证实/需注意】**fork 不走 inbox 重放**：`Inbox` 只读 `ownEvents()`（即 `inheritedEventCount` 之后）。父子在 fork 边界若父仍有 pending inbox 事件（位于继承前缀内），子**不会**在自己的 inbox 中看到它们。这是一条由 `ownEvents()` 边界直接推出的语义差异，未找到专门测试。
- 【已证实】**resume 的 turn 编号来自投影**：`ReactLoopAgent` 构造时 `lastTurn = sessionProjections.stateOf(session,'turnBoundary')?.lastTurn ?? 0`（`agent-loop/src/agent.ts:101-102`），所以恢复后继续 `turn = lastTurn + 1`（`resume.spec.ts:692-693` 断言 `[1,2]`）。
- 【已证实】resume 会写 `request/header`，reason 为 `'resume'`（`agent.ts:508`：`baseline === undefined ? 'initial' : 'resume'`）。

## 7. delegated/subagent 会话与父会话的历史、长期状态、存储命名空间

- 【已证实】**历史**：spawn 子**不继承**父日志（`isSeeded:false`，`subagent-in-process-driver/tests/inheritance.spec.ts:110-111`）；fork 子继承父的“**最后一个 `turn/end` 为止**的完整前缀”（`subagent-fork-in-process/src/index.ts:48-54`），未完成 turn 被排除；continuable 在 fork seed 之后**追加 descriptor 自有事件**，`inheritedEventCount` 只到 `prepared.seed.length`（`continuation.ts:466-467`）。fork 前缀在创建时**只捕获一次**（`subagent-fork-in-process/src/index.ts:84-90` 注释），后续冷 resume 重放子自己的持久化前缀，而不是重新 fork 父的新历史。
- 【已证实】**长期状态**：goal/todo 投影按子自己的 `SessionId` 持有 cell（`WeakMap<Session, UnitCell>`，`session-projection/src/index.ts:171`），从子自己的日志 fold。fork 子继承父前缀中的 `goal/change`/`todo/write`，spawn 子为空。
- 【已证实】**存储命名空间**：子 id 是 `randomUUID()`（`subagent-in-process-driver/src/index.ts:113`；continuable 同 `continuation.ts:435`），**与父同 cwd**（`childSessionMeta` 继承 `parentHeader.cwd`），因此落到**同一个 project 目录** `$DSH_HOME/sessions/--<cwd-slug>--/<uuid>/session.jsonl`，与父**平级**、无嵌套命名空间、无父子目录关系（路径公式见 03 文档与 `format.ts:180-242`）。out-of-process SDK 子会话用 `session-<uuid>`（`subagent-dsh-sdk/src/run.ts:298`）。
- 【已证实】**跨项目唯一性约束**：`findLog` 扫描全部 project 目录，若同一 id 出现在多个目录直接抛错（`session-persistence-jsonl/src/index.ts:816-837`），且 `onCreated`/`adoptLivePrefix` 要求磁盘 `cwd` 与 live header `cwd` 严格一致（`coordinator.ts:1442-1443`、`:1501-1502`）。⇒ 子会话与父会话**共享同一存储根与项目目录规则**，不共享文件。
- 【已证实】**delegation 的 long-term 权限面写入子日志而非父**：`appendDelegatedPolicyOverrides` 在未发布窗口内把 `sandbox/mode{source:'delegation'}` 与 `approval/policy{policy:'never'}` append 到**子自己的 log**（`child-agent.ts:258-268`），位于任何 fork seed **之后**以覆盖陈旧 seed 状态（注释明确）；冷 resume 时**不重复 append**，改为重放已持久化事件（`continuation.ts:1129-1136`）。
- 【已证实】**continuable 子的重建输入**：descriptor（`subagent/descriptor.ts` 折叠自 `events.slice(inheritedEventCount)`，`continuation.ts:998`）提供 mode/provider/model/persona/toolFilter；`coldResume` 用 `ctx.agents.resume({resumeSessionId: childId})`（`:1142-1147`），**不经过 provider**，并先 `authorizeLineage(parent, childId, source.header.parentSession)`（`:994`）——**只有持久化 header 上的直接父**（且是 live 实例）能续期。

## 8. 多次打开同一 session 与 fork 的区别

| 维度 | 多次打开同 id（load / resume / observe） | fork |
|---|---|---|
| Session 对象 | load 复用 live 对象或返回未发布 detached；resume 产生**新 live 对象** | **必然新对象** |
| SessionId | **同一个** | **新 id** |
| 磁盘文件 | **同一个文件** | **新文件** |
| 历史 | 全量重放 | 前缀深拷贝 |
| `inheritedEventCount` | 复用持久化值（fork 子仍是原值） | = seed 长度 |
| `firstLiveSeq` | = 存储日志长度（整段都是构造 seed） | = seed 长度 |
| 父链路 | header 不变 | 新增 `parentSession` + `isSeeded:true` |
| goal activation | disarmed | disarmed |
| 并发 | 同 id 只能一个 live：`sessions.enter`/`agents.enter` 硬拒；Web `resolveAgent` 用 `resumes` Map 去重并发 resume（`session-controller/src/agent.ts:141`） | 子 id 自定义，父可继续运行 |

- 【已证实】只读探查不算“打开”：session-controller `inspect`（`index.ts:192-205`）在有 live 时直接返回其 header+events，否则 `inspectApiSession`（`agent.ts:112-137`）走 `observeSession(projectionMode:'none')`，**不修复、不 resume、不发布**。`observeSession` 的 prepared 分支在 `source==='prepared'` 时由 `follow` 调 `promote`（`history.ts:160-168`）才把它提升为 live。
- 【已证实】Web fork 与 core fork 的差异已列在 §2 末尾（Web 以 `turn/end` 锚定 + 推进到下个 `turn/start`，且不写 origin/delegationDepth）。

## 9. 对“长期摘要状态关联 key”的可用稳定标识与继承风险

- 【已证实】**可用的稳定标识（按稳定性降序）**：
  1. `SessionId`（`Session.id`，`index.ts:449-451`）——唯一、durable、子会话天然不同。
  2. 三元组 `(SessionId, createdAt, inheritedEventCount)` + `cwd`/`isSeeded`：这正是 projection-cache 的 `CheckpointIdentity`（`session-projection-cache/src/index.ts:354-382`），其注释明确“**session id 是一个 slot，不是一次生命周期**”，因此单靠 id 不足以区分“同 id 被删后重建”与“存储根被替换”。
  3. `session/end-seed` 事件 seq（= 存储历史的 firstLive 边沿）：durable、可读，`session-controller` 用它作为“冷源附着”的发布边界（`api/session-controller/tests/transport.host.spec.ts:254-296`），compaction 也用它清空继承过来的未闭合 bracket（`compaction-basic/src/region.ts:535`）。
  4. `inheritedEventCount`（`isOwnSeq`/`ownEvents` 的边界，`index.ts:615-626`）——区分“继承历史”与“本会话自有历史”的**权威切点**。
- 【已证实】**继承风险清单**：
  - **R1 跨会话污染**：任何以 `parentSession` 为 key 而不带子 id 的长期摘要状态，会在**同一父的多个 fork 子**之间串味（一个父可 fork 多次，每次全新 id 却共享 `parentSession`）。
  - **R2 混淆“继承段”与“自有段”**：以 seq 为 key 的外部状态若在 fork 子中被复用，seq 0..inheritedEventCount-1 表示的是**父的历史**；`ownEvents()`/`isOwnSeq()` 才是正确边界。已有实现遵循此规则（`continuation.ts:998`、`history.ts:294`）。
  - **R3 同 id 不同生命周期**：删除后重建同 id、或换 `$DSH_HOME` 后同 id，仅凭 `SessionId` 会把旧状态误挂到新会话。projection-cache 用 `CheckpointIdentity` 挡住；任何自建状态表应复制同一策略。
  - **R4 fork 边界落在 replace 区间内**（§2 待深挖项）：子会继承未遮蔽的原始节点，摘要类长期状态若以“被遮蔽 seq”为 key，会在子中指向仍然**可见**的节点。
  - **R5 `seedLength` 与 `firstLiveSeq` 混用**：resume 后二者不等（整段日志 vs 原 fork 切点，`resume.spec.ts:591-609`）。用 `firstLiveSeq` 当“子自有起点”的判据**在 resume 后会失效**；应用 `inheritedEventCount` / `ownEvents()`。
  - **R6 activation 不可继承**：goal 的 `activation` 是进程内 WeakMap 状态，跨 fork/resume 一律 disarmed（`goal/src/index.ts:248-266`），任何依赖“继承即可自动续跑”的长期状态设计必须先显式 re-arm。
  - **R7 多实例无锁**：无跨进程锁/CAS（见 03 文档 §6），两个进程 resume 同一 id 各自维护 cursor，长期状态表若落在磁盘上同样缺一致性保护。

---

## 落地决策事实（供下一阶段直接引用）

1. **新建/切换语义三分**：`create` = 新 id+新对象+新文件；`load/observe` = 同 id+同文件、可能复用 live 对象；`resume` = 同 id+同文件+新对象（`fromRestore`，零拷贝接管冻结）；`fork` = 新 id+新对象+新文件+前缀深拷贝。
2. **fork 的 seed 是“原始事件日志前缀深拷贝”**（含 replacement 与 sourceEventSeqs，含被遮蔽节点），**不是** surface 快照，也**不是**共享引用；`seq` 恒等映射使继承引用继续自洽。
3. **`seedLength` 只是持久化层对 `inheritedEventCount` 的编码**；逻辑层权威字段是 `Session.inheritedEventCount` + `header.isSeeded`；`firstLiveSeq` 是进程内构造事实，resume 后与前者不同。
4. **`parentSession` = 直接父的 seed lineage（仅记录、不校验存活）；`origin:'subagent'` = 仅展示分类；`delegationDepth` = 持久化递归预算、单调地板 `max(header, runtime)`。**
5. **projection 在 fork/resume 时整体从 seq 0 重算**（goal/todo 的 `init` 忽略 inheritedEventCount）；checkpoint 复用的身份键是 `(createdAt, cwd, isSeeded, inheritedEventCount)`，不是 id 单独。
6. **resume 会物理修复 open turn**：合成 tool/result + step/end + turn/end{interrupted} 并 `commitRepair` 写盘；live 会话的 open turn 反过来会**拒绝** load/resume。
7. **inbox 由 `ownEvents()` 重放**：resume 后 pending 消息复活；fork 子不看继承前缀里的 inbox 事件。
8. **子会话与父会话共享存储根与 cwd 项目目录，但文件与 id 完全独立**；子 id 为 UUID（in-process）或 `session-UUID`（SDK）。
9. **长期摘要状态的关联 key 至少需要 `SessionId + (createdAt, cwd, isSeeded, inheritedEventCount)`，并以 `inheritedEventCount`/`ownEvents()` 区分继承段与自有段**；不可依赖 `firstLiveSeq` 或 `parentSession` 单独作 key。

## 遗留问题（未证实 / 待深挖）

1. 【待深挖】fork 边界落在某 replace 节点的被遮蔽区间内部（而不含该 replace 节点）时，子 surface 与父在该前缀上分叉——源码无防护、无测试。
2. 【待深挖】`session-projection.hydrate` 在全量 cold fold 与 checkpoint 增量之间的剪枝边界（`restoreFloor` + `baseSeq`）与 fork 子（`isSeeded:true`）首次 hydrate 的具体分支，未逐行验证。
3. 【待深挖】goal/todo 之外的其它 projection unit（如 subagent descriptor、modelSelection）是否完全遵守同一 `inheritedEventCount` 边界；本轮只抽验了 subagent descriptor 与 goal/todo。
4. 【未找到】限定范围内没有“fork 时同步复制 goal/todo/长期摘要状态”的实现——状态一律由子自己的日志重算，没有跨会话状态搬运通道。
5. 【未找到】限定范围内没有对 `parentSession` 做存活/存在性校验的实现（父被删除后子仍可 resume，仅 `parentSession` 字段留作 lineage 记录）。
6. 【未证实】多次 fork 同一父、或 fork 子再 fork 时，`delegationDepth` 是否会被 fork 路径写入——`SessionStore.fork` 与 Web fork 都**不写** `delegationDepth`，故 fork 链上该字段保持缺省（0/继承自被 fork 的会话 header），与 delegation 链的 `+1` 语义**不是同一套计数**。

---

*核心实现文件 18 个（另有 2 个辅助实现、3 个测试文件作证）：*

| # | 文件 | 关键符号（行号） |
|---|---|---|
| 1 | `packages/core/session/src/index.ts` | `Session`(425)、`create`(486)、`fromRestore`(505)、构造函数 seed 校验(524-578)、`ownEvents`(615)、`SessionStore.create`(894)、`prepare`(927)、`enter`(977)、`announce`(1032)、`flush`(1086)、`fork`(1145)、`_forkSeed`(1162) |
| 2 | `packages/core/session/src/types.ts` | `SessionHeader`(92-130)、`CreateSessionOptions`(137)、`RestoredSessionOptions`(164) |
| 3 | `packages/core/session/src/preparation.ts` | `SessionPreparation`(20-48) |
| 4 | `packages/core/session/src/surface.ts` | `surfaceOpOf`(195)、`assertProvenance`(221)、`replacementRange`(256)、`planSurfaceEvent`(331) |
| 5 | `packages/core/session/src/repair.ts` | `interruptedTurnClosers`(29-135) |
| 6 | `packages/core/agent/src/index.ts` | `AgentRegistry.enter`(468) |
| 7 | `packages/core/agent/src/inbox.ts` | `Inbox` 构造重放(28-40)、`claim`(71) |
| 8 | `packages/core/agent-loop/src/index.ts` | `create`(652)、`createAgent`(669)、`setupAndPublish`(689)、`resume`(717)、`resumeWith`(726) |
| 9 | `packages/core/agent-loop/src/agent.ts` | 构造函数 `lastTurn`(101)、`preStep`(234)、`turn`(255)、`request/header reason`(508) |
| 10 | `packages/session/session-persistence/src/coordinator.ts` | `create`(685)、`prepare`(811)、`load`(847)、`inspect`(878)、`loadLiveSnapshot`(1153)、`prepareCore`(1066)、`commitPrepared`(1113)、`installWritePath`(1273)、`onCreated`(1427)、`attachPrepared`(1372) |
| 11 | `packages/session/session-persistence-jsonl/src/format.ts` | `HeaderLine`(46)、`toHeaderLine`(66)、`fromHeaderLine`(96)、`isHeaderLine`(117) |
| 12 | `packages/session/session-projection/src/index.ts` | `register`(233)、`session/created` cell(209)、`restore`(476)、`hydrate`(552)、`buildCell`(603)、`cellFor`(615) |
| 13 | `packages/session/session-projection-cache/src/index.ts` | `recordFor`(116)、`cachedSnapshot`(137)、`hydratePrepared`(171)、`identityOf`(354)、`identityMatches`(377) |
| 14 | `packages/session-query/session-query/src/observation.ts` | `preparedProjections`(188-199)、`live`(161) |
| 15 | `packages/subagent/subagent/src/child-agent.ts` | `resolveChildDepth`(49)、`childSessionMeta`(138)、`appendDelegatedPolicyOverrides`(258) |
| 16 | `packages/subagent/subagent/src/continuation.ts` | `start`(430)、`coldResume`(974)、`materializeTracked`(1119) |
| 17 | `packages/subagent/subagent-in-process-driver/src/index.ts` | `startInProcessRun`(104-151)、`readResult`(211) |
| 18 | `packages/subagent/subagent-fork-in-process/src/index.ts` | `completedTurnPrefix`(48)、`prepareContinuable`(84) |

*辅助实现 2 个*：`packages/subagent/subagent/src/depth.ts`（`delegationDepthOf` 28-36）、`packages/api/session-controller/src/commands.ts`（Web fork 188-281）。
*读侧宿主佐证*：`packages/api/session-controller/src/agent.ts`（`inspectApiSession` 112、`resumeObserved` 412、`resume` 428/460）、`.../src/history.ts`（`follow` 105、`validateAddress` 267）、`.../src/index.ts`（`inspect` 192）。
*测试证据*：`core/session/tests/fork.spec.ts`、`core/agent-loop/tests/resume.spec.ts`、`goal/tests/goal.spec.ts`。
