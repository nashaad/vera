import { AsyncQueue } from "../../src/engine/async-queue.ts";
import {
    projectTranscript,
    type AgentUpdate,
    type ClientCommand,
    type HistoryUpdate,
} from "../../src/engine/protocol.ts";
import { readSessionSnapshot } from "../../src/store/session-store.ts";
import type { TuiAgentClient } from "./agent-client.ts";

export interface JsonlViewClient extends TuiAgentClient {
    readonly viewOnly: true;
    readonly sessionPath: string;
}

export function isJsonlViewClient(
    client: TuiAgentClient,
): client is JsonlViewClient {
    return isWorkerFreeClient(client) && client.home !== true;
}

export function isWorkerFreeClient(client: TuiAgentClient): boolean {
    return client.viewOnly === true;
}

export async function createJsonlViewClient(
    sessionPath: string,
): Promise<JsonlViewClient> {
    const snapshot = await readSessionSnapshot(sessionPath);
    const outgoing = new AsyncQueue<AgentUpdate>();
    const history: HistoryUpdate = {
        type: "history",
        entries: projectTranscript(
            snapshot.messages,
            undefined,
            snapshot.messageIds,
            snapshot.harnessMessages,
        ),
        seq: 0,
    };
    outgoing.push(history);

    const client: JsonlViewClient = {
        agentId: snapshot.header.id,
        workspace: snapshot.header.cwd,
        viewOnly: true,
        sessionPath,
        async send(command: ClientCommand): Promise<void> {
            if (!commandNeedsRunningLoop(command)) {
                return;
            }
            throw new Error(
                "This conversation is idle until something wakes it",
            );
        },
        receive(signal) {
            return outgoing.receive(signal);
        },
        async detach(): Promise<void> {
            client.close();
        },
        close(): void {
            outgoing.fail(new Error("Jsonl view closed"), {
                discardBuffered: true,
            });
        },
    };
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
