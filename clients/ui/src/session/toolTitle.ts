import type { ToolCall } from "./model.ts";

// The first of these arguments that is a non-empty string names the call.
const MAIN_ARGUMENT_KEYS = ["command", "cmd", "path", "file_path", "pattern", "query", "url", "name"] as const;
const PATH_KEYS: readonly string[] = ["path", "file_path"];
const TITLE_LIMIT = 96;

// The tool name and its main argument on one line, such as `read config.ts` or `bash git status`.
export function toolTitle(tool: string, args: Readonly<Record<string, unknown>>): string {
    const main = mainArgument(args);
    return main === undefined ? tool : `${tool} ${main}`;
}

function mainArgument(args: Readonly<Record<string, unknown>>): string | undefined {
    for (const key of MAIN_ARGUMENT_KEYS) {
        const value = args[key];
        if (typeof value !== "string" || value.trim().length === 0) continue;
        return PATH_KEYS.includes(key) ? lastSegment(value) : cut(collapse(value));
    }
    return undefined;
}

function lastSegment(path: string): string {
    const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? path;
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

// Cuts by code point so a surrogate pair is never split.
function cut(text: string): string {
    const characters = [...text];
    if (characters.length <= TITLE_LIMIT) return text;
    return `${characters.slice(0, TITLE_LIMIT).join("")}...`;
}

export type Action = "shell" | "read" | "search" | "web" | "fetch" | "write" | "edit" | "list" | "task";

interface ActionWords {
    // An approval's verb: "Run" before the command it asks to run.
    readonly ask: string;
    // The status line while the call runs.
    readonly live: string;
    // A finished call's row.
    readonly row: string;
    readonly one: string;
    readonly many: (count: number) => string;
}

const ACTION_OF: Readonly<Record<string, Action>> = {
    bash: "shell",
    read: "read",
    grep: "search",
    catalog_search: "search",
    web_search: "web",
    web_fetch: "fetch",
    web_download: "fetch",
    write: "write",
    edit: "edit",
    list: "list",
    subagent: "task",
    async_subagent: "task",
    message_subagent: "task",
};

const ACTIONS: Readonly<Record<Action, ActionWords>> = {
    shell: { ask: "Run", live: "Running", row: "Ran", one: "ran a command", many: (n) => `ran ${n} commands` },
    read: { ask: "Read", live: "Reading", row: "Read", one: "read a file", many: (n) => `read ${n} files` },
    search: { ask: "Search", live: "Searching", row: "Searched", one: "searched once", many: (n) => `searched ${n} times` },
    web: {
        ask: "Search the web for",
        live: "Searching the web",
        row: "Searched the web for",
        one: "searched the web",
        many: (n) => `searched the web ${n} times`,
    },
    fetch: { ask: "Open", live: "Fetching", row: "Fetched", one: "fetched a page", many: (n) => `fetched ${n} pages` },
    write: { ask: "Create", live: "Writing", row: "Wrote", one: "wrote a file", many: (n) => `wrote ${n} files` },
    edit: { ask: "Edit", live: "Editing", row: "Edited", one: "edited a file", many: (n) => `edited ${n} files` },
    list: { ask: "List", live: "Listing", row: "Listed", one: "listed a folder", many: (n) => `listed ${n} folders` },
    task: {
        ask: "Start a subagent for",
        live: "Starting a subagent",
        row: "Started a subagent",
        one: "started a subagent",
        many: (n) => `started ${n} subagents`,
    },
};

export function actionOf(tool: string): Action | undefined {
    return ACTION_OF[tool];
}

// What an approval asks to do, before its target: "Run", "Create", or the tool's own name.
export function askTitle(tool: string): string {
    const action = actionOf(tool);
    return action === undefined ? tool : ACTIONS[action].ask;
}

// Writes and edits that landed are named by the diff rollup or the plan, so a line for them adds nothing.
export function changesFiles(call: ToolCall): boolean {
    const action = actionOf(call.tool);
    return (action === "write" || action === "edit") && call.state === "done" && call.presentation !== undefined
        && call.presentation.kind !== "tool_notice";
}

export function isShell(call: ToolCall): boolean {
    return actionOf(call.tool) === "shell";
}

// The shortest tail of a path that no other path in the run shares.
function uniqueSuffix(path: string, others: readonly string[]): string {
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
    for (let take = 1; take <= parts.length; take += 1) {
        const suffix = parts.slice(-take).join("/");
        const clash = others.some((other) => other !== path
            && other.split(/[\\/]/).filter((part) => part.length > 0).slice(-take).join("/") === suffix);
        if (!clash) return suffix;
    }
    return path;
}

function stringArg(call: ToolCall, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = call.args[key];
        if (typeof value === "string" && value.trim().length > 0) return collapse(value);
    }
    return undefined;
}

export function callPath(call: ToolCall): string | undefined {
    return stringArg(call, PATH_KEYS);
}

// What a call acts on: a command line is kept whole, a path is cut to what tells it apart.
export function callTarget(call: ToolCall, others: readonly string[] = []): string {
    const action = actionOf(call.tool);
    const text = stringArg(call, ["command", "cmd", "pattern", "query", "q", "url", "name"]);
    const path = callPath(call);
    // A search names its pattern, and the path it searches in is only where.
    if (text !== undefined && (path === undefined || action === "shell" || action === "search" || action === "web")) return cut(text);
    if (path !== undefined) return uniqueSuffix(path, others);
    if (text !== undefined) return cut(text);
    return call.title.startsWith(`${call.tool} `) ? call.title.slice(call.tool.length + 1) : "";
}

// What an approval names after its action. The whole path stays, as the folder is often why the tool asks;
// a command or query is kept whole too, and the card's width cuts it.
export function askTarget(tool: string, input: Readonly<Record<string, unknown>>): string {
    const call: ToolCall = { tool, title: "", args: input, state: "running" };
    const path = callPath(call);
    const action = actionOf(tool);
    if (path !== undefined && action !== "shell" && action !== "search" && action !== "web") return path;
    return stringArg(call, ["command", "cmd", "pattern", "query", "q", "url", "name"]) ?? path ?? "";
}

export function callPaths(calls: readonly ToolCall[]): string[] {
    return calls.flatMap((call) => callPath(call) ?? []);
}

export function rowVerb(call: ToolCall): string {
    const action = actionOf(call.tool);
    return action === undefined ? call.tool : ACTIONS[action].row;
}

// The status line's words for the call that is running: `Reading` and `app.js`.
export function liveAction(call: ToolCall, others: readonly string[] = []): { readonly label: string; readonly target: string } {
    const action = actionOf(call.tool);
    if (action === undefined) return { label: call.tool, target: callTarget(call, others) };
    return { label: ACTIONS[action].live, target: action === "task" ? "" : callTarget(call, others) };
}

// A finished run in one line, one phrase per kind of call in the order each first ran: `Ran 3 commands, read 2 files`.
export function toolSummary(calls: readonly ToolCall[]): string {
    const counts = new Map<string, number>();
    for (const call of calls) {
        const key = actionOf(call.tool) ?? call.tool;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const text = [...counts]
        .map(([key, count]) => {
            const action = ACTIONS[key as Action] as ActionWords | undefined;
            if (action !== undefined) return count === 1 ? action.one : action.many(count);
            return count === 1 ? `used ${key}` : `used ${key} ${count} times`;
        })
        .join(", ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// The whole command of a shell call, with its line breaks.
export function shellCommand(call: ToolCall): string {
    const raw = call.args["command"] ?? call.args["cmd"];
    return typeof raw === "string" ? raw : callTarget(call);
}
