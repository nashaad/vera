import {
    BoxRenderable,
    fg,
    StyledText,
    TextRenderable,
    type Renderable,
    type RenderContext,
    type TextChunk,
} from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import { tuiThemeSwatch, type TuiThemeName } from "./theme.ts";

export type TuiSettingsPickerKind =
    | "model"
    | "reasoning"
    | "permissions"
    | "theme"
    | "session";

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
    readonly initialTheme?: TuiThemeName;
    readonly loading?: boolean;
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
    | { readonly kind: "permissions"; readonly mode: ApprovalMode }
    | { readonly kind: "theme"; readonly theme: TuiThemeName }
    | { readonly kind: "session"; readonly sessionPath: string };

export interface TuiSettingsPickerTransition {
    readonly state?: TuiSettingsPickerState;
    readonly selection?: TuiSettingsPickerSelection;
    readonly handled: boolean;
    readonly previewTheme?: TuiThemeName;
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

const THEME_OPTIONS: readonly TuiSettingsPickerOption[] = [
    { value: "default", label: "Default", description: "Vera's original palette" },
    { value: "system", label: "System", description: "inherit terminal colors" },
    { value: "orng", label: "Orng", description: "warm orange on black" },
    { value: "palenight", label: "Palenight", description: "soft blue and purple" },
    { value: "synthwave", label: "Synthwave", description: "bright cyan and neon" },
    { value: "nightowl", label: "Night Owl", description: "deep blue, low glare" },
    { value: "github", label: "GitHub", description: "GitHub dark palette" },
];

export function startTuiSettingsPicker(
    kind: TuiSettingsPickerKind,
    currentModel: string | undefined,
    currentReasoning: ModelReasoningEffort | undefined,
    currentPermissions: ApprovalMode | undefined,
    availableReasoning: readonly ModelReasoningEffort[] | undefined = undefined,
    availableModels: readonly SuggestedModel[] | undefined = undefined,
    currentTheme: TuiThemeName = "default",
): TuiSettingsPickerState {
    const options = kind === "theme"
        ? THEME_OPTIONS
        : kind === "model"
        ? modelOptions(availableModels, currentModel)
        : kind === "reasoning"
            ? reasoningOptions(availableReasoning)
            : PERMISSION_OPTIONS;
    const currentValue = kind === "theme"
        ? currentTheme
        : kind === "model"
        ? currentModel
        : kind === "reasoning"
            ? currentReasoning ?? "default"
            : currentPermissions;
    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === currentValue),
    );
    return {
        kind,
        allOptions: options,
        options,
        selectedIndex,
        query: "",
        ...(kind === "theme" ? { initialTheme: currentTheme } : {}),
    };
}

export function startTuiSessionPicker(
    agents: readonly RegisteredAgentSummary[],
    currentAgentId?: string,
    loading = false,
): TuiSettingsPickerState {
    const options = agents
        .filter((agent) => agent.kind === "interactive"
            && agent.id !== currentAgentId
            && agent.status !== "closed"
            && agent.status !== "failed")
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )
        .map((agent) => ({
            value: agent.session_path,
            label: agent.title ?? agent.id.slice(0, 8),
            description: `${agent.status} · ${agent.workspace}`,
        }));
    return {
        kind: "session",
        allOptions: options,
        options,
        selectedIndex: 0,
        query: "",
        loading,
    };
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
        return {
            handled: true,
            ...(state.kind === "theme" && state.initialTheme !== undefined
                ? { previewTheme: state.initialTheme }
                : {}),
        };
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
        const next = {
                ...state,
                selectedIndex: Math.max(0, state.selectedIndex - 1),
            };
        return {
            state: next,
            handled: true,
            ...themePreview(next),
        };
    }
    if (key.name === "down") {
        const next = {
                ...state,
                selectedIndex: Math.min(
                    state.options.length - 1,
                    state.selectedIndex + 1,
                ),
            };
        return {
            state: next,
            handled: true,
            ...themePreview(next),
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
    let themeNodes: Renderable[] = [];
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
        backgroundColor: TUI_PANEL,
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
            for (const node of themeNodes) {
                node.destroy();
            }
            themeNodes = [];
            if (state.kind === "theme") {
                content.visible = false;
                box.title = undefined;
                box.border = false;
                box.left = "20%";
                box.width = "60%";
                box.height = state.allOptions.length + 7;
                box.paddingLeft = 2;
                box.paddingRight = 2;
                box.paddingTop = 1;
                renderThemePickerRows(renderer, box, state, themeNodes);
                return;
            }
            content.visible = true;
            box.border = true;
            box.left = "10%";
            box.width = "80%";
            box.paddingLeft = 1;
            box.paddingRight = 1;
            box.title = pickerTitle(state.kind);
            box.height = Math.min(
                18,
                state.options.length + 9,
            );
            content.content = renderTuiSettingsPicker(state);
        },
    };
}

const THEME_LABEL_WIDTH = 11;

function renderThemePickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
): void {
    const header = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
    });
    header.add(new TextRenderable(renderer, {
        content: "Theme",
        fg: TUI_TEXT,
        attributes: 1,
    }));
    header.add(new TextRenderable(renderer, {
        content: "esc",
        fg: TUI_MUTED,
    }));
    const search = new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_MUTED)("⌕  "),
            fg(state.query.length === 0 ? TUI_MUTED : TUI_ACCENT)(
                state.query.length === 0 ? "Search" : state.query,
            ),
        ]),
        width: "100%",
        height: 2,
        paddingLeft: 1,
        paddingTop: 1,
    });
    box.add(header);
    box.add(search);
    nodes.push(header, search);

    // Show the curated catalog even while filtering: unmatched rows dim rather
    // than vanish, so the list keeps its stable palette-card shape.
    const matches = new Set(state.options.map((option) => option.value));
    state.allOptions.forEach((option) => {
        const active = option.value === state.options[state.selectedIndex]?.value;
        const current = option.value === state.initialTheme;
        const matched = matches.has(option.value);
        const row = new TextRenderable(renderer, {
            content: themeRowContent(option, active, current, matched),
            bg: active ? TUI_ELEMENT : TUI_PANEL,
            width: "100%",
            height: 1,
            paddingRight: 1,
        });
        box.add(row);
        nodes.push(row);
    });

    const footer = new TextRenderable(renderer, {
        content: "↑↓ move · ⏎ apply · esc cancel",
        fg: TUI_MUTED,
        width: "100%",
        height: 2,
        paddingLeft: 1,
        paddingTop: 1,
    });
    box.add(footer);
    nodes.push(footer);
}

function themeRowContent(
    option: TuiSettingsPickerOption,
    active: boolean,
    current: boolean,
    matched: boolean,
): StyledText {
    const labelColor = matched
        ? (active || current ? TUI_ACCENT : TUI_TEXT)
        : TUI_MUTED;
    const chunks: TextChunk[] = [
        fg(active ? TUI_ACCENT : TUI_PANEL)("▌ "),
        fg(TUI_ACCENT)(current ? "● " : "  "),
        fg(labelColor)(option.label.padEnd(THEME_LABEL_WIDTH)),
        ...themeSwatchChunks(option.value as TuiThemeName, matched),
        fg(matched ? TUI_MUTED : TUI_PANEL)(`  ${option.description}`),
    ];
    return new StyledText(chunks);
}

function themeSwatchChunks(name: TuiThemeName, matched: boolean): TextChunk[] {
    const swatch = tuiThemeSwatch(name);
    if (swatch === undefined) {
        // System inherits the terminal palette, unknown until applied.
        return [fg(TUI_MUTED)("░░ ░░ ░░ ░░")];
    }
    return swatch.flatMap((color, index) => [
        ...(index === 0 ? [] : [fg(TUI_PANEL)(" ")]),
        fg(matched ? color : TUI_MUTED)("██"),
    ]);
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
    const empty = state.kind === "session" && rows.length === 0
        ? state.loading
            ? "Loading conversations…"
            : "No conversations found"
        : rows.join("\n");
    return `${search}${empty}\n\n↑↓ move · enter select · esc close`;
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
    const next = { ...state, options, selectedIndex: 0, query };
    return {
        state: next,
        handled: true,
        ...themePreview(next),
    };
}

function themePreview(
    state: TuiSettingsPickerState,
): { readonly previewTheme?: TuiThemeName } {
    if (state.kind !== "theme") {
        return {};
    }
    const value = state.options[state.selectedIndex]?.value;
    return value === undefined ? {} : { previewTheme: value as TuiThemeName };
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
    if (kind === "permissions") {
        return { kind, mode: value as ApprovalMode };
    }
    if (kind === "session") {
        return { kind, sessionPath: value };
    }
    return { kind, theme: value as TuiThemeName };
}

function pickerTitle(kind: TuiSettingsPickerKind): string {
    return kind === "model"
        ? " Model "
        : kind === "reasoning"
            ? " Reasoning "
            : kind === "permissions"
                ? " Permissions "
                : kind === "session"
                    ? " Resume "
                    : " Themes ";
}

function unchanged(
    state: TuiSettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition {
    return { state, handled };
}
