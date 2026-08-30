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
    dialogInsetBottomOffset,
    dialogInsetTop,
    dialogOptionRow,
    dialogOptionRows,
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

test("inset dialogs float clear of both terminal edges", async () => {
    const roomy = await createTestRenderer({ width: 100, height: 40 });
    try {
        expect(dialogInsetTop(roomy.renderer)).toBe(1);
        expect(dialogInsetBottomOffset(roomy.renderer)).toBe(5);
    } finally {
        roomy.renderer.destroy();
    }

    const short = await createTestRenderer({
        width: 42,
        height: DIALOG_SHORT_TERMINAL_HEIGHT,
    });
    try {
        expect(dialogInsetTop(short.renderer)).toBe(1);
        expect(dialogInsetBottomOffset(short.renderer)).toBe(1);
    } finally {
        short.renderer.destroy();
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

test("a positive leading mark uses success green", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        const row = dialogOptionRow(setup.renderer, {
            leading: "✓",
            leadingTone: "positive",
            label: " finished",
            active: false,
        });
        const leading = row.getChildren()[0] as TextRenderable;
        const chunks = (leading.content as StyledText).chunks;
        expect(chunkFor(chunks, "✓")?.fg).toEqual(parseColor(TUI_SUCCESS));

        const selected = dialogOptionRow(setup.renderer, {
            leading: "✓",
            leadingTone: "positive",
            label: " finished",
            active: true,
        });
        const selectedLeading = selected.getChildren()[0] as TextRenderable;
        expect(chunkFor(
            (selectedLeading.content as StyledText).chunks,
            "✓",
        )?.fg).toEqual(parseColor(TUI_BACKGROUND));
    } finally {
        setup.renderer.destroy();
    }
});

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

/** The label column, which is the row's first child when it has no leading. */
function labelText(row: BoxRenderable): string {
    const label = row.getChildren()[0] as TextRenderable;
    return (label.content as StyledText).chunks[0]!.text.toString();
}

test("the label column is capped so a long name ends in an ellipsis", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        // The meta column does not shrink. Left uncapped, the label column
        // would run past the width and the layout would cut the name mid-word.
        const rows = dialogOptionRows(setup.renderer, [
            {
                label: "Anthropic Claude Opus 4.5 (long)",
                meta: "openrouter · images · unverified",
                active: false,
            },
            { label: "fatty", meta: "openai-codex · unverified", active: false },
        ], 48);

        expect(labelText(rows[0]!)).toBe("Anthropic Claude O…");
        // A meta column too wide for what is left is clipped here too, so it
        // ends in an ellipsis rather than being cut off by the right edge.
        expect(metaChunks(rows[0]!).map((chunk) => chunk.text.toString()).join(""))
            .toBe("  openrouter · images · unve…");
        // Short names keep their text and the column stays one width.
        expect(labelText(rows[1]!)).toBe("fatty              ");
    } finally {
        setup.renderer.destroy();
    }
});

test("a meta column cut on a part boundary still says a fact is missing", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        const [row] = dialogOptionRows(setup.renderer, [{
            label: "OpenAI: GPT-5.4 Mini",
            meta: [
                { text: "openrouter · " },
                { text: "top pick", tone: "positive" },
                { text: " · images · " },
                { text: "unverified" },
            ],
            active: false,
        }], 40);
        const meta = metaChunks(row!)
            .map((chunk) => chunk.text.toString()).join("");

        // "unverified" was dropped whole, so without this the column would end
        // on a clean "· " and read as the complete list.
        expect(meta.trimEnd().endsWith("…")).toBe(true);
        expect(meta).not.toContain("unverified");
    } finally {
        setup.renderer.destroy();
    }
});

test("a card row puts its meta on a second line under the label", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        const [row] = dialogOptionRows(setup.renderer, [{
            label: "GLM-5.2",
            meta: [
                { text: "openrouter · " },
                { text: "verified", tone: "positive" },
            ],
            active: false,
            card: true,
        }], 60);
        const chunks = metaChunks(
            (row!.getChildren().at(-1) as BoxRenderable),
        );

        // Left under the label rather than pushed to the right edge, so no run
        // of padding separates the two lines.
        expect(chunks[0]?.text.toString()).toBe("openrouter · ");
        expect(chunkFor(chunks, "verified")?.fg).toEqual(
            parseColor(TUI_SUCCESS),
        );
        // Label line, meta line, and the blank line to the next card.
        expect(row!.height).toBe(3);
    } finally {
        setup.renderer.destroy();
    }
});

test("one card row does not take width from surrounding inline rows", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        const rows = dialogOptionRows(setup.renderer, [
            {
                label: "Worker",
                description: "ollama",
                active: false,
            },
            {
                label: "Spawning session model",
                description: "off",
                meta: "currently openrouter/google/gemini-3.1-pro-preview",
                active: false,
                card: true,
            },
        ], 60);

        expect(rows[0]?.height).toBe(1);
        expect(rows[1]?.height).toBe(3);
        expect(metaChunks(rows[1]!.getChildren()[1] as BoxRenderable)
            .map((chunk) => chunk.text.toString()).join(""))
            .toBe("currently openrouter/google/gemini-3.1-pro-preview");
    } finally {
        setup.renderer.destroy();
    }
});
