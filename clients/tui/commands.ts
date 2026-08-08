import { fg, StyledText, type TextChunk } from "@opentui/core";

import type {
    ClientExtensionCommandDescriptor,
} from "../../src/extensions/client-registry.ts";
import type {
    ExtensionCommandDescriptor,
    ExtensionCommandResult,
} from "../../src/extensions/commands.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT } from "./state.ts";
import { tuiKeyHint } from "./keymap.ts";

/** What a command's first argument names, so the composer can complete it. */
export type TuiCommandArgumentKind = "model" | "mention";

export interface TuiCommandCatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly arguments?: TuiCommandArgumentKind;
}

export interface OpenRewindTuiCommandAction {
    readonly type: "open_rewind";
}

export interface OpenForkTuiCommandAction {
    readonly type: "open_fork";
}

export interface UpdateModelTuiCommandAction {
    readonly type: "update_model";
    readonly model: string;
}

export interface UpdateReasoningTuiCommandAction {
    readonly type: "update_reasoning";
    readonly reasoningEffort: string;
}

export interface UpdatePermissionsTuiCommandAction {
    readonly type: "update_permissions";
    readonly mode: string;
}

export interface OpenModelPickerTuiCommandAction {
    readonly type: "open_model_picker";
}

export interface OpenReasoningPickerTuiCommandAction {
    readonly type: "open_reasoning_picker";
}

export interface OpenPermissionsPickerTuiCommandAction {
    readonly type: "open_permissions_picker";
}

export interface OpenPreferencesListTuiCommandAction {
    readonly type: "open_preferences_list";
}

export interface OpenSettingsMenuTuiCommandAction {
    readonly type: "open_settings_menu";
}

export interface OpenCommandPaletteTuiCommandAction {
    readonly type: "open_command_palette";
}

/**
 * Put text in the composer and leave the cursor there. The palette needs this
 * for actions that cannot complete without typing (renaming a conversation has
 * no picker to open), so the row starts the command instead of running a
 * half-finished one.
 */
export interface PrefillComposerTuiCommandAction {
    readonly type: "prefill_composer";
    readonly text: string;
}

export interface OpenThemePickerTuiCommandAction {
    readonly type: "open_theme_picker";
}

export interface OpenResumePickerTuiCommandAction {
    readonly type: "open_resume_picker";
}

export interface OpenSubagentsPickerTuiCommandAction {
    readonly type: "open_subagents_picker";
}

export interface GoToParentTuiCommandAction {
    readonly type: "go_to_parent";
}

export interface ReconnectTuiCommandAction {
    readonly type: "reconnect";
}

export interface CreateSessionTuiCommandAction {
    readonly type: "create_session";
}

export interface UpdateSessionNameTuiCommandAction {
    readonly type: "update_session_name";
    readonly name: string | null;
}

export interface CloneSessionTuiCommandAction {
    readonly type: "clone_session";
}

export interface CompactSessionTuiCommandAction {
    readonly type: "compact_session";
}

export interface ShowDiagnosticsTuiCommandAction {
    readonly type: "show_diagnostics";
}

export interface ShowPoolTuiCommandAction {
    readonly type: "show_pool";
}

/** `/pool add`: pools the running model, the same write ^s makes. */
export interface AddCurrentModelToPoolTuiCommandAction {
    readonly type: "pool_current_model";
}

export interface TuiCommandErrorAction {
    readonly type: "command_error";
    readonly message: string;
}

export interface RunExtensionTuiCommandAction {
    readonly type: "run_extension";
    readonly command: string;
    readonly argumentsText: string;
    readonly source: string;
    readonly origin: "direct" | "client" | "host";
}

export type TuiCommandAction =
    | OpenRewindTuiCommandAction
    | OpenForkTuiCommandAction
    | UpdateModelTuiCommandAction
    | UpdateReasoningTuiCommandAction
    | UpdatePermissionsTuiCommandAction
    | OpenModelPickerTuiCommandAction
    | OpenReasoningPickerTuiCommandAction
    | OpenPermissionsPickerTuiCommandAction
    | OpenPreferencesListTuiCommandAction
    | OpenSettingsMenuTuiCommandAction
    | OpenCommandPaletteTuiCommandAction
    | PrefillComposerTuiCommandAction
    | OpenThemePickerTuiCommandAction
    | OpenResumePickerTuiCommandAction
    | OpenSubagentsPickerTuiCommandAction
    | GoToParentTuiCommandAction
    | ReconnectTuiCommandAction
    | CreateSessionTuiCommandAction
    | UpdateSessionNameTuiCommandAction
    | CloneSessionTuiCommandAction
    | CompactSessionTuiCommandAction
    | ShowDiagnosticsTuiCommandAction
    | ShowPoolTuiCommandAction
    | AddCurrentModelToPoolTuiCommandAction
    | RunExtensionTuiCommandAction
    | TuiCommandErrorAction;

/**
 * Palette rows are grouped under these headings, in this order. Ordering lives
 * with the group names because the palette's whole job is scanability: a stable
 * heading order matters more than registration order.
 */
export const TUI_PALETTE_GROUPS = [
    "Session",
    "Settings",
    "Extensions",
] as const;

export type TuiPaletteGroup = (typeof TUI_PALETTE_GROUPS)[number];

export interface TuiPaletteActionDefinition {
    /** Stable identity, never shown. */
    readonly name: string;
    /** The verb phrase the row shows: "Switch model", not "/model". */
    readonly label: string;
    readonly description: string;
    readonly group: TuiPaletteGroup;
    /** Keybinding shown in the row's right column, when the action has one. */
    readonly keyHint?: string;
    readonly slashName?: string;
    readonly action: TuiCommandAction;
}

export type TuiPaletteEntry = TuiPaletteActionDefinition;

export interface TuiCommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly prefixPriority?: "builtin" | "extension";
    readonly action?: OpenRewindTuiCommandAction
        | OpenForkTuiCommandAction
        | OpenPreferencesListTuiCommandAction
        | OpenSettingsMenuTuiCommandAction
        | OpenCommandPaletteTuiCommandAction
        | OpenThemePickerTuiCommandAction
        | OpenResumePickerTuiCommandAction
        | OpenSubagentsPickerTuiCommandAction
        | GoToParentTuiCommandAction
        | ReconnectTuiCommandAction
        | CreateSessionTuiCommandAction
        | CloneSessionTuiCommandAction
        | CompactSessionTuiCommandAction
        | ShowDiagnosticsTuiCommandAction;
    readonly palette?: TuiPaletteActionDefinition;
    readonly arguments?: TuiCommandArgumentKind;
    readonly parse?: (argumentsText: string) => TuiCommandAction;
}

const REWIND_COMMAND = {
    name: "rewind",
    description: "Rewind the active conversation",
    usage: "/rewind",
} as const satisfies TuiCommandCatalogEntry;

const FORK_COMMAND = {
    name: "fork",
    description: "Fork from an earlier prompt",
    usage: "/fork",
} as const satisfies TuiCommandCatalogEntry;

const MODEL_COMMAND = {
    name: "model",
    description: "Change the model for the next turn",
    usage: "/model <model-id>",
} as const satisfies TuiCommandCatalogEntry;

const EFFORT_COMMAND = {
    name: "effort",
    description: "Change reasoning effort for the next turn",
    usage: "/effort <off|low|medium|high|max>",
} as const satisfies TuiCommandCatalogEntry;

const PERMISSIONS_COMMAND = {
    name: "permissions",
    description: "Change the session permission mode",
    usage: "/permissions <ask|auto|full_access>",
} as const satisfies TuiCommandCatalogEntry;

const SETTINGS_COMMAND = {
    name: "settings",
    description: "Model, reasoning, permissions, and theme",
    usage: "/settings",
} as const satisfies TuiCommandCatalogEntry;

const PALETTE_COMMAND = {
    name: "palette",
    description: "Search every action by name or description",
    usage: "/palette",
} as const satisfies TuiCommandCatalogEntry;

const THEMES_COMMAND = {
    name: "themes",
    description: "Change the TUI theme",
    usage: "/themes",
} as const satisfies TuiCommandCatalogEntry;

const RESUME_COMMAND = {
    name: "resume",
    description: "Switch to another conversation",
    usage: "/resume",
} as const satisfies TuiCommandCatalogEntry;

const SUBAGENTS_COMMAND = {
    name: "subagents",
    description: "List this conversation's subagents",
    usage: "/subagents",
} as const satisfies TuiCommandCatalogEntry;

const PARENT_COMMAND = {
    name: "parent",
    description: "Switch to the parent conversation",
    usage: "/parent",
} as const satisfies TuiCommandCatalogEntry;

const RECONNECT_COMMAND = {
    name: "reconnect",
    description: "Restart the host and reconnect this conversation",
    usage: "/reconnect",
} as const satisfies TuiCommandCatalogEntry;

const CLEAR_COMMAND = {
    name: "clear",
    description: "Start a new conversation",
    usage: "/clear",
} as const satisfies TuiCommandCatalogEntry;

const RENAME_COMMAND = {
    name: "rename",
    description: "Name or unname this conversation",
    usage: "/rename [name]",
} as const satisfies TuiCommandCatalogEntry;

const CLONE_COMMAND = {
    name: "clone",
    description: "Duplicate this conversation",
    usage: "/clone",
} as const satisfies TuiCommandCatalogEntry;

const COMPACT_COMMAND = {
    name: "compact",
    description: "Summarize earlier messages to free context",
    usage: "/compact",
} as const satisfies TuiCommandCatalogEntry;

const POOL_COMMAND = {
    name: "pool",
    description: "Show the model pool, or add the running model to it",
    usage: "/pool [add]",
} as const satisfies TuiCommandCatalogEntry;

const DIAGNOSTICS_COMMAND = {
    name: "diagnostics",
    description: "Show live turn and model activity",
    usage: "/diagnostics",
} as const satisfies TuiCommandCatalogEntry;

export const BUILTIN_COMMANDS = [
    REWIND_COMMAND,
    FORK_COMMAND,
    MODEL_COMMAND,
    EFFORT_COMMAND,
    PERMISSIONS_COMMAND,
    SETTINGS_COMMAND,
    THEMES_COMMAND,
    RESUME_COMMAND,
    SUBAGENTS_COMMAND,
    PARENT_COMMAND,
    RECONNECT_COMMAND,
    CLEAR_COMMAND,
    RENAME_COMMAND,
    CLONE_COMMAND,
    COMPACT_COMMAND,
    DIAGNOSTICS_COMMAND,
    POOL_COMMAND,
    PALETTE_COMMAND,
] as const satisfies readonly TuiCommandCatalogEntry[];

export class TuiCommandRegistry {
    private readonly commands = new Map<string, TuiCommandDefinition>();
    private readonly paletteActions = new Map<string, TuiPaletteActionDefinition>();

    registerCommand(command: TuiCommandDefinition): void {
        if (this.commands.has(command.name)) {
            throw new Error(`Duplicate TUI command: /${command.name}`);
        }
        this.commands.set(command.name, command);
        if (command.palette !== undefined) {
            this.registerPaletteAction(command.palette);
        }
    }

    registerPaletteAction(action: TuiPaletteActionDefinition): void {
        if (this.paletteActions.has(action.name)) {
            throw new Error(`Duplicate TUI palette action: ${action.name}`);
        }
        this.paletteActions.set(action.name, action);
    }

    registeredCommands(): readonly TuiCommandCatalogEntry[] {
        return [...this.commands.values()].map((command) => ({
            name: command.name,
            description: command.description,
            usage: command.usage,
            ...(command.arguments === undefined
                ? {}
                : { arguments: command.arguments }),
        }));
    }

    registeredPaletteActions(): readonly TuiPaletteActionDefinition[] {
        return [...this.paletteActions.values()];
    }

    suggestions(input: string): readonly TuiCommandCatalogEntry[] {
        const text = input.trimStart();
        if (!text.startsWith("/") || /\s/.test(text)) {
            return [];
        }
        const prefix = text.slice(1);
        return this.registeredCommands().filter((command) =>
            command.name.startsWith(prefix)
        );
    }

    /**
     * The half-typed first argument of a command that declares one, or
     * undefined anywhere else. Only the first argument completes: `/add gpt as
     * m1` is past it by the second word.
     */
    argumentPrefix(
        input: string,
    ): { kind: TuiCommandArgumentKind; prefix: string } | undefined {
        const match = /^\s*\/([a-z][a-z0-9-]*)\s+(\S*)$/.exec(input);
        if (match === null) {
            return undefined;
        }
        const kind = this.commands.get(match[1] ?? "")?.arguments;
        return kind === undefined ? undefined : { kind, prefix: match[2] ?? "" };
    }

    completion(input: string): string | undefined {
        const text = input.trimStart();
        const suggestions = this.suggestions(input);
        if (suggestions.length === 0) {
            return undefined;
        }

        const prefix = text.slice(1);
        const completedName = sharedPrefix(
            suggestions.map((command) => command.name),
        );
        if (completedName === prefix) {
            return undefined;
        }

        const leadingWhitespace = input.slice(0, input.length - text.length);
        return `${leadingWhitespace}/${completedName}`;
    }

    dispatch(input: string): TuiCommandAction | undefined {
        const text = input.trim();
        if (!text.startsWith("/")) {
            return undefined;
        }

        const separatorIndex = text.search(/\s/);
        const commandEnd = separatorIndex === -1 ? text.length : separatorIndex;
        const name = text.slice(1, commandEnd);
        const exactCommand = this.commands.get(name);
        let command = exactCommand;
        if (command === undefined) {
            const matches = [...this.commands.values()].filter((candidate) =>
                candidate.name.startsWith(name)
            );
            const builtinMatches = matches.filter(
                (candidate) => candidate.prefixPriority !== "extension",
            );
            const eligibleMatches = builtinMatches.length > 0
                ? builtinMatches
                : matches;
            if (eligibleMatches.length !== 1) {
                return undefined;
            }
            const [uniqueMatch] = eligibleMatches;
            if (uniqueMatch === undefined) {
                return undefined;
            }
            command = uniqueMatch;
        }

        const argumentsText = text.slice(commandEnd).trim();
        if (command.parse !== undefined) {
            return command.parse(argumentsText);
        }
        if (argumentsText.length > 0 || command.action === undefined) {
            return {
                type: "command_error",
                message: `Usage: ${command.usage}`,
            };
        }
        return command.action;
    }
}

export function registerExtensionTuiCommands(
    registry: TuiCommandRegistry,
    commands: readonly (
        ExtensionCommandDescriptor | ClientExtensionCommandDescriptor
    )[],
    origin: RunExtensionTuiCommandAction["origin"] = "host",
): void {
    const names = new Set(
        registry.registeredCommands().map((command) => command.name),
    );
    for (const command of commands) {
        if (names.has(command.name)) {
            throw new Error(`Duplicate TUI command: /${command.name}`);
        }
        names.add(command.name);
    }
    for (const command of commands) {
        const palette = "palette" in command ? command.palette : undefined;
        const run = (argumentsText: string): TuiCommandAction => ({
            type: "run_extension",
            command: command.name,
            argumentsText,
            source: command.source,
            origin,
        });
        registry.registerCommand({
            name: command.name,
            description: command.description,
            usage: command.usage,
            prefixPriority: "extension",
            ...(command.arguments === undefined
                ? {}
                : { arguments: command.arguments }),
            parse: run,
            palette: {
                name: `extension:${command.source}:${command.name}`,
                label: palette?.label ?? command.description,
                description: palette?.description ?? "",
                group: palette?.group ?? "Extensions",
                ...(palette?.keyHint === undefined
                    ? {}
                    : { keyHint: palette.keyHint }),
                slashName: command.name,
                action: run(""),
            },
        });
    }
}

export function extensionCommandResultText(
    result: ExtensionCommandResult,
): string {
    if (result.body.kind === "text") {
        return `${result.source}: ${result.body.text}`;
    }
    return `${result.source} [${result.body.level}]: ${result.body.text}`;
}

function sharedPrefix(values: readonly string[]): string {
    let prefix = values[0] ?? "";
    for (const value of values.slice(1)) {
        while (!value.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }
    return prefix;
}

export function renderTuiCommandSuggestions(
    commands: readonly TuiCommandCatalogEntry[],
    selectedIndex = -1,
    maxWidth?: number,
): StyledText {
    const chunks: TextChunk[] = [];
    const commandWidth = Math.max(
        0,
        ...commands.map((command) => command.name.length),
    );
    // Each row stays one row: a description that would wrap is cut with an
    // ellipsis instead, because a wrapped row breaks the one-line-per-command
    // height the box is sized by.
    const descriptionWidth = maxWidth === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(1, maxWidth - (2 + 1 + commandWidth + 2));
    commands.forEach((command, index) => {
        const active = index === selectedIndex;
        if (index > 0) {
            chunks.push(fg(TUI_MUTED)("\n"));
        }
        // Quiet selection: a chevron marker plus an accent command name, the
        // lightest device that marks the row without a loud full-width bar.
        chunks.push(active ? fg(TUI_ACCENT)("› ") : fg(TUI_MUTED)("  "));
        chunks.push(fg(active ? TUI_ACCENT : TUI_TEXT)(
            `/${command.name.padEnd(commandWidth)}`,
        ));
        const description = command.description.length > descriptionWidth
            ? `${command.description.slice(0, Math.max(0, descriptionWidth - 1))}\u2026`
            : command.description;
        chunks.push(fg(TUI_MUTED)(`  ${description}`));
    });
    return new StyledText(chunks);
}

/** The values that could finish a half-typed argument, best match first. */
export function tuiArgumentSuggestions(
    values: readonly string[],
    prefix: string,
): readonly string[] {
    const lower = prefix.toLowerCase();
    if (lower.length === 0) {
        return values;
    }
    const starts = values.filter((value) =>
        value.toLowerCase().startsWith(lower)
    );
    const contains = values.filter((value) =>
        !value.toLowerCase().startsWith(lower)
        && value.toLowerCase().includes(lower)
    );
    return [...starts, ...contains];
}

/** What Tab should type, or undefined when there is nothing left to add. */
export function tuiArgumentCompletion(
    values: readonly string[],
    prefix: string,
): string | undefined {
    const suggestions = tuiArgumentSuggestions(values, prefix).filter((value) =>
        value.toLowerCase().startsWith(prefix.toLowerCase())
    );
    if (suggestions.length === 0) {
        return undefined;
    }
    const completed = sharedPrefix(suggestions);
    if (completed.length > prefix.length) {
        return completed;
    }
    // Nothing left to type and the name is whole: Tab moves past it instead
    // of doing nothing, so `as <alias>` can be typed straight after.
    return suggestions.some((value) =>
            value.toLowerCase() === prefix.toLowerCase()
        )
        ? `${prefix} `
        : undefined;
}

/** Swaps the half-typed trailing argument for the chosen one. */
export function tuiWithArgument(input: string, value: string): string {
    return input.replace(/\S*$/, value);
}

export function renderTuiArgumentSuggestions(
    values: readonly string[],
    selectedIndex = -1,
): StyledText {
    const chunks: TextChunk[] = [];
    values.forEach((value, index) => {
        const active = index === selectedIndex;
        if (index > 0) {
            chunks.push(fg(TUI_MUTED)("\n"));
        }
        chunks.push(active ? fg(TUI_ACCENT)("› ") : fg(TUI_MUTED)("  "));
        chunks.push(fg(active ? TUI_ACCENT : TUI_TEXT)(value));
    });
    return new StyledText(chunks);
}

export function tuiCommandSuggestionsText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

export function createBuiltinTuiCommandRegistry(): TuiCommandRegistry {
    return createConfiguredBuiltinTuiCommandRegistry([]);
}

export function createConfiguredBuiltinTuiCommandRegistry(
    _disabledExtensionIds: readonly string[],
): TuiCommandRegistry {
    const registry = new TuiCommandRegistry();
    registry.registerCommand({
        ...REWIND_COMMAND,
        action: { type: "open_rewind" },
        palette: {
            name: "rewind",
            label: "Rewind conversation",
            description: "undo back to an earlier prompt",
            group: "Session",
            slashName: "rewind",
            action: { type: "open_rewind" },
        },
    });
    registry.registerCommand({
        ...FORK_COMMAND,
        action: { type: "open_fork" },
        palette: {
            name: "fork",
            label: "Fork conversation",
            description: "branch from an earlier prompt",
            group: "Session",
            slashName: "fork",
            action: { type: "open_fork" },
        },
    });
    registry.registerCommand({
        ...MODEL_COMMAND,
        parse: (argumentsText) => argumentsText.length === 0
            ? { type: "open_model_picker" }
            : { type: "update_model", model: argumentsText },
        palette: {
            name: "model",
            label: "Switch model",
            description: "change the model for the next turn",
            group: "Settings",
            slashName: "model",
            action: { type: "open_model_picker" },
        },
    });
    registry.registerCommand({
        ...EFFORT_COMMAND,
        parse: (argumentsText) => isReasoningEffort(argumentsText)
            ? { type: "update_reasoning", reasoningEffort: argumentsText }
            : argumentsText.length === 0
                ? { type: "open_reasoning_picker" }
                : { type: "command_error", message: `Usage: ${EFFORT_COMMAND.usage}` },
        palette: {
            name: "effort",
            label: "Change reasoning effort",
            description: "how much the model thinks before answering",
            group: "Settings",
            // The binding belongs to the reasoning-cycle extension, not to
            // this command. It is advertised here because a keybinding with no
            // command of its own has nowhere else to appear, and a binding
            // nobody can find is a binding nobody has.
            keyHint: tuiKeyHint("cycle-reasoning"),
            slashName: "effort",
            action: { type: "open_reasoning_picker" },
        },
    });
    registry.registerCommand({
        ...PERMISSIONS_COMMAND,
        parse: (argumentsText) => isApprovalMode(argumentsText)
            ? { type: "update_permissions", mode: argumentsText }
            : argumentsText.length === 0
                ? { type: "open_permissions_picker" }
                : { type: "command_error", message: `Usage: ${PERMISSIONS_COMMAND.usage}` },
        palette: {
            name: "permission_mode",
            label: "Change permission mode",
            description: "how much Vera asks before running commands",
            group: "Settings",
            slashName: "permissions",
            action: { type: "open_permissions_picker" },
        },
    });
    registry.registerCommand({
        ...SETTINGS_COMMAND,
        action: { type: "open_settings_menu" },
        palette: {
            name: "settings",
            label: "Open settings",
            description: "model, reasoning, permissions, and theme",
            group: "Settings",
            slashName: "settings",
            action: { type: "open_settings_menu" },
        },
    });
    registry.registerCommand({
        ...THEMES_COMMAND,
        action: { type: "open_theme_picker" },
        palette: {
            name: "theme",
            label: "Change theme",
            description: "recolor the TUI",
            group: "Settings",
            slashName: "themes",
            action: { type: "open_theme_picker" },
        },
    });
    registry.registerCommand({
        ...RESUME_COMMAND,
        action: { type: "open_resume_picker" },
        palette: {
            name: "resume",
            label: "Switch conversation",
            description: "reopen another conversation",
            group: "Session",
            slashName: "resume",
            action: { type: "open_resume_picker" },
        },
    });
    registry.registerCommand({
        ...SUBAGENTS_COMMAND,
        action: { type: "open_subagents_picker" },
        palette: {
            name: "subagents",
            label: "List subagents",
            description: "see and open this conversation's subagents",
            group: "Session",
            slashName: "subagents",
            action: { type: "open_subagents_picker" },
        },
    });
    registry.registerCommand({
        ...PARENT_COMMAND,
        action: { type: "go_to_parent" },
        palette: {
            name: "parent",
            label: "Go to parent conversation",
            description: "jump back to the conversation that spawned this one",
            group: "Session",
            slashName: "parent",
            action: { type: "go_to_parent" },
        },
    });
    registry.registerCommand({
        ...RECONNECT_COMMAND,
        action: { type: "reconnect" },
        palette: {
            name: "reconnect",
            label: "Reconnect host",
            description: "restart the host after a connection failure",
            group: "Session",
            slashName: "reconnect",
            action: { type: "reconnect" },
        },
    });
    registry.registerCommand({
        ...CLEAR_COMMAND,
        action: { type: "create_session" },
        palette: {
            name: "clear",
            label: "New conversation",
            description: "start fresh with no history",
            group: "Session",
            slashName: "clear",
            action: { type: "create_session" },
        },
    });
    registry.registerCommand({
        ...RENAME_COMMAND,
        parse: (argumentsText) => ({
            type: "update_session_name",
            name: argumentsText.length === 0 ? null : argumentsText,
        }),
        palette: {
            name: "rename",
            label: "Rename conversation",
            description: "give this conversation a name",
            group: "Session",
            slashName: "rename",
            // A bare /rename clears the name, so the palette row starts the
            // command in the composer rather than running it.
            action: { type: "prefill_composer", text: "/rename " },
        },
    });
    registry.registerCommand({
        ...CLONE_COMMAND,
        action: { type: "clone_session" },
        palette: {
            name: "clone",
            label: "Duplicate conversation",
            description: "copy this conversation into a new one",
            group: "Session",
            slashName: "clone",
            action: { type: "clone_session" },
        },
    });
    registry.registerCommand({
        ...COMPACT_COMMAND,
        action: { type: "compact_session" },
        palette: {
            name: "compact",
            label: "Summarize earlier messages",
            description: "free context without losing the transcript",
            group: "Session",
            slashName: "compact",
            action: { type: "compact_session" },
        },
    });
    registry.registerCommand({
        ...DIAGNOSTICS_COMMAND,
        action: { type: "show_diagnostics" },
        palette: {
            name: "diagnostics",
            label: "Show diagnostics",
            description: "inspect the current turn and model request",
            group: "Session",
            slashName: "diagnostics",
            action: { type: "show_diagnostics" },
        },
    });
    registry.registerCommand({
        ...POOL_COMMAND,
        parse: (argumentsText) => {
            const argument = argumentsText.trim();
            if (argument.length === 0) {
                return { type: "show_pool" };
            }
            if (argument === "add") {
                return { type: "pool_current_model" };
            }
            return {
                type: "command_error",
                message: `/pool takes no argument or "add", not "${argument}"`,
            };
        },
        palette: {
            name: "pool",
            label: "Show the model pool",
            description: "the shortlist you curated",
            group: "Settings",
            slashName: "pool",
            action: { type: "show_pool" },
        },
    });
    // The palette does not list itself: you are already looking at it.
    registry.registerCommand({
        ...PALETTE_COMMAND,
        action: { type: "open_command_palette" },
    });
    registry.registerPaletteAction({
        name: "granted_permissions",
        label: "Review granted permissions",
        description: "see and revoke what you have approved",
        group: "Settings",
        action: { type: "open_preferences_list" },
    });
    return registry;
}

function isReasoningEffort(value: string): boolean {
    return value.length > 0;
}

function isApprovalMode(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}
