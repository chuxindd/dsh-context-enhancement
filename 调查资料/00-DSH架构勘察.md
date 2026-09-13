# DSH 架构级轻量勘察

> 状态：初步架构地图。仅记录已直接核验的源码结论；未完成内容不得视为已证实。
> DSH 源码：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`
> 调查方式：只读；未修改 DSH，未启动服务器。

## 1. 已证实的架构概览

- DSH 是 monorepo。根 `package.json:11-18` 与 `pnpm-workspace.yaml:1-14` 定义 `vendor/*`、`packages/*/*`、`native/*`、`apps/*`、`website`。
- 产品应用主要是 `apps/cli`（`dsh` bin）和 `apps/web`；核心包覆盖 agent/session/system-prompt/tools、llm、session persistence、compaction、client、host/api/bundle、goal/todo 等领域。
- 启动组合为：CLI → profile patch stack → Cordis Loader 插件树。profile、user、home、CLI overlays 依次叠加。
- `Session` 是 append-only event log。模型可见历史并非原始日志，而是事件上的 `surfaceOp` 折叠结果。
- 普通消息追加；摘要和裁剪通过 replacement 节点遮蔽旧 surface；原始事件仍保留。
- `ReactLoopAgent` 每 turn/step 从 Session 派生消息，并实时组装系统提示、runtime context、工具 schema，随后调用 LLM；流块、assistant message、usage 和工具结果均写回 Session。
- `LlmRuntime` 管理 provider/adapter 注册；`prepareCall` 绑定具体模型信息、默认参数、`contextWindow` 和 adapter dispatch，再经 `llm/stream` waterfall。
- `SessionPersistence` 抽象保存 Header 与连续事件。JSONL backend 通过 coordinator 订阅 `session/created`、`session/event`，write-behind 批量 fsync；加载过程恢复完整前缀并处理 crash-orphaned turn。
- 已证实的核心插件介入面包括：`system-prompt/assemble`、`agent/pre-step`、`agent/request`、`agent/request-error`、`llm/stream`，以及 tools 的 pre/around/post/result waterfalls。

## 2. 关键数据流

### 2.1 启动

`apps/cli/src/bin.ts:24-34`
→ `profile-boot.ts:156-172` 合并 bundle/profile/home/CLI/telemetry patches
→ `runProfile:209-306`
→ `app-boot boot():772-819` 创建 Cordis Context、安装 Loader、mount root Include、等待 entry 激活。

### 2.2 一轮 Agent 对话

外部 `agent.followup/steer`
→ Inbox
→ `ReactLoopAgent.turn():255-339` 追加 turn/step/user 事件
→ `preStep():234-252` 调用 `systemPrompt.assemble` 并追加 runtime context
→ `step():341-438` 获取 `session.deriveMessages()`
→ `buildRequest():444-544` 记录 request/header 与 request/context，构建冻结的 `GenerateOptions`
→ `preparedCall.stream` / `llm.stream`
→ provider adapter
→ chunks、usage、最终 assistant message 入日志
→ 执行 tool calls 并记录结果
→ turn end。

### 2.3 历史重建

`Session.append()` 校验并提交事件
→ `SurfaceManager` 应用 append/replace
→ `Session.deriveMessages():790-810` 对当前 surface nodes 调用 `deriveEventMessage`。

进入模型历史的主要内容：`user/message`、非空 `assistant/message`、`tool/result`。turn/step/chunk/request metadata 不进入模型历史。

### 2.4 持久化与恢复

Session 同步发布 `session/event`
→ persistence coordinator write-behind
→ JSONL `appendBatch` / `appendLines`。

恢复时 backend 解析 header 与 contiguous records
→ `Session.fromRestore` 逐事件复用 surface 校验
→ AgentLoop resume。

### 2.5 上下文容量和 overflow

adapter exact-model metadata
→ `LlmRuntime.prepareCall` 暴露 `context.contextWindow`
→ Agent 写 `request/context`。

Provider usage chunk 由 `BlockAssembler` 收集，写入 `assistant/message.usage`。Provider 将典型上下文错误归一为 `CONTEXT_WINDOW_EXCEEDED`；`compaction-basic` 可在 `agent/request-error` 看到该 code 后压缩并请求 retry。

## 3. 关键源码入口

1. `apps/cli/src/bin.ts:24-49` — CLI dispatch。
2. `apps/cli/src/profile-boot.ts:156-172,209-306` — profile/patch 组合和进程生命周期。
3. `packages/boot/app-boot/src/index.ts:501-544,772-819` — Cordis Loader 根树安装与激活。
4. `packages/core/agent-loop/src/agent.ts:234-252,341-438,444-544` — Agent 请求主链。
5. `packages/core/agent/src/runtime-types.ts:224-297` — Agent 生命周期与 waterfall 钩子契约。
6. `packages/core/session/src/types.ts:253-404`、`packages/core/session/src/index.ts:633-719,772-810` — 事件模型、append 与模型历史派生。
7. `packages/core/session/src/surface.ts:21-121,330-410` — surface/replacement canonical fold。
8. `packages/core/system-prompt/src/index.ts:18-38,114-119,388-422` — prompt/context/tools assembly。
9. `packages/llm/llm/src/index.ts:890-935,959-1065` — adapter prepare/stream 调用链。
10. `packages/session/session-persistence/src/index.ts:116-305`、`packages/session/session-persistence-jsonl/src/index.ts:126-217,445-479,689-721` — persistence seam 与 JSONL backend。

## 4. 待深挖或未核验

- `token-meter` 的 contextPressure/contextBreakdown 如何关联 provider usage、heuristic estimate、replacement shadow price，以及如何送达 Web。
- Web GUI trajectory/context usage 的 host controller、wire contract、client store 和 UI 链路。
- goal/todo 的 Session 事件、projection checkpoint、resume/re-arm 和持久化恢复语义。
- compaction-basic 的阈值选择、generation 并发检查和 summary transaction 算法。
- 普通插件是否存在直接修改冻结后的 `GenerateOptions.messages` 的专用 hook。本轮仅证实：正规历史变更路径包括 pre-step 入日志或 surface replacement；`agent/request` 只改配置；`llm/stream` 的实际可变更边界仍需审计。

## 5. 后续可独立调查的领域

1. Token/pressure：限定 `packages/llm/token-meter` 及直接依赖。
2. Web 读链：API session controller、connection/store、trajectory/context indicator。
3. Compaction/replacement：限定 `packages/compaction/*`。
4. Goal/TODO 长期状态：限定 `packages/goal/*`、`packages/todo/*` 及必要直接依赖。
5. 插件可变更边界：横向枚举 Cordis hooks，判断可读写对象、冻结时机和持久性。
6. Provider adapters：对比 serialization、usage、context catalog 与 overflow 归一化。
