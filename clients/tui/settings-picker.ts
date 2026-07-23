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
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import {
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER_WIDTH,
    dialogFooterNode,
    dialogGroupHeaderNode,
    dialogHeaderNode,
    dialogOptionRow,
    dialogSearchNode,
} from "./dialog-chrome.ts";
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
    readonly searchText?: string;
    readonly provider?: string;
    readonly model?: string;
}

export interface TuiSettingsPickerState {
    readonly kind: TuiSettingsPickerKind;
    readonly allOptions: readonly TuiSettingsPickerOption[];
    readonly options: readonly TuiSettingsPickerOption[];
    readonly selectedIndex: number;
    readonly query: string;
    readonly initialTheme?: TuiThemeName;
    readonly initialModel?: string;
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
    | { readonly kind: "model"; readonly provider: string; readonly model: string }
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
        description: "a reviewer clears the safe ones, you decide the rest",
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
    currentProvider: string | undefined = undefined,
): TuiSettingsPickerState {
    const options = kind === "theme"
        ? THEME_OPTIONS
        : kind === "model"
        ? modelOptions(availableModels, currentProvider, currentModel)
        : kind === "reasoning"
            ? reasoningOptions(availableReasoning)
            : PERMISSION_OPTIONS;
    const currentValue = kind === "theme"
        ? currentTheme
        : kind === "model"
        ? currentModel === undefined || currentProvider === undefined
            ? undefined
            : providerModelKey(currentProvider, currentModel)
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
        ...(kind === "model" && currentValue !== undefined
            ? { initialModel: currentValue }
            : {}),
        ...(kind === "theme" ? { initialTheme: currentTheme } : {}),
    };
}

export function startTuiSessionPicker(
    agents: readonly RegisteredAgentSummary[],
    currentAgentId?: string,
    loading = false,
    now: Date = new Date(),
): TuiSettingsPickerState {
    const options = agents
        .filter((agent) => agent.kind === "interactive"
            && agent.id !== currentAgentId
            && agent.status !== "closed"
            && agent.status !== "failed"
            && agent.title !== undefined)
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )
        .map((agent) => ({
            value: agent.session_path,
            label: truncateSessionTitle(agent.title!),
            description: sessionDescription(agent, now),
            searchText: `${agent.id} ${agent.workspace}`,
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

function truncateSessionTitle(title: string): string {
    const normalized = title.replaceAll(/\s+/g, " ").trim();
    const characters = [...normalized];
    return characters.length <= 30
        ? normalized
        : `${characters.slice(0, 29).join("")}…`;
}

function sessionDescription(
    agent: RegisteredAgentSummary,
    now: Date,
): string {
    const workspaceName = agent.workspace.split("/").filter(Boolean).at(-1)
        ?? agent.workspace;
    const workspace = workspaceName.length <= 14
        ? workspaceName
        : `${workspaceName.slice(0, 13)}…`;
    const activity = agent.status === "working" || agent.status === "waiting"
        ? agent.status
        : relativeSessionTime(agent.updated_at, now);
    return `${activity} · ${workspace}`;
}

function relativeSessionTime(value: string | undefined, now: Date): string {
    const timestamp = value === undefined ? Number.NaN : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        return "saved";
    }
    const elapsedMinutes = Math.max(
        0,
        Math.floor((now.getTime() - timestamp) / 60_000),
    );
    if (elapsedMinutes < 1) {
        return "just now";
    }
    if (elapsedMinutes < 60) {
        return `${elapsedMinutes}m ago`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `${elapsedHours}h ago`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    return elapsedDays < 7
        ? `${elapsedDays}d ago`
        : new Date(timestamp).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
        });
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
            selection: pickerSelection(state.kind, selected),
            handled: true,
        };
    }
    return unchanged(state, false);
}

export function createTuiSettingsPickerView(
    renderer: RenderContext,
): TuiSettingsPickerView {
    let nodes: Renderable[] = [];
    const box = new BoxRenderable(renderer, {
        id: "settings-picker",
        border: false,
        borderColor: TUI_ACCENT,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: 2,
        left: "10%",
        width: "80%",
        height: 8,
        zIndex: 15,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        focusable: true,
        visible: false,
    });

    return {
        box,
        update(state): void {
            for (const node of nodes) {
                node.destroy();
            }
            nodes = [];
            box.title = undefined;
            box.border = false;
            if (state.kind === "theme") {
                box.left = "20%";
                box.width = "60%";
                box.height = state.allOptions.length + DIALOG_CHROME_HEIGHT;
                renderThemePickerRows(renderer, box, state, nodes);
                return;
            }
            box.left = "10%";
            box.width = "80%";
            renderListPickerRows(renderer, box, state, nodes);
        },
    };
}

const PICKER_MAX_ROWS = 12;

type PickerDisplayRow =
    | { readonly kind: "group"; readonly label: string }
    | {
        readonly kind: "option";
        readonly option: TuiSettingsPickerOption;
        readonly index: number;
    };

function renderListPickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
): void {
    const header = dialogHeaderNode(renderer, pickerTitle(state.kind));
    const search = dialogSearchNode(renderer, state.query);
    box.add(header);
    box.add(search);
    nodes.push(header, search);

    const rows = windowedDisplayRows(
        listDisplayRows(state),
        state.selectedIndex,
    );
    let lines = 0;
    if (rows.length === 0) {
        const empty = new TextRenderable(renderer, {
            content: emptyPickerMessage(state),
            fg: TUI_MUTED,
            width: "100%",
            height: 1,
            paddingLeft: DIALOG_GUTTER_WIDTH,
        });
        box.add(empty);
        nodes.push(empty);
        lines = 1;
    }
    rows.forEach((row, position) => {
        const node = row.kind === "group"
            ? dialogGroupHeaderNode(renderer, row.label, position > 0)
            : dialogOptionRow(renderer, {
                label: row.option.label,
                leading: isCurrentOption(state, row.option) ? "● " : "  ",
                description: row.option.description,
                meta: optionMeta(state, row.option),
                active: row.index === state.selectedIndex,
                current: isCurrentOption(state, row.option),
            });
        lines += row.kind === "group" && position > 0 ? 2 : 1;
        box.add(node);
        nodes.push(node);
    });

    const footer = dialogFooterNode(renderer, "↑↓ move · ⏎ select · esc close");
    box.add(footer);
    nodes.push(footer);
    box.height = lines + DIALOG_CHROME_HEIGHT;
}

function listDisplayRows(
    state: TuiSettingsPickerState,
): readonly PickerDisplayRow[] {
    // Only the unfiltered model list is grouped: a search result is a single
    // ranked list, and the provider moves to the row's right-hand column.
    const grouped = state.kind === "model" && state.query.length === 0;
    const rows: PickerDisplayRow[] = [];
    state.options.forEach((option, index) => {
        if (
            grouped
            && state.options[index - 1]?.provider !== option.provider
        ) {
            rows.push({ kind: "group", label: option.provider ?? "Other" });
        }
        rows.push({ kind: "option", option, index });
    });
    return rows;
}

function windowedDisplayRows(
    rows: readonly PickerDisplayRow[],
    selectedIndex: number,
): readonly PickerDisplayRow[] {
    if (rows.length <= PICKER_MAX_ROWS) {
        return rows;
    }
    const cursor = rows.findIndex((row) =>
        row.kind === "option" && row.index === selectedIndex
    );
    const centered = Math.max(0, cursor) - Math.floor(PICKER_MAX_ROWS / 2);
    const start = Math.min(
        Math.max(0, centered),
        rows.length - PICKER_MAX_ROWS,
    );
    return rows.slice(start, start + PICKER_MAX_ROWS);
}

function isCurrentOption(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    return state.kind === "model" && option.value === state.initialModel;
}

function optionMeta(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): string | undefined {
    return state.kind === "model" && state.query.length > 0
        ? option.provider
        : undefined;
}

function emptyPickerMessage(state: TuiSettingsPickerState): string {
    if (state.kind !== "session") {
        return "No matches found";
    }
    return state.loading === true
        ? "Loading conversations…"
        : "No conversations found";
}

const THEME_LABEL_WIDTH = 11;

function renderThemePickerRows(
    renderer: RenderContext,
    box: BoxRenderable,
    state: TuiSettingsPickerState,
    nodes: Renderable[],
): void {
    const header = dialogHeaderNode(renderer, "Theme");
    const search = dialogSearchNode(renderer, state.query);
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

    const footer = dialogFooterNode(renderer, "↑↓ move · ⏎ apply · esc cancel");
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
        active ? fg(TUI_ACCENT)("› ") : fg(TUI_PANEL)("  "),
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

function searched(
    state: TuiSettingsPickerState,
    query: string,
): TuiSettingsPickerTransition {
    const normalized = query.toLowerCase();
    const options = state.allOptions.filter((option) =>
        `${option.label} ${option.value} ${option.description} ${
            option.searchText ?? ""
        }`
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
    currentProvider: string | undefined,
    currentModel: string | undefined,
): readonly TuiSettingsPickerOption[] {
    const options = (available ?? []).map((model) => ({
        value: providerModelKey(model.provider, model.model),
        label: model.label,
        description: model.description,
        searchText: `${model.provider} ${model.model}`,
        provider: model.provider,
        model: model.model,
    })).toSorted((left, right) =>
        left.provider.localeCompare(right.provider)
            || left.label.localeCompare(right.label)
    );
    if (currentModel === undefined || currentProvider === undefined) {
        return options;
    }
    const currentValue = providerModelKey(currentProvider, currentModel);
    if (options.some((option) => option.value === currentValue)) return options;
    return [
        {
            value: currentValue,
            label: currentModel,
            description: "current model",
            searchText: `${currentProvider} ${currentModel}`,
            provider: currentProvider,
            model: currentModel,
        },
        ...options,
    ];
}

function providerModelKey(provider: string, model: string): string {
    return JSON.stringify([provider, model]);
}

function pickerSelection(
    kind: TuiSettingsPickerKind,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerSelection {
    if (kind === "model") {
        if (option.provider === undefined || option.model === undefined) {
            throw new Error("model picker option is missing provider identity");
        }
        return { kind, provider: option.provider, model: option.model };
    }
    const value = option.value;
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
        ? "Select model"
        : kind === "reasoning"
            ? "Reasoning"
            : kind === "permissions"
                ? "Permissions"
                : kind === "session"
                    ? "Resume"
                    : "Theme";
}

function unchanged(
    state: TuiSettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition {
    return { state, handled };
}
