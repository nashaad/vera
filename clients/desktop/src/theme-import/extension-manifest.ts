import { DESKTOP_ENGINE } from "../../../ui/src/extensions/manifest.ts";
import { THEME_IMPORT_COMMAND, THEME_IMPORTER_ID } from "../../../ui/src/extensions/theme-importer.ts";
import { THEME_IMPORT_TASK, THEME_TASK_FILE, THEME_TASK_SERVICE } from "./task-protocol.ts";

// The vera.desktop.json of the importer extension. build.ts writes it beside the worker bundle.
export const THEME_IMPORTER_MANIFEST = {
    id: THEME_IMPORTER_ID,
    version: "1.0.0",
    engine: DESKTOP_ENGINE,
    contributes: {
        tasks: [{ id: THEME_IMPORT_TASK, title: THEME_TASK_SERVICE, main: THEME_TASK_FILE }],
        commands: [{ command: THEME_IMPORT_COMMAND, title: "Import VS Code Theme…", category: "Theme", task: THEME_IMPORT_TASK }],
    },
} as const;
