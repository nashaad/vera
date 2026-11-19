import { parseImportedTheme, type ImportedTheme } from "../../../ui/src/theme/imported.ts";

// What main and the task of an included extension's command say to each other. Main imports only this file from
// this folder; an extension's worker imports it too, and holds the code that answers.

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// One reply holds at most this many themes, and this many bytes of them once written as JSON.
export const MAX_REPLY_THEMES = 200;
export const MAX_REPLY_BYTES = 16 * 1024 * 1024;
export const MAX_SKIPPED_LINES = 200;
export const MAX_PICK_ITEMS = 300;
// An item's value is handed back to the task unread, so it is capped by its size as JSON.
export const MAX_PICK_VALUE_BYTES = 16 * 1024;
export const MAX_COMMAND_LENGTH = 200;
export const MAX_PATH_LENGTH = 4096;
export const MAX_TEXT_LENGTH = 400;
export const MAX_REASON_LENGTH = 1000;
const MAX_JSON_DEPTH = 8;

export interface CommandTask {
    readonly command: string;
    // The file the person chose, for a command whose manifest entry has a `file` filter.
    readonly file?: string;
    // The value of the item the person picked from this command's last `pick` reply.
    readonly pick?: JsonValue;
}

export interface PickItem {
    readonly label: string;
    readonly detail?: string;
    readonly value: JsonValue;
}

export type CommandReply =
    // Converted themes; main installs them and the task writes nothing.
    | { readonly kind: "themes"; readonly themes: readonly ImportedTheme[]; readonly skipped: readonly string[] }
    // A list for the person to choose from. `cut` is set when more items were found than are listed.
    | { readonly kind: "pick"; readonly title: string; readonly items: readonly PickItem[]; readonly cut: boolean }
    | { readonly kind: "refused"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isJsonValue(value: unknown, depth: number): value is JsonValue {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (depth >= MAX_JSON_DEPTH) return false;
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
    return isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

// A value that is plain JSON and no larger than an item's cap.
export function parseJsonValue(value: unknown): JsonValue | undefined {
    if (!isJsonValue(value, 0)) return undefined;
    return JSON.stringify(value).length <= MAX_PICK_VALUE_BYTES ? value : undefined;
}

export function parseCommandTask(value: unknown): CommandTask | undefined {
    if (!isRecord(value) || !isText(value.command, MAX_COMMAND_LENGTH)) return undefined;
    const { command, file, pick } = value;
    if (file !== undefined && !isText(file, MAX_PATH_LENGTH)) return undefined;
    const picked = pick === undefined ? undefined : parseJsonValue(pick);
    if (pick !== undefined && picked === undefined) return undefined;
    return { command, ...(file === undefined ? {} : { file }), ...(picked === undefined ? {} : { pick: picked }) };
}

function parseThemes(value: unknown, skipped: unknown): CommandReply | undefined {
    if (!Array.isArray(value) || value.length > MAX_REPLY_THEMES || JSON.stringify(value).length > MAX_REPLY_BYTES) return undefined;
    if (!Array.isArray(skipped) || skipped.length > MAX_SKIPPED_LINES || !skipped.every((line) => isText(line, MAX_REASON_LENGTH))) return undefined;
    const themes: ImportedTheme[] = [];
    for (const entry of value) {
        const theme = parseImportedTheme(entry);
        if (theme === undefined) return undefined;
        themes.push(theme);
    }
    return { kind: "themes", themes, skipped: skipped as string[] };
}

function parsePickItem(value: unknown): PickItem | undefined {
    if (!isRecord(value) || !isText(value.label, MAX_TEXT_LENGTH)) return undefined;
    const { label, detail } = value;
    if (detail !== undefined && !isText(detail, MAX_TEXT_LENGTH)) return undefined;
    const item = parseJsonValue(value.value);
    if (item === undefined) return undefined;
    return { label, ...(detail === undefined ? {} : { detail }), value: item };
}

function parsePick(value: Record<string, unknown>): CommandReply | undefined {
    const { title, items, cut } = value;
    if (!isText(title, MAX_TEXT_LENGTH) || !Array.isArray(items) || items.length > MAX_PICK_ITEMS || typeof cut !== "boolean") return undefined;
    const parsed: PickItem[] = [];
    for (const entry of items) {
        const item = parsePickItem(entry);
        if (item === undefined) return undefined;
        parsed.push(item);
    }
    return { kind: "pick", title, items: parsed, cut };
}

export function parseCommandReply(value: unknown): CommandReply | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === "themes") return parseThemes(value.themes, value.skipped);
    if (value.kind === "pick") return parsePick(value);
    if (value.kind === "refused") return isText(value.reason, MAX_REASON_LENGTH) ? { kind: "refused", reason: value.reason } : undefined;
    return undefined;
}
