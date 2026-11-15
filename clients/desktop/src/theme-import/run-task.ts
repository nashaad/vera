import { importInstalledTheme, importThemeFile } from "./import-theme.ts";
import { scanInstalledThemes } from "./installed.ts";
import { extensionRoots } from "./roots.ts";
import type { ThemeTask, ThemeTaskReply } from "./task-protocol.ts";

// Converts and lists; installing what it converts is main's step, so the task writes nothing.
export async function runThemeTask(task: ThemeTask): Promise<ThemeTaskReply> {
    switch (task.kind) {
        case "import-file":
            return { kind: "imported", outcome: importThemeFile(task.path) };
        case "import-installed":
            return { kind: "imported", outcome: importInstalledTheme(task.theme) };
        case "list-installed":
            return { kind: "listed", scan: await scanInstalledThemes(task.roots ?? extensionRoots()) };
    }
}
