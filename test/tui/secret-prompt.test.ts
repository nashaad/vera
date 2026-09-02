import { expect, test } from "bun:test";
import { parseKeypress, type StyledText } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiSecretPromptView,
    handleTuiSecretPromptKey,
    tuiSecretEntryLine,
    handleTuiSecretPromptPaste,
    startTuiSecretPrompt,
} from "../../clients/tui/secret-prompt.ts";

const OPENROUTER = {
    id: "openrouter",
    label: "OpenRouter",
    hint: "API key, pay per token",
};

test("the API-key card is vertically centered", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiSecretPromptView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiSecretPrompt(OPENROUTER));

    try {
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("OpenRouter API key");
        expect(view.card.screenY).toBe(
            Math.floor((setup.renderer.height - view.card.height) / 2),
        );

        setup.resize(60, 14);
        view.update(startTuiSecretPrompt(OPENROUTER));
        await setup.flush();
        expect(view.card.screenY).toBe(
            Math.floor((setup.renderer.height - view.card.height) / 2),
        );
    } finally {
        setup.renderer.destroy();
    }
});

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

test("the entry line shows the key as typed", () => {
    // Masked once, which read as a row of dots rather than as a field with a
    // key in it, and hid whether the whole key had landed.
    expect(entryText(tuiSecretEntryLine("sk-abc"))).toContain("sk-abc");
    expect(entryText(tuiSecretEntryLine("sk-abc"))).not.toContain("•");
});

test("an empty submit closes rather than storing nothing under the provider", () => {
    const empty = handleTuiSecretPromptKey(startTuiSecretPrompt(OPENROUTER), {
        name: "return",
    });

    expect(empty.handled).toBe(true);
    expect(empty.submitted).toBeUndefined();
    expect(empty.state).toBeUndefined();
});

test("escape closes and ctrl+u clears, since a mistyped key is not worth backspacing", () => {
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

test("a shifted character keeps its case", () => {
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

test("a bracketed paste reaches the field, since nobody types a 70-character key", () => {
    // The terminal delivers a paste as its own event, not as keystrokes, so the
    // field has to take it separately or the only realistic way to enter a key
    // does nothing at all.
    const state = handleTuiSecretPromptPaste(
        startTuiSecretPrompt(OPENROUTER),
        "sk-or-v1-pasted\n",
    );

    // The trailing newline a copied line carries must not survive: it would
    // otherwise be stored inside the key and sent as a header.
    expect(state.value).toBe("sk-or-v1-pasted");
});

test("a paste of nothing but whitespace leaves the field alone", () => {
    const state = startTuiSecretPrompt(OPENROUTER);

    expect(handleTuiSecretPromptPaste(state, "  \n ")).toBe(state);
});

test("an empty field names what goes in it, rather than showing an ellipsis", () => {
    // The muted placeholder is what every search box in the TUI does, and an
    // accent ellipsis read as content rather than as an empty field.
    expect(entryText(tuiSecretEntryLine(""))).toContain("API key");
    expect(entryText(tuiSecretEntryLine("sk-abc"))).not.toContain("API key");
});

function entryText(line: StyledText): string {
    return line.chunks.map((chunk) => chunk.text).join("");
}

test("the key card carries the onboarding rail when one is given", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiSecretPromptView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    try {
        view.update(startTuiSecretPrompt(
            OPENROUTER,
            undefined,
            "Provider > Key > Model    step 2 of 3",
        ));
        await setup.flush();
        const withRail = setup.captureCharFrame();
        expect(withRail).toContain("OpenRouter API key");
        expect(withRail).toContain("step 2 of 3");

        // A user adding a second provider is not being walked through gates.
        view.update(startTuiSecretPrompt(OPENROUTER));
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("step 2 of 3");
    } finally {
        setup.renderer.destroy();
    }
});
