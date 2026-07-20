export interface TuiCommandCatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
}

export interface OpenRewindTuiCommandAction {
    readonly type: "open_rewind";
}

export interface TuiCommandErrorAction {
    readonly type: "command_error";
    readonly message: string;
}

export type TuiCommandAction =
    | OpenRewindTuiCommandAction
    | TuiCommandErrorAction;

export interface TuiCommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly action: OpenRewindTuiCommandAction;
}

const REWIND_COMMAND = {
    name: "rewind",
    description: "Rewind the active conversation",
    usage: "/rewind",
} as const satisfies TuiCommandCatalogEntry;

export const BUILTIN_COMMANDS = [
    REWIND_COMMAND,
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
        if (argumentsText.length > 0) {
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
    return registry;
}
