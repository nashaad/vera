import {
    BoxRenderable,
    fg,
    italic,
    StyledText,
    TextareaRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    isJobAssignmentId,
    JOB_ASSIGNMENT_INTENTS,
    type ModelAssignmentId,
    type ModelAssignmentRow,
} from "../../src/config/model-assignments.ts";
import type {
    ModelPricing,
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { formatBlendedRate, formatListedRates } from "../../src/model/listed-rates.ts";
import {
    INTELLIGENCE_CUTOFFS,
    stepIntelligenceCutoff,
    passesIntelligenceCutoff,
    type IntelligenceCutoff,
} from "../../src/model/intelligence-cutoff.ts";
import { isSafeProviderId } from "../../src/providers/provider-id.ts";
import {
    isVeraProviderId,
    type VeraCustomProviderConfig,
    type VeraProviderCredential,
    type VeraProviderProtocol,
} from "../../src/config.ts";
import type {
    ModelTurnSettings,
    ReviewerModelDefault,
    ReviewerModelSelection,
} from "../../src/engine/model-settings.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import {
    dialogBoxHeight,
    halfPageCursor,
    LIST_MIN_ROWS,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import { centeredDialogSurface } from "./dialog-chrome.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    createTuiSingleLineTextarea,
    insertTuiSingleLinePaste,
    syncTuiSingleLineTextarea,
    tuiTextareaKey,
} from "./single-line-editor.ts";

import {
    type TuiSettingsPickerState,
} from "./settings-picker-types.ts";

export type TuiProviderFormFieldId =
    | "id"
    | "base_url"
    | "protocol"
    | "credential"
    | "api_key";

export const TUI_PROVIDER_FORM_FIELDS: readonly TuiProviderFormFieldId[] = [
    "id",
    "base_url",
    "protocol",
    "credential",
    "api_key",
];

export function tuiProviderFormFields(
    state: TuiProviderFormState,
): readonly TuiProviderFormFieldId[] {
    const shown = state.shipped === true
        ? TUI_PROVIDER_FORM_FIELDS.filter(
            (field) => field === "base_url" || field === "api_key",
        )
        : TUI_PROVIDER_FORM_FIELDS;
    return state.credential === "api_key"
        ? shown
        : shown.filter((field) => field !== "api_key");
}

export interface TuiProviderFormState {
    readonly editorSession: number;
    readonly id: string;
    readonly baseUrl: string;
    readonly protocol: VeraProviderProtocol;
    readonly credential: VeraProviderCredential;
    readonly apiKey: string;
    readonly field: TuiProviderFormFieldId;
    readonly error?: string;
    readonly parent?: TuiSettingsPickerState;
    readonly editing?: string;
    readonly shipped?: boolean;
}

export interface TuiProviderFormDeclaration {
    readonly id: string;
    readonly declaration: VeraCustomProviderConfig;
    readonly apiKey?: string;
    readonly replaces?: string;
    readonly shipped?: boolean;
    readonly restore?: boolean;
}

export interface TuiProviderFormKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface TuiProviderFormTransition {
    readonly state?: TuiProviderFormState;
    readonly handled: boolean;
    readonly submitted?: TuiProviderFormDeclaration;
}

export interface TuiProviderFormView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    focus(): void;
    handleKey(
        state: TuiProviderFormState,
        key: TuiProviderFormKey,
    ): TuiProviderFormTransition;
    handlePaste(state: TuiProviderFormState, text: string): TuiProviderFormState;
    update(state: TuiProviderFormState): void;
}

export function startTuiProviderForm(
    parent?: TuiSettingsPickerState,
    existing?: {
        readonly id: string;
        readonly baseUrl: string;
        readonly protocol: VeraProviderProtocol;
        readonly credential: VeraProviderCredential;
        readonly apiKey?: string;
        readonly shipped?: boolean;
    },
): TuiProviderFormState {
    return {
        editorSession: nextProviderFormEditorSession++,
        id: existing?.id ?? "",
        baseUrl: existing?.baseUrl ?? "",
        protocol: existing?.protocol ?? "openai-chat",
        credential: existing?.credential ?? "api_key",
        apiKey: existing?.apiKey ?? "",
        field: existing === undefined ? "id" : "base_url",
        ...(parent === undefined ? {} : { parent }),
        ...(existing === undefined ? {} : { editing: existing.id }),
        ...(existing?.shipped === true ? { shipped: true } : {}),
    };
}

export function handleTuiProviderFormPaste(
    state: TuiProviderFormState,
    text: string,
): TuiProviderFormState {
    const pasted = text.replaceAll(PROVIDER_FORM_CONTROL_RUN, "").trim();
    if (pasted.length === 0 || !providerFormTextField(state.field)) {
        return state;
    }
    return editedProviderFormField(
        state,
        providerFormFieldValue(state, state.field) + pasted,
    );
}

export function handleTuiProviderFormKey(
    state: TuiProviderFormState,
    key: TuiProviderFormKey,
): TuiProviderFormTransition {
    if (key.name === "escape") {
        return { handled: true };
    }
    const binding = tuiBindingId("provider_form", key);
    if (binding === "next_form_field") {
        return { state: movedProviderFormField(state, 1), handled: true };
    }
    if (binding === "previous_form_field") {
        return { state: movedProviderFormField(state, -1), handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return { state, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        return {
            state: movedProviderFormField(state, key.name === "up" ? -1 : 1),
            handled: true,
        };
    }
    if (
        !providerFormTextField(state.field)
        && (key.name === "left" || key.name === "right" || key.name === "space")
    ) {
        return { state: toggledProviderFormChoice(state), handled: true };
    }
    if (key.name === "return" || key.name === "enter") {
        return submittedProviderForm(state);
    }
    if (!providerFormTextField(state.field)) {
        return { state, handled: true };
    }
    if (key.name === "backspace") {
        return {
            state: editedProviderFormField(
                state,
                providerFormFieldValue(state, state.field).slice(0, -1),
            ),
            handled: true,
        };
    }
    const typed = key.sequence !== undefined && key.sequence.length > 0
        ? key.sequence
        : key.name.length === 1
        ? key.name
        : undefined;
    if (typed === undefined || PROVIDER_FORM_CONTROL_CHARACTERS.test(typed)) {
        return { state, handled: true };
    }
    return {
        state: editedProviderFormField(
            state,
            providerFormFieldValue(state, state.field) + typed,
        ),
        handled: true,
    };
}

export function movedProviderFormField(
    state: TuiProviderFormState,
    step: 1 | -1,
): TuiProviderFormState {
    const fields = tuiProviderFormFields(state);
    const at = fields.indexOf(state.field);
    const next = (at + step + fields.length) % fields.length;
    return { ...state, field: fields[next]! };
}

export function submittedProviderForm(
    state: TuiProviderFormState,
): TuiProviderFormTransition {
    const id = state.id.trim();
    const baseUrl = state.baseUrl.trim();
    if (id.length === 0) {
        return providerFormError(state, "id", "a name is required");
    }
    if (/\s/.test(id)) {
        return providerFormError(state, "id", "a name cannot contain spaces");
    }
    if (!isSafeProviderId(id)) {
        return providerFormError(
            state,
            "id",
            "use lowercase letters, numbers, dots, dashes, or underscores",
        );
    }
    if (state.shipped !== true && isVeraProviderId(id)) {
        return providerFormError(state, "id", `${id} is a provider Vera ships`);
    }
    if (baseUrl.length === 0 && state.shipped !== true) {
        return providerFormError(state, "base_url", "a base URL is required");
    }
    const apiKey = state.credential === "api_key" ? state.apiKey.trim() : "";
    return {
        handled: true,
        submitted: {
            id,
            declaration: {
                protocol: state.protocol,
                base_url: baseUrl,
                credential: state.credential,
            },
            ...(apiKey.length === 0 ? {} : { apiKey }),
            ...(state.editing === undefined || state.editing === id
                ? {}
                : { replaces: state.editing }),
            ...(state.shipped === true ? { shipped: true } : {}),
            ...(state.shipped === true && baseUrl.length === 0
                ? { restore: true }
                : {}),
        },
    };
}

export function providerFormError(
    state: TuiProviderFormState,
    field: TuiProviderFormFieldId,
    error: string,
): TuiProviderFormTransition {
    return { state: { ...state, field, error }, handled: true };
}

export function providerFormTextField(field: TuiProviderFormFieldId): boolean {
    return field === "id" || field === "base_url" || field === "api_key";
}

export function providerFormFieldValue(
    state: TuiProviderFormState,
    field: TuiProviderFormFieldId,
): string {
    return field === "id"
        ? state.id
        : field === "api_key"
        ? state.apiKey
        : state.baseUrl;
}

export function editedProviderFormField(
    state: TuiProviderFormState,
    value: string,
): TuiProviderFormState {
    const { error: _error, ...rest } = state;
    return state.field === "id"
        ? { ...rest, id: value }
        : state.field === "api_key"
        ? { ...rest, apiKey: value }
        : { ...rest, baseUrl: value };
}

export function toggledProviderFormChoice(
    state: TuiProviderFormState,
): TuiProviderFormState {
    const { error: _error, ...rest } = state;
    if (state.field === "protocol") {
        return {
            ...rest,
            protocol: state.protocol === "openai-chat"
                ? "anthropic-messages"
                : "openai-chat",
        };
    }
    return state.credential === "api_key"
        ? { ...rest, credential: "none", apiKey: "" }
        : { ...rest, credential: "api_key" };
}

export function tuiProviderFormRows(
    state: TuiProviderFormState,
): readonly StyledText[] {
    return tuiProviderFormFields(state).map((field) => {
        const focused = state.field === field;
        const value = providerFormTextField(field)
            ? providerFormFieldValue(state, field)
            : "";
        const empty = value.length === 0;
        const shown = field === "api_key" && !focused
            ? "•".repeat(Math.min(value.length, 12))
            : value;
        return new StyledText([
            fg(focused ? TUI_ACCENT : TUI_MUTED)(focused ? "› " : "  "),
            fg(TUI_MUTED)(`${PROVIDER_FORM_LABELS[field].padEnd(10)} `),
            ...(providerFormTextField(field)
                ? [empty
                    ? italic(fg(TUI_MUTED)(PROVIDER_FORM_PLACEHOLDERS[field]))
                    : fg(TUI_TEXT)(shown)]
                : providerFormChoiceChunks(
                    state,
                    field === "protocol" ? "protocol" : "credential",
                )),
        ]);
    });
}

function providerFormChoiceChunks(
    state: TuiProviderFormState,
    field: "protocol" | "credential",
) {
    const choices = field === "protocol"
        ? [
            { value: "openai-chat", label: "OpenAI chat" },
            { value: "anthropic-messages", label: "Anthropic" },
        ] as const
        : [
            { value: "api_key", label: "API key" },
            { value: "none", label: "No key" },
        ] as const;
    const selected = field === "protocol" ? state.protocol : state.credential;
    return choices.flatMap((choice, index) => [
        ...(index === 0 ? [] : [fg(TUI_MUTED)("   ")]),
        fg(choice.value === selected ? TUI_TEXT : TUI_MUTED)(
            `${choice.value === selected ? "●" : "○"} ${choice.label}`,
        ),
    ]);
}

export const PROVIDER_FORM_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const PROVIDER_FORM_CONTROL_RUN = /[\u0000-\u001f\u007f]/g;

export const PROVIDER_FORM_LABELS: Readonly<Record<TuiProviderFormFieldId, string>> = {
    id: "Name",
    base_url: "Base URL",
    protocol: "Protocol",
    credential: "Credential",
    api_key: "Key",
};

export const PROVIDER_FORM_PLACEHOLDERS: Readonly<
    Record<TuiProviderFormFieldId, string>
> = {
    id: "my-endpoint",
    base_url: "https://…/v1",
    protocol: "openai-chat",
    credential: "API key",
    api_key: "paste or type it, or leave it for later",
};

export function createTuiProviderFormView(
    renderer: RenderContext,
): TuiProviderFormView {
    const title = new TextRenderable(renderer, {
        content: "Declare a provider",
        fg: TUI_TEXT,
        attributes: 1,
        width: "100%",
        height: 1,
    });
    const hint = new TextRenderable(renderer, {
        content: "An OpenAI- or Anthropic-compatible endpoint of your own.",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const rows = TUI_PROVIDER_FORM_FIELDS.map((field, index) => {
        const row = new BoxRenderable(renderer, {
            id: `provider-form-${field}`,
            width: "100%",
            height: 1,
            flexDirection: "row",
            ...(index === 0 ? { marginTop: 1 } : {}),
        });
        const label = new TextRenderable(renderer, {
            content: "",
            width: 14,
            height: 1,
            flexShrink: 0,
        });
        const value = new TextRenderable(renderer, {
            content: "",
            height: 1,
            flexGrow: 1,
            flexShrink: 1,
            wrapMode: "none",
            overflow: "hidden",
        });
        row.add(label);
        let editor: TextareaRenderable | undefined;
        let editorBox: BoxRenderable | undefined;
        if (providerFormTextField(field)) {
            editor = createTuiSingleLineTextarea(renderer, {
                id: `provider-form-${field}-editor`,
                placeholder: PROVIDER_FORM_PLACEHOLDERS[field],
                backgroundColor: TUI_PANEL,
            });
            editorBox = new BoxRenderable(renderer, {
                width: "auto",
                height: 1,
                flexGrow: 1,
                flexShrink: 1,
                backgroundColor: TUI_PANEL,
            });
            editorBox.add(editor);
            row.add(editorBox);
        }
        row.add(value);
        return { field, row, label, value, editor, editorBox };
    });
    const error = new TextRenderable(renderer, {
        content: "",
        fg: TUI_ACCENT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "provider-form",
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
    for (const row of rows) {
        box.add(row.row);
    }
    box.add(error);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "provider-form-surface", box);
    let shownState: TuiProviderFormState | undefined;
    let shownEditorSession: number | undefined;
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "text" }),
            tuiThemeProperties(hint, { fg: "muted" }),
            ...rows.flatMap((row) => [
                tuiThemeProperties(row.label, { fg: "muted" }),
                tuiThemeProperties(row.value, { fg: "text" }),
                ...(row.editor === undefined
                    ? []
                    : [tuiThemeProperties(row.editor, {
                        textColor: "text",
                        focusedTextColor: "text",
                        backgroundColor: "panel",
                        focusedBackgroundColor: "panel",
                        cursorColor: "accent",
                        placeholderColor: "muted",
                    })]),
                ...(row.editorBox === undefined
                    ? []
                    : [tuiThemeProperties(row.editorBox, {
                        backgroundColor: "panel",
                    })]),
            ]),
            tuiThemeProperties(error, { fg: "accent" }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        focus(): void {
            const active = rows.find((row) => row.field === shownState?.field);
            if (active?.editor !== undefined) {
                active.editor.focus();
                return;
            }
            box.focus();
        },
        handleKey(state, key): TuiProviderFormTransition {
            const active = rows.find((row) => row.field === state.field);
            const current = active?.editor === undefined
                ? state
                : editedProviderFormField(state, active.editor.plainText);
            if (!providerFormTextField(state.field) || providerFormControlKey(key)) {
                return handleTuiProviderFormKey(current, key);
            }
            active?.editor?.handleKeyPress(tuiTextareaKey(key));
            return {
                state: active?.editor === undefined
                    ? current
                    : editedProviderFormField(current, active.editor.plainText),
                handled: true,
            };
        },
        handlePaste(state, text): TuiProviderFormState {
            const active = rows.find((row) => row.field === state.field);
            if (active?.editor === undefined) return state;
            insertTuiSingleLinePaste(active.editor, text);
            return editedProviderFormField(state, active.editor.plainText);
        },
        update(state): void {
            shownState = state;
            title.content = state.shipped === true
                ? `Edit ${state.id}`
                : state.editing === undefined
                ? "Declare a provider"
                : "Edit provider";
            hint.content = state.shipped === true
                ? "Where it answers, and the key that reaches it. Empty the"
                    + " URL to go back to the one Vera ships."
                : state.editing === undefined
                ? "An OpenAI- or Anthropic-compatible endpoint of your own."
                : "Change the endpoint, the protocol, or the key you stored.";
            const shownFields = new Set(tuiProviderFormFields(state));
            const lines = tuiProviderFormRows(state);
            for (const row of rows) {
                row.row.visible = shownFields.has(row.field);
                if (!row.row.visible) continue;
                const focused = row.field === state.field;
                row.label.content = new StyledText([
                    fg(focused ? TUI_ACCENT : TUI_MUTED)(
                        `${focused ? "›" : " "} ${PROVIDER_FORM_LABELS[row.field].padEnd(10)} `,
                    ),
                ]);
                if (row.editor !== undefined && row.editorBox !== undefined) {
                    if (shownEditorSession !== state.editorSession) {
                        row.editor.setText(providerFormFieldValue(state, row.field));
                        row.editor.gotoBufferEnd();
                    } else {
                        syncTuiSingleLineTextarea(
                            row.editor,
                            providerFormFieldValue(state, row.field),
                        );
                    }
                    row.editorBox.visible = focused;
                    row.value.visible = !focused;
                    if (!focused) {
                        const value = providerFormFieldValue(state, row.field);
                        row.value.content = new StyledText([
                            value.length === 0
                                ? italic(fg(TUI_MUTED)(PROVIDER_FORM_PLACEHOLDERS[row.field]))
                                : fg(TUI_TEXT)(row.field === "api_key"
                                    ? "•".repeat(Math.min(value.length, 12))
                                    : value),
                        ]);
                    }
                } else {
                    if (row.field !== "protocol" && row.field !== "credential") {
                        continue;
                    }
                    row.value.visible = true;
                    row.value.content = new StyledText(
                        providerFormChoiceChunks(state, row.field),
                    );
                }
            }
            shownEditorSession = state.editorSession;
            error.content = state.error ?? "";
            footer.content = `↑↓ ${tuiKeyHint("next_form_field")} · ${
                providerFormTextField(state.field) ? "←→ move" : "←→ change"
            } · ⏎ save · esc cancel`;
        },
    };
}

function providerFormControlKey(key: TuiProviderFormKey): boolean {
    return key.name === "escape"
        || key.name === "return"
        || key.name === "enter"
        || key.name === "up"
        || key.name === "down"
        || tuiBindingId("provider_form", key) === "next_form_field"
        || tuiBindingId("provider_form", key) === "previous_form_field";
}

let nextProviderFormEditorSession = 1;
