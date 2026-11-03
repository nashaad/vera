import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiFlightEvent, TuiFlightRecorder } from "../../../clients/tui/flight-recorder.ts";
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

// The keypress handler records raw input before it acts, so one armed throw fails exactly one key.
function failOnceOnKey(events: TuiFlightEvent[]): TuiFlightRecorder & { arm(): void } {
    let armed = false;
    return {
        ...recordingFlightRecorder(events),
        record: (event) => {
            if (armed && event.type === "raw_input_received") {
                armed = false;
                throw new Error("the crow dropped the log");
            }
            events.push(event);
        },
        arm: () => { armed = true; },
    };
}

test("a key whose handler throws shows the error in the transcript and logs it, and typing still works", async () => {
    const events: TuiFlightEvent[] = [];
    const recorder = failOnceOnKey(events);
    const session = await startTuiTestSession({ home: home(), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled }), flightRecorder: recorder }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        // Raw input is recorded at most every 250ms; wait past that so the armed key records.
        await session.settle(300);
        recorder.arm();
        session.sendText("x");
        await session.waitForVisiblePane("Key failed: the crow dropped the log");
        expect(events.filter((event) => event.type === "input_handler_failed"))
            .toMatchObject([{ source: "keypress", error: { message: "the crow dropped the log" } }]);
        await session.settle(300);
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
