import { expect, test } from "bun:test";
import {
    parseColor,
    TextRenderable,
    type BoxRenderable,
    type Renderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiGutterEntry,
    markTuiGutterEntry,
} from "../../clients/tui/gutter.ts";
import {
    createTuiUserEntry,
    markTuiUserEntry,
    unmarkTuiUserEntry,
} from "../../clients/tui/user-entry.ts";
import {
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    type TuiTranscriptEntryKind,
} from "../../clients/tui/state.ts";

/** Every kind a search hit can land on. Diffs carry no message id. */
const LANDABLE: readonly Exclude<TuiTranscriptEntryKind, "diff">[] = [
    "user",
    "assistant",
    "tool",
    "tool_header",
    "thinking",
    "thought",
    "review",
    "notice",
    "inbox",
    "notification",
    "extension_label",
    "substitution",
];

/** The band's caret, which is where a user entry carries its marker. */
function caretOf(node: Renderable): TextRenderable | undefined {
    let found: TextRenderable | undefined;
    const walk = (current: Renderable): void => {
        if (current instanceof TextRenderable && current.id.endsWith("-caret")) {
            found = current;
        }
        for (const child of current.getChildren()) walk(child);
    };
    walk(node);
    return found;
}

test("a search can mark whatever kind of block it lands on", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    try {
        for (const kind of LANDABLE) {
            const entry = { kind, text: "the matched words" } as const;
            // The user band owns its full width and takes no gutter column,
            // so it is the one kind that carries its own marker. Every other
            // kind goes through the gutter. A kind that fits neither would
            // land the reader with nothing on screen saying why.
            const marked = kind === "user"
                ? markTuiUserEntry(
                    createTuiUserEntry(renderer, kind, entry, 0),
                )
                : markTuiGutterEntry(createTuiGutterEntry(
                    renderer,
                    kind,
                    entry,
                    new TextRenderable(renderer, {
                        id: `${kind}-body`,
                        content: entry.text,
                    }),
                    0,
                    false,
                    {},
                ));
            expect(`${kind}: ${marked}`).toBe(`${kind}: true`);
        }
    } finally {
        renderer.destroy();
    }
});

test("the user band says it is the landing with a rule down its edge", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    try {
        const entry = { kind: "user", text: "ask me a question" } as const;
        const band = createTuiUserEntry(renderer, "u1", entry, 0);
        const caret = caretOf(band);
        expect(caret?.plainText).toBe("› ");

        const rule = band.findDescendantById("u1-rule-column") as BoxRenderable;
        markTuiUserEntry(band);
        // The rule runs the height of the band, so a message of any length
        // is marked down its whole side rather than on its first row. The
        // caret is the band's own and does not change with the mark.
        expect(rule.backgroundColor?.toString())
            .toBe(parseColor(TUI_NOTICE).toString());
        expect(caret?.plainText).toBe("› ");
        expect(caret?.fg).toEqual(parseColor(TUI_MUTED));

        unmarkTuiUserEntry(band);
        expect(rule.backgroundColor?.toString())
            .toBe(parseColor(TUI_ELEMENT).toString());
    } finally {
        renderer.destroy();
    }
});

test("a band built already marked comes up marked", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    try {
        const entry = { kind: "user", text: "ask me a question" } as const;
        const band = createTuiUserEntry(renderer, "u2", entry, 0, true);
        const rule = band.findDescendantById("u2-rule-column") as BoxRenderable;
        expect(rule.backgroundColor?.toString())
            .toBe(parseColor(TUI_NOTICE).toString());
    } finally {
        renderer.destroy();
    }
});
