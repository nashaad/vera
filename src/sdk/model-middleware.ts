import type { UserQuestionUiRequest } from "../engine/events.ts";
import type { UserQuestionResult } from "../engine/inbound-command-router.ts";
import type { ModelAdapter } from "../model/types.ts";

export interface ModelAdapterContext {
    readonly sessionId: string;
    readonly sessionPath: string;
    readonly parentSessionId?: string;
    readonly workspace: string;
    readonly provider: string;
    /** `ask` is a side question that never enters the session; don't record it as a turn. */
    readonly purpose: "turn" | "ask";
    readonly notice?: (text: string) => void;
    readonly ask?: (request: Omit<UserQuestionUiRequest, "type" | "outOfBand">, signal?: AbortSignal) => Promise<UserQuestionResult>;
}

export type ModelMiddleware = (
    adapter: ModelAdapter,
    context: ModelAdapterContext,
) => ModelAdapter;
