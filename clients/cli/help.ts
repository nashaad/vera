export interface CliCommandHelp {
    readonly usage: string;
    readonly description: string;
}

export const CLI_COMMANDS: readonly CliCommandHelp[] = [
    { usage: "vera", description: "Start a new agent in the current directory" },
    { usage: "vera -c", description: "Continue the most recent session" },
    { usage: "vera -p \"prompt\" [flags]", description: "Run one bounded turn and print the final reply" },
    { usage: "vera ls", description: "List live resident agents" },
    { usage: "vera attach <agent-id>", description: "Attach to a live agent" },
    { usage: "vera resume <session-id|path>", description: "Resume a durable session" },
    { usage: "vera export <session-path> [--format markdown|json]", description: "Export a conversation" },
    { usage: "vera inspect <session-path>", description: "Inspect the latest model request" },
    { usage: "vera abort <agent-id>", description: "Stop a live agent's active turn" },
    { usage: "vera host stop [-y|--yes]", description: "Stop the resident host and attached clients" },
    { usage: "vera login", description: "Sign in to a Vera account (not available yet)" },
    { usage: "vera rpc", description: "Run the NDJSON integration bridge" },
] as const;

export function renderCliHelp(): string {
    const width = Math.max(...CLI_COMMANDS.map((command) => command.usage.length));
    const commands = CLI_COMMANDS.map((command) =>
        `  ${command.usage.padEnd(width)}  ${command.description}`
    ).join("\n");
    return `Vera coding agent\n\nUsage:\n${commands}\n\nOptions:\n`
        + "  -h, --help     Show this help\n"
        + "  -y, --yes     Skip host stop or busy-host restart confirmation\n"
        + "  -v, --version  Show the source revision\n"
        + "\nFlags for -p:\n"
        + "  --permission-mode <mode>  Run under a named permission mode\n"
        + "  --model <provider/model>  Run on one model instead of the configured one\n"
        + "  --effort <level>          Run at one reasoning effort\n";
}

export function renderCliUsage(): string {
    return "Run 'vera --help' to see available commands.\n";
}
