import { LAYOUT_COMMANDS } from "../../commands/layout-commands.ts";
import { NAVIGATION_COMMANDS } from "../../commands/navigation-commands.ts";
import { OVERLAY_COMMANDS } from "../../commands/overlay-ids.ts";
import { PAGE_COMMANDS } from "../../commands/page-commands.ts";
import { SESSION_COMMANDS } from "../../commands/session-commands.ts";

export type SlashGroup = "built-in" | "extension" | "skill";

// The terminal lists built-ins, then extensions, then skills.
export const SLASH_GROUPS: readonly SlashGroup[] = ["built-in", "extension", "skill"];

export const SLASH_GROUP_TITLES: Readonly<Record<SlashGroup, string>> = {
    "built-in": "Built in",
    extension: "Extensions",
    skill: "Skills",
};

export const NOT_IMPLEMENTED = "Not implemented yet";

// The composer pills a command can open or drive.
export type PillTarget = "model" | "effort" | "approval" | "models";

export type SlashAction =
    // Runs a window command. `needsSession` commands do nothing outside a session page.
    | { readonly kind: "command"; readonly id: string; readonly needsSession?: true }
    | { readonly kind: "pill"; readonly pill: PillTarget }
    | { readonly kind: "agent" }
    | { readonly kind: "extension" }
    | { readonly kind: "skill" }
    | { readonly kind: "unsupported" };

export interface SlashEntry {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly group: SlashGroup;
    readonly description: string;
    readonly usage: string;
    readonly action: SlashAction;
}

export interface ExtensionCommandInfo {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly source: string;
}

export interface SkillCommandInfo {
    readonly name: string;
    readonly description: string;
}

function builtin(
    name: string,
    usage: string,
    description: string,
    action: SlashAction,
    aliases: readonly string[] = [],
): SlashEntry {
    return { name, aliases, group: "built-in", description, usage, action };
}

const session = (id: string): SlashAction => ({ kind: "command", id, needsSession: true });
const command = (id: string): SlashAction => ({ kind: "command", id });
const UNSUPPORTED: SlashAction = { kind: "unsupported" };

// Every terminal command is listed. Those the window cannot run are marked, not left out.
export const BUILTIN_SLASH_ENTRIES: readonly SlashEntry[] = [
    builtin("rewind", "/rewind", "Go back to an earlier prompt", session(SESSION_COMMANDS.rewind)),
    builtin("fork", "/fork", "Start a new session from an earlier prompt", session(SESSION_COMMANDS.rewind)),
    builtin("model", "/model [name]", "Change the model", { kind: "pill", pill: "model" }),
    builtin("effort", "/effort [level]", "Change the reasoning effort", { kind: "pill", pill: "effort" }),
    builtin("permissions", "/permissions [mode]", "Change how tool calls are approved", { kind: "pill", pill: "approval" }),
    builtin("agent", "/agent [name]", "Choose the agent this session runs as", { kind: "agent" }),
    builtin("settings", "/settings", "Open Settings", command(NAVIGATION_COMMANDS.settings)),
    builtin("nudges", "/nudges", "Show standing nudges", command(OVERLAY_COMMANDS.nudges.id)),
    builtin("configure", "/configure", "Find the configuration files", command(OVERLAY_COMMANDS.configure.id)),
    builtin("themes", "/themes", "Choose a theme", command(OVERLAY_COMMANDS.themes.id)),
    builtin("animations", "/animations", "Preview the activity animations", UNSUPPORTED),
    builtin("resume", "/resume", "Go to another session", command(OVERLAY_COMMANDS.sessions.id)),
    builtin("work", "/work", "Show the sessions that need you or are running", command(NAVIGATION_COMMANDS.work)),
    builtin("sidebar", "/sidebar", "Show or hide the sidebar", command(LAYOUT_COMMANDS.toggleSidebar)),
    builtin("search", "/search", "Search past work", command(NAVIGATION_COMMANDS.search)),
    builtin("subagents", "/subagents", "List this session's subagents", session(SESSION_COMMANDS.subagents)),
    builtin("parent", "/parent", "Go to the parent session", session(SESSION_COMMANDS.parent)),
    builtin("back", "/back", "Go back to the previous page", command(NAVIGATION_COMMANDS.back)),
    builtin("clear", "/clear", "Start a new chat", command(NAVIGATION_COMMANDS.newChat), ["new"]),
    builtin("rename", "/rename [name]", "Name this session", session(SESSION_COMMANDS.rename)),
    builtin("import", "/import [path]", "Bring in a conversation from another tool", UNSUPPORTED),
    builtin("clone", "/clone", "Duplicate this session", session(SESSION_COMMANDS.clone)),
    builtin("close", "/close", "Stop this session and keep its file", session(SESSION_COMMANDS.close)),
    builtin("compact", "/compact", "Summarize earlier messages to free context", session(SESSION_COMMANDS.compact)),
    builtin("diagnostics", "/diagnostics", "Show session diagnostics", command(OVERLAY_COMMANDS.diagnostics.id)),
    builtin("extensions", "/extensions", "Show extensions that failed to load", command(OVERLAY_COMMANDS.extensions.id)),
    builtin("extension", "/extension <op>", "Install, enable, disable or remove an extension", UNSUPPORTED),
    builtin("doctor", "/doctor", "Check Vera's health", command(OVERLAY_COMMANDS.doctor.id)),
    builtin("usage", "/usage", "Open this machine's usage page", command(PAGE_COMMANDS.usage)),
    builtin("failure-report", "/failure-report", "Find the model failure report", command(OVERLAY_COMMANDS.failures.id)),
    builtin("reload-extensions", "/reload-extensions", "Reload extensions without restarting", UNSUPPORTED),
    builtin("models", "/models", "Browse every model", { kind: "pill", pill: "models" }),
    builtin("palette", "/palette", "Open the command palette", command(OVERLAY_COMMANDS.palette.id)),
];

// A command from an extension or a skill that shares a built-in's name or alias is left out, as in the terminal.
export function buildSlashEntries(
    extensions: readonly ExtensionCommandInfo[],
    skills: readonly SkillCommandInfo[],
): readonly SlashEntry[] {
    const taken = new Set(BUILTIN_SLASH_ENTRIES.flatMap((entry) => [entry.name, ...entry.aliases]));
    const entries: SlashEntry[] = [...BUILTIN_SLASH_ENTRIES];
    for (const info of extensions) {
        if (taken.has(info.name)) continue;
        taken.add(info.name);
        entries.push({
            name: info.name,
            aliases: [],
            group: "extension",
            description: info.description,
            usage: info.usage.length > 0 ? info.usage : `/${info.name}`,
            action: { kind: "extension" },
        });
    }
    for (const info of skills) {
        if (taken.has(info.name)) continue;
        taken.add(info.name);
        entries.push({
            name: info.name,
            aliases: [],
            group: "skill",
            description: info.description,
            usage: `/${info.name} [arguments]`,
            action: { kind: "skill" },
        });
    }
    return entries;
}

// The entries whose name or alias starts with what follows the slash, grouped. Empty once the
// text holds whitespace, because from then on the user is typing arguments.
export function suggestSlash(entries: readonly SlashEntry[], text: string): readonly SlashEntry[] {
    const typed = text.trimStart();
    if (!typed.startsWith("/") || /\s/.test(typed)) return [];
    const prefix = typed.slice(1);
    const matching = entries.filter((entry) =>
        entry.name.startsWith(prefix) || entry.aliases.some((alias) => alias.startsWith(prefix)));
    return SLASH_GROUPS.flatMap((group) => matching.filter((entry) => entry.group === group));
}

// The entry a typed name matches exactly, else the first one, so Enter runs what was typed.
export function defaultSlashIndex(suggestions: readonly SlashEntry[], text: string): number {
    const name = text.trimStart().slice(1);
    const exact = suggestions.findIndex((entry) => entry.name === name || entry.aliases.includes(name));
    return exact === -1 ? 0 : exact;
}

export type SlashLine =
    // Not a command; send it as a message. A path such as /tmp/a.txt lands here.
    | { readonly kind: "prompt" }
    | { readonly kind: "command"; readonly entry: SlashEntry; readonly args: string }
    | { readonly kind: "unknown"; readonly message: string };

// An exact name or alias wins; else a name prefix that only one command in the first group having a match carries.
export function resolveSlashLine(entries: readonly SlashEntry[], text: string): SlashLine {
    const typed = text.trim();
    if (!typed.startsWith("/")) return { kind: "prompt" };
    const separator = typed.search(/\s/);
    const end = separator === -1 ? typed.length : separator;
    const name = typed.slice(1, end);
    const args = typed.slice(end).trim();
    const exact = entries.find((entry) => entry.name === name || entry.aliases.includes(name));
    if (exact !== undefined) return { kind: "command", entry: exact, args };
    const prefixed = entries.filter((entry) => entry.name.startsWith(name));
    for (const group of SLASH_GROUPS) {
        const inGroup = prefixed.filter((entry) => entry.group === group);
        if (inGroup.length === 0) continue;
        const [only] = inGroup;
        if (inGroup.length === 1 && only !== undefined) return { kind: "command", entry: only, args };
        break;
    }
    const message = unknownSlashMessage(entries, text);
    return message === undefined ? { kind: "prompt" } : { kind: "unknown", message };
}

// "/Users/x" and "/tmp/a.txt" are paths, so they get no message.
export function unknownSlashMessage(entries: readonly SlashEntry[], text: string): string | undefined {
    const name = /^\s*\/([^\s/.]+)(\s|$)/.exec(text)?.[1];
    if (name === undefined) return undefined;
    const names = entries.map((entry) => entry.name);
    let closest = names.filter((candidate) => candidate.startsWith(name)).slice(0, 3);
    if (closest.length === 0) {
        let best = 3;
        for (const candidate of names) {
            const distance = editDistance(name, candidate);
            if (distance < best) {
                best = distance;
                closest = [candidate];
            }
        }
    }
    const unknown = `Unknown command: /${name}`;
    if (closest.length === 0) return unknown;
    const options = closest.map((candidate) => `/${candidate}`);
    const last = options.pop();
    const list = options.length === 0 ? last : `${options.join(", ")} or ${last}`;
    return `${unknown}. Did you mean ${list}?`;
}

function editDistance(left: string, right: string): number {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= right.length; column += 1) {
            const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
            current.push(Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution));
        }
        previous = current;
    }
    return previous[right.length] ?? 0;
}

export function notImplementedMessage(entry: SlashEntry): string {
    return `/${entry.name}: ${NOT_IMPLEMENTED}`;
}
