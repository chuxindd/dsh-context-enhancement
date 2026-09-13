# DSH Session 持久化、恢复与多实例可见性机制事实

> 状态：基于 DSH 源码静态实现事实核验。
> DSH 源码根目录：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 调查范围：`packages/session/session-persistence/**`、`packages/session/session-persistence-jsonl/**`、`packages/core/session/**` 及 host/projection 调用层。
> 约束：只陈述源码实现事实，不审计插件，不修改源码。

---

## 核心问题调查结论与源码证据

### 1. Session header/event 的磁盘格式、路径定位、append 顺序和持久提交时机

- 【已证实】**磁盘文件格式与第一行 Header**：
  - 文件格式为逐行 JSONL（plaintext 或 Zstandard 逐帧压缩，默认 `compression: 'zstd'`）。
  - **首行必须为 Session Header**（`packages/session/session-persistence-jsonl/src/format.ts:46-89, 314-329`）：
    - 记录类型 `{ type: 'session', version, id, createdAt, cwd?, parentSession?, seedLength?, origin?, delegationDepth, agentPreset? }`。
    - 若首行缺失、非合法 JSON、或非 `type: 'session'`，报 `corrupt session log`（`format.ts:315-327`）。
    - 若版本不匹配当前 harness 的 `SESSION_FORMAT_VERSION`（当前为 0），抛出 `SessionFormatUnsupportedError`（`format.ts:305-312`）。
  - **后续行 Event 存储格式**（`format.ts:254-270`）：
    - 默认开启 `packChunks: true`，连续的 `assistant/chunk` 事件在落盘前被打包压缩为 `text-chunks`、`reasoning-chunks`、`tool-call-chunks` 单行存储记录（`format.ts:255`）。
    - 节点回溯来源 `sourceEventSeqs`（如 replacement 节点的替换来源）在持久化时做 Run-Length 压缩：3 个及以上连续 seq 被编码为 `[start, end]`（`format.ts:260-270`）。
- 【已证实】**路径定位规则**：
  - 根目录为配置项 `root`（默认通过 `dshHomePath('sessions')` 解析到 `$DSH_HOME/sessions` 或 `~/.dsh/sessions`，`packages/bundle/base/cordis.patch.yml:110-113`）。
  - 完整文件路径公式（`packages/session/session-persistence-jsonl/src/format.ts:180-242`）：
    - 项目目录：`projectDir = root/--${slug(cwd)}--`（无 cwd 时为 `root/_no-cwd`）。
    - 会话目录：`sessionDir = projectDir/${encodeSegment(id)}`（字符经 `~XXXX` 编码转义，`format.ts:154-169`）。
    - 物理文件：`session.jsonl`（无压缩）或 `session.jsonl.zstd`（Zstandard 压缩）。
    - `locate(meta)` 接口直接根据该公式计算绝对路径，不触发磁盘 I/O（`packages/session/session-persistence-jsonl/src/index.ts:182-184`）。
- 【已证实】**Append 顺序与单 Session 串行化**：
  - `PersistenceCoordinator` 对每个 `SessionId` 维护独立的 Promise 链 `chains.get(id)`（`packages/session/session-persistence/src/coordinator.ts:651, 1197-1207`）。
  - 所有针对同一会话的操作（`createCore`、`appendCore`、`prepareCore`、`commitPrepared`、`readFromCore`）必须挂入该 session 的 Promise 链排队，确保同进程内单会话写操作绝对严格按顺序单工执行，绝不并发交叉。
  - `appendCore` 强制校验事件序列连续性：断言 `event.seq === state.cursor + i`（`coordinator.ts:784-788`），若不匹配直接拒绝。
- 【已证实】**持久提交时机**：
  - 首次物化（`materialize`）：新会话在内存注册时是惰性的（`materialized = false`），直到第一批事件写入或显式调用 `ensureMaterialized` 时，先写临时文件 `.dsh-...tmp`，经 `sync()` 后再通过原子移动/链接发布（`session-persistence-jsonl/src/index.ts:549-627`）。
  - 日常事件：由 `session/event` 监听器截获，进入 `SessionWriteBehind` 队列，等待批次定时器触发或显式 `flush()` 提交（见下题）。

---

### 2. Write-behind、flush/fsync、正常关闭和进程崩溃时的源码保证与明确缺口

- 【已证实】**Write-Behind 缓冲与批量持久化**：
  - 调度实现位于 `packages/session/session-persistence/src/write-behind.ts`。
  - 批处理窗口：`writeBatchMaxDelayMs` 默认 **200ms**（`write-behind.ts:82-84`；`coordinator.ts:46`）。
  - 当队列为空且新事件入队时，启动定时器 `armTimer()`。超时触发 `onDeadline()` 开始后台写入并清空 pending（`write-behind.ts:45-56, 93-100`）。
  - 写入在后台 Promise 中进行；若后台写失败，将失败批次完整插回 `pending` 头部（`batch.concat(this.pending)`），暂停自动调度并记 warning 日志，保留数据不丢（`write-behind.ts:145-152`）。
- 【已证实】**Flush 与 Fsync 保证**：
  - 显式 `flush`（`write-behind.ts:63-72, 118-136`）：取消等待定时器，创建 `barrier` Promise，循环排空 `pending` 中的所有批次直到队列为空。
  - 落盘 Fsync：
    - 在 `appendLines` 中，每次写入 `handle.writeFile(content)` 后必须显式 `await handle.sync()` 强制刷盘（`session-persistence-jsonl/src/index.ts:708`）。
    - 若 `writeFile` 或 `sync` 抛出异常，捕获后调用 `rollbackAppend` 将文件截断回写入前的 `size` 并再次 `handle.sync()`，防止半写数据污染（`index.ts:709-717, 723-731`）。
    - 目录元数据同步：POSIX 下 `materializePosix` 对父目录调用 `syncDirPosix`（`index.ts:596, 678-685`）；Win32 下通过系统调用 `MOVEFILE_WRITE_THROUGH` 确保目录项耐久（`win32.ts:116-120`）。
- 【已证实】**正常关闭保证（Graceful Shutdown）**：
  - `PersistenceCoordinator.installWritePath` 中通过 Cordis `ctx.effect` 注册销毁钩子（`coordinator.ts:1279-1302`）。
  - Cordis 卸载时倒序触发：先关闭新事件准入，再并发 `flush` 所有活动的 live sessions（`errors = await settledErrors([...this.live.keys()].map(s => this.flush(s)))`），随后等待会话操作链 `chains` 彻底排空，最后调用 `backend.close()`。若有失败聚合为 `AggregateError` 抛出。
- 【已证实】**进程崩溃时的源码保证与明确缺口**：
  - **保证**：
    - 已完成 `handle.sync()` 的完整批次在磁盘上持久存在。
    - 若崩溃发生在文件尾部写入中途，恢复时检测到文件尾部不完整（JSONL 未换行或 Zstandard 帧不完整），启动截断修复机制（见第 3 题）。
  - **明确缺口**：
    - **Write-behind 内存丢失窗口**：进程若遭遇 `SIGKILL`、断电或内核崩溃，停留在 `SessionWriteBehind.pending` 队列中（最长 200ms）的事件未进入 Node 文件系统，**彻底丢失**。
    - **单会话锁仅限同进程**：进程崩溃后重启没有持久化锁文件需要清理，但崩溃瞬间未完成 flush 的内存状态不可恢复。

---

### 3. 重启加载如何选择记录、验证连续前缀、处理损坏尾部及 orphaned turn

- 【已证实】**记录选择与连续前缀验证**：
  - 恢复入口为 `coordinator.load(id)` / `coordinator.prepare(id)`（`coordinator.ts:811-866, 1066-1110`）。
  - 扫描底层日志（`format.ts:337-454`）：
    - 首先读取并严格校验首行 Header（`parseHeaderRecord`）。
    - 逐行解码并校验 `seq`：断言 `event.seq === this.events.length`（`format.ts:441-450`）。若出现断号（seq gap）或单行不可解析，记录 `this.issue`。
    - 若遇到 `turn/end` 且之前存在 issue，立即判定日志破坏，抛出 CorruptionError；若损坏发生在未闭合的末尾，则容忍并进入截断修复。
- 【已证实】**损坏尾部（Torn Tail）处理**：
  - Plaintext JSONL：若文件末行没有 `\n`，`SessionLogScanner` 视其为 incomplete fragment，`committedBytes` 仅记录到最后一个有效 `\n` 之后；`scanLog` 返回 `tornMarker: { truncateTo: committedBytes, recoveredEvents: [] }`（`session-persistence-jsonl/src/index.ts:346-348`）。
  - Zstandard 压缩：`scanZstdFrames` 扫描帧结构，若末尾帧不完整（`tornStart !== undefined`），尝试用 `decompressZstdPrefix` 解压其前缀残片并提取完整事件行；同时设置 `tornMarker: { truncateTo: tornStart, recoveredEvents: [...] }`（`index.ts:404-435`）。
  - 提交修复（`commitRepair`，`session-persistence-jsonl/src/index.ts:469-479`）：
    - 物理截断：执行 `fs.truncate(path, tornMarker.truncateTo)` 并 `handle.sync()`，直接物理丢弃损坏尾部。
    - 补写残片中解析出的完整事件。
- 【已证实】**Orphaned / Interrupted Turn 修复**：
  - 源码位置：`packages/core/session/src/repair.ts:29-135` (`interruptedTurnClosers`)。
  - 若持久化日志最后处于未闭合的 turn（`openTurn !== null`，即存在 `turn/start` 但无对应的 `turn/end`）：
    1. **悬空 Tool-call 补全**：若在 assistant message 中请求了工具调用但未记录结果，构造确定性的合成错误结果 `tool/result`（错误码为 `TOOL_NOT_STARTED` 或 `TOOL_OUTCOME_UNKNOWN`，`repair.ts:93-125`）。
    2. **未闭合 Step 补全**：若 `openStep !== null`，合成追加 `{ type: 'step/end', data: { turn, step } }`（`repair.ts:130-132`）。
    3. **Turn 闭合**：合成追加 `{ type: 'turn/end', data: { turn, reason: { kind: 'interrupted' } } }`（`repair.ts:133`）。
    4. 合成事件的 `time` 复用日志最后一条真实事件的时间戳，`seq` 紧随其后递增。
  - 修复落地（`coordinator.ts:1123-1127`）：
    - `load` / `commitPrepared` 会调用 `backend.commitRepair(..., tornMarker, closers)`，将 synthetic closers 真正持久化追加到磁盘中，使磁盘日志变为合法闭合状态。

---

### 4. Replacement/summary 类型节点是否和普通事件同样持久；回放如何重建 surface，哪些相关状态只存在内存

- 【已证实】**持久化形式与普通事件完全相同**：
  - Replacement 节点（如 compaction-basic 生成的携带 `<compacted-summary>` 的 `user/message`、以及伴随的 `compaction/summary` 或 `compaction/prune` 审计事件）**与普通 SessionEvent 具有完全相同的存储结构**，都作为独立的 JSONL 行落盘（`packages/core/session/src/surface.ts:214-253`；`02-Compaction与Replacement.md:89-94`）。
  - 唯一的区别在于其 Envelope 上的属性：
    - `surfaceOp: { op: 'replace', start: seqA, end: seqB }`。
    - `sourceEventSeqs: SessionSeq[]`（被遮蔽的历史节点 seq 列表，落盘时经 `encodeSeqRanges` 压缩）。
  - 磁盘不维护独立的“表面文件”或“快照索引”，全部由事件日志驱动。
- 【已证实】**回放时 Surface 的重建**：
  - 重建入口：`Session.fromRestore`（`packages/core/session/src/index.ts:505-553`）。
  - 恢复会话时，底层实例化 `SurfaceManager(this.log)`（`index.ts:428`）。
  - 遍历 seed 事件时，逐个调用 `this.surfaceManager.validateNext(snapshot)`，内部通过 `planSurfaceEvent` 与 `applySurfaceEvent`（`packages/core/session/src/surface.ts:413-475`）动态维护 `_state.nodes`（可见表面节点索引数组）与 `_state.replaceGeneration`（单调递增替换代数）。
  - 只要重放完整个事件日志，被 replace 遮蔽的节点就会从 `nodes` 列表中剔除，完美复现当时的模型可见 surface。
- 【已证实】**哪些状态只存在内存**：
  - `SurfaceManager._pendingPlan`：准备提交但尚未正式进入日志的暂态计划（`surface.ts:420`）。
  - `Session.eventsSnapshot`：日志全量事件的浅拷贝缓存（`packages/core/session/src/index.ts:581`）。
  - `SessionStore` 的 WeakMap 绑定关系（`attachments`，`index.ts:415`）。
  - 运行时锁：Compaction 的 bracket 状态（在内存由 compaction-invariant 和 region 检查，虽然 `compaction/start` 事件落盘，但没有跨进程的分布式锁，见第 6 题）。
  - `SessionWriteBehind` 的 `pending` 队列、定时器及 barrier（`write-behind.ts:23-28`）。

---

### 5. Session 缓存/registry 在哪里；重新打开会话何时读盘，何时复用内存对象

- 【已证实】**缓存与 Registry 的三级分布**：
  1. **Live Session Registry (`ctx.sessions`)**：
     - 位置：`packages/core/session/src/index.ts:840-1129` (`SessionStore` 服务)。
     - 内部使用 `store = new Map<SessionId, SessionEntry>()`，保存当前宿主进程内处于活跃状态的 Live `Session` 实例。
  2. **Coordinator Prepared LRU 缓存 (`preparations`)**：
     - 位置：`packages/session/session-persistence/src/preparations.ts:38-42` (`SessionPreparations`)。
     - 默认容量为 5（`DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5`，`coordinator.ts:43`）。
     - 保存尚未发布为 Live Session、但已完成冷解析与校验的 `PreparedSessionSource` 对象。
  3. **Coordinator Live 状态跟踪 (`states` / `live`)**：
     - 位置：`packages/session/session-persistence/src/coordinator.ts:640-642`。
     - `states = new Map<SessionId, SessionState>()`：记录 session 的 cursor、materialized 状态及 owner。
     - `live = new Map<Session, LiveSessionState>()`：记录活跃会话的 write-behind 控制器。
- 【已证实】**重新打开时的复用与读盘判定**：
  - 入口：`coordinator.load(id)` 与 `coordinator.prepare(id)`（`coordinator.ts:811-866`）：
    1. **若 Session 当前在 `ctx.sessions` 中存活（Live）**：
       - `load(id)`：**直接复用内存对象**，调用 `loadLiveSnapshot(live)`（`coordinator.ts:850-851, 1153-1168`），执行 `flush(session)` 确保当前缓冲刷盘后，直接提取内存中的 `session.snapshotEvents()`，不重新读盘；若此时该 Live 会话有未关闭的 turn，直接报错拒绝 load。
       - `prepare(id)`：直接抛错 `cannot prepare session while it is live`（`coordinator.ts:814-816`）。
    2. **若在 Prepared LRU 缓存中（Ready）**：
       - 命中 `preparations` 缓存，检查 `isPreparedSourceCurrent(source)`（`coordinator.ts:1145-1150`）：
       - 调用 `backend.readStoredRevision(id)` 获取磁盘文件的 stat 属性（`dev:ino:size:mtimeNs:ctimeNs`，`session-persistence-jsonl/src/index.ts:101-118`）。
       - 若 revision 一致，**复用缓存中的内存 Session**，不重新读取或解析全量 JSONL/Zstd 内容。
       - 若 revision 不一致（磁盘被外部改写），调用 `discardReady` 废弃缓存，回退到读盘。
    3. **若完全冷加载（Cold Read）**：
       - 调用 `backend.loadStored(id)` 全量读盘并解码。

---

### 6. 两个 DSH 进程同时读取或写入同一会话时，有无文件锁、版本/CAS、刷新、轮询或变更通知

- 【已证实】**无跨进程文件锁（No File Lock / Flock）**：
  - 源码排查：在 `session-persistence`、`session-persistence-jsonl` 及其 Windows 原生辅助模块 `win32.ts` 中，**没有任何 `flock`、`lockfile`、`fcntl`、`LockFileEx` 或基于文件的互斥锁实现**。
  - 写文件使用标准的 `fs.open(path, 'a')` 进行 append（`session-persistence-jsonl/src/index.ts:696`）。
- 【已证实】**无 cross-process CAS、轮询或文件系统变更通知**：
  - 源码中没有任何针对 session 文件的 `fs.watch`、`fs.watchFile`、inotify 或 ReadDirectoryChangesW 监听。
  - `readStableFile` 仅在单进程单次读取内部做轻量重试循环（读取前后对比 `stat` revision，若在读取期间发生写操作导致 stat 变动则重试读取，`index.ts:310-322`），但这只是防止读取到被截断的半帧，并不提供多进程并发控制。
- 【已证实】**单机首次创建时的文件排他（TOCTOU 保护）**：
  - 在首次 `materialize` 创建会话目录和文件时：
    - POSIX：写入临时文件后使用 `fs.link(tmp, finalPath)` + `fs.unlink(tmp)` 发布；如果两个进程同时新建同一 SessionId，后者的 `link` 会因 `EEXIST` 失败报错（`index.ts:580-585`）。
    - Win32：通过 `publishNewFileWin32` 调用 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)`，目标存在则报错（`win32.ts:116-120`）。
- 【已证实】**双进程并发写同一已存在会话的破坏性事实**：
  - 一旦会话文件已存在，两个 DSH 进程同时 append 时：
    - 由于缺少跨进程互斥锁，两个进程的 WriteBehind 定时器（各自 200ms）可能并发执行 `handle.writeFile`。
    - 两个进程在内存各自维护自增的 `seq` 和 `cursor`。如果进程 A 追加了 seq 10，进程 B 在不知情的情况下也追加了 seq 10，磁盘文件将出现**重复的 seq 序列或交错的 JSONL 行 / Zstd 帧**。
    - 某一方写失败触发 `rollbackAppend` 时，会执行 `handle.truncate(before)`，可能**直接截断抹掉另一个进程刚刚追加的有效数据**（`session-persistence-jsonl/src/index.ts:709-727`）。
    - 进程间没有任何通知机制促使另一方重新读盘。

---

### 7. Session ID、profile、home、workspace 或存储根目录如何决定两个 DSH 是否访问同一份数据

- 【已证实】**决定存储位置的四要素**：
  1. **Storage Root (`root`)**：
     - 配置来源：profile patch 文件（如 `packages/bundle/base/cordis.patch.yml:113` 中的 `root: !!js dshHomePath('sessions')`）。
     - `dshHomePath('sessions')` 展开为：`$DSH_HOME/sessions`；若无环境变量则回退到用户主目录 `~/.dsh/sessions`（`packages/util/home-paths/src/index.ts:98`）。
     - **只要两个 DSH 进程的 `$DSH_HOME` 解析到相同的文件系统物理路径，它们的存储根目录就完全相同**。
  2. **Workspace / Working Directory (`meta.cwd`)**：
     - 创建 Session 时传入的 `meta.cwd`（`packages/core/session/src/index.ts:945`）。
     - 生成项目子目录 `projectDir(root, cwd) = root/--${slug(cwd)}--`（`session-persistence-jsonl/src/format.ts:180-212`）。
     - 若两个进程以相同的绝对路径工作区启动，其项目子目录完全相同。
  3. **Session ID (`meta.id`)**：
     - 目录路径为 `projectDir/${encodeSegment(id)}/session.jsonl[.zstd]`。
     - 如果两个进程指定了相同的 Session ID，则映射到同一个磁盘文件。
  4. **全局跨项目扫描与冲突检查（Identity Check）**：
     - `JsonlSessionPersistence.findLog(id)` 会扫描 `root` 下的所有项目目录（`session-persistence-jsonl/src/index.ts:816-837`）。
     - 若同一个 `id` 在多个不同的 `cwd` 项目目录下被发现，抛出异常：`duplicate JSONL session id ... appears in multiple project directories`（`index.ts:833`）。
     - 在写入或加载时，强制断言物理文件中的 `header.cwd` 必须与请求的 `meta.cwd` 一致；若同一 id 在不同 cwd 访问，拒绝加载（`coordinator.ts:1442, 1501`）。

---

### 8. 恢复完成后，投影/消费者如何收到已有历史：重放事件、restore hook，还是读取重建 Session

- 【已证实】**构造器种子（Constructor Seed）不发布 `session/event`**：
  - 核心事实：通过 `Session.fromRestore` 或带有 `seed` 构造的 Session，**其历史事件绝不在 Cordis 总线发布 `session/event`**（`packages/core/session/src/index.ts:454-475`）。
  - 源码明确注解：“`Events with smaller seq values entered through construction — replay, fork, or resume — and were never published on the session/event firehose (constructor seeds do not emit)`”（`index.ts:454-457`）。
  - 会话初始化时会记录 `firstLiveSeq = SessionLogOffset(this.log.length)`，并向日志末尾打入一个标记事件 `{ type: 'session/end-seed' }`（`index.ts:555, 575-577`）。后续只有 live 阶段新 append 的事件才会触发 `session/event`。
- 【已证实】**消费者获取历史的三种途径**：
  1. **主动读取重建后的 Session（主路径）**：
     - 上层消费者（如 AgentLoop、Web API Controller）通过 `ctx.sessions.get(id)` 拿到重建的 `session` 实例，调用 `session.deriveMessages()` 或 `session.surface.nodes` 直接读取投影好的当前模型可见历史。
  2. **声明式投影服务的增量 Tail 折叠（`session-projection` 机制）**：
     - 源码：`packages/session/session-projection/src/index.ts:472-540` (`restore`)。
     - 投影机制（如 agent 列表、元数据、title 等）使用 `restoreFloor` 计算已持久化 Checkpoint 与当前日志尾部的差异序列，调用持久层 `readFrom(id, fromSeq)` 获取增量事件后缀，将缺少的部分通过 `def.apply(state, event)` 顺序折叠到当前最新状态，并更新内存缓存。
  3. **基于 `session/created` 钩子探测新会话挂载**：
     - 消费者（如 `session-controller`、`session-telemetry`）通过监听 `session/created` 事件捕获 Session 挂载（`packages/core/session/src/index.ts:1025-1060`）。
     - 但收到该事件时，消费者获得的是整个 Session 对象的引用，若需要历史，通过 `session.snapshotEvents()` 从内存读取，而非等待事件重播。

---

## 供后续代理直接引用的摘要

1. **磁盘组织**：以 `$DSH_HOME/sessions` 为根，按工作区路径名哈希分层 `root/--<cwd-slug>--/<session-id>/session.jsonl[.zstd]`。文件首行为 JSON Session Header，后续为 JSONL 事件行（默认开启 chunk 打包与 Zstandard 帧压缩）。
2. **写路径与持久性**：会话事件写入由 `SessionWriteBehind` 缓冲，默认最长防抖 **200ms**。每次底层批量写入均调用 `handle.sync()` 强制 fsync，写失败自动回滚截断。正常停机时由 Cordis effect 倒序排空 `flush`；但在进程硬崩溃（Kill/断电）时，200ms 缓冲队列中的事件存在丢弃窗口。
3. **恢复与修复机制**：重启读取时逐行验证 `seq` 连续性。文件末尾残缺的半行或损坏 Zstd 帧会被自动物理截断（`commitRepair`）；对于因崩溃遗留的未闭合 Turn（Orphaned Turn），由 `interruptedTurnClosers` 自动合成错误 Tool Result、`step/end` 和 `turn/end`，并在磁盘中持久化闭合。
4. **Surface 与 Replacement**：Compaction / Replacement 节点作为普通事件行完整落盘，Envelope 携带 `surfaceOp: replace` 与 `sourceEventSeqs`。回放时由 `SurfaceManager` 顺序重放事件流，动态剔除被遮蔽节点以重建模型可见视图。
5. **并发与多实例缺失**：**DSH 完全没有跨进程文件锁（No flock）、没有文件变更监听（No fs.watch）、没有跨实例 CAS 机制**。若两个 DSH 进程指向同一个 `$DSH_HOME` 并并发读写同一 Session，会导致内存 cursor 冲突、写冲突覆写甚至回滚截断破坏，读取方也完全无法感知外部进程的追加。
6. **回放通知**：恢复历史事件不会在总线重新激发 `session/event`，消费者通过读取重建的 `Session` 对象或调用 `session-projection.restore` 增量补齐。

---

## 交给其他任务的问题

1. **多实例/重启场景下 Web Controller 行为**：当另一个 DSH 实例改写了磁盘日志，或者当前 DSH 重启后客户端重连，Web Session Controller 是否直接依赖只读的 `readFrom` / `readStoredRevision`，还是因为内存中的准备缓存未失效导致向前端推送了陈旧视图？
2. **插件对非持久化生命周期的干预**：当前插件在 `session/created` 与 `agent/pre-step` 之间，是否误假设所有历史事件都会通过 `session/event` 重新发送，从而在重启恢复时漏掉了关键上下文初始化？
3. **Compaction 触发与外部修改的冲突**：如果在多实例并发访问下，一个实例正在执行 compaction 生成 replacement 节点，另一个实例正在写入新事件，由于缺少跨进程锁，是否会导致 replacement 遮蔽范围索引错乱？
