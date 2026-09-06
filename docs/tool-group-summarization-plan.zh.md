# 连续工具组语义要点化实施方案

状态：已确认，作为后续实现基线。

关联设计：`压缩方案3.md`。本方案采用方案 A：先对满足条件的旧连续工具组进行一次 LLM 语义要点化，再对未处理或处理失败的旧工具结果执行确定性裁剪，最后在仍然超限时执行遗忘区语义压缩。

## 1. 目标

为主线程压缩链增加连续工具组的语义摘要能力，同时保留当前实现已经验证的以下性质：

- 近期上下文保持高保真；
- 原始 Session events 不被删除；
- replacement 可以通过 source references 回到原始消息；
- Session reload 后可以重建相同 surface；
- LLM 摘要失败时可以退回确定性 tool-result-pruner；
- 摘要、裁剪和全局 compaction 互不破坏官方 transaction model；
- 同一工具组不会因为重复触发或进程恢复而无限重复调用模型。

## 2. 最终压缩链

```text
当前 Session surface
    |
    +-- 保护近期区域
    |
    +-- 选择旧连续工具组
    |
    +-- 一次 LLM 调用生成组级要点
    |       |
    |       +-- 成功：按原始 tool/result 节点生成 replacement
    |       +-- 失败：该组进入确定性裁剪
    |
    +-- tool-result-pruner 处理剩余旧工具结果
    |
    +-- 重新测量
    |
    +-- 仍超限：compaction-basic 执行遗忘区语义压缩
```

方案 A 的关键顺序是：先根据估算选择候选组，不先破坏性裁剪；候选组完成 LLM 摘要后，再对剩余内容执行确定性 pruner。

## 3. 组件边界

新增 `tool-group-summarizer` 内部能力，第一版不立即冻结为公共 export。

它负责：

1. 从当前 surface 发现连续工具组；
2. 排除近期保护区；
3. 按收益阈值选择候选组；
4. 构建组级模型输入；
5. 进行一次 auxiliary LLM 调用；
6. 校验结构化输出和来源；
7. 为组内每个 tool/result 生成 replacement；
8. 记录 source references 和幂等 fingerprint；
9. 在任何失败路径上交给 deterministic pruner。

`tool-result-pruner` 继续负责确定性 head/marker/tail 裁剪，不承担语义解释和模型调用。

## 4. 工具组模型

工具组优先使用已有的 `tool-pairing` 和 `tool-segments` 能力，不重新创建独立的 Session 解析器。

```ts
interface ToolGroup {
  sourceSeqs: readonly SessionSeq[]
  toolResultSeqs: readonly SessionSeq[]
  callIds: readonly ToolCallId[]
  startSeq: SessionSeq
  endSeq: SessionSeq
  estimatedTokens: number
  startPosition: number
  endPosition: number
}
```

边界判断依次使用：

1. 相同 turn、step、task 或 transaction；
2. 明确的 tool-call/tool-result 配对；
3. 当前 surface 中的连续位置；
4. 中间没有非工具内容打断；
5. 父子调用关系和输入输出依赖；
6. 时间连续性作为辅助条件。

无法可靠确定边界时拆成较小组，不强行合并不相关的工具调用。

所有范围判断基于当前 surface 位置，不使用裸 seq 数值区间。surface replacement 后 seq 数值可能不再单调。

## 5. 触发条件

组级摘要只处理近期保护区之外的内容。

建议的初始配置：

```yaml
toolGroupSummarizer:
  enabled: true
  minGroupResults: 2
  minGroupChars: 12000
  minGroupTokens: 2000
  maxGroupTokens: 12000
  maxGroupsPerPass: 2
  maxSummaryTokens: 1200
```

配置含义：

- `minGroupResults`：组内最少 tool/result 数；
- `minGroupChars`、`minGroupTokens`：只有潜在压缩收益足够大才调用模型；
- `maxGroupTokens`：限制单次组摘要输入；
- `maxGroupsPerPass`：限制一次压缩的额外调用数量；
- `maxSummaryTokens`：限制摘要输出体积。

小型工具组不调用模型，直接保留或由 deterministic pruner 处理。

## 6. 摘要调用协议

一次 LLM 调用处理完整工具组，输出结构化 JSON。输出按 tool/result 节点拆分，避免把整个工具组压成一个不符合 tool pairing 的伪节点。

```ts
interface ToolGroupSummary {
  version: 1
  groupSummary: string
  items: Array<{
    sourceSeq: number
    callId?: string
    summary: string
    facts: string[]
    files: string[]
    identifiers: string[]
    errors: string[]
    unresolved: string[]
  }>
  groupErrors: string[]
  unresolved: string[]
}
```

模型约束：

- 只能提取输入中出现的事实；
- 不得把计划写成已完成；
- 不得把无错误输出推断成成功；
- 保留精确文件路径、ID、错误串和退出状态；
- 缺失信息保持未知；
- 不得伪造文件、测试结果或调用结果；
- 每个 source seq 必须对应输入中的真实 tool/result。

## 7. Replacement 规则

每个原始 tool/result 生成一个对应 replacement：

```text
tool/result seq 182 -> summary replacement seq 220
tool/result seq 184 -> summary replacement seq 221
tool/result seq 186 -> summary replacement seq 222
```

replacement 必须：

- 保留原始 call id；
- 保留合法的 tool/result message 结构；
- 通过 `sourceEventSeqs` 指向原始 event；
- 只替换当前 surface，不删除原始 event；
- 使用官方 surface replacement 机制；
- 保持 tool-call/tool-result 配对；
- 保留非文本 content block，不能把附件或图片静默丢弃。

文本摘要使用固定、可识别的格式，例如：

```text
[tool group summary]
Goal: ...
Result: ...
Files: ...
Errors: ...
Unresolved: ...
Source event: seq=182
[/tool group summary]
```

## 8. 幂等和持久化

为避免“模型摘要已生成但进程在 replacement 前崩溃”导致重复调用，增加 compaction audit 记录或扩展现有 context-enhancement storage domain。

每条摘要记录至少包含：

- Session lifecycle identity；
- group fingerprint；
- source seqs；
- current surface revision 或 cursor；
- request id；
- provider/model；
- prompt schema version；
- raw model output；
- parsed summary；
- status；
- replacement seqs；
- error information。

状态：

```text
open
success
fallback
failure
```

group fingerprint 至少由以下内容组成：

```text
Session lifecycle
source seqs
call ids
event types
content digest
summary schema version
```

提交前重新检查：

1. Session lifecycle 是否仍然匹配；
2. source seqs 是否仍在当前 surface；
3. 内容 digest 是否仍然匹配；
4. 是否已有 success replacement；
5. surface revision 是否仍然匹配。

不匹配时放弃旧结果，重新读取当前 surface；已有成功记录时直接复用，不再次调用模型。

## 9. 失败降级

所有语义摘要失败都必须降级，不得阻塞主线程：

```text
组级 LLM 摘要
    |
    +-- timeout
    +-- cancellation
    +-- empty response
    +-- invalid JSON
    +-- schema failure
    +-- source mismatch
    +-- fact validation failure
    +-- storage failure
              |
              v
确定性 tool-result-pruner
              |
              v
必要时进入全局 semantic compaction
```

失败时不得：

- 删除原始消息；
- 推进错误 cursor；
- 写入未验证摘要；
- 无限重试；
- 用部分 replacement 冒充完整成功；
- 让旧摘要和新 surface 混合提交。

## 10. 与当前 pruner 的关系

当前 `tool-result-pruner` 保留不变，继续承担低成本确定性缩减：

- 旧区域使用普通 `thresholdChars`；
- 近期区域默认保持原样；
- `hardLimitChars` 只处理异常巨大的近期结果；
- 使用 `compaction/prune` shadow-price event；
- 通过 replacement 和 source references 支持 replay。

新 summarizer 只处理值得进行语义理解的旧工具组。摘要成功的组不再对同一组执行普通裁剪；摘要失败或不满足摘要条件的内容交给 pruner。

## 11. 分阶段实施

### 阶段 1：工具组快照

扩展现有 segment/pairing helper，生成稳定 ToolGroup，不调用模型、不改变当前 surface。

验收：

- 正确发现 tool-call/tool-result；
- 正确处理替换后的非单调 seq；
- 正确排除近期区域；
- 正确处理孤立工具；
- 当前测试保持通过。

### 阶段 2：摘要协议和纯函数

定义 JSON schema、prompt、fingerprint、source validation 和事实白名单校验。

验收：

- 非法 JSON 拒绝；
- 缺失 source seq 拒绝；
- 伪造路径、ID、错误拒绝；
- 缺失组内节点拒绝；
- schema version 可演进。

### 阶段 3：一次组级 LLM 调用

一个工具组只发起一次模型调用，输出多个 item。所有 timeout、取消、空响应和解析失败都回退。

验收：

- 不产生无限重试；
- 失败不阻塞主流程；
- fallback 可测量并留下明确状态。

### 阶段 4：surface replacement

将 item 按原始 tool/result 节点落回，保留 call id、source references 和 replay 语义。

验收：

- 原始 event 仍存在；
- replacement 可 reload；
- tool pairing 不损坏；
- replacement 后可以继续追加工具调用。

### 阶段 5：durable audit 和恢复

加入 group fingerprint、open/success/fallback/failure 和 crash recovery。

验收：

- 模型成功后写入前崩溃；
- 部分 replacement 后崩溃；
- storage write failure；
- Session dispose；
- restart；
- 同组重复触发；
- 摘要期间产生新事件。

### 阶段 6：接入 compaction-basic

将候选组摘要、确定性 pruner、remeasure 和全局 semantic compaction 串联。

验收：

- 摘要成功时不重复全局 compaction；
- 摘要失败时仍能 pruner；
- pruner 后仍超限才调用 semantic compaction；
- 近期结果默认保持高保真；
- hard limit 仍能处理异常大结果。

## 12. 第一版边界

第一版只承诺：

- 旧区域处理；
- 每次最多 1–2 个工具组；
- 每组最多 8–12 个 tool/result；
- 结构化文本摘要；
- deterministic fallback；
- source references；
- durable fingerprint；
- replay 和 restart recovery。

第一版不包含：

- 全文归档搜索 UI；
- 跨组语义合并；
- 修改官方 Session event vocabulary；
- 删除原始 Session events；
- 无界并发摘要；
- 每个小工具调用单独发模型请求。

## 13. 验收标准

完成后必须证明：

1. 语义摘要比 head/marker/tail 裁剪保留更多局部因果信息；
2. 摘要中的路径、ID、错误和状态都能回溯到输入；
3. 近期工具结果不会被普通摘要主动修改；
4. 失败会可靠回退到确定性 pruner；
5. 原始消息仍可从 Session event log 回看；
6. reload 后 replacement 和 source references 保持一致；
7. 同一 group 不会重复成功摘要；
8. 新事件不会污染正在处理的快照；
9. compaction 仍保留官方 start/summary/end transaction；
10. 完整测试、typecheck、build、release-check 和隔离 Profile mount 全部通过。
