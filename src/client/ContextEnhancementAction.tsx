import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { NS, type ContextEnhancementKey } from './locales.ts'

type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>
type EffectKey = 'taskStateBasic' | 'taskStatePrompt' | 'toolResultPruner' | 'compactionBasic'
type EffectRow = Readonly<{ label: ContextEnhancementKey; detail: ContextEnhancementKey; key: EffectKey }>
const EFFECTS: readonly EffectRow[] = [
  { key: 'taskStateBasic', label: 'taskStateBasic', detail: 'taskStateBasicDetail' },
  { key: 'taskStatePrompt', label: 'taskStatePrompt', detail: 'taskStatePromptDetail' },
  { key: 'toolResultPruner', label: 'toolResultPruner', detail: 'toolResultPrunerDetail' },
  { key: 'compactionBasic', label: 'compactionBasic', detail: 'compactionBasicDetail' },
]
const rootStyle: CSSProperties = { position: 'relative', display: 'inline-flex', zIndex: 2147483000 }
const triggerStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-border-subtle, #d9dce3)', borderRadius: 7, background: 'var(--dsw-surface-primary, #fff)', color: 'var(--dsw-text-secondary, #5f6368)', cursor: 'pointer', font: 'inherit', fontSize: 12, lineHeight: 1.25, padding: '6px 10px', whiteSpace: 'nowrap' }
const triggerIconStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, color: '#16834f', fontSize: 13 }
const panelStyle: CSSProperties = { position: 'fixed', zIndex: 2147483001, width: 'min(360px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', padding: 14, border: '1px solid var(--dsw-border-subtle, #d9dce3)', borderRadius: 8, background: 'var(--dsw-surface-primary, #fff)', boxShadow: '0 10px 28px rgb(0 0 0 / 14%)', color: 'var(--dsw-text-primary, #1f2329)' }
const headingStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, fontWeight: 600 }
const introStyle: CSSProperties = { margin: '6px 0 8px', color: 'var(--dsw-text-secondary, #6b7280)', fontSize: 12, lineHeight: 1.4 }
const rowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '10px minmax(0, 1fr) auto', gap: 8, alignItems: 'start', padding: '10px 0', borderTop: '1px solid var(--dsw-border-subtle, #e8e9ed)' }
const dotStyle: CSSProperties = { width: 7, height: 7, marginTop: 5, borderRadius: '50%', background: '#20a464' }
const detailStyle: CSSProperties = { marginTop: 3, color: 'var(--dsw-text-secondary, #6b7280)', fontSize: 12, lineHeight: 1.35 }
const statusStyle: CSSProperties = { color: '#16834f', fontSize: 12, whiteSpace: 'nowrap' }
const countStyle: CSSProperties = { marginTop: 4, color: 'var(--dsw-text-secondary, #6b7280)', fontSize: 11, whiteSpace: 'nowrap' }
const closeStyle: CSSProperties = { border: 0, background: 'transparent', color: 'var(--dsw-text-secondary, #6b7280)', cursor: 'pointer', font: 'inherit', fontSize: 16, lineHeight: 1, padding: 2 }

/** Render a compact, user-facing status action for contextual sessions. */
export function ContextEnhancementAction({ sessionId, useSessions, useProjection, t }: Props) {
  const agentPreset = useSessions((state: SessionListState) => state.byId[sessionId]?.projectionValues?.agentPreset)
  const evidence = useProjection('contextEnhancement')
  const [open, setOpen] = useState(false)
  const [triggerActive, setTriggerActive] = useState(false)
  const [panelPosition, setPanelPosition] = useState<CSSProperties>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const closePanel = (): void => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  useEffect(() => {
    if (!open) return
    const updatePanelPosition = (): void => {
      const trigger = triggerRef.current
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      const panelWidth = Math.min(360, window.innerWidth - 24)
      const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth))
      const panelHeight = panelRef.current?.offsetHeight ?? 0
      const below = rect.bottom + 8
      const top = panelHeight > 0 && below + panelHeight > window.innerHeight - 12
        ? Math.max(12, rect.top - panelHeight - 8)
        : below
      setPanelPosition({ left, top })
    }
    updatePanelPosition()
    requestAnimationFrame(() => {
      updatePanelPosition()
      closeRef.current?.focus()
    })
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)
    return () => {
      window.removeEventListener('resize', updatePanelPosition)
      window.removeEventListener('scroll', updatePanelPosition, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePanel()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', closeOnEscape) }
  }, [open])
  if (agentPreset !== 'contextual') return null
  return <div ref={rootRef} style={rootStyle}>
    <button
      ref={triggerRef}
      type="button"
      style={{
        ...triggerStyle,
        ...(triggerActive || open ? {
          borderColor: 'var(--dsw-border-strong, #b8bdc7)',
          background: 'var(--dsw-surface-secondary, #f5f6f8)',
          color: 'var(--dsw-text-primary, #1f2329)',
        } : {}),
      }}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={panelId}
      aria-label={t('trigger')}
      title={t('panelLabel')}
      onMouseEnter={() => setTriggerActive(true)}
      onMouseLeave={() => setTriggerActive(false)}
      onFocus={() => setTriggerActive(true)}
      onBlur={() => setTriggerActive(false)}
      onClick={() => { setOpen(value => !value) }}
    >
      <span style={triggerIconStyle} aria-hidden="true">✦</span>{t('trigger')}
    </button>
    {open ? <section ref={panelRef} id={panelId} style={{ ...panelStyle, ...panelPosition }} role="dialog" aria-modal="false" aria-label={t('panelLabel')}>
      <div style={headingStyle}><strong>{t('panelLabel')}</strong><button ref={closeRef} type="button" style={closeStyle} aria-label={t('close')} onClick={closePanel}>×</button></div>
      <p style={introStyle}>{t('intro')}</p>
      {EFFECTS.map(effect => {
        const count = evidence?.[effect.key] ?? 0
        return <div key={effect.label} style={rowStyle}>
          <span style={dotStyle} aria-hidden="true" />
          <div><div>{t(effect.label)}</div><div style={detailStyle}>{t(effect.detail)}</div></div>
          <div style={{ textAlign: 'right' }}><div style={statusStyle}>{t('enabled')}</div><div style={countStyle}>{count === 0 ? t('notTriggered') : t('evidence', { count })}</div></div>
        </div>
      })}
      <div style={{ ...detailStyle, paddingTop: 10 }}>{t('footer')}</div>
    </section> : null}
  </div>
}
