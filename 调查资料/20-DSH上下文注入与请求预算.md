# DSH 上下文注入链路与模型请求预算账本

> 状态：基于 DSH 源码只读核验。DSH 根目录：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 调查限定：`packages/core/system-prompt/**`、`packages/core/agent-loop/**`、`packages/core/agent/src/{dispatch,inbox,runtime-types}.ts`、`packages/core/tools/src/index.ts`（schema/context 直接接口）、`packages/core/session/src/{types,request-header,surface}.ts`、`packages/core/scope/src/store.ts`、`packages/llm/token-meter/src/{index,estimate,usage-projection,breakdown-projection,surface-fold}.ts`、`packages/llm/llm/src/{types,call-config,message}.ts`。
> 不重复已落库事实（00–06）。不做 token 估算法推导、provider adapter、compaction 算法、storage、goal/todo、当前插件审计。
> 证据标记：【已证实】= 已读源码含行号；【待深挖】= 机制已见但未完整核验；【未找到】= 限定范围内不存在。
> 行号格式：`文件:行`（省略 `packages/` 前缀）。

---

## 1. 一次请求的精确组装顺序（问题 1）

**【已证实】一次 step 内只有一次 assembly、一次 runtime-context 投影；`system`/`tools` 在 step 开头冻结，`messages` 在 retry 循环内每次重派生。**

```
turn()  agent-loop/src/agent.ts:255
  │
  ├─ 每 step 调用一次 preStep():234
  │   1. inbox.claim(target, turn)                        :238   → 已认领 messages（next-step 全部 + 若 next-turn 则再取 1 条）
  │   2. systemPrompt.assemble(assembleContextFor(this,signal))  :239
  │        └─ 派发 waterfall 'system-prompt/assemble'     system-prompt/src/index.ts:601
  │            assembly = { sections[], contexts[], tools[], variables }   :588-600
  │            assembleContextFor → { agent, scope: agent, signal }        agent/src/dispatch.ts:174-175
  │   3. renderContextSections(assembly)                  system-prompt/src/index.ts:302
  │      joinContextSections(sections)                    system-prompt/src/index.ts:287-291
  │      runtimeContext.project(text, sections)           agent-loop/src/runtime-context.ts:64
  │        → 仅当文本与上次保留值不同才返回一条 UserMessage（不提交）
  │   4. waterfall 'agent/pre-step' { messages, turn, step, signal }   agent.ts:243-249
  │        内建 next() = { kind:'enter', messages:[...claimed, runtimeContext?] }  agent.ts:245-248
  │        ★ runtime context 追加在已认领消息之后
  │   5. decision.messages 逐条 session.append('user/message', msg, {surfaceOp:'append'})  agent.ts:291-293
  │      → 这一步起，claim 出来的消息 + runtime snapshot 都成为**持久 surface 节点**
  │
  ├─ step(assembly, startsRequestSeries)  agent.ts:341          ← 每个 step 只调用一次
  │   system = renderPrompt(assembly)     agent.ts:346          ← 一次性渲染，retry 不再渲染
  │   ┌ while (true)  agent.ts:348  ── 每次请求迭代（含 retry）──
  │   │   surfaceGeneration = session.surface.replaceGeneration  :349
  │   │   buildRequest(turn, step, assembly.tools, system,
  │   │               session.deriveMessages(), ...)             :350-359
  │   │      b1. persistedHeader = session.requestHeader()      :458
  │   │      b2. waterfall 'agent/request' → LlmCallConfig      :478-481（每次迭代都跑）
  │   │      b3. llm.prepareCall(proposedConfig)                :489 → adapterDefaults / contextWindow
  │   │      b4. header = canonicalHeader({ config, adapterDefaults?, system?, tools? })  :498-503
  │   │          ★ canonicalHeader 把空 system / 空 tools 归一为**缺席字段**  session/src/request-header.ts:21-31
  │   │      b5. 按需 append 'request/header'（initial|resume|change|series）  :507-518
  │   │      b6. 按需 append 'request/context'（provider/model/contextWindow） :521-532
  │   │      b7. request = markAgentLoopRequest(deepFreeze({
  │   │             ...header.config, messages: boundaryMessages,
  │   │             system?, tools?, sessionId, signal }))       :535-542
  │   │   preparedCall.stream(request) | llm.stream(request)    :364 → 'llm/stream' waterfall
  │   │   逐 chunk → session.append('assistant/chunk')          :368
  │   │   若 finish.kind==='error'|'aborted' → waterfall 'agent/request-error'  :390-402
  │   │        action?.kind==='retry' → continue（回到 b1，重新 deriveMessages） :404-407
  │   └ 成功 → append 'assistant/message'（surfaceOp append）  :418-427
  │
  ├─ 有 tool-call → executeToolCalls()  agent.ts:432
  │   结果按**模型序**提交：tool/result（surfaceOp append）  tool-calls.ts:156, 269-289
  │   紧随其后把 result.additionalContexts 推入 next-step inbox  tool-calls.ts:157
  │   acceptContext = inbox.splice('next-step', len, 0, [ctx])  agent.ts:434
  └─ 回到 preStep（新 step）：这些 additionalContexts 成为 claimed 批次的一部分
```

**模型实际看到的请求字段顺序**（`GenerateOptions`，`llm/src/types.ts:393-429`）：
`provider, model, reasoningEffort?, system?, tools?, temperature?, maxTokens?, stop?, messages, sessionId, signal` — **字段顺序不决定语义**；真正的语义顺序是 provider adapter 决定：system 槽在前，`messages` 按数组顺序（= `session.deriveMessages()` 的 surface 顺序），`tools` 独立字段。

**【已证实】`messages` 的精确次序**（一个 step 内）：
1. 之前所有 step/turn 的 surface 节点（`user/message` / 非空 `assistant/message` / `tool/result`；`deriveEventMessage` 只投影这三类，`session/src/surface.ts:90-121`）；
2. 本 step 由 `agent/pre-step` 决策提交的 claimed 消息（含 steering、inject、`time-context` 附加、工具 `additionalContexts`）；
3. 本 step 的 runtime-context 快照（在 claimed 之后，`agent.ts:247`）。

**【已证实】不存在全局重排**：没有任何环节对 `messages` 做排序或裁剪；顺序 = surface 位置顺序 + 决策数组拼接顺序。`llm/stream` 前有 invariant 断言 `options.messages` 必须等于 `session.deriveMessages()`（`agent-loop/src/invariant.ts:39-42`），因此 loop 请求的 messages 不可能被下游插件改写。

---

## 2. PromptAssembly 语义：order / key / complete / 去重 / 覆盖 / 恢复（问题 2）

**【已证实】四张表，key 语义不同：**

| 表 | key | 顺序规则 | 去重/覆盖规则 |
|---|---|---|---|
| `sections` | `section.name`（唯一名） | `order` 升序，**同 order 按 name 的 code-unit 排序**（`comparePromptSections`，`system-prompt/src/index.ts:227-229`） | 全局层 → 作用域链，**同名作用域覆盖全局**（`ScopedLayers.merge`，`scope/src/store.ts:208-217`）；同层内重名**抛错**（`NamedEntries.insert`，`store.ts:43-46`） |
| `contexts` | `context.name`（唯一名） | 仅 `order` 升序（`a.order - b.order`，`index.ts:593）——**同 order 无 name 兜底**，退回到 Map 插入序 | 同 sections：作用域覆盖全局、同层重名抛错 |
| `tools` | 无 name 表；由 tool providers 收集 | `orderTools`：配置了 `toolOrder` 则按配置序 + `<unlisted-tools>` 处按名字典序；未配置则**整个数组 `sort(compareToolNames)`**（`index.ts:205-219`） | **不去重**：collection 阶段 `collected.push(...schemas)` 直接拼接（`index.ts:570`）；两个 provider 返回同名 schema 不会报错 |
| `variables` | `variable` 名 | 非列表 | 全局先求值，作用域链由远及近**后求值覆盖**（`index.ts:542-551`）；重名在同层抛错 |

**【已证实】`order` 常量（集中分配，插件不得自造语义）**：
- Section orders：`system-prompt/src/index.ts:121-152`（HARNESS_IDENTITY -1000 … STRUCTURED_OUTPUT 9900）。
- Context orders：**只有三个**：`SANDBOX_POLICY 110`、`APPROVAL_POLICY 115`、`SUBAGENT_DELEGATION 120`（`index.ts:157-161`）。三个真实使用者分别取 `getContextOrder(...)`（`sandbox/src/sandbox-policy/src/index.ts:141-143`、`interaction/user-approval/src/index.ts:155-157`、`subagent/subagent/src/child-agent.ts:205-209`）——**120 以上没有任何保留位**，新 context 只能用任意数字，与既有项同 order 时顺序退化为注册序。

**【已证实】`complete` 语义**：
- 生效的 `complete` section 至多一个，多于一个 → assembly 抛错（`index.ts:574-577`）。
- 它的文本被**快照**在 `completeSection`（`:585`），waterfall 返回后**强制执行**：`sections: [completeSection]`（`:608`）→ listener **无法**增删/替换该 scope 的 system prompt。
- 但 waterfall 仍然运行，所以 `tools`/`contexts`/`variables` 仍可被 listener 改（`:601-604`——注释明确说明这是设计意图）。
- 恢复条件：`completeSection === undefined && !runtimeContextSuppressed` 时直接返回 waterfall 结果（`:605`）。

**【已证实】runtime-context 抑制的"不可逆"**：`runtimeContextSuppressed` 只要**全局层或作用域链任一层**有 supperssor 就为真（`:539-540`），一旦为真，waterfall 之后 `contexts` 被强制清空（`:609`）。构造期 `includeRuntimeContext:false` 直接调用 `suppressRuntimeContext()`（`:421`）——全局抑制无法被任何作用域重新开启。

**【已证实】渲染语义**：
- `renderPrompt`：逐 section 插值 → **丢弃空文本** → 以 `'\n\n'` 拼接（`index.ts:263-268`）。
- `joinContextSections`：逐 context 文本 `'\n\n'` 拼接，非空时前置固定句 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`（`:287-291`）；全空则 `''`。
- 变量插值**严格**：未注册变量、`undefined` 值、畸形 `{{` 都抛错（`:309-346`）；`{{` 后无任何 `}}` 视为普通散文。

**【已证实】waterfall 覆盖语义**：`system-prompt/assemble` 的返回值即权威（`:601-604`），唯一例外是上面的 `complete` 与 runtime-context 抑制恢复。`system-prompt-invariant` 以 `{global:true, prepend:true}` 包在最外层校验结果：section/context 名字非空且**不得重复**、text 必须是 string、tool 名非空、变量名合法（`system-prompt/src/invariant.ts:16-51`）——**这是"listener 不能制造重复 key"的强制兜底**。

---

## 3. 注入路径的持久性与 retry 行为（问题 3）

**【已证实】`agent.inject()`**：
- `inject(input)` = `send(input, 'next-step', wakeup:false)`（`agent.ts:139-141`）。
- 落库形式：`inbox.splice` → `session.append('agent/inbox/spliced', {target:'next-step', inserted:[...]})`（`agent/src/inbox.ts:139-193`）→ **持久**（走正常 append 通道，无 fiber 校验）。
- 生效时机：下一次 `preStep` 的 `inbox.claim()`（`inbox.ts:71-78`）把它并入 claimed 批次；随后作为 `user/message` **持久**入 surface。
- **不唤醒 driver**；空闲 agent 会一直挂到 `followup`/`steer` 唤醒（契约 `agent/src/runtime-types.ts:141-149`）。
- **可能错过**当前 step（若 claim 已发生）；取消/销毁可能丢弃（`cancel` 默认 `inbox.clear()`，`agent.ts:143-149`）。
- **retry 语义**：claim 发生在 `preStep`（每 step 一次），retry 在 `step` 内部的 while 循环里 —— **retry 不会重新 claim、不会重复注入**。

**【已证实】`systemPrompt.context()`**：
- 只是注册一个 `(context) => string` 提供者（`system-prompt/src/index.ts:467-476`），生命周期绑定注册 fiber（`ctx.effect`），**不写日志、不持久**。
- 每次 `assemble()` 都重新求值（`index.ts:590-597`）；一个 step 只 assemble 一次。
- 求值结果经 `renderContextSections` 过滤空文本后由 `RuntimeContextProjection.project` 变成一条 `UserMessage`（`agent-loop/src/runtime-context.ts:64-75`），`source = {kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt', form:'snapshot', sections}`。
- **持久性与去重**：仅当快照文本与"最近一条仍可见的同源快照"不同才提交（`project` 的 `retained.text === snapshot` 早退，`:67`）；`retained` 由构造期回放 + `session/event` 增量维护（`:34-56`）。已提交的快照是普通 `user/message`，**只能靠替换（replace）或压缩消失**。
- **retry 不重投影**：`project()` 在 `preStep` 调用一次（`agent.ts:242`），step 内每次 retry 都不再执行；因此 retry 携带的是同一份快照文本。

**【已证实】三类注入的 retry/重建矩阵：**

| 注入物 | 生成点 | 本 step 内 retry 是否重建 | 持久性 |
|---|---|---|---|
| system prompt 字符串 | `preStep` 的 `assemble` → `renderPrompt` | **否**（`agent.ts:346` 在 while 外） | 落为 `request/header.system`（仅当 header 变化时新写一条） |
| `assembly.tools` | `preStep` 的 `assemble` | **否**，每次 `buildRequest` **重读同一数组引用**（`agent.ts:353`） | 落为 `request/header.tools` |
| runtime context 快照 | `preStep` 的 `project()` | **否** | 持久 `user/message` |
| `agent/pre-step` 决策消息 | 每 step 一次 | **否** | 持久 `user/message` |
| 工具 `additionalContexts` | 每个 step 的工具提交时 | 属下一次 step，非本 step retry | 持久 `user/message` |
| `request/header` / `request/context` | **每次** `buildRequest` | **是**（按 `headerEquals` / 字段比较决定是否新写） | 持久 |
| `messages` | **每次** `buildRequest` 的 `session.deriveMessages()` | **是**（重新派生，可含新 replacement） | 派生自 surface |

**【待深挖】**`assembly` 对象本身未被冻结：listener 保留引用并在返回后异步改 `assembly.tools` 的元素，会让**同一 step 的后续 retry**读到新 tools（因为 `buildRequest` 每次重读），而 `system` 字串不会——这是 06 文档遗留问题 1 的具体机制，本轮只证实了代码路径，未做实验。

---

## 4. 计量关系：谁进 token-meter，以什么表示（问题 4）

**【已证实】三条计量口径并存：**

| 口径 | 入口 | 含 system | 含 tools | 含 runtime context | 含 Session messages | 含 output |
|---|---|---|---|---|---|---|
| `measure().baseline` | `token-meter/src/index.ts:156,168-171` | ✅ `estimateHeader` | ✅ `estimateHeader` | ❌ 不计入 baseline | ❌（在 `surfaceTokens`） | ⚠️ 仅当 `kind==='usage'`（usage 含 outputTokens，`index.ts:65-70`） |
| `measure().totalTokens` | `:179` | ✅（经 baseline） | ✅ | ✅（作为 surface 节点） | ✅ | ⚠️ 同上 |
| `contextPressure` 投影 | `usage-projection.ts:181-225` | ❌ | ❌ | ✅ 隐含在 `surfaceTokens` | ✅ | ❌ 明确排除（`pressureFrom`，`:77-79`） |
| `contextBreakdown` 投影 | `breakdown-projection.ts:58-87` | ✅ `systemTokens` | ✅ `toolsTokens` | ✅ 混入 `messageTokens` | ✅ `messageTokens` | ❌ |

**【已证实】表示方式与计量公式：**
- `systemTokens = ceil(header.system.length / 4) + ROLE_OVERHEAD(4)`（`estimate.ts:77-80`）。
- `toolsTokens = ceil(JSON.stringify(header.tools).length / 4) + BLOCK_OVERHEAD(4)`（`estimate.ts:87-90`）——**整个 tools 数组的 JSON 长度**，非逐 schema 之和。
- 消息：`estimateMessage = estimateContent(content) + ROLE_OVERHEAD`，文本块 `ceil(len/4)+4`，tool-call 计 name+arguments，tool-result 递归（`estimate.ts:37-70`）。
- `totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`（`index.ts:179`）。
- `pressureTokens = inputTokens + cacheRead + cacheWrite`（无 output）；`projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`（`usage-projection.ts:218-224`）。
- `contextBreakdown.messageTokens` 走 O(1) 影子价格 fold（`breakdown-projection.ts:64-82`）。

**【已证实】runtime context 与各注入在计量里的"可见性"**：
- runtime context 快照**没有独立字段**：它作为普通 `user/message` 混入 `messageTokens` / `surfaceTokens`，**无法从任何投影里单独读出"上下文注入了多少 token"**。
- 固定引导句 `Current runtime context. This snapshot supersedes…`（`system-prompt/src/index.ts:290`）按 4 字符/token 计入。
- `contextBreakdown.systemTokens/toolsTokens` 的来源是**最新一条 `request/header`**（last-wins，`breakdown-projection.ts:67-71`）；header 只在变化时新写，所以这两项是"最近一次实际发送的信封"的估价，而非本请求的即时价。
- `contextPressure.contextWindow` 来自最新 `request/context`（`usage-projection.ts:189-199`）；`contextWindow` 缺失时该字段被**删除**（`:194-197`）。

**【已证实】计量口径的已知偏差源**（01 文档已证事实的直接推论，本轮补充具体入口）：任何插件使 `header`（provider/model/system/tools/config 任一）变化，`request/header` 就会新写一条 → `headerEquals` 失败 → `measure()` 的 usage 锚点失效 → 立即退化到 4 字符/token 启发式（`index.ts:150-162`）。runtime context 的变化**不进入 header**（它是 messages），所以**不会**击穿锚点；相反，system prompt 或 tools 的任何插件改动**每次都击穿**。

---

## 5. tools schema 与 additionalContexts 的生成、排序、去重、重建（问题 5）

**【已证实】schema 生成链：**
- 注册：`ctx.systemPrompt.tools(provider)` 在 tools 构造期注册一次，provider 为 `context => this.wireSchemas(context.scope)`（`core/tools/src/index.ts:825`）。
- `wireSchemas(scope)`（`:972-993`）：`view(scope)` → `visible` 按模式投影。
  - `native`：`[...visible.values()].map(schemaOf(def,false))`，`knownNames = 全部 knownNames`。
  - `ptc`：只保留 `run_code` 一条（`:986-990`）。
  - 其它非 native 模式（SDK）：保留全部并追加 `knownNames` 加 `run_code`。
- `schemaOf` 只投影 `{name, description, parameters}`（`:1247-1258`）；`parameters` 在 collection 阶段被 `structuredClone`（`system-prompt/src/index.ts:564-568`），因此 assembly 里的 tools 是**每次 assemble 新克隆的对象**。
- **排序**：`orderTools`（`system-prompt/src/index.ts:205-219`）；默认（无 `toolOrder` 配置）是**名字典序全排**（`tools.sort(compareToolNames)`，原地排序 `collected`）。
- **去重**：**【未找到】** 任何按 name 去重；重名 schema 会同时出现在请求里。`toolOrder` 对重复配置项抛错（`:187-198`），provider 返回保留名 `<unlisted-tools>` 抛错（`:206-209`），`toolOrder` 含未注册名抛错（`:211-214`）。
- **每次 retry 是否重建**：**不重建**。provider 只在 step 开头的 `assemble()` 里被求值一次；`buildRequest` 每次 retry 只是重读 `assembly.tools` 引用（`agent-loop/src/agent.ts:353`），随后 `canonicalHeader` 把它写进 `header.tools`，再由 `deepFreeze` 冻结进请求（`:535-542`）。**同一 step 的所有 retry 共享同一组 tools 对象。**

**【已证实】additionalContexts 生成与排序：**
- 来源三处：① 工具体 `exec.deferContext(msg)`（`core/tools/src/index.ts:404, 1356-1383`）；② 工具返回结果自带 `result.additionalContexts`；③ `tools/post-execute` 决策的 `additionalContexts`。
- 归并顺序（逐层）：
  1. `dispatchScheduledExecution`：`[...deferredContexts, ...normalized.additionalContexts]`（`:1572-1580`）——**deferred 在前**。
  2. `postExecute`：`[...result.additionalContexts, ...decisionContexts]`（`:1751-1754`）——**结果自带在前，post-execute 决策在后**。
  3. `block` 决策：**丢弃** deferred/result 自带，只保留决策自己给的（`:1739-1746`，语义注释 `:1728-1730` 明确写出）。
- `ptc` 复合调用把子调用的 `additionalContexts` 逐个 `deferContext` 冒泡到外层 `run_code` 结果（`core/tools/src/ptc.ts:562-570`）。
- 去重：**【未找到】** 任何按 id 或文本去重。
- 进入模型历史的路径：`tool-calls.ts:156-157` —— 先 append `tool/result`，**紧接着**把每个 context 交给 `acceptContext` → `inbox.splice('next-step', ...)`（`agent-loop/src/agent.ts:434`）→ 下一 step 的 claimed 批次 → `user/message`。
  - 因此**排序规则 = 本 step 工具调用的模型序 × 单结果内部的三段顺序**；多个并行工具的结果按模型序 `commitReady`（`tool-calls.ts:147-161`）。
  - **跨 step 不去重、不替换**：同一个 context 在多个 step 重复提交就会重复进入 transcript，累积计费。
- retry：工具执行不在 retry 循环内（retry 只重发请求），所以 already-committed 的 `tool/result` 与 additionalContexts **保持**；失败的 `assistant/chunk` 留在日志但不进 surface/不计量（`surface.ts:116-120`）。

---

## 6. 预算、截断、拒绝机制（问题 6）

**【已证实】内核层无任何单项/总量预算、截断或拒绝：**
- system prompt：无长度上限；只有"空文本被丢弃"这一过滤（`system-prompt/src/index.ts:266`）。
- tools：无条数上限、无 schema 体积上限；`orderTools` 抛错的都是**配置错误**（重复项、未注册名、保留名），不是体积限制。
- runtime context：无大小限制；`project()` 只做**文本相等**去重（`runtime-context.ts:67`）。
- additionalContexts：无条数/体积上限。
- `agent/pre-step` 的 `{kind:'reject'}` 是唯一的"拒绝本次 step"机制（`agent-loop/src/agent.ts:276-279` → `turn/end {kind:'blocked'}`），但**内核不施加任何压力条件**；是否拒绝完全由 listener 自定。
- `tools/pre-execute` 的 allow/deny/ask 只作用于**单次工具调用**（06 文档已证），不是上下文预算。
- 【未找到】面向"上下文总量"的拒绝：内核不存在"若 projected > 阈值则拒绝/截断"的分支。

**【已证实】内核只做"检测+报错"，不做主动裁剪**：容量超限由 provider 报错归一为 `CONTEXT_WINDOW_EXCEEDED`，`agent/request-error` 是恢复 seam（00/06 已证）。内核层面唯一的主动缩减机制在 `compaction-*` 包（本轮范围外，不展开）。

---

## 7. output reserve / provider framing 是否在 pre-step 可得、是否计入压力（问题 7）

**【已证实】pre-step 阶段拿不到 output reserve：**
- `maxTokens` 不在 `AgentOptions`→`generate` 的 pre-step 视野里可见为"预留"；它在 `buildRequest` 内由 `agent/request` 的 `LlmCallConfig` 提供，或由 adapter 默认值补齐（`agent-loop/src/agent.ts:467, 478-481, 498-500`）。`preStep`（`:234-252`）**完全不接触** config。
- 因此 pre-step 的所有判定（含 compaction-basic 的阈值判定）都是**纯输入侧**的，没有输出预留参与。

**【已证实】output 在压力口径里被排除：**
- `pressureTokens` / `projectedTokens` 明确排除 output（`usage-projection.ts:77-79, 218-224`）。
- `measure()` 的 `totalTokens` **仅在 usage 锚点生效时**包含 `outputTokens`（`index.ts:65-70, 160-161`）；纯启发式基线 `estimatedAnchorTokens` 只含 `estimateHeader + surface`，不含输出预留。

**【已证实】`contextWindow` 的定义已把输出算进去**：类型注释为 "Maximum combined request and response context in tokens"（`core/session/src/types.ts:239`）。也就是说 **provider 端的 output reserve 是通过分母隐含体现的**，而分子（`projectedTokens`）是纯输入侧 —— 二者口径不完全对称，但 Web 端 `percent = projectedTokens / contextWindow` 因此是"输入占（输入+输出）总容量"的保守读法。

**【未找到】provider framing 的计量**：`estimate.ts` 里只有 `ROLE_OVERHEAD` / `BLOCK_OVERHEAD` 这类固定结构开销；**没有**任何 provider 特化 framing（role 包装、tools 序列化风格、system 分隔符）的计价入口。framing 属 adapter 层，内核不可见。

---

## 8. 多插件冲突与稳定顺序（问题 8）

**【已证实】稳定性的完整来源（按优先级）：**
1. **数据权威**（与监听顺序无关）：`system-prompt/assemble` 的返回值为权威（`index.ts:601-604`）；`complete` section 与 runtime-context 抑制在 waterfall **之后**强制恢复（`:605-610`）。
2. **常量 order**：section 用集中分配常量 + 同 order 按 name 兜底 → 确定性（`:227-229`）；context 仅按 order，**同 order 无兜底**，退化为注册/合并序（`:593`，合并序见 `scope/src/store.ts:208-217`）→ **这是 context 层唯一的确定性缺口**。
3. **tools 名字典序**（或 `toolOrder` 配置序）：确定性且跨机器一致（`:221-224` 注释明确"locale-independent"）。
4. **waterfall 只有 `prepend` 布尔，没有 priority**（06 文档已证）；同一事件的 agent-scoped 与 global listener 都参与。
5. **invariant 用 `{global:true, prepend:true}` 抢最外层**：`system-prompt/src/invariant.ts:51`、`agent-loop/src/invariant.ts:54`，保证关键断言不被短路绕过。

**【已证实】冲突的具体表现：**
- **同名 section**：跨层（全局 vs 作用域）是**覆盖**（合法，如 `deployment:persona`，`index.ts:172` 注释明确这是设计）；同层**抛错**。
- **同名 context**：同上覆盖/抛错。
- **同名 tool schema**：**不去重、不抛错**，两组都会进请求 → provider 端可能报重复工具名。这是本轮新证实的冲突点。
- **runtime-context 抑制**：全局抑制 → 作用域无法翻案；作用域抑制只影响该作用域（`:539-540`）。
- **多个 `complete` section**：直接 assembly 抛错（`:575-577`），turn 以 error 结束。
- **`system-prompt/assemble` listener 抛错**：冒泡到 `preStep` → turn error（06 已证）。
- **实际默认组合的 context 顺序**：`sandbox:policy(110)` → `approval:policy(115)` → `subagent:delegation(120)`；三者都取常量，顺序确定。

---

## 9. 完整"模型请求预算账本"

图中 `Σ` 表示"该部分被计入哪个总量"。计量单位：**估价**=4 字符/token 固定启发式 + 固定结构开销；**实测**=provider usage。

| # | 请求成分 | 组装位置 | 是否持久 | retry 是否重建 | token 计量入口 | 计量性质 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 默认 harness identity section | `system-prompt/src/index.ts:408-414` | 否 | 否 | `estimateSystemTokens`（并入 system） | 估价 | 常量字符串 |
| 2 | 插件 sections（含 `complete` 覆盖） | `index.ts:573-587` | 否 | 否 | 同上 | 估价 | 空文本被丢弃 |
| 3 | 变量插值 | `renderPrompt` `:263-268` | 否 | 否 | 同上 | 估价 | 插值后长度才计价 |
| 4 | **system 最终串** | `agent.ts:346` → `header.system` | ✅（`request/header`） | **否** | `estimateSystemTokens` `estimate.ts:77-80` | 估价 | 无上限、不截断 |
| 5 | tool schemas | `tools/src/index.ts:972-993` → `index.ts:598` | ✅（`header.tools`） | **否**（同 step 共享） | `estimateToolsTokens` `estimate.ts:87-90` | 估价 | 整数组 JSON/4；无去重、无上限 |
| 6 | `contexts` → runtime context 快照 | `runtime-context.ts:64-75` → `agent.ts:291-293` | ✅ `user/message` | 否 | 混入 `messageTokens` / `surfaceTokens` | 估价 | **无独立字段**，只按文本相等去重；**历史行不被遮蔽，逐次累积** |
| 7 | `agent/pre-step` 决策消息（含 steer/inject/time-context） | `agent.ts:291-293` | ✅ `user/message` | 否 | 同上 | 估价 | 顺序：claimed → runtime context |
| 8 | 工具 `additionalContexts` | `tools/index.ts:1572-1580,1751-1754` → `tool-calls.ts:157` | ✅ `user/message` | 属下一步 | 同上 | 估价 | 三段内部序；无去重 |
| 9 | Session 历史（user/assistant/tool-result） | `session/src/index.ts:790-811` | ✅ surface | **是**（重派生） | `estimateMessage` + 逐节点 fold | 估价（或 usage 锚点差额） | 唯一能被 `replace` 缩减的部分 |
| 10 | `request/header` | `agent.ts:498-518` | ✅ | **是**（按需） | —— 间接决定 #4/#5 价 | 元数据 | 变化即击穿 usage 锚点 |
| 11 | `request/context.contextWindow` | `agent.ts:521-532` | ✅ | 是（按需） | 不进分子，只作分母 | 元数据 | 含 output 容量的**总**窗口 |
| 12 | provider framing（role 包装、tools 序列化、system 分隔） | adapter 层 | — | — | **未计量/不可见** | — | `estimate.ts` 无入口 |
| 13 | 图片 route pricing 差额 | `surface-fold.ts:50-75` + `route-pricing.ts` | — | — | `tokens` vs `heuristicTokens` 双价 | 实测/估价并存 | 仅路由声明图片价时有差 |
| 14 | **output reserve（输出预留）** | `agent.ts:467,498`（`maxTokens`） | ✅（header.config） | 是（按需） | **未计量** | **不可见** | pre-step 拿不到；`pressureTokens` 明确排除 output |
| 15 | 失败尝试的 `assistant/chunk` | `agent.ts:368` | ✅ 日志 | 每次 retry 新增 | **不计入**（非 surface，`surface.ts:116-120`） | 不计费 | 普通 error finish **不**写 `assistant/message`（`:390-407` 直接 continue/throw）；仅 aborted 分支写 `interrupted:true` 的消息（`:373-388`） |
| 16 | 报告用量 `assistant/message.usage` | `agent.ts:418-427` | ✅ | 每次迭代 | 锚点：`baseline.kind='usage'` | 实测 | 仅当 header 严格匹配且 `usageTokens >= estimatedAnchor` |

**总量公式：**
- 精确/保守决策口径：`totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)`；`baseline = usage ? usageTokens : estimateHeader(header) + anchorSurfaceTokens`。
- 观察口径：`projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`（不含 output）；`contextBreakdown = systemTokens + toolsTokens + messageTokens`（三者同源估价，可与 `measure()` 的启发式口径对齐）。

---

## 10. 落地决策事实

1. **唯一"每步一次"的注入窗口是 `system-prompt/assemble`（step 开头，先于 `agent/pre-step`）**；retry 不会重跑它，所以想影响 retry 只能改 messages（surface/replacement），不能改 system。
2. **runtime context 是"文本级 supersede"，不是"行级遮蔽"**：旧快照永远留在 transcript 里累积计费，只有文本完全相同时才不新增。要控制长期体积，必须走 `session.append(..., {surfaceOp:'replace'})` 或压缩。
3. **system/tools 的任何变化都会写新 `request/header` 并使 provider usage 锚点失效**（→ 退化为 4 字符/token 低估）。把动态内容放进 `contexts`（messages）而不是 `sections`/`tools` 是保住锚点的关键。
4. **tools 没有去重**：多个 provider 贡献同名 schema 会原样都发出去。
5. **`contexts` 同 order 无 name 兜底**：新 context 的 order 要避开 110/115/120，否则顺序取决于注册时刻。
6. **内核没有上下文预算/截断/拒绝**：任何"预算"必须由插件在 `agent/pre-step` 或 `agent/request-error` 自行实现；`{kind:'reject'}` 是现成的拒绝出口。
7. **pre-step 看不到 output reserve**：只做输入侧判定；`contextWindow` 是含输出的总窗口，因此"输入/总窗口"的比值天然保守。
8. **tools/contexts 都可以在 scope 层覆盖（同名）或抑制（`suppressRuntimeContext`）**；全局抑制不可被作用域撤销。
9. **可计量的最细粒度是"每个 surface 节点"**（`measure().nodes[].{tokens,heuristicTokens,seq}`），但没有"按来源分类"的字段 —— runtime context / 插件注入 / 用户输入在计量上不可区分（唯一线索是 `user/message.source`，而 token-meter 不读 `source`）。

## 11. 遗留问题

1. **【待深挖】** `assembly` 未冻结：listener 保留引用并在返回后异步改 `tools` 数组元素时，同 step 后续 retry 会读到新 schema（`system` 不会）。需最小实验确认。
2. **【待深挖】** 两个 provider 返回同名 tool schema 时，provider adapter 的实际行为（是否报错/后者覆盖）未核验——内核确认不去重。
3. **【待深挖】** `contexts` 同 order 时"合并序"在真实 profile 下是否稳定：`ScopedLayers.merge` 用 Map 覆盖保留首次插入位置（`store.ts:212-216`），仅"新增 name"才追加到尾部，因此同一部署内稳定，但**跨 reload/注册顺序变化会变**。
4. **【待深挖】** `messageTokens` 在 shadow-price 缺失时会漂移（01 文档已证），而这正是 runtime context 反复追加导致 `replace` 场景增多的路径——`projectedTokens` 在该场景下的偏差量级未量化。
5. **【未找到】** 任何"上下文预算"或"注入体积上限"的内核机制；如果部署层有，只能在 `agent/pre-step` / `agent/request-error` 的 listener 里找到（本轮范围外）。
6. **【未找到】** provider framing 的计量入口；`estimate.ts` 只计内容与固定结构开销。
7. **【待深挖】** `systemPrompt.assemble` 在非 agent 上下文（诊断/测试）下 `context.agent === undefined`，此时 sandbox/approval 的 context 文本渲染为空（`sandbox-policy/src/index.ts:144-148`、`user-approval/src/index.ts:159-163`）——对真实 agent 请求无影响，但诊断 assembly 的计价与真实请求不等价。
