# E09 · Fork/Resume 实验（Stable Task State 生命周期区分）

> 状态：已完成。判定 **not-reproduced**（未复现错误 identity / cursor / stable 交叉引用；同时记录了两条与《理想化落地方案》§5.5 不一致的**契约不完整**事实）。
> 基线：插件 HEAD `cf034b4bce6141bb95b590f5ed7fa66f8727daa2`，DSH HEAD `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。
> 本目录为唯一写入位置；未修改生产源码、现有 tests、harness、`package.json`、`vitest.config.ts`、`lib`、tgz 或其他实验目录。

---

## 1. 唯一实验问题

Task State stable 在同一 Session 的 **resume** 与 **fork child** 两种生命周期下，是否正确区分 identity、stable、cursor 和继承前缀：

1. fork child 是否**错误共享父 stable**？
2. resume 是否**丢失已有 stable**？
3. 是否**误用 `firstLiveSeq` 代替 `inheritedEventCount`**（继承边界）？

## 2. 准确命令

```powershell
pnpm exec vitest run --config 审计资料/实验结果/harness/vitest.experiment.config.ts 审计资料/实验结果/E09-ForkResume/e09-fork-resume.spec.ts --reporter=verbose
```

- 工作目录：`C:\Users\chuxi\Documents\trae_projects\code\dsh-context-enhancement`
- 原始输出：`vitest-output-run1.txt`（22:44:25）、`vitest-output-run2.txt`（22:42:33）；另有一次完全相同的收尾复核运行（输出与 run1 逐字节一致，未另存）。
- 结果：`Test Files 1 passed (1) / Tests 1 passed (1)`，exit code 0，共 3 次通过运行，核心数值（cursor 5 / 28 / 29 / 33、audit 行数 3/1、child includedSeqs、判定）逐项一致。

## 3. 合成方式（真实 / fake 的边界）

**真实（未改一行生产代码）**

| 组件 | 来源 |
|---|---|
| Session 存储与恢复 | 真实 `SessionStore` + 真实 `@deepseek-ai/dsh-session-persistence-jsonl`（磁盘 JSONL，落在本目录 `tmp-sessions/`） |
| resume（习语路径） | 真实 `sessionPersistence.prepare(id)` → `ctx.sessions.enter(session)` → `ctx.sessions.announce(session)`（与 DSH persistence 契约测试及 E07 同一习语） |
| resume（生产 agent 路径） | 真实 `ctx.agents.resume({ resumeSessionId, agentOptions })`，AgentLoop 为被审计 DSH checkout 的构建产物 `packages/core/agent-loop/lib/index.js`（sha256 `a9142d46163d961ed5774ad544cb997da2197fefca5684ec820060dd50c1c935`，`dshHead=a66e470204…`，记入 ledger） |
| fork | 真实生产原语 `ctx.sessions.fork(source, SessionSeq(boundary), childSessionId)`（`SessionStore.fork`，DSH API catalog 中公开记载） |
| Stable Task State | 真实 `TaskStateBasicService`（`src/task-state-basic.ts`，仅 `ctx.plugin`）：调度、单飞 wave、filter、batch fold、prompt frame、候选校验、authority put、audit 行、committed pointer、lifecycle fence |
| 注入文本 | 真实 consumer `dsh-context-enhancement/task-state-prompt`（`{{task_state_snapshot}}`，maxBytes 8000）+ 真实 `ctx.systemPrompt.assemble()`，并真实跑了一次 `agent.followup` 产生的模型请求 |
| 持久域 | 真实 `Storage` + `StorageJson` + `StorageDomain`（`context_enhancement_task_state`），根目录 = 本目录 `tmp-storage/` |

**fake（唯一模型）**

- 脚本化 `LlmAdapter` 注册在部署 route `deepseek-official` / `deepseek-v4-flash` 上。task-state 辅助请求返回固定结构候选 JSON（facts/continuation 带 `E09-CALL-n-THROUGH-SEQ-m` 标记，便于证明每次提交折到哪个事件），agent 请求返回一段文本、**不含 tool call**（一步结束一轮）。
- adapter **刻意不产出 `usage`**，故没有任何 provider token / 计费数字进入本实验。

**安全**：不使用真实 `$HOME/.dsh`、不读写任何现有会话、不占用 8080、不启动 Web、不启动第二个进程（7 个 "process" 是同一 vitest 进程内**顺序**挂载/销毁的 Cordis Context，任一时刻只有一个存活）。

## 4. 阶段步骤（协议要求的三段 + 两条 resume 记录行）

| 阶段 | 进程 | 做什么 | 关键观测 |
|---|---|---|---|
| A | P1 | `ctx.sessions.create(e09-parent)`，追加一个完整 turn + 一个 **filter 不可投影**的插件来源 `user/message` 表面节点 | stable **revision 1 / cursor 5**；hidden 节点 `projection=null` 且不出现在 facts 中 |
| B | P2 | 用 resume 习语重开**同一** SessionId（不追加任何事件） | 同一 lifecycle 的 stable 被恢复（rev 1 / cursor 5，digest 一致）；**0 次模型调用**；`createdAt` 未变 |
| B2 | P5 | 用真实 `ctx.agents.resume` 重开同一 Session 并跑**一次真实 step** | 真实模型请求中出现 `revision 1, source event 5` 的注入文本（hash 与 renderer 一致）；assembly 层同 revision/cursor |
| C | P6 | 用习语重开父 Session，追加第二个完整 turn 封住前缀，然后 **fork** | 父 rev **2 / cursor 28**；fork 边界 28 ⇒ `inheritedEventCount=29`；child fork 后 **无 stable**；child 追加自己的 turn 后提交 **自己的 revision 1 / cursor 33**，父 stable 完全不变 |
| D | P7 | 同时 resume 父与 fork child | child 恢复 rev 1 / cursor 33；`firstLiveSeq=34 ≠ inheritedEventCount=29`（logLength 35） |
| E | 全部关闭后 | 从磁盘读回真实域文档 | 两条 Session 记录、4 条 audit 行；child 首轮 folded 窗口 = 继承前缀 eligible 事件 + 自己事件 |

## 5. 契约依据（判定所对照的固定文本）

- `理想化落地方案.md:538-543`（§5.5 Fork/Resume）：
  - **Resume**：相同 SessionId 和 lifecycle identity 时继续 stable；identity 不匹配视为新生命周期，不覆盖旧记录。
  - **Fork**：默认创建独立 stable，**cursor 起点为子 own events 边界**；父 stable 可作为带来源标记的 bootstrap 输入，但不是子 stable 的已提交版本。
  - 子第一批更新必须读取继承前缀和 own events，**形成自己的 revision 1**。
  - **不以 `firstLiveSeq` 判断继承边界，使用 `inheritedEventCount`/`ownEvents()`**。
- `理想化落地方案.md:233-243`（§3.13）：Fork 时明确选择——默认基于子 Session 的事件重建，**不直接共享父 stable**；可用父 stable 作为一次性 bootstrap 候选，但必须标记 `inherited` 并在子第一批成功后替换。
- `理想化落地方案.md:214-218`（§3.11）：record key 至少 `sessionId + lifecycleIdentity(createdAt,cwd,isSeeded,inheritedEventCount)`。
- 静态审计对照：`审计资料/22` A3（identity 缺 `isSeeded`/`inheritedEventCount`）、`审计资料/23` D10 与 X2、`审计资料/10:140-142`。

**判定规则（运行前固定，写在 spec 头部）**

```text
reproduced      = 真实路径产出了错误的 identity / cursor / stable 交叉引用：
                  R1 resume 未恢复同 lifecycle stable（丢失/重置/绑定到别的 lifecycle）
                  R2 child 把父 committed stable 当作自己的 committed stable（同 revision/cursor，无重建）
                  R3 一个 Session 的 stable/cursor/audit 行被另一 Session 读或写
                  R4 继承边界（cursor 或首批窗口）由 firstLiveSeq 而非 inheritedEventCount/ownEvents 算出
not-reproduced  = R1–R4 全为假
inconclusive    = fixture/runner/介质无法产出证据（挂载失败、resume/fork 被拒、超时、runner 报错）
design-confirmed= 仅有静态设计证据
```

## 6. 观测账本（关键数值，两次运行逐项一致）

```text
session ids          parent=e09-parent  child=e09-parent-fork-child
lifecycle identity   parent {createdAt=1789224154464, cwd=<tmp-sessions>, isSeeded=false, inheritedEventCount=0}
                     child  {createdAt=1789224154582, cwd=<tmp-sessions>, isSeeded=true,  inheritedEventCount=29, parentSession=e09-parent}
provider fence       (createdAt, cwd) —— 不含 isSeeded/inheritedEventCount（审计资料 22 A3 的静态结论落入本次实测）

A: stable rev1 / cursor 5   hidden 插件来源节点 projection=null，不在 facts
B: 恢复 stable rev1 / cursor 5 / digest 一致；模型调用 0
   firstLiveSeq=6, inheritedEventCount=0, logLength=7（end-seed 标记在 firstLiveSeq 定格后被追加）
B2: 真实请求 snapshot 文本 = "…(revision 1, source event 5, digest …)"；assembly 层同值
C: 父 rev2 / cursor 28
   fork(boundary=28) → child: inheritedEventCount=29, firstLiveSeq=29, ownEvents=[29]
   fork 后 childStable = undefined（未共享父 stable）；父 stable 仍 rev2/cursor28
   child 追加自己的 turn（30..33）后：rev1 / cursor 33（距继承切口 +4），父 stable 未变
D: child resume → stable rev1 / cursor 33；firstLiveSeq=34, inheritedEventCount=29, logLength=35
E: 域文档 2 条 Session 记录 + 4 条 audit 行
   child 首轮 includedSeqs = [1,2,3,5,11,13,19,21,24,25,26,28,31,32,33]
     —— 前 12 个全部是继承前缀（<29），后 3 个是自己事件（≥29）
   child 继承前缀内 where seq<29 的 eligible 事件数 = 12；父 rev2 窗口 includedSeqs 与这 12 个完全相同
```

## 7. 判定（not-reproduced）与逐条依据

| 判据 | 结论 | 证据 |
|---|---|---|
| R1 resume 丢失/重置/改绑 stable | **假** | B：rev1/cursor5/digest 与 A 完全一致、`createdAt` 未变、模型调用 0；D：父仍 rev2；三次 resume 无一重置 |
| R2 child 共享父 stable | **假** | fork 后 `getStable(child)=undefined`，域内无 child 记录；child 首批提交**自己的** rev1（digest 与父不同）；child 提交后父 rev2/cursor28 逐字段不变 |
| R3 跨 Session 引用 | **假** | 4 条 audit 行按 lifecycle createdAt 完全分离（父 3 / child 1）；域内两条记录 `createdAt`、`cursor`、`digest` 三者互不相同 |
| R4 用 firstLiveSeq 当继承边界 | **假** | 边界来自真实 fork 的 `inheritedEventCount=29=boundary+1`；ownEvents 从 29 起；首批 cursor 33 > 29；**且插件源码根本不读 `inheritedEventCount`/`firstLiveSeq`/`isSeeded`（`src/` 内 0 命中）**，只按 `seq > committedCursor` 折叠 |

**因此不触发 `reproduced`。**

## 8. 同时记录的两条契约不一致（不是 bug，是缺口）

这两条**不**构成 `reproduced`（没有错误交叉引用、没有数据损坏），但与《理想化落地方案》§5.5 的固定要求不一致，须按"契约不完整"记账：

1. **cursor 起点不是子 own events 边界。** 契约要求 "cursor 起点为子 own events 边界"；实测 child 无记录 ⇒ `committedCursor=-1` ⇒ 首批窗口从 seq 0 起，把**整个继承前缀**重新折叠（12 个继承 eligible 事件全部进入自己的 rev1 窗口，其中包含父已提交 rev2 的全部窗口内容）。对应静态结论 D10「无 inherited 标记、无 own-events 边界，继承前缀语义只能靠 cursor=-1 隐式得到」——本次给出了动态证据（**confirmed-for-default-branch**）。
2. **无一次性父 stable bootstrap 及其 `inherited` 来源标记。** 契约允许"父 stable 作为一次性 bootstrap 候选，但必须标记 inherited 并在子第一批成功后替换"；插件里既没有这条可选路径，也没有标记字段。这条属 `design-confirmed`（静态即可判定，本实验未去构造该分支）。

配套事实（**符合**契约、不算差异）：child 首批确实形成自己的 `revision 1`，并且确实读取了继承前缀 + own events。

## 9. `firstLiveSeq` vs `inheritedEventCount` 的实测关系

| 情形 | `inheritedEventCount` | `firstLiveSeq` | logLength | 说明 |
|---|---|---|---|---|
| 新建未播种父 Session（A） | 0 | 0 | 6 | 无 seed，二者都为 0（此时**不可区分**） |
| resume 后的未播种父 Session（B） | 0 | 6 | 7 | `firstLiveSeq` = 本生命周期构造 seed 长度（=存储日志长度）；标记事件在它定格之后追加，故 logLength 大 1 |
| fork 当刻的 child | 29 | 29 | 30 | child 日志恰为 seed（前缀 + 一个 end-seed），二者**按构造必然相等**——fork 当刻无法区分 |
| resume 后的 fork child（D） | 29 | 34 | 35 | 二者**明确分离**：`firstLiveSeq` 跟到本生命周期 seed 末端，durable 继承切口仍为 29；`isOwnSeq(0..28)` 全为 false |

结论：**没有任何代码把 `firstLiveSeq` 当作继承边界使用**（`src/` 零命中），因此不存在"误用 `firstLiveSeq` 代替 `inheritedEventCount`"；反过来说，插件也**没有**使用 durable 的 `inheritedEventCount`——它隐式地把整段日志都当作自己的输入，这就是第 8 节第 1 条。

## 10. 复现过程记录（透明性）

spec 迭代期间被真实 API 拒绝过两次，均属 fixture 缺陷而非产品缺陷，最终版本已修正：

1. **`cannot prepare session "e09-parent" while it is live`** —— 同一 Cordis Context 内先用 resume 习语把 Session 变为 live，再调 `ctx.agents.resume` 会被生产显式拒绝。修正：把"习语 resume"与"agent 路径 resume"拆到**不同 Context**（P2/P6 vs P5）。这是生产的正确防护，已作为 limitation 记录。
2. **`seed user/message at index 11 lacks an identified message`** —— fixture 构造的插件来源 `user/message` 事件缺少 message `id`，`Session` 的 seed/replay 校验器会拒绝 fork 该前缀。修正：给该节点补 `id`（真实 DSH runtime-context 节点同样带 id）。这证明 fixture 当时**确实**在做真实 fork 校验，也说明为什么不能靠伪造前缀绕过。
3. 早期版本还有两处 fixture 断言把 seq 写死（3/7/9），已被实测值纠正为**从记录值推导**（例如 cursor 与继承切口的距离由 `childOwnTurnEnd - inheritedCount` 推出）。

保留的 `vitest-output-run1.txt` / `vitest-output-run2.txt` **都是最终 spec 的通过输出**；上面 5 次迭代的失败输出未保留，其原始错误信息已逐条记录在本节。

## 11. fake 限制与未覆盖

- 唯一模型是脚本化 adapter，**没有真实摘要语义**、没有 `usage`、没有 provider token；候选 JSON 是 fixture 文本。
- 部署 route 下注册的是 fake adapter，不是真实 provider。
- AgentLoop 以原生 `import()` 读入被审计 checkout 的 `lib/index.js`（sha256 见 ledger）；若该 sha256 与审计基线不符，step/surface 层证据不成立。
- `minEvents=1`（生产允许的最小值）：部署值 20 下单个完整 turn 只有 3 个可投影 eligible 事件，永远不能提交，且 E07 已证明 resume 不开 startup 波，故用 1 把"resume 丢 stable"和"未达阈值"分开。阈值不参与任何 fork/resume identity 判定。
- fork 走 **Session 级**原语 `ctx.sessions.fork`，**未**走 Web/CLI 的 `ctx.agents.create({seed, inheritedEventCount, meta})` 包装（该包装内部同样落到 `sessions.create` + prepare/enter/announce）。包装层差异未覆盖。
- 7 个"process"是同进程内顺序挂载的 Context，不是 7 个操作系统进程；本实验不覆盖跨进程/多实例。
- **未覆盖**：① 同 id、同 `createdAt/cwd`、但 `isSeeded`/`inheritedEventCount` 不同的**碰撞 lifecycle**（只能靠手工伪造 header 触发，按纪律不伪造身份字段，故 A3 的碰撞分支记 **未测**）；② fork 子折叠"被 replacement 遮蔽的原始事件"（不挂压缩插件，无 replacement），X2 只得半边；③ resume 后 fork 前缀被重新播种的差异；④ 真实 prompt 的可见节点数与 token 归因。
- 本实验"通过"只表示 fixture 与结构断言通过，verdict 只回答第 1 节那一个问题。

## 12. sourceDrift

- 342 个核心文件 SHA-256 前后核对：`match=342 / mismatch=0 / missing=0`（`hash-check-before.json` / `hash-check-after.json`）。
- `git status --porcelain` 行数前后一致（`134`），`git HEAD` 前后一致（`cf034b4bce6141bb95b590f5ed7fa66f8727daa2`），见 `git-head-*.txt` / `git-status-*.txt` / `drift-check-after.json`。
- 唯一写入 = 本目录（`审计资料/实验结果/E09-ForkResume/`）；`审计资料/` 整体为未跟踪目录，新增文件不改变 git status 行数，属审计产物增长。
- 未修改：生产源码、现有 tests、harness（`vitest.experiment.config.ts`、`surface-harness.ts`、`task-state-harness.ts`、`compaction-harness.ts`）、`package.json`、`vitest.config.ts`、`lib`、tgz、E01–E08/E10 任何文件。
- DSH checkout 只读访问（HEAD a66e4702，工作区 dirty 0）；未触碰真实 `$HOME/.dsh`、现有会话、8080、Web。

## 13. 产物清单

| 文件 | 内容 |
|---|---|
| `e09-fork-resume.spec.ts` | 唯一 spec（判定规则写在其头部，运行前固定） |
| `e09-ledger.json` | 完整观测账本：7 个 process 的阶段记录、identity/firstLiveSeq/inheritedEventCount、stable 视图与注入文本 hash、audit 行、判定判据、limitations、sideObservations |
| `vitest-output-run1.txt` / `vitest-output-run2.txt` | 原始 Vitest verbose 输出（两次通过） |
| `tmp-storage/context_enhancement_task_state.json` | 真实持久域文档（2 条 Session 记录 + 4 条 audit 行） |
| `tmp-sessions/…/e09-parent/session.jsonl`、`…/e09-parent-fork-child/session.jsonl` | 真实 JSONL 会话日志（父 6 586 B、child 7 501 B） |
| `hash-check-before.json` / `hash-check-after.json` | 342 文件 SHA-256 核对 |
| `git-head-*.txt` / `git-status-*.txt` / `drift-check-after.json` | git 基线前后核对 |
| `artifact-hashes.json` | 本目录产物自身 hash |
