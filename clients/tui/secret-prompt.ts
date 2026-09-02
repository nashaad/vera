import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    createDialogTextFieldNode,
    DIALOG_CARD_Z_INDEX,
    updateDialogTextFieldNode,
} from "./dialog-chrome.ts";
import type { TuiSettingsPickerState } from "./settings-picker.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

export interface TuiSecretPromptState {
    /** Bumped for each prompt, so reopening the card starts the field empty rather than showing the last key. */
    readonly editorSession: number;
    readonly providerId: string;
    readonly label: string;
    readonly hint?: string;
    /** The onboarding step line, present only while the gates are unfinished. */
    readonly rail?: string;
    /** What the provider said when it turned the last key down. */
    readonly refusal?: string;
    readonly value: string;
    readonly parent?: TuiSettingsPickerState;
}

export interface TuiSecretPromptKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiSecretPromptTransition {
    readonly state?: TuiSecretPromptState;
    readonly handled: boolean;
    readonly submitted?: string;
}

export interface TuiSecretPromptView {
    readonly box: BoxRenderable;
    readonly card: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    focus(): void;
    handleKey(
        state: TuiSecretPromptState,
        key: TuiSecretPromptKey,
    ): TuiSecretPromptTransition;
    handlePaste(state: TuiSecretPromptState, text: string): TuiSecretPromptState;
    update(state: TuiSecretPromptState): void;
}

export function startTuiSecretPrompt(
    provider: {
        readonly id: string;
        readonly label: string;
        readonly hint?: string;
    },
    parent?: TuiSettingsPickerState,
    rail?: string,
    refusal?: string,
): TuiSecretPromptState {
    return {
        editorSession: nextEditorSession++,
        providerId: provider.id,
        label: provider.label,
        ...(provider.hint === undefined ? {} : { hint: provider.hint }),
        ...(rail === undefined ? {} : { rail }),
        ...(refusal === undefined ? {} : { refusal }),
        value: "",
        ...(parent === undefined ? {} : { parent }),
    };
}

/** The card's own keys. Everything else is the field's, and the field is the one every other dialog uses. */
export function handleTuiSecretPromptKey(
    state: TuiSecretPromptState,
    key: TuiSecretPromptKey,
): TuiSecretPromptTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    if (tuiBindingId("secret_prompt", key) === "clear_secret") {
        return {
            state: { ...state, editorSession: nextEditorSession++, value: "" },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const value = state.value.trim();
        return value.length === 0
            ? { handled: true }
            : { handled: true, submitted: value };
    }
    return { state, handled: false };
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
    const rail = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
    });
    const hint = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const entry = createDialogTextFieldNode(
        renderer,
        "secret-prompt-entry",
        "API key",
    );
    const refusal = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
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
    card.add(rail);
    card.add(hint);
    card.add(entry);
    card.add(refusal);
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
    let shownEditorSession: number | undefined;
    return {
        box,
        card,
        themeBindings: [
            tuiThemeProperties(title, { fg: "text" }),
            tuiThemeProperties(rail, { fg: "muted" }),
            tuiThemeProperties(refusal, { fg: "muted" }),
            tuiThemeProperties(hint, { fg: "muted" }),
            tuiThemeProperties(entry, {
                textColor: "text",
                focusedTextColor: "text",
                backgroundColor: "panel",
                focusedBackgroundColor: "panel",
                cursorColor: "accent",
                placeholderColor: "muted",
            }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(card, { backgroundColor: "panel" }),
        ],
        focus(): void {
            entry.focus();
        },
        handleKey(state, key): TuiSecretPromptTransition {
            const current = { ...state, value: entry.plainText };
            const transition = handleTuiSecretPromptKey(current, key);
            if (transition.handled) return transition;
            entry.handleKeyPress(tuiTextareaKey(key));
            return {
                state: { ...current, value: entry.plainText },
                handled: true,
            };
        },
        handlePaste(state, text): TuiSecretPromptState {
            insertTuiSingleLinePaste(entry, text);
            return { ...state, value: entry.plainText };
        },
        update(state): void {
            if (shownEditorSession !== state.editorSession) {
                if (entry.plainText !== state.value) {
                    entry.setText(state.value);
                }
                entry.gotoBufferEnd();
                shownEditorSession = state.editorSession;
            }
            title.content = `${state.label} API key`;
            rail.content = state.rail ?? "";
            hint.content = state.hint ?? "";
            updateDialogTextFieldNode(entry, state.value, "API key");
            refusal.content = state.refusal === undefined
                ? ""
                : `${state.label} refused this key: ${state.refusal}`;
            footer.content = state.refusal === undefined
                ? `⏎ save · ${tuiKeyHint("clear_secret")} · esc cancel`
                : `⏎ try again · ${
                    tuiKeyHint("clear_secret")
                } · esc change provider`;
        },
    };
}

let nextEditorSession = 1;
