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

import { useState, useSyncExternalStore, type CSSProperties, type FormEvent, type ReactNode } from 'react'
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
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-base)',
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
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: '22px 28px',
  marginTop: 20,
}
const summarySectionStyle: CSSProperties = {
  minWidth: 0,
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
  padding: '7px 13px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8,
  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit', fontSize: 13, cursor: 'pointer',
}
const textareaStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minHeight: 82, padding: '10px 12px',
  border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 9,
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

type TaskStateEditDraft = Record<keyof TaskStateEditValue, string>
type TaskStateEditSession = Readonly<{
  expectedRevision: number
  value: TaskStateEditValue
}>

function editDraftOf(value: TaskStateEditValue): TaskStateEditDraft {
  return {
    currentObjective: value.currentObjective,
    currentFocus: value.currentFocus,
    openWork: value.openWork.join('\n'),
    nextActions: value.nextActions.join('\n'),
    facts: value.facts.join('\n'),
    decisions: value.decisions.join('\n'),
    constraints: value.constraints.join('\n'),
    risks: value.risks.join('\n'),
  }
}

function editValueFromDraft(draft: TaskStateEditDraft): TaskStateEditValue {
  return {
    currentObjective: draft.currentObjective.trim(),
    currentFocus: draft.currentFocus.trim(),
    openWork: splitLines(draft.openWork),
    nextActions: splitLines(draft.nextActions),
    facts: splitLines(draft.facts),
    decisions: splitLines(draft.decisions),
    constraints: splitLines(draft.constraints),
    risks: splitLines(draft.risks),
  }
}

function EditForm({ value, saving, error, t, onCancel, onSubmit }: {
  value: TaskStateEditValue
  saving: boolean
  error: string | null
  t: ContextEnhancementViewProps['t']
  onCancel: () => void
  onSubmit: (value: TaskStateEditValue) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState(() => editDraftOf(value))
  const field = (key: keyof TaskStateEditValue, label: ContextEnhancementKey, tall = false) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }}>
      <span>{t(label)}</span>
      <textarea
        style={{ ...textareaStyle, minHeight: tall ? 112 : 76 }}
        value={draft[key]}
        onChange={(event) => {
          setDraft(current => ({ ...current, [key]: event.currentTarget.value }))
        }}
      />
    </label>
  )
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void onSubmit(editValueFromDraft(draft))
  }
  return (
    <form className="dsh-ce-editor" style={{ marginTop: 20 }} onSubmit={submit}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '18px 28px' }}>
        {field('currentObjective', 'section.currentObjective')}
        {field('currentFocus', 'section.currentFocus')}
        {field('openWork', 'section.openWork', true)}
        {field('nextActions', 'section.nextActions', true)}
        {field('facts', 'section.facts', true)}
        {field('decisions', 'section.decisions', true)}
        {field('constraints', 'section.constraints', true)}
        {field('risks', 'section.risks', true)}
      </div>
      <p style={{ ...statusDetailStyle, marginBottom: 0 }}>{t('edit.linesHint')}</p>
      {error !== null && <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button type="button" style={editButtonStyle} disabled={saving} onClick={onCancel}>{t('edit.cancel')}</button>
        <button type="submit" style={{ ...editButtonStyle, borderColor: 'var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-label-primary-foreground)' }} disabled={saving}>
          {saving ? t('edit.saving') : t('edit.save')}
        </button>
      </div>
    </form>
  )
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

/** One heading+list tile of the flat summary. */
function Section({
  title,
  items,
  empty,
}: {
  title: string
  items: readonly string[]
  empty: string
}): ReactNode {
  return (
    <section style={summarySectionStyle}>
      <div style={sectionTitleRowStyle}>
        <span style={sectionDotStyle} aria-hidden="true" />
        <h3 style={summaryHeadingStyle}>{title}</h3>
      </div>
      <div style={sectionContentStyle}>
        {items.length === 0 ? <p className="dsh-ce-empty" style={summaryTextStyle}>{empty}</p> : (
          <ul style={sectionListStyle}>
            {items.map((item, index) => (
              <li key={`${index}`} style={sectionListItemStyle}>
                <span style={sectionBulletStyle} aria-hidden="true">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
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
 * @param props - section title accessor, the committed stable, and empty copy.
 * @returns the tiled summary.
 */
function StableBody({ stable, section, emptyNoEntries }: {
  stable: TaskStateStable
  section: (key: string) => string
  emptyNoEntries: string
}): ReactNode {
  const continuation = stable.continuation
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
      {continuation.currentObjective === '' ? null : (
        <section style={summarySectionStyle}>
          <div style={sectionTitleRowStyle}>
            <span style={sectionDotStyle} aria-hidden="true" />
            <h3 style={summaryHeadingStyle}>{section('section.currentObjective')}</h3>
          </div>
          <div style={sectionContentStyle}>
            <p className="dsh-ce-objective" style={summaryTextStyle}>{continuation.currentObjective}</p>
          </div>
        </section>
      )}

      {continuation.currentFocus === '' ? null : (
        <section style={summarySectionStyle}>
          <div style={sectionTitleRowStyle}>
            <span style={sectionDotStyle} aria-hidden="true" />
            <h3 style={summaryHeadingStyle}>{section('section.currentFocus')}</h3>
          </div>
          <div style={sectionContentStyle}>
            <p style={summaryTextStyle}>{continuation.currentFocus}</p>
          </div>
        </section>
      )}

      {continuation.openWork.length > 0 && (
        <Section
          title={section('section.openWork')}
          items={continuation.openWork}
          empty={emptyNoEntries}
        />
      )}

      {continuation.nextActions.length > 0 && (
        <Section
          title={section('section.nextActions')}
          items={continuation.nextActions}
          empty={emptyNoEntries}
        />
      )}

      {stable.facts.length > 0 && (
        <Section
          title={section('section.facts')}
          items={stable.facts.map(entry => entry.content)}
          empty={emptyNoEntries}
        />
      )}

      {stable.decisions.length > 0 && (
        <Section
          title={section('section.decisions')}
          items={stable.decisions.map(entry => entry.content)}
          empty={emptyNoEntries}
        />
      )}

      {stable.constraints.length > 0 && (
        <Section
          title={section('section.constraints')}
          items={stable.constraints.map(entry => entry.content)}
          empty={emptyNoEntries}
        />
      )}

      {stable.risks.length > 0 && (
        <Section
          title={section('section.risks')}
          items={stable.risks.map(entry => entry.content)}
          empty={emptyNoEntries}
        />
      )}

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
function EmptySummary({ title, body, className, role }: { title: string; body: string; className?: string; role?: 'status' | 'alert' }): ReactNode {
  return (
    <div className={className} style={emptyCardStyle} role={role}>
      <div style={emptyIconStyle} aria-hidden="true">✦</div>
      <h2 style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }}>{title}</h2>
      <p style={{ ...summaryTextStyle, maxWidth: 440, margin: '10px auto 0' }}>{body}</p>
    </div>
  )
}

/** Explanatory onboarding view shown when the session is not using the contextual preset. */
function NonContextualGuide({ t }: { t: ContextEnhancementViewProps['t'] }): ReactNode {
  return (
    <div className="dsh-ce dsh-ce-noncontextual" style={pageStyle}>
      <section style={{ padding: '24px 28px', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-state-business-primary)', fontSize: 13, fontWeight: 600 }}>
          <span style={{ fontSize: 14 }} aria-hidden="true">✦</span>
          <span>{t('empty.nonContextual.badge')}</span>
        </div>
        <h1 style={{ margin: '8px 0 0', fontSize: 18, lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {t('empty.nonContextual.title')}
        </h1>
        <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', maxWidth: 720 }}>
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
        <div style={summaryGridStyle}>
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
  const [editing, setEditing] = useState<TaskStateEditSession | null>(null)
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
        {session.stable !== null && <StableBody stable={session.stable} section={key => t(key as never)} emptyNoEntries={t('empty.noEntries')} />}
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
    const save = async (value: TaskStateEditValue): Promise<void> => {
      if (editing === null) return
      setSaving(true)
      setEditError(null)
      try {
        const result = await editTaskState({ sessionId, expectedRevision: editing.expectedRevision, value })
        if (!result.ok) {
          setEditError(result.message)
          return
        }
        setEditing(null)
      } catch (error: unknown) {
        setEditError(String(error instanceof Error ? error.message : error))
      } finally {
        setSaving(false)
      }
    }
    summary = (
      <div className="dsh-ce-summary">
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>{t('summary.title')}</h2>
            <p style={{ ...statusDetailStyle, marginBottom: 0 }}>{t('view.subtitle')}</p>
          </div>
          {editing === null && (
            <button type="button" style={editButtonStyle} onClick={() => {
              setEditError(null)
              setEditing({ expectedRevision: stable.revision, value: editValueOf(stable) })
            }}>
              ✎ {t('edit.action')}
            </button>
          )}
        </header>
        {editing === null
          ? isEmptyStable(stable)
            ? <EmptySummary className="dsh-ce-empty-stable" title={t('empty.noStable.title')} body={t('empty.noStable.body')} />
            : <StableBody stable={stable} section={key => t(key as never)} emptyNoEntries={t('empty.noEntries')} />
          : <EditForm value={editing.value} saving={saving} error={editError} t={t} onCancel={() => { setEditing(null); setEditError(null) }} onSubmit={save} />}
      </div>
    )
  }

  return (
    <div className="dsh-ce" style={pageStyle}>
      <StatusPanel evidence={evidence} stable={session.stable} t={t} />
      <main style={summaryAreaStyle}>{summary}</main>
    </div>
  )
}
