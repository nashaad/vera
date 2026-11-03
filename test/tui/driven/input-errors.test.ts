import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiFlightEvent, TuiFlightRecorder } from "../../../clients/tui/flight-recorder.ts";
import { defaultVeraConfigPath } from "../../../src/config.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const home = () => mkdtempSync(join(tmpdir(), "vera-input-errors-"));
const pooled = [{ provider: "openrouter", model: "one/model", label: "One", available: true, verified: false, levels: [] }];

function recordingFlightRecorder(events: TuiFlightEvent[], throwOn?: string): TuiFlightRecorder {
    return {
        instanceId: "input-errors",
        logPath: "/dev/null",
        record: (event) => {
            if (event.type === throwOn) throw new Error("the crow dropped the log");
            events.push(event);
        },
        sessionEntered: () => {},
        close: () => {},
    };
}

test("a key whose handler throws shows the error in the transcript and logs it, and typing still works", async () => {
    const events: TuiFlightEvent[] = [];
    const session = await startTuiTestSession({ home: home(), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled }), flightRecorder: recordingFlightRecorder(events) }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        writeFileSync(defaultVeraConfigPath(), JSON.stringify({ schema_version: 1, provider: "kraken", model: "kraken/ink-1" }));
        session.sendKey("C-x"); session.sendText("m");
        await session.waitForVisiblePane("Switch model");
        session.sendKey("C-k");
        await session.waitForVisiblePane("Key failed: Vera config at");
        const failures = events.filter((event) => event.type === "input_handler_failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ source: "keypress", error: { name: "VeraConfigError" } });
        session.sendKey("Escape"); await session.settle();
        session.sendKey("Escape"); await session.settle();
        session.sendText("ahoy");
        await session.waitForVisiblePane("ahoy");
    } finally { await session.close(); }
}, 15_000);

test("a submit whose handler throws shows the error in the transcript and logs its source", async () => {
    const events: TuiFlightEvent[] = [];
    const session = await startTuiTestSession({ home: home(), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled }),
            flightRecorder: recordingFlightRecorder(events, "submit_requested") }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("hoist the black flag"); session.sendKey("Enter");
        await session.waitForVisiblePane("Submit failed: the crow dropped the log");
        expect(events.filter((event) => event.type === "input_handler_failed"))
            .toMatchObject([{ source: "submit", error: { message: "the crow dropped the log" } }]);
    } finally { await session.close(); }
}, 15_000);
