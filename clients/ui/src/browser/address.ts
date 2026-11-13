import type { AnnexPage } from "../protocol/bridge.ts";

// An entry is "" for the start page, a path on the annex such as /usage, or text that names
// somewhere else, kept so the address bar can show what was typed.
export interface BrowserHistory {
    readonly entries: readonly string[];
    readonly at: number;
}

export const HISTORY_LIMIT = 50;

export const START: BrowserHistory = { entries: [""], at: 0 };

export function currentEntry(history: BrowserHistory): string {
    return history.entries[history.at] ?? "";
}

// Opening the page already shown leaves the history as it is; anything ahead of it is dropped.
export function browse(history: BrowserHistory, entry: string): BrowserHistory {
    if (currentEntry(history) === entry) return history;
    const kept = [...history.entries.slice(0, history.at + 1), entry];
    const entries = kept.slice(Math.max(0, kept.length - HISTORY_LIMIT));
    return { entries, at: entries.length - 1 };
}

export function step(history: BrowserHistory, by: -1 | 1): BrowserHistory {
    const at = history.at + by;
    return at < 0 || at >= history.entries.length ? history : { ...history, at };
}

export function isAnnexPath(entry: string): boolean {
    return entry.startsWith("/");
}

// The annex host and port as the address bar shows them, such as 127.0.0.1:8372.
export function annexHost(base: string): string {
    return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function displayAddress(entry: string, base: string | undefined): string {
    if (entry === "" || !isAnnexPath(entry)) return entry;
    return base === undefined ? entry : `${annexHost(base)}${entry}`;
}

// What the address bar was given: the annex's address with a path, a bare path, or a page's
// label. Anything else is kept as typed and opens nothing.
export function resolveAddress(text: string, base: string | undefined, pages: readonly AnnexPage[]): string {
    const bare = text.trim().replace(/^https?:\/\//, "");
    if (bare === "") return "";
    const hosts = base === undefined ? [] : hostSpellings(annexHost(base));
    const host = hosts.find((candidate) => bare === candidate || bare.startsWith(`${candidate}/`));
    if (host !== undefined) return bare.slice(host.length) || "/";
    if (bare.startsWith("/")) return bare;
    const lower = bare.toLowerCase();
    return pages.find((page) => page.label.toLowerCase() === lower)?.path ?? bare;
}

// The annex answers on 127.0.0.1, localhost and vera.localhost at the same port.
function hostSpellings(host: string): readonly string[] {
    const port = host.slice(host.lastIndexOf(":"));
    return [host, `127.0.0.1${port}`, `localhost${port}`, `vera.localhost${port}`];
}

// The listed page an annex path belongs to: its own path, or a query or hash on it.
export function pageAt(path: string, pages: readonly AnnexPage[]): AnnexPage | undefined {
    const bare = path.replace(/[?#].*$/, "").replace(/(.)\/+$/, "$1");
    return pages.find((page) => page.path === bare);
}
