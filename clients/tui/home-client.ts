import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
    HistoryUpdate,
} from "../../src/engine/protocol.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { TuiAgentClient } from "./agent-client.ts";

export interface HomeClient extends TuiAgentClient {
    readonly viewOnly: true;
    readonly home: true;
}

export function isHomeClient(client: TuiAgentClient): client is HomeClient {
    return client.home === true;
}

export interface HomeClientOptions {
    readonly readModelSettings?: (
        workspace: string,
    ) => Promise<ModelTurnSettings | undefined>;
    readonly refreshCatalog?: (
        provider: string,
        workspace: string,
    ) => Promise<ModelTurnSettings | undefined>;
}

export function createHomeClient(
    workspace: string,
    options: HomeClientOptions = {},
): HomeClient {
    const outgoing = new AsyncQueue<AgentUpdate>();
    const history: HistoryUpdate = { type: "history", entries: [], seq: 0 };
    outgoing.push(history);
    const client: HomeClient = {
        workspace,
        viewOnly: true,
        home: true,
        async send(command: ClientCommand): Promise<void> {
            if (command.type === "get_model_settings") {
                await answerModelSettings(command.requestId);
                return;
            }
            if (command.type === "catalog_refresh") {
                await answerCatalogRefresh(command.requestId, command.provider);
                return;
            }
            if (!commandNeedsRunningLoop(command)) {
                return;
            }
            throw new Error("There is no conversation open yet");
        },
        receive(signal) {
            return outgoing.receive(signal);
        },
        async detach(): Promise<void> {
            client.close();
        },
        close(): void {
            closed = true;
            outgoing.fail(new Error("Home closed"), { discardBuffered: true });
        },
    };

    let seq = 1;
    let closed = false;
    async function answerModelSettings(requestId: string): Promise<void> {
        const settings = await options.readModelSettings?.(workspace)
            .catch(() => undefined);
        seq += 1;
        if (closed) return;
        outgoing.push(
            settings === undefined
                ? {
                    type: "model_settings_rejected",
                    requestId,
                    reason: "unavailable",
                    seq,
                }
                : {
                    type: "model_settings",
                    requestId,
                    settings,
                    pending: false,
                    seq,
                },
        );
    }

    async function answerCatalogRefresh(
        requestId: string,
        provider: string,
    ): Promise<void> {
        const settings = await options.refreshCatalog?.(provider, workspace)
            .catch(() => undefined);
        seq += 1;
        if (closed) return;
        outgoing.push(
            settings === undefined
                ? {
                    type: "model_settings_rejected",
                    requestId,
                    reason: options.refreshCatalog === undefined
                        ? "unavailable"
                        : "invalid",
                    seq,
                }
                : {
                    type: "model_settings",
                    requestId,
                    settings,
                    pending: false,
                    seq,
                },
        );
    }

    return client;
}

function commandNeedsRunningLoop(command: ClientCommand): boolean {
    switch (command.type) {
        case "get_model_settings":
        case "get_permissions":
        case "get_session_model_settings_history":
        case "list_agents":
        case "list_timeline":
        case "preview_timeline_action":
        case "catalog_refresh":
            return false;
        default:
            return true;
    }
}
