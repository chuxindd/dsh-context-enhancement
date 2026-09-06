import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ToolGroup } from './tool-groups.ts';
import type { ToolGroupSummary } from './tool-group-summary.ts';
export interface ToolGroupReplacementResult {
    readonly replacementSeqs: readonly SessionSeq[];
    readonly sourceSeqs: readonly SessionSeq[];
}
export declare function replaceToolGroup(session: Session, group: ToolGroup, summary: ToolGroupSummary): ToolGroupReplacementResult;
//# sourceMappingURL=tool-group-replacement.d.ts.map