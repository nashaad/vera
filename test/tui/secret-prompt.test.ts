import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";

import {
    handleTuiSecretPromptKey,
    startTuiSecretPrompt,
    tuiMaskedSecret,
} from "../../clients/tui/secret-prompt.ts";

const OPENROUTER = {
    id: "openrouter",
    label: "OpenRouter",
    hint: "API key, pay per token",
};

function typed(value: string) {
    let state = startTuiSecretPrompt(OPENROUTER);
    for (const character of value) {
        state = handleTuiSecretPromptKey(state, { name: character }).state!;
    }
    return state;
}

test("a typed key is collected and handed back on enter", () => {
    const submitted = handleTuiSecretPromptKey(typed("sk-abc"), {
        name: "return",
    });

    expect(submitted.submitted).toBe("sk-abc");
    expect(submitted.state).toBeUndefined();
});

test("a pasted key arrives as one event rather than a key at a time", () => {
    // Terminals deliver a paste as a single sequence, and an API key is pasted
    // far more often than it is typed.
    const state = handleTuiSecretPromptKey(startTuiSecretPrompt(OPENROUTER), {
        name: "s",
        sequence: "sk-or-v1-pasted",
    });

    expect(state.state?.value).toBe("sk-or-v1-pasted");
});

test("the entry line shows length, never the key", () => {
    expect(tuiMaskedSecret("")).toBe("…");
    expect(tuiMaskedSecret("sk-abc")).toBe("••••••");
    expect(tuiMaskedSecret("sk-abc")).not.toContain("s");
});

test("an empty submit closes rather than storing nothing under the provider", () => {
    const empty = handleTuiSecretPromptKey(startTuiSecretPrompt(OPENROUTER), {
        name: "return",
    });

    expect(empty.handled).toBe(true);
    expect(empty.submitted).toBeUndefined();
    expect(empty.state).toBeUndefined();
});

test("escape closes and ctrl+u clears, since a masked key cannot be proofread", () => {
    expect(handleTuiSecretPromptKey(typed("sk-abc"), { name: "escape" }))
        .toEqual({ handled: true });
    expect(
        handleTuiSecretPromptKey(typed("sk-abc"), { name: "u", ctrl: true })
            .state?.value,
    ).toBe("");
});

test("surrounding whitespace is dropped from a pasted key", () => {
    const state = handleTuiSecretPromptKey(startTuiSecretPrompt(OPENROUTER), {
        name: "s",
        sequence: "  sk-padded  ",
    });

    expect(handleTuiSecretPromptKey(state.state!, { name: "return" }).submitted)
        .toBe("sk-padded");
});

test("a shifted character keeps its case, because a masked key cannot be reread", () => {
    // The parser reports a shifted letter as `name: "s", sequence: "S"`, so
    // reading the name would store a key that is silently lower case and fails
    // on the first turn with nothing on screen to explain it.
    let state = startTuiSecretPrompt(OPENROUTER);
    for (const character of "sK-AbC") {
        state = handleTuiSecretPromptKey(
            state,
            parseKeypress(Buffer.from(character)) as never,
        ).state!;
    }

    expect(handleTuiSecretPromptKey(state, { name: "return" }).submitted)
        .toBe("sK-AbC");
});

test("an escape sequence is a key, not text to collect", () => {
    const arrowUp = handleTuiSecretPromptKey(
        typed("sk-abc"),
        parseKeypress(Buffer.from("\u001b[A")) as never,
    );

    expect(arrowUp.handled).toBe(false);
    expect(arrowUp.state?.value).toBe("sk-abc");
});
