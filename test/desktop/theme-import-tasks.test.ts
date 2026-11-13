import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { parseThemeTask, parseThemeTaskReply, type ThemeTask } from "../../clients/desktop/src/theme-import/task-protocol.ts";
import { runThemeTask } from "../../clients/desktop/src/theme-import/run-task.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { manifestText, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

test("@core each task and its answer survive the copy between processes", async () => {
    const home = scratchDirectory();
    const files = scratchDirectory();
    const root = scratchDirectory();
    writeText(join(root, "crow.hold-1.0.0", "package.json"), manifestText([{ label: "Crow Hold Night", uiTheme: "vs-dark", path: "./night.json" }]));
    writeText(join(root, "crow.hold-1.0.0", "night.json"), pirateCrowText());
    const listing = parseThemeTask(structuredClone({ kind: "list-installed", roots: [root] }));
    if (listing === undefined) throw new Error("The listing task did not read.");
    const listed = parseThemeTaskReply(structuredClone(await runThemeTask(listing)));
    if (listed?.kind !== "listed") throw new Error("The listing answer did not read.");
    const theme = listed.scan.themes[0];
    expect(theme?.label).toBe("Crow Hold Night");

    const tasks: unknown[] = [
        { kind: "import-file", directory: themesDirectory(home), path: writeText(join(files, "crow.json"), pirateCrowText()) },
        { kind: "import-installed", directory: themesDirectory(home), theme },
    ];
    for (const sent of tasks) {
        const task = parseThemeTask(structuredClone(sent));
        expect(task).toEqual(sent as ThemeTask);
        if (task === undefined) continue;
        const reply = parseThemeTaskReply(structuredClone(await runThemeTask(task)));
        expect(reply?.kind === "imported" && reply.outcome.ok && reply.outcome.imported.length).toBe(1);
    }
    const refused = await runThemeTask({ kind: "import-file", directory: themesDirectory(home), path: join(files, "missing.json") });
    expect(parseThemeTaskReply(structuredClone(refused))).toEqual(refused);
});

test("theme tasks and answers of the wrong shape are not read", () => {
    for (const task of [undefined, "list", { kind: "delete" }, { kind: "import-file", path: 1 }, { kind: "list-installed", roots: [1] }]) {
        expect(parseThemeTask(task)).toBeUndefined();
    }
    for (const reply of [null, { kind: "imported" }, { kind: "imported", outcome: { ok: true, imported: [{}], skipped: [] } }, { kind: "listed", scan: { themes: [], cut: "no" } }]) {
        expect(parseThemeTaskReply(reply)).toBeUndefined();
    }
});
