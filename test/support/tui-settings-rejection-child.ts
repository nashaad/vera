import { startTui } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";

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
        if (command.type === "update_permissions") {
            push({
                type: "permissions_rejected",
                requestId: command.requestId,
                reason: "invalid",
                seq: (seq += 1),
            });
        }
    },
});

await startTui({ client });
