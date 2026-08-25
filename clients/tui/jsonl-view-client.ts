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
 * worker. The first command that needs a running loop is how it becomes live.
 */
export interface JsonlViewClient extends TuiAgentClient {
    readonly viewOnly: true;
    readonly sessionPath: string;
}

export function isJsonlViewClient(
    client: TuiAgentClient,
): client is JsonlViewClient {
    return client.viewOnly === true;
}

export async function createJsonlViewClient(
    sessionPath: string,
    options: {
        readonly onActivate?: (command: ClientCommand) => Promise<void>;
    } = {},
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
            if (options.onActivate === undefined) {
                throw new Error(
                    "This conversation is on disk until it is opened for work",
                );
            }
            await options.onActivate(command);
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
 * Reads and listings do not start a worker. A prompt, an approval, or any
 * other command that needs the loop is what turns this file into a session.
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
