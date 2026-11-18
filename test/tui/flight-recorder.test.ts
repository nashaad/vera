import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiFlightRecorder } from "../../clients/tui/flight-recorder.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TUI flight recorder", () => {
    test("records lifecycle and redacted composer metadata", async () => {
        const runtimeDirectory = mkdtempSync(join(tmpdir(), "vera-flight-"));
        roots.push(runtimeDirectory);
        const recorder = createTuiFlightRecorder({
            runtimeDirectory,
            pid: 42,
            now: () => new Date("2026-08-14T18:10:00.000Z"),
        });
        recorder.sessionEntered("session-1");
        recorder.record({ type: "composer_changed", characters: 12 });
        await recorder.close("renderer_destroyed");

        const entries = readFileSync(recorder.logPath, "utf8")
            .trim().split("\n").map((line) => JSON.parse(line));
        expect(entries.map((entry) => entry.type)).toEqual([
            "client_started",
            "session_attached",
            "composer_changed",
            "client_exited",
        ]);
        expect(entries[2]).toMatchObject({
            pid: 42,
            sessionId: "session-1",
            characters: 12,
        });
        expect(JSON.stringify(entries)).not.toContain("message text");
    });
});

test("records event loop stalls with memory use", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "vera-flight-"));
    roots.push(runtimeDirectory);
    const recorder = createTuiFlightRecorder({
        runtimeDirectory,
        heartbeatIntervalMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const until = Date.now() + 600;
    while (Date.now() < until) {
        // Busy-wait to freeze the event loop.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await recorder.close("renderer_destroyed");

    const stalls = readFileSync(recorder.logPath, "utf8")
        .trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "event_loop_stalled");
    expect(stalls).toHaveLength(1);
    expect(stalls[0].stalledMs).toBeGreaterThanOrEqual(500);
    expect(stalls[0].rssBytes).toBeGreaterThan(0);
    expect(stalls[0].heapUsedBytes).toBeGreaterThan(0);
});

test("@core recorder shutdown flushes once and is idempotent", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "vera-flight-"));
    roots.push(runtimeDirectory);
    const recorder = createTuiFlightRecorder({ runtimeDirectory });
    const shutdown = recorder.close("relaunch");
    expect(recorder.close("second_close")).toBe(shutdown);
    await shutdown;
    const entries = readFileSync(recorder.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.type === "client_exited")).toEqual([
        expect.objectContaining({ reason: "relaunch" }),
    ]);
});
