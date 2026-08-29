import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type {
    AgentUpdate,
    ClientCommand,
    HistoryUpdate,
} from "../../src/engine/protocol.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
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

export interface HomeClientOptions {
    /**
     * Reads the catalog, the shortlist and the defaults from the host.
     *
     * All three are host state, so home can show them with no conversation
     * behind it. Absent, or failing, home simply has none to show.
     */
    readonly readModelSettings?: (
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
        // Home is replaced the moment a conversation opens, so a read that
        // was already in flight has nowhere left to land. That is the end of
        // the answer, not a fault worth reporting against the new client.
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
