import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
    MAX_REPLY_BYTES,
    MAX_REPLY_THEMES,
    parseThemeTask,
    parseThemeTaskReply,
    type ThemeTask,
} from "../../clients/desktop/src/theme-import/task-protocol.ts";
import { runThemeTask } from "../../clients/desktop/src/theme-import/run-task.ts";
import { manifestText, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

test("@core each task and its answer survive the copy between processes", async () => {
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
        { kind: "import-file", path: writeText(join(files, "crow.json"), pirateCrowText()) },
        { kind: "import-installed", theme },
    ];
    for (const sent of tasks) {
        const task = parseThemeTask(structuredClone(sent));
        expect(task).toEqual(sent as ThemeTask);
        if (task === undefined) continue;
        const reply = parseThemeTaskReply(structuredClone(await runThemeTask(task)));
        expect(reply?.kind === "imported" && reply.outcome.ok && reply.outcome.themes.length).toBe(1);
    }
    const refused = await runThemeTask({ kind: "import-file", path: join(files, "missing.json") });
    expect(parseThemeTaskReply(structuredClone(refused))).toEqual(refused);
});

test("@core a task writes nothing beside the file it reads, and the converted theme comes back whole", async () => {
    const files = scratchDirectory();
    const path = writeText(join(files, "crow.json"), pirateCrowText());
    const reply = await runThemeTask({ kind: "import-file", path });
    expect(readdirSync(files)).toEqual(["crow.json"]);
    const read = parseThemeTaskReply(structuredClone(reply));
    expect(read).toEqual(reply);
    expect(read?.kind === "imported" && read.outcome.ok && read.outcome.themes[0]?.colors.surface).toBe("#10131a");
});

test("@core a listing task may leave its roots out, and a reply holds at most the capped themes and bytes", async () => {
    expect(parseThemeTask({ kind: "list-installed" })).toEqual({ kind: "list-installed" });
    const converted = await runThemeTask({ kind: "import-file", path: writeText(join(scratchDirectory(), "crow.json"), pirateCrowText()) });
    const theme = converted.kind === "imported" && converted.outcome.ok ? converted.outcome.themes[0] : undefined;
    if (theme === undefined) throw new Error("The fixture theme did not import.");
    const themes = (count: number) => Array.from({ length: count }, () => theme);
    expect(parseThemeTaskReply({ kind: "imported", outcome: { ok: true, themes: themes(1), skipped: [] } })).toBeDefined();
    expect(parseThemeTaskReply({ kind: "imported", outcome: { ok: true, themes: themes(MAX_REPLY_THEMES + 1), skipped: [] } })).toBeUndefined();
    const heavy = { ...theme, source: "x".repeat(MAX_REPLY_BYTES) };
    expect(parseThemeTaskReply({ kind: "imported", outcome: { ok: true, themes: [heavy], skipped: [] } })).toBeUndefined();
});

test("theme tasks and answers of the wrong shape are not read", () => {
    for (const task of [undefined, "list", { kind: "delete" }, { kind: "import-file", path: 1 }, { kind: "list-installed", roots: [1] }]) {
        expect(parseThemeTask(task)).toBeUndefined();
    }
    for (const reply of [null, { kind: "imported" }, { kind: "imported", outcome: { ok: true, themes: [{}], skipped: [] } }, { kind: "imported", outcome: { ok: true, imported: [], skipped: [] } }, { kind: "listed", scan: { themes: [], cut: "no" } }]) {
        expect(parseThemeTaskReply(reply)).toBeUndefined();
    }
});
