import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    parseColor,
    type BoxRenderable,
    type StyledText,
    type TextChunk,
    type TextRenderable,
} from "@opentui/core";

import {
    DIALOG_SHORT_TERMINAL_HEIGHT,
    dialogBottomOffset,
    dialogOptionRow,
} from "../../clients/tui/dialog-chrome.ts";
import {
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_SUCCESS,
} from "../../clients/tui/state.ts";

test("bottom-anchored overlays clear the status line only when there is room", async () => {
    const roomy = await createTestRenderer({ width: 80, height: 24 });
    try {
        // The status line is drawn over these overlays, so with height to spare
        // they sit one row above it rather than losing their key hints to it.
        expect(dialogBottomOffset(roomy.renderer)).toBe(2);
    } finally {
        roomy.renderer.destroy();
    }

    const short = await createTestRenderer({
        width: 42,
        height: DIALOG_SHORT_TERMINAL_HEIGHT,
    });
    try {
        // At this height the reserved row would come out of the content: the
        // question being asked scrolls off before its own hints do. So short
        // terminals keep the collision and keep the content.
        expect(dialogBottomOffset(short.renderer)).toBe(1);
    } finally {
        short.renderer.destroy();
    }

    const boundary = await createTestRenderer({
        width: 42,
        height: DIALOG_SHORT_TERMINAL_HEIGHT + 1,
    });
    try {
        expect(dialogBottomOffset(boundary.renderer)).toBe(2);
    } finally {
        boundary.renderer.destroy();
    }
});

/** The chunks of the row's meta column, which is its last child. */
function metaChunks(row: BoxRenderable): readonly TextChunk[] {
    const meta = row.getChildren().at(-1) as TextRenderable;
    return (meta.content as StyledText).chunks;
}

function chunkFor(
    chunks: readonly TextChunk[],
    text: string,
): TextChunk | undefined {
    return chunks.find((chunk) => chunk.text.toString() === text);
}

test("an affirmative fact in the meta column is toned apart from the rest", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        const row = dialogOptionRow(setup.renderer, {
            label: "GLM-5.2",
            meta: [
                { text: "openrouter · " },
                { text: "verified", tone: "positive" },
            ],
            active: false,
        });
        const chunks = metaChunks(row);

        expect(chunkFor(chunks, "verified")?.fg).toEqual(
            parseColor(TUI_SUCCESS),
        );
        expect(chunkFor(chunks, "openrouter · ")?.fg).toEqual(
            parseColor(TUI_MUTED),
        );

        // On the highlighted row the whole width is painted in the accent, so
        // the affirmative tone flips with everything else rather than staying
        // green on accent.
        const active = metaChunks(dialogOptionRow(setup.renderer, {
            label: "GLM-5.2",
            meta: [
                { text: "openrouter · " },
                { text: "verified", tone: "positive" },
            ],
            active: true,
        }));
        expect(chunkFor(active, "verified")?.fg).toEqual(
            parseColor(TUI_BACKGROUND),
        );
        expect(chunkFor(active, "verified")?.fg).toEqual(
            chunkFor(active, "openrouter · ")?.fg,
        );
    } finally {
        setup.renderer.destroy();
    }
});
