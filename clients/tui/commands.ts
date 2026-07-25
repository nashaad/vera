import { fg, StyledText, type TextChunk } from "@opentui/core";

import type {
    ExtensionCommandDescriptor,
    ExtensionCommandResult,
} from "../../src/extensions/commands.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT } from "./state.ts";

export interface TuiCommandCatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
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
    readonly reasoningEffort: "off" | "low" | "medium" | "high" | "max";
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

export interface TuiCommandErrorAction {
    readonly type: "command_error";
    readonly message: string;
}

export interface RunExtensionTuiCommandAction {
    readonly type: "run_extension";
    readonly command: string;
    readonly argumentsText: string;
    readonly source: string;
    readonly origin: "direct" | "host";
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
    | CreateSessionTuiCommandAction
    | UpdateSessionNameTuiCommandAction
    | CloneSessionTuiCommandAction
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
        | CreateSessionTuiCommandAction
        | CloneSessionTuiCommandAction;
    readonly palette?: TuiPaletteActionDefinition;
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

const REASONING_COMMAND = {
    name: "reasoning",
    description: "Change reasoning effort for the next turn",
    usage: "/reasoning <off|low|medium|high|max>",
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

export const BUILTIN_COMMANDS = [
    REWIND_COMMAND,
    FORK_COMMAND,
    MODEL_COMMAND,
    REASONING_COMMAND,
    PERMISSIONS_COMMAND,
    SETTINGS_COMMAND,
    THEMES_COMMAND,
    RESUME_COMMAND,
    CLEAR_COMMAND,
    RENAME_COMMAND,
    CLONE_COMMAND,
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
    commands: readonly ExtensionCommandDescriptor[],
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
            parse: run,
            // An extension describes itself in one line and has no verb label of
            // its own, so the description carries the row and the slash name
            // stays visible in the right-hand column.
            palette: {
                name: `extension:${command.source}:${command.name}`,
                label: command.description,
                description: "",
                group: "Extensions",
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
): StyledText {
    const chunks: TextChunk[] = [];
    const commandWidth = Math.max(
        0,
        ...commands.map((command) => command.name.length),
    );
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
        chunks.push(fg(TUI_MUTED)(`  ${command.description}`));
    });
    return new StyledText(chunks);
}

export function tuiCommandSuggestionsText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

export function createBuiltinTuiCommandRegistry(): TuiCommandRegistry {
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
        ...REASONING_COMMAND,
        parse: (argumentsText) => isReasoningEffort(argumentsText)
            ? { type: "update_reasoning", reasoningEffort: argumentsText }
            : argumentsText.length === 0
                ? { type: "open_reasoning_picker" }
                : { type: "command_error", message: `Usage: ${REASONING_COMMAND.usage}` },
        palette: {
            name: "reasoning",
            label: "Change reasoning effort",
            description: "how much the model thinks before answering",
            group: "Settings",
            slashName: "reasoning",
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

function isReasoningEffort(value: string): value is UpdateReasoningTuiCommandAction["reasoningEffort"] {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}

function isApprovalMode(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}
