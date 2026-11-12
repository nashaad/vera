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
