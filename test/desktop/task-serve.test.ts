import { afterEach, expect, test } from "bun:test";

import { serveOneTask } from "../../clients/desktop/src/tasks/serve.ts";

type Listener = (event: { data: unknown }) => void;

interface FakePort {
    readonly sent: unknown[];
    deliver(data: unknown): void;
}

const realPort = (process as { parentPort?: unknown }).parentPort;
const realExit = process.exit;

afterEach(() => {
    (process as { parentPort?: unknown }).parentPort = realPort;
    process.exit = realExit;
});

function installPort(): FakePort {
    let listener: Listener | undefined;
    const sent: unknown[] = [];
    (process as { parentPort?: unknown }).parentPort = {
        on: (_event: string, handler: Listener) => {
            listener = handler;
        },
        postMessage: (message: unknown) => {
            sent.push(structuredClone(message));
        },
    };
    return {
        sent,
        deliver: (data) => listener?.({ data }),
    };
}

function trapExit(): number[] {
    const codes: number[] = [];
    process.exit = ((code?: number) => {
        codes.push(code ?? 0);
        throw new Error("exit");
    }) as typeof process.exit;
    return codes;
}

const parseLine = (value: unknown): { n: number } | undefined =>
    typeof value === "object" && value !== null && typeof (value as { n?: unknown }).n === "number" ? { n: (value as { n: number }).n } : undefined;

test("@core serveOneTask posts progress and log messages, then the result", async () => {
    const port = installPort();
    serveOneTask(parseLine, async (task, report) => {
        report.progress("start", 10);
        report.log("info", "working");
        report.progress(undefined, Number.NaN);
        report.progress("done");
        return { doubled: task.n * 2 };
    });
    port.deliver({ type: "run", task: { n: 21 } });
    await Bun.sleep(10);
    expect(port.sent).toEqual([
        { type: "progress", message: "start", increment: 10 },
        { type: "log", level: "info", text: "working" },
        { type: "progress" },
        { type: "progress", message: "done" },
        { type: "result", reply: { doubled: 42 } },
    ]);
});

test("@core serveOneTask refuses a message that is not a run message or whose task is malformed", () => {
    for (const data of [{ n: 1 }, { type: "run" }, { type: "run", task: { n: "one" } }, "run"]) {
        const port = installPort();
        const codes = trapExit();
        serveOneTask(parseLine, () => ({}));
        expect(() => port.deliver(data)).toThrow("exit");
        expect(codes).toEqual([1]);
        expect(port.sent).toEqual([]);
    }
});

test("@core a cancel message after the run message reaches the task once, and the task still answers", async () => {
    const port = installPort();
    let cancels = 0;
    serveOneTask(parseLine, async (task, report) => {
        report.onCancel(() => {
            cancels += 1;
        });
        await Bun.sleep(20);
        return { n: task.n };
    });
    port.deliver({ type: "run", task: { n: 5 } });
    port.deliver({ type: "cancel" });
    port.deliver({ type: "cancel" });
    port.deliver({ n: 9 });
    await Bun.sleep(40);
    expect(cancels).toBe(1);
    expect(port.sent).toEqual([{ type: "result", reply: { n: 5 } }]);
});

test("@core a task that asks after the cancel arrived is told at once, and a task that never asks is not disturbed", async () => {
    const port = installPort();
    let told = false;
    serveOneTask(parseLine, async (task, report) => {
        await Bun.sleep(10);
        report.onCancel(() => {
            told = true;
        });
        return { n: task.n };
    });
    port.deliver({ type: "run", task: { n: 1 } });
    port.deliver({ type: "cancel" });
    await Bun.sleep(30);
    expect(told).toBe(true);

    const quiet = installPort();
    serveOneTask(parseLine, (task) => ({ n: task.n }));
    quiet.deliver({ type: "run", task: { n: 2 } });
    quiet.deliver({ type: "cancel" });
    await Bun.sleep(10);
    expect(quiet.sent).toEqual([{ type: "result", reply: { n: 2 } }]);
});

test("@core a cancel message as the first message is refused like any other message that is not a run", () => {
    const port = installPort();
    const codes = trapExit();
    serveOneTask(parseLine, () => ({}));
    expect(() => port.deliver({ type: "cancel" })).toThrow("exit");
    expect(codes).toEqual([1]);
});
