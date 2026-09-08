var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
class FrameQueue {
    frames = [];
    waiters = [];
    closed = false;
    push(frame) {
        if (this.closed)
            return;
        const waiter = this.waiters.shift();
        if (waiter !== undefined)
            waiter.resolve({ value: frame, done: false });
        else
            this.frames.push(frame);
    }
    next(signal) {
        if (signal.aborted) {
            return Promise.reject(signal.reason ?? new Error('task-state stream aborted'));
        }
        if (this.frames.length > 0)
            return Promise.resolve({ value: this.frames.shift(), done: false });
        if (this.closed)
            return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
            const abort = () => {
                signal.removeEventListener('abort', abort);
                this.remove(resolve, reject);
                reject(signal.reason ?? new Error('task-state stream aborted'));
            };
            signal.addEventListener('abort', abort, { once: true });
            this.waiters.push({
                resolve: result => {
                    signal.removeEventListener('abort', abort);
                    resolve(result);
                },
                reject: error => {
                    signal.removeEventListener('abort', abort);
                    reject(error);
                },
            });
            if (signal.aborted)
                abort();
        });
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const waiter of this.waiters.splice(0))
            waiter.resolve({ value: undefined, done: true });
        this.frames.length = 0;
    }
    remove(resolve, reject) {
        const index = this.waiters.findIndex(waiter => waiter.resolve === resolve && waiter.reject === reject);
        if (index >= 0)
            this.waiters.splice(index, 1);
    }
}
let TaskStateControlService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _control_decorators;
    let _edit_decorators;
    return class TaskStateControlService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _control_decorators = [Remote({ mode: 'stream' })];
            _edit_decorators = [Remote('edit')];
            __esDecorate(this, null, _control_decorators, { kind: "method", name: "control", static: false, private: false, access: { has: obj => "control" in obj, get: obj => obj.control }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _edit_decorators, { kind: "method", name: "edit", static: false, private: false, access: { has: obj => "edit" in obj, get: obj => obj.edit }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['sessions', 'taskState'];
        constructor(ctx) {
            super(ctx, 'taskStateControl', { namespace: 'taskState' });
            ctx.effect(() => {
                const source = ctx.taskState;
                const dispose = source.subscribeCommitted?.((sessionId, stable) => {
                    for (const queue of this.queues)
                        queue.push({
                            type: 'update',
                            value: { sessionId, stable },
                        });
                });
                return () => {
                    dispose?.();
                    for (const queue of this.queues)
                        queue.close();
                    this.queues.clear();
                };
            }, 'task-state-control.listeners');
        }
        queues = (__runInitializers(this, _instanceExtraInitializers), new Set());
        control(signal) {
            return this.openControlStream(signal);
        }
        /** Persist a user-authored replacement and return its committed revision. */
        edit(request) {
            const source = this.ctx.taskState;
            if (source.editStable === undefined) {
                return Promise.resolve({ ok: false, code: 'unavailable', message: 'This task-state provider does not support editing.' });
            }
            return source.editStable(request);
        }
        async *openControlStream(signal) {
            if (signal.aborted)
                return;
            const queue = new FrameQueue();
            this.queues.add(queue);
            try {
                const items = {};
                for (const session of this.ctx.sessions.list()) {
                    items[session.id] = this.ctx.taskState.getStable(session.id) ?? null;
                }
                if (signal.aborted)
                    return;
                yield { type: 'baseline', value: { items } };
                while (!signal.aborted) {
                    try {
                        const item = await queue.next(signal);
                        if (item.done)
                            break;
                        yield item.value;
                    }
                    catch (error) {
                        if (signal.aborted)
                            break;
                        throw error;
                    }
                }
            }
            finally {
                this.queues.delete(queue);
                queue.close();
            }
        }
    };
})();
export { TaskStateControlService };
export default TaskStateControlService;
//# sourceMappingURL=service.js.map