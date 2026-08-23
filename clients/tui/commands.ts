import { fg, StyledText, type TextChunk } from "@opentui/core";

import type {
    ClientExtensionCommandDescriptor,
} from "../../src/extensions/client-registry.ts";
import type {
    ExtensionCommandDescriptor,
    ExtensionCommandResult,
} from "../../src/extensions/commands.ts";
import {
    parseExtensionManagerCommand,
    tokenizeExtensionManagerArguments,
    type ExtensionManagerCommand,
} from "../../src/extensions/manager-command.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT } from "./state.ts";
import { tuiKeyHint } from "./keymap.ts";

/** What a command's first argument names, so the composer can complete it. */
export type TuiCommandArgumentKind = "model" | "mention";

/**
 * Where a slash command came from, which is the only grouping the list needs:
 * nothing is filed by hand, nothing goes stale, and it answers the question
 * that actually gets asked, which is whether the thing just installed showed
 * up.
 */
export const TUI_SLASH_GROUPS = ["built in", "extensions", "skills"] as const;

export type TuiSlashGroup = (typeof TUI_SLASH_GROUPS)[number];

export interface TuiCommandCatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    /** Absent on the definitions themselves; the registry fills it in. */
    readonly group?: TuiSlashGroup;
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
    /**
     * Whether the host default moves too.
     *
     * The normal TUI action changes the persistent host default. The explicit
     * field remains for callers that need to name that scope in a typed action.
     */
    readonly scope?: "global";
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

/**
 * Open the agent surface, or wear one by name.
 *
 * Both go through the same wear path: the picker is a readout of what is live
 * as much as it is a way to change it, and `/agent <name>` is the shortcut for
 * people who already know which one they want.
 */
export interface OpenAgentPickerTuiCommandAction {
    readonly type: "open_agent_picker";
}

export interface WearAgentTuiCommandAction {
    readonly type: "wear_agent";
    readonly name: string;
}

export interface OpenPreferencesListTuiCommandAction {
    readonly type: "open_preferences_list";
}

export interface OpenSettingsMenuTuiCommandAction {
    readonly type: "open_settings_menu";
}

export interface OpenConfigureTuiCommandAction {
    readonly type: "open_configure";
}

export interface OpenCommandPaletteTuiCommandAction {
    readonly type: "open_command_palette";
}

export interface OpenHelpTuiCommandAction {
    readonly type: "open_help";
    readonly tab?: "general" | "keys";
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

export interface OpenWorkTabTuiCommandAction {
    readonly type: "open_work_tab";
}

export interface OpenSearchTuiCommandAction {
    readonly type: "open_search";
}

export interface OpenSubagentsPickerTuiCommandAction {
    readonly type: "open_subagents_picker";
}

export interface GoToParentTuiCommandAction {
    readonly type: "go_to_parent";
}

export interface GoBackTuiCommandAction {
    readonly type: "go_back";
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

export interface ShowExtensionsTuiCommandAction {
    readonly type: "show_extensions";
    readonly scope?: "profile" | "project";
}

export interface ManageExtensionsTuiCommandAction {
    readonly type: "manage_extensions";
    readonly command: Exclude<ExtensionManagerCommand, { readonly operation: "list" }>;
}

export interface ShowDoctorTuiCommandAction {
    readonly type: "show_doctor";
}

export interface WriteFailureReportTuiCommandAction {
    readonly type: "write_failure_report";
}

export interface ReloadClientExtensionsTuiCommandAction {
    readonly type: "reload_client_extensions";
}

export interface ShowPoolTuiCommandAction {
    readonly type: "show_pool";
}

export interface ShowDefaultsTuiCommandAction {
    readonly type: "show_defaults";
}

export interface OpenProvidersTuiCommandAction {
    readonly type: "open_providers";
}

/** `/shortlist add`: pins the running model, the same write ^s makes. */
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
    | OpenAgentPickerTuiCommandAction
    | WearAgentTuiCommandAction
    | OpenPreferencesListTuiCommandAction
    | OpenSettingsMenuTuiCommandAction
    | OpenConfigureTuiCommandAction
    | OpenCommandPaletteTuiCommandAction
    | OpenHelpTuiCommandAction
    | PrefillComposerTuiCommandAction
    | OpenThemePickerTuiCommandAction
    | OpenResumePickerTuiCommandAction
    | OpenWorkTabTuiCommandAction
    | OpenSearchTuiCommandAction
    | OpenSubagentsPickerTuiCommandAction
    | GoToParentTuiCommandAction
    | GoBackTuiCommandAction
    | ReconnectTuiCommandAction
    | CreateSessionTuiCommandAction
    | UpdateSessionNameTuiCommandAction
    | CloneSessionTuiCommandAction
    | CompactSessionTuiCommandAction
    | ShowDiagnosticsTuiCommandAction
    | ShowExtensionsTuiCommandAction
    | ManageExtensionsTuiCommandAction
    | ShowDoctorTuiCommandAction
    | WriteFailureReportTuiCommandAction
    | ReloadClientExtensionsTuiCommandAction
    | ShowPoolTuiCommandAction
    | ShowDefaultsTuiCommandAction
    | OpenProvidersTuiCommandAction
    | AddCurrentModelToPoolTuiCommandAction
    | RunExtensionTuiCommandAction
    | TuiCommandErrorAction;

export type TuiCommandScope = "focused_agent" | "main_session" | "application";

/**
 * Which owner a slash command is allowed to affect. Keep this exhaustive so a
 * newly added command cannot silently inherit Vera while another agent is focused.
 */
export function tuiCommandScope(action: TuiCommandAction): TuiCommandScope {
    switch (action.type) {
        case "update_model":
        case "update_reasoning":
        case "update_permissions":
        case "open_model_picker":
        case "open_reasoning_picker":
        case "open_permissions_picker":
        case "open_agent_picker":
        case "wear_agent":
        case "open_settings_menu":
        case "open_configure":
        case "open_resume_picker":
        case "open_subagents_picker":
        case "go_to_parent":
        case "go_back":
        case "create_session":
        case "update_session_name":
            return "focused_agent";
        case "open_rewind":
        case "open_fork":
        case "reconnect":
        case "clone_session":
        case "compact_session":
            return "main_session";
        case "open_preferences_list":
        case "open_work_tab":
        case "open_search":
        case "open_command_palette":
        case "open_help":
        case "prefill_composer":
        case "open_theme_picker":
        case "show_diagnostics":
        case "show_extensions":
        case "manage_extensions":
        case "show_doctor":
        case "write_failure_report":
        case "reload_client_extensions":
        case "show_pool":
        case "show_defaults":
        case "open_providers":
        case "pool_current_model":
        case "run_extension":
        case "command_error":
            return "application";
    }
}

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
    readonly isAvailable?: () => boolean;
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
        | OpenConfigureTuiCommandAction
        | OpenCommandPaletteTuiCommandAction
        | OpenHelpTuiCommandAction
        | OpenThemePickerTuiCommandAction
        | OpenResumePickerTuiCommandAction
        | OpenWorkTabTuiCommandAction
        | OpenSearchTuiCommandAction
        | OpenSubagentsPickerTuiCommandAction
        | GoToParentTuiCommandAction
        | GoBackTuiCommandAction
        | ReconnectTuiCommandAction
        | CreateSessionTuiCommandAction
        | CloneSessionTuiCommandAction
        | CompactSessionTuiCommandAction
        | ShowDiagnosticsTuiCommandAction
        | ShowExtensionsTuiCommandAction
        | ShowDoctorTuiCommandAction
        | WriteFailureReportTuiCommandAction
        | ShowDefaultsTuiCommandAction
        | OpenProvidersTuiCommandAction
        | ReloadClientExtensionsTuiCommandAction;
    readonly palette?: TuiPaletteActionDefinition;
    readonly arguments?: TuiCommandArgumentKind;
    readonly isAvailable?: () => boolean;
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
    description: "Change Vera's default permission mode",
    usage: "/permissions <mode>",
} as const satisfies TuiCommandCatalogEntry;

const AGENT_COMMAND = {
    name: "agent",
    description: "Switch agents: instructions, tools, skills and posture",
    usage: "/agent [name]",
} as const satisfies TuiCommandCatalogEntry;

const SETTINGS_COMMAND = {
    name: "settings",
    description: "Model, reasoning, permissions, and theme",
    usage: "/settings",
} as const satisfies TuiCommandCatalogEntry;

const CONFIGURE_COMMAND = {
    name: "configure",
    description: "Open Vera's config file in your editor",
    usage: "/configure",
} as const satisfies TuiCommandCatalogEntry;

const PALETTE_COMMAND = {
    name: "palette",
    description: "Search actions, commands, and keyboard shortcuts",
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

const WORK_COMMAND = {
    name: "work",
    description: "Show every session that needs you or is running",
    usage: "/work",
} as const satisfies TuiCommandCatalogEntry;

const SEARCH_COMMAND = {
    name: "search",
    description: "Search past work",
    usage: "/search",
} as const satisfies TuiCommandCatalogEntry;

const SUBAGENTS_COMMAND = {
    name: "subagents",
    description: "List this conversation's subagents",
    usage: "/subagents",
} as const satisfies TuiCommandCatalogEntry;

const BACK_COMMAND = {
    name: "back",
    description: "Return to the conversation you came from",
    usage: "/back",
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
    name: "shortlist",
    description: "Show your shortlist, or pin the running model to it",
    usage: "/shortlist [add]",
} as const satisfies TuiCommandCatalogEntry;

const PROVIDERS_COMMAND = {
    name: "providers",
    description: "Connect a provider, or add an endpoint of your own",
    usage: "/providers",
} as const satisfies TuiCommandCatalogEntry;

const DEFAULTS_COMMAND = {
    name: "defaults",
    description: "Show which model runs each job",
    usage: "/defaults",
} as const satisfies TuiCommandCatalogEntry;

const DIAGNOSTICS_COMMAND = {
    name: "diagnostics",
    description: "Show live turn and model activity",
    usage: "/diagnostics",
} as const satisfies TuiCommandCatalogEntry;

const EXTENSIONS_COMMAND = {
    name: "extensions",
    description: "Show installed extensions and their state",
    usage: "/extensions",
} as const satisfies TuiCommandCatalogEntry;

const EXTENSION_COMMAND = {
    name: "extension",
    description: "Install, enable, disable, remove, or reload an extension",
    usage: "/extension <op> …",
} as const satisfies TuiCommandCatalogEntry;

const DOCTOR_COMMAND = {
    name: "doctor",
    description: "Check resident hosts and Vera process health",
    usage: "/doctor",
} as const satisfies TuiCommandCatalogEntry;

const FAILURE_REPORT_COMMAND = {
    name: "failure-report",
    description: "Write a shareable report of recorded model failures",
    usage: "/failure-report",
} as const satisfies TuiCommandCatalogEntry;

const RELOAD_EXTENSIONS_COMMAND = {
    name: "reload-extensions",
    description: "Reload client extensions without restarting Vera",
    usage: "/reload-extensions",
} as const satisfies TuiCommandCatalogEntry;

export const BUILTIN_COMMANDS = [
    REWIND_COMMAND,
    FORK_COMMAND,
    MODEL_COMMAND,
    EFFORT_COMMAND,
    PERMISSIONS_COMMAND,
    AGENT_COMMAND,
    SETTINGS_COMMAND,
    CONFIGURE_COMMAND,
    THEMES_COMMAND,
    RESUME_COMMAND,
    WORK_COMMAND,
    SEARCH_COMMAND,
    SUBAGENTS_COMMAND,
    PARENT_COMMAND,
    BACK_COMMAND,
    RECONNECT_COMMAND,
    CLEAR_COMMAND,
    RENAME_COMMAND,
    CLONE_COMMAND,
    COMPACT_COMMAND,
    DIAGNOSTICS_COMMAND,
    EXTENSIONS_COMMAND,
    EXTENSION_COMMAND,
    DOCTOR_COMMAND,
    FAILURE_REPORT_COMMAND,
    RELOAD_EXTENSIONS_COMMAND,
    POOL_COMMAND,
    DEFAULTS_COMMAND,
    PROVIDERS_COMMAND,
    PALETTE_COMMAND,
] as const satisfies readonly TuiCommandCatalogEntry[];

export class TuiCommandRegistry {
    private readonly commands = new Map<string, TuiCommandDefinition>();
    private readonly paletteActions = new Map<string, TuiPaletteActionDefinition>();

    registerCommand(command: TuiCommandDefinition): void {
        if (this.commands.has(command.name)) {
            throw new Error(`Duplicate TUI command: /${command.name}`);
        }
        if (command.palette !== undefined) {
            this.registerPaletteAction(command.palette);
        }
        this.commands.set(command.name, command);
    }

    registerPaletteAction(action: TuiPaletteActionDefinition): void {
        if (this.paletteActions.has(action.name)) {
            throw new Error(`Duplicate TUI palette action: ${action.name}`);
        }
        this.paletteActions.set(action.name, action);
    }

    unregisterCommand(
        name: string,
        expected?: TuiCommandDefinition,
    ): void {
        const command = this.commands.get(name);
        if (command === undefined || (expected !== undefined && command !== expected)) {
            return;
        }
        this.commands.delete(name);
        if (command.palette !== undefined) {
            this.paletteActions.delete(command.palette.name);
        }
    }

    registeredCommands(
        names?: ReadonlySet<string>,
    ): readonly TuiCommandCatalogEntry[] {
        return [...this.commands.values()].filter(
            (command) => (names?.has(command.name) ?? true)
                && (command.isAvailable?.() ?? true),
        ).map((command) => ({
            name: command.name,
            description: command.description,
            usage: command.usage,
            group: command.prefixPriority === "extension"
                ? "extensions" as const
                : "built in" as const,
            ...(command.arguments === undefined
                ? {}
                : { arguments: command.arguments }),
        }));
    }

    hasCommand(name: string): boolean {
        return this.commands.has(name);
    }

    commandNames(): readonly string[] {
        return [...this.commands.keys()];
    }

    registeredPaletteActions(): readonly TuiPaletteActionDefinition[] {
        return [...this.paletteActions.values()].filter(
            (action) => action.isAvailable?.() ?? true,
        );
    }

    suggestions(input: string): readonly TuiCommandCatalogEntry[] {
        const text = input.trimStart();
        if (!text.startsWith("/") || /\s/.test(text)) {
            return [];
        }
        const prefix = text.slice(1);
        const matching = this.registeredCommands().filter((command) =>
            command.name.startsWith(prefix)
        );
        // Registration order is an implementation detail. Within a group the
        // commands keep it, since that is the order they are defined in.
        return TUI_SLASH_GROUPS.flatMap((group) =>
            matching.filter((command) => slashGroup(command) === group)
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
        if (
            exactCommand !== undefined
            && !(exactCommand.isAvailable?.() ?? true)
        ) {
            return {
                type: "command_error",
                message: `/${name} is unavailable`,
            };
        }
        let command = exactCommand;
        if (command === undefined) {
            const matches = [...this.commands.values()].filter((candidate) =>
                candidate.name.startsWith(name)
                && (candidate.isAvailable?.() ?? true)
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
): () => void {
    const names = new Set<string>();
    for (const command of commands) {
        if (registry.hasCommand(command.name) || names.has(command.name)) {
            throw new Error(`Duplicate TUI command: /${command.name}`);
        }
        names.add(command.name);
    }
    const definitions = commands.map((command): TuiCommandDefinition => {
        const palette = "palette" in command ? command.palette : undefined;
        const isAvailable = "isAvailable" in command
            ? command.isAvailable
            : undefined;
        const run = (argumentsText: string): TuiCommandAction => ({
            type: "run_extension",
            command: command.name,
            argumentsText,
            source: command.source,
            origin,
        });
        return {
            name: command.name,
            description: command.description,
            usage: command.usage,
            prefixPriority: "extension",
            ...(command.arguments === undefined
                ? {}
                : { arguments: command.arguments }),
            ...(isAvailable === undefined
                ? {}
                : { isAvailable }),
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
                ...(isAvailable === undefined
                    ? {}
                    : { isAvailable }),
            },
        };
    });
    const registered: TuiCommandDefinition[] = [];
    try {
        for (const definition of definitions) {
            registry.registerCommand(definition);
            registered.push(definition);
        }
    } catch (error) {
        for (const definition of registered) {
            registry.unregisterCommand(definition.name, definition);
        }
        throw error;
    }
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        for (const definition of definitions) {
            registry.unregisterCommand(definition.name, definition);
        }
    };
}

export function extensionCommandResultText(
    result: ExtensionCommandResult,
): string {
    if (result.body.kind === "text") {
        return `${result.source}: ${result.body.text}`;
    }
    if (result.body.kind === "handled") {
        return result.source;
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

/**
 * The slice of a long suggestion list that is on screen.
 *
 * The box used to grow to the length of the list, so on a short terminal the
 * bottom commands were drawn off the top of the pane and could not be reached
 * at all. It scrolls instead, and gives up one row to say how many are still
 * below, because a list that silently ends reads as the whole catalog.
 */
export function tuiSuggestionWindow(
    count: number,
    selectedIndex: number,
    maxRows: number,
): { start: number; rows: number; hidden: number } {
    const room = Math.max(1, maxRows);
    if (count <= room) {
        return { start: 0, rows: count, hidden: 0 };
    }
    const rows = Math.max(1, room - 1);
    const selected = Math.max(0, Math.min(selectedIndex, count - 1));
    // Keep the highlighted row on screen, scrolling by as little as possible.
    const start = Math.max(0, Math.min(selected - rows + 1, count - rows));
    return {
        start: selected < start ? selected : start,
        rows,
        hidden: count - rows,
    };
}

/**
 * The width of the group column, wide enough for every group name so each
 * command starts on the same column whichever group it is in.
 */
const SLASH_GROUP_WIDTH = Math.max(
    0,
    ...TUI_SLASH_GROUPS.map((group) => group.length),
) + 2;

/**
 * The blank lines a grouped list spends separating its groups, which the box
 * has to know about because it is sized in lines rather than in commands.
 */
function slashGroup(command: TuiCommandCatalogEntry): TuiSlashGroup {
    return command.group ?? "built in";
}

export function tuiSuggestionGaps(
    commands: readonly TuiCommandCatalogEntry[],
    grouped: boolean,
    compact = false,
): number {
    if (!grouped) return 0;
    const transitions = commands.filter((command, index) =>
        index > 0
        && commands[index - 1] !== undefined
        && slashGroup(commands[index - 1]!) !== slashGroup(command)
    ).length;
    // Compact drops the group name into its own line above the group's rows
    // instead of sharing the first row with a command, which costs one extra
    // line per group (including the first, which owns no gap of its own).
    return compact && commands.length > 0
        ? transitions + (transitions + 1)
        : transitions;
}

/**
 * Below this the group column and a description cannot both fit beside the
 * command names without a row running past the available width. Compact mode
 * drops both rather than let a row overflow.
 */
export const SLASH_COMPACT_WIDTH = 36;

export function renderTuiCommandSuggestions(
    commands: readonly TuiCommandCatalogEntry[],
    selectedIndex = -1,
    maxWidth?: number,
    hidden = 0,
    grouped = false,
    compact = false,
): StyledText {
    const chunks: TextChunk[] = [];
    if (compact) {
        commands.forEach((command, index) => {
            const active = index === selectedIndex;
            const previous = commands[index - 1];
            const opensGroup = grouped
                && (previous === undefined
                    || slashGroup(previous) !== slashGroup(command));
            if (index > 0) {
                chunks.push(fg(TUI_MUTED)(opensGroup ? "\n\n" : "\n"));
            }
            // The group's own line, not shared with a row: a shared row is
            // what forced the group column into every line below it.
            if (opensGroup) {
                chunks.push(fg(TUI_MUTED)(`${slashGroup(command)}\n`));
            }
            // Selection still needs a text marker, not just the accent
            // colour, so the row reads the same with colour off.
            chunks.push(active ? fg(TUI_ACCENT)("› ") : fg(TUI_MUTED)("  "));
            chunks.push(fg(active ? TUI_ACCENT : TUI_TEXT)(`/${command.name}`));
        });
        if (hidden > 0) {
            chunks.push(fg(TUI_MUTED)(`\n  … ${hidden} more`));
        }
        return new StyledText(chunks);
    }
    const commandWidth = Math.max(
        0,
        ...commands.map((command) => command.name.length),
    );
    const gutter = grouped ? SLASH_GROUP_WIDTH : 0;
    const markerWidth = grouped || selectedIndex >= 0 ? 2 : 0;
    // Each row stays one row: a description that would wrap is cut with an
    // ellipsis instead, because a wrapped row breaks the one-line-per-command
    // height the box is sized by.
    const descriptionWidth = maxWidth === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(
            1,
            maxWidth - (markerWidth + gutter + 1 + commandWidth + 2),
        );
    commands.forEach((command, index) => {
        const active = index === selectedIndex;
        const previous = commands[index - 1];
        const opensGroup = grouped
            && (previous === undefined
                || slashGroup(previous) !== slashGroup(command));
        if (index > 0) {
            chunks.push(fg(TUI_MUTED)(opensGroup ? "\n\n" : "\n"));
        }
        // Quiet selection: a chevron marker plus an accent command name, the
        // lightest device that marks the row without a loud full-width bar.
        if (markerWidth > 0) {
            chunks.push(active ? fg(TUI_ACCENT)("› ") : fg(TUI_MUTED)("  "));
        }
        // Printed once, on the group's first row. The gap below it and the
        // word reappearing at the left margin are the whole separator: no
        // heading row, which is the scarce axis, and no rule.
        if (grouped) {
            chunks.push(fg(TUI_MUTED)(
                (opensGroup ? slashGroup(command) : "").padEnd(gutter),
            ));
        }
        chunks.push(fg(active ? TUI_ACCENT : TUI_TEXT)(
            `/${command.name.padEnd(commandWidth)}`,
        ));
        const description = command.description.length > descriptionWidth
            ? `${command.description.slice(0, Math.max(0, descriptionWidth - 1))}\u2026`
            : command.description;
        chunks.push(fg(TUI_MUTED)(`  ${description}`));
    });
    if (hidden > 0) {
        chunks.push(fg(TUI_MUTED)(`\n  \u2026 ${hidden} more`));
    }
    return new StyledText(chunks);
}

/**
 * Columns the slash-command strip may actually paint beside a dock.
 *
 * The renderer still reports the whole terminal after the app reserves a
 * left rail. Measuring against that whole width lets descriptions run under
 * the rail and wrap inside the narrower strip, breaking one-command-per-row.
 */
export function tuiCommandSuggestionWidth(
    terminalColumns: number,
    horizontalInset: number,
    occupiedLeftColumns = 0,
): number {
    return Math.max(
        1,
        terminalColumns - horizontalInset - occupiedLeftColumns,
    );
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
        parse: (argumentsText) => {
            const [mode, scope, ...rest] = argumentsText.split(/\s+/)
                .filter((word) => word.length > 0);
            if (mode === undefined) {
                return { type: "open_permissions_picker" };
            }
            if (
                !isApprovalMode(mode)
                || rest.length > 0
                || (scope !== undefined && scope !== "default")
            ) {
                return {
                    type: "command_error",
                    message: `Usage: ${PERMISSIONS_COMMAND.usage}`,
                };
            }
            return {
                type: "update_permissions",
                mode,
                scope: "global",
            };
        },
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
        ...AGENT_COMMAND,
        parse: (argumentsText) =>
            argumentsText.length === 0
                ? { type: "open_agent_picker" }
                : /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argumentsText)
                ? { type: "wear_agent", name: argumentsText }
                : {
                    type: "command_error",
                    message: `Usage: ${AGENT_COMMAND.usage}`,
                },
        palette: {
            name: "agent",
            label: "Switch agents",
            description: "instructions, tools, skills and posture, as one thing",
            group: "Settings",
            slashName: "agent",
            action: { type: "open_agent_picker" },
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
        ...CONFIGURE_COMMAND,
        action: { type: "open_configure" },
        palette: {
            name: "configure",
            label: "Open config file",
            description: "edit Vera's provider and model defaults",
            group: "Settings",
            slashName: "configure",
            action: { type: "open_configure" },
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
        ...WORK_COMMAND,
        action: { type: "open_work_tab" },
        palette: {
            name: "work",
            label: "Show work",
            description: "what needs you and what is running",
            group: "Session",
            slashName: "work",
            action: { type: "open_work_tab" },
        },
    });
    registry.registerCommand({
        ...SEARCH_COMMAND,
        action: { type: "open_search" },
        palette: {
            name: "search",
            label: "Search past work",
            description: "find a message, a command, or a file",
            group: "Session",
            slashName: "search",
            action: { type: "open_search" },
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
        ...BACK_COMMAND,
        action: { type: "go_back" },
        palette: {
            name: "back",
            label: "Go back",
            description: "return to the conversation you came from",
            group: "Session",
            slashName: "back",
            action: { type: "go_back" },
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
        ...EXTENSIONS_COMMAND,
        action: { type: "show_extensions" },
        palette: {
            name: "extensions",
            label: "Manage extensions",
            description: "see installed capabilities and their state",
            group: "Extensions",
            slashName: "extensions",
            action: { type: "show_extensions" },
        },
    });
    registry.registerCommand({
        ...EXTENSION_COMMAND,
        parse: (argumentsText) => {
            const tokenized = tokenizeExtensionManagerArguments(argumentsText);
            if ("error" in tokenized) {
                return { type: "command_error", message: tokenized.error };
            }
            const parsed = parseExtensionManagerCommand([
                "extension",
                ...tokenized.words,
            ]);
            if (parsed === undefined) {
                return {
                    type: "command_error",
                    message: `Usage: ${EXTENSION_COMMAND.usage}`,
                };
            }
            if ("error" in parsed) {
                return { type: "command_error", message: parsed.error };
            }
            return parsed.command.operation === "list"
                ? { type: "show_extensions", scope: parsed.command.scope }
                : { type: "manage_extensions", command: parsed.command };
        },
        palette: {
            name: "extension",
            label: "Change an extension",
            description: "install or change managed extension state",
            group: "Extensions",
            slashName: "extension",
            action: { type: "prefill_composer", text: "/extension " },
        },
    });
    registry.registerCommand({
        ...DOCTOR_COMMAND,
        action: { type: "show_doctor" },
        palette: {
            name: "doctor",
            label: "Check process health",
            description: "find unrecognized hosts and sustained CPU",
            group: "Session",
            slashName: "doctor",
            action: { type: "show_doctor" },
        },
    });
    registry.registerCommand({
        ...FAILURE_REPORT_COMMAND,
        action: { type: "write_failure_report" },
        palette: {
            name: "failure_report",
            label: "Write a model failure report",
            description: "summarise recorded model failures into a file",
            group: "Session",
            slashName: "failure-report",
            action: { type: "write_failure_report" },
        },
    });
    registry.registerCommand({
        ...RELOAD_EXTENSIONS_COMMAND,
        action: { type: "reload_client_extensions" },
        palette: {
            name: "reload_extensions",
            label: "Reload client extensions",
            description: "re-read extension code and client configuration",
            group: "Extensions",
            slashName: "reload-extensions",
            action: { type: "reload_client_extensions" },
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
                message: `/shortlist takes no argument or "add", not "${argument}"`,
            };
        },
        palette: {
            name: "shortlist",
            label: "Show your shortlist",
            description: "the models you keep",
            group: "Settings",
            slashName: "shortlist",
            action: { type: "show_pool" },
        },
    });
    registry.registerCommand({
        ...DEFAULTS_COMMAND,
        action: { type: "show_defaults" },
        palette: {
            name: "defaults",
            label: "Show which model runs each job",
            description: "snappy, eco, extra, and the jobs that inherit them",
            group: "Settings",
            slashName: "defaults",
            action: { type: "show_defaults" },
        },
    });
    registry.registerCommand({
        ...PROVIDERS_COMMAND,
        action: { type: "open_providers" },
        palette: {
            name: "providers",
            label: "Connect a provider",
            description: "sign in, or add an endpoint of your own",
            group: "Settings",
            slashName: "providers",
            action: { type: "open_providers" },
        },
    });
    registry.registerPaletteAction({
        name: "help",
        label: "Show keyboard shortcuts",
        description: "view hotkeys, shortcuts, and keyboard controls, including ctrl+p (control p)",
        group: "Settings",
        action: { type: "open_help", tab: "keys" },
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
