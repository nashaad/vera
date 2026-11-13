import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskLog, TaskProgress } from "../../clients/desktop/src/tasks/messages.ts";
import { TaskRunner } from "../../clients/desktop/src/tasks/runner.ts";
import { startStdioTaskProcess } from "../../clients/desktop/src/tasks/stdio-process.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "stdio-task.sh");
const scratch = mkdtempSync(join(tmpdir(), "vera-stdio-task-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The fixtures are POSIX sh scripts.
const posix = process.platform === "win32" ? test.skip : test;

interface Ping {
    readonly ping: number;
}

const parsePong = (message: unknown): { pong: number } | undefined =>
    typeof message === "object" && message !== null && typeof (message as { pong?: unknown }).pong === "number"
        ? { pong: (message as { pong: number }).pong }
        : undefined;

let counter = 0;

interface Trial {
    readonly record: string;
    readonly runner: TaskRunner<Ping, { pong: number }>;
    readonly progress: TaskProgress[];
    readonly logs: TaskLog[];
    readonly listeners: { onProgress(p: TaskProgress): void; onLog(l: TaskLog): void };
    pid(): number | undefined;
}

function trial(mode: string, timeoutMs?: number): Trial {
    counter += 1;
    const record = join(scratch, `record-${counter}`);
    const progress: TaskProgress[] = [];
    const logs: TaskLog[] = [];
    return {
        record,
        // A short grace keeps the SIGKILL case fast; the polite stop is still tried first.
        runner: new TaskRunner<Ping, { pong: number }>(
            () => startStdioTaskProcess("sh", [FIXTURE, mode, record], { killGraceMs: 100 }),
            parsePong,
            timeoutMs,
        ),
        progress,
        logs,
        listeners: { onProgress: (p) => progress.push(p), onLog: (l) => logs.push(l) },
        pid: () => {
            const text = logs.find((log) => /^pid \d+$/.test(log.text))?.text;
            return text === undefined ? undefined : Number(text.slice(4));
        },
    };
}

async function until(condition: () => boolean, what: string, limitMs = 5000): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await Bun.sleep(10);
    }
}

// Signal 0 only tests whether the pid exists; it is never sent to a process this file did not start.
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

posix("@core a non-JS task answers over stdin and stdout, with progress and logs first", async () => {
    const t = trial("answer");
    const reply = await t.runner.run({ ping: 1 }, t.listeners);
    expect(reply).toEqual({ pong: 1 });
    expect(readFileSync(t.record, "utf8")).toBe('{"type":"run","task":{"ping":1}}\n');
    expect(t.logs.map((log) => `${log.level} ${log.text.replace(/\d+$/, "N")}`)).toEqual(["info pid N", "warn careful"]);
    expect(t.progress).toEqual([{ message: "halfway", increment: 50 }]);
    await until(() => t.pid() !== undefined && !alive(t.pid() as number), "the task to exit");
});

posix("@core the task exits when stdin reaches end-of-file, with SIGTERM ignored", async () => {
    const t = trial("answer-ignoring-term");
    expect(await t.runner.run({ ping: 1 }, t.listeners)).toEqual({ pong: 1 });
    await until(() => existsSync(`${t.record}.eof`), "the task to see end-of-file");
    await until(() => !alive(t.pid() as number), "the task to exit");
});

posix("stdin stays open while the task runs and closes when the process is stopped", async () => {
    counter += 1;
    const record = join(scratch, `record-${counter}`);
    const child = startStdioTaskProcess<Ping>("sh", [FIXTURE, "silent", record], { killGraceMs: 10_000 });
    let pid: number | undefined;
    let exited = false;
    child.onMessage((message) => {
        const text = (message as { text?: string }).text ?? "";
        if (/^pid \d+$/.test(text)) pid = Number(text.slice(4));
    });
    child.onExit(() => {
        exited = true;
    });
    child.post({ type: "run", task: { ping: 1 } });
    await until(() => pid !== undefined, "the task to start");
    await Bun.sleep(300);
    expect(exited).toBe(false);
    expect(existsSync(`${record}.eof`)).toBe(false);
    expect(alive(pid as number)).toBe(true);
    child.kill();
    await until(() => exited, "the exit");
    expect(existsSync(`${record}.eof`)).toBe(true);
    expect(alive(pid as number)).toBe(false);
});

posix("@core a task that never answers is stopped at the timeout and leaves no process", async () => {
    const t = trial("silent", 300);
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task did not answer in time.");
    await until(() => !alive(t.pid() as number), "the process to be gone");
});

posix("@core a task that ignores SIGTERM and stdin is killed", async () => {
    const t = trial("stubborn", 300);
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task did not answer in time.");
    await until(() => !alive(t.pid() as number), "the process to be killed");
});

posix("@core a task that exits without answering fails the request", async () => {
    const t = trial("exit");
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task stopped without answering.");
});

posix("a command that cannot be started fails the request", async () => {
    const runner = new TaskRunner<Ping, { pong: number }>(
        () => startStdioTaskProcess("vera-no-such-command-anywhere", []),
        parsePong,
    );
    await expect(runner.run({ ping: 1 })).rejects.toThrow("The task stopped without answering.");
});

posix("@core output that is not JSON fails the request and stops the task", async () => {
    const t = trial("garbage");
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task sent an answer that could not be read.");
    await until(() => !alive(t.pid() as number), "the process to be gone");
});

posix("@core a line over 1 MiB fails the request and stops the task", async () => {
    const t = trial("oversized");
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task sent an answer that could not be read.");
    expect(t.logs.map((log) => log.text.length).filter((length) => length > 1024)).toEqual([]);
    await until(() => !alive(t.pid() as number), "the process to be gone");
});

posix("@core output with no line break is refused instead of buffered", async () => {
    const t = trial("unterminated-flood", 10_000);
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task sent an answer that could not be read.");
    await until(() => !alive(t.pid() as number), "the process to be gone");
});

posix("@core stderr becomes error log lines, including a last line with no line break", async () => {
    const t = trial("stderr");
    await expect(t.runner.run({ ping: 1 }, t.listeners)).rejects.toThrow("The task stopped without answering.");
    expect(t.logs.slice(1)).toEqual([
        { level: "error", text: "first complaint" },
        { level: "error", text: "second complaint" },
        { level: "error", text: "no newline at the end" },
    ]);
});

posix("@core stderr is drained, so a task that writes 4 MB to it still answers", async () => {
    const t = trial("stderr-flood");
    expect(await t.runner.run({ ping: 1 }, t.listeners)).toEqual({ pong: 1 });
    const errors = t.logs.filter((log) => log.level === "error");
    for (const log of errors) expect(log.text.length).toBeLessThanOrEqual(64 * 1024);
});

posix("@core UTF-8 text survives the pipe", async () => {
    const t = trial("multibyte");
    expect(await t.runner.run({ ping: 1 }, t.listeners)).toEqual({ pong: 1 });
    expect(t.logs.map((log) => log.text)).toContain("héllo € \u{1f642}");
});
