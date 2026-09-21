import { randomUUID } from "node:crypto";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { UpdateModelSettingsCommand } from "../../src/engine/protocol.ts";

export interface ModelSwitchChoice {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

// A switch is also the default for new conversations, so this must stay
// `update_model_settings`; test/locked/model-switch-carries.test.ts restarts a real host to prove it.
export function modelSwitchCommand(choice: ModelSwitchChoice): UpdateModelSettingsCommand {
    return {
        type: "update_model_settings",
        requestId: randomUUID(),
        patch: {
            provider: choice.provider,
            model: choice.model,
            reasoningEffort: choice.reasoningEffort ?? null,
        },
    };
}
