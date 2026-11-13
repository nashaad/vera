// Path and text helpers for the Files view.

export function childPath(parent: string, name: string): string {
    const separator = separatorOf(parent);
    return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

// The path below the session folder, or the whole path when it is not below it.
export function pathUnder(root: string, path: string): string {
    const separator = separatorOf(root);
    const base = root.endsWith(separator) ? root : `${root}${separator}`;
    return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path;
}

// A final newline ends the last line rather than starting another.
export function lineCount(text: string): number {
    if (text === "") return 0;
    let count = 1;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
    return text.endsWith("\n") ? count - 1 : count;
}

export function gutterText(count: number): string {
    return Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
}

export function byteSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Files opened in the view, oldest first; Back and Forward move `at` and keep the list.
export interface FileHistory {
    readonly paths: readonly string[];
    readonly at: number;
}

export const MAX_FILE_HISTORY = 50;
export const EMPTY_FILE_HISTORY: FileHistory = { paths: [], at: -1 };

export function openedFile(history: FileHistory): string | undefined {
    return history.paths[history.at];
}

// Opening a file drops whatever was ahead of the current one, as a browser does.
export function openInHistory(history: FileHistory, path: string): FileHistory {
    if (openedFile(history) === path) return history;
    const paths = [...history.paths.slice(0, history.at + 1), path].slice(-MAX_FILE_HISTORY);
    return { paths, at: paths.length - 1 };
}

export function stepHistory(history: FileHistory, step: -1 | 1): FileHistory {
    const at = history.at + step;
    return at < 0 || at >= history.paths.length ? history : { paths: history.paths, at };
}

function separatorOf(path: string): string {
    return path.includes("/") || !path.includes("\\") ? "/" : "\\";
}
