/** Context-enhancement header panel dictionaries. */
export declare const NS = "contextEnhancement";
export declare const zh: {
    readonly trigger: "增强功能";
    readonly panelLabel: "当前会话的增强功能";
    readonly intro: "功能会根据当前会话自动工作，详细记录可在轨迹中查看。";
    readonly enabled: "已启用";
    readonly evidence: "本会话触发 {count} 次";
    readonly notTriggered: "本会话尚未触发";
    readonly close: "关闭";
    readonly taskStateBasic: "任务进度记忆";
    readonly taskStateBasicDetail: "自动保存任务进度";
    readonly taskStatePrompt: "请求上下文同步";
    readonly taskStatePromptDetail: "自动同步当前任务状态";
    readonly toolResultPruner: "工具结果整理";
    readonly toolResultPrunerDetail: "减少重复和冗余内容";
    readonly compactionBasic: "长对话整理";
    readonly compactionBasicDetail: "按需压缩历史上下文";
    readonly footer: "详细记录会出现在当前会话的轨迹中。";
};
export declare const en: Record<ContextEnhancementKey, string>;
export type ContextEnhancementKey = keyof typeof zh;
//# sourceMappingURL=locales.d.ts.map