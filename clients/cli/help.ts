export interface CliCommandHelp {
    readonly usage: string;
    readonly description: string;
}

export const CLI_COMMANDS: readonly CliCommandHelp[] = [
    { usage: "vera", description: "Start a new agent in the current directory" },
    { usage: "vera ls", description: "List live resident agents" },
    { usage: "vera attach <agent-id>", description: "Attach to a live agent" },
    { usage: "vera resume <session-path>", description: "Resume a durable session" },
    { usage: "vera send <agent-id> <message>", description: "Send a prompt to a live agent" },
    { usage: "vera abort <agent-id>", description: "Stop a live agent's active turn" },
    { usage: "vera login [openai-codex]", description: "Sign in with a Codex subscription" },
    { usage: "vera rpc", description: "Run the NDJSON integration bridge" },
] as const;

export function renderCliHelp(): string {
    const width = Math.max(...CLI_COMMANDS.map((command) => command.usage.length));
    const commands = CLI_COMMANDS.map((command) =>
        `  ${command.usage.padEnd(width)}  ${command.description}`
    ).join("\n");
    return `Vera coding agent\n\nUsage:\n${commands}\n\nOptions:\n`
        + "  -h, --help     Show this help\n"
        + "  -v, --version  Show the source revision\n";
}

export function renderCliUsage(): string {
    return "Run 'vera --help' to see available commands.\n";
}
