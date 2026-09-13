/** Context-enhancement conversation-view dictionaries. */
/** Dictionary namespace owned by this plugin. */
export declare const NS = "contextEnhancement";
/** Simplified Chinese dictionary (the key-set source of truth). */
export declare const zh: {
    readonly 'view.contextEnhancement': "上下文优化";
    readonly 'view.subtitle': "自动提炼当前对话的目标、下一步行动与关键沉淀，保持长对话连贯。点击编辑可以修改摘要内容。";
    readonly 'summary.eyebrow': "会话摘要";
    readonly 'summary.title': "当前任务上下文";
    readonly 'edit.action': "编辑";
    readonly 'edit.save': "保存";
    readonly 'edit.saving': "正在保存…";
    readonly 'edit.cancel': "取消";
    readonly 'edit.linesHint': "列表字段每行一项；保存后会生成新的摘要修订。";
    readonly 'status.title': "当前状态";
    readonly 'status.intro': "以下能力正在保障当前会话，持续优化长对话记忆与上下文效率。";
    readonly 'status.enabled': "已启用";
    readonly 'status.notTriggered': "尚未生效";
    readonly 'status.evidenceSaved': "已生成 {count} 版";
    readonly 'status.evidenceRequests': "参与 {count} 次请求";
    readonly 'status.evidenceGrouped': "已归纳 {count} 组";
    readonly 'status.evidenceCompacted': "已压缩 {count} 次";
    readonly 'status.taskStateBasic': "保存会话摘要";
    readonly 'status.taskStateBasicDetail': "自动提炼并保存当前会话中的重要信息";
    readonly 'status.taskStatePrompt': "读取会话摘要";
    readonly 'status.taskStatePromptDetail': "在后续请求中继续参考已保存的会话信息";
    readonly 'status.toolResultPruner': "归纳工具操作";
    readonly 'status.toolResultPrunerDetail': "将连续的工具调用和结果压缩为结果摘要，减少冗长工具输出";
    readonly 'status.compactionBasic': "压缩较早的对话内容";
    readonly 'status.compactionBasicDetail': "将较早的对话提炼成摘要，减少上下文占用";
    readonly 'meta.revisionLabel': "修订";
    readonly 'meta.sourceCursorLabel': "来源游标";
    readonly 'meta.digestLabel': "内容摘要";
    readonly 'loading.title': "正在加载上下文摘要…";
    readonly 'loading.body': "正在同步当前会话已经提交的任务状态，请稍候。";
    readonly 'error.title': "上下文摘要连接失败";
    readonly 'error.unknown': "发生未知错误。";
    readonly 'error.staleNote': "以下为最后已知的摘要内容。";
    readonly 'error.retry': "重试";
    readonly 'empty.nonContextual.badge': "上下文增强插件已就绪";
    readonly 'empty.nonContextual.title': "解锁长对话智能增强与持久任务记忆";
    readonly 'empty.nonContextual.body': "当前会话处于普通模式，启用“上下文增强”模式后，AI 将自动跟踪任务目标、提炼关键事实，并智能压缩冗长上下文。";
    readonly 'empty.nonContextual.activateTitle': "如何启用";
    readonly 'empty.nonContextual.activateIntro': "只需一步，即可开启完整上下文优化体验：";
    readonly 'empty.nonContextual.activateStep': "新建会话时选择：点击新建会话，在模式下拉菜单中选择「上下文增强」";
    readonly 'empty.nonContextual.featuresTitle': "核心能力与优势";
    readonly 'empty.nonContextual.featuresIntro': "专为长程编程与复杂对话设计，保障会话在长程任务中跨窗口跨轮次持续可用";
    readonly 'empty.nonContextual.featMemory': "任务状态持久记忆";
    readonly 'empty.nonContextual.featMemoryDesc': "自动提炼当前目标、焦点与待办，长对话全程不跑偏。";
    readonly 'empty.nonContextual.featAnchor': "核心记忆防遗忘注入";
    readonly 'empty.nonContextual.featAnchorDesc': "将任务状态锚定在核心提示中，即使历史被压缩记忆依然完好。";
    readonly 'empty.nonContextual.featPrune': "工具操作分组归纳";
    readonly 'empty.nonContextual.featPruneDesc': "自动合并冗长的搜索与读写输出，大幅削减 Token 消耗。";
    readonly 'empty.nonContextual.featCompact': "早期对话渐进遗忘";
    readonly 'empty.nonContextual.featCompactDesc': "结构化提炼较早会话，消除冗余占用，保障长对话流畅高效。";
    readonly 'empty.noStable.title': "还没有可用的上下文摘要";
    readonly 'empty.noStable.body': "会话进行中会自动归纳任务状态，并在此处展示。";
    readonly 'empty.noEntries': "尚未归纳出任何条目。";
    readonly 'section.currentObjective': "当前目标";
    readonly 'section.currentFocus': "当前焦点";
    readonly 'section.openWork': "待办工作";
    readonly 'section.nextActions': "下一步";
    readonly 'section.facts': "事实";
    readonly 'section.decisions': "决策";
    readonly 'section.constraints': "约束";
    readonly 'section.risks': "风险";
    readonly 'section.evidence': "依据";
    readonly 'section.todoReferences': "待办引用";
};
/** The context-enhancement dictionary key union. */
export type ContextEnhancementKey = keyof typeof zh;
/** English dictionary, checked complete against the Chinese source of truth. */
export declare const en: Record<ContextEnhancementKey, string>;
//# sourceMappingURL=locales.d.ts.map