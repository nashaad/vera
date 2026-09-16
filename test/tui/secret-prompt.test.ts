import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiSecretPromptView,
    startTuiSecretPrompt,
    type TuiSecretPromptState,
    type TuiSecretPromptView,
} from "../../clients/tui/secret-prompt.ts";

const OPENROUTER = {
    id: "openrouter",
    label: "OpenRouter",
    hint: "API key, pay per token",
};

/** The card is one field in a box, so every key test drives the real field rather than a copy of its rules. */
async function openCard(): Promise<{
    view: TuiSecretPromptView;
    setup: Awaited<ReturnType<typeof createTestRenderer>>;
    state: TuiSecretPromptState;
    frame(): Promise<string>;
}> {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiSecretPromptView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    const state = startTuiSecretPrompt(OPENROUTER);
    view.update(state);
    view.focus();
    return {
        view,
        setup,
        state,
        async frame(): Promise<string> {
            await setup.flush();
            return setup.captureCharFrame();
        },
    };
}

function type(
    view: TuiSecretPromptView,
    state: TuiSecretPromptState,
    value: string,
): TuiSecretPromptState {
    let next = state;
    for (const character of value) {
        next = view.handleKey(
            next,
            parseKeypress(Buffer.from(character)) as never,
        ).state ?? next;
    }
    return next;
}

/** An odd-height card in an even-height terminal cannot sit dead center, so the two gaps are allowed to differ by the one row. */
function centeringGap(
    setup: Awaited<ReturnType<typeof createTestRenderer>>,
    card: { readonly screenY: number; readonly height: number },
): number {
    const above = card.screenY;
    const below = setup.renderer.height - card.screenY - card.height;
    return Math.abs(above - below);
}

test("the API-key card is vertically centered", async () => {
    const { view, setup } = await openCard();

    try {
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("OpenRouter API key");
        expect(centeringGap(setup, view.card)).toBeLessThanOrEqual(1);

        setup.resize(60, 14);
        view.update(startTuiSecretPrompt(OPENROUTER));
        await setup.flush();
        expect(centeringGap(setup, view.card)).toBeLessThanOrEqual(1);
    } finally {
        setup.renderer.destroy();
    }
});

test("the field takes the keyboard, so typing lands in the card and not behind it", async () => {
    const { view, setup, state, frame } = await openCard();

    try {
        const typed = type(view, state, "sk-abc");
        view.update(typed);
        expect(typed.value).toBe("sk-abc");
        expect(await frame()).toContain("sk-abc");
        expect(view.handleKey(typed, { name: "return" }).submitted)
            .toBe("sk-abc");
    } finally {
        setup.renderer.destroy();
    }
});

test("a shifted character keeps its case", async () => {
    // A key stored silently lower case fails on the first turn with nothing on
    // screen to explain it.
    const { view, setup, state } = await openCard();

    try {
        const typed = type(view, state, "sK-AbC");
        expect(view.handleKey(typed, { name: "return" }).submitted)
            .toBe("sK-AbC");
    } finally {
        setup.renderer.destroy();
    }
});

test("editing keys work, because the field is the one every dialog uses", async () => {
    const { view, setup, state } = await openCard();

    try {
        let typed = type(view, state, "sk-abcX");
        typed = view.handleKey(typed, { name: "backspace" }).state ?? typed;
        expect(typed.value).toBe("sk-abc");

        typed = view.handleKey(
            typed,
            parseKeypress(Buffer.from("[D")) as never,
        ).state ?? typed;
        typed = type(view, typed, "1");
        expect(typed.value).toBe("sk-ab1c");
    } finally {
        setup.renderer.destroy();
    }
});

test("escape closes and ctrl+u clears, since a mistyped key is not worth backspacing", async () => {
    const { view, setup, state } = await openCard();

    try {
        const typed = type(view, state, "sk-abc");
        expect(view.handleKey(typed, { name: "escape" }))
            .toEqual({ handled: true });

        const cleared = view.handleKey(typed, { name: "u", ctrl: true }).state;
        expect(cleared?.value).toBe("");
        view.update(cleared!);
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("sk-abc");
    } finally {
        setup.renderer.destroy();
    }
});

test("an empty submit closes rather than storing nothing under the provider", async () => {
    const { view, setup, state } = await openCard();

    try {
        const empty = view.handleKey(state, { name: "return" });
        expect(empty.handled).toBe(true);
        expect(empty.submitted).toBeUndefined();
        expect(empty.state).toBeUndefined();
    } finally {
        setup.renderer.destroy();
    }
});

test("a bracketed paste reaches the field, since nobody types a 70-character key", async () => {
    // The terminal delivers a paste as its own event, not as keystrokes, so the
    // field has to take it separately or the only realistic way to enter a key
    // does nothing at all.
    const { view, setup, state } = await openCard();

    try {
        // The newline a copied line carries must not survive: it would
        // otherwise be stored inside the key and sent as a header.
        const pasted = view.handlePaste(state, "sk-or-v1-pasted\n");
        expect(pasted.value).toBe("sk-or-v1-pasted");
        expect(view.handleKey(pasted, { name: "return" }).submitted)
            .toBe("sk-or-v1-pasted");
    } finally {
        setup.renderer.destroy();
    }
});

test("the key is shown as typed, not masked", async () => {
    // Masked once, which read as a row of dots rather than as a field with a
    // key in it, and hid whether the whole key had landed.
    const { view, setup, state, frame } = await openCard();

    try {
        view.update(type(view, state, "sk-abc"));
        const shown = await frame();
        expect(shown).toContain("sk-abc");
        expect(shown).not.toContain("•");
    } finally {
        setup.renderer.destroy();
    }
});

test("an empty field names what goes in it, rather than showing an ellipsis", async () => {
    const { setup, frame } = await openCard();

    try {
        expect(await frame()).toContain("API key");
    } finally {
        setup.renderer.destroy();
    }
});

test("reopening the card starts empty rather than showing the last key", async () => {
    const { view, setup, state, frame } = await openCard();

    try {
        view.update(type(view, state, "sk-abc"));
        expect(await frame()).toContain("sk-abc");

        view.update(startTuiSecretPrompt(OPENROUTER));
        expect(await frame()).not.toContain("sk-abc");
    } finally {
        setup.renderer.destroy();
    }
});


test("masked extension keys never enter the rendered field and preserve editing", async () => {
    const { view, setup, state, frame } = await openCard();
    try {
        let masked: TuiSecretPromptState = { ...state, masked: true, title: "Exa API key" };
        view.update(masked);
        masked = type(view, masked, "private-value");
        view.update(masked);
        expect(await frame()).not.toContain("private-value");
        expect(await frame()).toContain("•••••••••••••");
        masked = view.handleKey(masked, { name: "left" }).state!;
        masked = view.handleKey(masked, { name: "backspace" }).state!;
        view.update(masked);
        expect(view.handleKey(masked, { name: "return" }).submitted).toBe("private-vale");
        masked = view.handlePaste(masked, "-pasted");
        view.update(masked);
        expect(await frame()).not.toContain("pasted");
        expect(view.handleKey(masked, { name: "return" }).submitted).toContain("pasted");
        masked = view.handleKey(masked, { name: "u", ctrl: true }).state!;
        view.update(masked);
        expect(await frame()).not.toContain("•••");
        masked = type(view, masked, "replacement");
        view.update(masked);
        expect(view.handleKey(masked, { name: "return" }).submitted).toBe("replacement");
        view.clear();
        expect(await frame()).not.toContain("•••");
    } finally { setup.renderer.destroy(); }
});
