import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { TuiAgentClient } from "../../clients/tui/main.ts";

export interface SettingsAnsweringClientOptions {
    readonly agentId: string;
    readonly workspace?: string;
    readonly model: string;
    readonly mode: ApprovalMode;
    /** Updates delivered before anything is asked for, such as replayed history. */
    readonly initialUpdates?: readonly AgentUpdate[];
    /** Commands this session answers beyond the two settings requests. */
    readonly onCommand?: (
        command: ClientCommand,
        push: (update: AgentUpdate) => void,
    ) => void;
    readonly onDetach?: () => void;
}

/**
 * A session that reports its own model and approval mode when asked.
 *
 * The status line has nothing to show until a client asks for these, so a
 * fake that ignores the requests cannot tell a session that reports late from
 * one that never reports at all.
 */
export function createSettingsAnsweringClient(
    options: SettingsAnsweringClientOptions,
): TuiAgentClient {
    const updates = new AsyncQueue<AgentUpdate>();
    let seq = 0;
    for (const update of options.initialUpdates ?? []) {
        updates.push(update);
    }
    return {
        agentId: options.agentId,
        ...(options.workspace === undefined
            ? {}
            : { workspace: options.workspace }),
        async send(command: ClientCommand): Promise<void> {
            if (command.type === "get_model_settings") {
                updates.push({
                    type: "model_settings",
                    requestId: command.requestId,
                    settings: { model: options.model },
                    pending: false,
                    seq: (seq += 1),
                });
                return;
            }
            if (command.type === "get_permissions") {
                updates.push({
                    type: "permissions",
                    requestId: command.requestId,
                    mode: options.mode,
                    pending: false,
                    seq: (seq += 1),
                });
                return;
            }
            options.onCommand?.(command, (update) => updates.push(update));
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {
            options.onDetach?.();
        },
        close(): void {},
    };
}
