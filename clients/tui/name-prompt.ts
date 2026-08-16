import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_ACCENT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import { centeredDialogSurface } from "./dialog-chrome.ts";
import type { TuiSettingsPickerState } from "./settings-picker.ts";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface TuiSessionNameTarget {
    readonly kind: "session";
    readonly sessionId: string;
}

export interface TuiPoolNameTarget {
    readonly kind: "pool";
    readonly provider: string;
    readonly model: string;
}

export type TuiNamePromptTarget = TuiSessionNameTarget | TuiPoolNameTarget;

/**
 * The name line for one row, either a session or a pool entry.
 *
 * Its own overlay rather than the picker's search box: what is typed here
 * names the row, and the picker's box filters the list.
 */
export interface TuiNamePromptState {
    readonly target: TuiNamePromptTarget;
    /** The row as it reads now, which may still be a fallback label. */
    readonly label: string;
    readonly value: string;
    /** The pane this was opened over, restored when it closes. */
    readonly parent?: TuiSettingsPickerState;
}

export interface TuiNamePromptKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiNamePromptTransition {
    readonly state?: TuiNamePromptState;
    readonly handled: boolean;
    /**
     * The requested name on a submit, null to clear it. Absent means the
     * overlay closed without asking for anything.
     */
    readonly submitted?: string | null;
}

export interface TuiNamePromptView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    update(state: TuiNamePromptState): void;
}

export function startTuiNamePrompt(
    target: TuiNamePromptTarget,
    label: string,
    parent?: TuiSettingsPickerState,
): TuiNamePromptState {
    // The field opens empty rather than holding the current row text: a row
    // with no name of its own reads as its first prompt, and prefilling would
    // offer to save that sentence as the name.
    return {
        target,
        label,
        value: "",
        ...(parent === undefined ? {} : { parent }),
    };
}

export function handleTuiNamePromptPaste(
    state: TuiNamePromptState,
    text: string,
): TuiNamePromptState {
    const pasted = text.replaceAll(new RegExp(CONTROL_CHARACTERS, "g"), "")
        .trim();
    return pasted.length === 0
        ? state
        : { ...state, value: state.value + pasted };
}

export function handleTuiNamePromptKey(
    state: TuiNamePromptState,
    key: TuiNamePromptKey,
): TuiNamePromptTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    // Everything else is swallowed rather than passed down. The pane this is
    // drawn over is a list with its own bindings, and a key that fell through
    // would move a row nobody can see, or reopen this prompt over itself and
    // lose what has been typed. Interrupt and the palette are decided ahead of
    // any overlay, so they are not reachable from here to begin with.
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: true };
    }
    if (key.name === "backspace") {
        return {
            state: { ...state, value: state.value.slice(0, -1) },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const value = state.value.trim();
        // Submitting an empty field clears the name and restores the
        // first-prompt fallback, which is what bare `/rename` does. Escape is
        // the way out for someone who meant neither.
        return { handled: true, submitted: value.length === 0 ? null : value };
    }
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
        ? key.name
        : undefined;
    if (typed === undefined || CONTROL_CHARACTERS.test(typed)) {
        return { state, handled: true };
    }
    return { state: { ...state, value: state.value + typed }, handled: true };
}

export function createTuiNamePromptView(
    renderer: RenderContext,
): TuiNamePromptView {
    const title = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        attributes: 1,
        width: "100%",
        height: 1,
    });
    const hint = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const entry = new TextRenderable(renderer, {
        content: "",
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "⏎ save · ⏎ on an empty field clears · esc cancel",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "name-prompt",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(title);
    box.add(hint);
    box.add(entry);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "name-prompt-surface", box);
    return {
        box,
        surface,
        update(state): void {
            title.content = state.target.kind === "session"
                ? "Rename conversation"
                : "Name pooled model";
            hint.content = state.label;
            entry.content = tuiNamePromptEntryLine(state.value);
        },
    };
}

export function tuiNamePromptEntryLine(value: string): StyledText {
    return new StyledText([
        value.length === 0
            ? fg(TUI_MUTED)("name")
            : fg(TUI_TEXT)(value),
        fg(TUI_ACCENT)("▏"),
    ]);
}
