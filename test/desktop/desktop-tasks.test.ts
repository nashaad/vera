import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { TaskLog, TaskProgress, TaskRunMessage } from "../../clients/desktop/src/tasks/messages.ts";
import { TaskRunner, type TaskProcess } from "../../clients/desktop/src/tasks/runner.ts";

const DESKTOP_SOURCE = resolve(import.meta.dir, "..", "..", "clients", "desktop", "src");
const REPOSITORY = resolve(DESKTOP_SOURCE, "..", "..", "..");

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

test("@core the main process loads no task code; each task process loads its own", () => {
    const main = reachable(join(DESKTOP_SOURCE, "main.ts"));
    expect(inDesktop(main.files, "theme-import")).toEqual(["theme-import/roots.ts", "theme-import/task-protocol.ts"]);
    expect(inDesktop(main.files, "model-assignments")).toEqual(["model-assignments/task-protocol.ts"]);
    expect(main.files).not.toContain(join(REPOSITORY, "src", "config.ts"));
    expect([...main.packages].filter((name) => name.startsWith("zod"))).toEqual([]);

    const themes = reachable(join(DESKTOP_SOURCE, "theme-import", "worker.ts"));
    for (const file of ["theme-import/import-theme.ts", "theme-import/zip.ts", "theme-import/installed.ts"]) {
        expect(inDesktop(themes.files, "theme-import")).toContain(file);
    }
    expect(themes.files).not.toContain(join(REPOSITORY, "src", "config.ts"));

    const assignments = reachable(join(DESKTOP_SOURCE, "model-assignments", "worker.ts"));
    expect(inDesktop(assignments.files, "model-assignments")).toContain("model-assignments/assignment-store.ts");
    expect(assignments.files).toContain(join(REPOSITORY, "src", "config.ts"));
    expect(inDesktop(assignments.files, "theme-import")).toEqual([]);
    for (const worker of [themes, assignments]) expect(worker.files).not.toContain(join(DESKTOP_SOURCE, "main.ts"));
});
