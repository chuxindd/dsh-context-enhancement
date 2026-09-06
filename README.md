# Dsh-Context-Enhancement

`dsh-context-enhancement` 是为 DeepSeek Harness（DSH）定制的上下文增强插件，面向单一长会话的上下文管理，提供“工具要点化”和“遗忘区压缩”、“独立会话摘要”的能力，力求化解会话在触发 /compact 上下文压缩后损失信息过多，导致前后表现“判若两人”的技术困境。

> 当前版本：`0.1.6`。兼容 DeepSeek Harness `0.1.2-rc.1`。
> 本项目还在测试阶段，代码由 GPT5.6 Sol 完成，欢迎批评指教。

## 工作原理

编码 Agent 在长任务中会经历几十上百轮工具调用。 把完整历史保留在主上下文中会面临以下硬约束：

* 上下文窗口有限，工具输出、代码片段和报错日志迟早填满窗口，必须压缩或丢弃。
* 输入越长，有用约束越容易被大量工具低价值输出稀释，主 Agent 越难判断下一步该做什么。
* 模型难以区分当前现场、历史事实和已经完成的工作。
* 在窗口即将耗尽时一次性压缩，输入往往过大，极易同时损失底层细节和全局结构。

同时，长任务还需要一份持续更新的任务摘要，用于记录已经发生的事实、决策和关键上下文。

在行业常见的 TODO 清单编排、长程目标（Goal）验证及各种状态循环机制的基础之上，针对长会话的记忆管理，本插件由“主线程分区压缩”和“独立 checkpoint 旁路”两套并行机制分别处理：

#### 2.1 主线程压缩链

主线程中的内容随新对话产生而逐渐老化，并依次进入三个互不重叠的区域：

|  历史演变 (最老 $\rightarrow$ 最新) | 遗忘区 | 工具压缩区 | 近区 |
|---|---|---|---|
| 核心状态 |  逐渐模糊 |  精简提炼 |  当前活跃 |
| 触发操作 | 操作③：分批语义压缩 | 操作① / 操作②：工具要点化或工具裁剪 | 原始内容完整保留 |
| 场景定义 | 深度记忆归档 | 核心工具库 | 当前工作现场 |


每段内容遵循统一生命周期：

```text
近区原始内容
    │ 随新内容增长而老化
    ▼
工具压缩区
    │ 工具结果形成要点或经过裁剪
    │ 用户消息、助手回答和工具要点继续参与后续对话
    │ 接受用户纠偏、模型判断和新工具证据验证
    ▼
遗忘区
    │ 按最老优先的有限批次执行语义压缩
    ▼
遗忘摘要
```

#### 2.2 Checkpoint 旁路链

独立任务状态服务读取主线程事件流，在后台持续更新同一份 Checkpoint。

```text
主线程事件流
    │
    └─ 独立 Checkpoint 服务
          ├─ 截取上次提交位置之后的新增事件
          ├─ 与上一版稳定状态合并
          └─ 校验并提交新的稳定版本
```

Checkpoint 使用独立模型请求、输入预算、输出预算、超时和重试策略。主 Agent 始终读取最近一次成功提交的稳定版本；后台更新和失败均不阻塞主任务。

## 相比 standard 的变化

`contextual` 保留 `standard` 的编码工具、规划、子代理和工作流能力，仅改变任务连续性
与上下文管理方式。

| 能力                 | `standard`         | `contextual`                                           |
| -------------------- | ------------------ | ------------------------------------------------------ |
| 编码 Agent 与工具    | 完整提供           | 完整保留                                               |
| 任务状态             | 依赖当前对话       | 自动提取并持久保存任务事实、决策、约束、风险和后续事项 |
| 服务重启后的任务恢复 | 无独立状态         | 从存储直接恢复，不需要重新调用模型重建                 |
| 较早工具输出         | 由默认压缩统一处理 | 在压缩前优先缩减，降低上下文占用                       |
| 长对话压缩           | DSH 默认实现       | 优先保留近期工作，再整理较早历史                       |

在 Web 会话中，标题栏的 **增强功能** 按钮显示四项运行状态：任务进度记忆、请求上下文同步、工具结果整理和长对话整理。该面板用于查看状态。

## 安装

### 前置条件

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `0.1.2-rc.1`
- 已配置可用的 DSH 模型提供方
- Web 安装使用 `dsh --profile web`

### 从 GitHub Release 安装

安装固定 tag，避免后续提交改变当前部署：

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.6'
dsh --profile web
```

打开 `http://127.0.0.1:8080`，新建会话并选择 **上下文增强**。插件会保留`standard`、`minimal`、`ptc` 和 `cordis` 等原有模式，同时将 `contextual` 注册为默认模式。

### 从本地源码安装

适合开发、调试或尚未创建 Release 时使用：

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run build
npm pack
dsh plugin --profile web add "file:$PWD/dsh-context-enhancement-0.1.6.tgz"
dsh --profile web
```

在 Windows PowerShell 中，如果 DSH CLI 不接受含 `/` 的相对路径，请传入 tarball 的绝对路径。

### Desktop 兼容步骤

Desktop 启动器会重建 Agent preset 的发现目录，因此安装 Bundle 后还需要把 `contextual` preset 写入用户目录。在本仓库或解压后的源码目录执行：

```powershell
pnpm run install:desktop-preset
```

默认写入 `%DSH_HOME%\.agent-presets\contextual`；未设置 `DSH_HOME` 时使用 `%USERPROFILE%\.dsh\.agent-presets\contextual`。如果已有同名 preset，脚本会拒绝覆盖；确认需要替换时执行：

```powershell
pnpm run install:desktop-preset -- --force
```

## 使用与验证

1. 启动 Web profile，打开或新建会话。
2. 在 Agent 选择器中选择 **上下文增强**。
3. 正常执行任务；任务状态与上下文整理均自动运行，不需要手动维护。
4. 点击会话标题栏的 **增强功能** 查看各能力是否启用及本会话触发次数。
5. 打开“轨迹”查看压缩、裁剪等详细事件。

任务状态达到事件阈值后异步更新，因此刚创建的会话可能显示“本会话尚未触发”。这不代表能力未启用。

## 配置

Bundle 默认配置位于 `cordis.patch.yml`，可在 profile/home patch 层覆盖。覆盖 `config`时需要提供完整配置，而不是只写变化字段。

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

`contextual` 继承 DSH 官方配置字段，包括 `thresholdRatio`、`retainRatio`、`retainTokens`、`summarizationProvider`、`summarizationModel`、`maxTokens`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies` 和 `auto`。

工具输出缩减使用 `thresholdChars`、`headChars` 和 `tailChars`。修改阈值前建议先通过轨迹观察真实会话；阈值过低会增加处理频率，保留量过低会损失排查问题所需的原始输出。

## 数据、升级与卸载

任务状态保存在：

```text
$DSH_HOME/storages/context_enhancement_task_state.json
```

普通 Session 继续保存在 `$DSH_HOME/sessions`。插件不会在卸载时删除这些数据。

升级：

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.6'
```

回滚到上一版本：

```powershell
dsh plugin --profile web add 'github:chuxindd/dsh-context-enhancement#v0.1.3'
```

卸载：

```powershell
dsh plugin --profile web remove dsh-context-enhancement
```

每次安装、升级、回滚或卸载后都需要重启 profile。卸载会移除 `contextual` 默认覆盖并恢复官方压缩组合，但不会删除任务状态文件和 Session 日志。

## 本地开发

```powershell
git clone https://github.com/chuxindd/dsh-context-enhancement.git
cd dsh-context-enhancement
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

仓库提交 `lib/` 构建产物，因为 GitHub tag 安装不会运行 `prepare` 或 `postinstall`。修改 `src/` 后必须运行 `pnpm run build`，并把对应的 `lib/` 变化一起提交。

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

- 不要为任务状态新增 DSH `SessionEventMap` 事件；审计数据位于独立 storage domain，保证卸载后旧 Session 日志仍可由官方代码读取。
- 修改持久 schema 时必须说明兼容和迁移策略，并增加重启、损坏数据和旧版本数据测试。
- 修改压缩策略时应覆盖工具调用配对、选择边界、空收益、溢出与确定性回退。
- 修改客户端后同时更新中英文 locale、projection 测试和 `lib/client.js`。
- `src/internal/` 中源自 DSH 的代码必须保留 provenance 与 MIT 归属说明。

## 贡献

Issue：<https://github.com/chuxindd/dsh-context-enhancement/issues>

提交 Pull Request 前：

1. 从独立分支完成改动，避免混入无关格式化或生成文件。
2. 为行为变化增加或更新测试。
3. 运行 `pnpm run typecheck`、`pnpm test`、`pnpm run build` 和 `pnpm run release:check`。
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
pnpm run verify:install -- .\dsh-context-enhancement-0.1.6.tgz
```

全部通过后提交版本变更，创建 `v0.1.6` tag，并在 GitHub Release 上传同名 tarball。

## 兼容性说明

- 当前精确兼容 DSH `0.1.2-rc.1`；升级 DSH 后需要重新验证并发布新版本。
- 运行时不导入 `@deepseek-ai/dsh-*` 的未发布 `src/*` subpath。
- Headless 或未挂载 `agent-presets` roster 的 profile 只会启用主机侧任务状态 provider，
  不会修改默认 Agent preset。

## 许可证

MIT。
