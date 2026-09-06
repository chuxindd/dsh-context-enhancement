import { freezeMessage } from '@deepseek-ai/dsh-llm';
export function replaceToolGroup(session, group, summary) {
    const replacementSeqs = [];
    const snapshot = group.toolResultSeqs.map(sourceSeq => {
        const event = session.eventAt(sourceSeq);
        if (event?.type !== 'tool/result')
            throw new Error(`tool-group-replacement: source seq ${sourceSeq} is no longer a tool result`);
        const item = summary.items.find(candidate => candidate.sourceSeq === sourceSeq);
        if (item === undefined)
            throw new Error(`tool-group-replacement: missing summary item for source seq ${sourceSeq}`);
        return { sourceSeq, event, item };
    });
    for (const { sourceSeq, event, item } of snapshot) {
        const original = event.data.message;
        const content = [{
                type: 'text',
                text: formatSummary(item.summary, item.facts, item.files, item.errors, item.unresolved, sourceSeq),
            }];
        const message = freezeMessage({
            ...original,
            content: [{
                    ...original.content[0],
                    content,
                }],
        });
        const replacement = session.append('tool/result', {
            ...event.data,
            message,
        }, {
            surfaceOp: { op: 'replace', start: sourceSeq, end: sourceSeq },
            sourceEventSeqs: [sourceSeq],
        });
        replacementSeqs.push(replacement.seq);
    }
    return { replacementSeqs, sourceSeqs: [...group.sourceSeqs] };
}
function formatSummary(summary, facts, files, errors, unresolved, sourceSeq) {
    return [
        '[tool group summary]',
        `Result: ${summary}`,
        `Facts: ${facts.length === 0 ? '(none)' : facts.join('; ')}`,
        `Files: ${files.length === 0 ? '(none)' : files.join(', ')}`,
        `Errors: ${errors.length === 0 ? '(none)' : errors.join('; ')}`,
        `Unresolved: ${unresolved.length === 0 ? '(none)' : unresolved.join('; ')}`,
        `Source event: seq=${sourceSeq}`,
        '[/tool group summary]',
    ].join('\n');
}
//# sourceMappingURL=tool-group-replacement.js.map