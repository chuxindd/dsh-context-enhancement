import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>;
/** Render a compact, user-facing status action for contextual sessions. */
export declare function ContextEnhancementAction({ sessionId, useSessions, useProjection, t }: Props): import("react").JSX.Element | null;
export {};
//# sourceMappingURL=ContextEnhancementAction.d.ts.map