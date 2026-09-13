# 21 · DSH/Cordis 后台任务、取消、超时与 Session/Agent 生命周期事实

> 状态：只读源码核验，未修改 DSH，未启动进程，未派生子代理。
> DSH 源码：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 范围：`vendor/cordis/**` 生命周期内核、`vendor/{timer,hmr}`、`packages/util/timeout`、`packages/jobs/**`、`packages/core/{agent,agent-loop,session,scope,tools}`、`packages/schedule/schedule`、`packages/llm/llm-retry`、`packages/llm/llm/src/retry-policy.ts`、`packages/guard/timeout-policy`、`packages/session/session-checkpoint-policy`、`apps/cli/src/{process-shutdown,profile-boot}.ts`、`packages/bundle/base/cordis.patch.yml`。
> 约束：直接调用最多两层。排除 compaction 算法、存储实现、goal/todo 业务、当前插件。不重复事实库 00/03/06/07。
> 证据标记：【已证实】=读源码含行号；【已证实·推导】=由已证实路径组合推出；【待深挖】=有线索未闭环；【未找到】=范围内不存在。行号省略 `packages/` 前缀。

---

## 1. ctx.effect / ctx.on / service × fiber activate / deactivate / dispose

- 【已证实】**Fiber 状态机**：`FiberState = PENDING | LOADING | ACTIVE | FAILED | DISPOSED | UNLOADING`（`vendor/cordis/src/fiber.ts:147-154`）。epoch 是"注入服务集合的指纹"，epoch 变化即驱动 load/unload（`fiber.ts:611-639`）。
- 【已证实】**ctx.effect(execute, label)**（`fiber.ts:415-561`）：
  - `assertActive()`，且 state 为 `UNLOADING` 时抛 `CordisError('INACTIVE_EFFECT')`（`:419-422`；错误码定义 `:171-174`，`assertActive` 实现 `:351-354`）。
  - `execute` **立即同步执行**（`:522`）；它返回的 disposer 立即登记（`:520`）。disposer 为 `Promise<void>` 且 wrapper 本身可 await（`:555-559`）→ **await `ctx.effect` 返回的 disposer 会等到该 effect 自己的清理完成**。
  - 一个 effect 的多个 disposer 按**注册逆序串行**执行（`:431-441`，`task = task.then(...)` 链）。
  - **异步 effect body 的 rejection 被吞掉并转 `log.error`**（`:545-548`），抛出 `execute` 时同步抛（`:523-537`）。→ 后台任务若用 `ctx.effect(async () => {...})` 启动，其失败**不会**回归调用方。
  - 已注销后再调用 disposer 是 no-op（`:428`），`effectInertia` 让外层 owner 能 join 别人已启动的清理（`:112-117, 515`）。
- 【已证实】**ctx.on(name, listener)**（`vendor/cordis/src/events.ts:288-302`）内部就是 `ctx.fiber.effect(...)`（`:254-260`）：先 `assertActive()`，返回的 disposer 就是 effect disposer → **fiber 卸载即自动注销监听**，无需手工管理。
- 【已证实】**service**：`Service` 构造函数 `super(ctx, name)` → `ctx.reflect.provide(name, self, check)`（`vendor/cordis/src/service.ts:42-59`）；类插件构造后还会调用 `instance?.[symbols.init]?.()`（`fiber.ts:250-261`）。服务随 owner fiber 卸载自动注销；同名再注册抛错。
- 【已证实】**fiber 卸载顺序**（`_unload`，`fiber.ts:675-696`）：`this._disposables.clear()` 返回**逆序**数组（`vendor/cordis/src/utils.ts:27-31`），但用 `Promise.all(...)` 并发执行 → **逆序发起、并发 await**；每个 disposer 的异常被单独捕获并 `log.error`（`:683-685`，不聚合、不外抛）。`_unload` 结束后清 `inertia`（`:687-695`）。
- 【已证实】**fiber.dispose() 会等待**：dispose 路径先 `emitPluginDisposed`（`:119-137`，`internal/plugin` 观察者被包含），必要时 `registry.delete`，再 `_setEpoch(INACTIVE)`，最后 `while (this.inertia) await this.inertia`（`:265-297`）→ **返回的 Promise 在该 fiber 全部异步 disposer 结束后才 resolve**。
- 【已证实】**reload/重启**：`restart()` = `_setEpoch(INACTIVE)` + `_refresh()` + `await this.await()`（`:718-723`）；`update(config)` 走 `internal/update` waterfall 后 restart（`:736-753`）；`_reload()` 重跑插件回调，失败则 `log.error` + `_error` + 回 INACTIVE（`:646-673`）。`Fiber.await()` 等待 inertia 并重抛启动错误（`:704-710`）。**根 fiber 的 dispose 就是 restart**（`:331`）。
- 【已证实·推导】**activate 可失败但不阻断已注册 effect**：处于 PENDING 时注册的 effect 会在卸载时显式 drain（`:277-286`）。
- Scope 层：`createScope(ctx, key)` 通过 `ctx.plugin(noop)` 起一个子 fiber，`dispose()` 用 `quiesceFiber` = `await fiber.dispose()` + 等 `inertia`（`core/scope/src/index.ts:104-147`）→ agent 级作用域的所有注册项（服务、监听、effect）随 scope 卸载统一回收。

---

## 2. 受监管异步任务的启动、错误观察、dispose 是否等待

| 原语 | 位置 | 启动 | 错误观察 | dispose 是否等待 |
|---|---|---|---|---|
| `ctx.jobs`（Service） | `jobs/jobs/src/index.ts:62-177`，实现 `jobs/jobs-local/src/index.ts` | `ctx.jobs.start({kind,label,owner?,run})` 同步返回 `JobId`，`run()` 同步返回 `{cancel, done, readOutput?}`（`jobs/src/types.ts:46-91`） | `done: Promise<JobOutcome>`（producer 自报 `completed/killed/failed` + `detail`）；`ctx.jobs.wait(id, timeoutMs, agent, signal)`；`onJobDone`/`onJobsChanged` 监听（`jobs-local:250` 用 `deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)`） | **是**。owner 侧 `owner.ctx.effect(() => async () => { await this.disposeOwned(owner) }, 'jobs.ownerCleanup()')`（`jobs-local:459-463`）；服务侧 `ctx.effect(() => () => this.disposeAll(), 'jobs teardown')`（`jobs-local:128`）。teardown cancel 抛错则只把记录强制 `failed` 并 warn "work may be orphaned"（`jobs-local:516-530`） |
| `Agent.runMaintenance(job)` | `core/agent-loop/src/agent.ts:151-171` | 仅当 `phase.kind === 'idle'`，否则**同步抛** `agent "<id>" already has active work`（`:152`）；给 job 一个专属 `AbortSignal`（`:156,164`） | job 的 rejection 原样返回调用方；`finally` 恢复 idle 并 `done.resolve()`（`:165-169`）→ **不进 agent error 状态、不发 `agent/error`、不影响主 turn** | 调用方 await 返回的 promise；`activityDone` 由 `finally` 收敛，`whenIdle()` 据此（`:204-209`） |
| `ctx.timer`（cordis-plugin-timer） | `vendor/timer/src/index.ts:12-145` | `ctx.timeout(cb,ms)`、`ctx.interval(cb,ms)`（异步迭代器形态 `:56-104`）、`ctx.throttle`、`ctx.debounce` | 无（回调异常成为未捕获异常） | 所有定时器都是注册 fiber 的 effect（`:35-41,63-66,108-111`）→ fiber 卸载即清；`interval` 迭代器在上下文销毁时 reject `Context has been disposed`（`:77-79`） |
| 自持 runtime（DSH 范式） | `schedule/schedule/src/runtime.ts:77-321` | 由 `ctx.on('agent/created')` 建实例，包在 `agent.ctx.effect(..., 'schedule.runtime()')` 里（`schedule/src/index.ts:51-83`） | 全部转 `ctx.logger.warn`，并置 `faulted` 停摆（`runtime.ts:118-127,205-215`） | `dispose()` = 置 stopping、清 timer、resolve stop、`Promise.allSettled([run, idleWait])`（`:131-140`），幂等缓存（`:132`） |

- 【已证实】**JobRegistry 的硬约束**（`jobs/jobs/src/index.ts:35-61` 契约 + `jobs-local`）：`start` 在"该 owner 没有任何已 attach 的 controller"时拒绝（需 `attachController`，`tool-jobs` 加载时 attach）；每 owner 并发上限 `maxConcurrentJobsPerOwner` 默认 **10**（`jobs-local:27-37`）；**超限是抛错，不是排队**；owner 身份按 session id 校验，owner 必须仍是注册中的那个 Agent 实例；settlement **first-wins**，completion listener 被包含且**不 await**（`jobs-local` settle 段）；"注册的生命周期长于 producer/controller fiber"。
- 【已证实·推导】**job 不继承 turn 的 signal**：producer 典型实现 `shell/tool-bash/src/index.ts:364-377` 只从 `exec.agent` 取 owner，`run()` 里不接 `exec.signal` → 后台任务与发起它的 tool call / turn 的取消**解耦**，取消只能走 `job_kill` / owner 销毁。
- 【未找到】Cordis 与 DSH 核心中**没有**通用后台任务/线程池服务（除 `ctx.jobs` 这一 job 语义服务）；`packages/workflow/workflow-worker-thread` 属于 workflow 业务，未进本轮范围。

---

## 3. AbortSignal 传播链（进程 → agent → turn/step → tool → LLM）

- 【已证实】**进程级没有对外暴露的 signal**：`apps/cli/src/profile-boot.ts:213-225` 注册 SIGTERM(→exit 0)/SIGINT(→exit 130) 并调用 `shutdown.interrupt`，`createProcessShutdown` 的 `dispose` 就是 `app.current?.fiber.dispose()`（`:213`）；`signalShutdown` 这个 AbortController **仅在启动窗口内部使用**（`:270-273,301-303`），未 provide 给插件。插件可用的关闭钩子只有 **fiber disposer**。
- 【已证实】**agent 创建期 signal**：`AgentLoop` 用 per-owner `AbortController`（`core/agent-loop/src/index.ts`，`preparation` 与 `raceAbortCall(...)`）；创建被放弃/owner 卸载时 `abort.abort(new Error('agent "<id>" lifecycle disposed'))`。
- 【已证实】**turn/step 级 signal 是唯一的活动取消源**：Phase 为 `{kind:'running', abort: AbortController}` / `{kind:'maintenance', abort}`（`core/agent-loop/src/agent.ts:39-47`）；每个 running phase 新建 controller（`:194-200`），`preStep` 取 `this.phase.abort.signal`（`:237-240`）并把同一个 signal 传进 `system-prompt/assemble`、`agent/pre-step`、后续 step；`cancel(cause, {keepInbox})` = 清 inbox + `phase.abort.abort(cause)`（`:143-149`）。`cause ∈ {user,parent,hook,disposed}`（`core/session/src/types.ts:181-188`）。
- 【已证实】**到 LLM**：request 对象里带 `signal`（`agent.ts:535-543`，request 被 `deepFreeze` + `markAgentLoopRequest`），adapter 侧再用 `idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')` 叠加空闲超时（`llm/llm-deepseek/src/adapter.ts:477`、`llm/llm-pi-ai/src/adapter.ts:350`）。
- 【已证实】**到 tool**：`executeToolCalls(..., signal)` → `runGroup(..., signal)`（`core/agent-loop/src/tool-calls.ts:122-231`）；`exec.signal` 即调用方 signal；`tools/execute` wrapper 可替换 `exec.signal`，但注册表用 `fuseToolSignals(caller, wrapper)` 把调用方 signal 融合回去，**wrapper 无法脱离调用方取消**（`core/tools/src/index.ts:1876-1907`，用法 `:1519-1549`）；取消后未派发的调用补写有序合成结果（`tool-calls.ts:238-259`）。
- 【已证实·推导】**没有 session 级 signal**：取消粒度是"agent 的一个活动（turn 或 maintenance）"，与 session 的 open/close 无关。
- 【已证实】**可取消等待的范式**：`cancellableDelay(delayMs, signal)` 用 `setTimeout` + `signal.addEventListener('abort', ..., {once:true})` 返回 boolean（`llm/llm-retry/src/index.ts:83-96`）；融合上游与自有 lifetime 用 `AbortSignal.any` 类逻辑，`@deepseek-ai/dsh-timeout` 的 `deadline(upstream, timeoutMs, code)` 把"上游取消"与"自身超时"融成一个可 `using` 的信号（`util/timeout/src/index.ts:81-125,175-190`）。

---

## 4. 关闭/取消顺序：进程、Agent、Session

**进程关机**【已证实】
`SIGTERM/SIGINT` → `ProcessShutdown.interrupt(code)` → `dispose()`（root fiber dispose）→ 5s `PROCESS_SHUTDOWN_TIMEOUT_MS` 到期 `forceExit`（`apps/cli/src/process-shutdown.ts:4,52-63`）；关机已在进行时再收到信号**立即强杀**（`:69-75`）；正常完成走 `complete(code)` 记 `process.exitCode`。root fiber dispose 会等待全部 disposer（含 `AgentLoop` 的 ownership 收尾），故 5s 是唯一的硬上限。

**Agent 生命周期**【已证实】`core/agent-loop/src/index.ts` 的 `FactoryOwnership`：`dispose()` = `accepting=false` → `teardown.abort(...)` → `inactive.resolve()` → `await Promise.all([...liveAgents.map(d=>d()), ...startupTasks])`；插件侧由 `ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')` 拥有。

**单个 Agent 卸载顺序**（同上文件，publish 的 composite teardown）：① `abort.abort('agent "<id>" lifecycle disposed')`（放弃创建期等待）→ ② 移除 owner 监听 → ③ `machine.cancel({kind:'disposed'})`（清 inbox + abort 活动）→ ④ `await machine.whenIdle()`（等 driver/maintenance 完全收敛，**跨链式活动**：`while (activity !== this.activityDone)`，`agent.ts:204-209`）→ ⑤ `await machine.scope.dispose()`（agent scope fiber 卸载：工具、监听、`ctx.jobs` owner cleanup 等）→ ⑥ `finally`：`detachAgent()` **然后** `detachSession()`。

**Session 侧**【已证实】`SessionStore.enter(session)` 返回幂等 detach 能力；`detachEntered` 先 `store.delete` + 删 attachment，再在"已 announce"时 `emitDisposed` → `session/disposed`（`core/session/src/index.ts:977-1023`）；观察者被逐个包含，抛错/拒绝只 `log.warn`（`:381-399`）。`announce()` 发 `session/created`，同步抛错会回滚发布（`:1032-1040`）。`flush()` 走 store 拥有的 carrier 派发 `session/flush`，`Promise.allSettled` 等**全部** listener 落定后抛**第一个**失败（`:1086-1103`）→ 这是"fail-closed 检查点"的机制基础（`session/session-checkpoint-policy/src/index.ts:64-82`，挂在 `llm/stream` 首个 chunk 前、top-level `tools/execute` body 前、`agent/pre-step`）。
- 【已证实】`agent/disposed` 在 registry 摘除时**同步** emit，listener 被包含（`core/agent/src/index.ts:505-534`）；`agent/created` 同步抛错会否决发布，异步拒绝只 `log.warn`（`:543-569`）。
- 【已证实】**顺序要点**：`agent/disposed` → 之后才 `session/disposed`（detachAgent 先于 detachSession）；两者都在 agent driver 静默**之后**。

### 生命周期时序（单 Session，正常路径）

```
SIGTERM/SIGINT ─► shutdown.dispose() ─► root ctx.fiber.dispose()
   └─(逆序发起/并发 await 全部 effect disposer, 5s 上限)
        └─ AgentLoop.ownership.dispose(): abort 创建 + 等 liveAgents/startupTasks
             └─ per-agent teardown: abort创建 → machine.cancel(disposed) → await whenIdle()
                  → await scope.dispose()  [工具/监听/ctx.jobs owner cleanup 等 job settle]
                  → detachAgent() (agent/disposed) → detachSession() (session/disposed)
session/event (同步, 已提交后) ─► 观察者被包含, 不可重入 append
job settle → 提交记录 → onJobDone 监听(包含, 不 await) → 最后一个才 announce completion(可同步开新 turn)
```

---

## 5. per-session 单飞 / 队列 / coalescing / scheduler 原语盘点

| 能力 | 现状 | 证据 |
|---|---|---|
| per-session 串行化 | **有**：`PersistenceCoordinator` 为每个 SessionId 维护 Promise 链，写操作严格排队（事实库 03 已落库） | `session/session-persistence/src/coordinator.ts:651,1197-1207` |
| per-agent 队列 | **有**：`Inbox` 两个 durable 列表 `next-turn`/`next-step`，`claim(target, turn)` 批量取用（next-step 全取 + next-turn 取 1），`append/prepend/splice/clear` 都写 durable `agent/inbox/spliced` | `core/agent/src/inbox.ts:25-101` |
| per-agent 单飞 + coalescing | **有范式、无通用服务**：`ScheduleRuntime` 用 `requested: boolean` 合并触发 + `run` 单飞 + `while (this.requested) { this.requested=false; await driveOnce() }` 串行 drain + `retire()` 处理"结算微任务窗口内到达的触发" | `schedule/schedule/src/runtime.ts:103-128,142-157` |
| per-agent 并发上限 | `ctx.jobs` 的 `maxConcurrentJobsPerOwner`（默认 10），超限抛错 | `jobs/jobs-local/src/index.ts:27-37` |
| in-step 调度器 | **有**：工具调用池 `maxParallelToolCalls`，按模型序连续 commit，取消后补合成结果；`schedulerFailure` 先停新派发再等已在飞 | `core/agent-loop/src/tool-calls.ts:199-247`；`core/agent-loop/src/constants.ts` |
| 通用 mutex/queue/单飞工具类 | **未找到**：`packages/util/**` 无 mutex/semaphore/serial-queue 类 | —— |
| 定时/背压 | `ctx.timer` 的 `throttle`/`debounce`（fiber 绑定的定时器） | `vendor/timer/src/index.ts:120-144` |

【已证实】**维护任务不能被排队**：`runMaintenance` 在非 idle 时同步抛错（`agent.ts:152`），DSH 的既有解法是"抛错后转去 `await agent.whenIdle()` 再重试"（`schedule/runtime.ts:186-203,304-308`）。【已证实·推导】该 `idleWait` 只保留**一个**等待者（`:188`），因此天然合并。

---

## 6. timeout / retry / backoff 的正式工具

- 【已证实】**超时**：`packages/util/timeout/src/index.ts` 是唯一正式超时库：`TimeoutReason`（带 capability 自有 code，`:12-22`）、`MAX_TIMER_DELAY_MS`（`:25`）、`clampTimeout(requested, def, max, name)`（`:45-55`，0/负数不是"禁用"哨兵）、`deadline(upstream, timeoutMs, code)`（`:81-125`，`timeoutMs <= 0` 为内部无定时器哨兵，`using` 可释放）、`idleWatchdog(upstream, timeoutMs, code)` 带 `next()/pulse()`（`:126-174`）、`timeoutOf(x, code)` 按 code 区分本层与嵌套超时（`:184-190`）。它**只通过 abort 通知**，停止工作由各能力自己实现。
- 【已证实】**tool 超时**：`ToolDefinition.timeoutMs` 是"声明 + 协作式兑现 `exec.signal`"的断言；`guard/timeout-policy` 在 `tools/execute` 里 `using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)`、临时替换 `exec.signal`、只在**自己**的定时器触发时把结果换成结构化 `TOOL_TIMEOUT`（`guard/timeout-policy/src/index.ts:25-80`）；已存在于 base bundle（`bundle/base/cordis.patch.yml:383-384`）。
- 【已证实】**重试/退避**：只有 LLM 请求级。策略由 provider 拥有（`llm/llm/src/retry-policy.ts:14-24` 默认 `maxRetries=5, initialDelayMs=500, maxDelayMs=10000, jitterRatio=0.1`，可重试码 `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`），执行器 `packages/llm/llm-retry` 挂在 `agent/request-error`；退避公式 `localDelay`：`min(initialDelayMs * 2**(retry-1) * jitter, maxDelayMs)`（`llm/llm-retry/src/index.ts:59-64`），等待用可取消定时器（`:83-96`），每次重试**先落 durable 事件再等待**，计数器存 session projection。
- 【未找到】**没有**通用 retry/backoff 工具（无 `retry(fn, policy)` 之类）；非 LLM 的后台重试必须自写，或复用 `deadline` + 自持 loop。

---

## 7. reload / 重启后，旧异步回调提交的防护

- 【已证实】**HMR 的 reload 不等待旧 fiber 卸载**：`vendor/hmr/src/index.ts:511-531` 先 `ctx.registry.delete(plugin)`，而 `RegistryService.delete` 对 `runtime.fibers` 逐个 `fiber.dispose()` **不 await**（`vendor/cordis/src/registry.ts:258-267`），随后立刻注册新导入的插件回调（`hmr/index.ts:502-509`）。→ 旧实例的异步 disposer 与在飞任务可能与新实例并存。
- 【已证实】**框架侧防线**：① `ctx.effect`/`ctx.on` 在卸载后抛 `INACTIVE_EFFECT`（`fiber.ts:419-422`；`events.ts:294`），旧回调无法再注册新 effect；② fiber dispose 会等待自身 disposer，但**不保证**与 HMR 新实例的相对顺序；③ 事件 waterfall 会**快照** listener 列表（`events.ts:254-259` 注册为 effect；派发时取快照），已捕获的旧回调仍可能被调用。
- 【已证实】**DSH 业务侧的三种既有防护**：
  1. **lifetime AbortController + 排空集合**：`llm-retry` 在 effect disposer 里 `disposeListener(); lifetime.abort(new Error('llm-retry plugin disposed')); await Promise.allSettled([...active])`，并在回调入口 `if (lifetime.signal.aborted) return undefined` 拒绝陈旧回调继续下游（`llm/llm-retry/src/index.ts:243-258`）。
  2. **身份重校验（liveness fence）**：`ScheduleRuntime.isLive()` = `ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)`，所有异步续作前重查（`schedule/schedule/src/runtime.ts:159-168`）；Session/Agent 的 detach 闭包用捕获的 entry 身份校验 `store.get(id) !== entry` 即放弃（`core/session/src/index.ts:1019`；`core/agent/src/index.ts:511`）。
  3. **owner fiber 断言**：`ownerCtx.fiber.assertActive()`、`ownership.isActive()`、`this.ctx.agents.requireInitiator()` 在跨越 await 后重查（`core/agent-loop/src/index.ts` resume 路径）。
- 【待深挖】`session-projection-cache`、`settings-file` 等长时间后台/缓存消费者是否也实现了同等 liveness fence，本轮未逐一核验。

---

## 8. 同步 session / event 回调能否安全触发后台工作

- 【已证实】**观察者是在事件已提交后同步调用的**：`Session.append` 先 `log.push`（`core/session/src/index.ts:707`）再 `invokeContainedSessionObservers`（`:709-711`），全程 `entry.appending = true`（`:700`），`finally` 复位并处理挂起的 detach（`:713-717`）。
- 【已证实】**因此监听器内不能同步 append**：append 入口 `if (entry?.appending) throw new Error('session append cannot reenter while another append is being published')`（`:687-690`）→ **`session/event` 回调里直接 `session.append(...)` 会抛错**，必须延后到微任务/下一 tick。
- 【已证实】**监听器失败不影响 append**：逐个 try/catch，只 `log.warn`，返回的 Promise 只被 observe（`:381-399`）→ 一个 listener 阻塞不了其他 listener，也改不了 `append` 的返回值。
- 【已证实】**append 是热路径**：文档明确"hot path never blocks on I/O"（`:633-639`）；同步做重 I/O 会直接拖慢 turn。⇒ **安全做法是"同步只做入队/置标志，异步再做重活"**，与 `ScheduleRuntime.requestDrive()`（同步置 `requested` + 若无在飞则起 promise，`runtime.ts:103-128`）和 `ctx.jobs` settlement（先提交记录 → 通知观察者 → **最后** announce completion，"because a reporter may open a model turn synchronously"，`jobs/jobs/src/index.ts:49-53`）同构。
- 【已证实】**从后台回调"唤醒主 Agent"的正式通道**：idle owner 用 `agent.followup(msg)`（开新 turn，但有 `maxConsecutiveWakes` 默认 3 的自激励上限，被用户输入重置），busy owner 用 `agent.inject(msg)`（进 next-step，turn 收不了口，多走一步）；`quiet` 模式则只挂起（`jobs/tool-jobs/src/index.ts:23-52` 及 onJobDone 段）。
- 【已证实】**在 maintenance 期间到达的唤醒会被 latch**：`wakeDriver` 在非 idle 阶段只置 `phase.wakeRequested`（`disposed` 除外），maintenance 收敛时若有 pending 则重放（`agent.ts:181-190,165-169`）→ 这既是"更新期间合并后续需求"的现成机制，也意味着**长 maintenance 会把用户 turn 推迟到它结束**（不丢、但延迟）。

---

## 9. 目标能力的可用原语与缺失能力清单

目标：**每 Session 单 worker + 更新期间合并后续需求 + 失败不阻塞主 Agent**（不设计具体插件）。

**可用原语（均已证实）**
1. 生命周期绑定：`ctx.on('agent/created' | 'agent/disposed')` + `agent.ctx.effect(...)`；插件级 `ctx.effect(() => { const off = ctx.on(...); return async () => { off(); await Promise.allSettled(cleanups) } }, ...)` —— 直接照 `schedule/schedule/src/index.ts:43-84` 的形态。
2. 单 worker + 单飞：自持 `run?: Promise<void>` + `requested: boolean`；`requestDrive()` 同步合并触发；`retire(run)` 处理结算窗口（`schedule/runtime.ts:103-157`）。
3. 合并/背压：`requested` 布尔合并 + `idleWait` 单例等待（`runtime.ts:186-203`）；若要"更新期间合并需求"，`agent.inject()`/`followup()` + `Inbox` durable 队列即可（`agent.ts:122-141`；`inbox.ts:71-78`）。
4. 不阻塞主 Agent：① `agent.runMaintenance(job)`（只在真正 idle 时占用 idle 相位，且不把失败升级为 agent 错误，`agent.ts:151-171`)；② `ctx.jobs.start(...)`（owner 销毁时被 cancel 并 await，`jobs-local:459-463`）。
5. 取消：`AbortController` per activity；`deadline()/idleWatchdog()` 提供"上游取消 + 自身超时"融合（`util/timeout/src/index.ts:81-174`）。
6. 陈旧回调防护：lifetime AbortController + `signal.aborted` 入口拒绝 + `ctx.agents.get(id) === agent` 身份重查（`llm-retry:243-258`；`runtime.ts:159-168`）。
7. 清理等待：effect disposer 可 await；`agent.scope.dispose()`、`fiber.dispose()`、`jobs` teardown 均等待（`scope:104-118`；`fiber.ts:265-297`；`jobs-local:459-463`）。
8. 定时：`ctx.timeout/interval/throttle/debounce`（fiber 绑定，自动清理）或自持 `setTimeout` + `MAX_TIMER_DELAY_MS` 分段（`runtime.ts:177-184`）。
9. 失败可见性：`ctx.logger.warn/error`、`agent/error`、`turn/end{kind:'error'}`、`job.done` 的 `failed` + `detail`。

**缺失能力（需自建或需另行确认）**
1. **无通用 per-session 单飞/合并服务**：Cordis 无 mutex/serial-queue，DSH 也无 `ctx.tasks`/`ctx.scheduler` 之类的通用原语；只能自持 `requested`/`run`（照 `ScheduleRuntime` 抄）。
2. **无排队语义**：`ctx.jobs` 超限即抛（默认 10/owner），`runMaintenance` 非 idle 即同步抛 → "合并后续需求"必须自己做 latch + 重试（`whenIdle`）。
3. **无进程关机 signal 给插件**：只有 fiber disposer；5s 后强杀（`process-shutdown.ts:4,52-63`）→ 后台任务必须在 disposer 里尽快收敛，且不能假设有 grace 通知。
4. **HMR reload 不 await 旧 fiber 卸载**（`registry.ts:258-267` + `hmr/index.ts:511-531`）→ 任何跨 await 提交都必须自带 liveness fence，框架不代劳。
5. **无通用 retry/backoff 工具**：退避算法私有在 `llm-retry`；非 LLM 任务需自写。
6. **无 job 内容持久化/跨进程恢复**：`jobs-local` 全内存（"process-local"），注册记录不落盘、不跨进程；重启后旧 job 只剩下 session 里可能存在的通知痕迹。
7. **maintenance 与用户 turn 互斥**：maintenance 期间 status 仍为 `idle`（`agent.ts:108-110`）但用户输入只能被 latch 延迟执行；长任务会推迟对话（可接受但不隐形）。
8. **观察者内不能 append**：`session/event` 回调必须延后写（`:687-690`），"同步触发后台工作"时不能顺手写 session。
9. 【待深挖】`session-checkpoint-policy` 的文档提到 `goal-round-driver` 的 "idle checkpoint" 是 `sessions.flush` 的既有消费者（`core/session/src/index.ts:1073-1080`）——那是一处已存在的"空闲后台提交"实现，本轮按范围未展开（goal 业务）。

---

## 附录：本轮核验的实现文件（20 个主证据）

1. `vendor/cordis/src/fiber.ts`
2. `vendor/cordis/src/events.ts`
3. `vendor/cordis/src/registry.ts`
4. `vendor/cordis/src/service.ts`
5. `vendor/cordis/src/context.ts`
6. `vendor/cordis/src/utils.ts`
7. `vendor/timer/src/index.ts`
8. `vendor/hmr/src/index.ts`
9. `packages/util/timeout/src/index.ts`
10. `packages/jobs/jobs/src/index.ts` + `types.ts`
11. `packages/jobs/jobs-local/src/index.ts`
12. `packages/jobs/tool-jobs/src/index.ts`
13. `packages/core/agent/src/runtime-types.ts`、`index.ts`、`inbox.ts`
14. `packages/core/agent-loop/src/agent.ts`
15. `packages/core/agent-loop/src/index.ts`
16. `packages/core/agent-loop/src/tool-calls.ts`
17. `packages/core/session/src/index.ts`、`types.ts`
18. `packages/core/scope/src/index.ts`
19. `packages/core/tools/src/index.ts`
20. `packages/schedule/schedule/src/runtime.ts` + `index.ts`
辅助（部分读取）：`packages/llm/llm-retry/src/index.ts`、`packages/llm/llm/src/retry-policy.ts`、`packages/guard/timeout-policy/src/index.ts`、`packages/session/session-checkpoint-policy/src/index.ts`、`packages/shell/tool-bash/src/index.ts`、`apps/cli/src/{process-shutdown,profile-boot}.ts`、`packages/bundle/base/cordis.patch.yml`。

---

## 落地决策事实（供下一阶段直接采用）

1. **要"每 Session 单 worker"，唯一正确的挂载点是 `ctx.on('agent/created')` + `agent.ctx.effect(...)`**；`agent` 的 id 就是 session id（`core/agent/src/index.ts:470-472`），因此"per-session"与"per-agent"在 DSH 里是同一件事。参考实现照抄 `schedule/schedule/src/index.ts:43-84`。
2. **单飞 + 合并用自持 `requested/run` 组合**（`schedule/runtime.ts:103-157`），不要指望框架提供队列；`ctx.jobs` 只给"上限 + 抛错"。
3. **不阻塞主 Agent 的两种正式姿势**：短临界区用 `agent.runMaintenance()`（失败不外溢、只在 idle 时占位）；长任务用 `ctx.jobs.start({owner: agent, ...})`（owner 销毁时被 cancel 并 await，turn 取消不影响它）。两者**不要同时**用于同一份工作。
4. **唤醒主 Agent 走 `followup`（idle，有 3 次自激励上限）/ `inject`（busy）**，不要从后台回调直接 append session。
5. **任何后台续作都必须自带 liveness fence**（`ctx.agents.get(id) === agent` 或自持 lifetime AbortController 的 `aborted` 检查），因为 HMR reload 不等待旧 fiber 卸载。
6. **超时一律用 `@deepseek-ai/dsh-timeout` 的 `deadline`/`idleWatchdog`/`clampTimeout`**；重试必须自写（只有 LLM 请求有正式重试器）。
7. **关机只有 fiber disposer**，5s 硬上限；后台 worker 的 disposer 必须是"置停 + 清 timer + `Promise.allSettled(在飞)`"的形式（`runtime.ts:131-140`）。
8. **DSH 现有的 "Checkpoint" 是同步 fail-closed 的持久化屏障**（`session-checkpoint-policy`），不是后台任务；若要做"独立后台 checkpoint"，应复用 `ctx.sessions.flush(session)`（唯一 flush 入口，`core/session/src/index.ts:1086-1103`）而不是自己写通道。

## 遗留问题

1. `goal-round-driver` 的 "idle checkpoint" 与 goal 相位的后台推进方式未核验（本轮按范围排除 goal 业务）——它是唯一已知的"空闲后台提交"既有实现。
2. `subagent` 的父子取消链（`parent` cancel cause 的触发者与跨 agent 传播路径）只看到接口未看实现。
3. HMR reload 期间"旧 fiber 在飞任务 vs 新 fiber"的实际竞态是否有 in-tree 测试覆盖，未核验。
4. `ctx.jobs` 是否有远程/持久化实现（除 `jobs-local` 外的 backend）未检索完整。
5. `session-projection-cache`、`settings-file`、`web` 侧消费者的 liveness fence 一致性未核验。
6. `DisposableList.clear()` 逆序 + `Promise.all` 并发卸载意味着"先停准入、再排空"的次序只对**同步部分**成立；异步 disposer 之间的相对次序无保证——若目标插件依赖严格次序，需要自行用一个复合 effect 串起来（`scope.ts:109` 的 `rawDispose` 就是为此存在）。
