import { expect, test } from "bun:test";

import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";
import { describeEvent, OutputLog } from "../../clients/ui/src/state/outputLog.ts";

test("@core the log keeps only the newest entries up to its cap", () => {
    const log = new OutputLog(3, () => 7);
    for (const text of ["a", "b", "c", "d", "e"]) log.append("info", text);
    expect(log.snapshot().map((entry) => entry.text)).toEqual(["c", "d", "e"]);
    expect(log.snapshot()[0]?.time).toBe(7);
});

test("a repeated line is not logged twice in a row", () => {
    const log = new OutputLog();
    log.append("info", "same");
    log.append("info", "same");
    log.append("warning", "same");
    log.append("info", "same");
    expect(log.snapshot().map((entry) => entry.kind)).toEqual(["info", "warning", "info"]);
});

test("a very long line is cut", () => {
    const log = new OutputLog();
    log.append("error", "x".repeat(5_000));
    expect(log.snapshot()[0]?.text.length).toBeLessThan(2_100);
});

test("the snapshot is the same array until the log changes, and subscribers hear each change once", () => {
    const log = new OutputLog();
    let heard = 0;
    const unsubscribe = log.subscribe(() => {
        heard += 1;
    });
    const empty = log.snapshot();
    expect(log.snapshot()).toBe(empty);
    log.clear();
    expect(heard).toBe(0);
    log.append("info", "one");
    expect(log.snapshot()).not.toBe(empty);
    log.append("info", "one");
    expect(heard).toBe(1);
    log.clear();
    expect(log.snapshot()).toEqual([]);
    expect(heard).toBe(2);
    unsubscribe();
    log.append("info", "two");
    expect(heard).toBe(2);
});

test("connection events become log lines; frames and layout commands do not", () => {
    const events: DesktopEvent[] = [
        { type: "phase", phase: "starting" },
        { type: "ready", socketPath: "/s", pid: 12, buildId: "abcdef0123", home: "/h" },
        { type: "question", id: "q", text: "Replace the host?" },
        { type: "disconnected", reason: "The host is not running." },
        { type: "failed", message: "boom" },
        { type: "missing_cli", message: "No Vera at /x" },
        { type: "frame", text: "{}\n" },
        { type: "command", id: "layout.togglePanel" },
    ] as DesktopEvent[];
    const lines = events.map((event) => describeEvent(event));
    expect(lines.map((line) => line?.kind)).toEqual(["info", "info", "warning", "warning", "error", "error", undefined, undefined]);
    expect(lines[1]?.text).toBe("Attached to host 12, build abcdef0, home /h.");
    expect(lines[3]?.text).toBe("Connection lost: The host is not running.");
});
