import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespace$TaskState {
        control: (signal?: AbortSignal) => AsyncIterable<unknown>;
        edit: (request: unknown) => Promise<unknown>;
    }
    interface TypertRemoteMap {
        'taskState/control': (signal?: AbortSignal) => AsyncIterable<unknown>;
        'taskState/edit': (request: unknown) => Promise<unknown>;
    }
    interface TypertRemoteNamespaceMap {
        taskState: TypertRemoteNamespace$TaskState;
    }
}
/** Client contribution for the plugin-owned taskState/control stream. */
export declare const taskStateRemoteContribution: TypertRemoteContribution;
//# sourceMappingURL=task-state-remote.d.ts.map