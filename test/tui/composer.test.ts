import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiComposer } from "../../clients/tui/composer.ts";

test("TUI composer edits, pastes, submits, and survives resize", async () => {
    const setup = await createTestRenderer({
        width: 40,
        height: 8,
        kittyKeyboard: true,
    });
    const submitted: string[] = [];
    let composer: ReturnType<typeof createTuiComposer>;
    composer = createTuiComposer(setup.renderer, () => {
        submitted.push(composer.plainText);
    });
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.typeText("first");
        setup.mockInput.pressEnter({ shift: true });
        await setup.mockInput.pasteBracketedText("pasted\nblock");
        await setup.flush();

        expect(composer.plainText).toBe("first\npasted\nblock");
        expect(submitted).toEqual([]);
        expect(composer.width).toBe(40);

        setup.resize(24, 6);
        await setup.flush();

        expect(composer.width).toBe(24);
        expect(composer.plainText).toBe("first\npasted\nblock");

        setup.mockInput.pressEnter();
        expect(submitted).toEqual(["first\npasted\nblock"]);
    } finally {
        setup.renderer.destroy();
    }
});

test("TUI composer collapses a large paste and expands it on submit", async () => {
    const setup = await createTestRenderer({
        width: 80,
        height: 8,
        kittyKeyboard: true,
    });
    const pasted = [
        "┌────────┬────────┐",
        "│ Aspect │ Vera   │",
        "├────────┼────────┤",
        "│ Client │ TUI    │",
        "└────────┴────────┘",
    ].join("\n");
    const submitted: string[] = [];
    let composer: ReturnType<typeof createTuiComposer>;
    composer = createTuiComposer(setup.renderer, () => {
        submitted.push(composer.expandedText());
    });
    setup.renderer.root.add(composer);
    composer.focus();

    try {
        await setup.mockInput.typeText("compare this: ");
        await setup.mockInput.pasteBracketedText(pasted);
        await setup.flush();

        expect(composer.plainText).toBe(
            `compare this: [Pasted Content ${pasted.length} chars]`,
        );
        expect(composer.expandedText()).toBe(`compare this: ${pasted}`);

        setup.mockInput.pressEnter();
        expect(submitted).toEqual([`compare this: ${pasted}`]);

        composer.clearComposer();
        expect(composer.plainText).toBe("");
        expect(composer.expandedText()).toBe("");
    } finally {
        setup.renderer.destroy();
    }
});
