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
