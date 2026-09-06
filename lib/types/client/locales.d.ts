/** Context-enhancement header panel dictionaries. */
export declare const NS = "contextEnhancement";
export declare const zh: {
    readonly trigger: "当前状态";
    readonly panelLabel: "当前状态";
    readonly intro: "以下能力正在为当前会话工作，次数表示已经实际生效的操作。";
    readonly enabled: "已启用";
    readonly evidenceSaved: "已保存 {count} 次";
    readonly evidenceRead: "已读取 {count} 次";
    readonly evidenceGrouped: "已归纳 {count} 组";
    readonly evidenceCompacted: "已压缩 {count} 次";
    readonly notTriggered: "尚未生效";
    readonly close: "关闭";
    readonly taskStateBasic: "保存会话摘要";
    readonly taskStateBasicDetail: "自动提炼并保存当前会话中的重要信息";
    readonly taskStatePrompt: "读取会话摘要";
    readonly taskStatePromptDetail: "在后续请求中继续参考已保存的会话信息";
    readonly toolResultPruner: "归纳工具操作";
    readonly toolResultPrunerDetail: "将一组连续的工具调用和结果压缩为结果摘要，减少冗长工具输出";
    readonly compactionBasic: "压缩较早的对话内容";
    readonly compactionBasicDetail: "将较早的对话提炼成摘要，减少上下文占用";
    readonly footer: "详细记录会出现在当前会话的轨迹中。";
};
export declare const en: Record<ContextEnhancementKey, string>;
export type ContextEnhancementKey = keyof typeof zh;
//# sourceMappingURL=locales.d.ts.map