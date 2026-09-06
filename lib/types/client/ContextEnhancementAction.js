import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useRef, useState } from 'react';
const EFFECTS = [
    { key: 'taskStateBasic', label: 'taskStateBasic', detail: 'taskStateBasicDetail', countLabel: 'evidenceSaved' },
    { key: 'taskStatePrompt', label: 'taskStatePrompt', detail: 'taskStatePromptDetail', countLabel: 'evidenceRead' },
    { key: 'toolResultPruner', label: 'toolResultPruner', detail: 'toolResultPrunerDetail', countLabel: 'evidenceGrouped' },
    { key: 'compactionBasic', label: 'compactionBasic', detail: 'compactionBasicDetail', countLabel: 'evidenceCompacted' },
];
const rootStyle = { position: 'relative', display: 'inline-flex', zIndex: 2147483000 };
const triggerStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-border-subtle, #d9dce3)', borderRadius: 7, background: 'var(--dsw-surface-primary, #fff)', color: 'var(--dsw-text-secondary, #5f6368)', cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: 1.25, padding: '6px 10px', whiteSpace: 'nowrap' };
const triggerIconStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, color: '#16834f', fontSize: 13 };
const panelStyle = { position: 'fixed', zIndex: 2147483001, width: 'min(360px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', padding: 14, border: '1px solid var(--dsw-border-subtle, #d9dce3)', borderRadius: 8, background: 'var(--dsw-surface-primary, #fff)', boxShadow: '0 10px 28px rgb(0 0 0 / 14%)', color: 'var(--dsw-text-primary, #1f2329)' };
const headingStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, fontWeight: 600 };
const introStyle = { margin: '6px 0 8px', color: 'var(--dsw-text-secondary, #6b7280)', fontSize: 12, lineHeight: 1.4 };
const rowStyle = { display: 'grid', gridTemplateColumns: '10px minmax(0, 1fr) auto', gap: 8, alignItems: 'start', padding: '10px 0', borderTop: '1px solid var(--dsw-border-subtle, #e8e9ed)' };
const dotStyle = { width: 7, height: 7, marginTop: 5, borderRadius: '50%', background: '#20a464' };
const detailStyle = { marginTop: 3, color: 'var(--dsw-text-secondary, #6b7280)', fontSize: 12, lineHeight: 1.35 };
const statusStyle = { color: '#16834f', fontSize: 12, whiteSpace: 'nowrap' };
const countStyle = { marginTop: 4, color: 'var(--dsw-text-secondary, #6b7280)', fontSize: 11, whiteSpace: 'nowrap' };
const closeStyle = { border: 0, background: 'transparent', color: 'var(--dsw-text-secondary, #6b7280)', cursor: 'pointer', font: 'inherit', fontSize: 16, lineHeight: 1, padding: 2 };
/** Render a compact, user-facing status action for contextual sessions. */
export function ContextEnhancementAction({ sessionId, useSessions, useProjection, t }) {
    const agentPreset = useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset);
    const evidence = useProjection('contextEnhancement');
    const [open, setOpen] = useState(false);
    const [triggerActive, setTriggerActive] = useState(false);
    const [panelPosition, setPanelPosition] = useState({});
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);
    const closeRef = useRef(null);
    const panelId = useId();
    const closePanel = () => {
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
    };
    useEffect(() => {
        if (!open)
            return;
        const updatePanelPosition = () => {
            const trigger = triggerRef.current;
            if (trigger === null)
                return;
            const rect = trigger.getBoundingClientRect();
            const panelWidth = Math.min(360, window.innerWidth - 24);
            const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth));
            const panelHeight = panelRef.current?.offsetHeight ?? 0;
            const below = rect.bottom + 8;
            const top = panelHeight > 0 && below + panelHeight > window.innerHeight - 12
                ? Math.max(12, rect.top - panelHeight - 8)
                : below;
            setPanelPosition({ left, top });
        };
        updatePanelPosition();
        requestAnimationFrame(() => {
            updatePanelPosition();
            closeRef.current?.focus();
        });
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);
        return () => {
            window.removeEventListener('resize', updatePanelPosition);
            window.removeEventListener('scroll', updatePanelPosition, true);
        };
    }, [open]);
    useEffect(() => {
        if (!open)
            return;
        const close = (event) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target))
                setOpen(false);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape')
                closePanel();
        };
        document.addEventListener('pointerdown', close);
        document.addEventListener('keydown', closeOnEscape);
        return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', closeOnEscape); };
    }, [open]);
    if (agentPreset !== 'contextual')
        return null;
    return _jsxs("div", { ref: rootRef, style: rootStyle, children: [_jsxs("button", { ref: triggerRef, type: "button", style: {
                    ...triggerStyle,
                    ...(triggerActive || open ? {
                        borderColor: 'var(--dsw-border-strong, #b8bdc7)',
                        background: 'var(--dsw-surface-secondary, #f5f6f8)',
                        color: 'var(--dsw-text-primary, #1f2329)',
                    } : {}),
                }, "aria-expanded": open, "aria-haspopup": "dialog", "aria-controls": panelId, "aria-label": t('trigger'), title: t('panelLabel'), onMouseEnter: () => setTriggerActive(true), onMouseLeave: () => setTriggerActive(false), onFocus: () => setTriggerActive(true), onBlur: () => setTriggerActive(false), onClick: () => { setOpen(value => !value); }, children: [_jsx("span", { style: triggerIconStyle, "aria-hidden": "true", children: "\u2726" }), t('trigger')] }), open ? _jsxs("section", { ref: panelRef, id: panelId, style: { ...panelStyle, ...panelPosition }, role: "dialog", "aria-modal": "false", "aria-label": t('panelLabel'), children: [_jsxs("div", { style: headingStyle, children: [_jsx("strong", { children: t('panelLabel') }), _jsx("button", { ref: closeRef, type: "button", style: closeStyle, "aria-label": t('close'), onClick: closePanel, children: "\u00D7" })] }), _jsx("p", { style: introStyle, children: t('intro') }), EFFECTS.map(effect => {
                        const count = effect.key === 'taskStateBasic' || effect.key === 'taskStatePrompt'
                            ? (evidence?.taskStateRequests ?? 0)
                            : (evidence?.[effect.key] ?? 0);
                        return _jsxs("div", { style: rowStyle, children: [_jsx("span", { style: dotStyle, "aria-hidden": "true" }), _jsxs("div", { children: [_jsx("div", { children: t(effect.label) }), _jsx("div", { style: detailStyle, children: t(effect.detail) })] }), _jsxs("div", { style: { textAlign: 'right' }, children: [_jsx("div", { style: statusStyle, children: t('enabled') }), _jsx("div", { style: countStyle, children: count === 0 ? t('notTriggered') : t(effect.countLabel, { count }) })] })] }, effect.label);
                    }), _jsx("div", { style: { ...detailStyle, paddingTop: 10 }, children: t('footer') })] }) : null] });
}
//# sourceMappingURL=ContextEnhancementAction.js.map