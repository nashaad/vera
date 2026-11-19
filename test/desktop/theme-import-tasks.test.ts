import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
    MAX_PICK_ITEMS,
    MAX_PICK_VALUE_BYTES,
    MAX_REPLY_BYTES,
    MAX_REPLY_THEMES,
    parseCommandReply,
    parseCommandTask,
    type CommandReply,
    type CommandTask,
} from "../../clients/desktop/src/extension-commands/task-protocol.ts";
import { IMPORT_COMMAND, INSTALLED_COMMAND, runCommandTask } from "../../extensions/vscode-theme-import/run-task.ts";
import { manifestText, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

// A task and its answer cross a structured clone and a JSON round trip, as they do between processes.
async function answered(task: CommandTask, roots: readonly string[] = []): Promise<CommandReply> {
    const sent = parseCommandTask(JSON.parse(JSON.stringify(structuredClone(task))));
    if (sent === undefined) throw new Error("The task did not read.");
    const reply = parseCommandReply(JSON.parse(JSON.stringify(structuredClone(await runCommandTask(sent, roots)))));
    if (reply === undefined) throw new Error("The reply did not read.");
    return reply;
}

function installedRoot(): string {
    const root = scratchDirectory();
    writeText(join(root, "crow.hold-1.0.0", "package.json"), manifestText([{ label: "Crow Hold Night", uiTheme: "vs-dark", path: "./night.json" }]));
    writeText(join(root, "crow.hold-1.0.0", "night.json"), pirateCrowText());
    return root;
}

test("@core each command task and its answer survive the copy between processes", async () => {
    const files = scratchDirectory();
    const root = installedRoot();
    const listed = await answered({ command: INSTALLED_COMMAND }, [root]);
    if (listed.kind !== "pick") throw new Error("The listing did not answer with a list.");
    expect(listed.items.map((item) => [item.label, item.detail])).toEqual([["Crow Hold Night", "Pirate Crow Pack"]]);
    expect(listed.cut).toBe(false);

    const tasks: CommandTask[] = [
        { command: IMPORT_COMMAND, file: writeText(join(files, "crow.json"), pirateCrowText()) },
        { command: INSTALLED_COMMAND, pick: listed.items[0]?.value ?? null },
    ];
    for (const task of tasks) {
        expect(parseCommandTask(structuredClone(task))).toEqual(task);
        const reply = await answered(task, [root]);
        expect(reply.kind === "themes" && reply.themes.length).toBe(1);
    }
    const refused = await answered({ command: IMPORT_COMMAND, file: join(files, "missing.json") });
    expect(refused.kind).toBe("refused");
});

test("@core a command task writes nothing beside the file it reads, and the converted theme comes back whole", async () => {
    const files = scratchDirectory();
    const path = writeText(join(files, "crow.json"), pirateCrowText());
    const reply = await answered({ command: IMPORT_COMMAND, file: path });
    expect(readdirSync(files)).toEqual(["crow.json"]);
    expect(reply.kind === "themes" && reply.themes[0]?.colors.surface).toBe("#10131a");
});

test("a command the importer does not have, or a file command without a file, is refused", async () => {
    expect(await answered({ command: "vera.other.import", file: "/crow.json" })).toEqual({ kind: "refused", reason: "Vera could not import that theme." });
    expect(await answered({ command: IMPORT_COMMAND })).toEqual({ kind: "refused", reason: "Vera could not read that file as a theme." });
    expect(await answered({ command: INSTALLED_COMMAND, pick: { path: 1 } })).toEqual({ kind: "refused", reason: "Vera could not read that file as a theme." });
    expect(await answered({ command: INSTALLED_COMMAND }, [scratchDirectory()])).toEqual({ kind: "refused", reason: "VS Code has no themed extensions installed here." });
});

test("a reply holds at most the capped themes, bytes, items and value size", async () => {
    const converted = await answered({ command: IMPORT_COMMAND, file: writeText(join(scratchDirectory(), "crow.json"), pirateCrowText()) });
    const theme = converted.kind === "themes" ? converted.themes[0] : undefined;
    if (theme === undefined) throw new Error("The fixture theme did not import.");
    const themes = (count: number) => Array.from({ length: count }, () => theme);
    expect(parseCommandReply({ kind: "themes", themes: themes(1), skipped: [] })).toBeDefined();
    expect(parseCommandReply({ kind: "themes", themes: themes(MAX_REPLY_THEMES + 1), skipped: [] })).toBeUndefined();
    expect(parseCommandReply({ kind: "themes", themes: [{ ...theme, source: "x".repeat(MAX_REPLY_BYTES) }], skipped: [] })).toBeUndefined();

    const item = (value: unknown) => ({ label: "Crow", value });
    const pick = (items: unknown[]) => ({ kind: "pick", title: "Crow", items, cut: false });
    expect(parseCommandReply(pick(Array.from({ length: MAX_PICK_ITEMS }, () => item(1))))).toBeDefined();
    expect(parseCommandReply(pick(Array.from({ length: MAX_PICK_ITEMS + 1 }, () => item(1))))).toBeUndefined();
    expect(parseCommandReply(pick([item("x".repeat(MAX_PICK_VALUE_BYTES))]))).toBeUndefined();
});

test("command tasks and answers of the wrong shape are not read", () => {
    const wrongTasks = [undefined, "run", { command: "" }, { command: 1 }, { command: "a", file: 1 }, { command: "a", file: "" }, { command: "a", pick: () => 1 }, { command: "a", pick: undefined, file: [] }];
    for (const task of wrongTasks) expect(parseCommandTask(task)).toBeUndefined();
    const wrongReplies = [
        null,
        { kind: "themes" },
        { kind: "themes", themes: [{}], skipped: [] },
        { kind: "themes", themes: [], skipped: [1] },
        { kind: "pick", title: "", items: [], cut: false },
        { kind: "pick", title: "Crow", items: [{ value: 1 }], cut: false },
        { kind: "pick", title: "Crow", items: [{ label: "Crow", value: undefined }], cut: false },
        { kind: "pick", title: "Crow", items: [], cut: "no" },
        { kind: "refused" },
        { kind: "refused", reason: "" },
        { kind: "listed", scan: { themes: [], cut: false } },
    ];
    for (const reply of wrongReplies) expect(parseCommandReply(reply)).toBeUndefined();
});
