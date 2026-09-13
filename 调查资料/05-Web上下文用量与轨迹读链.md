# Web GUI 上下文用量与轨迹读链勘察

> 状态：基于 DSH 源码静态追踪，仅验证数据流，不审计显示正确性。
> DSH 源码根目录：`C:\Users\chuxi\Documents\trae_projects\code\deepseek-harness`

---

## Q1：Web 的 used、contextWindow、百分比分别取哪个字段，前端是否二次计算？

**【已证实】**

- `used` = `pressure.projectedTokens`（fallback 到 `pressureTokens`）
- `contextWindow` = `pressure.contextWindow`
- `percent` = `Math.min(100, Math.round(usedTokens / contextWindow * 100))`

前端有**一次**二次计算：百分比是前端乘出来的，不是服务端下发的。

**证据：**
- `packages/client/ui-conversation/src/client/context-occupancy.ts:15-24`
  ```ts
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
  ```
- `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:56-61,88-89` — 调用 `useProjection('contextPressure')` 后使用上述结果渲染圆环。

---

## Q2：数据通过哪个 projection/controller/wire contract/订阅进入客户端，更新时机是什么？

**【已证实】**

**完整链路：**
1. **服务端投影**：`token-meter` 注册 `contextPressure` 投影（`packages/llm/token-meter/src/index.ts:108-110`），监听 Session 事件（`request/context`、`assistant/chunk`、`assistant/message`）并维护 `ContextPressureState`。
2. **控制面广播**：`packages/api/session-controller/src/control.ts:27-35` 订阅 `ctx.sessionProjections.onChanged`，向所有 control stream 客户端发送 `{ type: 'projection', sessionId, key, value, seq }`。
3. **Wire Contract**：`SessionControlFrame` 类型（`packages/api/session-controller/src/types.ts:509-513`）含 `'baseline'` 和 `'projection'` 两个 frame 变体。
4. **客户端 store**：`ProjectionValueStore`（`packages/api/session-controller/src/client/sessions/projection-store.ts:77-199`）维护 per-key `Row { value, seq }`，遵循"高 seq 胜"规则；通过 `seed(baseline)` 初始化，通过 `apply(key, value, seq)` 增量更新。
5. **客户端订阅**：`Session.projections.faceOf(key)` 返回 `ObservableSnapshot<unknown>`，由 `useProjection` hook 消费（`projection-store.ts:34-41`）。
6. **ContextMeter** 在 `InputBar`（`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:468`）中通过 `useProjection('contextPressure')` 读取。

**更新时机：**
- 每次 Session 事件触发投影重算 → `onChanged` 回调 → control stream 推送 `'projection'` frame → 客户端 `ProjectionValueStore.apply()` → React re-render。
- `request/context` 事件更新 `contextWindow`；`assistant/chunk` 或 `assistant/message` 事件更新 `pressureTokens`；`compaction/summary` 等 surface replace 事件更新 `surfaceTokens`。

---

## Q3：缺少 contextWindow、usage 或 estimate 时，UI 如何显示？

**【已证实】**

| 缺失条件 | UI 表现 |
|---------|--------|
| `contextWindow` 缺失 | `contextOccupancy()` 返回 `null` → `ContextMeter` 返回 `null`，**整个组件不渲染**（`ContextMeter.tsx:87`） |
| `projectedTokens` 和 `pressureTokens` 均缺失 | `usedTokens === undefined` → `null` → 不渲染 |
| 只有 `pressureTokens` 无 `projectedTokens`（新会话首次请求前） | 使用 `pressureTokens` 作为 `usedTokens`，若有 `contextWindow` 则正常显示 |

**证据：** `context-occupancy.ts:18-19` — 任一缺失即返回 `null`；`ContextMeter.tsx:87` — `if (context === null) return null`。

---

## Q4：页面展示的是当前 surface 估算、最近 provider usage、累计 usage，还是组合字段？

**【已证实】**

展示的是**组合字段**：

- `usedTokens` = `projectedTokens`（首选）或 `pressureTokens`（备选）
  - `projectedTokens` = `pressureTokens + (surfaceTokens - sampledSurfaceTokens)` ① 这是**最新 provider usage 锚点 + 自锚点以来的 surface 差量估算**
  - `pressureTokens` = 最近一次 provider 报告的 prompt 端用量（input + cacheRead + cacheWrite）
- `contextWindow` = 最近一次 `request/context` 事件中记录的模型容量

**本质**：以最近一次 provider usage 为锚点，叠加 surface 变化（含压缩后的 shadow price 扣减）的启发式重定价。不是纯累计，也不是纯单次 surface 估算。

**证据：**
- `usage-projection.ts:78-79,217-224` — `pressureTokens` 公式与 `projectedTokens` 计算
- `projection.ts:30-48` — `ContextPressureProjection` 类型定义及注释说明"独立 last-wins slots"

---

## Q5："上下文已压缩/压缩 N 条/约 N tokens"轨迹文案由哪个事件和字段产生？

**【已证实】**

**轨迹文案来源：**

1. **事件**：`compaction/start` → `compaction/summary` → `compaction/end` 三事件序列
2. **Trajectory 定义**：`packages/client/ui-trajectory/src/client/trajectory-compaction-definition.ts:80-111` 匹配这些事件，构建 `RequestView { purpose: 'compaction' }`
3. **布局渲染**：`packages/client/ui-trajectory/src/client/layout.ts:315-366` 将 `kind: 'compacted'` 的 cell 写入轨迹表
4. **文案**（中文，`locales.ts:172-181`）：
   - `layout.compacting` = `'正在压缩上下文…'` — 运行中
   - `layout.compacted` = `'上下文已压缩'` — 完成且无 summary
   - `layout.compactionFailed` = `'上下文压缩失败'` — 错误
   - `layout.compactionInterrupted` = `'上下文压缩在完成前被中断。'` — 中断
   - 分组标题：`group.compaction` = `'压缩 {seq}'`（`locales.ts:41`）

**具体字段来源（`layout.ts:321-332`）：**
```ts
text: request.status === 'running'
  ? t('layout.compacting')
  : request.status === 'error'
    ? request.error === COMPACTION_INTERRUPTED_ERROR
      ? t('layout.compactionInterrupted')
      : request.error ?? t('layout.compactionFailed')
    : request.summary === undefined
      ? t('layout.compacted')
      : '',
```

**注意**：源码中**没有**"压缩 N 条"或"约 N tokens"的文案**。这些文案可能来自插件或未来扩展。当前代码只产生"上下文已压缩"等固定文案。

---

## Q6：是否存在多个不同 context indicator 或 trajectory 组件，口径是否不同？

**【已证实】**

**context indicator 组件：**
- `ContextMeter`（`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx`）— 唯一一个显示用量百分比的 ring indicator，挂载在 `InputBar` 发送按钮旁。
- `StatsLine`（`packages/client/ui-chat/src/client/chat/StatsLine.tsx:191`）— 明确注释"Context occupancy deliberately lives on the composer's ContextMeter ring, not here"，不显示 context 用量。

**trajectory compaction 渲染：**
- `trajectory-compaction-definition.ts` — 轨迹目标专用，构建 `compaction` kind 节点
- `trajectory-assistant-definition.ts` — Assistant 生命周期定义，不涉及压缩
- Chat 侧也有 compaction 节点定义（`packages/client/ui-chat/src/client/conversation-nodes/compaction.ts`），但轨迹目标只消费 `trajectory-compaction-definition`

**口径差异：**
- ContextMeter 的 `usedTokens` 使用 `projectedTokens`（provider 锚点 + surface delta），而 ACP 的 `usage_update`（`packages/acp/acp/src/updates.ts:97-101`）使用 `meter.measure(session).totalTokens`（包含 outputTokens 的全量）
- 两者计算口径不同：`projectedTokens` 排除 output，`totalTokens` 包含 output

**证据：**
- `acp/src/updates.ts:94-101` — `used: meter.measure(session).totalTokens`，`size: session.requestContext()?.contextWindow`
- `context-occupancy.ts:18` — `usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens`

---

## 供后续代理直接引用的结论摘要

1. **ContextMeter 是唯一 context indicator 组件**，位于 InputBar 发送按钮旁，通过 `useProjection('contextPressure')` 订阅投影；缺 contextWindow 时整组件不渲染。
2. **usedTokens = projectedTokens（首选）**，公式：`Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`，不含 outputTokens。
3. **百分比 = Math.min(100, round(usedTokens / contextWindow * 100))**，在前端计算，服务端只下发原始数值。
4. **数据流**：TokenMeter 投影 → SessionControlController broadcast → ProjectionValueStore.apply → useProjection hook → ContextMeter。
5. **轨迹压缩文案**由 `trajectory-compaction-definition.ts` + `layout.ts` 生成，使用 locale key `layout.compacted` / `layout.compacting` / `layout.compactionFailed`；**没有"压缩 N 条"或"约 N tokens"文案**。
6. **ACP usage_update 与 ContextMeter 口径不同**：前者用 `totalTokens`（含 output），后者用 `projectedTokens`（不含 output）。

---

## 交给其他任务的问题

1. **"压缩 N 条/约 N tokens"文案**在当前源码中未找到，可能来自插件层或尚未实现的 feature；需要检查当前安装的插件或 UI 扩展。
2. **compaction-basic 的影子价格声明时序**：`compaction/summary` 事件携带的 `shadowedTokenCount` 是否在 `replace` 事件前相邻写入，直接影响投影漂移风险（详见 01 文档 Q4）。
3. **contextWindow 缺失场景的具体影响**：首次请求前的 `pressureTokens` 无 `contextWindow` 时无显示；切换模型时可能出现短暂窗口期缺值。
4. **Trajectory 中 compaction cell 的 usage 列**（`attachUsage(cell, request.usage)`）数据来源是 `compaction/summary` 事件的 `usage` 字段，需确认其值是否与 token-meter 投影口径一致。
