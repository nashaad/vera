import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
    HistoryUpdate,
} from "../../src/engine/protocol.ts";
import type { TuiAgentClient } from "./agent-client.ts";

/**
 * The home screen: no conversation, no session file, no worker.
 *
 * It is a client so the TUI still has exactly one thing on screen at all
 * times. Everything it offers (a new conversation, the session picker, the
 * palette) creates or attaches the real client that replaces it.
 */
export interface HomeClient extends TuiAgentClient {
    readonly viewOnly: true;
    readonly home: true;
}

export function isHomeClient(client: TuiAgentClient): client is HomeClient {
    return client.home === true;
}

export function createHomeClient(workspace: string): HomeClient {
    const outgoing = new AsyncQueue<AgentUpdate>();
    const history: HistoryUpdate = { type: "history", entries: [], seq: 0 };
    outgoing.push(history);
    const client: HomeClient = {
        workspace,
        viewOnly: true,
        home: true,
        async send(command: ClientCommand): Promise<void> {
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
            outgoing.fail(new Error("Home closed"), { discardBuffered: true });
        },
    };
    return client;
}

/** Reads and listings answer with nothing; anything else needs a session. */
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
