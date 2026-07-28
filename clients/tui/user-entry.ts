import { BoxRenderable, TextRenderable } from "@opentui/core";
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
        paddingLeft: 1,
        paddingRight: 1,
        marginTop,
    });
    band.add(new TextRenderable(renderer, {
        id: `${id}-text`,
        content: entry.text,
        fg: TUI_TEXT,
        bg: TUI_ELEMENT,
        width: "100%",
        wrapMode: "word",
        selectable: true,
    }));
    const attachments = entry.kind === "diff" ? [] : entry.attachments ?? [];
    attachments.forEach((name, index) => {
        const chip = new BoxRenderable(renderer, {
            id: `${id}-chip-${index}`,
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
