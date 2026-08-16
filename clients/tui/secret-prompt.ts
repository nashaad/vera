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
import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";
import type { TuiSettingsPickerState } from "./settings-picker.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";

/**
 * The API-key line for one provider.
 *
 * Its own overlay rather than a picker pane with a search box: what is typed
 * here is a secret, and it should never become a filter over anything.
 */
export interface TuiSecretPromptState {
    readonly providerId: string;
    readonly label: string;
    readonly hint?: string;
    readonly value: string;
    /** The pane this was opened over, restored when it closes. */
    readonly parent?: TuiSettingsPickerState;
}

export interface TuiSecretPromptKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiSecretPromptTransition {
    readonly state?: TuiSecretPromptState;
    readonly handled: boolean;
    /** The entered key, present only on a submit with something in it. */
    readonly submitted?: string;
}

export interface TuiSecretPromptView {
    /** Full-screen centering surface; visibility and focus live here. */
    readonly box: BoxRenderable;
    /** The visible prompt card inside the centering surface. */
    readonly card: BoxRenderable;
    update(state: TuiSecretPromptState): void;
}

export function startTuiSecretPrompt(
    provider: {
        readonly id: string;
        readonly label: string;
        readonly hint?: string;
    },
    parent?: TuiSettingsPickerState,
): TuiSecretPromptState {
    return {
        providerId: provider.id,
        label: provider.label,
        ...(provider.hint === undefined ? {} : { hint: provider.hint }),
        value: "",
        ...(parent === undefined ? {} : { parent }),
    };
}

/**
 * A pasted key.
 *
 * The terminal delivers a bracketed paste as its own event rather than as
 * keystrokes, so this field has to take it explicitly: an API key is 70-odd
 * characters nobody types by hand, which makes paste the only real way in.
 * Everything unprintable is dropped, including the newline a copied line
 * usually carries, so a paste ending in Enter does not submit half a key.
 */
export function handleTuiSecretPromptPaste(
    state: TuiSecretPromptState,
    text: string,
): TuiSecretPromptState {
    const pasted = text.replaceAll(/[\u0000-\u001f\u007f]/g, "").trim();
    return pasted.length === 0
        ? state
        : { ...state, value: state.value + pasted };
}

export function handleTuiSecretPromptKey(
    state: TuiSecretPromptState,
    key: TuiSecretPromptKey,
): TuiSecretPromptTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    // Ctrl+U, the readline key for it, because a mistyped key is not worth
    // holding backspace through.
    if (tuiBindingId("secret_prompt", key) === "clear_secret") {
        return { state: { ...state, value: "" }, handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: false };
    }
    if (key.name === "backspace") {
        return {
            state: { ...state, value: state.value.slice(0, -1) },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const value = state.value.trim();
        // An empty submit is the user changing their mind with no key to hand,
        // which is what Escape means, so it closes rather than storing "".
        return value.length === 0
            ? { handled: true }
            : { handled: true, submitted: value };
    }
    // Keys arrive one character at a time, but a paste arrives as one event
    // carrying the whole string, which is how most keys get here. The sequence
    // is what was actually typed and the name is not: a shifted letter arrives
    // as `name: "s", sequence: "S"`, and an API key stored in lower case would
    // fail on the first turn.
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
        ? key.name
        : undefined;
    // Control bytes mean this was a key rather than text: an escape sequence, a
    // tab, a stray newline on its own.
    if (typed === undefined || /[\u0000-\u001f\u007f]/.test(typed.replaceAll(/[\r\n]/g, ""))) {
        return { state, handled: false };
    }
    return {
        state: { ...state, value: state.value + typed.replaceAll(/[\r\n]/g, "") },
        handled: true,
    };
}

export function createTuiSecretPromptView(
    renderer: RenderContext,
): TuiSecretPromptView {
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
        // Per character, because a key is one unbroken token: word wrapping
        // would leave it on one line and paint it out through the right edge of
        // the dialog and over the transcript behind it.
        wrapMode: "char",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: `⏎ save · ${tuiKeyHint("clear_secret")} · esc cancel`,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const card = new BoxRenderable(renderer, {
        id: "secret-prompt-card",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        maxHeight: "90%",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
    });
    card.add(title);
    card.add(hint);
    card.add(entry);
    card.add(footer);
    const box = new BoxRenderable(renderer, {
        id: "secret-prompt",
        border: false,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: DIALOG_CARD_Z_INDEX,
        alignItems: "center",
        justifyContent: "center",
        focusable: true,
        visible: false,
    });
    box.add(card);
    return {
        box,
        card,
        update(state): void {
            title.content = `${state.label} API key`;
            hint.content = state.hint ?? "";
            entry.content = tuiSecretEntryLine(state.value);
        },
    };
}

/**
 * The entry line, empty or not.
 *
 * The value shows as it was typed. It was masked once, which read as a row of
 * dots rather than as a field with a key in it and hid the one thing worth
 * checking about a paste: that the whole key landed. The secret is on screen
 * only while a dialog the user opened deliberately is open, and it is never
 * written to the transcript or the event log.
 *
 * An empty field says what goes in it, in muted text, the way every search box
 * in the TUI does.
 */
export function tuiSecretEntryLine(value: string): StyledText {
    return new StyledText([
        value.length === 0 ? fg(TUI_MUTED)("API key") : fg(TUI_TEXT)(value),
        // The caret keeps the line reading as a live input once it empties out
        // again, which is the same reason the search boxes carry one.
        fg(TUI_ACCENT)("▏"),
    ]);
}
