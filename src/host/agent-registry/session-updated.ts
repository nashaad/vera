import type { UiRequest } from "../../engine/events.ts";
import type {
    SessionUpdatedHookPayload,
    SessionUpdatedModel,
    SessionWaitingOn,
} from "../../sdk/hooks.ts";
import { sessionIsSubagent } from "../../store/session-store.ts";
import { modelSelectionCleared } from "../model-catalog-settings.ts";
import { storeListedTitle } from "./session-title.ts";
import type { RegisteredAgentEntry } from "./support.ts";

export function sessionUpdatedPayload(
    entry: RegisteredAgentEntry,
    defaultProvider: string,
): SessionUpdatedHookPayload {
    const status = entry.agent.status;
    const waitingOn = status === "waiting"
        ? waitingOnOf(entry.agent.waitingRequest)
        : undefined;
    const title = storeListedTitle(entry.store);
    const context = entry.agent.context;
    const model = modelOf(entry, defaultProvider);
    return {
        type: "session_updated",
        sessionId: entry.store.header.id,
        workspace: entry.store.header.cwd,
        status,
        ...(waitingOn === undefined ? {} : { waitingOn }),
        ...(title === undefined ? {} : { title }),
        ...(context === undefined
            ? {}
            : {
                context: {
                    tokens: context.tokens,
                    ...(context.capacity === undefined
                        ? {}
                        : { capacity: context.capacity }),
                    estimated: context.estimated,
                },
            }),
        ...(model === undefined ? {} : { model }),
        spawned: sessionIsSubagent(entry.store.header),
    };
}

/** Returns the payload only when it differs from the last one sent for this entry. */
export function changedSessionUpdate(
    entry: RegisteredAgentEntry,
    defaultProvider: string,
): SessionUpdatedHookPayload | undefined {
    if (entry.ephemeral || entry.pendingPublication || entry.agent.closed) {
        return undefined;
    }
    const payload = sessionUpdatedPayload(entry, defaultProvider);
    const key = JSON.stringify(payload);
    if (key === entry.lastSessionUpdate) {
        return undefined;
    }
    entry.lastSessionUpdate = key;
    return payload;
}

function waitingOnOf(request: UiRequest | undefined): SessionWaitingOn | undefined {
    if (request === undefined) {
        return undefined;
    }
    if (request.type === "tool_approval") {
        return { kind: "approval", tool: request.toolCall.name };
    }
    if (request.type === "user_question") {
        return { kind: "question", question: request.question };
    }
    return { kind: "configuration", reason: request.reason };
}

function modelOf(
    entry: RegisteredAgentEntry,
    defaultProvider: string,
): SessionUpdatedModel | undefined {
    const settings = entry.modelSettings;
    if (modelSelectionCleared(settings) || settings.model.length === 0) {
        return undefined;
    }
    return {
        provider: settings.provider ?? defaultProvider,
        model: settings.model,
    };
}
