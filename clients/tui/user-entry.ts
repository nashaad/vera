import { BoxRenderable, StyledText, TextRenderable } from "@opentui/core";
import { fg } from "@opentui/core";
import type { RenderContext } from "@opentui/core";

import type { TuiTranscriptEntry } from "./state.ts";
import { TUI_ACCENT, TUI_BACKGROUND, TUI_ELEMENT, TUI_MUTED, TUI_TEXT } from "./state.ts";

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
    line.add(new TextRenderable(renderer, {
        id: `${id}-caret`,
        content: "› ",
        fg: TUI_MUTED,
        bg: TUI_ELEMENT,
        flexShrink: 0,
    }));
    // What an extension prepended renders muted, so the user's own words
    // stand apart from the machinery that rode along with them.
    const dimmed = entry.kind === "diff" ? 0 : entry.dimmedPrefix ?? 0;
    line.add(new TextRenderable(renderer, {
        id: `${id}-text`,
        content: dimmed > 0 && dimmed < entry.text.length
            ? new StyledText([
                fg(TUI_MUTED)(entry.text.slice(0, dimmed)),
                fg(TUI_TEXT)(entry.text.slice(dimmed)),
            ])
            : entry.text,
        fg: TUI_TEXT,
        bg: TUI_ELEMENT,
        flexGrow: 1,
        wrapMode: "word",
        selectable: true,
    }));
    band.add(line);
    const attachments = entry.kind === "diff" ? [] : entry.attachments ?? [];
    attachments.forEach((name, index) => {
        const chip = new BoxRenderable(renderer, {
            id: `${id}-chip-${index}`,
            marginLeft: 2,
            // The chips read as their own row under the message rather than as
            // the last line of it.
            marginTop: index === 0 ? 1 : 0,
            flexDirection: "row",
            backgroundColor: TUI_ELEMENT,
        });
        chip.add(new TextRenderable(renderer, {
            id: `${id}-chip-${index}-label`,
            content: " File ",
            fg: TUI_BACKGROUND,
            bg: TUI_ACCENT,
            selectable: true,
        }));
        chip.add(new TextRenderable(renderer, {
            id: `${id}-chip-${index}-name`,
            content: ` ${name}`,
            fg: TUI_MUTED,
            bg: TUI_ELEMENT,
            selectable: true,
        }));
        band.add(chip);
    });
    return band;
}
