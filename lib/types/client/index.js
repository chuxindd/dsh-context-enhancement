import { ContextEnhancementView } from "./ContextEnhancementView.js";
import { TaskStateControlMirror, createTaskStateControlSessionSource } from "./task-state-control-store.js";
import { taskStateRemoteContribution } from "./task-state-remote.js";
import { en, NS, zh } from "./locales.js";
export const inject = ['locale', 'slots', 'remote'];
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-enhancement: dictionaries');
    let mounted = false;
    let taskStateRemote;
    const mirror = new TaskStateControlMirror({
        open: signal => {
            const remote = taskStateRemote;
            if (!mounted || remote === undefined) {
                return undefined;
            }
            if (typeof ctx.remote.$stream === 'function') {
                return ctx.remote.$stream({
                    name: 'dsh-context-enhancement/task-state-control',
                    open: s => remote.control(s),
                    ended: accepted => new Error(accepted ? 'task-state control stream ended' : 'task-state control baseline missing'),
                });
            }
            return remote.control(signal);
        },
    });
    const sources = new Map();
    const getSessionSource = (sessionId) => {
        let source = sources.get(sessionId);
        if (source === undefined) {
            source = createTaskStateControlSessionSource(mirror, sessionId);
            sources.set(sessionId, source);
        }
        return source;
    };
    ctx.effect(() => {
        let disposeMount;
        let taskStateScope;
        let cancelled = false;
        const start = async () => {
            try {
                disposeMount = await ctx.remote.$mount(taskStateRemoteContribution);
                if (cancelled) {
                    disposeMount?.();
                    return;
                }
                taskStateScope = ctx.inject(['remote.taskState'], (remoteCtx) => {
                    taskStateRemote = remoteCtx.remote.taskState;
                });
                await taskStateScope;
                if (cancelled) {
                    await taskStateScope.dispose();
                    disposeMount?.();
                    return;
                }
                mounted = true;
                mirror.start();
            }
            catch (error) {
                ctx.logger?.warn?.(`context-enhancement: remote mount failed: ${String(error)}`);
            }
        };
        void start();
        return async () => {
            cancelled = true;
            mounted = false;
            taskStateRemote = undefined;
            await mirror.dispose();
            await taskStateScope?.dispose();
            await disposeMount?.();
            sources.clear();
        };
    }, 'context-enhancement: task-state mirror');
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'contextEnhancement',
        order: 5,
        locale: NS,
        label: () => ctx.locale.bind(NS)('view.contextEnhancement'),
        inject: (sessionId) => ({
            useTaskState: () => getSessionSource(sessionId),
            retryTaskState: () => { mirror.retry(); },
            editTaskState: (request) => {
                const remote = taskStateRemote;
                if (!mounted || remote === undefined) {
                    return Promise.resolve({ ok: false, code: 'unavailable', message: 'Task-state connection is unavailable.' });
                }
                return remote.edit(request);
            },
        }),
    }, ContextEnhancementView));
}
//# sourceMappingURL=index.js.map