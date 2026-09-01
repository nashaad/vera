import { BoxRenderable, fg, italic, StyledText, TextRenderable, type RenderContext } from "@opentui/core";

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
    DeveloperSettings,
    DeveloperSettingsPatch,
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
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

import {
    type TuiSettingsPickerState,
} from "./settings-picker-types.ts";

/**
 * The declaration form for a provider Vera does not ship: an OpenAI- or
 * Anthropic-compatible endpoint the user runs or pays for themselves.
 *
 * The quirk flags a declaration can carry (`images`, `max_tokens`,
 * `thinking`) stay hand-edited in `config.json`, which remains the file this
 * form writes and never a second source of truth.
 *
 * The key field is on this screen rather than in a prompt that follows it, so
 * declaring an endpoint and giving it a key is one action in any order. It is
 * present only while the credential choice is `api_key`; the key itself goes
 * to the credential store, never to `config.json`.
 */
export type TuiProviderFormFieldId =
    | "id"
    | "base_url"
    | "protocol"
    | "credential"
    | "api_key";

/** Every field the form can show, in screen order. */
export const TUI_PROVIDER_FORM_FIELDS: readonly TuiProviderFormFieldId[] = [
    "id",
    "base_url",
    "protocol",
    "credential",
    "api_key",
];

/** The fields this form actually shows, which the credential choice decides. */
export function tuiProviderFormFields(
    state: TuiProviderFormState,
): readonly TuiProviderFormFieldId[] {
    // A provider Vera ships already owns its name and its wire protocol: the
    // adapter is written against them. What moves is where it answers, and the
    // key that reaches it.
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
    readonly id: string;
    readonly baseUrl: string;
    readonly protocol: VeraProviderProtocol;
    readonly credential: VeraProviderCredential;
    /** Held only while the form is open, and never rendered in the clear. */
    readonly apiKey: string;
    readonly field: TuiProviderFormFieldId;
    /** Set by a refused submit, cleared by the next edit. */
    readonly error?: string;
    /** The pane this was opened over, restored when it closes. */
    readonly parent?: TuiSettingsPickerState;
    /**
     * The name this form opened on, when it opened on an existing declaration.
     * Absent on a new one. A submit whose name moved away from this is a
     * rename, which the caller settles by moving the stored credential.
     */
    readonly editing?: string;
    /**
     * Set when the form opened on a provider Vera ships. Its endpoint is the
     * only thing it declares, so the rest of the fields are not shown and the
     * submit is an override rather than a declaration.
     */
    readonly shipped?: boolean;
}

/** A finished form, on its way to the caller that owns the config file. */
export interface TuiProviderFormDeclaration {
    readonly id: string;
    readonly declaration: VeraCustomProviderConfig;
    /**
     * The key to store alongside the declaration, when one was entered. Absent
     * on a declaration that carries no key, so the caller stores nothing.
     */
    readonly apiKey?: string;
    /** The name this declaration replaces, when the form opened on one. */
    readonly replaces?: string;
    /**
     * Set when this is a shipped provider's endpoint rather than a
     * declaration. The caller writes `provider_endpoints`, not `providers`.
     */
    readonly shipped?: boolean;
    /** Set when a shipped provider goes back to the host Vera ships with. */
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
    /** Present only on a submit that passed the form's own checks. */
    readonly submitted?: TuiProviderFormDeclaration;
}

export interface TuiProviderFormView {
    /** The visible card; focus lives here. */
    readonly box: BoxRenderable;
    /** Full-screen centering surface; visibility lives here. */
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
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
        /** A provider Vera ships, opened to move its endpoint. */
        readonly shipped?: boolean;
    },
): TuiProviderFormState {
    return {
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

/**
 * A pasted base URL. Same reason the secret prompt takes one: the terminal
 * delivers a bracketed paste as its own event rather than as keystrokes, and a
 * URL is the field most likely to arrive that way.
 */
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
    // Swallowed rather than passed down, for the same reason the name prompt
    // swallows them: the pane behind this card is a list with its own
    // bindings, and a key falling through would move a row nobody can see.
    // Interrupt is decided ahead of every overlay and never reaches here.
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

/** One step through the shown fields, wrapping at either end. */
export function movedProviderFormField(
    state: TuiProviderFormState,
    step: 1 | -1,
): TuiProviderFormState {
    const fields = tuiProviderFormFields(state);
    const at = fields.indexOf(state.field);
    const next = (at + step + fields.length) % fields.length;
    return { ...state, field: fields[next]! };
}

/**
 * What the form can decide on its own: a name that is usable as a key and a
 * URL that is there at all. Whether the URL is one Vera will accept is the
 * config writer's call, and its refusal comes back on the same error line.
 *
 * Checks run here rather than on every edit, so a half-typed field never
 * blocks moving to another one.
 */
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
    // A shipped provider always has a host to fall back to, so an emptied
    // field is the way back to it rather than a mistake.
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
            // An empty key field is a declaration without a key yet, not an
            // empty key, so it is left off rather than stored as "".
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
    // Turning the key off drops what was typed rather than keeping it out of
    // sight, so a declaration saved as keyless carries no key anywhere.
    return state.credential === "api_key"
        ? { ...rest, credential: "none", apiKey: "" }
        : { ...rest, credential: "api_key" };
}

/**
 * The shown rows as they read on screen, cursor and all.
 *
 * The key is drawn in the clear. A field being filled in shows its literal
 * value, so a paste that arrived truncated is visible while it can still be
 * fixed. Masking would belong to a stored key shown back to a passer-by, and
 * no surface does that.
 *
 * A field standing empty shows its placeholder softened, so nothing on this
 * card reads as a value already there.
 */
export function tuiProviderFormRows(
    state: TuiProviderFormState,
): readonly StyledText[] {
    return tuiProviderFormFields(state).map((field) => {
        const focused = state.field === field;
        const value = providerFormTextField(field)
            ? providerFormFieldValue(state, field)
            : field === "protocol"
            ? state.protocol
            : state.credential === "api_key"
            ? "API key"
            : "none";
        const empty = value.length === 0;
        // A key already stored is covered until the cursor is on it. Typing
        // one stays in the clear: a row of dots hides whether a paste landed
        // whole, which is the mistake this field exists to catch.
        const shown = field === "api_key" && !focused
            // A fixed count rather than one dot per character: the real length
            // wraps the card at any real key, and it is a fact about the
            // secret that the field has no reason to publish.
            ? "•".repeat(Math.min(value.length, 12))
            : value;
        return new StyledText([
            fg(focused ? TUI_ACCENT : TUI_MUTED)(focused ? "› " : "  "),
            fg(TUI_MUTED)(`${PROVIDER_FORM_LABELS[field].padEnd(10)} `),
            empty
                ? italic(fg(TUI_MUTED)(PROVIDER_FORM_PLACEHOLDERS[field]))
                : fg(TUI_TEXT)(shown),
            ...(focused && providerFormTextField(field)
                ? [fg(TUI_ACCENT)("▏")]
                : []),
        ]);
    });
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
    const rows = TUI_PROVIDER_FORM_FIELDS.map((field, index) =>
        new TextRenderable(renderer, {
            id: `provider-form-${field}`,
            content: "",
            width: "100%",
            height: "auto",
            wrapMode: "char",
            ...(index === 0 ? { marginTop: 1 } : {}),
        })
    );
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
        box.add(row);
    }
    box.add(error);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "provider-form-surface", box);
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "text" }),
            tuiThemeProperties(hint, { fg: "muted" }),
            tuiThemeProperties(error, { fg: "accent" }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(state): void {
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
            const lines = tuiProviderFormRows(state);
            rows.forEach((row, index) => {
                const line = lines[index];
                // A field the credential choice hides leaves the card
                // entirely rather than sitting there greyed out.
                row.visible = line !== undefined;
                row.content = line ?? new StyledText([]);
            });
            error.content = state.error ?? "";
            // ←→ picks between the choices on a toggle row and moves the
            // cursor on a typed one, so the hint says whichever the field
            // under the cursor actually does.
            footer.content = `↑↓ ${tuiKeyHint("next_form_field")} · ${
                providerFormTextField(state.field) ? "←→ move" : "←→ change"
            } · ⏎ save · esc cancel`;
        },
    };
}
