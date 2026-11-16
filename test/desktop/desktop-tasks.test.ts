import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { TaskLog, TaskProgress, TaskRunMessage } from "../../clients/desktop/src/tasks/messages.ts";
import { TaskRunner, type TaskProcess } from "../../clients/desktop/src/tasks/runner.ts";
import { parseDesktopManifest } from "../../clients/ui/src/extensions/manifest.ts";
import { registerExtensionCommands } from "../../clients/ui/src/extensions/commands.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import type { DesktopExtensionEntry } from "../../clients/ui/src/protocol/extensions.ts";

const DESKTOP_SOURCE = resolve(import.meta.dir, "..", "..", "clients", "desktop", "src");
const REPOSITORY = resolve(DESKTOP_SOURCE, "..", "..", "..");
const IMPORTER_FOLDER = join(REPOSITORY, "extensions", "vscode-theme-import");

interface Ping {
    readonly ping: number;
}

const parsePong = (message: unknown): { pong: number } | undefined =>
    typeof message === "object" && message !== null && typeof (message as { pong?: unknown }).pong === "number"
        ? { pong: (message as { pong: number }).pong }
        : undefined;

class FakeProcess implements TaskProcess<Ping> {
    readonly posted: TaskRunMessage<Ping>[] = [];
    kills = 0;
    private message: ((message: unknown) => void) | undefined;
    private exit: (() => void) | undefined;

    post(message: TaskRunMessage<Ping>): void {
        this.posted.push(message);
    }

    onMessage(listener: (message: unknown) => void): void {
        this.message = listener;
    }

    onExit(listener: () => void): void {
        this.exit = listener;
    }

    kill(): void {
        this.kills += 1;
    }

    answer(message: unknown): void {
        this.message?.(message);
    }

    stop(): void {
        this.exit?.();
    }
}

function fakeStarts(): { started: FakeProcess[]; start: () => TaskProcess<Ping> } {
    const started: FakeProcess[] = [];
    return {
        started,
        start: () => {
            const child = new FakeProcess();
            started.push(child);
            return child;
        },
    };
}

const result = (pong: unknown): unknown => ({ type: "result", reply: { pong } });

async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

test("@core each task gets its own process, which is stopped once it answers", async () => {
    const { started, start } = fakeStarts();
    const tasks = new TaskRunner(start, parsePong);
    expect(started).toHaveLength(0);
    const pending = tasks.run({ ping: 1 });
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0]?.posted).toEqual([{ type: "run", task: { ping: 1 } }]);
    started[0]?.answer(result(1));
    expect(await pending).toEqual({ pong: 1 });
    expect(started[0]?.kills).toBe(1);
    const second = tasks.run({ ping: 2 });
    await settle();
    started[1]?.answer(result(2));
    await second;
    expect(started).toHaveLength(2);
});

test("@core a process that exits, answers badly or takes too long is stopped and the request fails", async () => {
    const { started, start } = fakeStarts();
    const tasks = new TaskRunner(start, parsePong, 30);
    const exited = tasks.run({ ping: 1 });
    await settle();
    started[0]?.stop();
    await expect(exited).rejects.toThrow("stopped without answering");
    const garbled = tasks.run({ ping: 2 });
    await settle();
    started[1]?.answer(result("two"));
    await expect(garbled).rejects.toThrow("could not be read");
    await expect(tasks.run({ ping: 3 })).rejects.toThrow("did not answer in time");
    expect(started.map((child) => child.kills)).toEqual([1, 1, 1]);
});

test("@core tasks run one at a time", async () => {
    const { started, start } = fakeStarts();
    const tasks = new TaskRunner(start, parsePong);
    const first = tasks.run({ ping: 1 });
    const second = tasks.run({ ping: 2 });
    await settle();
    expect(started).toHaveLength(1);
    started[0]?.stop();
    await expect(first).rejects.toThrow();
    await settle();
    expect(started).toHaveLength(2);
    started[1]?.answer(result(2));
    expect(await second).toEqual({ pong: 2 });
});

test("@core progress and log lines reach the listeners in order before the answer", async () => {
    const { started, start } = fakeStarts();
    const tasks = new TaskRunner(start, parsePong);
    const seen: string[] = [];
    const pending = tasks.run(
        { ping: 1 },
        {
            onProgress: (progress: TaskProgress) => seen.push(`progress ${progress.message ?? "-"} ${progress.increment ?? "-"}`),
            onLog: (log: TaskLog) => seen.push(`log ${log.level} ${log.text}`),
        },
    );
    await settle();
    const child = started[0];
    child?.answer({ type: "progress", message: "reading", increment: 10 });
    child?.answer({ type: "log", level: "warn", text: "slow disk" });
    child?.answer({ type: "progress", increment: 40 });
    child?.answer({ type: "progress" });
    expect(seen).toEqual(["progress reading 10", "log warn slow disk", "progress - 40", "progress - -"]);
    child?.answer(result(7));
    expect(await pending).toEqual({ pong: 7 });
});

test("@core a task is stopped at its answer and later messages are ignored", async () => {
    const { started, start } = fakeStarts();
    const tasks = new TaskRunner(start, parsePong);
    const seen: string[] = [];
    const pending = tasks.run({ ping: 1 }, { onLog: (log) => seen.push(log.text), onProgress: () => seen.push("progress") });
    await settle();
    const child = started[0];
    child?.answer(result(1));
    child?.answer({ type: "log", level: "info", text: "too late" });
    child?.answer({ type: "progress", message: "too late" });
    child?.answer("not an envelope");
    child?.stop();
    expect(await pending).toEqual({ pong: 1 });
    expect(seen).toEqual([]);
    expect(child?.kills).toBe(1);
});

test("@core a message that is not a task output fails the request", async () => {
    const malformed: unknown[] = [
        undefined,
        null,
        "result",
        { pong: 1 },
        { type: "run", task: {} },
        { type: "progress", message: 3 },
        { type: "progress", increment: "5" },
        { type: "progress", increment: Number.NaN },
        { type: "progress", increment: -1 },
        { type: "log", level: "debug", text: "x" },
        { type: "log", level: "info" },
        { type: "result" },
        { type: "result", reply: { pong: "one" } },
    ];
    for (const message of malformed) {
        const { started, start } = fakeStarts();
        const pending = new TaskRunner(start, parsePong).run({ ping: 1 });
        await settle();
        started[0]?.answer(message);
        await expect(pending).rejects.toThrow("could not be read");
        expect(started[0]?.kills).toBe(1);
    }
});

test("a listener that throws does not fail the task", async () => {
    const { started, start } = fakeStarts();
    const pending = new TaskRunner(start, parsePong).run(
        { ping: 1 },
        {
            onProgress: () => {
                throw new Error("listener failed");
            },
        },
    );
    await settle();
    started[0]?.answer({ type: "progress", message: "x" });
    started[0]?.answer(result(1));
    expect(await pending).toEqual({ pong: 1 });
});

test("a run message that cannot be posted fails the request and stops the process", async () => {
    const child = new FakeProcess();
    child.post = () => {
        throw new Error("could not be cloned");
    };
    await expect(new TaskRunner(() => child, parsePong).run({ ping: 1 })).rejects.toThrow("could not be cloned");
    expect(child.kills).toBe(1);
});

test("@core a task that is still reporting when time runs out is stopped", async () => {
    const { started, start } = fakeStarts();
    const pending = new TaskRunner(start, parsePong, 30).run({ ping: 1 });
    await settle();
    started[0]?.answer({ type: "progress", message: "still going" });
    await expect(pending).rejects.toThrow("did not answer in time");
    expect(started[0]?.kills).toBe(1);
});

test("a process that cannot start fails its request, and the next task still runs", async () => {
    let attempts = 0;
    const child = new FakeProcess();
    const tasks = new TaskRunner(() => {
        attempts += 1;
        if (attempts === 1) throw new Error("no task file");
        return child;
    }, parsePong);
    await expect(tasks.run({ ping: 1 })).rejects.toThrow("no task file");
    const next = tasks.run({ ping: 2 });
    await settle();
    child.answer(result(2));
    expect(await next).toEqual({ pong: 2 });
});

interface Reached {
    readonly files: Set<string>;
    readonly packages: Set<string>;
}

// Type-only imports drop out of the scan, as they do from the bundle.
function reachable(entry: string): Reached {
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.pop();
        if (file === undefined || files.has(file)) continue;
        files.add(file);
        for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
            if (!path.startsWith(".")) {
                packages.add(path);
                continue;
            }
            const target = resolve(dirname(file), path);
            if (target.startsWith(REPOSITORY) && /\.tsx?$/.test(target)) queue.push(target);
        }
    }
    return { files, packages };
}

function inDesktop(files: Set<string>, folder: string): string[] {
    return [...files].map((file) => relative(DESKTOP_SOURCE, file)).filter((file) => file.startsWith(`${folder}/`)).sort();
}

function inImporter(files: Set<string>): string[] {
    return [...files].map((file) => relative(IMPORTER_FOLDER, file)).filter((file) => !file.startsWith("..")).sort();
}

test("@core the main process loads no task code; each task process loads its own", () => {
    const main = reachable(join(DESKTOP_SOURCE, "main.ts"));
    expect(inDesktop(main.files, "extension-commands")).toEqual(["extension-commands/page-result.ts", "extension-commands/page.ts", "extension-commands/service.ts", "extension-commands/task-protocol.ts"]);
    expect(inImporter(main.files)).toEqual([]);
    expect(inDesktop(main.files, "model-assignments")).toEqual(["model-assignments/task-protocol.ts"]);
    expect(inDesktop(main.files, "extension-install")).toEqual(["extension-install/task-protocol.ts"]);
    expect(inDesktop(main.files, "extension-catalog")).toEqual(["extension-catalog/task-protocol.ts"]);
    expect(main.files).not.toContain(join(REPOSITORY, "src", "config.ts"));
    expect([...main.packages].filter((name) => name.startsWith("zod"))).toEqual([]);

    const themes = reachable(join(IMPORTER_FOLDER, "theme-import.ts"));
    for (const file of ["import-theme.ts", "zip.ts", "installed.ts", "run-task.ts"]) expect(inImporter(themes.files)).toContain(file);
    expect(inDesktop(themes.files, "extension-commands")).toEqual(["extension-commands/task-protocol.ts"]);
    expect(themes.files).not.toContain(join(REPOSITORY, "src", "config.ts"));
    expect(themes.packages.has("electron")).toBe(false);

    const assignments = reachable(join(DESKTOP_SOURCE, "model-assignments", "worker.ts"));
    expect(inDesktop(assignments.files, "model-assignments")).toContain("model-assignments/assignment-store.ts");
    expect(assignments.files).toContain(join(REPOSITORY, "src", "config.ts"));
    expect(inImporter(assignments.files)).toEqual([]);

    const install = reachable(join(DESKTOP_SOURCE, "extension-install", "worker.ts"));
    for (const file of ["extension-install/run-task.ts", "extension-install/tar.ts", "extension-install/unpack.ts"]) {
        expect(inDesktop(install.files, "extension-install")).toContain(file);
    }
    expect(inImporter(install.files)).toEqual([]);
    expect(inDesktop(themes.files, "extension-install")).toEqual([]);
    expect(install.files).not.toContain(join(REPOSITORY, "src", "config.ts"));
    expect(install.packages.has("electron")).toBe(false);

    const catalog = reachable(join(DESKTOP_SOURCE, "extension-catalog", "worker.ts"));
    for (const file of ["extension-catalog/fetch.ts", "extension-catalog/parse-catalog.ts", "extension-catalog/run-task.ts"]) {
        expect(inDesktop(catalog.files, "extension-catalog")).toContain(file);
    }
    expect(inDesktop(catalog.files, "extension-install")).toEqual([]);
    expect(inDesktop(install.files, "extension-catalog")).toEqual([]);
    expect(inImporter(catalog.files)).toEqual([]);
    expect(catalog.files).not.toContain(join(REPOSITORY, "src", "config.ts"));
    expect(catalog.packages.has("electron")).toBe(false);
    for (const worker of [themes, assignments, install, catalog]) expect(worker.files).not.toContain(join(DESKTOP_SOURCE, "main.ts"));
});

function sourcesUnder(directory: string): string[] {
    return [...new Bun.Glob("**/*.{ts,tsx,mjs}").scanSync({ cwd: directory })].map((file) => join(directory, file));
}

test("@core the shell and the window never name the importer, and the build names only its folder", () => {
    const names = [/vscode-theme-import/, /theme-import\.cjs/, /Vera Theme Import/];
    const core = [...sourcesUnder(DESKTOP_SOURCE), ...sourcesUnder(join(REPOSITORY, "clients", "ui", "src"))];
    expect(core.length).toBeGreaterThan(100);
    for (const file of core) for (const name of names) expect(name.test(readFileSync(file, "utf8")), `${relative(REPOSITORY, file)} ${name}`).toBe(false);
    const build = readFileSync(join(REPOSITORY, "clients", "desktop", "build.ts"), "utf8");
    expect(build.match(/vscode-theme-import/g)).toHaveLength(1);
    for (const name of [/vera\.vscode-theme-import/, /theme-import\.cjs/, /Vera Theme Import/]) expect(name.test(build)).toBe(false);
});

test("@core the importer extension's manifest is valid, names its task and its worker source, and registers the commands the window shows", () => {
    const text = readFileSync(join(IMPORTER_FOLDER, "vera.desktop.json"), "utf8");
    const parsed = parseDesktopManifest(JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.reason);
    const manifest = parsed.manifest;
    expect(manifest.id).toBe("vera.vscode-theme-import");
    expect(manifest.tasks).toEqual([{ id: "import", title: "Vera Theme Import", main: "theme-import.cjs" }]);
    expect(manifest.main).toBeUndefined();
    expect(readFileSync(join(IMPORTER_FOLDER, "theme-import.ts"), "utf8")).toContain("serveOneTask(");
    expect(manifest.commands).toEqual([
        {
            command: "vera.vscode-theme-import.import",
            title: "Import VS Code Theme…",
            category: "Theme",
            task: "import",
            file: { label: "VS Code themes", extensions: ["json", "jsonc", "vsix"] },
        },
        { command: "vera.vscode-theme-import.installed", title: "Import Theme Installed in VS Code…", category: "Theme", task: "import" },
    ]);
    expect(manifest.menus).toEqual({
        appearance: [
            {
                command: "vera.vscode-theme-import.import",
                title: "Import a VS Code theme",
                description: "Choose a theme .json file or a .vsix extension package. Colors carry over; fonts, sizes and spacing stay Vera's.",
                button: "Import…",
            },
            {
                command: "vera.vscode-theme-import.installed",
                title: "Installed in VS Code",
                description: "Themes from the extensions installed in VS Code on this machine.",
                button: "Show themes",
            },
        ],
        theme: [{ command: "vera.vscode-theme-import.import" }],
        browser: [],
    });

    const entry: DesktopExtensionEntry = {
        id: manifest.id,
        version: manifest.version,
        themes: [],
        hasMain: true,
        hasCommands: true,
        commands: manifest.commands.map((command) => ({ id: command.command, title: command.title, ...(command.category === undefined ? {} : { category: command.category }) })),
        menus: { appearance: [], theme: [], browser: [] },
        included: true,
        enabled: true,
    };
    const registry = new CommandRegistry();
    registerExtensionCommands(registry, [entry], () => {});
    expect(registry.list().map((registered) => registered.title)).toEqual(["Theme: Import VS Code Theme…", "Theme: Import Theme Installed in VS Code…"]);
});
