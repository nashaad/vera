import type { BootQuestion } from "../../src/host/boot.ts";
import type { StartupCard } from "./startup-card.ts";

// The boot questions default to yes: Enter takes it, as it does on the plain [Y/n] line.
export function bootQuestionCard(question: BootQuestion): StartupCard {
    const lines = question.text.split("\n");
    const body = lines.length > 1
        ? [...lines.slice(0, -1), "", lines[lines.length - 1]!]
        : lines;
    if (question.id === "keep_fresh_runtime") {
        return {
            kind: "question",
            title: "Keep the fresh runtime folder?",
            body,
            choices: [
                { key: "y", label: "keep it", isDefault: true },
                { key: "n", label: "put the stash back" },
            ],
        };
    }
    return {
        kind: "error",
        title: "Vera can't start",
        body,
        choices: [
            {
                key: "y",
                label: question.id === "stash_runtime" ? "stash and start fresh" : "stop it and start fresh",
                isDefault: true,
            },
            { key: "n", label: "quit" },
        ],
    };
}
