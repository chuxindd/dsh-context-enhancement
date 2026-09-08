import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Conversation-view Tab "上下文优化" (contextEnhancement): a flat rendering
 * and controlled editor for one Session's committed {@link TaskStateStable}.
 *
 * The view reads its Session's stable out of the shared
 * {@link TaskStateControlMirror} through the per-Session source the entry's
 * inject face provides (`useTaskState`). Edits travel through the plugin-owned
 * Host Remote and replace the authoritative stable under revision control.
 *
 * ## States the view renders
 *
 * - `connecting` — the shared Remote mirror has not applied an opening
 *   baseline yet (or the Host proxy namespace is absent): the loading state.
 * - `error` — the stream failed terminally: an error state with a retry
 *   affordance (keeps the last applied stable readable when one exists).
 * - `live` with `stable === null` — the Host reported no committed stable
 *   for this Session. The Session preset selects either the waiting-for-first-
 *   summary state or the non-contextual state.
 * - `live` with a stable whose content has no entries — the "folded, but
 *   nothing has been folded yet" empty state.
 * - `live` with a committed stable — the flat summary body.
 *
 * The flat body tiles the stable's whole durable content: the meta row
 * (revision / sourceCursor / digest), the continuation (currentObjective,
 * currentFocus, openWork, nextActions), and the four kinded lists plus
 * evidence and todo references. The eight authored summary fields are editable;
 * evidence and todo references remain derived, read-only provenance.
 *
 * @module dsh-context-enhancement/client/ContextEnhancementView
 */
import { useState, useSyncExternalStore } from 'react';
const EDITABLE_FIELDS = [
    { key: 'currentObjective', label: 'section.currentObjective' },
    { key: 'currentFocus', label: 'section.currentFocus' },
    { key: 'openWork', label: 'section.openWork' },
    { key: 'nextActions', label: 'section.nextActions' },
    { key: 'facts', label: 'section.facts' },
    { key: 'decisions', label: 'section.decisions' },
    { key: 'constraints', label: 'section.constraints' },
    { key: 'risks', label: 'section.risks' },
];
const EFFECTS = [
    { key: 'taskStateBasic', label: 'status.taskStateBasic', detail: 'status.taskStateBasicDetail', countLabel: 'status.evidenceSaved' },
    { key: 'taskStatePrompt', label: 'status.taskStatePrompt', detail: 'status.taskStatePromptDetail', countLabel: 'status.evidenceRequests' },
    { key: 'toolResultPruner', label: 'status.toolResultPruner', detail: 'status.toolResultPrunerDetail', countLabel: 'status.evidenceGrouped' },
    { key: 'compactionBasic', label: 'status.compactionBasic', detail: 'status.compactionBasicDetail', countLabel: 'status.evidenceCompacted' },
];
const statusPanelStyle = {
    padding: '24px 28px',
    borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-base)',
};
const statusInnerStyle = {
    margin: '0 auto',
};
const statusGridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    gap: '18px 28px',
    marginTop: 20,
};
const statusRowStyle = {
    display: 'grid',
    gridTemplateColumns: '9px minmax(0, 1fr) auto',
    gap: 10,
    alignItems: 'start',
};
const statusDotStyle = {
    width: 7,
    height: 7,
    marginTop: 7,
    borderRadius: '50%',
    background: '#20a464',
};
const statusDetailStyle = {
    marginTop: 4,
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 12,
    lineHeight: 1.4,
};
const statusEnabledStyle = {
    color: 'var(--dsw-alias-state-success-primary)',
    fontSize: 12,
    textAlign: 'right',
    whiteSpace: 'nowrap',
};
const statusCountStyle = {
    marginTop: 5,
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 11,
};
const pageStyle = {
    minHeight: '100%',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
};
const summaryAreaStyle = {
    margin: '0 auto',
    padding: '24px 28px 32px',
};
const emptyCardStyle = {
    maxWidth: 580,
    margin: '24px auto 0',
    padding: '44px 28px',
    textAlign: 'center',
};
const emptyIconStyle = {
    display: 'grid',
    placeItems: 'center',
    width: 44,
    height: 44,
    margin: '0 auto 16px',
    borderRadius: 12,
    background: 'var(--dsw-alias-state-business-tertiary)',
    color: 'var(--dsw-alias-state-business-primary)',
    fontSize: 20,
};
const summaryGridStyle = {
    columns: '260px',
    columnGap: 28,
    marginTop: 20,
};
const featuresGridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: '22px 28px',
    marginTop: 20,
};
const summarySectionStyle = {
    display: 'inline-block',
    width: '100%',
    breakInside: 'avoid',
    marginBottom: 24,
    verticalAlign: 'top',
    boxSizing: 'border-box',
};
const sectionTitleRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
};
const sectionDotStyle = {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--dsw-alias-state-business-primary)',
    flexShrink: 0,
};
const summaryHeadingStyle = {
    margin: 0,
    fontSize: 14,
    lineHeight: '20px',
    fontWeight: 600,
};
const sectionContentStyle = {
    paddingLeft: 17,
    marginTop: 8,
};
const summaryTextStyle = {
    margin: 0,
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 13,
    lineHeight: 1.6,
};
const editButtonStyle = {
    padding: '6px 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 6,
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit', fontSize: 12, cursor: 'pointer',
};
const sectionEditButtonStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    padding: '2px 8px',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '18px',
    cursor: 'pointer',
};
const textareaStyle = {
    boxSizing: 'border-box', width: '100%', minHeight: 82, padding: '8px 10px',
    border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', fontSize: 13, lineHeight: 1.55, resize: 'vertical',
};
function editValueOf(stable) {
    return {
        currentObjective: stable.continuation.currentObjective,
        currentFocus: stable.continuation.currentFocus,
        openWork: stable.continuation.openWork,
        nextActions: stable.continuation.nextActions,
        facts: stable.facts.map(entry => entry.content),
        decisions: stable.decisions.map(entry => entry.content),
        constraints: stable.constraints.map(entry => entry.content),
        risks: stable.risks.map(entry => entry.content),
    };
}
function splitLines(value) {
    return value.split(/\r?\n/).map(item => item.trim()).filter(item => item.length > 0);
}
function editDraftFor(stable, field) {
    switch (field) {
        case 'currentObjective': return stable.continuation.currentObjective;
        case 'currentFocus': return stable.continuation.currentFocus;
        case 'openWork': return stable.continuation.openWork.join('\n');
        case 'nextActions': return stable.continuation.nextActions.join('\n');
        case 'facts': return stable.facts.map(e => e.content).join('\n');
        case 'decisions': return stable.decisions.map(e => e.content).join('\n');
        case 'constraints': return stable.constraints.map(e => e.content).join('\n');
        case 'risks': return stable.risks.map(e => e.content).join('\n');
    }
}
function updateEditValue(base, field, draft) {
    switch (field) {
        case 'currentObjective': return { ...base, currentObjective: draft.trim() };
        case 'currentFocus': return { ...base, currentFocus: draft.trim() };
        case 'openWork': return { ...base, openWork: splitLines(draft) };
        case 'nextActions': return { ...base, nextActions: splitLines(draft) };
        case 'facts': return { ...base, facts: splitLines(draft) };
        case 'decisions': return { ...base, decisions: splitLines(draft) };
        case 'constraints': return { ...base, constraints: splitLines(draft) };
        case 'risks': return { ...base, risks: splitLines(draft) };
    }
}
const sectionListStyle = {
    margin: 0,
    padding: 0,
    listStyle: 'none',
};
const sectionListItemStyle = {
    display: 'grid',
    gridTemplateColumns: '12px minmax(0, 1fr)',
    gap: 6,
    alignItems: 'start',
    marginTop: 6,
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary)',
};
const sectionBulletStyle = {
    color: 'var(--dsw-alias-label-tertiary)',
    userSelect: 'none',
    textAlign: 'center',
};
const metaStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 20px',
    margin: '12px 0 0',
    padding: 0,
};
const metaItemStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
};
const metaLabelStyle = {
    color: 'var(--dsw-alias-label-tertiary)',
};
const metaValueStyle = {
    margin: 0,
    color: 'var(--dsw-alias-label-secondary)',
    fontWeight: 500,
};
const metaDigestStyle = {
    maxWidth: 240,
    overflow: 'hidden',
    fontFamily: 'var(--dsw-font-mono, monospace)',
    fontSize: 11,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-secondary)',
};
const seqBadgeStyle = {
    fontFamily: 'var(--dsw-font-mono, monospace)',
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
};
/** Four contextual capabilities formerly shown in the removed header popover. */
function StatusPanel({ evidence, stable, t }) {
    const countFor = (key) => {
        if (key === 'taskStateBasic')
            return stable?.revision ?? 0;
        if (key === 'taskStatePrompt')
            return evidence?.taskStateRequests ?? 0;
        return evidence?.[key] ?? 0;
    };
    return (_jsx("section", { className: "dsh-ce-status", style: statusPanelStyle, "aria-labelledby": "dsh-ce-status-title", children: _jsxs("div", { style: statusInnerStyle, children: [_jsx("h2", { id: "dsh-ce-status-title", style: { margin: 0, fontSize: 16 }, children: t('status.title') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('status.intro') }), _jsx("div", { style: statusGridStyle, children: EFFECTS.map(effect => {
                        const count = countFor(effect.key);
                        return (_jsxs("div", { style: statusRowStyle, children: [_jsx("span", { style: statusDotStyle, "aria-hidden": "true" }), _jsxs("div", { children: [_jsx("div", { children: t(effect.label) }), _jsx("div", { style: statusDetailStyle, children: t(effect.detail) })] }), _jsxs("div", { style: statusEnabledStyle, children: [_jsx("div", { children: t('status.enabled') }), _jsx("div", { style: statusCountStyle, children: count === 0 ? t('status.notTriggered') : t(effect.countLabel, { count }) })] })] }, effect.key));
                    }) })] }) }));
}
/** One heading+list or heading+text tile of the flat summary with inline editing support. */
function SummarySection({ title, fieldKey, items, text, editingField, saving, editError, t, onStartEdit, onUpdateDraft, onSave, onCancel, empty, }) {
    const isEditing = editingField?.field === fieldKey;
    const isList = items !== undefined;
    return (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: title }), !isEditing && onStartEdit && (_jsxs("button", { type: "button", className: "dsh-ce-section-edit", style: sectionEditButtonStyle, title: t('edit.action'), "aria-label": `${t('edit.action')} ${title}`, onClick: () => onStartEdit(fieldKey), children: ["\u270E ", t('edit.action')] }))] }), _jsx("div", { style: sectionContentStyle, children: isEditing && onUpdateDraft && onSave && onCancel ? (_jsxs("div", { children: [_jsx("textarea", { style: {
                                ...textareaStyle,
                                minHeight: isList ? 112 : 72,
                            }, value: editingField.draft, onChange: (event) => onUpdateDraft(event.currentTarget.value), disabled: saving, autoFocus: true }), isList && (_jsx("p", { style: { ...statusDetailStyle, marginTop: 4, marginBottom: 0 }, children: t('edit.linesHint') })), editError !== null && (_jsx("p", { role: "alert", style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '4px 0 0' }, children: editError })), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }, children: [_jsx("button", { type: "button", style: editButtonStyle, disabled: saving, onClick: onCancel, children: t('edit.cancel') }), _jsx("button", { type: "button", style: {
                                        ...editButtonStyle,
                                        borderColor: 'var(--dsw-alias-state-business-primary)',
                                        background: 'var(--dsw-alias-state-business-primary)',
                                        color: 'var(--dsw-alias-label-primary-foreground)',
                                    }, disabled: saving, onClick: () => { void onSave(); }, children: saving ? t('edit.saving') : t('edit.save') })] })] })) : text !== undefined && text !== '' ? (_jsx("p", { className: fieldKey === 'currentObjective' ? 'dsh-ce-objective' : undefined, style: summaryTextStyle, children: text })) : items !== undefined && items.length > 0 ? (_jsx("ul", { style: sectionListStyle, children: items.map((item, index) => (_jsxs("li", { style: sectionListItemStyle, children: [_jsx("span", { style: sectionBulletStyle, "aria-hidden": "true", children: "\u2022" }), _jsx("span", { children: item })] }, `${index}`))) })) : (_jsx("p", { className: "dsh-ce-empty", style: summaryTextStyle, children: empty })) })] }));
}
/** Read-only reference line (evidence / todo reference). */
function ReferenceList({ rows }) {
    if (rows.length === 0)
        return null;
    return (_jsx("ul", { style: sectionListStyle, children: rows.map((row, index) => (_jsxs("li", { className: "dsh-ce-reference", style: sectionListItemStyle, children: [_jsxs("span", { className: "dsh-ce-seq", style: seqBadgeStyle, children: ["#", row.seq] }), _jsx("span", { children: row.text })] }, `${index}`))) }));
}
/** True when a committed stable carries no durable content at all. */
function isEmptyStable(stable) {
    return stable.facts.length === 0
        && stable.decisions.length === 0
        && stable.constraints.length === 0
        && stable.risks.length === 0
        && stable.continuation.currentObjective === ''
        && stable.continuation.currentFocus === ''
        && stable.continuation.openWork.length === 0
        && stable.continuation.nextActions.length === 0
        && stable.evidence.length === 0
        && stable.todoReferences.length === 0;
}
/**
 * The flat display body of one committed stable.
 * @param props - section title accessor, the committed stable, and editing handlers.
 * @returns the tiled summary.
 */
function StableBody({ stable, section, t, editingField = null, saving = false, editError = null, onStartEdit, onUpdateDraft, onSave, onCancel, }) {
    const continuation = stable.continuation;
    const renderSection = (fieldKey, titleKey, options) => {
        const isEditing = editingField?.field === fieldKey;
        const hasContent = options.text !== undefined
            ? options.text !== ''
            : (options.items !== undefined && options.items.length > 0);
        if (!hasContent && !isEditing && onStartEdit === undefined)
            return null;
        return (_jsx(SummarySection, { title: section(titleKey), fieldKey: fieldKey, items: options.items, text: options.text, editingField: editingField, saving: saving, editError: editError, t: t, onStartEdit: onStartEdit, onUpdateDraft: onUpdateDraft, onSave: onSave, onCancel: onCancel, empty: t('empty.noEntries') }, fieldKey));
    };
    return (_jsxs("div", { className: "dsh-ce-stable", children: [_jsxs("dl", { className: "dsh-ce-meta", style: metaStyle, children: [_jsxs("div", { style: metaItemStyle, children: [_jsx("dt", { style: metaLabelStyle, children: section('meta.revisionLabel') }), _jsx("dd", { style: metaValueStyle, children: stable.revision })] }), _jsxs("div", { style: metaItemStyle, children: [_jsx("dt", { style: metaLabelStyle, children: section('meta.sourceCursorLabel') }), _jsx("dd", { style: metaValueStyle, children: stable.sourceCursor })] }), _jsxs("div", { style: metaItemStyle, children: [_jsx("dt", { style: metaLabelStyle, children: section('meta.digestLabel') }), _jsx("dd", { className: "dsh-ce-digest", style: { ...metaValueStyle, ...metaDigestStyle }, children: stable.digest })] })] }), _jsxs("div", { style: summaryGridStyle, children: [renderSection('currentObjective', 'section.currentObjective', { text: continuation.currentObjective }), renderSection('currentFocus', 'section.currentFocus', { text: continuation.currentFocus }), renderSection('openWork', 'section.openWork', { items: continuation.openWork }), renderSection('nextActions', 'section.nextActions', { items: continuation.nextActions }), renderSection('facts', 'section.facts', { items: stable.facts.map(entry => entry.content) }), renderSection('decisions', 'section.decisions', { items: stable.decisions.map(entry => entry.content) }), renderSection('constraints', 'section.constraints', { items: stable.constraints.map(entry => entry.content) }), renderSection('risks', 'section.risks', { items: stable.risks.map(entry => entry.content) }), stable.evidence.length > 0 && (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: section('section.evidence') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx(ReferenceList, { rows: stable.evidence.map(ref => ({ seq: ref.seq, text: ref.note })) }) })] })), stable.todoReferences.length > 0 && (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: section('section.todoReferences') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx(ReferenceList, { rows: stable.todoReferences.map(ref => ({ seq: ref.seq, text: ref.content })) }) })] }))] })] }));
}
/** Centered summary placeholder used while no readable stable is available. */
function EmptySummary({ title, body, className, role, action }) {
    return (_jsxs("div", { className: className, style: emptyCardStyle, role: role, children: [_jsx("div", { style: emptyIconStyle, "aria-hidden": "true", children: "\u2726" }), _jsx("h2", { style: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }, children: title }), _jsx("p", { style: { ...summaryTextStyle, maxWidth: 440, margin: '10px auto 0' }, children: body }), action] }));
}
/** Explanatory onboarding view shown when the session is not using the contextual preset. */
function NonContextualGuide({ t }) {
    return (_jsxs("div", { className: "dsh-ce dsh-ce-noncontextual", style: pageStyle, "data-conversation-composer-overlay": "", children: [_jsxs("section", { style: { padding: '36px 28px 32px', textAlign: 'center', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }, children: [_jsx("div", { style: emptyIconStyle, "aria-hidden": "true", children: "\u2726" }), _jsx("div", { style: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12, fontWeight: 600, marginBottom: 6 }, children: t('empty.nonContextual.badge') }), _jsx("h1", { style: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }, children: t('empty.nonContextual.title') }), _jsx("p", { style: { margin: '10px auto 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: 620 }, children: t('empty.nonContextual.body') })] }), _jsxs("section", { style: { padding: '24px 28px', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }, children: [_jsx("h2", { style: { margin: 0, fontSize: 16, lineHeight: '22px', fontWeight: 600 }, children: t('empty.nonContextual.activateTitle') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('empty.nonContextual.activateIntro') }), _jsxs("div", { style: { marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', maxWidth: 680 }, children: [_jsx("span", { style: { fontSize: 16, lineHeight: 1, flexShrink: 0 }, children: "\uD83D\uDCA1" }), _jsxs("div", { children: [_jsxs("strong", { children: [t('empty.nonContextual.activateStep').split('：')[0], "\uFF1A"] }), _jsx("span", { style: { color: 'var(--dsw-alias-label-secondary)' }, children: t('empty.nonContextual.activateStep').split('：')[1] })] })] })] }), _jsxs("section", { style: { padding: '24px 28px 32px' }, children: [_jsx("h2", { style: { margin: 0, fontSize: 16, lineHeight: '22px', fontWeight: 600 }, children: t('empty.nonContextual.featuresTitle') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('empty.nonContextual.featuresIntro') }), _jsxs("div", { style: featuresGridStyle, children: [_jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featMemory') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featMemoryDesc') }) })] }), _jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: { ...sectionDotStyle, background: '#722ed1' }, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featAnchor') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featAnchorDesc') }) })] }), _jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: { ...sectionDotStyle, background: '#20a464' }, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featPrune') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featPruneDesc') }) })] }), _jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: { ...sectionDotStyle, background: '#fa8c16' }, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featCompact') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featCompactDesc') }) })] })] })] })] }));
}
/**
 * The "上下文优化" conversation view tab.
 * @param props - session kit, per-Session task-state source, locale seat.
 * @returns the summary surface with a revision-controlled editor.
 */
export function ContextEnhancementView({ sessionId, useSessions, useProjection, useTaskState, retryTaskState, editTaskState, t, }) {
    const source = useTaskState();
    const session = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
    const agentPreset = useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset);
    const evidence = useProjection('contextEnhancement');
    const [editingField, setEditingField] = useState(null);
    const [saving, setSaving] = useState(false);
    const [editError, setEditError] = useState(null);
    const connection = session.connection;
    if (agentPreset !== 'contextual') {
        return _jsx(NonContextualGuide, { t: t });
    }
    let summary;
    if (connection === 'connecting') {
        summary = (_jsx(EmptySummary, { className: "dsh-ce-connecting", title: t('loading.title'), body: t('loading.body'), role: "status" }));
    }
    else if (connection === 'error') {
        summary = (_jsxs("div", { className: "dsh-ce-error", style: emptyCardStyle, role: "alert", children: [_jsx("div", { style: { ...emptyIconStyle, background: 'var(--dsw-alias-state-warn-secondary)', color: 'var(--dsw-alias-state-warn-label)' }, "aria-hidden": "true", children: "!" }), _jsx("h2", { style: { margin: 0, fontSize: 20 }, children: t('error.title') }), _jsx("p", { style: { ...summaryTextStyle, maxWidth: 520, margin: '10px auto 0' }, children: session.error ?? t('error.unknown') }), session.stable !== null && (_jsx("p", { className: "dsh-ce-stale", style: summaryTextStyle, children: t('error.staleNote') })), _jsx("button", { type: "button", style: { marginTop: 18, padding: '7px 16px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }, onClick: () => { retryTaskState(); }, children: t('error.retry') }), session.stable !== null && _jsx(StableBody, { stable: session.stable, section: key => t(key), t: t })] }));
    }
    else if (session.stable === null) {
        summary = (_jsx("div", { className: "dsh-ce-empty-stable", children: _jsx(EmptySummary, { title: t('empty.noStable.title'), body: t('empty.noStable.body') }) }));
    }
    else {
        const stable = session.stable;
        const startEdit = (field) => {
            setEditError(null);
            setEditingField({
                field,
                draft: editDraftFor(stable, field),
                expectedRevision: stable.revision,
            });
        };
        const saveEdit = async () => {
            if (editingField === null)
                return;
            setSaving(true);
            setEditError(null);
            try {
                const fullValue = editValueOf(stable);
                const updatedValue = updateEditValue(fullValue, editingField.field, editingField.draft);
                const result = await editTaskState({
                    sessionId,
                    expectedRevision: editingField.expectedRevision,
                    value: updatedValue,
                });
                if (!result.ok) {
                    setEditError(result.message);
                    return;
                }
                setEditingField(null);
            }
            catch (error) {
                setEditError(String(error instanceof Error ? error.message : error));
            }
            finally {
                setSaving(false);
            }
        };
        summary = (_jsxs("div", { className: "dsh-ce-summary", children: [_jsxs("header", { children: [_jsx("h2", { style: { margin: 0, fontSize: 16 }, children: t('summary.title') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('view.subtitle') })] }), isEmptyStable(stable) && editingField === null ? (_jsx("div", { className: "dsh-ce-empty-stable", children: _jsx(EmptySummary, { title: t('empty.noStable.title'), body: t('empty.noStable.body'), action: _jsx("div", { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 18 }, children: EDITABLE_FIELDS.map(field => (_jsxs("button", { type: "button", style: editButtonStyle, title: `${t('edit.action')} ${t(field.label)}`, "aria-label": `${t('edit.action')} ${t(field.label)}`, onClick: () => startEdit(field.key), children: ["\u270E ", t(field.label)] }, field.key))) }) }) })) : (_jsx(StableBody, { stable: stable, section: key => t(key), t: t, editingField: editingField, saving: saving, editError: editError, onStartEdit: startEdit, onUpdateDraft: draft => setEditingField(curr => curr ? { ...curr, draft } : null), onSave: saveEdit, onCancel: () => {
                        setEditingField(null);
                        setEditError(null);
                    } }))] }));
    }
    return (_jsxs("div", { className: "dsh-ce", style: pageStyle, "data-conversation-composer-overlay": "", children: [_jsx(StatusPanel, { evidence: evidence, stable: session.stable, t: t }), _jsx("main", { style: summaryAreaStyle, children: summary })] }));
}
//# sourceMappingURL=ContextEnhancementView.js.map