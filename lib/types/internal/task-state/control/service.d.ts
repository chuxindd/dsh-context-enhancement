import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TaskStateControlFrame, TaskStateEditRequest, TaskStateEditResult } from './types.ts';
export declare class TaskStateControlService extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    private readonly queues;
    control(signal: AbortSignal): AsyncIterable<TaskStateControlFrame>;
    /** Persist a user-authored replacement and return its committed revision. */
    edit(request: TaskStateEditRequest): Promise<TaskStateEditResult>;
    private openControlStream;
}
export default TaskStateControlService;
//# sourceMappingURL=service.d.ts.map