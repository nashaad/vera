import type { HelpCorpus } from "./help-corpus.ts";

export interface CliCommandHelp {
    readonly usage: string;
    readonly description: string;
}

export const CLI_COMMANDS: readonly CliCommandHelp[] = [
    { usage: "vera [--bare|--prompt-only]", description: "Start a new agent in the current directory" },
    { usage: "vera help [topic] [--llms]", description: "Explain Vera's commands, state, and recovery paths" },
    { usage: "vera -c", description: "Continue the most recent session" },
    { usage: "vera -p \"prompt\" [flags]", description: "Run one bounded turn and print the final reply" },
    { usage: "vera ls [--all]", description: "List this workspace's agents, or every one" },
    { usage: "vera attach <agent-id>", description: "Attach to a live agent" },
    { usage: "vera resume <session-id|path>", description: "Resume a durable session" },
    { usage: "vera export <session-path> [--format markdown|json]", description: "Export a conversation" },
    { usage: "vera inspect <session-path>", description: "Inspect the latest model request" },
    { usage: "vera configure", description: "Open Vera's config file in your editor" },
    { usage: "vera extension list|install|enable|disable|remove", description: "Manage profile or project extensions" },
    { usage: "vera abort <agent-id>", description: "Stop a live agent's active turn; the agent stays live and keeps its queued prompts" },
    { usage: "vera close <agent-id>", description: "End a live agent for good: discard its queued prompts and stop its work; the session is kept and can be resumed" },
    { usage: "vera doctor", description: "Check this runtime's resident host, Vera process health, leftover tmux sockets, and providers; stops leftovers in this runtime after asking; does not stop other profiles, worktrees, SDK instances, or live tmux servers" },
    { usage: "vera doctor --yes", description: "Stop leftovers in this runtime without asking first; does not stop other profiles, worktrees, SDK instances, or live tmux servers" },
    { usage: "vera doctor --check-providers", description: "Also contact each provider endpoint to test reachability and credentials" },
    { usage: "vera prune", description: "List this home's Vera processes and stop them one at a time" },
    { usage: "vera models refresh", description: "Fetch each provider's model list now, instead of waiting out the cache" },
    { usage: "vera shortlist list", description: "List the models you keep" },
    { usage: "vera shortlist add <provider/model> [--verify]", description: "Pin a model to your shortlist" },
    { usage: "vera shortlist remove <name|id>", description: "Remove a model from your shortlist" },
    { usage: "vera schedule add ID --cron EXPR --to ID --text TEXT [--timezone TZ]", description: "Create a cron schedule" },
    { usage: "vera schedule list", description: "List schedules" },
    { usage: "vera schedule show ID", description: "Inspect a schedule and its runs" },
    { usage: "vera schedule pause|resume|remove|run ID", description: "Control or trigger a schedule" },
    { usage: "vera rollback [--prefix DIR]", description: "Restore the pinned known-good release; does not pack, use Git, or use the network. --prefix is a test prefix. The daily prefix is $HOME/.local" },
    { usage: "vera migrate-home [--rollback]", description: "Lift the default profile to the Vera home root; other profiles stay in a sibling backup. --rollback restores that backup" },
    { usage: "vera host stop [-y|--yes] [--force]", description: "Stop the resident host and attached clients; --force kills one that is not answering" },
    { usage: "vera host supervise [off|status]", description: "Let launchd restart this profile's resident host when it dies, so schedules keep running with nobody at the keyboard" },
    { usage: "vera rescue", description: "Start Vera under the isolated rescue profile, when the default profile's host is wedged" },
    { usage: "vera login", description: "Sign in to a Vera account (not available yet)" },
    { usage: "vera stdio", description: "Create an agent and bridge it as NDJSON" },
    { usage: "vera stdio --attach <agent-id>", description: "Bridge a live agent as NDJSON" },
    { usage: "vera stdio --resume <session-id|path>", description: "Resume and bridge a session as NDJSON" },
] as const;

/**
 * Top-level CLI help has one renderer. `vera help`, `vera -h`, and
 * `vera --help` must stay aliases; topic lookup only narrows this corpus.
 */
export function renderCliHelp(corpus: HelpCorpus): string {
    const width = Math.max(...CLI_COMMANDS.map((command) => command.usage.length));
    const commands = CLI_COMMANDS.map((command) =>
        `  ${command.usage.padEnd(width)}  ${command.description}`
    ).join("\n");
    const topicWidth = Math.max(...corpus.topics.map((topic) => topic.slug.length));
    const topics = corpus.topics.map((topic) =>
        `  ${topic.slug.padEnd(topicWidth)}  ${topic.summary}`
    ).join("\n");
    return `Vera coding agent\n\nUsage:\n${commands}\n\nOptions:\n`
        + "  -h, --help     Show this help\n"
        + "  -y, --yes     Skip host stop or busy-host restart confirmation\n"
        + "  -v, --version  Show the product version and build ID\n"
        + "  --profile NAME  Select a profile before starting Vera\n"
        + "\nFlags for -p:\n"
        + "  --bare                    Skip model extensions, project guidance, memory, and scratch prompt state\n"
        + "  --prompt-only             Send only Vera's identity prompt and user message; offer no tools\n"
        + "  --permission-mode <mode>  Run under a named permission mode\n"
        + "  --model <name|id>         Run on one shortlisted model, by name or provider/model\n"
        + "  --session <file>          Write a durable session at this path; vera resume FILE continues it\n"
        + `\nHelp topics:\n${topics}\n\n`
        + "Use 'vera help <topic>' for one topic, or 'vera help --llms' for the compact help corpus.\n";
}

export function renderCliUsage(): string {
    return "Run 'vera --help' or 'vera help' to see available commands and guidance.\n";
}
