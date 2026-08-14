import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiFlightRecorder } from "../../clients/tui/flight-recorder.ts";
import { heartbeatAge } from "../../clients/tui/flight-watchdog.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TUI flight recorder", () => {
    test("records lifecycle and redacted composer metadata", () => {
        const runtimeDirectory = mkdtempSync(join(tmpdir(), "vera-flight-"));
        roots.push(runtimeDirectory);
        const recorder = createTuiFlightRecorder({
            runtimeDirectory,
            spawnWatchdog: false,
            pid: 42,
            now: () => new Date("2026-08-14T18:10:00.000Z"),
        });
        recorder.sessionEntered("session-1");
        recorder.record({ type: "composer_changed", characters: 12 });
        recorder.close("renderer_destroyed");

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

test("heartbeat age rejects malformed timestamps", () => {
    expect(heartbeatAge("bad", 10_000)).toBeUndefined();
    expect(heartbeatAge("1970-01-01T00:00:05.000Z", 10_000)).toBe(5_000);
});
