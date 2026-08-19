import { startTui, type TuiDependencies } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";

const MODELS = [
    {
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
        label: "Claude Haiku 4.5",
        description: "fast",
    },
    {
        provider: "ollama",
        model: "gemma4:26b",
        label: "Gemma 4",
        description: "local",
    },
];

export function createTuiReviewerDependencies(): TuiDependencies {
    let seq = 2_000;
    let reviewer: unknown = { mode: "agent" };

    function settings(): Record<string, unknown> {
        return {
            model: "current-model",
            availableModels: MODELS,
            reviewerDefault: reviewer,
        };
}

const client = createSettingsAnsweringClient({
    agentId: "reviewer-session",
    model: "current-model",
    mode: "auto",
    get modelSettings() {
        return settings();
    },
    onCommand: (command, push) => {
        if (command.type !== "update_model_settings") return;
        const patch = command.patch.reviewer;
        reviewer = patch === null || patch === undefined
            ? { mode: "agent" }
            : {
                mode: "fixed",
                primary: patch.primary,
                ...(patch.fallback === null || patch.fallback === undefined
                    ? {}
                    : { fallback: patch.fallback }),
            };
        push({
            type: "model_settings",
            requestId: command.requestId,
            settings: settings(),
            pending: false,
            seq: (seq += 1),
        } as never);
    },
});

return { client };
}

if (import.meta.main) {
    await startTui(createTuiReviewerDependencies());
}
