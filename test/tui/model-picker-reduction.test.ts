import { expect, test } from "bun:test";

import type { SuggestedModel } from "../../src/model/supported-models.ts";
import {
    handleTuiSettingsPickerKey,
    startTuiSettingsPicker,
} from "../../clients/tui/settings-picker.ts";

const MODELS: readonly SuggestedModel[] = [
    {
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        label: "Anthropic: Claude Opus 5",
        description: "the newest one",
    },
    {
        provider: "openrouter",
        model: "anthropic/claude-opus-5:batch",
        label: "Anthropic: Claude Opus 5 (batch)",
        description: "queued rather than answered",
        hiddenByDefault: "batch",
    },
    {
        provider: "openrouter",
        model: "openai/gpt-3.5-turbo",
        label: "OpenAI: GPT-3.5 Turbo",
        description: "listed years ago",
        hiddenByDefault: "old",
    },
];

function picker(pooled: Parameters<typeof startTuiSettingsPicker>[8] = []) {
    return startTuiSettingsPicker(
        "model",
        "anthropic/claude-opus-5",
        "high",
        "auto",
        MODELS,
        "default",
        "openrouter",
        undefined,
        pooled,
    );
}

function modelValues(state: ReturnType<typeof picker>): readonly string[] {
    return state.options
        .filter((option) => option.model !== undefined)
        .map((option) => option.model!);
}

test("the model pane opens without the folded rows", () => {
    const values = modelValues(picker());
    expect(values).toContain("anthropic/claude-opus-5");
    expect(values).not.toContain("anthropic/claude-opus-5:batch");
    expect(values).not.toContain("openai/gpt-3.5-turbo");
});

test("the reveal key adds the folded rows and takes them away again", () => {
    const opened = picker();
    const revealed = handleTuiSettingsPickerKey(opened, {
        name: "a",
        ctrl: true,
    });
    expect(revealed.handled).toBe(true);
    expect(revealed.state?.revealAll).toBe(true);
    expect(modelValues(revealed.state!)).toContain("openai/gpt-3.5-turbo");

    const folded = handleTuiSettingsPickerKey(revealed.state!, {
        name: "a",
        ctrl: true,
    });
    expect(folded.state?.revealAll).toBe(false);
    expect(modelValues(folded.state!)).not.toContain("openai/gpt-3.5-turbo");
});

test("a search reaches a folded row without revealing the pane", () => {
    const searched = handleTuiSettingsPickerKey(picker(), { name: "3" });
    expect(modelValues(searched.state!)).toContain("openai/gpt-3.5-turbo");
    expect(searched.state?.revealAll).toBeUndefined();
});

test("a pooled row is never folded away", () => {
    const values = modelValues(picker([{
        provider: "openrouter",
        model: "openai/gpt-3.5-turbo",
        label: "OpenAI: GPT-3.5 Turbo",
        available: true,
        verified: true,
        levels: [],
    }]));
    expect(values).toContain("openai/gpt-3.5-turbo");
});

// A count rides on a closed heading only: an open section shows its rows, so
// the number would be restating what the reader can already see.
test("a closed heading counts what it is hiding", () => {
    const folded = handleTuiSettingsPickerKey(picker(), {
        name: "left",
        shift: true,
    });
    const heading = folded.state?.options.find((option) =>
        option.section === "openrouter"
    );
    expect(heading?.label).toBe("openrouter (1 of 3)");
});
