# DSH Token 与 Context Pressure 计量域勘察

> 状态：基于 DSH 源码的静态与实现事实核验。
> DSH 源码根目录：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 调查限定：`packages/llm/token-meter/**` 及直接依赖与消费者一层。不审计插件，不修改源码。

---

## 1. 封闭问题回答与源码证据

### Q1: 模型 `contextWindow`/容量从哪里进入 token-meter，缺失时如何处理？
- 【已证实】**进入路径**：
  1. Adapter 在 `LlmRuntime.resolveModelInfo` / `prepareCall` 提供 `LlmModelContext` (`context.contextWindow`)（`packages/llm/llm/src/index.ts:750-774`）。
  2. `ReactLoopAgent` 在请求前构建 `RequestContext`，若与上次不同则向 Session 追加 `request/context` 事件（`packages/core/agent-loop/src/agent.ts:521-532`）。
  3. `token-meter` 的 `contextPressure` 投影监听 Session 事件，遇到 `request/context` 事件时提取 `event.data.contextWindow` 存入投影状态（`packages/llm/token-meter/src/usage-projection.ts:189-199`）。
- 【已证实】**缺失处理**：
  1. 在 `RequestContext` 中 `contextWindow` 为可选字段（`packages/core/session/src/types.ts:240`）。
  2. 在 `contextPressureProjectionDefinition` 中，若缺失则移除状态中的键，对客户端输出的 wire view 也省略该字段（`packages/llm/token-meter/src/usage-projection.ts:194-197, 219`）。
  3. **服务核心接口 `TokenMeter.measure(session)` 完全不接收也不依赖 `contextWindow`**（`packages/llm/token-meter/src/types.ts:22-35`）。容量校验由外部消费者执行（如 `compaction-basic`，若缺失抛出 `TargetPressureConfigError`，`packages/compaction/compaction-basic/src/index.ts:297-303`）。

### Q2: “已用 token”由哪些组成部分构成：surface messages、system prompt、tool schemas、runtime context、输出预留等是否计入？
- 【已证实】`TokenMeter.measure(session)` 的计算构成（`packages/llm/token-meter/src/index.ts:139-183`）：
  - **公式**：`totalTokens = Math.max(0, baseline.tokens + surfaceDeltaTokens)`。
  - **Surface Messages**：**计入**。遍历当前 Session surface 的节点（`user/message`、非空 `assistant/message`、`tool/result`），按消息内容估算（`packages/llm/token-meter/src/surface-fold.ts:63-75, 86-107`）。
  - **System Prompt**：**计入**。通过 `estimateHeader(header)` 计入（`CHARS_PER_TOKEN = 4` + `ROLE_OVERHEAD = 4`，`packages/llm/token-meter/src/estimate.ts:77-80, 97-98`）。
  - **Tool Schemas**：**计入**。通过 `estimateHeader(header)` 计入（JSON 序列化字符数 / 4 + `BLOCK_OVERHEAD = 4`，`packages/llm/token-meter/src/estimate.ts:87-90`）。
  - **Runtime Context**：**计入**。在 `agent.ts:242-248` 中作为 `user/message` 追加到消息历史中，作为 surface 节点被计入。
  - **输出预留（maxTokens）**：**不计入**。源码中没有任何关于 `maxTokens` 的占位或预留扣减。但 provider usage 中实际产生的 `outputTokens` 会计入 `baseline`（若为 usage 基线）和 `tokenUsage` 投影。
- 【已证实】`contextPressure` 投影构成（`packages/llm/token-meter/src/usage-projection.ts:78-79, 217-224`）：
  - `pressureTokens` 仅为 Prompt 端用量：`inputTokens + cacheReadTokens + cacheWriteTokens`，明确**排除 outputTokens**。
  - `projectedTokens = Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`，表示下一次调用的 prompt 预测值。

### Q3: 计量使用 provider 实际 usage、启发式估算还是混合方式？其优先级和时序是什么？
- 【已证实】**计量方式**：混合方式（Provider Usage Anchoring + Heuristic Delta）。
- 【已证实】**时序与优先级逻辑**（`packages/llm/token-meter/src/index.ts:140-183`）：
  1. **锚点捕获**：当收到 `assistant/message` 且包含 `event.data.usage` 与 `nextHeader` 时，记录 `MeasurementAnchor`，包含当时的 header、表面节点切片 `nodes`、provider 输出估算值 `assistantTokens` 和 `usage`（`index.ts:274-289`）。
  2. **信封严格匹配**：调用 `measure()` 时，必须满足当前有效 `requestHeader` 与 `anchor.header` 完全一致（`optionalHeaderEquals`）。若发生模型、参数、System、Tools 等任何变更，**立即降级为全启发式估算**（`baseline.kind = 'estimated'`）。
  3. **保守阈值检验**：即使 Header 匹配，必须满足 `usageTokens(usage) >= estimatedAnchorTokens`（即实际 usage 不低于启发式计算的锚点值），才会采用实际 usage 作为基线（`baseline.kind = 'usage'`）；否则依然回退为全启发式估算（`index.ts:160-162`）。
  4. **表面差量累加**：在 baseline 之上，加上当前 surface 相比锚点 surface 的重定价差额 `surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens`。

### Q4: replacement/surface 变化后如何重新投影；是否存在 shadow price、重复计量或只按事件累计的机制？
- 【已证实】**双轨制实现事实**：
  1. **服务主线 `TokenMeter.measure()`（基于位置重算的单例状态机）**：
     - 在内存中维护 `MeterSurfaceNode[]`（`packages/llm/token-meter/src/surface-fold.ts:86-121`）。
     - 遇到 `replace` 事件（带 `start`、`end`），精确定位切片范围，精确减去被替换节点的 `heuristicTokens`，拼接新节点。**不依赖 shadow price，完全由 surface 节点状态重新聚合，不存在重复计量或累加漂移**。
  2. **投影主线 `contextPressure` 与 `contextBreakdown`（O(1) 纯增量 fold）**：
     - 为满足检查点持久化必须 O(1) 的约束，不维护节点数组，仅维护数字总额（`packages/llm/token-meter/src/surface-projection.ts:1-18`）。
     - **严格依赖 Shadow Price Protocol（影子价格协议）**：
       - 压缩或裁剪组件在追加 `replace` 事件的前一刻，必须先追加 `compaction/summary` 或 `compaction/prune` 事件，声明 `shadowedRange` 和 `shadowedTokenCount`（`packages/compaction/compaction-basic/src/region.ts:457-467`；`packages/compaction/compaction-tool-result-pruner/src/index.ts:162-173`）。
       - `foldSurfaceProjection` 捕捉该 claim。紧随其后的 `replace` 消费该 claim，使 `deltaTokens = newTokens - claim.tokens`。
       - **降级机制**：若 `replace` 前无相邻 claim（`claim === undefined`），为保证旧日志回放不报错，**`deltaTokens` 强制记为 0**（`packages/llm/token-meter/src/surface-projection.ts:86-90`）。**在此场景下，旧消息 token 不会被扣减，投影确实会退化为“只按事件累计”并发生漂移**。

### Q5: context pressure、水位或 breakdown 的数据结构、计算公式、发布事件/服务 API 和直接消费者是什么？
- 【已证实】**核心数据结构**：
  - `TokenMeasurement`（`packages/llm/token-meter/src/types.ts:22-35`）：`{ logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }`。
  - `ContextPressureProjection`（`packages/llm/token-meter/src/projection.ts:30-48`）：`{ pressureTokens?, projectedTokens?, contextWindow? }`。
  - `ContextBreakdownProjection`（`packages/llm/token-meter/src/projection.ts:59-66`）：`{ systemTokens, toolsTokens, messageTokens }`。
  - `TokenUsageProjection`（`packages/llm/token-meter/src/projection.ts:13-18`）：`{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`。
- 【已证实】**计算公式**：
  - `totalTokens = Math.max(0, baseline.tokens + surfaceDeltaTokens)`。
  - `pressureTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)`。
  - `projectedTokens = Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`。
  - `contextBreakdown`: `systemTokens = estimateSystemTokens(header)`，`toolsTokens = estimateToolsTokens(header)`，`messageTokens = messageTokens + fold.deltaTokens`。
- 【已证实】**服务 API 与发布链路**：
  - API：`ctx.tokenMeter.measure(session, requestHeader?)`，`ctx.tokenMeter.estimateMessage(message)`。
  - 投影注册：`TokenMeter` 注册到 `ctx.sessionProjections`（`packages/llm/token-meter/src/index.ts:108-110`）。
  - 控制面广播：`packages/api/session-controller/src/control.ts:27-35` 监听 `sessionProjections.onChanged`，向 Web / 远程客户端发送 `{ type: 'projection', sessionId, key, value, seq }`。
  - ACP 更新：`packages/acp/acp/src/updates.ts:88-102` 在 `assistant/message` 时读取 `meter.measure(session).totalTokens` 发布 `usage_update`。
- 【已证实】**直接消费者**：
  - `compaction-basic`: 在 `compactIfNeeded` 中调用 `meter.measure(agent.session)` 与阈值比对；并在执行 summary 准备时切片 `nodes` 计算 `shadowedTokenCount`（`packages/compaction/compaction-basic/src/index.ts:268, 305`；`region.ts:346-361`）。
  - `compaction-tool-result-pruner`: 调用 `ctx.tokenMeter.estimateMessage(...)` 构造 prune 影子价格（`packages/compaction/compaction-tool-result-pruner/src/index.ts:165`）。
  - `api/session-controller`: 消费投影并推流至客户端（`control.ts:27-35`）。
  - `client/ui-conversation`: 消费 `contextPressure` 渲染水位指示器（`packages/client/ui-conversation/src/client/context-occupancy.ts`）。

### Q6: 哪些关键量可能采用不同统计口径？
- 【已证实】源码中明确存在以下 5 类口径分歧：
  1. **全量已用 vs 提示词压力（Output 包含与否）**：
     - `TokenMeter.measure().totalTokens`：包含 baseline 中的 `outputTokens`（若为 usage 锚点）。
     - `contextPressure.pressureTokens` 与 `projectedTokens`：明确只包含输入与缓存，排除 `outputTokens`。
  2. **启发式估算（Heuristic）vs 提供商账单（Provider Usage）**：
     - 启发式按 `CHARS_PER_TOKEN = 4` 计算，源码明确注释该算法对 CJK 字符和 JSON Schema 会系统性严重低估（`projection.ts:54-56`, `README.md:147`）。
     - 任何信封变更（更换模型/修改 tools）都会立即导致基线退化为启发式估算。
  3. **模型图像路由计价（Route-Priced）vs 通用启发式（Fixed Heuristic）**：
     - `TokenSurfaceNode.tokens`：若 adapter 声明了图片定价则计入视觉 token（`route-pricing.ts:61`）。
     - `TokenSurfaceNode.heuristicTokens`：按结构 JSON 字符数 / 4 估算。
     - **分歧点**：`shadowedTokenCount` 强制使用 `heuristicTokens`，而 compaction 的压缩触发与缩减判断使用的是 `tokens`（`region.ts:356-361`）。
  4. **精确重算（O(surface)）vs 影子协议扣减（O(1)）**：
     - `measure()` 通过节点列表做真实差量计算。
     - 投影流如果未收到相邻的 `compaction/*` 事件，replace 操作扣减为 0，两者发生偏离。
  5. **单轮用量多尝试聚合口径（`deriveTurnTokenUsage`）**：
     - Step 内因重试（`llm/retry-started`）产生的多次请求，按尝试累加计费（`turn-usage.ts:213-220`）；而普通的流式 `assistant/chunk` usage 会被最终的 `assistant/message` usage 原地覆盖替换（`usage-projection.ts:145-155`）。

---

## 2. 供后续代理直接引用的结论摘要

1. **Token 计量存在“双轨制”**：
   - 决策轨（`TokenMeter.measure`）：维护内存节点数组，基于 Anchor + Heuristic Delta 计算，O(surface) 复杂度，无累加漂移，供 `compaction-basic` 的决策与执行使用。
   - 观察轨（`SessionProjection`）：为持久化缓存维持 O(1)，依赖 `compaction/summary` 和 `compaction/prune` 的影子价格协议（Shadow Price）。缺失 claim 时 delta 降级为 0。
2. **压力触发与水位计算分离**：
   - `TokenMeter.measure()` 不感知 `contextWindow`，只返回 `totalTokens`。
   - `compaction-basic` 自行向 `ctx.llm.resolveModelInfo` 查询 `contextWindow`，并以 `totalTokens >= Math.floor(contextWindow * thresholdRatio)` 判断压缩。
3. **已用量未预留 output**：
   - 运行中不计算 `maxTokens` 预留。
4. **信封变化直接导致 Provider Usage 锚点失效**：
   - 只要 `requestHeader`（包含 provider/model/system/tools/config）发生变化，`measure()` 立即丢弃 provider usage 锚点，完全退化为启发式估算（以 4 字符/token 计价，CJK 严重偏低）。

---

## 3. 仍需交给其他独立任务的问题

1. **Compaction 决策与执行时机**：`compaction-basic` 在 `agent/pre-step` 触发压缩后，工具执行历史（`tool/result`）未被及时纳入压缩范围的具体时序。
2. **Web 端上下文水位（Pressure 区间）渲染与触发**：前端 `ui-conversation` 如何使用 `contextPressure` 与模型元数据计算百分比区间，是否存在展示层与内核决策层的口径不同步。
3. **插件拦截对 requestHeader 的影响**：插件在 `systemPrompt` 或 `agent/request` 注入动态内容导致 header 频繁变动时，是否会频繁击穿 provider usage 锚点回退到低估的启发式模式。
