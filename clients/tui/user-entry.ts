import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_TEXT,
} from "./state.ts";

interface TuiUserEntryThemeParts {
    readonly grounds: BoxRenderable[];
    readonly accent: TextRenderable[];
    readonly muted: TextRenderable[];
    readonly caret: TextRenderable;
    readonly rule: BoxRenderable;
    readonly text: TextRenderable[];
}

const themeParts = new WeakMap<BoxRenderable, TuiUserEntryThemeParts>();

/** Bands drawn with the landing rule, so a repaint does not clear it. */
const markedBands = new WeakSet<BoxRenderable>();

/** The caret every band opens with. */
const CARET = "› ";

/**
 * The user's own message, as a full-width tinted band. An accent rule down the
 * left read as an admonition, and the message is not a warning.
 */
export function createTuiUserEntry(
    renderer: RenderContext,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
    marked = false,
): BoxRenderable {
    const band = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        backgroundColor: TUI_ELEMENT,
        marginTop,
    });
    // A landing paints this column, so the rule runs the height of the band
    // rather than marking only its first row. The padding lives inside the
    // body so the rule covers the band's tinted rows too.
    const rule = new BoxRenderable(renderer, {
        id: `${id}-rule-column`,
        width: 1,
        flexShrink: 0,
        backgroundColor: marked ? TUI_NOTICE : TUI_ELEMENT,
    });
    band.add(rule);
    const body = new BoxRenderable(renderer, {
        id: `${id}-body`,
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: "column",
        backgroundColor: TUI_ELEMENT,
        // The band carries a row of tint above and below the text: without it
        // the message reads as a highlighted line rather than as its own block.
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
    });
    band.add(body);
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
        content: CARET,
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
    body.add(line);
    const attachments = entry.kind === "diff" ? [] : entry.attachments ?? [];
    // The rule is painted from the mark, not from the ground run.
    const grounds = [band, body, line];
    const accent: TextRenderable[] = [];
    // The caret is repainted from the mark, not from the muted run.
    const muted: TextRenderable[] = [];
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
        body.add(chip);
        grounds.push(chip);
        accent.push(label);
        muted.push(attachmentName);
    });
    themeParts.set(band, { grounds, accent, muted, caret, rule, text: [text] });
    if (marked) markedBands.add(band);
    return band;
}

/**
 * Draws the landing rule on an already-built band, in place.
 *
 * Reports whether it found a band to mark, so a landing that cannot be shown
 * is a failure rather than a silent no-op.
 */
export function markTuiUserEntry(node: BoxRenderable): boolean {
    const parts = themeParts.get(node);
    if (parts === undefined) return false;
    markedBands.add(node);
    parts.rule.backgroundColor = TUI_NOTICE;
    return true;
}

/** Clears a band's landing rule. */
export function unmarkTuiUserEntry(node: BoxRenderable): void {
    const parts = themeParts.get(node);
    if (parts === undefined) return;
    markedBands.delete(node);
    parts.rule.backgroundColor = TUI_ELEMENT;
}

export function repaintTuiUserEntry(node: BoxRenderable): void {
    const parts = themeParts.get(node);
    if (parts === undefined) return;
    const marked = markedBands.has(node);
    parts.caret.content = CARET;
    parts.caret.fg = TUI_MUTED;
    parts.caret.bg = TUI_ELEMENT;
    for (const ground of parts.grounds) ground.backgroundColor = TUI_ELEMENT;
    parts.rule.backgroundColor = marked ? TUI_NOTICE : TUI_ELEMENT;
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
