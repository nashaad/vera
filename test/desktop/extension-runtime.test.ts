import { expect, test } from "bun:test";

import type { ToWorker } from "../../clients/ui/src/extensions/envelope.ts";
import {
    ExtensionRuntime,
    MAX_CONTEXT_KEYS,
    MAX_MESSAGES_PER_SECOND,
    MAX_QUEUED_RUNS,
    PING_AFTER_MS,
    PONG_WITHIN_MS,
    type ExtensionDefinition,
    type Timers,
    type WorkerLink,
} from "../../clients/ui/src/extensions/runtime.ts";
import type { ExtensionMainResult } from "../../clients/ui/src/protocol/desktop-extensions.ts";

class FakeClock implements Timers {
    time = 0;
    private nextHandle = 1;
    private readonly pending = new Map<number, { readonly at: number; readonly run: () => void }>();

    set = (run: () => void, ms: number): unknown => {
        const handle = this.nextHandle;
        this.nextHandle += 1;
        this.pending.set(handle, { at: this.time + ms, run });
        return handle;
    };

    clear = (handle: unknown): void => {
        this.pending.delete(handle as number);
    };

    now = (): number => this.time;

    get waiting(): number {
        return this.pending.size;
    }

    advance(ms: number): void {
        const target = this.time + ms;
        for (;;) {
            const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (due === undefined) break;
            this.pending.delete(due[0]);
            this.time = due[1].at;
            due[1].run();
        }
        this.time = target;
    }
}

class FakeLink implements WorkerLink {
    readonly posted: ToWorker[] = [];
    terminated = false;

    constructor(readonly receive: (data: unknown) => void) {}

    post(message: ToWorker): void {
        this.posted.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }

    types(): string[] {
        return this.posted.map((message) => message.type);
    }
}

interface Toast {
    readonly text: string;
    readonly tone: string;
}

const DEMO: ExtensionDefinition = { id: "demo", main: "main.js", commands: ["demo.one", "demo.two"] };

function setup(options: { readonly source?: () => Promise<ExtensionMainResult> } = {}) {
    const clock = new FakeClock();
    const links: FakeLink[] = [];
    const toasts: Toast[] = [];
    const logs: string[] = [];
    const context = new Map<string, string | number | boolean>();
    const reads: string[] = [];
    const runtime = new ExtensionRuntime({
        readSource: async (extensionId, main) => {
            reads.push(`${extensionId}/${main}`);
            return options.source === undefined ? { ok: true, source: "export function activate() {}" } : options.source();
        },
        createLink: (_extensionId, receive) => {
            const link = new FakeLink(receive);
            links.push(link);
            return link;
        },
        toast: (text, tone) => toasts.push({ text, tone }),
        log: (extensionId, level, text) => logs.push(`${extensionId} ${level} ${text}`),
        setContext: (key, value) => {
            if (value === undefined) context.delete(key);
            else context.set(key, value);
        },
        timers: clock,
    });
    runtime.define([DEMO]);
    const stateOf = (id = "demo") => runtime.snapshot().find((entry) => entry.extensionId === id)?.state;
    return { clock, links, toasts, logs, context, reads, runtime, stateOf };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function started(run = "demo.one") {
    const env = setup();
    env.runtime.run("demo", run);
    await tick();
    env.links[0]!.receive({ type: "loaded" });
    return env;
}

test("@core nothing starts until a command runs, then one worker loads the extension and runs it", async () => {
    const { runtime, links, reads, stateOf } = setup();
    expect(links).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(stateOf()).toBe("inactive");

    runtime.run("demo", "demo.one", { path: "a" });
    expect(stateOf()).toBe("activating");
    await tick();
    expect(reads).toEqual(["demo/main.js"]);
    expect(links).toHaveLength(1);
    expect(links[0]!.posted).toEqual([{ type: "load", source: "export function activate() {}", commands: ["demo.one", "demo.two"] }]);

    links[0]!.receive({ type: "loaded" });
    expect(stateOf()).toBe("active");
    expect(links[0]!.posted[1]).toEqual({ type: "run", call: 1, command: "demo.one", args: { path: "a" } });
    links[0]!.receive({ type: "done", call: 1 });
    runtime.run("demo", "demo.two");
    expect(links[0]!.posted[2]).toEqual({ type: "run", call: 2, command: "demo.two" });
    expect(links).toHaveLength(1);
});

test("a command the extension did not declare is refused and starts nothing", async () => {
    const { runtime, links, logs, stateOf } = setup();
    runtime.run("demo", "demo.undeclared");
    runtime.run("unknown", "unknown.one");
    await tick();
    expect(links).toHaveLength(0);
    expect(stateOf()).toBe("inactive");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("not declared");
});

test("arguments that are not plain data are refused", async () => {
    const { runtime, links, logs } = setup();
    runtime.run("demo", "demo.one", { run: () => 1 });
    await tick();
    expect(links).toHaveLength(0);
    expect(logs[0]).toContain("not plain data");
});

test("a command that throws fails with a toast and a log line, and the extension stays active", async () => {
    const { runtime, links, toasts, logs, stateOf } = await started();
    links[0]!.receive({ type: "failed", call: 1, reason: "boom" });
    expect(toasts).toEqual([{ text: "Command demo.one failed: boom", tone: "danger" }]);
    expect(logs).toContain("demo error demo.one failed: boom");
    expect(stateOf()).toBe("active");
    runtime.run("demo", "demo.two");
    expect(links[0]!.types()).toEqual(["load", "run", "run"]);
});

test("a call in flight past 3 s makes the window ping, and an answer keeps the extension active", async () => {
    const { clock, links, toasts, stateOf } = await started();
    clock.advance(PING_AFTER_MS - 1);
    expect(links[0]!.types()).toEqual(["load", "run"]);
    clock.advance(1);
    expect(links[0]!.posted[2]).toEqual({ type: "ping", n: 1 });
    clock.advance(PONG_WITHIN_MS - 1);
    links[0]!.receive({ type: "pong", n: 1 });
    // The call is still in flight, so the window checks again after another 3 s.
    clock.advance(PING_AFTER_MS);
    expect(links[0]!.posted[3]).toEqual({ type: "ping", n: 2 });
    links[0]!.receive({ type: "pong", n: 2 });
    clock.advance(PONG_WITHIN_MS);
    expect(stateOf()).toBe("active");
    expect(toasts).toHaveLength(0);
});

test("@core no answer to the ping within 3 s stops the worker and marks the extension not responding", async () => {
    const { clock, links, toasts, logs, context, stateOf } = await started();
    links[0]!.receive({ type: "context", key: "demo.armed", value: true });
    clock.advance(PING_AFTER_MS);
    clock.advance(PONG_WITHIN_MS);
    expect(stateOf()).toBe("not-responding");
    expect(toasts).toEqual([{ text: "Extension demo stopped responding and was stopped.", tone: "warning" }]);
    expect(logs.some((line) => line.includes("did not answer a ping"))).toBe(true);
    expect(links[0]!.terminated).toBe(true);
    expect(context.size).toBe(0);
    expect(clock.waiting).toBe(0);
    // A late answer from the stopped worker changes nothing.
    links[0]!.receive({ type: "pong", n: 1 });
    expect(stateOf()).toBe("not-responding");
});

test("a call that finishes in time never pings", async () => {
    const { clock, links } = await started();
    clock.advance(PING_AFTER_MS - 100);
    links[0]!.receive({ type: "done", call: 1 });
    expect(clock.waiting).toBe(0);
    clock.advance(PING_AFTER_MS * 3);
    expect(links[0]!.types()).toEqual(["load", "run"]);
});

test("a worker that hangs while activating is stopped, and its late load changes nothing", async () => {
    const { runtime, clock, links, stateOf } = setup();
    runtime.run("demo", "demo.one");
    await tick();
    clock.advance(PING_AFTER_MS + PONG_WITHIN_MS);
    expect(stateOf()).toBe("not-responding");
    expect(links[0]!.terminated).toBe(true);
    links[0]!.receive({ type: "loaded" });
    expect(stateOf()).toBe("not-responding");
    expect(links[0]!.types()).toEqual(["load", "ping"]);
});

test("@core stopping ends the worker, clears its context keys, and the next run starts a fresh worker", async () => {
    const { runtime, links, context, stateOf } = await started();
    links[0]!.receive({ type: "context", key: "demo.armed", value: true });
    expect(context.get("demo.armed")).toBe(true);
    runtime.stop("demo");
    expect(links[0]!.terminated).toBe(true);
    expect(context.size).toBe(0);
    expect(stateOf()).toBe("inactive");

    // A message from the stopped worker changes nothing.
    links[0]!.receive({ type: "context", key: "demo.armed", value: true });
    links[0]!.receive({ type: "toast", text: "late" });
    expect(context.size).toBe(0);

    runtime.run("demo", "demo.one");
    await tick();
    expect(links).toHaveLength(2);
    expect(links[1]!.types()).toEqual(["load"]);
    expect(stateOf()).toBe("activating");
});

test("running a command after a not responding stop starts a fresh worker", async () => {
    const { runtime, clock, links, stateOf } = await started();
    clock.advance(PING_AFTER_MS + PONG_WITHIN_MS);
    expect(stateOf()).toBe("not-responding");
    runtime.run("demo", "demo.two");
    await tick();
    expect(stateOf()).toBe("activating");
    expect(links).toHaveLength(2);
    links[1]!.receive({ type: "loaded" });
    expect(stateOf()).toBe("active");
    expect(links[1]!.types()).toEqual(["load", "run"]);
    // The old call is gone with the old worker, so nothing pings the new one.
    clock.advance(PING_AFTER_MS - 1);
    expect(links[1]!.types()).toEqual(["load", "run"]);
});

test("stopAll ends every worker", async () => {
    const { runtime, links } = setup();
    runtime.define([DEMO, { id: "other", main: "main.js", commands: ["other.one"] }]);
    runtime.run("demo", "demo.one");
    runtime.run("other", "other.one");
    await tick();
    runtime.stopAll();
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.terminated)).toBe(true);
    expect(runtime.snapshot().map((entry) => entry.state)).toEqual(["inactive", "inactive"]);
});

test("a main file that cannot be read fails the start with the reason, and the next run tries again", async () => {
    let answer: ExtensionMainResult = { ok: false, reason: "The file does not exist." };
    const { runtime, links, toasts, stateOf } = setup({ source: async () => answer });
    runtime.run("demo", "demo.one");
    await tick();
    expect(links).toHaveLength(0);
    expect(stateOf()).toBe("failed");
    expect(runtime.snapshot()[0]).toEqual({ extensionId: "demo", state: "failed", reason: "The file does not exist." });
    expect(toasts).toEqual([{ text: "Extension demo could not start: The file does not exist.", tone: "danger" }]);

    answer = { ok: true, source: "export function activate() {}" };
    runtime.run("demo", "demo.one");
    await tick();
    expect(links).toHaveLength(1);
    expect(stateOf()).toBe("activating");
});

test("an extension that fails to activate is failed and its worker is ended", async () => {
    const { runtime, links, toasts, stateOf } = setup();
    runtime.run("demo", "demo.one");
    await tick();
    links[0]!.receive({ type: "load-failed", reason: "The extension does not export activate()." });
    expect(stateOf()).toBe("failed");
    expect(links[0]!.terminated).toBe(true);
    expect(toasts[0]!.text).toContain("could not start");
});

test("@core an extension may set only keys that start with its own id, and the window refuses the rest", async () => {
    const { links, context, logs } = await started();
    links[0]!.receive({ type: "context", key: "demo.armed", value: true });
    links[0]!.receive({ type: "context", key: "view", value: "settings" });
    links[0]!.receive({ type: "context", key: "demo", value: true });
    links[0]!.receive({ type: "context", key: "demo.", value: true });
    links[0]!.receive({ type: "context", key: "demoer.armed", value: true });
    links[0]!.receive({ type: "context", key: "sessionBusy" });
    expect([...context.entries()]).toEqual([["demo.armed", true]]);
    expect(logs.filter((line) => line.includes("Refused context key"))).toHaveLength(5);
    links[0]!.receive({ type: "context", key: "demo.armed" });
    expect(context.size).toBe(0);
});

test("an extension may hold a bounded number of context keys", async () => {
    const { links, context, logs } = await started();
    for (let index = 0; index < MAX_CONTEXT_KEYS + 5; index += 1) links[0]!.receive({ type: "context", key: `demo.k${index}`, value: index });
    expect(context.size).toBe(MAX_CONTEXT_KEYS);
    expect(logs.filter((line) => line.includes("may set"))).toHaveLength(5);
    links[0]!.receive({ type: "context", key: "demo.k0", value: "again" });
    expect(context.get("demo.k0")).toBe("again");
});

test("toasts carry the extension id, and malformed messages are refused with a log line", async () => {
    const { links, toasts, logs } = await started();
    links[0]!.receive({ type: "toast", text: "hi", tone: "success" });
    links[0]!.receive({ type: "toast", text: "plain" });
    links[0]!.receive({ type: "toast", text: 5 });
    links[0]!.receive("toast");
    links[0]!.receive({ type: "log", level: "info", text: "one line" });
    expect(toasts).toEqual([{ text: "demo: hi", tone: "success" }, { text: "demo: plain", tone: "info" }]);
    expect(logs).toEqual([
        "demo error Refused a malformed message from the extension.",
        "demo error Refused a malformed message from the extension.",
        "demo info one line",
    ]);
});

test("messages over the rate limit are dropped, and the window opens again after a second", async () => {
    const { clock, links, toasts, logs } = await started();
    for (let index = 0; index < MAX_MESSAGES_PER_SECOND + 50; index += 1) links[0]!.receive({ type: "toast", text: "x" });
    // The `loaded` message used one of the window's slots.
    expect(toasts).toHaveLength(MAX_MESSAGES_PER_SECOND - 1);
    expect(logs.filter((line) => line.includes("Dropped messages"))).toHaveLength(1);
    clock.advance(1_000);
    links[0]!.receive({ type: "toast", text: "again" });
    expect(toasts).toHaveLength(MAX_MESSAGES_PER_SECOND);
});

test("runs queued while the worker starts are bounded", async () => {
    const { runtime, links, logs } = setup();
    for (let index = 0; index < MAX_QUEUED_RUNS + 3; index += 1) runtime.run("demo", "demo.one");
    await tick();
    links[0]!.receive({ type: "loaded" });
    expect(links[0]!.posted.filter((message) => message.type === "run")).toHaveLength(MAX_QUEUED_RUNS);
    expect(logs.filter((line) => line.includes("dropped"))).toHaveLength(3);
});

test("redefining extensions stops one whose main changed and keeps the others", async () => {
    const { runtime, links, stateOf } = setup();
    runtime.define([DEMO, { id: "other", main: "main.js", commands: ["other.one"] }]);
    runtime.run("demo", "demo.one");
    runtime.run("other", "other.one");
    await tick();
    runtime.define([{ ...DEMO, main: "next.js" }, { id: "other", main: "main.js", commands: ["other.one"] }]);
    expect(links[0]!.terminated).toBe(true);
    expect(links[1]!.terminated).toBe(false);
    expect(stateOf("demo")).toBe("inactive");
    expect(stateOf("other")).toBe("activating");
    runtime.define([]);
    expect(links[1]!.terminated).toBe(true);
    expect(runtime.snapshot()).toEqual([]);
});

test("listeners hear every state change", async () => {
    const { runtime, links } = setup();
    let heard = 0;
    runtime.subscribe(() => {
        heard += 1;
    });
    runtime.run("demo", "demo.one");
    await tick();
    links[0]!.receive({ type: "loaded" });
    runtime.stop("demo");
    expect(heard).toBeGreaterThanOrEqual(3);
});
