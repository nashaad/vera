import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_MUTED, TUI_TEXT } from "./state.ts";

interface TuiUserEntryThemeParts {
    readonly grounds: BoxRenderable[];
    readonly accent: TextRenderable[];
    readonly muted: TextRenderable[];
    readonly text: TextRenderable[];
}

const themeParts = new WeakMap<BoxRenderable, TuiUserEntryThemeParts>();

/**
 * The user's own message, as a full-width tinted band. An accent rule down the
 * left read as an admonition, and the message is not a warning.
 */
export function createTuiUserEntry(
    renderer: RenderContext,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const band = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "column",
        backgroundColor: TUI_ELEMENT,
        // The band carries a row of tint above and below the text: without it
        // the message reads as a highlighted line rather than as its own block.
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop,
    });
    const line = new BoxRenderable(renderer, {
        id: `${id}-line`,
        width: "100%",
        flexDirection: "row",
        backgroundColor: TUI_ELEMENT,
    });
    // The caret sits in its own column so a message that wraps stays aligned
    // under itself rather than under the caret.
    const caret = new TextRenderable(renderer, {
        id: `${id}-caret`,
        content: "› ",
        fg: TUI_MUTED,
        bg: TUI_ELEMENT,
        flexShrink: 0,
    });
    line.add(caret);
    // What an extension prepended is left out of the band: it was sent with
    // the message, but the band is what the user said, and a note about the
    // room is not that.
    const injected = entry.kind === "diff" ? 0 : entry.dimmedPrefix ?? 0;
    const text = new TextRenderable(renderer, {
        id: `${id}-text`,
        content: injected > 0 && injected < entry.text.length
            ? entry.text.slice(injected)
            : entry.text,
        fg: TUI_TEXT,
        bg: TUI_ELEMENT,
        flexGrow: 1,
        wrapMode: "word",
        selectable: true,
    });
    line.add(text);
    band.add(line);
    const attachments = entry.kind === "diff" ? [] : entry.attachments ?? [];
    const grounds = [band, line];
    const accent: TextRenderable[] = [];
    const muted = [caret];
    attachments.forEach((name, index) => {
        const chip = new BoxRenderable(renderer, {
            id: `${id}-chip-${index}`,
            marginLeft: 2,
            // The chips read as their own row under the message rather than as
            // the last line of it.
            marginTop: index === 0 && entry.text.length > 0 ? 1 : 0,
            flexDirection: "row",
            backgroundColor: TUI_ELEMENT,
        });
        const label = new TextRenderable(renderer, {
            id: `${id}-chip-${index}-label`,
            content: "File ",
            fg: TUI_ACCENT,
            bg: TUI_ELEMENT,
            selectable: true,
        });
        const attachmentName = new TextRenderable(renderer, {
            id: `${id}-chip-${index}-name`,
            content: ` ${name}`,
            fg: TUI_MUTED,
            bg: TUI_ELEMENT,
            selectable: true,
        });
        chip.add(label);
        chip.add(attachmentName);
        band.add(chip);
        grounds.push(chip);
        accent.push(label);
        muted.push(attachmentName);
    });
    themeParts.set(band, { grounds, accent, muted, text: [text] });
    return band;
}

export function repaintTuiUserEntry(node: BoxRenderable): void {
    const parts = themeParts.get(node);
    if (parts === undefined) return;
    for (const ground of parts.grounds) ground.backgroundColor = TUI_ELEMENT;
    for (const item of parts.accent) {
        item.fg = TUI_ACCENT;
        item.bg = TUI_ELEMENT;
    }
    for (const item of parts.muted) {
        item.fg = TUI_MUTED;
        item.bg = TUI_ELEMENT;
    }
    for (const item of parts.text) {
        item.fg = TUI_TEXT;
        item.bg = TUI_ELEMENT;
    }
}
