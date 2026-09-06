import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type ContextEnhancementKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        contextEnhancement: ContextEnhancementKey;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map