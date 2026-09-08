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
    border: '0.5px solid var(--dsw-alias-border-l3)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-base)',
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
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: '22px 28px',
    marginTop: 20,
};
const summarySectionStyle = {
    minWidth: 0,
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
    padding: '7px 13px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit', fontSize: 13, cursor: 'pointer',
};
const textareaStyle = {
    boxSizing: 'border-box', width: '100%', minHeight: 82, padding: '10px 12px',
    border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 9,
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
function editDraftOf(value) {
    return {
        currentObjective: value.currentObjective,
        currentFocus: value.currentFocus,
        openWork: value.openWork.join('\n'),
        nextActions: value.nextActions.join('\n'),
        facts: value.facts.join('\n'),
        decisions: value.decisions.join('\n'),
        constraints: value.constraints.join('\n'),
        risks: value.risks.join('\n'),
    };
}
function editValueFromDraft(draft) {
    return {
        currentObjective: draft.currentObjective.trim(),
        currentFocus: draft.currentFocus.trim(),
        openWork: splitLines(draft.openWork),
        nextActions: splitLines(draft.nextActions),
        facts: splitLines(draft.facts),
        decisions: splitLines(draft.decisions),
        constraints: splitLines(draft.constraints),
        risks: splitLines(draft.risks),
    };
}
function EditForm({ value, saving, error, t, onCancel, onSubmit }) {
    const [draft, setDraft] = useState(() => editDraftOf(value));
    const field = (key, label, tall = false) => (_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }, children: [_jsx("span", { children: t(label) }), _jsx("textarea", { style: { ...textareaStyle, minHeight: tall ? 112 : 76 }, value: draft[key], onChange: (event) => {
                    setDraft(current => ({ ...current, [key]: event.currentTarget.value }));
                } })] }));
    const submit = (event) => {
        event.preventDefault();
        void onSubmit(editValueFromDraft(draft));
    };
    return (_jsxs("form", { className: "dsh-ce-editor", style: { marginTop: 20 }, onSubmit: submit, children: [_jsxs("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '18px 28px' }, children: [field('currentObjective', 'section.currentObjective'), field('currentFocus', 'section.currentFocus'), field('openWork', 'section.openWork', true), field('nextActions', 'section.nextActions', true), field('facts', 'section.facts', true), field('decisions', 'section.decisions', true), field('constraints', 'section.constraints', true), field('risks', 'section.risks', true)] }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('edit.linesHint') }), error !== null && _jsx("p", { role: "alert", style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }, children: error }), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }, children: [_jsx("button", { type: "button", style: editButtonStyle, disabled: saving, onClick: onCancel, children: t('edit.cancel') }), _jsx("button", { type: "submit", style: { ...editButtonStyle, borderColor: 'var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-label-primary-foreground)' }, disabled: saving, children: saving ? t('edit.saving') : t('edit.save') })] })] }));
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
/** One heading+list tile of the flat summary. */
function Section({ title, items, empty, }) {
    return (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: title })] }), _jsx("div", { style: sectionContentStyle, children: items.length === 0 ? _jsx("p", { className: "dsh-ce-empty", style: summaryTextStyle, children: empty }) : (_jsx("ul", { style: sectionListStyle, children: items.map((item, index) => (_jsxs("li", { style: sectionListItemStyle, children: [_jsx("span", { style: sectionBulletStyle, "aria-hidden": "true", children: "\u2022" }), _jsx("span", { children: item })] }, `${index}`))) })) })] }));
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
 * @param props - section title accessor, the committed stable, and empty copy.
 * @returns the tiled summary.
 */
function StableBody({ stable, section, emptyNoEntries }) {
    const continuation = stable.continuation;
    return (_jsxs("div", { className: "dsh-ce-stable", children: [_jsxs("dl", { className: "dsh-ce-meta", style: metaStyle, children: [_jsxs("div", { style: metaItemStyle, children: [_jsx("dt", { style: metaLabelStyle, children: section('meta.revisionLabel') }), _jsx("dd", { style: metaValueStyle, children: stable.revision })] }), _jsxs("div", { style: metaItemStyle, children: [_jsx("dt", { style: metaLabelStyle, children: section('meta.sourceCursorLabel') }), _jsx("dd", { style: metaValueStyle, children: stable.sourceCursor })] }), _jsxs("div", { style: metaItemStyle, children: [_jsx("dt", { style: metaLabelStyle, children: section('meta.digestLabel') }), _jsx("dd", { className: "dsh-ce-digest", style: { ...metaValueStyle, ...metaDigestStyle }, children: stable.digest })] })] }), _jsxs("div", { style: summaryGridStyle, children: [continuation.currentObjective === '' ? null : (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: section('section.currentObjective') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { className: "dsh-ce-objective", style: summaryTextStyle, children: continuation.currentObjective }) })] })), continuation.currentFocus === '' ? null : (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: section('section.currentFocus') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: continuation.currentFocus }) })] })), continuation.openWork.length > 0 && (_jsx(Section, { title: section('section.openWork'), items: continuation.openWork, empty: emptyNoEntries })), continuation.nextActions.length > 0 && (_jsx(Section, { title: section('section.nextActions'), items: continuation.nextActions, empty: emptyNoEntries })), stable.facts.length > 0 && (_jsx(Section, { title: section('section.facts'), items: stable.facts.map(entry => entry.content), empty: emptyNoEntries })), stable.decisions.length > 0 && (_jsx(Section, { title: section('section.decisions'), items: stable.decisions.map(entry => entry.content), empty: emptyNoEntries })), stable.constraints.length > 0 && (_jsx(Section, { title: section('section.constraints'), items: stable.constraints.map(entry => entry.content), empty: emptyNoEntries })), stable.risks.length > 0 && (_jsx(Section, { title: section('section.risks'), items: stable.risks.map(entry => entry.content), empty: emptyNoEntries })), stable.evidence.length > 0 && (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: section('section.evidence') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx(ReferenceList, { rows: stable.evidence.map(ref => ({ seq: ref.seq, text: ref.note })) }) })] })), stable.todoReferences.length > 0 && (_jsxs("section", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: section('section.todoReferences') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx(ReferenceList, { rows: stable.todoReferences.map(ref => ({ seq: ref.seq, text: ref.content })) }) })] }))] })] }));
}
/** Centered summary placeholder used while no readable stable is available. */
function EmptySummary({ title, body, className, role }) {
    return (_jsxs("div", { className: className, style: emptyCardStyle, role: role, children: [_jsx("div", { style: emptyIconStyle, "aria-hidden": "true", children: "\u2726" }), _jsx("h2", { style: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }, children: title }), _jsx("p", { style: { ...summaryTextStyle, maxWidth: 440, margin: '10px auto 0' }, children: body })] }));
}
/** Explanatory onboarding view shown when the session is not using the contextual preset. */
function NonContextualGuide({ t }) {
    return (_jsxs("div", { className: "dsh-ce dsh-ce-noncontextual", style: pageStyle, children: [_jsxs("section", { style: { padding: '24px 28px', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-state-business-primary)', fontSize: 13, fontWeight: 600 }, children: [_jsx("span", { style: { fontSize: 14 }, "aria-hidden": "true", children: "\u2726" }), _jsx("span", { children: t('empty.nonContextual.badge') })] }), _jsx("h1", { style: { margin: '8px 0 0', fontSize: 18, lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }, children: t('empty.nonContextual.title') }), _jsx("p", { style: { margin: '8px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: 720 }, children: t('empty.nonContextual.body') })] }), _jsxs("section", { style: { padding: '24px 28px', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }, children: [_jsx("h2", { style: { margin: 0, fontSize: 16, lineHeight: '22px', fontWeight: 600 }, children: t('empty.nonContextual.activateTitle') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('empty.nonContextual.activateIntro') }), _jsxs("div", { style: { marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', maxWidth: 680 }, children: [_jsx("span", { style: { fontSize: 16, lineHeight: 1, flexShrink: 0 }, children: "\uD83D\uDCA1" }), _jsxs("div", { children: [_jsxs("strong", { children: [t('empty.nonContextual.activateStep').split('：')[0], "\uFF1A"] }), _jsx("span", { style: { color: 'var(--dsw-alias-label-secondary)' }, children: t('empty.nonContextual.activateStep').split('：')[1] })] })] })] }), _jsxs("section", { style: { padding: '24px 28px 32px' }, children: [_jsx("h2", { style: { margin: 0, fontSize: 16, lineHeight: '22px', fontWeight: 600 }, children: t('empty.nonContextual.featuresTitle') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('empty.nonContextual.featuresIntro') }), _jsxs("div", { style: summaryGridStyle, children: [_jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: sectionDotStyle, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featMemory') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featMemoryDesc') }) })] }), _jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: { ...sectionDotStyle, background: '#722ed1' }, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featAnchor') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featAnchorDesc') }) })] }), _jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: { ...sectionDotStyle, background: '#20a464' }, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featPrune') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featPruneDesc') }) })] }), _jsxs("div", { style: summarySectionStyle, children: [_jsxs("div", { style: sectionTitleRowStyle, children: [_jsx("span", { style: { ...sectionDotStyle, background: '#fa8c16' }, "aria-hidden": "true" }), _jsx("h3", { style: summaryHeadingStyle, children: t('empty.nonContextual.featCompact') })] }), _jsx("div", { style: sectionContentStyle, children: _jsx("p", { style: summaryTextStyle, children: t('empty.nonContextual.featCompactDesc') }) })] })] })] })] }));
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
    const [editing, setEditing] = useState(null);
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
        summary = (_jsxs("div", { className: "dsh-ce-error", style: emptyCardStyle, role: "alert", children: [_jsx("div", { style: { ...emptyIconStyle, background: 'var(--dsw-alias-state-warn-secondary)', color: 'var(--dsw-alias-state-warn-label)' }, "aria-hidden": "true", children: "!" }), _jsx("h2", { style: { margin: 0, fontSize: 20 }, children: t('error.title') }), _jsx("p", { style: { ...summaryTextStyle, maxWidth: 520, margin: '10px auto 0' }, children: session.error ?? t('error.unknown') }), session.stable !== null && (_jsx("p", { className: "dsh-ce-stale", style: summaryTextStyle, children: t('error.staleNote') })), _jsx("button", { type: "button", style: { marginTop: 18, padding: '7px 16px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }, onClick: () => { retryTaskState(); }, children: t('error.retry') }), session.stable !== null && _jsx(StableBody, { stable: session.stable, section: key => t(key), emptyNoEntries: t('empty.noEntries') })] }));
    }
    else if (session.stable === null) {
        summary = (_jsx("div", { className: "dsh-ce-empty-stable", children: _jsx(EmptySummary, { title: t('empty.noStable.title'), body: t('empty.noStable.body') }) }));
    }
    else {
        const stable = session.stable;
        const save = async (value) => {
            if (editing === null)
                return;
            setSaving(true);
            setEditError(null);
            try {
                const result = await editTaskState({ sessionId, expectedRevision: editing.expectedRevision, value });
                if (!result.ok) {
                    setEditError(result.message);
                    return;
                }
                setEditing(null);
            }
            catch (error) {
                setEditError(String(error instanceof Error ? error.message : error));
            }
            finally {
                setSaving(false);
            }
        };
        summary = (_jsxs("div", { className: "dsh-ce-summary", children: [_jsxs("header", { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: 0, fontSize: 16 }, children: t('summary.title') }), _jsx("p", { style: { ...statusDetailStyle, marginBottom: 0 }, children: t('view.subtitle') })] }), editing === null && (_jsxs("button", { type: "button", style: editButtonStyle, onClick: () => {
                                setEditError(null);
                                setEditing({ expectedRevision: stable.revision, value: editValueOf(stable) });
                            }, children: ["\u270E ", t('edit.action')] }))] }), editing === null
                    ? isEmptyStable(stable)
                        ? _jsx(EmptySummary, { className: "dsh-ce-empty-stable", title: t('empty.noStable.title'), body: t('empty.noStable.body') })
                        : _jsx(StableBody, { stable: stable, section: key => t(key), emptyNoEntries: t('empty.noEntries') })
                    : _jsx(EditForm, { value: editing.value, saving: saving, error: editError, t: t, onCancel: () => { setEditing(null); setEditError(null); }, onSubmit: save })] }));
    }
    return (_jsxs("div", { className: "dsh-ce", style: pageStyle, children: [_jsx(StatusPanel, { evidence: evidence, stable: session.stable, t: t }), _jsx("main", { style: summaryAreaStyle, children: summary })] }));
}
//# sourceMappingURL=ContextEnhancementView.js.map