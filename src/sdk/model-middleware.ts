import type { UserQuestionUiRequest } from "../engine/events.ts";
import type { UserQuestionResult } from "../engine/inbound-command-router.ts";
import type { NoticeFacts } from "../engine/notice-facts.ts";
import type { ModelAdapter } from "../model/types.ts";

export type { NoticeFacts } from "../engine/notice-facts.ts";

/** A notice for this extension's client half to put into words. */
export interface ModelNotice {
    readonly key: string;
    readonly facts: NoticeFacts;
}

export interface ModelAdapterContext {
    readonly sessionId: string;
    readonly sessionPath: string;
    readonly parentSessionId?: string;
    readonly workspace: string;
    readonly provider: string;
    /** `ask` is a side question that never enters the session; don't record it as a turn. */
    readonly purpose: "turn" | "ask";
    readonly notice?: (notice: string | ModelNotice) => void;
    readonly ask?: (request: Omit<UserQuestionUiRequest, "type" | "outOfBand">, signal?: AbortSignal) => Promise<UserQuestionResult>;
}

export type ModelMiddleware = (
    adapter: ModelAdapter,
    context: ModelAdapterContext,
) => ModelAdapter;

/** Host-internal: pairs a middleware with the extension that registered it, so notices can carry its id. */
export interface SourcedModelMiddleware {
    readonly extensionId: string;
    readonly apply: ModelMiddleware;
}
