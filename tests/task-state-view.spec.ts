import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import React from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ContextEnhancementView } from '../src/client/ContextEnhancementView.tsx'
import { taskStateRemoteContribution } from '../src/client/task-state-remote.ts'
import { zh } from '../src/client/locales.ts'
import type { TaskStateStable } from '../src/internal/task-state/contract/types.ts'
import type { TaskStateControlSessionState } from '../src/client/task-state-control-store.ts'
import { apply, inject } from '../src/client/index.ts'

function mockStable(overrides: Partial<TaskStateStable> = {}): TaskStateStable {
  return {
    schemaVersion: 1,
    revision: 1,
    filterVersion: 'task-state-basic/filter-v2',
    sourceCursor: 42,
    digest: 'digest-12345',
    facts: [{ id: 'fact-1' as never, content: 'Fact content' }],
    decisions: [{ id: 'decision-1' as never, content: 'Decision content' }],
    constraints: [{ id: 'constraint-1' as never, content: 'Constraint content' }],
    risks: [{ id: 'risk-1' as never, content: 'Risk content' }],
    continuation: {
      currentObjective: 'Objective content',
      currentFocus: 'Focus content',
      openWork: ['Work 1'],
      nextActions: ['Action 1'],
    },
    evidence: [{ seq: 10, note: 'Evidence note' }],
    todoReferences: [{ seq: 11, content: 'Todo ref content' }],
    ...overrides,
  }
}

function createSource(state: TaskStateControlSessionState) {
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
  }
}

function translate(key: string, params?: Record<string, string | number>): string {
  const value = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? value
    : value.replace(/\{([^}]+)\}/g, (token, name: string) => String(params[name] ?? token))
}

function contextualRuntime() {
  return {
    sessionId: 'contextual' as SessionId,
    useSessions: (select: (state: unknown) => unknown) => select({
      byId: { contextual: { projectionValues: { agentPreset: 'contextual' } } },
    }),
    useProjection: () => ({
      taskStateRequests: 3,
      taskStateBasic: 0,
      taskStatePrompt: 0,
      toolResultPruner: 2,
      compactionBasic: 1,
    }),
  }
}

describe('ContextEnhancementView', () => {
  it('renders loading state when connecting', () => {
    const source = createSource({
      stable: null,
      connection: 'connecting',
      generation: 0,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: () => {},
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(html).toContain('dsh-ce-connecting')
    expect(html).toContain(zh['loading.title'])
  })

  it('renders error state with retry button and error details', () => {
    const retryFn = vi.fn()
    const source = createSource({
      stable: null,
      connection: 'error',
      error: 'Connection timed out',
      generation: 0,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: retryFn,
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(html).toContain('dsh-ce-error')
    expect(html).toContain('Connection timed out')
    expect(html).toContain(zh['error.retry'])
  })

  it('renders stale data note in error state when last stable exists', () => {
    const source = createSource({
      stable: mockStable(),
      connection: 'error',
      error: 'Stream interrupted',
      generation: 1,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: () => {},
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(html).toContain('dsh-ce-stale')
    expect(html).toContain(zh['error.staleNote'])
    expect(html).toContain('Objective content')
  })

  it('renders non-contextual empty state when stable is null', () => {
    const source = createSource({
      stable: null,
      connection: 'live',
      generation: 1,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: () => {},
        sessionId: 'non-contextual' as SessionId,
        useSessions: (select: (state: unknown) => unknown) => select({
          byId: { 'non-contextual': { projectionValues: { agentPreset: 'standard' } } },
        }),
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(html).toContain('dsh-ce-noncontextual')
    expect(html).toContain(zh['empty.nonContextual.title'])
    expect(html).toContain(zh['empty.nonContextual.body'])
    expect(html).not.toContain(zh['status.title'])
  })

  it('renders the waiting-for-summary state for a contextual Session without a stable', () => {
    const source = createSource({
      stable: null,
      connection: 'live',
      generation: 1,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: () => {},
        sessionId: 'contextual' as SessionId,
        useSessions: (select: (state: unknown) => unknown) => select({
          byId: { contextual: { projectionValues: { agentPreset: 'contextual' } } },
        }),
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(html).toContain('dsh-ce-empty-stable')
    expect(html).toContain(zh['empty.noStable.title'])
    expect(html).not.toContain(zh['empty.nonContextual.title'])
  })

  it('keeps the edit action available when a committed stable has no items', () => {
    const emptyStable = mockStable({
      facts: [],
      decisions: [],
      constraints: [],
      risks: [],
      continuation: {
        currentObjective: '',
        currentFocus: '',
        openWork: [],
        nextActions: [],
      },
      evidence: [],
      todoReferences: [],
    })
    const source = createSource({
      stable: emptyStable,
      connection: 'live',
      generation: 1,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: () => {},
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(html).toContain('dsh-ce-empty-stable')
    expect(html).toContain(zh['empty.noStable.title'])
    expect(html).toContain(zh['edit.action'])
    expect(html).toContain(zh['section.currentObjective'])
    expect(html).toContain(zh['section.risks'])
  })

  it('renders the complete summary and an edit action for a populated stable', () => {
    const populated = mockStable()
    const source = createSource({
      stable: populated,
      connection: 'live',
      generation: 1,
    })
    const html = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => source,
        retryTaskState: () => {},
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    // Meta information
    expect(html).toContain(zh['meta.revisionLabel'])
    expect(html).toContain('42')
    expect(html).toContain('digest-12345')

    // Continuation
    expect(html).toContain(zh['section.currentObjective'])
    expect(html).toContain('Objective content')
    expect(html).toContain(zh['section.currentFocus'])
    expect(html).toContain('Focus content')
    expect(html).toContain(zh['section.openWork'])
    expect(html).toContain('Work 1')
    expect(html).toContain(zh['section.nextActions'])
    expect(html).toContain('Action 1')

    // Sections
    expect(html).toContain(zh['section.facts'])
    expect(html).toContain('Fact content')
    expect(html).toContain(zh['section.decisions'])
    expect(html).toContain('Decision content')
    expect(html).toContain(zh['section.constraints'])
    expect(html).toContain('Constraint content')
    expect(html).toContain(zh['section.risks'])
    expect(html).toContain('Risk content')

    // References
    expect(html).toContain(zh['section.evidence'])
    expect(html).toContain('Evidence note')
    expect(html).toContain(zh['section.todoReferences'])
    expect(html).toContain('Todo ref content')
    expect(html).toContain('dsh-ce-seq')

    // Empty editable fields remain discoverable so users can add new entries.
    const sparseHtml = renderToString(
      React.createElement(ContextEnhancementView, {
        ...contextualRuntime(),
        useTaskState: () => createSource({
          stable: mockStable({ decisions: [], constraints: [], risks: [] }),
          connection: 'live',
          generation: 1,
        }),
        retryTaskState: () => {},
        t: translate as never,
        viewRequest: null,
      } as never),
    )
    expect(sparseHtml).toContain(zh['section.decisions'])
    expect(sparseHtml).toContain(zh['section.constraints'])
    expect(sparseHtml).toContain(zh['section.risks'])

    // The former 0.1.6 popover capabilities now live at the top of the view.
    expect(html).toContain(zh['status.title'])
    expect(html).toContain(zh['status.taskStateBasic'])
    expect(html).toContain(zh['status.taskStatePrompt'])
    expect(html).toContain(zh['status.toolResultPruner'])
    expect(html).toContain(zh['status.compactionBasic'])
    expect(html).toContain('已生成 1 版')
    expect(html).toContain('参与 3 次请求')
    expect(html).toContain('已归纳 2 组')
    expect(html).toContain('已压缩 1 次')

    // Display mode stays lightweight until the explicit edit action is used.
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
    expect(html).toContain(`<button type="button"`)
    expect(html).toContain(zh['edit.action'])
  })
})

describe('client apply and view wiring', () => {
  it('mounts its own taskState Remote namespace without a circular injection', () => {
    expect(inject).toContain('remote')
    expect(inject).not.toContain('remote.taskState')
  })

  it('uses a strict frame codec for the mounted task-state Remote contribution', () => {
    const descriptor = taskStateRemoteContribution.descriptors.find(candidate => candidate.method === 'control')!
    expect(descriptor.namespace).toBe('taskState')
    expect(descriptor.method).toBe('control')
    expect(descriptor.mode).toBe('stream')
    expect(descriptor.result.mode).toBe('strict')
    const resultCodec = descriptor.result
    if (resultCodec.mode !== 'strict') throw new Error('expected strict result codec')
    expect(() => resultCodec.schema.parse({
      type: 'baseline',
      value: { items: {} },
    })).not.toThrow()
    expect(() => resultCodec.schema.parse({ type: 'nope' })).toThrow()
  })

  it('uses strict request and result codecs for the edit Remote', () => {
    const descriptor = taskStateRemoteContribution.descriptors.find(candidate => candidate.method === 'edit')!
    expect(descriptor.namespace).toBe('taskState')
    expect(descriptor.service).toBe('taskStateControl')
    expect(descriptor.invocation).toEqual({ kind: 'direct' })
    const requestCodec = descriptor.parameters?.[0]?.codec
    if (requestCodec?.mode !== 'strict') throw new Error('expected strict request codec')
    expect(() => requestCodec.schema.parse({
      sessionId: 'session-a',
      expectedRevision: 1,
      value: {
        currentObjective: 'Objective', currentFocus: 'Focus', openWork: [], nextActions: [],
        facts: [], decisions: [], constraints: [], risks: [],
      },
    })).not.toThrow()
    expect(() => requestCodec.schema.parse({ sessionId: '', expectedRevision: 0, value: {} })).toThrow()
    const resultCodec = descriptor.result
    if (resultCodec.mode !== 'strict') throw new Error('expected strict result codec')
    expect(() => resultCodec.schema.parse({ ok: false, code: 'conflict', message: 'changed', stable: mockStable() })).not.toThrow()
    expect(() => resultCodec.schema.parse({ ok: false, code: 'unknown', message: 'bad' })).toThrow()
  })

  it('mounts the task-state contribution before consuming the stream', async () => {
    let mounted = false
    const taskState = { control: vi.fn(async function* () {}), edit: vi.fn() }
    const mockCtx: Record<string, unknown> & {
      remote: Record<string, unknown>
    } = {
      effect: vi.fn((fn: () => unknown) => fn()),
      inject: vi.fn((_services: string[], callback: (ctx: unknown) => void) => {
        expect(mounted).toBe(true)
        callback({ ...mockCtx, remote: { ...mockCtx.remote, taskState } })
        return Object.assign(Promise.resolve(), { dispose: vi.fn(async () => {}) })
      }),
      locale: { register: vi.fn(), bind: vi.fn(() => (k: string) => translate(k)) },
      slots: { inject: vi.fn(), register: vi.fn() },
      remote: {
        $mount: vi.fn(async (contribution: unknown) => {
          expect(contribution).toBe(taskStateRemoteContribution)
          mounted = true
          return async () => {}
        }),
        $stream: vi.fn(),
      },
    }
    apply(mockCtx as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mounted).toBe(true)
    expect(mockCtx.remote.$mount).toHaveBeenCalledOnce()
    expect(mockCtx.inject).toHaveBeenCalledWith(['remote.taskState'], expect.any(Function))
  })

  it('registers conversation.view with id contextEnhancement and order 5', () => {
    const registrations: Record<string, unknown> = {}
    const mockCtx = {
      effect: vi.fn(),
      locale: {
        register: vi.fn(),
        bind: vi.fn(() => (k: string) => translate(k)),
      },
      slots: {
        inject: vi.fn((_slotName: string, cb: () => void) => {
          cb()
        }),
        register: vi.fn((desc: { name: string; id: string; order: number; label: () => string }, comp: unknown) => {
          registrations[desc.id] = { desc, comp }
        }),
      },
      remote: {
        $mount: vi.fn(async () => () => {}),
        $stream: vi.fn(),
      },
    }

    apply(mockCtx as never)

    expect(mockCtx.slots.inject).toHaveBeenCalledWith('conversation.view', expect.any(Function))
    const reg = registrations['contextEnhancement'] as {
      desc: { name: string; id: string; order: number; label: () => string; inject: (id: SessionId) => { useTaskState: () => unknown; retryTaskState: () => void; editTaskState: (request: unknown) => Promise<unknown> } }
      comp: unknown
    }
    expect(reg).toBeDefined()
    expect(reg.desc.name).toBe('conversation.view')
    expect(reg.desc.id).toBe('contextEnhancement')
    expect(reg.desc.order).toBe(5)
    expect(reg.desc.label()).toBe('上下文优化')
    expect(reg.comp).toBe(ContextEnhancementView)

    const injected = reg.desc.inject('test-session' as SessionId)
    expect(typeof injected.useTaskState).toBe('function')
    expect(typeof injected.retryTaskState).toBe('function')
    expect(typeof injected.editTaskState).toBe('function')

    const source = injected.useTaskState() as { getSnapshot: () => { connection: string } }
    expect(source.getSnapshot().connection).toBe('connecting')
  })
})
