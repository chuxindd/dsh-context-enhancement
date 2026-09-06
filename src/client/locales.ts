/** Context-enhancement header panel dictionaries. */
export const NS = 'contextEnhancement'
export const zh = {
  trigger: '增强功能',
  panelLabel: '当前会话的增强功能',
  intro: '功能会根据当前会话自动工作，详细记录可在轨迹中查看。',
  enabled: '已启用',
  evidence: '本会话参与 {count} 次请求',
  notTriggered: '本会话尚未参与请求',
  close: '关闭',
  taskStateBasic: '任务进度记忆',
  taskStateBasicDetail: '自动保存任务进度',
  taskStatePrompt: '请求上下文同步',
  taskStatePromptDetail: '自动同步当前任务状态',
  toolResultPruner: '工具结果整理',
  toolResultPrunerDetail: '减少重复和冗余内容',
  compactionBasic: '长对话整理',
  compactionBasicDetail: '按需压缩历史上下文',
  footer: '详细记录会出现在当前会话的轨迹中。',
} as const
export const en: Record<ContextEnhancementKey, string> = {
  trigger: 'Enhanced features',
  panelLabel: 'Enhanced features for this session',
  intro: 'These features work automatically for the current session. Detailed records are available in the trajectory.',
  enabled: 'Enabled',
  evidence: 'Participated in {count} requests in this session',
  notTriggered: 'No request participation yet',
  close: 'Close',
  taskStateBasic: 'Task progress memory',
  taskStateBasicDetail: 'Automatically saves task progress',
  taskStatePrompt: 'Request context sync',
  taskStatePromptDetail: 'Automatically syncs the current task state',
  toolResultPruner: 'Tool-result cleanup',
  toolResultPrunerDetail: 'Reduces repeated and unnecessary content',
  compactionBasic: 'Long-conversation cleanup',
  compactionBasicDetail: 'Compresses conversation history when needed',
  footer: 'Detailed records appear in the current session trajectory.',
}
export type ContextEnhancementKey = keyof typeof zh
