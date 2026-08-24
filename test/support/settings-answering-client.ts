import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../src/engine/protocol.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { TuiAgentClient } from "../../clients/tui/main.ts";

export interface SettingsAnsweringClientOptions {
    readonly agentId: string;
    readonly workspace?: string;
    readonly model: string;
    readonly mode: ApprovalMode;
    /** Extra fields merged into every reported model settings payload. */
    readonly modelSettings?: Record<string, unknown>;
    /** Updates delivered before anything is asked for, such as replayed history. */
    readonly initialUpdates?: readonly AgentUpdate[];
    /** Commands this session answers beyond the two settings requests. */
    readonly onCommand?: (
        command: ClientCommand,
        push: (update: AgentUpdate) => void,
    ) => void;
    readonly onDetach?: () => void;
    readonly release?: NonNullable<TuiAgentClient["release"]>;
    readonly supportsHostCapability?: NonNullable<
        TuiAgentClient["supportsHostCapability"]
    >;
    /**
     * Drop the first `get_model_settings` so a client that never asks again
     * stays on the loading placeholders, and one that retries after history
     * still fills the status line.
     */
    readonly ignoreFirstModelSettingsRequest?: boolean;
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
    let ignoredFirstModelSettings = false;
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
                if (
                    options.ignoreFirstModelSettingsRequest === true
                    && !ignoredFirstModelSettings
                ) {
                    ignoredFirstModelSettings = true;
                    return;
                }
                updates.push({
                    type: "model_settings",
                    requestId: command.requestId,
                    settings: {
                        model: options.model,
                        ...options.modelSettings,
                    },
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
        ...(options.release === undefined ? {} : { release: options.release }),
        ...(options.supportsHostCapability === undefined
            ? {}
            : { supportsHostCapability: options.supportsHostCapability }),
        async detach(): Promise<void> {
            options.onDetach?.();
        },
        close(): void {},
    };
}
