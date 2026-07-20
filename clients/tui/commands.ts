export interface TuiCommandCatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
}

export interface OpenRewindTuiCommandAction {
    readonly type: "open_rewind";
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
    readonly mode: "ask" | "approve_for_me" | "full_access";
}

export interface TuiCommandErrorAction {
    readonly type: "command_error";
    readonly message: string;
}

export type TuiCommandAction =
    | OpenRewindTuiCommandAction
    | UpdateModelTuiCommandAction
    | UpdateReasoningTuiCommandAction
    | UpdatePermissionsTuiCommandAction
    | TuiCommandErrorAction;

export interface TuiCommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly action?: OpenRewindTuiCommandAction;
    readonly parse?: (argumentsText: string) => TuiCommandAction;
}

const REWIND_COMMAND = {
    name: "rewind",
    description: "Rewind the active conversation",
    usage: "/rewind",
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
    usage: "/permissions <ask|approve_for_me|full_access>",
} as const satisfies TuiCommandCatalogEntry;

export const BUILTIN_COMMANDS = [
    REWIND_COMMAND,
    MODEL_COMMAND,
    REASONING_COMMAND,
    PERMISSIONS_COMMAND,
] as const satisfies readonly TuiCommandCatalogEntry[];

export class TuiCommandRegistry {
    private readonly commands = new Map<string, TuiCommandDefinition>();

    registerCommand(command: TuiCommandDefinition): void {
        if (this.commands.has(command.name)) {
            throw new Error(`Duplicate TUI command: /${command.name}`);
        }
        this.commands.set(command.name, command);
    }

    registeredCommands(): readonly TuiCommandCatalogEntry[] {
        return [...this.commands.values()].map((command) => ({
            name: command.name,
            description: command.description,
            usage: command.usage,
        }));
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
        const command = this.commands.get(name);
        if (command === undefined) {
            return undefined;
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
): string {
    return commands
        .map((command) => `/${command.name}  ${command.description}`)
        .join("\n");
}

export function createBuiltinTuiCommandRegistry(): TuiCommandRegistry {
    const registry = new TuiCommandRegistry();
    registry.registerCommand({
        ...REWIND_COMMAND,
        action: { type: "open_rewind" },
    });
    registry.registerCommand({
        ...MODEL_COMMAND,
        parse: (argumentsText) => argumentsText.length === 0
            ? { type: "command_error", message: `Usage: ${MODEL_COMMAND.usage}` }
            : { type: "update_model", model: argumentsText },
    });
    registry.registerCommand({
        ...REASONING_COMMAND,
        parse: (argumentsText) => isReasoningEffort(argumentsText)
            ? { type: "update_reasoning", reasoningEffort: argumentsText }
            : { type: "command_error", message: `Usage: ${REASONING_COMMAND.usage}` },
    });
    registry.registerCommand({
        ...PERMISSIONS_COMMAND,
        parse: (argumentsText) => isApprovalMode(argumentsText)
            ? { type: "update_permissions", mode: argumentsText }
            : { type: "command_error", message: `Usage: ${PERMISSIONS_COMMAND.usage}` },
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

function isApprovalMode(value: string): value is UpdatePermissionsTuiCommandAction["mode"] {
    return value === "ask"
        || value === "approve_for_me"
        || value === "full_access";
}
