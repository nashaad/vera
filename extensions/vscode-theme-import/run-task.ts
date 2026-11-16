import {
    MAX_REASON_LENGTH,
    MAX_SKIPPED_LINES,
    MAX_TEXT_LENGTH,
    parseJsonValue,
    type CommandReply,
    type CommandTask,
    type JsonValue,
    type PickItem,
} from "../../clients/desktop/src/extension-commands/task-protocol.ts";
import { importInstalledTheme, importThemeFile, type ImportOutcome } from "./import-theme.ts";
import { parseInstalledTheme, scanInstalledThemes, type InstalledTheme } from "./installed.ts";
import { extensionRoots } from "./roots.ts";

export const IMPORT_COMMAND = "vera.vscode-theme-import.import";
export const INSTALLED_COMMAND = "vera.vscode-theme-import.installed";

const UNREADABLE = "Vera could not read that file as a theme.";
const FAILED = "Vera could not import that theme.";
const NONE_INSTALLED = "VS Code has no themed extensions installed here.";
const PICK_TITLE = "Themes installed in VS Code";

function reply(outcome: ImportOutcome): CommandReply {
    if (!outcome.ok) return { kind: "refused", reason: outcome.reason.slice(0, MAX_REASON_LENGTH) };
    return {
        kind: "themes",
        themes: outcome.themes,
        skipped: outcome.skipped.slice(0, MAX_SKIPPED_LINES).map((line) => line.slice(0, MAX_REASON_LENGTH)),
    };
}

function valueOf(theme: InstalledTheme): JsonValue | undefined {
    const { label, extension, folder, path, uiTheme } = theme;
    return parseJsonValue({ label, extension, folder, path, ...(uiTheme === undefined ? {} : { uiTheme }) });
}

function itemsOf(themes: readonly InstalledTheme[]): PickItem[] {
    const items: PickItem[] = [];
    for (const theme of themes) {
        const value = valueOf(theme);
        if (value === undefined) continue;
        items.push({ label: theme.label.slice(0, MAX_TEXT_LENGTH), detail: theme.extension.slice(0, MAX_TEXT_LENGTH), value });
    }
    return items;
}

async function listInstalled(roots: readonly string[]): Promise<CommandReply> {
    const scan = await scanInstalledThemes(roots);
    const items = itemsOf(scan.themes);
    if (items.length === 0) return { kind: "refused", reason: NONE_INSTALLED };
    return { kind: "pick", title: PICK_TITLE, items, cut: scan.cut };
}

// Converts and lists; installing what it converts is main's step, so the task writes nothing.
// `roots` are the folders to search for installed themes; VS Code's own when they are left out.
export async function runCommandTask(task: CommandTask, roots: readonly string[] = extensionRoots()): Promise<CommandReply> {
    if (task.command === IMPORT_COMMAND) {
        return task.file === undefined ? { kind: "refused", reason: UNREADABLE } : reply(importThemeFile(task.file));
    }
    if (task.command === INSTALLED_COMMAND) {
        if (task.pick === undefined) return listInstalled(roots);
        const theme = parseInstalledTheme(task.pick);
        return theme === undefined ? { kind: "refused", reason: UNREADABLE } : reply(importInstalledTheme(theme));
    }
    return { kind: "refused", reason: FAILED };
}
