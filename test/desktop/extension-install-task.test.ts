import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { parseInstallReply, parseInstallTask, type InstallTask } from "../../clients/desktop/src/extension-install/task-protocol.ts";
import { runInstallTask } from "../../clients/desktop/src/extension-install/run-task.ts";
import { MAX_PACKAGE_BYTES } from "../../clients/desktop/src/extensions/limits.ts";
import { themeFiles, writePackage, type TarItem } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function stagingFolder(): string {
    return mkdtempSync(join(scratchDirectory(), ".staging-"));
}

function run(items: readonly TarItem[], extra: Partial<InstallTask> = {}): { reply: ReturnType<typeof runInstallTask>; staging: string } {
    const staging = stagingFolder();
    const reply = runInstallTask({ kind: "install", packagePath: writePackage(items), staging, ...extra });
    return { reply, staging };
}

const CROW = [{ label: "Crow Night", name: "Crow Night" }];

test("@core a theme package unpacks into the staging folder and the reply is the preview", () => {
    const { reply, staging } = run(themeFiles("crow.pack", "1.2.0", [...CROW, { label: "Crow Day", name: "Crow Day" }]));
    expect(reply).toEqual({ ok: true, preview: { id: "crow.pack", version: "1.2.0", themes: ["Crow Night", "Crow Day"], hasMain: false, hasCommands: false, hasUnavailableContributions: false } });
    expect(readdirSync(staging).sort()).toEqual(["themes", "vera.desktop.json"]);
    expect(readdirSync(join(staging, "themes")).sort()).toEqual(["crow-day.json", "crow-night.json"]);
});

test("a package with a module and commands says so in the preview", () => {
    const items = [
        { name: "vera.desktop.json", data: JSON.stringify({ id: "crow.cmds", version: "1.0.0", engine: DESKTOP_ENGINE, main: "main.js", contributes: { commands: [{ command: "crow.cmds.hello", title: "Hello" }] } }) },
        { name: "main.js", data: "export default {};" },
    ];
    expect(run(items).reply).toEqual({ ok: true, preview: { id: "crow.cmds", version: "1.0.0", themes: [], hasMain: true, hasCommands: true, hasUnavailableContributions: false } });
});

test("a package with a page script or menu marks unavailable contributions", () => {
    const items = [
        { name: "vera.desktop.json", data: JSON.stringify({ id: "crow.page", version: "1.0.0", engine: DESKTOP_ENGINE, contributes: { commands: [{ command: "crow.page.open", title: "Open", page: "open.js" }], menus: { browser: [{ command: "crow.page.open", icon: "pointer" }] } } }) },
        { name: "open.js", data: "document.body;" },
    ];
    expect(run(items).reply).toMatchObject({ ok: true, preview: { hasUnavailableContributions: true } });
});

test("a package whose only code is a task worker says it carries a module and commands", () => {
    const items = [
        { name: "vera.desktop.json", data: JSON.stringify({ id: "crow.tasks", version: "1.0.0", engine: DESKTOP_ENGINE, contributes: { tasks: [{ id: "scan", title: "Crow Scan", main: "scan.cjs" }], commands: [{ command: "crow.tasks.scan", title: "Scan", task: "scan" }] } }) },
        { name: "scan.cjs", data: "module.exports = {};" },
    ];
    expect(run(items).reply).toEqual({ ok: true, preview: { id: "crow.tasks", version: "1.0.0", themes: [], hasMain: true, hasCommands: true, hasUnavailableContributions: true } });
    expect(run(items.slice(0, 1)).reply).toEqual({ ok: false, reason: 'The file "scan.cjs" that task "scan" names is not in the extension.' });
});

test("@core the expected checksum is checked before anything is unpacked", () => {
    const path = writePackage(themeFiles("crow.pack", "1.0.0", CROW));
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const wrong = stagingFolder();
    expect(runInstallTask({ kind: "install", packagePath: path, sha256: "0".repeat(64), staging: wrong })).toEqual({ ok: false, reason: "The package does not match its expected checksum." });
    expect(readdirSync(wrong)).toEqual([]);
    const right = stagingFolder();
    expect(runInstallTask({ kind: "install", packagePath: path, sha256: hash.toUpperCase(), staging: right }).ok).toBe(true);
});

test("@core refusals come back as a reason and leave nothing unpacked outside the staging folder", () => {
    const outside = scratchDirectory();
    const cases: [string, TarItem[]][] = [
        ["not a plain file or folder", [{ name: "vera.desktop.json", data: "{}" }, { name: "link", type: "2" }]],
        ["leaves its folder", [{ name: "../escape.json", data: "x" }]],
        ["leaves its folder", [{ name: "/abs.json", data: "x" }]],
        ["The extension has no vera.desktop.json.", [{ name: "other.json", data: "{}" }]],
        ["vera.desktop.json is not valid JSON.", [{ name: "vera.desktop.json", data: "{" }]],
        ["is not a saved theme", [{ name: "vera.desktop.json", data: JSON.stringify({ id: "a", version: "1", engine: DESKTOP_ENGINE, contributes: { themes: [{ label: "T", path: "t.json" }] } }) }, { name: "t.json", data: "{}" }]],
        ["The module", [{ name: "vera.desktop.json", data: JSON.stringify({ id: "a", version: "1", engine: DESKTOP_ENGINE, main: "main.js" }) }]],
    ];
    for (const [expected, items] of cases) {
        const { reply } = run(items);
        expect(reply.ok).toBe(false);
        expect(!reply.ok && reply.reason).toContain(expected);
    }
    expect(existsSync(join(outside, "escape.json"))).toBe(false);
    expect(existsSync(join(tmpdir(), "escape.json"))).toBe(false);
});

test("a file, a folder or a link that is not a regular package is refused", () => {
    const staging = stagingFolder();
    const directory = scratchDirectory();
    expect(runInstallTask({ kind: "install", packagePath: directory, staging })).toEqual({ ok: false, reason: "The package is not a file." });
    expect(runInstallTask({ kind: "install", packagePath: join(directory, "missing.tgz"), staging })).toEqual({ ok: false, reason: "Vera could not read the package." });
    const path = join(directory, "plain.txt");
    writeFileSync(path, "not a package");
    expect(runInstallTask({ kind: "install", packagePath: path, staging })).toEqual({ ok: false, reason: "The package is not a gzip tar file." });
});

test("a package over the size cap is refused without reading it", () => {
    const path = join(scratchDirectory(), "big.tgz");
    writeFileSync(path, Buffer.alloc(MAX_PACKAGE_BYTES + 1));
    expect(statSync(path).size).toBeGreaterThan(MAX_PACKAGE_BYTES);
    expect(runInstallTask({ kind: "install", packagePath: path, staging: stagingFolder() })).toEqual({ ok: false, reason: "The package is larger than 8 MiB." });
});

test("@core the task and the reply survive structuredClone and a JSON round trip, and malformed ones are refused", () => {
    const task: InstallTask = { kind: "install", packagePath: "/tmp/a.tgz", sha256: "ab".repeat(32), staging: "/tmp/.staging-x" };
    for (const copy of [structuredClone(task), JSON.parse(JSON.stringify(task))]) expect(parseInstallTask(copy)).toEqual(task);
    const reply = { ok: true as const, preview: { id: "a", version: "1", themes: ["T"], hasMain: false, hasCommands: false, hasUnavailableContributions: false } };
    for (const copy of [structuredClone(reply), JSON.parse(JSON.stringify(reply))]) expect(parseInstallReply(copy)).toEqual(reply);
    expect(parseInstallReply({ ok: false, reason: "No." })).toEqual({ ok: false, reason: "No." });

    for (const bad of [undefined, null, "install", [], { kind: "other" }, { ...task, packagePath: "relative.tgz" }, { ...task, staging: "relative" }, { ...task, sha256: 4 }, { ...task, packagePath: 4 }]) {
        expect(parseInstallTask(bad)).toBeUndefined();
    }
    for (const bad of [undefined, null, [], {}, { ok: true }, { ok: false }, { ok: false, reason: 4 }, { ok: true, preview: { ...reply.preview, themes: [4] } }, { ok: true, preview: { ...reply.preview, hasMain: "yes" } }, { ok: true, preview: { ...reply.preview, hasUnavailableContributions: undefined } }, { ok: true, preview: { ...reply.preview, hasUnavailableContributions: "yes" } }]) {
        expect(parseInstallReply(bad)).toBeUndefined();
    }
});

test("the same package unpacks to the same files on a fresh staging folder, since the task keeps nothing", () => {
    const path = writePackage(themeFiles("crow.pack", "1.0.0", CROW));
    const first = stagingFolder();
    const second = stagingFolder();
    const one = runInstallTask(structuredClone({ kind: "install", packagePath: path, staging: first } as InstallTask));
    const two = runInstallTask(structuredClone({ kind: "install", packagePath: path, staging: second } as InstallTask));
    expect(one).toEqual(two);
    expect(readFileSync(join(first, "vera.desktop.json"), "utf8")).toBe(readFileSync(join(second, "vera.desktop.json"), "utf8"));
});
