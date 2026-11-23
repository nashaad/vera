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

export function byteSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function separatorOf(path: string): string {
    return path.includes("/") || !path.includes("\\") ? "/" : "\\";
}
