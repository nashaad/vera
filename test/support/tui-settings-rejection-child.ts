import { startTui, type TuiDependencies } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

export function createTuiSettingsRejectionDependencies(): TuiDependencies {
    let seq = 1_000;
    const client = createSettingsAnsweringClient({
        agentId: "settings-rejection-session",
        model: "current-model",
        mode: "review",
        onCommand: (command, push) => {
            if (command.type === "update_model_settings") {
                push({
                    type: "model_settings_rejected",
                    requestId: command.requestId,
                    reason: "unavailable",
                    seq: (seq += 1),
                });
                return;
            }
            if (
                command.type === "update_permissions"
                || command.type === "update_session_permission_mode"
            ) {
                push({
                    type: "permissions_rejected",
                    requestId: command.requestId,
                    reason: "invalid",
                    seq: (seq += 1),
                });
            }
        },
    });

    return { client };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createTuiSettingsRejectionDependencies());
}
