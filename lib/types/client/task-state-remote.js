import { z } from 'zod';
import { taskStateStableSchema } from "../internal/task-state/contract/spec.js";
const stableOrNoneSchema = taskStateStableSchema.nullable();
const editValueSchema = z.object({
    currentObjective: z.string(),
    currentFocus: z.string(),
    openWork: z.array(z.string()),
    nextActions: z.array(z.string()),
    facts: z.array(z.string()),
    decisions: z.array(z.string()),
    constraints: z.array(z.string()),
    risks: z.array(z.string()),
}).strict();
const editRequestSchema = z.object({
    sessionId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    value: editValueSchema,
}).strict();
const editResultSchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), stable: taskStateStableSchema }).strict(),
    z.object({
        ok: z.literal(false),
        code: z.enum(['unavailable', 'not-found', 'conflict', 'invalid']),
        message: z.string(),
        stable: taskStateStableSchema.optional(),
    }).strict(),
]);
const frameSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('baseline'),
        value: z.object({
            items: z.record(z.string(), stableOrNoneSchema),
        }).strict(),
    }),
    z.object({
        type: z.literal('update'),
        value: z.object({
            sessionId: z.string().min(1),
            stable: stableOrNoneSchema,
        }).strict(),
    }),
]);
/** Client contribution for the plugin-owned taskState/control stream. */
export const taskStateRemoteContribution = {
    package: 'dsh-context-enhancement',
    descriptors: [{
            id: 'dsh-context-enhancement#taskState/control',
            service: 'taskStateControl',
            namespace: 'taskState',
            method: 'control',
            mode: 'stream',
            invocation: { kind: 'direct' },
            parameters: [],
            cancellation: { parameter: 'signal' },
            result: { mode: 'strict', typeSymbol: 'dsh-context-enhancement/TaskStateControlFrame', schema: frameSchema },
        }, {
            id: 'dsh-context-enhancement#taskState/edit',
            service: 'taskStateControl',
            namespace: 'taskState',
            method: 'edit',
            invocation: { kind: 'direct' },
            parameters: [{
                    name: 'request',
                    wire: 'request',
                    source: 'json',
                    codec: { mode: 'strict', typeSymbol: 'dsh-context-enhancement/TaskStateEditRequest', schema: editRequestSchema },
                }],
            result: { mode: 'strict', typeSymbol: 'dsh-context-enhancement/TaskStateEditResult', schema: editResultSchema },
        }],
};
//# sourceMappingURL=task-state-remote.js.map