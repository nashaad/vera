import { AsyncQueue } from "../../src/engine/async-queue.ts";
import {
    projectTranscript,
    type AgentUpdate,
    type ClientCommand,
    type HistoryUpdate,
} from "../../src/engine/protocol.ts";
import { readSessionSnapshot } from "../../src/store/session-store.ts";
import type { TuiAgentClient } from "./agent-client.ts";

/**
 * A conversation opened from its session file, with no host agent and no
 * worker. The resume overlay is what turns it into a live session.
 */
export interface JsonlViewClient extends TuiAgentClient {
    readonly viewOnly: true;
    readonly sessionPath: string;
}

export function isJsonlViewClient(
    client: TuiAgentClient,
): client is JsonlViewClient {
    return isWorkerFreeClient(client) && client.home !== true;
}

/**
 * A client with no worker of its own: a session file, or the home screen.
 *
 * Both paint without a composer and neither has a conversation to stop, so
 * the screen and the leave paths ask this rather than which of the two it is.
 */
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

/**
 * Reads and listings do not start a worker. A prompt or any other command
 * that needs the loop is refused until the overlay resumes this file.
 */
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
