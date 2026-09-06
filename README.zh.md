# dsh-context-enhancement

`dsh-context-enhancement` 是 DeepSeek Harness（DSH）的上下文增强插件，归类于
[`dsh-plugin`](https://github.com/topics/dsh-plugin)。它基于
`standard` Agent 模式，新增可跨轮次和重启恢复的任务状态，并替换默认的上下文压缩
实现，在长会话中优先保留近期工作与关键结论，提前缩减较早的工具输出。

适合多步骤、长时间、工具调用密集，或需要中断后继续的开发任务。

> 当前版本：`0.1.5`。兼容 DeepSeek Harness `0.1.2-rc.1`。

## 相比 standard 的变化

`contextual` 保留 `standard` 的编码工具、规划、子代理和工作流能力，仅改变任务连续性
与上下文管理方式。

| 能力 | `standard` | `contextual` |
| --- | --- | --- |
| 编码 Agent 与工具 | 完整提供 | 完整保留 |
| 任务状态 | 依赖当前对话 | 自动提取并持久保存任务事实、决策、约束、风险和后续事项 |
| 服务重启后的任务恢复 | 无独立状态 | 从存储直接恢复，不需要重新调用模型重建 |
| 较早工具输出 | 由默认压缩统一处理 | 在压缩前优先缩减，降低上下文占用 |
| 长对话压缩 | DSH 默认实现 | 优先保留近期工作，再整理较早历史 |

在 Web 会话中，标题栏的 **增强功能** 按钮显示四项运行状态：任务进度记忆、请求上下文
同步、工具结果整理和长对话整理。该面板用于查看状态；详细事件仍在“轨迹”中。

## 安装

### 前置条件

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `0.1.2-rc.1`
- 已配置可用的 DSH 模型提供方
- Web 安装使用 `dsh --profile web`

### 从 GitHub Release 安装

安装固定 tag，避免后续提交改变当前部署：

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.5'
dsh --profile web
```

打开 `http://127.0.0.1:8080`，新建会话并选择 **上下文增强**。插件会保留
`standard`、`minimal`、`ptc` 和 `cordis` 等原有模式，同时将 `contextual` 注册为默认
模式。

### 从本地源码安装

适合开发、调试或尚未创建 Release 时使用：

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run build
npm pack
dsh plugin --profile web add "file:$PWD/dsh-context-enhancement-0.1.5.tgz"
dsh --profile web
```

在 Windows PowerShell 中，如果 DSH CLI 不接受含 `/` 的相对路径，请传入 tarball 的
绝对路径。

### Desktop 兼容步骤

Desktop 启动器会重建 Agent preset 的发现目录，因此安装 Bundle 后还需要把
`contextual` preset 写入用户目录。在本仓库或解压后的源码目录执行：

```powershell
pnpm run install:desktop-preset
```

默认写入 `%DSH_HOME%\.agent-presets\contextual`；未设置 `DSH_HOME` 时使用
`%USERPROFILE%\.dsh\.agent-presets\contextual`。如果已有同名 preset，脚本会拒绝覆盖；
确认需要替换时执行：

```powershell
pnpm run install:desktop-preset -- --force
```

## 使用与验证

1. 启动 Web profile，打开或新建会话。
2. 在 Agent 选择器中选择 **上下文增强**。
3. 正常执行任务；任务状态与上下文整理均自动运行，不需要手动维护。
4. 点击会话标题栏的 **增强功能** 查看各能力是否启用及本会话触发次数。
5. 打开“轨迹”查看压缩、裁剪等详细事件。

任务状态达到事件阈值后异步更新，因此刚创建的会话可能显示“本会话尚未触发”。这不代表
能力未启用。

## 工作原理

本 Bundle 把长会话处理拆成两条并行链：

1. **主线程压缩链**：直接改变下一次模型请求所看到的 Session surface，逐步降低历史内容的粒度，控制上下文水位。
2. **Checkpoint 旁路链**：独立收集任务进展，生成可在后续请求中读取的持久任务状态，不把状态整理阻塞在主 Agent 的压缩调用里。

### 一、主线程压缩链

主线程压缩不是等窗口耗尽后只做一次“大总结”，而是按风险从低到高处理：

```text
按当前 surface 尾部位置和 token 年龄划分
      │
      ├─ 近区（模型容量 0-20%）：完整保留当前现场
      ├─ 工具区（20-50%）：工具要点化或原始大结果确定性裁剪
      └─ 遗忘区（>50%）：从最老端选择有界安全语义压缩批次
```

#### 1. 近区保护

`compaction-basic` 按目标模型容量及当前 surface 位置划分三区：近区为 0-20%，工具区为 20-50%，遗忘区为 50% 以前的历史。普通维护不会跨区：近区不处理，工具区只进行工具要点化或原始结果裁剪，语义压缩只处理遗忘区。

所有边界都按当前 surface 的位置判断，而不是假设 Session seq 连续。工具调用与工具结果必须处于完整、平衡的 step/segment 内；如果范围从工具组中间切过，宁可跳过该组，也不截断调用链。

#### 2. 工具组摘要

当旧区域中存在满足阈值的连续工具组时，`tool-group-summarizer` 会：

- 将同一完整工具 segment 内的调用、结果和关联事件作为一个组处理；
- 根据结果数量、字符数、估算 token 数、单组上限和每轮组数筛选候选；
- 对每个组发起一次 `purpose: compaction` 的结构化 JSON 模型调用；
- 要求输出覆盖所有 source seq 和 callId，并只保留输入中出现的事实、路径、标识符、错误和未解决项；
- 校验 schema、来源覆盖和 source-grounded claims 后，为每个原始 tool/result 节点追加独立 replacement；
- replacement 保留原消息元数据和 `sourceEventSeqs`，原始事件不删除，后续仍可沿来源定位。

摘要提交前会重新检查 Session lifecycle、surface generation 和 source nodes 是否稳定。模型路由失败、流失败、空输出、JSON/schema 错误或来源校验失败时，不阻塞主会话，而是记录 fallback/failure 并交给确定性裁剪继续处理。

摘要审计使用独立的 `context_enhancement_tool_group_summary` storage domain，记录 `open/success/fallback/failure` 生命周期、fingerprint 和内容 digest。已有成功 fingerprint 会跳过重复模型调用；未完成的 open 记录会复用 request id，避免重启后重复创建同一请求。

#### 3. 确定性裁剪

工具组摘要完成后，`tool-result-pruner` 会基于**最新 surface**重新计算工具区，只处理由 replacement 来源索引确认的原始大结果；已生成的工具要点不会被扫描或依赖文本标记再次裁剪。若配置硬上限，近区中异常大的原始结果仍可被限制。它保留头尾、结构和必要元数据，摘要失败时是主链的确定性 fallback。

这里的“摘要”和“裁剪”职责不同：摘要保留结构化语义，裁剪只做可预测的体积缩减。两者都不会删除原始 Session 事件，而是通过 surface replacement/shadowing 改变后续模型请求看到的内容。

#### 4. 旧历史语义压缩

如果工具组摘要和确定性裁剪后仍超过目标模型阈值，`compaction-basic` 才选择满足工具调用配对和 step 边界的更早历史区域，调用官方兼容的语义 compaction，并重新测量结果。压缩有有限重试次数；若没有安全的可压缩范围或无法收敛，则显式报告失败，不把未平衡的工具链硬切开。

`context-overflow` 是单独的紧急路径：先执行全表确定性裁剪，再进行一次可推进 surface 的 compaction，用于恢复本次请求，而不是改变普通 pressure 路径的近期保护策略。

### 二、Checkpoint 旁路链

`task-state-basic` 在后台消费 Session 事件，到达配置的事件阈值后使用独立模型调用生成结构化候选状态。候选结果经过 schema、大小、数量和语义约束校验后，才提交为该 Session lifecycle 的稳定记录。

`task-state-prompt` 在后续模型请求开始前读取最近一次已提交的稳定状态，限制在 `maxBytes` 内注入。没有稳定状态时不注入占位内容；后台更新失败也不会阻塞主 Agent 当前工作。

Checkpoint 当前包含：

- 已确认事实、决策、约束和风险；
- 证据引用、TODO 引用和继续执行信息；
- source cursor、revision、digest 等提交边界。

任务状态和主线程压缩的边界如下：

| 维度 | 主线程压缩链 | Checkpoint 旁路链 |
| --- | --- | --- |
| 目标 | 控制当前请求的上下文体积和噪声 | 保存可持续读取的任务全局状态 |
| 是否替换 Session surface | 是，通过 replacement/shadowing | 否，只写独立 storage domain |
| 是否删除原始事件 | 否 | 否 |
| 更新失败时 | fallback 到确定性裁剪或报告压缩失败 | 保留上一份稳定状态，主任务继续 |
| 主要实现 | `compaction-basic`、`tool-group-*`、`tool-result-pruner` | `task-state-basic`、`task-state-prompt` |

任务状态审计和工具组摘要审计都位于独立 storage domain，不新增 DSH `SessionEventMap` 事件，因此卸载插件或切回官方 preset 时，普通 Session 日志仍可被官方运行时读取。

`standard` 仍使用 DSH 官方压缩实现；只有 `contextual` preset 挂载本 Bundle 的压缩和任务状态组合。卸载 Bundle 后，官方组合恢复，已保存的任务状态和 Session 日志不会被插件删除。

## 配置

Bundle 默认配置位于 `cordis.patch.yml`，可在 profile/home patch 层覆盖。覆盖 `config`
时需要提供完整配置，而不是只写变化字段。

### 任务状态 provider

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `provider` / `model` | `deepseek-official` / `deepseek-v4-flash` | 后台任务状态更新使用的模型路由 |
| `minEvents` | `20` | 已提交位置之后，自动启动一次更新所需的最少事件数 |
| `maxEvents` | `200` | 单次更新最多处理的事件数 |
| `maxInputBytes` | `60000` | 单次结构化输入的 UTF-8 字节预算 |
| `maxOutputTokens` | `4000` | 单次后台生成上限 |
| `timeoutMs` | `120000` | 单次请求超时 |
| `maxInfraRetries` | `2` | 瞬时基础设施错误的额外重试次数 |
| `maxEntriesPerKind` | `50` | 每类事实、决策、约束和风险的上限 |
| `maxEntryBytes` | `4000` | 单条状态记录的字节上限 |
| `maxListItems` | `40` | 单个列表字段的条目上限 |

`task-state-prompt` 的 `maxBytes` 默认是 `8000`，用于限制注入请求上下文的状态大小。

### 上下文压缩

`contextual` 继承 DSH 官方配置字段，包括 `thresholdRatio`、`retainRatio`、
`retainTokens`、`summarizationProvider`、`summarizationModel`、`maxTokens`、
`compactionRetries`、`maxOverflowRetries`、`modelPolicies` 和 `auto`。

工具输出缩减使用 `thresholdChars`、`headChars` 和 `tailChars`。修改阈值前建议先通过轨迹
观察真实会话；阈值过低会增加处理频率，保留量过低会损失排查问题所需的原始输出。

## 数据、升级与卸载

任务状态保存在：

```text
$DSH_HOME/storages/context_enhancement_task_state.json
```

普通 Session 继续保存在 `$DSH_HOME/sessions`。插件不会在卸载时删除这些数据。

升级：

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.5'
```

回滚到上一版本：

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.3'
```

卸载：

```powershell
dsh plugin --profile web remove dsh-context-enhancement
```

每次安装、升级、回滚或卸载后都需要重启 profile。卸载会移除 `contextual` 默认覆盖并
恢复官方压缩组合，但不会删除任务状态文件和 Session 日志。

## 本地开发

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

仓库提交 `lib/` 构建产物，因为 GitHub tag 安装不会运行 `prepare` 或 `postinstall`。
修改 `src/` 后必须运行 `pnpm run build`，并把对应的 `lib/` 变化一起提交。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm run typecheck` | 严格检查源码与测试类型 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm run test:watch` | 开发过程中持续运行测试 |
| `pnpm run build` | 生成 `lib/types` 和运行时入口 |
| `pnpm run release:check` | 检查依赖、exports、patch、preset 和打包内容 |
| `pnpm run verify:install` | 在隔离 DSH home 中安装 tarball 并验证 preset 挂载 |

## 扩展开发

主要修改入口：

| 目标 | 入口 |
| --- | --- |
| 调整任务状态 schema 或服务契约 | `src/task-state.ts`、`src/internal/task-state/` |
| 调整任务状态采集、校验和提交 | `src/task-state-basic.ts`、`src/internal/task-state/basic/` |
| 调整注入模型请求的状态格式 | `src/task-state-prompt.ts` |
| 调整压缩选择和执行策略 | `src/compaction-basic.ts`、`src/internal/compaction/` |
| 调整工具输出缩减 | `src/tool-result-pruner.ts` |
| 调整 Web 状态面板 | `src/client/`、`src/effect-projection.ts` |
| 调整 Agent 组合 | `presets/contextual/agent.cordis.yml` |
| 调整 Profile 安装行为 | `cordis.patch.yml` |

开发约束：

- 不要为任务状态新增 DSH `SessionEventMap` 事件；审计数据位于独立 storage domain，保证
  卸载后旧 Session 日志仍可由官方代码读取。
- 修改持久 schema 时必须说明兼容和迁移策略，并增加重启、损坏数据和旧版本数据测试。
- 修改压缩策略时应覆盖工具调用配对、选择边界、空收益、溢出与确定性回退。
- 修改客户端后同时更新中英文 locale、projection 测试和 `lib/client.js`。
- `src/internal/` 中源自 DSH 的代码必须保留 provenance 与 MIT 归属说明。

## 贡献

Issue：<https://github.com/chuxindd/dsh-context-enhancement/issues>

提交 Pull Request 前：

1. 从独立分支完成改动，避免混入无关格式化或生成文件。
2. 为行为变化增加或更新测试。
3. 运行 `pnpm run typecheck`、`pnpm test`、`pnpm run build` 和
   `pnpm run release:check`。
4. 提交源码及对应的 `lib/` 构建产物。
5. 在 PR 中说明问题、实现选择、兼容影响和人工验证方式。
6. 如果改变持久数据、Agent 组合或压缩语义，明确写出升级与回滚影响。

完整约定见 `CONTRIBUTING.md`。

## 发布维护

维护者发布新版本时：

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run release:check
npm pack
pnpm run verify:install -- .\dsh-context-enhancement-0.1.5.tgz
```

全部通过后提交版本变更，创建 `v0.1.5` tag，并在 GitHub Release 上传同名 tarball。

## 兼容性说明

- 当前精确兼容 DSH `0.1.2-rc.1`；升级 DSH 后需要重新验证并发布新版本。
- 运行时不导入 `@deepseek-ai/dsh-*` 的未发布 `src/*` subpath。
- 部分官方压缩实现按 MIT 许可证移植到 `src/internal/`，来源见
  `THIRD_PARTY_NOTICES.md`。
- Headless 或未挂载 `agent-presets` roster 的 profile 只会启用主机侧任务状态 provider，
  不会修改默认 Agent preset。

## 许可证

MIT。部分代码改编自 DeepSeek Harness 的 MIT 实现，详见 `THIRD_PARTY_NOTICES.md`。
