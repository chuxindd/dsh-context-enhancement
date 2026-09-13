# DSH 插件钩子、Waterfall 与可变更边界勘察

> 状态：基于 DSH 源码静态核验（只读）。DSH 根目录：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 调查限定：`packages/core/agent/src/runtime-types.ts`、`packages/core/agent-loop/**`、`packages/core/system-prompt/**`、`packages/core/tools/**`、`packages/llm/llm` 的 stream seam、`vendor/cordis` 的事件/卸载直接接口；直接调用链最多两层。
> 不做：compaction 算法、token-meter、JSONL 存储、goal/todo、当前插件审计。不重复已落库事实（01–05）。
> 证据标记：【已证实】= 已读源码含行号；【待深挖】= 只证实机制存在但未完整核验；【未找到】= 限定范围内不存在。
> 行号格式：`文件:行`（省略 packages/ 前缀）。

---

## 1. Hook 矩阵（核心输出）

### 1.1 上下文管理相关事件：模式、时序、输入输出、短路与异常

| 事件 / seam | 模式 | 精确触发点 | 输入 | 返回值与 `next()` 语义 | 可短路？ | 异常语义 |
|---|---|---|---|---|---|---|
| `system-prompt/assemble` | waterfall | `agent-loop/src/agent.ts:239`（**在 `agent/pre-step` 之前**，由 `systemPrompt.assemble` 内部派发 `system-prompt/src/index.ts:601`） | `(assembly: PromptAssembly, context: AssembleContext{scope?,agent?,signal?})` | 返回的 assembly **即权威**；`next()` 走内层/内建 | 是（不调 `next()`） | 【已证实】listener 抛错 → 冒泡出 `assemble()` → `preStep` 失败 → turn 以 error 结束（`agent.ts:239,311-324`）。附带 `system-prompt-invariant` 以 `{global:true,prepend:true}` 校验权威结果（`system-prompt/src/invariant.ts:46-51`） |
| `agent/pre-step` | waterfall | `agent.ts:243-249`，在 `step/start` **之前**；触发时机 = 输入被 `inbox.claim()` 之后、`step/start` 与 `user/message` 入日志之前 | `{agent, messages(已认领), turn, step, signal}` | 返回 `{kind:'reject'}` 或 `{kind:'enter', messages, startsRequestSeries?}`（`core/agent/src/runtime-types.ts:55-63`）。`next()` 返回内建决策：`{kind:'enter', messages:[...claimed, runtimeContext?]}`（`agent.ts:245-248`）；**loop 只取决策，不取 assembly** | 是 | 【已证实】抛错 → `turn()` catch → `turn/end {kind:'error'}`（`agent.ts:311-332`）。决策 `reject` → `turn/end {kind:'blocked'}`（`agent.ts:276-279`） |
| `agent/request` | waterfall | `agent.ts:478-481`，在**每次** `buildRequest` 内（即每个 step、以及每次 request-error retry 后） | `{agent, turn, step, signal}` | 返回 `LlmCallConfig`；不调 `next()` 即完全替换；`next()` = 首次请求的 `AgentOptions` 或已落库 header 的 config（`agent.ts:468-481`，`requestProposal` 剥离 adapter 默认值 `agent.ts:60-67`） | 是 | 【已证实】抛错 → `buildRequest` 抛 → `step()` → `turn()` error 结束 |
| `agent/request-error` | waterfall | `agent.ts:392-402`，**仅当** stream 产出 `finish.kind === 'error' \| 'aborted'`（即适配器边界的归一化失败）时 | `{agent, turn, step, provider, failure, retryPolicy, signal}` | 返回 `{kind:'retry'} \| undefined`；`next()` 委托下游；返回非 retry → 循环抛 `LlmError`（`agent.ts:404-406`） | 是 | 【已证实】抛错 → step/turn error。**注意**：`llm/stream` 内抛出的异常走 `agent.ts:372-389` 分支，**不**派发本事件 |
| `llm/stream` | waterfall | `llm/llm/src/index.ts:1055-1065`；被 `agent.ts:364` 调用（`preparedCall.stream(request)` 优先） | `(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)`；loop 构建的 request 已 `deepFreeze` 并带 `markAgentLoopRequest` 身份 | 返回 chunk 异步可迭代；`next()` = 适配器 stream；**yield 自己的 chunk 即整体短路** | 是 | 【已证实】listener 自身抛错 → 冒泡到 `agent.ts:372` catch → turn error（**不经** `agent/request-error`）；适配器/迭代失败被归一化为终止 finish chunk（`llm/index.ts:1005-1008,1019-1023,1069-1077`） |
| `tools/pre-execute` | waterfall | `tools/src/index.ts:1466-1469`（`prepare` 阶段，在 body 前） | `(exec: ToolExecution, next)` | `PreToolDecision = allow \| deny{reason} \| ask{reason?}`（`tools/index.ts:581-584`）；`next()` = allow | 是 | 【已证实】**被包含**：抛错 → `prepareExecution` catch → `toolErrorResult`（`tools/index.ts:1495-1497`），不炸 turn |
| `tools/execute` | waterfall | `tools/src/index.ts:1564-1567`（around-dispatch，包住 tool body） | `(exec: ToolDispatchExecution, next)`；wrapper 只能替换 `exec.signal` | 返回 `ToolExecutionResult`；`next()` = `dispatchToolBody` | 是 | 【已证实】被包含：抛错 → `dispatchScheduledExecution` catch → final error result（`tools/index.ts:1587-1589`） |
| `tools/post-execute` | waterfall | `tools/src/index.ts:1734-1737`（`finalize` 阶段，body 之后、`finalizeContent`/materialize 之前） | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next)` | `PostToolDecision = {accept,content?,value?,additionalContexts?} \| {block,feedback,additionalContexts?}`（`tools/index.ts:590-593`） | 是 | 【已证实】被包含：抛错 → `finalizeScheduledExecution` catch → error result（`tools/index.ts:1609-1611`） |
| `tools/result` | **emit** | `tools/src/index.ts:1656-1658`（materialize 之后、**durable `tool/result` 入日志之前**） | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>)` | 返回值被忽略 | 否 | 【已证实】observer 抛错仅 `logger.warn`，不影响结果与后续 observer（`tools/index.ts:1653-1659`） |
| `tools/ptc-dispatch-log` | waterfall | `tools/src/index.ts:1287-1297`（`run_code` 子调用 settle 后，写 `tool/code-dispatch` 之前） | `(dispatch: PtcDispatchLog, next)` | 返回 `ContentBlock[]`（只改**日志副本**） | 是 | 【已证实】被包含：抛错 → 记录原 content（`tools/index.ts:1293-1296`） |
| `agent/turn-stopping` | **serial** | `agent.ts:305`（step 结束且 `inbox.nextStep` 为空、`turn/end` 之前） | `{agent, turn, signal}` | 无返回值契约；**数据决定**：listener 只能 `agent.steer(...)` 让机器重读 inbox（`runtime-types.ts:268-285`） | 否（serial 的 bail 值会停止后续 listener，但"是否继续 turn"由数据决定） | 【已证实】抛错 → `turn()` catch → error 结束 |
| `agent/status` | emit | `agent.ts:113-120`（相位切换处） | `{agent, status:'idle'\|'running'}` | 忽略 | 否 | 【已证实】经 `agentEvents().emit` 逐 listener 包含异常/拒绝（`core/agent/src/dispatch.ts:120-137`） |
| `agent/session-start` | emit | 生命周期开始，首个 turn 前（`runtime-types.ts:214-224`） | `{agent, source}` | 忽略；用 `agent.inject()` 播种 | 否 | 同上（包含式） |
| `agent/error` | emit | `agent.ts:212-217`（step/turn 失败上报） | `{agent, turn, step, error}` | 忽略 | 否 | 同上 |
| `session/event` | emit | `Session.append` 内，事件已在 log 后**同步**派发（`core/session/src/index.ts:700-711`） | `(session, event)` | 忽略 | 否 | 【已证实】per-listener 包含（`session/index.ts:638-639` 契约 + `invokeContainedSessionObservers`） |
| `system-prompt/change` / `tools/change` | emit | 注册/注销 prompt 贡献或 tool 变化（`system-prompt/src/index.ts:398-401`、`tools/src/index.ts:806`） | 无 / 无 | 忽略 | 否 | 注册期通知，非上下文路径 |
| `internal/dispatch` | emit | 任何非 `internal/` 事件派发前（`cordis/src/events.ts:168-170`） | `(mode, name, args, thisArg)` | 忽略 | 否 | 被 compaction-invariant 用作预提交校验窗口（`compaction/compaction/src/invariant.ts:344-351`） |

### 1.2 各 seam 的可变更边界（可变 / 冻结 / 持久性）

| seam | 可读 | 可写 | 冻结时机 | 影响范围 |
|---|---|---|---|---|
| `system-prompt/assemble` | assembly 全量、context（含 agent/scope/signal） | `sections/contexts/tools/variables` 四表（返回即权威） | 【已证实】assembly 未被 `deepFreeze`；但返回值立即被 `renderPrompt()`（`agent.ts:346`）与 `header.tools`（`agent.ts:498-503`）消费 | 本次 assembly；`system` 字符串在 `step()` 开头只渲染一次，**retry 不重渲染**，`assembly.tools` 每次 `buildRequest` 重读 |
| `agent/pre-step` | session/surface/投影/inbox/messages | 只能返回决策：改 `messages`、`reject`。被返回的 messages 由 loop 以 `surfaceOp:'append'` 落库（`agent.ts:291-293`） | 决策对象由 loop 重新赋值后使用（`agent.ts:251`） | **持久**（写入 `user/message` 日志） |
| `agent/request` | session/header/contextWindow | 仅 `LlmCallConfig` 六字段：`provider/model/reasoningEffort/temperature/maxTokens/stop`（`llm/llm/src/call-config.ts:23-30`） | `seedConfig` 已 `deepFreeze(structuredClone(...))`（`agent.ts:468-477`），返回替换值不限 | 本次请求配置；变化被写成 `request/header`（reason `change`/`series`，`agent.ts:507-518`）→ **持久** |
| `agent/request-error` | 全 session + failure + retryPolicy | 返回值 `{kind:'retry'}`；**间接**可写日志（如 replacement） | failure 已冻结（`llm/index.ts:112-118`） | 决定是否重跑请求；写入的日志 **持久** |
| `llm/stream` | `options`（深冻结，**只读**） | 只能 yield 自己的 chunk 或不 yield | loop 请求 `deepFreeze`（`agent.ts:535-542`）+ `markAgentLoopRequest`（`call-config.ts:66-69`） | 本次流。**不可改 messages**：`agent-loop/src/invariant.ts:39-42` 断言 `options.messages` 必须等于 `session.deriveMessages()`，`:44-52` 断言 header 各字段与折叠 header 一致 |
| `tools/pre-execute` | `exec`（参数已冻结） | 只能返回 allow/deny/ask；参数重写被明确排除（"arguments are already logged"，`tools/index.ts:576-580`） | `createExecution` 中 `deepFreeze(detached)`（`tools/index.ts:1403-1407`） | 本次调用 |
| `tools/execute` | `exec` | **只能替换 `exec.signal`**（`tools/index.ts:145-155`）；call identity 不可变 | 同上 | 本次 dispatch（含重试/超时/指标包裹） |
| `tools/post-execute` | `exec`、result | 可替换 `content`、`value`（仅成功结果）、`additionalContexts`，或 `block` 成 isError | result 在 `tools/result` 前被 materialize + `Object.freeze(exec)`（`tools/index.ts:1651`） | 本次结果；`additionalContexts` 由 loop 在 **tool/result 之后**注入下一步（`tool-calls.ts:156-157`） |
| `tools/result` | 冻结的 exec + result | 不可写 | 已冻结 | 仅观察 |
| 直接 `session.append(..., {surfaceOp})` | — | 任何 surface-eligible 事件 | — | **持久**；合法性由 `SurfaceManager.validateNext` 判定（`session/index.ts:698`） |

---

## 2. 逐项回答

### Q1 精确时序、IO、短路、异常与 `next()` 语义

- 【已证实】**Cordis 派发原语的唯一权威**在 `vendor/cordis/src/events.ts`：`emit` 同步调用、忽略返回值、`Array.map` 语义（一个同步抛错会饿死后续 listener，`events.ts:194-196`）；`serial` 按序 await 直到出现 bail 值（非 null/false/undefined，`events.ts:13-15,204-209`）；`waterfall` 用捕获的 listener 数组做 `cbs.shift() ?? inner` 的续接，**不调用 `next()` 即否决剩余链与内建行为**，返回值为最外层 listener 的返回值（`events.ts:234-243`）。
- 【已证实】`waterfall` 的 listener 快照在 dispatch 时确定（`events.ts:236-242`）：**已开始的链即使 listener 在飞行中被注销仍会被调用**——`llm-retry` 明确为此自守（"A waterfall may have captured this callback before its registration was removed"，`llm/llm-retry/src/index.ts:243-252`）。
- 【已证实】异常语义分两类：(a) **包含式**——`agent` 事件 emit（`dispatch.ts:120-137`）、`session/event`（`session/index.ts:638-639`）、`tools/*` 三个 waterfall（`tools/index.ts:1495-1497,1587-1589,1609-1611`）与 `tools/result`（`tools/index.ts:1653-1659`）；(b) **直抛式**——`system-prompt/assemble`、`agent/pre-step`、`agent/request`、`agent/request-error`、`llm/stream`，抛错即终止当前请求/turn。
- 【已证实】`skipSignal`：`system-prompt/assemble` 的 signal "只控制本次显式 assembly，不得留存去控制后续 turn"（`system-prompt/src/index.ts:22-26`）；`agent.pre-step/agent.request/request-error` 的 signal 是当前 turn 的取消信号（`runtime-types.ts:238-267`）。loop 在关键点后立即 `signal.throwIfAborted()`（`agent.ts:240,250,287,303,306,365,371,403,482,496,533`）。

### Q2 各 hook 执行时，Session/surface/messages/system prompt/options 的可变性与冻结

- 【已证实】**Session**：始终可读 `surface.nodes`、`surface.replaceGeneration`（`session/index.ts:431-432`）、`snapshotEvents()`（`:600-609`）、`eventAt()`（`:588`）、`seq`（`:629`）、`ownEvents()/isOwnSeq()`（`:615,624`）、`requestHeader()`（`:734-744`）、`requestContext()`（`:755-763`）、`deriveMessages()`（`:790-809`）。日志为 append-only，无删除/改写 API；事件进入 log 前做无损 JSON 快照并深冻结（`session/index.ts:678-697`）。
- 【已证实】**surface 只能通过 append 一个带 `surfaceOp:{op:'replace',start,end}` 的 surface-eligible 事件改变**，且必须提供覆盖被遮蔽区间的 `sourceEventSeqs`（`session/index.ts:698` → `surface.ts:195-218,220-253`）。替换仅在事件成功写入后 `splice` 生效（`surface.ts:378-381`）。
- 【已证实】**messages**：在 `agent/pre-step` 可通过决策替换（**持久**，写成 `user/message`）；在 `agent/request`/`llm/stream` **不可改**——前者契约明示"cannot mutate messages"（`runtime-types.ts:243`），后者的 request 深冻结且被 invariant 断言等于 `session.deriveMessages()`（`agent-loop/src/invariant.ts:39-42`）。
- 【已证实】**system prompt**：只能在 `system-prompt/assemble` 的 assembly 层变更（或通过 `systemPrompt.section()` 注册，`system-prompt/src/index.ts:432-441`）。`renderPrompt()` 在 `step()` 开头一次性执行（`agent.ts:346`），因此 **retry 不会重跑 assembly**。**注意**：若某 scope 注册了 `complete:true` 的 section，waterfall 之后该 section 会被强制恢复为唯一 section（`system-prompt/src/index.ts:605-608`）——listener 无法增删或替换该 scope 的 system prompt。
- 【已证实】**options**：`GenerateOptions` 由 `buildRequest` 组装并 `deepFreeze`（`agent.ts:535-542`）；`AgentOptions` 是 `readonly`（`runtime-types.ts:71-77`）且只作为 `agent/request` 的种子。
- 【已证实】**请求配置的持久性**：变更被记录为 `request/header`（reason `change`/`series`）与 `request/context`（`agent.ts:504-532`），因此对**后续**请求生效——下一次 `buildRequest` 从落库 header 折叠出 seed（`agent.ts:458-477`）。
- 【待深挖】`PromptAssembly` 对象本身未被冻结，listener 若保留引用并在返回后异步改动，其 `tools` 会在**同一 step 的每次 retry 的 `buildRequest`** 中被重读，而 `system` 字符串不会。

### Q3 排序关系

- 【已证实】**一次 step 的完整顺序**（`agent.ts:234-438`）：
  1. `inbox.claim()`（`:238`）
  2. `systemPrompt.assemble()` → 内部派发 **`system-prompt/assemble`**（`:239`）
  3. runtime context 投影（`:241-242`）
  4. **`agent/pre-step`**（`:243-249`）
  5. `step/start`（`:288`）→ `user/message` × n（`:291-293`）
  6. `deriveMessages()` → **`agent/request`**（`:355`, `:478-481`）→ `llm.prepareCall`（`:489`）
  7. `request/header`（`:507-518`）→ `request/context`（`:521-532`）
  8. **`llm/stream`**（`:364` → `llm/index.ts:1059-1064`）→ 逐 chunk 写 `assistant/chunk`（`:368`）
  9. 失败且为 finish error/aborted → **`agent/request-error`**（`:392-402`）；返回 retry 则 `continue` 回到第 6 步
  10. 成功 → `assistant/message`（`:418-427`）
  11. 有 tool-call → **`tools/pre-execute` → (`tools/execute`→body) → `tools/post-execute` → `finalizeContent` → `tools/result`**（`tools/index.ts:1466,1564,1734,1631/1640,1656`）
  12. 工具调用追加上下文到 `next-step` inbox（`tool-calls.ts:156-157`）→ 回到第 4 步（`agent.ts:304-310`）
  13. `turn/end` 前若 `nextStep` 为空 → **`agent/turn-stopping`**（serial，`:305`）→ `turn/end`（`:328`）
- 【已证实】**关键结论**：`system-prompt/assemble` 严格**先于** `agent/pre-step`；`agent/request` 在**每个** retry 迭代内重跑；`agent/request-error` 严格位于 `llm/stream` 之后、下一次 `agent/request` 之前。
- 【已证实】tool 内部顺序：`prepare`(pre-execute+ask+guard) 与 `dispatch`(execute+body) 由 loop 分别 await（`tool-calls.ts:170-174`），`post` 在有序 commit 点执行（`tool-calls.ts:152-156`）；`tools/result` 在 durable `tool/result` **之前**触发（`tools/index.ts:1635` vs `tool-calls.ts:156`）。

### Q4 多插件监听顺序、prepend/priority/order、冲突与短路

- 【已证实】**只有 `prepend` 布尔，没有 priority/weight**（`cordis/src/events.ts:112-117`）：`push` 为默认（注册顺序，先注册者在最外层），`prepend:true` 为 `unshift`（后注册者插到最前，即最外层最先决定），`events.ts:255`。同一事件的 agent-scoped 与 global listener 都参与，先按 `dispatch()` 的 scope filter 过滤（`events.ts:171-174`；`hook.global || !filter || filter.call(thisArg, hook.ctx)`）。
- 【已证实】**短路规则**：waterfall 最外层不调 `next()` → 内层与内建行为都不执行；内层无法"否决"外层；`emit` 无短路语义（返回值被忽略），但同步抛错会中断后续 listener（除已包含的 agent/session 事件）。
- 【已证实】**冲突解决依靠"数据/权威值"而非顺序**，实例：
  - `system-prompt/assemble`：返回值为权威，但 `complete` section 与 runtime-context 抑制在 waterfall 之后强制恢复（`system-prompt/src/index.ts:605-610`）。
  - `agent/turn-stopping`：文档明示"Data decides, so listener order cannot change the outcome"（`runtime-types.ts:268-285`）。
  - `tools/pre-execute` 之后是 **monotonic guard**：只能拒绝，不能把拒绝翻回允许（`tools/index.ts:696-704,1477-1490`）。
  - invariant 插件用 `{global:true,prepend:true}` 保证自己最外层、不被短路静默绕过（`llm/llm/src/invariant.ts:88`、`system-prompt/src/invariant.ts:51`、`agent-loop/src/invariant.ts:54`、`compaction/compaction/src/invariant.ts:323,343,351`）。
- 【已证实】**现存顺序冲突点**：`compaction-basic` 的 `agent/request-error` 注册**无 prepend**（`compaction/compaction-basic/src/index.ts:180`），`llm-retry` 同样无 prepend（`llm/llm-retry/src/index.ts:243`）→ 两者互见顺序由插件装载顺序决定。默认 `retryableCodes` **不含** `CONTEXT_WINDOW_EXCEEDED`（`llm/llm/src/retry-policy.ts:18-24`；常量在 `llm/llm/src/error.ts:25`），故 normal 模式会 `next()` 让下游 compaction 处理；但若部署把该 code 配进 `retryableCodes`，位于外层的 `llm-retry` 会在**不调用 `next()`** 的情况下直接重试同一超限请求（`llm-retry/src/index.ts:215-217,223`）。`always` 模式先 `settleDownstream(next)`，下游返回 retry 时优先采用（`:199-214`）。
- 【已证实】`agent/pre-step` 的现存顺序示例：`compaction-basic` 在 `next()` **之前**执行压力压缩（`compaction-basic/src/index.ts:148-166`）；`time-context` 用 `{prepend:true}` 并把消息追加到 `next()` 的结果之后（`packages/context/time-context/src/index.ts:180-220`）。

### Q5 retry 后哪些阶段重跑、哪些状态复用；overflow 恢复的安全 seam

- 【已证实】**重跑**（`agent.ts:348-408` 的 `while(true)`）：`surface.replaceGeneration` 重读 → `session.deriveMessages()` 重新派生 → **`agent/request`** waterfall → `llm.prepareCall`（新 `PreparedLlmCall`，因 `prepareCall` 的 `stream` 只允许派发一次，`llm/index.ts:916-926`）→ `request/header` / `request/context` 按需再写 → **`llm/stream`**。
- 【已证实】**不重跑/复用**：`system-prompt/assemble`（`system` 字符串与 `assembly.tools` 来自 step 开头）、runtime-context 投影、`agent/pre-step`、`user/message` 落库、工具执行。失败尝试已写入的 `assistant/chunk` 事件**保留在日志中**（非 surface-eligible，不进模型历史）；`assistant/message` 只在其后被写入。
- 【已证实】**series 语义**：`startsSeries = startsRequestSeries || this.requestSurfaceGeneration !== surfaceGeneration`（`agent.ts:504-506`）→ 一次 replacement 导致的 generation 变化会让新请求以 `request/header{reason:'series'}` 开启新消息序列（`:516-518`）。
- 【已证实】**无内建 retry 计数**：`agent/request-error` 的 listener 必须自持久化计数。现存两种范式：WeakMap + 在 `agent/status:idle` 与新的 `assistant/message`（`session/event`）时清零（`compaction-basic/src/index.ts:168-178,185-192`）；或用 `ctx.sessionProjections` 的 `'llmRetry'` 持久投影并把 retry 记成 `llm/retry` / `llm/retry-started` 事件（`llm-retry/src/index.ts:188-190,220`）。
- 【已证实】**overflow 恢复的安全 seam = `agent/request-error`**，理由全部来自源码：(a) 它是唯一携带归一化 `failure.code` 的 turn 内扩展点（`agent.ts:392-402`）；(b) 返回 `{kind:'retry'}` 会回到请求构建循环，从而重新 `deriveMessages()`，**已提交的 replacement 会被新请求采用**（`:348-359`）；(c) 它位于 `llm/stream` 之后、放弃 step 之前，能在 turn 不失败的情况下完成替代。**风险**：若把 `CONTEXT_WINDOW_EXCEEDED` 配为 provider 的可重试码且 `llm-retry` 位于外层，本 seam 不会被调用（见 Q4）。
- 【待深挖】`request/header{reason:'series'}` 对下游 provider 缓存复用的影响未在本轮核验（属 provider/缓存专题）。

### Q6 Session generation / compaction lock / turn-step 边界在 hook 中可获得什么

- 【已证实】**generation**：`session.surface.replaceGeneration`（单调递增的已提交位置替换计数，`surface.ts:143-149,380,448-450`）；`deriveMessages()` 的缓存即按它失效重建（`session/index.ts:793-798`）。示例用法：overflow 前记录、commit 后比较（`compaction-basic/src/index.ts:192`）。
- 【已证实】**turn/step 边界**：payload 直接给出（`pre-step`: turn+step；`request`/`request-error`: turn+step；`turn-stopping`: turn；`error`: turn+step；`inbox/claimed`: turn）。另有持久投影 `ctx.sessionProjections.stateOf(session,'turnBoundary')` → `{openTurnStartSeq,lastStepStartSeq,lastStepBoundary,lastTurn}`（`agent-loop/src/index.ts:44-79`；loop 自身就这么用，`agent.ts:101`）。**【未找到】Session 上直接暴露"当前 open turn / 是否在 turn 内"的公共方法**——除投影外只能自行折叠 `turn/start`/`turn/end`。
- 【已证实】**compaction lock**：**【未找到】锁对象或 `ctx.compaction` 上的公共"是否 busy"查询**。锁是**持久日志状态**，由折叠 `compaction/start`/`compaction/end`（含 `session/end-seed` 作废）与 open turn 得出（`compaction-basic/src/region.ts:527-558,174-183,289-300`）。在 hook 中只能以同样的日志折叠（`session.snapshotEvents()`/`eventAt()`）观察。
- 【已证实】**已有 bracket 的跨 turn 约束**（对任何写日志的插件都生效）：`turn/start`/`turn/end` 不得跨一个未闭合的 compaction bracket（`compaction/compaction/src/invariant.ts:136-149`）；`compaction/start` 重复开启被拒（`:200-208`）。
- 【已证实】**contextWindow**：由 `request/context` 折叠得到（`session/index.ts:755-763`），在 `agent/request-error` 时可读（`compaction-basic` 的 overflow 路径据此路由目标）。

### Q7 卸载/reload/fiber dispose 后监听器与服务如何失效；后台异步回调能否继续提交

- 【已证实】**监听器**：`ctx.on` 把注册包成 `fiber.effect`，随 owning fiber 卸载自动注销（`cordis/src/events.ts:288-302,254-260`），返回 disposer 可提前注销（`:269-275`）。已 dispose 的 fiber 再注册抛 `CordisError('INACTIVE_EFFECT')`（`fiber.ts:351-354`、`events.ts:294`、`fiber.ts:419-422`）。
- 【已证实】**reload**：`restart()`/`update()` → `_setEpoch(INACTIVE)` → `_unload()` → `_reload()` 重跑插件回调（`fiber.ts:646-673,718-753`）。因此 listener 被"移除再插入"，**`prepend` listener 的相对位置会随 reload 时刻变化**（`events.ts:255`）。
- 【已证实】**服务**：`Service` 构造即 `ctx.reflect.provide`，随 owning fiber 卸载注销（`service.ts:42-59`）；未提供时读取返回 `undefined`（strict 读取抛错）（`reflect.ts:15-17,252-258`）→ 卸载后依赖服务的后台逻辑会拿到 `undefined`/抛错。
- 【已证实】**卸载不能撤回已在飞行的 waterfall 链**：dispatch 时已快照 callback 数组，链会走完（`events.ts:236-242`）；`llm-retry` 为此用 `lifetime.signal.aborted` 自守，并在卸载 effect 中 abort + drain 在途恢复（`llm-retry/src/index.ts:243-258`）。
- 【已证实】**`session.append()` 本身不做 fiber 校验**（`session/index.ts:668-719` 无 `assertActive`）→ 持有 Session 引用的后台回调**仍能提交**；但提交要过 `SurfaceManager.validateNext` 与 compaction-invariant，违反 bracket/turn 边界会 fail。`session/event` 的派发载体是 session 的 attach 载体而非某个插件 fiber（`session/index.ts:687,700-711`），故卸载某插件不阻止其他观察者收到事件。【待深挖】`collectSessionCallbacks` 对已 detach 载体的确切行为。
- 【待深挖】scope 过滤的完整实现（`ctx[Context.filter]`、`Scoped<T>`、`scopeTarget`）——本轮只证实过滤存在及其调用位置（`events.ts:171-174`、`agent/src/dispatch.ts:94-96,125-126`、`tools/index.ts:1465,1563,1735`、`system-prompt/src/index.ts:602`），未逐行核验"无 agent 的诊断 assembly 是否也能命中 agent-scoped listener"的边界。

### Q8 各目标的推荐正规 seam（仅陈述 DSH 能力，不含插件方案）

| 目标 | 正规 seam | 依据 |
|---|---|---|
| **读 surface / 历史** | 任一 `agent/*` payload 的 `agent.session`：`surface.nodes`、`deriveMessages()`、`snapshotEvents()/eventAt()`、`requestHeader()/requestContext()`；跨会话用 `ctx.sessions.get/list`（`session/index.ts:1119,1127`） | `session/index.ts:431-432,588-631,734-763,790-809` |
| **写 replacement** | 唯一路径：`session.append(eligibleType, data, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs})`；合法性与完整性由 `SurfaceManager.validateNext` 在入 log 前判定，失败即抛、surface 不变。时机上安全的是"无并发写者"的窗口：`agent/pre-step`（尚未 buildRequest）或 `agent/request-error`（step 内、重跑请求前） | `session/index.ts:668-719`；`surface.ts:195-253,324-326,378-381`；`compaction/compaction/src/invariant.ts:136-149` |
| **注入长期状态** | (a) 已开启的 turn 内：`agent.inject(msg)`（下一步 pre-step 领取，不唤醒；`agent.ts:139-141`、`runtime-types.ts:141-149`）；(b) 直接改本次决策：`agent/pre-step` 返回 `messages`（**持久**落库）；(c) 每 assembly 的动态 context：`systemPrompt.context({name,order,text})` + `ctx.sessionProjections.register` 记状态（`system-prompt/src/index.ts:467-476`；loop 内置范式 `runtime-context.ts:34-75`、`time-context/src/index.ts:152-220`）；(d) 组内共享的持久投影状态：`ctx.sessionProjections.register/stateOf` | 同上 + `agent-loop/src/index.ts:44-79` |
| **修改请求配置** | `agent/request` waterfall，只能改 `LlmCallConfig` 六字段；改 `messages/system/tools` 无合法 seam（invariant 会 fail） | `agent.ts:478-481`；`call-config.ts:23-30`；`agent-loop/src/invariant.ts:39-52` |
| **包裹 provider stream** | `llm/stream` waterfall：读 `options`（深冻结），`next()` 到适配器，或 yield 自己的 chunk 短路（retry/replay/routing 的既定用途） | `llm/index.ts:54-69,1055-1065`；`agent.ts:364` |

---

## 3. 可直接用于落地决策的事实

1. 上下文相关的核心 waterfall 共 5 个：`system-prompt/assemble`、`agent/pre-step`、`agent/request`、`agent/request-error`、`llm/stream`；tool 侧 4 个：`tools/pre-execute`、`tools/execute`、`tools/post-execute`（waterfall）+ `tools/result`（emit，仅观察）。
2. 派发原语只有 `prepend` 布尔，**没有 priority**；waterfall 最外层不调 `next()` 即否决一切内层与内建行为；已开始的链无法被卸载撤回。
3. `system-prompt/assemble` 先于 `agent/pre-step`；`agent/request` 位于**每次 retry 迭代内**；`agent/request-error` 位于 `llm/stream` 之后、下一次 `agent/request` 之前。
4. `llm/stream` 是**只读** seam：loop 请求深冻结，且 `agent-loop-invariant` 断言 `messages === session.deriveMessages()`、header 各字段与折叠 header 一致。
5. 模型可见内容的合法写入通道只有两个：`agent/pre-step` 决策（持久 `user/message`）与带 `surfaceOp.replace` 的 `session.append`（面遮蔽）。`agent/request` 只能改 6 个配置字段。
6. `session.append` 不做 fiber 校验：后台异步回调仍可提交，但必须自守失效边界，并满足 `SurfaceManager` 与 compaction-invariant 的 bracket/turn 约束。
7. overflow 恢复的安全 seam 是 `agent/request-error` + `{kind:'retry'}`：它使请求构建循环重跑 `deriveMessages()`，从而让已提交的 replacement 生效；失败尝试的 `assistant/chunk` 事件留在日志但不进模型历史。
8. generation 用 `session.surface.replaceGeneration` 观察与判进展；turn/step 用 payload 或 `sessionProjections.stateOf(session,'turnBoundary')`；**compaction lock 与 open turn 无公共查询 API**，只能折叠日志。
9. `agent/request-error` 无内建计数：必须自持久化（WeakMap+重置事件，或 `ctx.sessionProjections` 持久状态）。
10. 三个公共扩展点的失败被包含（不会炸 turn）：`tools/pre-execute|execute|post-execute` 与 `tools/result`；五个上下文 waterfall 的抛错会终止当前请求/turn。
11. `llm/stream` 中 listener 抛出的异常**不会**进入 `agent/request-error`（只有适配器归一化的 finish error/aborted 才会）。
12. 若某 scope 注册了 `complete:true` prompt section，`system-prompt/assemble` 的 listener 无法增删/替换该 scope 的 system prompt。

## 4. 仍需其他专题回答的问题

1. `PromptAssembly` 未冻结：listener 保留引用并在返回后异步改动，对同一 step 的 retry（`tools` 会重读）与 `system`（不会重读）的差异影响——需最小实验确认。
2. `llm-retry` 与 `compaction-basic` 对 `agent/request-error` 的**实际装载顺序**在真实 profile 中的取值（本轮只证实两者均无 `prepend`），以及把 `CONTEXT_WINDOW_EXCEEDED` 配入 `retryableCodes` 后 overflow 恢复是否被外层吞掉。
3. `ctx.sessionProjections` 的完整注册/状态契约（版本迁移、stateSchema、跨 reload 行为）——本轮只证实 3 个内置 key 的用法。
4. scope 过滤的完整语义（`Scoped<T>`/`Context.filter`）与"无 agent 的诊断 assembly"是否命中 agent-scoped listener。
5. `collectSessionCallbacks`/session attach 载体在插件卸载与 session detach 后的回调收集行为。
6. `request/header{reason:'series'}` 与 replacement 交互对 provider 端缓存复用的实际影响（属 provider/缓存专题）。
7. 工具 `additionalContexts`（post-execute 与 tool body `deferContext`）进入下一步的完整排序与去重规则。

---

## 附：本轮直接核验的源文件（25 个）

优先集合（18）：`core/agent/src/runtime-types.ts`、`core/agent/src/dispatch.ts`、`core/agent-loop/src/agent.ts`、`core/agent-loop/src/tool-calls.ts`、`core/agent-loop/src/runtime-context.ts`、`core/agent-loop/src/invariant.ts`、`core/agent-loop/src/index.ts`、`core/system-prompt/src/index.ts`、`core/system-prompt/src/invariant.ts`、`core/tools/src/index.ts`、`core/session/src/index.ts`、`core/session/src/surface.ts`、`llm/llm/src/index.ts`、`llm/llm/src/call-config.ts`、`llm/llm/src/retry-policy.ts`、`llm/llm-retry/src/index.ts`、`vendor/cordis/src/events.ts`、`vendor/cordis/src/fiber.ts`。
为回答 Q4/Q6/Q7 追加的最小补充（7）：`vendor/cordis/src/service.ts`、`vendor/cordis/src/reflect.ts`（仅检索）、`llm/llm/src/error.ts`（仅检索）、`compaction/compaction/src/invariant.ts`、`compaction/compaction-basic/src/index.ts`、`compaction/compaction-basic/src/region.ts`（仅检索）、`context/time-context/src/index.ts`（seam 用法范式）。
