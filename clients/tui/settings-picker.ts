import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import { TUI_NOTICE, TUI_TEXT } from "./state.ts";

export type TuiSettingsPickerKind = "model" | "reasoning" | "permissions";

export interface TuiSettingsPickerOption {
    readonly value: string;
    readonly label: string;
    readonly description: string;
}

export interface TuiSettingsPickerState {
    readonly kind: TuiSettingsPickerKind;
    readonly allOptions: readonly TuiSettingsPickerOption[];
    readonly options: readonly TuiSettingsPickerOption[];
    readonly selectedIndex: number;
    readonly query: string;
}

export interface TuiSettingsPickerKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
    readonly shift?: boolean;
}

export type TuiSettingsPickerSelection =
    | { readonly kind: "model"; readonly model: string }
    | {
        readonly kind: "reasoning";
        readonly reasoningEffort: ModelReasoningEffort;
    }
    | { readonly kind: "permissions"; readonly mode: ApprovalMode };

export interface TuiSettingsPickerTransition {
    readonly state?: TuiSettingsPickerState;
    readonly selection?: TuiSettingsPickerSelection;
    readonly handled: boolean;
}

export interface TuiSettingsPickerView {
    readonly box: BoxRenderable;
    update(state: TuiSettingsPickerState): void;
}

const REASONING_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "off", label: "Off", description: "quick response, no extra reasoning" },
    { value: "low", label: "Low", description: "light reasoning" },
    { value: "medium", label: "Medium", description: "balanced reasoning" },
    { value: "high", label: "High", description: "deeper reasoning" },
    { value: "max", label: "Max", description: "maximum available reasoning" },
];

const PERMISSION_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "ask", label: "Ask", description: "ask before every bash command" },
    {
        value: "approve_for_me",
        label: "Approve for me",
        description: "auto-approve safe commands, ask for risky ones",
    },
    {
        value: "full_access",
        label: "Full access",
        description: "allow commands with your user permissions",
    },
];

export function startTuiSettingsPicker(
    kind: TuiSettingsPickerKind,
    currentModel: string | undefined,
    currentReasoning: ModelReasoningEffort | undefined,
    currentPermissions: ApprovalMode | undefined,
    availableReasoning: readonly ModelReasoningEffort[] | undefined = undefined,
    availableModels: readonly SuggestedModel[] | undefined = undefined,
): TuiSettingsPickerState {
    const options = kind === "model"
        ? modelOptions(availableModels, currentModel)
        : kind === "reasoning"
            ? reasoningOptions(availableReasoning)
            : PERMISSION_OPTIONS;
    const currentValue = kind === "model"
        ? currentModel
        : kind === "reasoning"
            ? currentReasoning ?? "default"
            : currentPermissions;
    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === currentValue),
    );
    return { kind, allOptions: options, options, selectedIndex, query: "" };
}

function reasoningOptions(
    available: readonly ModelReasoningEffort[] | undefined,
): readonly TuiSettingsPickerOption[] {
    return available === undefined
        ? REASONING_OPTIONS
        : REASONING_OPTIONS.filter((option) =>
            available.includes(option.value as ModelReasoningEffort)
        );
}

export function handleTuiSettingsPickerKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): TuiSettingsPickerTransition {
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return unchanged(state, false);
    }
    if (key.name === "escape") {
        return { handled: true };
    }
    if (key.name === "backspace") {
        return searched(state, state.query.slice(0, -1));
    }
    if (
        key.name.length === 1
        && !key.ctrl
        && !key.meta
    ) {
        return searched(state, state.query + key.name);
    }
    if (key.name === "up") {
        return {
            state: {
                ...state,
                selectedIndex: Math.max(0, state.selectedIndex - 1),
            },
            handled: true,
        };
    }
    if (key.name === "down") {
        return {
            state: {
                ...state,
                selectedIndex: Math.min(
                    state.options.length - 1,
                    state.selectedIndex + 1,
                ),
            },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const selected = state.options[state.selectedIndex];
        if (selected === undefined) {
            return unchanged(state, true);
        }
        return {
            selection: pickerSelection(state.kind, selected.value),
            handled: true,
        };
    }
    return unchanged(state, false);
}

export function createTuiSettingsPickerView(
    renderer: RenderContext,
): TuiSettingsPickerView {
    const content = new TextRenderable(renderer, {
        id: "settings-picker-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
    });
    const box = new BoxRenderable(renderer, {
        id: "settings-picker",
        title: " Settings ",
        border: true,
        borderColor: TUI_NOTICE,
        backgroundColor: "#16161E",
        position: "absolute",
        top: 2,
        left: "10%",
        width: "80%",
        height: 8,
        zIndex: 15,
        paddingX: 1,
        focusable: true,
        visible: false,
    });
    box.add(content);

    return {
        box,
        update(state): void {
            box.title = pickerTitle(state.kind);
            box.height = Math.min(
                18,
                state.options.length + 9,
            );
            content.content = renderTuiSettingsPicker(state);
        },
    };
}

export function renderTuiSettingsPicker(
    state: TuiSettingsPickerState,
): string {
    const rows = state.options.map((option, index) => {
        const marker = index === state.selectedIndex ? "›" : " ";
        return `${marker} ${option.label.padEnd(18)} ${option.description}`;
    });
    const search = `Search  ${state.query}\n\n${
        state.kind === "model" && state.query.length === 0 ? "Recent\n" : ""
    }`;
    return `${search}${rows.join("\n")}\n\n↑↓ move · enter select · esc close`;
}

function searched(
    state: TuiSettingsPickerState,
    query: string,
): TuiSettingsPickerTransition {
    const normalized = query.toLowerCase();
    const options = state.allOptions.filter((option) =>
        `${option.label} ${option.value} ${option.description}`
            .toLowerCase()
            .includes(normalized)
    );
    return {
        state: { ...state, options, selectedIndex: 0, query },
        handled: true,
    };
}

function modelOptions(
    available: readonly SuggestedModel[] | undefined,
    currentModel: string | undefined,
): readonly TuiSettingsPickerOption[] {
    const options = (available ?? []).map((model) => ({
        value: model.model,
        label: model.label,
        description: `${model.provider} · ${model.description}`,
    }));
    if (currentModel === undefined || options.some((option) => option.value === currentModel)) {
        return options;
    }
    return [
        {
            value: currentModel,
            label: currentModel,
            description: "current model",
        },
        ...options,
    ];
}

function pickerSelection(
    kind: TuiSettingsPickerKind,
    value: string,
): TuiSettingsPickerSelection {
    if (kind === "model") {
        return { kind, model: value };
    }
    if (kind === "reasoning") {
        return { kind, reasoningEffort: value as ModelReasoningEffort };
    }
    return { kind, mode: value as ApprovalMode };
}

function pickerTitle(kind: TuiSettingsPickerKind): string {
    return kind === "model"
        ? " Model "
        : kind === "reasoning"
            ? " Reasoning "
            : " Permissions ";
}

function unchanged(
    state: TuiSettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition {
    return { state, handled };
}
