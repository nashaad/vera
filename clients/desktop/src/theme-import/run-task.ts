import { ThemeStore } from "../theme-store.ts";
import { importInstalledTheme, importThemeFile } from "./import-theme.ts";
import { scanInstalledThemes } from "./installed.ts";
import type { ThemeTask, ThemeTaskReply } from "./task-protocol.ts";

// Saving happens here, not in the main process, so a theme's token rules never cross back to it.
export async function runThemeTask(task: ThemeTask): Promise<ThemeTaskReply> {
    switch (task.kind) {
        case "import-file":
            return { kind: "imported", outcome: importThemeFile(new ThemeStore(task.directory), task.path) };
        case "import-installed":
            return { kind: "imported", outcome: importInstalledTheme(new ThemeStore(task.directory), task.theme) };
        case "list-installed":
            return { kind: "listed", scan: await scanInstalledThemes(task.roots) };
    }
}
