# 07 · DSH storage domain 基础设施：生命周期、原子性、缓存与跨进程能力

> 状态：只读调查。未修改 DSH，未修改插件，未启动任何服务器/进程，未派生子代理。
> DSH 源码：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 范围：`packages/storage/**`（storage hub / storage-domain / storage-json / storage-sqlite）+ `bundle/base/cordis.patch.yml` 的 storage 行 + `util/home-paths`。其他正式 backend 只列能力入口。
> 明确排除：Session JSONL 已落库算法、当前插件业务、compaction、goal/todo、Web。
> 复用事实库：`00`（架构）、`03`（Session 持久化）、`16`（插件摘要持久化，仅作问题背景；其结论本轮回到 DSH storage 源码核验）。
> 证据标注：【已证实】= 直接读源码/测试/README 得到；【已证实·推导】= 由已证实代码路径组合推出，未见测试覆盖；【待深挖】= 有线索未闭环；【未找到】= 范围内检索不到。
> 本轮读实现文件 17 个（`storage/src/{index,registry,backend,error}.ts`、`storage-domain/src/{index,spec,domain,events,invariant}.ts`、`storage-json/src/{index,single-unit,per-record-unit,atomic,format}.ts`、`storage-sqlite/src/{index,unit,schema}.ts`）+ 契约测试 1、配置文件 1、home-paths 1、消费者证据 4（workspace、session-projection-cache、message-feedback、Agent Note）。

---

## 1. 注册、命名、版本化、打开、缓存、关闭、重新打开

**三层结构**【已证实】
- **Hub**（`storage/src/index.ts:47-93`）：`Storage` 是 Cordis Service（`super(ctx, 'storage')`，`:53-55`），自身不做 IO。两个面：`backend: BackendRegistry`（`:49`）与 `forms: Map<keyof StorageForms, unknown>`（`:51`）。
  - `mount(form, facility)`（`:64-75`）把数据形态挂到 hub，重复挂载抛 `duplicate-mount`；返回的 disposer 带 stale 守卫（`:71-73`）；
  - `form(form)`（`:82-87`）取形态，未挂载抛 `form-not-mounted`；`get domain()`（`:90-92`）是 `form('domain')` 的糖。
- **Backend 注册表**（`registry.ts:14-61`）：`register(name, backend)`（`:25-37`）返回 disposer，重名抛 `duplicate-backend`；**disposer 只注销名字，不关闭 backend**（`:20-22`，由持有插件自己 close）；`get(name)`（`:44-53`）未知名字抛 `backend-not-found`（错误信息带已注册列表）。名字空间是**扁平字符串**（示例 `json`/`sqlite`）。
- **形态挂载点与服务键解耦**：每个 backend 插件同时 `provide(storageBackendServiceKey(name))` = `storage.backend.<name>`（`storage/src/index.ts:26-28`），数据形态插件 `inject` 这些键，从而**激活不会与 backend 注册竞态**（`storage-domain/src/index.ts:219-238`）。`storage-json` 用 `'json'`（`storage-json/src/index.ts:118`），`storage-sqlite` 用 `'sqlite'`（`storage-sqlite/src/index.ts:167`）。

**命名与版本化**【已证实】
- domain 名 = backend unit 名，必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`backend.ts:10`）；`defineDomain` 在**模块加载期**就校验名字、版本（非负整数）、`compatibleVersions`（必须 < version）、`layout` 取值、`invalidRecords` 取值、表名，以及"global schema 不得接受 `null`"（`storage-domain/src/spec.ts:107-147`）。失败是 loud throw，发生在触碰介质之前。
- `descriptorOf(spec)`（`spec.ts:154-162`）把 spec 投影为 `KvUnitDescriptor{name, version, tables, hasGlobal, layout?, compatibleVersions?}`（`backend.ts:46-74`）。**domain 名 → unit 名 → 物理路径/表名是同一字符串**，没有独立命名空间或哈希。
- 版本 stamped 在介质上，open 时比对：JSON `single` 精确相等否则 `version-mismatch`（`format.ts:65-71`）；SQLite 存 `units(name, version)` 行（`sqlite/schema.ts:89-94`，比对在 `sqlite/index.ts:100-110`）；SQLite 还有独立物理布局版本 `PRAGMA user_version`（`STORAGE_SQLITE_SCHEMA_VERSION = 1`，`schema.ts:20`、比对 `:81-87`）。**无迁移机制**：版本不合一律拒绝（README 明示 pre-release 立场）。
- `layout` 只有 `'single' | 'per-record'`（`spec.ts:41-47`）；`per-record` 额外接受 `compatibleVersions` 名单，逐条记录版本戳不合就**当不存在丢弃**（`format.ts:101-125`）；`single` 无此宽容（`backend.ts:64-73`）。

**打开序列**【已证实】`DomainFacility.open(spec)`（`storage-domain/src/index.ts:103-175`）：
1. `reserved.has(name)` → `already-open`（`:104-107`，并在入口同步占用名字，所以并发 open 同名会 fail loud）；
2. 路由解析 `routes[name] ?? config.backend` → `ctx.storage.backend.get(...)`（`:109-110`，`backend-not-found` 透传）；
3. 无 `kv` facet → `facet-unsupported`（`:111-116`）；
4. `backend.kv.open(descriptorOf(spec))`（`:117`）；
5. `unit.loadAll()` 并**逐条 zod 校验**（`:119-143`），失败默认整次 open 拒绝（`invalid-record`，带 table/key）；spec 声明 `invalidRecords: 'backup-and-skip'` 且 unit 有 `backupRecord` 时，把记录文档移开、记 error 日志、当不存在继续（`:131-139`）；global slot 永远拒绝（`:151`）；
6. 构造 `DomainImpl`（`:156-159`）并登记进 `domains` Map。任何一步失败都会 `unit.close()`（`:165-168`）并释放名字占用（`:169-174`）。

**缓存**【已证实】只有两处进程内表：facility 的 `domains`（`index.ts:70`）+ `reserved`（`:72`），backend 的 open-unit 表（`storage-json/src/index.ts:40,43`；`storage-sqlite/src/index.ts:61`）。**没有跨进程注册表、没有实例 id、没有文件身份（ino/dev）登记**。

**关闭与重新打开**【已证实】`DomainImpl.close()`（`domain.ts:231-244`）：`disposal ??=` 使重复调用共享同一次 teardown（幂等）；`runClose` 先置 `disposing=true`（新写立即 `closed` 拒绝，`domain.ts:263-266`）→ `await this.chain`（排空在飞写，它们的 `domain/changed` 照常发）→ `await unit.close()` → `closed=true` → `onClosed()` 释放 facility 名字（`:156-159` 的回调）。名字释放后**可以再次 open**，那次 open 会重新 `loadAll()` 从介质重读——这就是"重新打开即重读"的唯一路径。
- 【已证实·推导】`runClose` 若 `unit.close()` reject，则 `closed` 不置位、`onClosed` 不执行 ⇒ 该名字**永久停在 `reserved`**（后续 open 永远 `already-open`），且 `close()` 缓存的是同一个 rejected promise。两个已交付 backend 的 `close()` 都不会 reject（`single-unit.ts:115-123`、`per-record-unit.ts:258-266`、`sqlite/unit.ts:120-126`），故当前不可达；自定义 backend 若 close 会抛，就会踩到。
- 【已证实】facility 卸载时兜底关闭遗留 domain：`closeAll()`（`index.ts:194-196`）在 `storage-domain` 的 effect disposer 里先执行，再卸载形态（`:227-235`）。

---

## 2. layout 的读写/API/内存模型；put/update/delete/list 的并发语义

**两种 layout 的介质与内存模型**【已证实】

| | `single`（默认） | `per-record` |
|---|---|---|
| 介质 | `<root>/<unit>.json` 单文档（`single-unit.ts:33`） | `<root>/<unit>/<table>/<key>.json` + `global.json`（`per-record-unit.ts:56,280,253`） |
| 内存 | unit 持有 `state`（`single-unit.ts:60`），**内存是权威**，文件是投影（`format.ts:15`） | unit **无状态**，目录树即权威；`loadAll` 每次重读（`per-record-unit.ts:206-215`、文件头注释 `:1-11`） |
| 一次写 | 改内存 → `serialize` 整个 state → 原子替换整个文件（`single-unit.ts:140-147`、`format.ts:28-39`） | 只写该 key 的文档（`per-record-unit.ts:284-289`） |
| 写失败 | 回滚内存（`single-unit.ts:82-86, 95-98, 108-111`） | 无需回滚（文件与内存都没变） |
| 键约束 | 键是 opaque 字符串，永不进路径（`backend.ts:96-98`） | 键成为路径段，必须匹配 `[a-zA-Z0-9_-]+`，否则写前拒绝（`per-record-unit.ts:39,308-311`） |
| 坏记录 | 整个 unit 拒绝 `malformed-medium`（`format.ts:47-56`） | 单条坏/旧记录读作不存在，不拖垮 unit（`format.ts:101-125`） |
| 版本升级 | 必须精确相等 | 名单外版本逐条丢弃；另有 legacy 整文件 bootstrap（`per-record-unit.ts:123-157`） |
| `backupRecord` | 无此成员 → `invalidRecords:'backup-and-skip'` 退化为 loud 拒绝（`backend.ts:112-123`、`index.ts:131`） | 有：重命名为 `<key>.json.bak.<YYYYMMDDHHmm>`（`per-record-unit.ts:238-245`） |

- 【已证实】**API 面（domain 层，全部同步读）**：`Domain<S>` 有 `name` / `global`（`get` 同步、`set` 异步）/ `table(name)` / `close()`（`domain.ts:19-119`）；`KvTable` 有 `get`、`entries()`、`keys()`、`size`、`put`、`delete`、`update`（`domain.ts:42-90`）。**没有 list/scan 之外的查询、没有索引、没有批量接口、没有 delete-all**；`entries()`/`keys()` 是**快照拷贝**（`domain.ts:292-300`），迭代期间排队的写落盘不影响本次迭代。
- 【已证实】**读是同步内存读**：`get/entries/keys/size` 只 `assertReadable()` 后读 Map（`domain.ts:287-305`）；`closed=true` 后读抛 `closed`，但**排空期间读仍有效**（`assertReadable` 只看 `closed`，`domain.ts:272-276`）。
- 【已证实】**并发语义（严格串行化于一条链）**：
  - 全部写（`put`/`delete`/`update`/`global.set`）都走 `enqueue`（`domain.ts:263-270`）：`result = chain.then(job)`、`chain = result.then(noop,noop)`，因此链**永不因单次失败断裂**，失败只拒绝调用方自己的那个 promise。
  - 提交顺序固定为**先落盘、再改内存、再发事件**（`domain.ts:307-313, 332-346`），文件头注释与 README 都把它当作不变量（`domain.ts:1-10`；`storage-domain/README.md:88`）。
  - `delete` 的存在性在**该 job 的链槽**上判定，不在调用时刻（`domain.ts:316-319`），返回 `false` 时既不写也不发事件（`:319`）。
  - `update(key, fn)` 是链上的读改写：缺键抛 `missing-key`（`:334-339`），`fn` 在链槽运行故不会交错（`:340-344`）。测试：`storage-domain/tests/domain.spec.ts:263-267`（同键 50 次并发递增不丢）。
  - 【未找到】revison/CAS/乐观锁：**全包零命中** `revision|CAS|if-match`（本轮 grep `revision|lock|busy|BEGIN|TRANSACTION|transact` 在 storage 全包只命中注释）。
- 【已证实】**跨表/跨键无原子性**：每次写是独立的一次 unit 调用；`DomainSpec` 里没有事务、没有 `transact`（Agent Note 明确把它列为 out-of-scope 待做项：`.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md:296`）。消费者要自己补：workspace 用一条**可恢复的两写 mutation 标记**（`workspace/src/spec.ts:33-57` 的 `pendingMutation`，启动 `recoverPendingMutation()` `workspace/src/index.ts:126`）来区分"中断的两次写"与"介质损坏"。

---

## 3. 同进程内写的序列化；revision/CAS/事务/批量提交

- 【已证实】**唯一序列化点是 domain 的写链**（`domain.ts:148-151, 263-270`）。Backend **明确不做**写排序：契约写死"unit 不串行化并发写，顺序是调用方的责任"（`backend.ts:76-84`），JSON 两个 unit 类文件头也各自复述（`single-unit.ts:4-6`、`per-record-unit.ts:191-193`），SQLite unit 亦然（`sqlite/unit.ts:1-7`）。共享一致性套件只测单调用语义，不测并发（`storage/tests/contract.ts:34-100`，5 个用例：空 unit、跨 reopen 往返、覆盖与幂等删除、版本不匹配、close 幂等）。
- 【已证实】**没有 revision / CAS / 事务 / 批量提交**：
  - 介质上唯一的版本号是**常量格式版本**（domain version / `user_version`），不是乐观并发计数；没有任何地方写单调递增的 revision。
  - SQLite 每个原语是**一条 prepared statement**（`sqlite/unit.ts:48-62`），原子性来自 SQLite 单语句语义，**显式不用事务**（`:1-7` 注释、README:72）。
  - JSON 每次写都是"整文档替换"或"单文档替换"，也**没有多写批处理**（`atomic.ts:24-40`）。
- 【已证实】**"批量"只存在于上层节流，不在存储层**：`session-projection-cache` 用 `writeEveryEvents: 200 / writeIntervalMs: 5000` 把多次变更合并成少量 checkpoint 写（`bundle/base/cordis.patch.yml:162-166`），但那是一层 per-record 的软节流，落到底层仍是逐记录写。
- 【已证实·推导】`update()` 提供的"CAS 形状"只是**进程内链序**的涌现属性：它比较的是内存镜像，介质不参与比对，也没有任何断言阻止旧值写回。

---

## 4. JSON 写盘的原子边界、失败回滚、崩溃与目录 fsync

**真实原子边界**【已证实】`writeAtomic`（`atomic.ts:24-40`）：
1. 同目录临时文件 `.${randomUUID()}.tmp`，`open(tmp,'wx',0o600)` 独占创建（`:25-27`）；
2. `writeFile` → `handle.sync()`（**文件 fsync**）→ `close`（`:29-32`）；
3. `rename(tmp, path)`（`:34`）；
4. `fsyncDirectory(dirname(path))`（`:35`）；
5. 任一步抛错 → `rm(tmp,{force:true})` 清理临时文件后重抛（`:36-39`）。

- 【已证实】**POSIX**：rename 是原子替换，且**父目录被 fsync**，故"rename 后崩溃"仍能看到新目录项（`:42-52`）。
- 【已证实】**Windows**：`fsyncDirectory` 直接 `return`（`atomic.ts:45`），且注释说明 libuv 把 rename 映射为 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`（`:5-9`）——**不含 `MOVEFILE_WRITE_THROUGH`**，与 session-log 侧 `win32.ts` 的 write-through publish 不同。storage-json README 把这条登记为已知限制（`storage-json/README.md:143`："Windows rename without explicit write-through … the stricter Win32 write-through publish helper from the session-log backend is planned to move down here when the `log` facet lands"）。⇒ **进程崩溃**下两平台都安全（rename 已生效）；**机器掉电**下 Windows 的目录项耐久性未被保证。
- 【已证实】**"一个 writer per process + last-write-wins 正确"是这套协议自述的前提**（`atomic.ts:7-10`），并且 README 直接登记"无跨进程写锁：两个进程写同一 unit 会交错替换，同一文件按 last-completion wins"（`storage-json/README.md:142`）。
- 【已证实】**失败回滚**：`single` unit 在 publish 失败时把内存改回旧值/删除新键（`single-unit.ts:82-86` put、`:95-98` delete、`:108-111` setGlobal）；domain 层更进一步——**先落盘后改内存**，所以 backend 拒绝时内存根本没动过（`domain.ts:307-313`）。
- 【已证实·推导】**回滚粒度与原子边界不完全对齐**：`publish()` 的 catch 覆盖 `writeAtomic` 的**全部**步骤，包括 rename 之后的 `fsyncDirectory`。POSIX 上若 rename 成功而目录 fsync 抛错，内存会回滚成旧值，而介质已是新值 ⇒ 该 unit 在"下一次发布"之前，进程内读与介质不一致；下一次发布从内存整文档重写，会把它自愈。无测试覆盖此窗口。
- 【已证实】**crash 后可见性契约**：契约与套件都要求"写 resolve 后崩溃再 reopen 必须在 `loadAll` 看到该写"（`storage/tests/contract.ts:43-59`，含 reopen 模拟；`Agent Note:48` 列为第 3 条）。JSON 的 reopen 走 `readFile` + `parse`（`single-unit.ts:34-48`），**只有 `JSON.parse` 失败才 `malformed-medium`**，没有 temp 文件残留回收逻辑（残留 `.tmp` 不会被读取，因为路径是精确的 `<name>.json`）。

---

## 5. 两进程同 `$DSH_HOME`：锁、刷新、watcher、外部变更可见性、LWW

- 【已证实】**没有任何跨进程锁、watcher、刷新或变更通知**：storage 全包 grep `fs.watch|watchFile|flock|lockfile|SQLITE_BUSY|busy|revision|BEGIN|TRANSACTION` **零命中**（唯一命中是 `sqlite/unit.ts:5` 的注释与 `domain.ts:257` 的注释）。互斥只存在于进程内：facility `reserved`（`storage-domain/src/index.ts:71-72,104-107`）、backend `open`/`opening` Map（`storage-json/src/index.ts:40,43,54-57`；`storage-sqlite/src/index.ts:61,87-94`）。
- 【已证实】**外部变更在重启/重开前不可见**：记录只在 `open()` 时 `loadAll()` 读一次（`storage-domain/src/index.ts:119`），此后 domain 只读自己的 Map（`domain.ts:287-305`）。**domain API 里没有任何 refresh/reload**（`domain.ts:97-119`）。唯一能看到外部写入的办法是 `close()` + 重新 `open()`。
  - 【已证实】介质层其实存在"重读"能力，但登记层不用它：`per-record` unit 的 `loadAll()` 每次调用都重扫目录（`per-record-unit.ts:206-215`），而 domain 只在 open 时调一次。
- 【已证实】**JSON 上的后果是"整文档 last-write-wins"，不是行级交错**：每次写把**该 unit 的全部表、全部记录**重新序列化（`format.ts:28-39`）并原子替换（`single-unit.ts:141`）。进程 B 的 open 快照不含 A 之后的写；B 的**任何**写都会用 B 的内存整文档覆盖，静默丢掉 A 的记录（README 登记为 `last-completion wins`，`storage-json/README.md:142`）。DSH 自己的注释也把这套协议的前提写成"exactly one writer per process"（`atomic.ts:7-10`）。
- 【已证实】**SQLite 后端的跨进程几何不同**（能力差异，见 Q8）：一次写只碰一行（`sqlite/unit.ts:99-103`，`INSERT … ON CONFLICT DO UPDATE`），因此**不同键的并发跨进程写都保留**（不会互相整文件覆盖）；但：
  - 【已证实】无 busy-wait/重试：竞争写锁会**立即拒绝**而不是等待（README:130"a competing connection holding a write lock rejects the operation immediately instead of waiting … cross-process coordination is out of scope"）；代码里没有捕获 SQLITE_BUSY 的重试（`sqlite/unit.ts:99-118` 只做 `settle` 包装）。
  - 【已证实·推导】同键 LWW + 陈旧内存：B 的 `update()` 是拿 B 的 open 快照做读改写（`domain.ts:340-344`），A 的并发写会被 B 的下一次写覆盖；`loadAll` 只在 open 时跑一次，故 B 不会察觉。
  - 【已证实】`layout` 对 SQLite **无效**：`materializeUnit` 只看 name/version/tables（`sqlite/index.ts:98-123`），不读 `descriptor.layout`；SQLite 天然是"记录级点更新"。
- 【未找到】任何跨进程/双进程测试：storage 全包测试 grep `concurrent|two processes|cross-process` 只命中 `domain.spec.ts:263` 的**进程内**并发用例与 `sqlite-backend.spec.ts:210,228` 的 `process.platform` 判定。共享一致性套件的 reopen 是"同进程新建 backend 实例指向同一介质"（`storage/tests/contract.ts:16-17`），不是两个进程。

---

## 6. shutdown / reload / HMR 时的 flush、dispose；已打开 domain 是否重读

- 【已证实】**flush 语义在 domain 层是"chain 排空"**：`runClose` 先 `disposing=true` 拒绝新写，再 `await this.chain`（排空已入队写，它们的 `domain/changed` 照常发出），然后 `unit.close()`（`domain.ts:236-244`）。unit 侧 `close()` 再 `Promise.allSettled(inFlight)` 排空仍在飞的发布（`single-unit.ts:115-123`、`per-record-unit.ts:258-266`）。backend `close()` 关闭所有 open unit（`storage-json/src/index.ts:82-90`；`storage-sqlite/src/index.ts:130-149`，先 await 仍在 opening 的 promise）。
- 【已证实】**dispose 顺序由消费者编排**：`bundle/base` 的插件 disposer 是"先 unregister 名字，再 `backend.close()`"（`storage-json/src/index.ts:111-117`；`storage-sqlite/src/index.ts:160-166`）；domain 形态的 effect disposer 是"先 `closeAll()` 排空，再卸载形态"（`storage-domain/src/index.ts:227-235`，注释解释为什么顺序不能反：排空中的写仍会发 `domain/changed`，而 invariant 要能通过 hub 解析到该域）。
- 【已证实】**消费者必须自己登记 domain 关闭**：facility 明确"调用方拥有 handle"（`index.ts:96-99`），实践是消费者在自己的 `ctx.effect` 里 close（`workspace/src/index.ts:121` `workspace.domainClose`；`session-projection-cache/src/index.ts:99,305` —— 后者先清定时器、后由 domain 关闭 effect 排空，注释解释了"晚到的 flush 不可能落在 disposal 之后，它只会以 `closed` 拒绝进 warning"）。
- 【已证实·推导】**reload 后必定重读**：domain 一旦关闭，名字释放（`index.ts:156-159`），再次 `open()` 走完整第 1 节序列，包含一次新的 `loadAll()` 与全量 zod 校验。因此"HMR/重挂 → 重新 open → 从介质重读"成立，条件只是消费者重新执行 `open()`；本轮**未读 Cordis 的 Service init/effect 重挂排序源码**，消费者是否一定重跑 `[Service.init]` 属【待深挖】（`workspace/src/index.ts:93,118-124` 的写法强烈指向"是"）。
- 【已证实】**已打开 domain 在进程存活期间绝不重读**：没有重读 API、没有 mtime/ino 比对、没有 watcher（第 5 节）。对比 Session log 侧至少有 `readStableFile` 的读写前后 stat 重试（`03` Q6）；storage 层连这个都没有。
- 【已证实】**没有任何 flush 端口暴露给消费者**（没有 `domain.flush()`）：唯一保证"数据落地"的办法是 `await put/update/delete/set` 本身——每次写 resolve 即已耐久（`backend.ts:76-84` 契约 + 套件 `contract.ts:43-59`）。

---

## 7. `$DSH_HOME`、profile、workspace 如何决定存储路径与隔离

- 【已证实】**路径公式（唯一一层）**：`storage-json` 的 `root` **没有默认值**，必须由装配显式给出（`storage-json/src/index.ts:22-36`，注释：`process.cwd()` 回退会让 unit 文件散落到进程启动目录）。base bundle 给的是 `root: !!js dshHomePath('storages')`（`packages/bundle/base/cordis.patch.yml:148-151`），于是：
  - `single`：`$DSH_HOME/storages/<domain 名>.json`（`single-unit.ts:33`）；
  - `per-record`：`$DSH_HOME/storages/<domain 名>/<table>/<key>.json`（`per-record-unit.ts:56,280`）。
- 【已证实】`dshHomePath(...)` = `join(resolveDshHome(), ...)`（`util/home-paths/src/index.ts:98-100`）；`resolveDshHome` 优先级为**显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`**，并做 `~` 展开 + `resolve` 规范化（`:76-91`）。环境变量常量 `DSH_HOME_ENV = 'DSH_HOME'`（`:18`），默认目录名 `.dsh`（`:12`）。
- 【已证实】**profile 不参与分片**：本轮 grep 所有 `*.yml`，只有 base bundle 出现 `dsh-storage-json` / `dsh-storage-domain` / `storages`；**没有任何 profile 层覆盖 storage root、backend 或 routes**。storage-domain 的 base 配置是 `backend: json` 且**没有 `routes`**（`cordis.patch.yml:153-156`）⇒ 所有 domain 默认全部落 JSON。
- 【已证实】**workspace 不参与分片**：`root` 里没有任何 cwd/workspace/profile 段；unit 名是常量，记录键由各 domain 决定。workspace 自己**是**一个 domain（`workspace`，version 2，`workspace/src/spec.ts:68-76`），即"工作区清单"这种跨工作区数据就住在单一的 `workspace.json` 里——说明该层的定位是**机器级共享状态**，不是 per-workspace 状态。domain 名相同即为同一份数据，与调用方所在工作区无关。
- 【已证实】**隔离只能靠配置**：要在物理上分片，唯一手段是给 storage-json 一个不同的 `root`（例如某 profile 层覆盖该行），或把某 domain 路由到另一个 backend（`routes`，`storage-domain/src/index.ts:109`、`spec.ts:52-57`）。**domain 名冲突是全局的**：facility 是进程级单例，同名 domain 第二次 open 直接 `already-open`（`index.ts:104-107`），因此"两个插件各自想独占同名 domain"在本层被拒绝，共享只能通过持有 handle 的那个消费者。

---

## 8. 是否存在更适合高一致性跨进程状态的正式存储 seam

**结论：存在一个已实现但未接线的正式 backend（`storage-sqlite`），以及若干并列的持久化 seam；但"跨进程高一致性"在 DSH 设计记录里是明确 out-of-scope。**

- 【已证实】**`storage-sqlite` 是同一个 hub 下的正式 backend**，注册名 `sqlite`（`sqlite/index.ts:158-167`），配置 `path` + `journalMode`（默认 `wal`），一个数据库文件承载所有路由到它的 unit（`schema.ts:60-74`、`recordTableName = u_<unit>_<table>`，`:117-119`），每记录一行 JSON 文本（`unit.ts:48-53`）。相对 JSON 的能力差异：**逐记录点更新**（一次写只碰一行）+ **SQLite 原生多进程锁/原子性**（README:12,72）。
- 【已证实】**它没有被任何装配启用**：本轮 grep 全仓 `*.yml`，`dsh-storage-sqlite` **零命中**；只有 `tsconfig`、`docs`、`package.json`、测试引用它。base bundle 只挂 `storage-json`（`cordis.patch.yml:148-151`），domain 默认路由 `json`（`:153-156`）。⇒ 任何"改用 SQLite 提高一致性"的动作都属于**新配置 + 手工迁移数据**（Agent Note 的 rework point 也这么写：`:293`"point `routes` at sqlite, migrate the data by hand once"）。
- 【已证实】**跨进程能力的天花板写在 DSH 自己的设计记录里**：
  - `.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md:290`："**Multi-process write protection** | two host processes writing one medium | JSON backend file locks; SQLite WAL is natively multi-process | … locking touches backends only" —— 列为 **Out-of-scope**（not doing）。
  - 同文件 `:291`："**Cross-process change observation** | GUI reconnect awareness | the revision pattern (copy session-persistence) | …" —— 同样 **not doing**。
  - `:328`：把"外部进程正在跑同一 session"明确接受为"multi-process is already out of scope, accepted"。
  - 落地侧的证据：`storage-domain/README.md:151` 把"**Single-process change visibility** — `domain/changed` 是进程内事件；第二个宿主进程或重连的 GUI 在 cross-process revision pattern 落地前观察不到任何变更"登记为已知限制；`events.ts:5-7` 也写明"这是后续阶段跨进程变更推送（RPC 帧）的事件源"。
  - 【已证实】因此**没有任何 revision/CAS/变更通知**可依赖；`domain/changed` 是纯进程内 `ctx.emit`（`domain.ts:251-261`，监听器抛错只记 warning，因为"提交点已过"）。
- 【已证实】**并列的其他持久化 seam（只列能力入口，本轮不深挖）**：Session 日志 seam（`session-persistence-jsonl`，root `dshHomePath('sessions')`，`cordis.patch.yml:110-113`，事实见 `03`）；session 检索/查询 seam（`session-query-sqlite`，默认 `path: ':memory:'`、`openAt: never`，即默认不落盘，`:129-133`）；附件字节 seam（`attachment-local`，自有文件树而非 storage hub，`:118-119`）。
- 【未找到】除上述之外，范围内**没有**任何"跨进程锁/注册表/租约/revision 服务/文件 watcher/共享内存"的正式 seam；也没有任何 backend 实现 `flock` 或等价物（JSON 无、SQLite 靠数据库自身）。

---

## 9. 此基础设施能保证 / 不能保证的持久状态不变量（仅陈述事实）

**能保证（源码/契约/套件层面）**
1. **单次写调用在介质上原子且 resolve 即已耐久**；崩溃 + reopen 后 `loadAll` 必能看到该写（`backend.ts:76-84`、`contract.ts:43-59`、Agent Note:48）。
2. **进程内读永不与介质分歧**（对已提交状态）：写是"先落盘后改内存"，backend 拒绝时内存不变（`domain.ts:1-10, 307-313`）；`domain/changed` 的载荷必等于发射时刻的内存值（不变式伴随插件 `invariant.ts:24-59`）。
3. **同进程内同一 domain 的写严格串行、事件按写序到达**；`update` 的读改写不会与并发 `update` 交错（`domain.ts:263-270`、`events.ts:38-47`、测试 `domain.spec.ts:263-267`）。
4. **写入值不会被无关的读路径污染**：域内记录以 zod 在 open 边界全量校验；`single` 介质损坏/版本不合一律 loud 失败，不静默降级（`index.ts:119-143`、`format.ts:47-88`、`contract.ts:74-89`）。
5. **同名 domain 在进程内单开**；关闭是幂等的，关闭后名字可复用（`index.ts:104-107,156-159`、`domain.ts:231-244`、`contract.ts:91-100`）。
6. **`per-record` 下单条坏/旧记录只丢自己**，不拖垮 unit；stale 版本记录读作不存在（`format.ts:101-125`、`per-record-unit.ts:1-27`）。
7. **unit 名/表名/键不会造成路径或 SQL 注入**：名字受限正则、SQLite 标识符经校验后插值、per-record 键先过 `SAFE_KEY_RE`（`backend.ts:10`、`sqlite/index.ts:79-86`、`per-record-unit.ts:308-311`）。

**不能保证（源码明示或缺环）**
1. **跨进程互斥**：无 flock/lockfile/租约；JSON 上两个进程写同一 unit 会交错替换、按 last-completion wins（`atomic.ts:7-10`、`storage-json/README.md:142`）。
2. **跨进程变更可见性与通知**：domain 只在 open 时读一次，无 watcher、无 stat 比对、无 revision，外部写在 reopen 前完全不可见（`index.ts:119`、全包零 watcher 命中；`storage-domain/README.md:151`、Agent Note:291）。
3. **跨进程（以及同进程跨记录）"读改写"不丢更新**：`update` 比的是内存镜像，介质不参与，没有 revision/CAS 断言（`domain.ts:332-346`）。
4. **跨记录/跨表原子事务**：不存在 `transact`，两次写之间的崩溃窗口要消费者自己用标记弥合（Agent Note:296；`workspace/src/spec.ts:33-57`）。
5. **"整文档后写覆盖"这一 JSON 失效模式的免疫**：`single` 每次写重写该 unit 全量记录（`format.ts:28-39`、`single-unit.ts:141`）；记录越多，单次写的代价与被覆盖的暴露面越大。`per-record` 把粒度降到记录，但**同一键**仍是整文档 LWW（`per-record-unit.ts:284-289`、`atomic.ts`）。
6. **机器掉电下的目录项持久性（Windows）**：rename 无 `MOVEFILE_WRITE_THROUGH`，目录 fsync 被跳过（`atomic.ts:43-46`；README:143）。
7. **迁移与向前兼容**：版本不合一律拒绝；`single` 必须精确相等；没有迁移工具（`spec.ts:38-40`、`json README:56`、`sqlite README:131`）。
8. **SQLite 路径上的忙等/重试**：竞争写锁立即失败，无重试策略（`storage-sqlite/README.md:130`）。
9. **"每个 domain 恰好一个写者"之外的强断言**：全包没有任何单调性/序号/时间戳校验；`single` 记录里连"哪次写更新"都不存（`format.ts:33-38` 只有 unit 头 + global + tables）。

---

## 决策事实

1. **DSH 的正式长期状态原语只有一组**：`ctx.storage`（名字注册表，无 IO）→ backend（介质拥有者，唯一 facet 是 `kv`）→ `ctx.storageDomain`（唯一的类型化消费者，zod 校验 + 写链 + `domain/changed`）。产品包不许直接碰 backend（`storage-domain/README.md:12`、Agent Note:38-42）。
2. **命名空间 = domain 名 = unit 名 = 路径段**，进程级全局唯一、不可配置；两插件要共享同一份 durable 状态，唯一合法方式是其中一方持有 handle（`already-open` 挡住第二次 open）。
3. **交付的装配是 `backend: json` 且无 routes**（`cordis.patch.yml:148-156`）⇒ 默认所有 domain 都是 `$DSH_HOME/storages/<name>.json` 整文档 LWW，且 profile/workspace 都不参与分片。
4. **一致性保证的层级是"单次调用"**：单调用原子 + 耐久 + 进程内串行；**没有**跨进程锁、没有 revision/CAS、没有事务、没有变更通知。这套假设被 DSH 源码原样写进协议注释（"exactly one writer per process and last-write-wins is correct"，`atomic.ts:7-10`），并在 Agent Note 的 out-of-scope 表里被显式接受。
5. **唯一的"逐记录 + 多进程锁"正式 backend 是 `storage-sqlite`，但未接线**：启用 = 改装配 + 手工迁移；且它只把几何从"整文档覆盖"改成"记录级 LWW"，**不提供**跨进程可见性、revision 或事务；忙锁立即失败。
6. **"重新打开即重读"是本层唯一的新鲜度机制**：`close()` + `open()`（含全量 zod 校验）是进程内看到外部写入的唯一路径；`per-record` unit 的 `loadAll` 有重读能力但 domain 层不用它。
7. **flush 没有独立端口**：写 resolve 即耐久；dispose 顺序（先排空 domain、再卸载形态、backend 先注销再 close）由装配方负责编排，消费者必须自己 `ctx.effect(() => () => domain.close())`。
8. **`invalidRecords: 'backup-and-skip'` 只在 `per-record` 上有效**（`single` 无 `backupRecord`）——这是"派生/可丢弃数据"与"权威数据"在本层的唯一分歧开关。

## 跨专题问题

1. **【交给压缩方案 4 的落地方案】**若插件需要一个"多进程下不丢"的长期状态，本层只能提供：(a) 单进程独占的 JSON domain（现状）；(b) 改装配路由到未接线的 `storage-sqlite`（记录级 LWW，仍需自行解决可见性）；(c) 完全绕开本层另建 seam（例如复用 Session 日志或自建带锁文件）。三者的装配代价与迁移成本需要独立评估，本轮不给方案。
2. **外部写入不可见 vs 消费者缓存**：`session-projection-cache`、`workspace`、`message-feedback` 都在 open 时一次性把 domain 读进内存，之后永不重读；任何"另一个进程改了这些 domain"的场景都只能通过重启观测。需要确认产品面是否假设了"只有一个宿主进程"。
3. **`single` 整文档重写的规模前提**：Agent Note:327 自己把它列为 risk（"if the second consumer lands on the JSON backend at thousand-record scale … the mitigation is exactly `routes` pointing at sqlite"）。需要量化某 domain 的记录数与记录大小以判断何时必须换 backend。
4. **`storage-sqlite` 的真实跨进程行为缺少任何测试与文档闭环**：只有"SQLite WAL is natively multi-process"一句设计陈述（Agent Note:290）与"竞争锁立即拒绝"（README:130）。需要一次受控实验（两进程，各写不同键 / 同键）来确认几何，本轮不执行。
5. **`runClose` 的失败路径**：`unit.close()` reject ⇒ 名字永久 `reserved`、`close()` 永久拒绝。当前两个 backend 不可达，但这是 backend 作者容易踩的隐式契约；是否应把 `onClosed` 放进 `finally` 属于上游设计问题。
6. **`publish()` 的 rename 后 fsync 失败窗口**（Q4 推导项）：内存回滚/介质已改的分歧是否可观测、是否需要按步骤区分回滚，未见测试。
7. **Cordis 重挂排序未核验**：本轮未读 Cordis Service/effect 的重挂语义，"HMR 后消费者会重跑 `[Service.init]` 从而重新 open 并重读"仍是推导；若要在方案里依赖它，需读 `cordis` 源码补齐。
8. **`layout` 对 SQLite 无效**（`sqlite/index.ts:98-123` 不读 `layout`）：把 `per-record` domain 路由到 sqlite 时语义是否仍等价（尤其 `compatibleVersions` 与 `backupRecord` 的差异）需要专门确认。

---

*本轮检查实现文件 17 个：`packages/storage/storage/src/{index,registry,backend,error}.ts`、`packages/storage/storage-domain/src/{index,spec,domain,events,invariant}.ts`、`packages/storage/storage-json/src/{index,single-unit,per-record-unit,atomic,format}.ts`、`packages/storage/storage-sqlite/src/{index,unit,schema}.ts`；契约/测试 1：`packages/storage/storage/tests/contract.ts`；配置与路径 2：`packages/bundle/base/cordis.patch.yml:110-166`、`packages/util/home-paths/src/index.ts`；消费者与文档证据 4：`packages/workspace/workspace/src/{index,spec}.ts`、`packages/session/session-projection-cache/src/{index,spec}.ts`、`packages/feedback/message-feedback/src/spec.ts`、`.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md`；另用 storage 包 4 个 README 作交叉印证。未修改任何文件（除本报告）。*
