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

import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { TaskStateStable } from '../internal/task-state/contract/types.ts'
import type { ContextEnhancementEvidence } from '../effect-projection.ts'
import type { TaskStateControlSessionState } from './task-state-control-store.ts'
import type { ContextEnhancementKey, NS } from './locales.ts'
import type { TaskStateEditRequest, TaskStateEditResult, TaskStateEditValue } from '../internal/task-state/control/types.ts'

/** Owner currency of the conversation-view entry (rendered one at a time). */
export type ContextEnhancementViewOwnerProps = {
  /** Focus request addressed to the selected View (currently unused). */
  readonly viewRequest: { readonly view: string; readonly focus: string } | null
}

/** Full props the conversation-view entry composes for this tab. */
export type ContextEnhancementViewProps =
  PropsRuntime<'conversation.view'>
  & {
    /** Per-Session source over the shared task-state mirror (entry-injected). */
    useTaskState: () => HostObservable<TaskStateControlSessionState>
    /** Retry after a terminal stream failure (entry-injected). */
    retryTaskState: () => void
    /** Commit a user-authored stable replacement through the Host. */
    editTaskState: (request: TaskStateEditRequest) => Promise<TaskStateEditResult>
  }
  & PropsLocale<typeof NS>

type EffectKey = 'taskStateBasic' | 'taskStatePrompt' | 'toolResultPruner' | 'compactionBasic'
type EffectRow = Readonly<{
  key: EffectKey
  label: ContextEnhancementKey
  detail: ContextEnhancementKey
  countLabel: ContextEnhancementKey
}>

const EDITABLE_FIELDS: readonly Readonly<{
  key: keyof TaskStateEditValue
  label: ContextEnhancementKey
}>[] = [
  { key: 'currentObjective', label: 'section.currentObjective' },
  { key: 'currentFocus', label: 'section.currentFocus' },
  { key: 'openWork', label: 'section.openWork' },
  { key: 'nextActions', label: 'section.nextActions' },
  { key: 'facts', label: 'section.facts' },
  { key: 'decisions', label: 'section.decisions' },
  { key: 'constraints', label: 'section.constraints' },
  { key: 'risks', label: 'section.risks' },
]

const EFFECTS: readonly EffectRow[] = [
  { key: 'taskStateBasic', label: 'status.taskStateBasic', detail: 'status.taskStateBasicDetail', countLabel: 'status.evidenceSaved' },
  { key: 'taskStatePrompt', label: 'status.taskStatePrompt', detail: 'status.taskStatePromptDetail', countLabel: 'status.evidenceRequests' },
  { key: 'toolResultPruner', label: 'status.toolResultPruner', detail: 'status.toolResultPrunerDetail', countLabel: 'status.evidenceGrouped' },
  { key: 'compactionBasic', label: 'status.compactionBasic', detail: 'status.compactionBasicDetail', countLabel: 'status.evidenceCompacted' },
]

const statusPanelStyle: CSSProperties = {
  padding: '24px 28px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
  background: 'var(--dsw-alias-bg-base)',
}
const statusInnerStyle: CSSProperties = {
  margin: '0 auto',
}
const statusGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  gap: '18px 28px',
  marginTop: 20,
}
const statusRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '9px minmax(0, 1fr) auto',
  gap: 10,
  alignItems: 'start',
}
const statusDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  marginTop: 7,
  borderRadius: '50%',
  background: '#20a464',
}
const statusDetailStyle: CSSProperties = {
  marginTop: 4,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: 1.4,
}
const statusEnabledStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
  fontSize: 12,
  textAlign: 'right',
  whiteSpace: 'nowrap',
}
const statusCountStyle: CSSProperties = {
  marginTop: 5,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 11,
}
const pageStyle: CSSProperties = {
  minHeight: '100%',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
}
const summaryAreaStyle: CSSProperties = {
  margin: '0 auto',
  padding: '24px 28px 32px',
}
const emptyCardStyle: CSSProperties = {
  maxWidth: 580,
  margin: '24px auto 0',
  padding: '44px 28px',
  textAlign: 'center',
}
const emptyIconStyle: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 44,
  height: 44,
  margin: '0 auto 16px',
  borderRadius: 12,
  background: 'var(--dsw-alias-state-business-tertiary)',
  color: 'var(--dsw-alias-state-business-primary)',
  fontSize: 20,
}
const summaryGridStyle: CSSProperties = {
  columns: '260px',
  columnGap: 28,
  marginTop: 20,
}
const featuresGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: '22px 28px',
  marginTop: 20,
}
const summarySectionStyle: CSSProperties = {
  display: 'inline-block',
  width: '100%',
  breakInside: 'avoid',
  marginBottom: 24,
  verticalAlign: 'top',
  boxSizing: 'border-box',
}
const sectionTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}
const sectionDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: 'var(--dsw-alias-state-business-primary)',
  flexShrink: 0,
}
const summaryHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
}
const sectionContentStyle: CSSProperties = {
  paddingLeft: 17,
  marginTop: 8,
}
const summaryTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  lineHeight: 1.6,
}
const editButtonStyle: CSSProperties = {
  padding: '6px 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const sectionEditButtonStyle: CSSProperties = {
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
}
const textareaStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minHeight: 82, padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8,
  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
  font: 'inherit', fontSize: 13, lineHeight: 1.55, resize: 'vertical',
}

function editValueOf(stable: TaskStateStable): TaskStateEditValue {
  return {
    currentObjective: stable.continuation.currentObjective,
    currentFocus: stable.continuation.currentFocus,
    openWork: stable.continuation.openWork,
    nextActions: stable.continuation.nextActions,
    facts: stable.facts.map(entry => entry.content),
    decisions: stable.decisions.map(entry => entry.content),
    constraints: stable.constraints.map(entry => entry.content),
    risks: stable.risks.map(entry => entry.content),
  }
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(item => item.length > 0)
}

type ActiveFieldEdit = Readonly<{
  field: keyof TaskStateEditValue
  draft: string
  expectedRevision: number
}>

function editDraftFor(stable: TaskStateStable, field: keyof TaskStateEditValue): string {
  switch (field) {
    case 'currentObjective': return stable.continuation.currentObjective
    case 'currentFocus': return stable.continuation.currentFocus
    case 'openWork': return stable.continuation.openWork.join('\n')
    case 'nextActions': return stable.continuation.nextActions.join('\n')
    case 'facts': return stable.facts.map(e => e.content).join('\n')
    case 'decisions': return stable.decisions.map(e => e.content).join('\n')
    case 'constraints': return stable.constraints.map(e => e.content).join('\n')
    case 'risks': return stable.risks.map(e => e.content).join('\n')
  }
}

function updateEditValue(base: TaskStateEditValue, field: keyof TaskStateEditValue, draft: string): TaskStateEditValue {
  switch (field) {
    case 'currentObjective': return { ...base, currentObjective: draft.trim() }
    case 'currentFocus': return { ...base, currentFocus: draft.trim() }
    case 'openWork': return { ...base, openWork: splitLines(draft) }
    case 'nextActions': return { ...base, nextActions: splitLines(draft) }
    case 'facts': return { ...base, facts: splitLines(draft) }
    case 'decisions': return { ...base, decisions: splitLines(draft) }
    case 'constraints': return { ...base, constraints: splitLines(draft) }
    case 'risks': return { ...base, risks: splitLines(draft) }
  }
}
const sectionListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
}
const sectionListItemStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '12px minmax(0, 1fr)',
  gap: 6,
  alignItems: 'start',
  marginTop: 6,
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
}
const sectionBulletStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  userSelect: 'none',
  textAlign: 'center',
}
const metaStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px 20px',
  margin: '12px 0 0',
  padding: 0,
}
const metaItemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
}
const metaLabelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
}
const metaValueStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontWeight: 500,
}
const metaDigestStyle: CSSProperties = {
  maxWidth: 240,
  overflow: 'hidden',
  fontFamily: 'var(--dsw-font-mono, monospace)',
  fontSize: 11,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-secondary)',
}
const seqBadgeStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, monospace)',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

/** Four contextual capabilities formerly shown in the removed header popover. */
function StatusPanel({ evidence, stable, t }: {
  evidence: ContextEnhancementEvidence | undefined
  stable: TaskStateStable | null
  t: ContextEnhancementViewProps['t']
}): ReactNode {
  const countFor = (key: EffectKey): number => {
    if (key === 'taskStateBasic') return stable?.revision ?? 0
    if (key === 'taskStatePrompt') return evidence?.taskStateRequests ?? 0
    return evidence?.[key] ?? 0
  }
  return (
    <section className="dsh-ce-status" style={statusPanelStyle} aria-labelledby="dsh-ce-status-title">
      <div style={statusInnerStyle}>
        <h2 id="dsh-ce-status-title" style={{ margin: 0, fontSize: 16 }}>{t('status.title')}</h2>
        <p style={{ ...statusDetailStyle, marginBottom: 0 }}>{t('status.intro')}</p>
        <div style={statusGridStyle}>
          {EFFECTS.map(effect => {
            const count = countFor(effect.key)
            return (
              <div key={effect.key} style={statusRowStyle}>
                <span style={statusDotStyle} aria-hidden="true" />
                <div>
                  <div>{t(effect.label)}</div>
                  <div style={statusDetailStyle}>{t(effect.detail)}</div>
                </div>
                <div style={statusEnabledStyle}>
                  <div>{t('status.enabled')}</div>
                  <div style={statusCountStyle}>
                    {count === 0 ? t('status.notTriggered') : t(effect.countLabel, { count })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/** One heading+list or heading+text tile of the flat summary with inline editing support. */
function SummarySection({
  title,
  fieldKey,
  items,
  text,
  editingField,
  saving,
  editError,
  t,
  onStartEdit,
  onUpdateDraft,
  onSave,
  onCancel,
  empty,
}: {
  title: string
  fieldKey: keyof TaskStateEditValue
  items?: readonly string[] | undefined
  text?: string | undefined
  editingField: ActiveFieldEdit | null
  saving: boolean
  editError: string | null
  t: ContextEnhancementViewProps['t']
  onStartEdit?: ((field: keyof TaskStateEditValue) => void) | undefined
  onUpdateDraft?: ((draft: string) => void) | undefined
  onSave?: (() => Promise<void>) | undefined
  onCancel?: (() => void) | undefined
  empty: string
}): ReactNode {
  const isEditing = editingField?.field === fieldKey
  const isList = items !== undefined

  return (
    <section style={summarySectionStyle}>
      <div style={sectionTitleRowStyle}>
        <span style={sectionDotStyle} aria-hidden="true" />
        <h3 style={summaryHeadingStyle}>{title}</h3>
        {!isEditing && onStartEdit && (
          <button
            type="button"
            className="dsh-ce-section-edit"
            style={sectionEditButtonStyle}
            title={t('edit.action')}
            aria-label={`${t('edit.action')} ${title}`}
            onClick={() => onStartEdit(fieldKey)}
          >
            ✎ {t('edit.action')}
          </button>
        )}
      </div>
      <div style={sectionContentStyle}>
        {isEditing && onUpdateDraft && onSave && onCancel ? (
          <div>
            <textarea
              style={{
                ...textareaStyle,
                minHeight: isList ? 112 : 72,
              }}
              value={editingField.draft}
              onChange={(event) => onUpdateDraft(event.currentTarget.value)}
              disabled={saving}
              autoFocus
            />
            {isList && (
              <p style={{ ...statusDetailStyle, marginTop: 4, marginBottom: 0 }}>
                {t('edit.linesHint')}
              </p>
            )}
            {editError !== null && (
              <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '4px 0 0' }}>
                {editError}
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                style={editButtonStyle}
                disabled={saving}
                onClick={onCancel}
              >
                {t('edit.cancel')}
              </button>
              <button
                type="button"
                style={{
                  ...editButtonStyle,
                  borderColor: 'var(--dsw-alias-state-business-primary)',
                  background: 'var(--dsw-alias-state-business-primary)',
                  color: 'var(--dsw-alias-label-primary-foreground)',
                }}
                disabled={saving}
                onClick={() => { void onSave() }}
              >
                {saving ? t('edit.saving') : t('edit.save')}
              </button>
            </div>
          </div>
        ) : text !== undefined && text !== '' ? (
          <p className={fieldKey === 'currentObjective' ? 'dsh-ce-objective' : undefined} style={summaryTextStyle}>
            {text}
          </p>
        ) : items !== undefined && items.length > 0 ? (
          <ul style={sectionListStyle}>
            {items.map((item, index) => (
              <li key={`${index}`} style={sectionListItemStyle}>
                <span style={sectionBulletStyle} aria-hidden="true">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dsh-ce-empty" style={summaryTextStyle}>{empty}</p>
        )}
      </div>
    </section>
  )
}

/** Read-only reference line (evidence / todo reference). */
function ReferenceList({ rows }: { rows: readonly { seq: number; text: string }[] }): ReactNode {
  if (rows.length === 0) return null
  return (
    <ul style={sectionListStyle}>
      {rows.map((row, index) => (
        <li key={`${index}`} className="dsh-ce-reference" style={sectionListItemStyle}>
          <span className="dsh-ce-seq" style={seqBadgeStyle}>#{row.seq}</span>
          <span>{row.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** True when a committed stable carries no durable content at all. */
function isEmptyStable(stable: TaskStateStable): boolean {
  return stable.facts.length === 0
    && stable.decisions.length === 0
    && stable.constraints.length === 0
    && stable.risks.length === 0
    && stable.continuation.currentObjective === ''
    && stable.continuation.currentFocus === ''
    && stable.continuation.openWork.length === 0
    && stable.continuation.nextActions.length === 0
    && stable.evidence.length === 0
    && stable.todoReferences.length === 0
}

/**
 * The flat display body of one committed stable.
 * @param props - section title accessor, the committed stable, and editing handlers.
 * @returns the tiled summary.
 */
function StableBody({
  stable,
  section,
  t,
  editingField = null,
  saving = false,
  editError = null,
  onStartEdit,
  onUpdateDraft,
  onSave,
  onCancel,
}: {
  stable: TaskStateStable
  section: (key: string) => string
  t: ContextEnhancementViewProps['t']
  editingField?: ActiveFieldEdit | null | undefined
  saving?: boolean | undefined
  editError?: string | null | undefined
  onStartEdit?: ((field: keyof TaskStateEditValue) => void) | undefined
  onUpdateDraft?: ((draft: string) => void) | undefined
  onSave?: (() => Promise<void>) | undefined
  onCancel?: (() => void) | undefined
}): ReactNode {
  const continuation = stable.continuation

  const renderSection = (
    fieldKey: keyof TaskStateEditValue,
    titleKey: string,
    options: { text?: string | undefined; items?: readonly string[] | undefined },
  ): ReactNode => {
    const isEditing = editingField?.field === fieldKey
    const hasContent = options.text !== undefined
      ? options.text !== ''
      : (options.items !== undefined && options.items.length > 0)

    if (!hasContent && !isEditing && onStartEdit === undefined) return null

    return (
      <SummarySection
        key={fieldKey}
        title={section(titleKey)}
        fieldKey={fieldKey}
        items={options.items}
        text={options.text}
        editingField={editingField}
        saving={saving}
        editError={editError}
        t={t}
        onStartEdit={onStartEdit}
        onUpdateDraft={onUpdateDraft}
        onSave={onSave}
        onCancel={onCancel}
        empty={t('empty.noEntries')}
      />
    )
  }

  return (
    <div className="dsh-ce-stable">
      <dl className="dsh-ce-meta" style={metaStyle}>
        <div style={metaItemStyle}>
          <dt style={metaLabelStyle}>{section('meta.revisionLabel')}</dt>
          <dd style={metaValueStyle}>{stable.revision}</dd>
        </div>
        <div style={metaItemStyle}>
          <dt style={metaLabelStyle}>{section('meta.sourceCursorLabel')}</dt>
          <dd style={metaValueStyle}>{stable.sourceCursor}</dd>
        </div>
        <div style={metaItemStyle}>
          <dt style={metaLabelStyle}>{section('meta.digestLabel')}</dt>
          <dd className="dsh-ce-digest" style={{ ...metaValueStyle, ...metaDigestStyle }}>{stable.digest}</dd>
        </div>
      </dl>

      <div style={summaryGridStyle}>
        {renderSection('currentObjective', 'section.currentObjective', { text: continuation.currentObjective })}
        {renderSection('currentFocus', 'section.currentFocus', { text: continuation.currentFocus })}
        {renderSection('openWork', 'section.openWork', { items: continuation.openWork })}
        {renderSection('nextActions', 'section.nextActions', { items: continuation.nextActions })}
        {renderSection('facts', 'section.facts', { items: stable.facts.map(entry => entry.content) })}
        {renderSection('decisions', 'section.decisions', { items: stable.decisions.map(entry => entry.content) })}
        {renderSection('constraints', 'section.constraints', { items: stable.constraints.map(entry => entry.content) })}
        {renderSection('risks', 'section.risks', { items: stable.risks.map(entry => entry.content) })}

        {stable.evidence.length > 0 && (
          <section style={summarySectionStyle}>
            <div style={sectionTitleRowStyle}>
              <span style={sectionDotStyle} aria-hidden="true" />
              <h3 style={summaryHeadingStyle}>{section('section.evidence')}</h3>
            </div>
            <div style={sectionContentStyle}>
              <ReferenceList
                rows={stable.evidence.map(ref => ({ seq: ref.seq, text: ref.note }))}
              />
            </div>
          </section>
        )}

        {stable.todoReferences.length > 0 && (
          <section style={summarySectionStyle}>
            <div style={sectionTitleRowStyle}>
              <span style={sectionDotStyle} aria-hidden="true" />
              <h3 style={summaryHeadingStyle}>{section('section.todoReferences')}</h3>
            </div>
            <div style={sectionContentStyle}>
              <ReferenceList
                rows={stable.todoReferences.map(ref => ({ seq: ref.seq, text: ref.content }))}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/** Centered summary placeholder used while no readable stable is available. */
function EmptySummary({ title, body, className, role, action }: {
  title: string
  body: string
  className?: string
  role?: 'status' | 'alert'
  action?: ReactNode
}): ReactNode {
  return (
    <div className={className} style={emptyCardStyle} role={role}>
      <div style={emptyIconStyle} aria-hidden="true">✦</div>
      <h2 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }}>{title}</h2>
      <p style={{ ...summaryTextStyle, maxWidth: 440, margin: '10px auto 0' }}>{body}</p>
      {action}
    </div>
  )
}

/** Explanatory onboarding view shown when the session is not using the contextual preset. */
function NonContextualGuide({ t }: { t: ContextEnhancementViewProps['t'] }): ReactNode {
  return (
    <div className="dsh-ce dsh-ce-noncontextual" style={pageStyle} data-conversation-composer-overlay="">
      <section style={{ padding: '36px 28px 32px', textAlign: 'center', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }}>
        <div style={emptyIconStyle} aria-hidden="true">✦</div>
        <div style={{ color: 'var(--dsw-alias-state-business-primary)', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          {t('empty.nonContextual.badge')}
        </div>
        <h1 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {t('empty.nonContextual.title')}
        </h1>
        <p style={{ margin: '10px auto 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: 620 }}>
          {t('empty.nonContextual.body')}
        </p>
      </section>

      <section style={{ padding: '24px 28px', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }}>
        <h2 style={{ margin: 0, fontSize: 16, lineHeight: '22px', fontWeight: 600 }}>
          {t('empty.nonContextual.activateTitle')}
        </h2>
        <p style={{ ...statusDetailStyle, marginBottom: 0 }}>
          {t('empty.nonContextual.activateIntro')}
        </p>
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', maxWidth: 680 }}>
          <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>💡</span>
          <div>
            <strong>{t('empty.nonContextual.activateStep').split('：')[0]}：</strong>
            <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('empty.nonContextual.activateStep').split('：')[1]}</span>
          </div>
        </div>
      </section>

      <section style={{ padding: '24px 28px 32px' }}>
        <h2 style={{ margin: 0, fontSize: 16, lineHeight: '22px', fontWeight: 600 }}>
          {t('empty.nonContextual.featuresTitle')}
        </h2>
        <p style={{ ...statusDetailStyle, marginBottom: 0 }}>
          {t('empty.nonContextual.featuresIntro')}
        </p>
        <div style={featuresGridStyle}>
          <div style={summarySectionStyle}>
            <div style={sectionTitleRowStyle}>
              <span style={sectionDotStyle} aria-hidden="true" />
              <h3 style={summaryHeadingStyle}>{t('empty.nonContextual.featMemory')}</h3>
            </div>
            <div style={sectionContentStyle}>
              <p style={summaryTextStyle}>{t('empty.nonContextual.featMemoryDesc')}</p>
            </div>
          </div>

          <div style={summarySectionStyle}>
            <div style={sectionTitleRowStyle}>
              <span style={{ ...sectionDotStyle, background: '#722ed1' }} aria-hidden="true" />
              <h3 style={summaryHeadingStyle}>{t('empty.nonContextual.featAnchor')}</h3>
            </div>
            <div style={sectionContentStyle}>
              <p style={summaryTextStyle}>{t('empty.nonContextual.featAnchorDesc')}</p>
            </div>
          </div>

          <div style={summarySectionStyle}>
            <div style={sectionTitleRowStyle}>
              <span style={{ ...sectionDotStyle, background: '#20a464' }} aria-hidden="true" />
              <h3 style={summaryHeadingStyle}>{t('empty.nonContextual.featPrune')}</h3>
            </div>
            <div style={sectionContentStyle}>
              <p style={summaryTextStyle}>{t('empty.nonContextual.featPruneDesc')}</p>
            </div>
          </div>

          <div style={summarySectionStyle}>
            <div style={sectionTitleRowStyle}>
              <span style={{ ...sectionDotStyle, background: '#fa8c16' }} aria-hidden="true" />
              <h3 style={summaryHeadingStyle}>{t('empty.nonContextual.featCompact')}</h3>
            </div>
            <div style={sectionContentStyle}>
              <p style={summaryTextStyle}>{t('empty.nonContextual.featCompactDesc')}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * The "上下文优化" conversation view tab.
 * @param props - session kit, per-Session task-state source, locale seat.
 * @returns the summary surface with a revision-controlled editor.
 */
export function ContextEnhancementView({
  sessionId, useSessions, useProjection, useTaskState, retryTaskState, editTaskState, t,
}: ContextEnhancementViewProps) {
  const source = useTaskState()
  const session = useSyncExternalStore<TaskStateControlSessionState>(source.subscribe, source.getSnapshot, source.getSnapshot)
  const agentPreset = useSessions((state: SessionListState) => state.byId[sessionId]?.projectionValues?.agentPreset)
  const evidence = useProjection('contextEnhancement')
  const [editingField, setEditingField] = useState<ActiveFieldEdit | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const connection = session.connection

  if (agentPreset !== 'contextual') {
    return <NonContextualGuide t={t} />
  }

  let summary: ReactNode

  if (connection === 'connecting') {
    summary = (
      <EmptySummary className="dsh-ce-connecting" title={t('loading.title')} body={t('loading.body')} role="status" />
    )
  } else if (connection === 'error') {
    summary = (
      <div className="dsh-ce-error" style={emptyCardStyle} role="alert">
        <div style={{ ...emptyIconStyle, background: 'var(--dsw-alias-state-warn-secondary)', color: 'var(--dsw-alias-state-warn-label)' }} aria-hidden="true">!</div>
        <h2 style={{ margin: 0, fontSize: 20 }}>{t('error.title')}</h2>
        <p style={{ ...summaryTextStyle, maxWidth: 520, margin: '10px auto 0' }}>{session.error ?? t('error.unknown')}</p>
        {session.stable !== null && (
          <p className="dsh-ce-stale" style={summaryTextStyle}>{t('error.staleNote')}</p>
        )}
        <button type="button" style={{ marginTop: 18, padding: '7px 16px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }} onClick={() => { retryTaskState() }}>
          {t('error.retry')}
        </button>
        {session.stable !== null && <StableBody stable={session.stable} section={key => t(key as never)} t={t} />}
      </div>
    )
  } else if (session.stable === null) {
    summary = (
      <div className="dsh-ce-empty-stable">
        <EmptySummary title={t('empty.noStable.title')} body={t('empty.noStable.body')} />
      </div>
    )
  } else {
    const stable = session.stable

    const startEdit = (field: keyof TaskStateEditValue) => {
      setEditError(null)
      setEditingField({
        field,
        draft: editDraftFor(stable, field),
        expectedRevision: stable.revision,
      })
    }

    const saveEdit = async () => {
      if (editingField === null) return
      setSaving(true)
      setEditError(null)
      try {
        const fullValue = editValueOf(stable)
        const updatedValue = updateEditValue(fullValue, editingField.field, editingField.draft)
        const result = await editTaskState({
          sessionId,
          expectedRevision: editingField.expectedRevision,
          value: updatedValue,
        })
        if (!result.ok) {
          setEditError(result.message)
          return
        }
        setEditingField(null)
      } catch (error: unknown) {
        setEditError(String(error instanceof Error ? error.message : error))
      } finally {
        setSaving(false)
      }
    }

    summary = (
      <div className="dsh-ce-summary">
        <header>
          <h2 style={{ margin: 0, fontSize: 16 }}>{t('summary.title')}</h2>
          <p style={{ ...statusDetailStyle, marginBottom: 0 }}>{t('view.subtitle')}</p>
        </header>
        {isEmptyStable(stable) && editingField === null ? (
          <div className="dsh-ce-empty-stable">
            <EmptySummary
              title={t('empty.noStable.title')}
              body={t('empty.noStable.body')}
              action={
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 18 }}>
                  {EDITABLE_FIELDS.map(field => (
                    <button
                      key={field.key}
                      type="button"
                      style={editButtonStyle}
                      title={`${t('edit.action')} ${t(field.label)}`}
                      aria-label={`${t('edit.action')} ${t(field.label)}`}
                      onClick={() => startEdit(field.key)}
                    >
                      ✎ {t(field.label)}
                    </button>
                  ))}
                </div>
              }
            />
          </div>
        ) : (
          <StableBody
            stable={stable}
            section={key => t(key as never)}
            t={t}
            editingField={editingField}
            saving={saving}
            editError={editError}
            onStartEdit={startEdit}
            onUpdateDraft={draft => setEditingField(curr => curr ? { ...curr, draft } : null)}
            onSave={saveEdit}
            onCancel={() => {
              setEditingField(null)
              setEditError(null)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="dsh-ce" style={pageStyle} data-conversation-composer-overlay="">
      <StatusPanel evidence={evidence} stable={session.stable} t={t} />
      <main style={summaryAreaStyle}>{summary}</main>
    </div>
  )
}
