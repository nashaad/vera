import { expect, test } from "bun:test";
import {
    parseColor,
    TextAttributes,
    TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiGutterEntry } from "../../clients/tui/gutter.ts";
import { TUI_MUTED } from "../../clients/tui/state.ts";

async function assistantFrame(): Promise<string> {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
        flexGrow: 1,
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        0,
    );
    setup.renderer.root.add(node);
    try {
        await setup.flush();
        return setup.captureCharFrame();
    } finally {
        node.destroy();
        setup.renderer.destroy();
    }
}

test("an assistant entry uses spacing without a separator rule", async () => {
    const frame = await assistantFrame();
    expect(frame).toContain("• Final answer");
    expect(frame).not.toContain("──────────");
});

test("the assistant marker is a muted weighted bullet", async () => {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    const content = new TextRenderable(setup.renderer, {
        id: "content",
        content: "Final answer",
    });
    const node = createTuiGutterEntry(
        setup.renderer,
        "answer",
        { kind: "assistant", text: "Final answer" },
        content,
        0,
    );
    setup.renderer.root.add(node);

    try {
        const marker = node.findDescendantById("answer-marker");
        expect(marker).toBeInstanceOf(TextRenderable);
        expect(marker instanceof TextRenderable ? marker.plainText : undefined)
            .toBe("•");
        expect(marker instanceof TextRenderable
            ? marker.fg.equals(parseColor(TUI_MUTED))
            : false).toBe(true);
        expect(marker instanceof TextRenderable ? marker.attributes : undefined)
            .toBe(TextAttributes.BOLD);
    } finally {
        setup.renderer.destroy();
    }
});
