export interface CliCommandHelp {
    readonly usage: string;
    readonly description: string;
}

export const CLI_COMMANDS: readonly CliCommandHelp[] = [
    { usage: "vera [--bare|--prompt-only]", description: "Start a new agent in the current directory" },
    { usage: "vera -c", description: "Continue the most recent session" },
    { usage: "vera -p \"prompt\" [flags]", description: "Run one bounded turn and print the final reply" },
    { usage: "vera ls [--all]", description: "List this workspace's agents, or every one" },
    { usage: "vera attach <agent-id>", description: "Attach to a live agent" },
    { usage: "vera resume <session-id|path>", description: "Resume a durable session" },
    { usage: "vera export <session-path> [--format markdown|json]", description: "Export a conversation" },
    { usage: "vera inspect <session-path>", description: "Inspect the latest model request" },
    { usage: "vera configure", description: "Open Vera's config file in your editor" },
    { usage: "vera abort <agent-id>", description: "Stop a live agent's active turn" },
    { usage: "vera pool list", description: "List pooled models" },
    { usage: "vera pool add <provider/model> [--verify]", description: "Add a model to the pool" },
    { usage: "vera pool remove <pool name|id>", description: "Remove a model from the pool" },
    { usage: "vera schedule add ID --cron EXPR --to ID --text TEXT [--timezone TZ]", description: "Create a cron schedule" },
    { usage: "vera schedule list", description: "List schedules" },
    { usage: "vera schedule show ID", description: "Inspect a schedule and its runs" },
    { usage: "vera schedule pause|resume|remove|run ID", description: "Control or trigger a schedule" },
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
        + "  --bare                    Skip model extensions, project guidance, memory, and scratch prompt state\n"
        + "  --prompt-only             Send only Vera's identity prompt and user message; offer no tools\n"
        + "  --permission-mode <mode>  Run under a named permission mode\n"
        + "  --model <pool name|id>    Run on one pooled model, by name or provider/model\n"
        + "  --effort <level>          Run at one reasoning effort\n";
}

export function renderCliUsage(): string {
    return "Run 'vera --help' to see available commands.\n";
}
