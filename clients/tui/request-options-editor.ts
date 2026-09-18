import {
    BoxRenderable,
    TextareaRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type { JsonObject } from "../../src/sdk/hooks.ts";
import { validateProviderRequestBody } from
    "../../src/providers/request-options.ts";
import {
    centeredDialogSurface,
    DIALOG_CARD_PADDING,
    dialogFooterNode,
    dialogHeaderNode,
} from "./dialog-chrome.ts";
import {
    TUI_ACCENT,
    TUI_DANGER,
    TUI_ELEMENT,
    TUI_INPUT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import { tuiThemeProperties, type TuiThemeBinding } from
    "./theme-bindings.ts";
import type {
    TuiModelRequestOptionsCandidate,
    TuiSettingsPickerState,
} from "./settings-picker.ts";

export interface TuiRequestOptionsEditorKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiRequestOptionsEditorState {
    readonly editorSession: number;
    readonly candidate: TuiModelRequestOptionsCandidate;
    readonly profile: string;
    readonly text: string;
    readonly parent: TuiSettingsPickerState;
    readonly error?: string;
}

export interface TuiRequestOptionsSave {
    readonly provider: string;
    readonly model: string;
    readonly body: JsonObject;
    readonly parent: TuiSettingsPickerState;
}

export interface TuiRequestOptionsEditorTransition {
    readonly state?: TuiRequestOptionsEditorState;
    readonly handled: boolean;
    readonly cancelled?: boolean;
    readonly save?: TuiRequestOptionsSave;
}

export interface TuiRequestOptionsEditorView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    focus(): void;
    handleKey(
        state: TuiRequestOptionsEditorState,
        key: TuiRequestOptionsEditorKey,
    ): TuiRequestOptionsEditorTransition;
    handlePaste(
        state: TuiRequestOptionsEditorState,
        text: string,
    ): TuiRequestOptionsEditorTransition;
    update(state: TuiRequestOptionsEditorState): void;
}

export function startTuiRequestOptionsEditor(
    candidate: TuiModelRequestOptionsCandidate,
    profile: string,
    body: JsonObject | undefined,
    parent: TuiSettingsPickerState,
): TuiRequestOptionsEditorState {
    return {
        editorSession: nextEditorSession++,
        candidate,
        profile,
        text: JSON.stringify(body ?? {}, null, 2),
        parent,
    };
}

export function handleTuiRequestOptionsEditorKey(
    state: TuiRequestOptionsEditorState,
    key: TuiRequestOptionsEditorKey,
): TuiRequestOptionsEditorTransition {
    if (key.name === "escape") {
        return { handled: true, cancelled: true };
    }
    if (key.ctrl === true && key.name.toLowerCase() === "s") {
        return saveTransition(state);
    }
    return { state, handled: false };
}

export function renderTuiRequestOptionsEditor(
    state: TuiRequestOptionsEditorState,
): string {
    const { candidate } = state;
    return [
        "Request options",
        `Vera provider   ${candidate.support.providerLabel}`,
        `Model           ${candidate.model}`,
        `Scope           ${state.profile} profile · every use of this model`,
        `Body            ${candidate.support.label}`,
        "",
        candidate.support.explanation,
        `Docs            ${candidate.support.documentationUrl}`,
        "",
        state.text,
        ...(state.error === undefined ? [] : ["", `Error: ${state.error}`]),
        "",
        "esc cancel  Ctrl+S save",
    ].join("\n");
}

export function createTuiRequestOptionsEditorView(
    renderer: RenderContext,
): TuiRequestOptionsEditorView {
    const header = dialogHeaderNode(renderer, "Request options");
    const context = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const editor = new TextareaRenderable(renderer, {
        id: "request-options-json",
        width: "100%",
        height: 8,
        wrapMode: "char",
        textColor: TUI_TEXT,
        focusedTextColor: TUI_TEXT,
        backgroundColor: TUI_INPUT,
        focusedBackgroundColor: TUI_INPUT,
        cursorColor: TUI_ACCENT,
        placeholderColor: TUI_MUTED,
    });
    const editorBox = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        border: true,
        borderStyle: "single",
        borderColor: TUI_ELEMENT,
        focusedBorderColor: TUI_ELEMENT,
        backgroundColor: TUI_INPUT,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
    });
    editorBox.add(editor);
    const error = new TextRenderable(renderer, {
        content: "",
        fg: TUI_DANGER,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
        visible: false,
    });
    const footer = dialogFooterNode(renderer, "esc cancel  Ctrl+S save");
    const box = new BoxRenderable(renderer, {
        id: "request-options-editor",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "80%",
        height: "auto",
        maxHeight: Math.max(12, renderer.height - 4),
        flexDirection: "column",
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(header);
    box.add(context);
    box.add(editorBox);
    box.add(error);
    box.add(footer);
    const surface = centeredDialogSurface(
        renderer,
        "request-options-editor-surface",
        box,
    );
    let shownEditorSession: number | undefined;

    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(context, { fg: "text" }),
            tuiThemeProperties(editor, {
                textColor: "text",
                focusedTextColor: "text",
                backgroundColor: "input",
                focusedBackgroundColor: "input",
                cursorColor: "accent",
                placeholderColor: "muted",
            }),
            tuiThemeProperties(editorBox, { backgroundColor: "input" }),
            tuiThemeProperties(editorBox, {
                borderColor: "element",
                focusedBorderColor: "element",
            }),
            tuiThemeProperties(error, { fg: "danger" }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        focus(): void {
            editor.focus();
        },
        handleKey(state, key): TuiRequestOptionsEditorTransition {
            const current = { ...state, text: editor.plainText };
            const transition = handleTuiRequestOptionsEditorKey(current, key);
            if (transition.handled) return transition;
            editor.handleKeyPress(textareaKey(key));
            return {
                state: { ...current, text: editor.plainText, error: undefined },
                handled: true,
            };
        },
        handlePaste(state, text): TuiRequestOptionsEditorTransition {
            const pasted = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
                .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
            if (pasted.length > 0) editor.insertText(pasted);
            return {
                state: { ...state, text: editor.plainText, error: undefined },
                handled: true,
            };
        },
        update(state): void {
            if (shownEditorSession !== state.editorSession) {
                editor.setText(state.text);
                editor.cursorOffset = editor.plainText.length;
                shownEditorSession = state.editorSession;
            }
            context.content = [
                `Vera provider   ${state.candidate.support.providerLabel}`,
                `Model           ${state.candidate.model}`,
                `Scope           ${state.profile} profile · every use of this model`,
                `Body            ${state.candidate.support.label}`,
                "",
                state.candidate.support.explanation,
                `Docs            ${state.candidate.support.documentationUrl}`,
            ].join("\n");
            error.visible = state.error !== undefined;
            error.content = state.error === undefined ? "" : `▲ ${state.error}`;
            editor.height = Math.max(4, Math.min(12, renderer.height - 16));
        },
    };
}

let nextEditorSession = 1;

function saveTransition(
    state: TuiRequestOptionsEditorState,
): TuiRequestOptionsEditorTransition {
    try {
        const parsed: unknown = JSON.parse(state.text);
        if (
            typeof parsed !== "object"
            || parsed === null
            || Array.isArray(parsed)
        ) {
            throw new Error("Request options must be a JSON object");
        }
        const body = parsed as JsonObject;
        validateProviderRequestBody(
            state.candidate.provider,
            body,
            "request options",
        );
        return {
            handled: true,
            save: {
                provider: state.candidate.provider,
                model: state.candidate.model,
                body,
                parent: state.parent,
            },
        };
    } catch (error) {
        return {
            state: {
                ...state,
                error: error instanceof Error ? error.message : String(error),
            },
            handled: true,
        };
    }
}

function textareaKey(
    key: TuiRequestOptionsEditorKey,
): Parameters<TextareaRenderable["handleKeyPress"]>[0] {
    return {
        ...key,
        name: key.name === "enter" ? "return" : key.name,
        sequence: key.sequence ?? "",
        ctrl: key.ctrl ?? false,
        meta: key.meta ?? false,
        shift: key.shift ?? false,
        option: false,
        number: false,
        raw: key.sequence ?? "",
        eventType: "press",
        source: "raw",
    } as Parameters<TextareaRenderable["handleKeyPress"]>[0];
}
