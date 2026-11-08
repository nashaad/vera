import { describe, expect, test } from "bun:test";

import { appendLostHostEntry, automaticReconnectAllowed } from "../../clients/tui/main/focus-switch.ts";
import { disconnectedRecoveryHint } from "../../clients/tui/main.ts";
import {
    applyStopWaitEvent,
    nextPlannedHostStop,
    type TuiStopWait,
} from "../../clients/tui/stop-wait.ts";
import type { TuiDiagnostic } from "../../clients/tui/diagnostic-severity.ts";
import { createTuiState, tuiEntryIsErrorRow, type TuiState, type TuiTranscriptEntry } from "../../clients/tui/state.ts";
import type { HostStopWaitEvent } from "../../src/host/protocol.ts";

const waiting = [{ session_id: "a1", name: "Fix parser", status: "working" as const }];

const opened: HostStopWaitEvent = { type: "host_stop_wait", kind: "stop", waiting_on: waiting };
const clearedStopped: HostStopWaitEvent = { type: "host_stop_wait_cleared", reason: "stopped" };
const clearedAbandoned: HostStopWaitEvent = {
    type: "host_stop_wait_cleared",
    reason: "abandoned",
    message: "turn resumed",
};

// Mirrors the order in watchStopWait: the fact is read against the wait before it is cleared.
function replay(events: readonly HostStopWaitEvent[]): {
    readonly plannedHostStop: boolean;
    readonly wait: TuiStopWait | undefined;
} {
    let plannedHostStop: boolean | undefined;
    let wait: TuiStopWait | undefined;
    for (const event of events) {
        plannedHostStop = nextPlannedHostStop(plannedHostStop, wait, event);
        wait = applyStopWaitEvent(wait, event);
    }
    return { plannedHostStop: plannedHostStop === true, wait };
}

function diagnosticOf(entry: TuiTranscriptEntry | undefined): TuiDiagnostic | undefined {
    return entry?.kind === "notice" ? entry.diagnostic : undefined;
}

function lostHost(state: TuiState, plannedHostStop: boolean): TuiState {
    return appendLostHostEntry(state, "Host connection closed", plannedHostStop);
}

describe("a connection loss after a planned stop", () => {
    test("shows a plain notice with the recovery hint and no error line", () => {
        const { plannedHostStop } = replay([opened, clearedStopped]);
        const state = lostHost(createTuiState(), plannedHostStop);

        expect(state.entries.some(tuiEntryIsErrorRow)).toBe(false);
        const notice = state.entries.at(-1);
        expect(notice?.kind).toBe("notice");
        expect(diagnosticOf(notice)?.severity).toBe("notice");
        expect(diagnosticOf(notice)?.message).toBe(`The host stopped. ${disconnectedRecoveryHint()}`);
    });

    test("an update wait that clears as stopped with no relaunch reads the same way", () => {
        const update: HostStopWaitEvent = {
            type: "host_stop_wait",
            kind: "update",
            target_build_id: "build-42",
            waiting_on: waiting,
        };
        const { plannedHostStop } = replay([update, clearedStopped]);
        expect(plannedHostStop).toBe(true);
    });

    test("the planned fact survives the wait clearing", () => {
        const { plannedHostStop, wait } = replay([opened, clearedStopped]);
        expect(wait).toBeUndefined();
        expect(plannedHostStop).toBe(true);
    });
});

describe("a connection loss without a planned stop", () => {
    test("with no stop wait seen, the error stays", () => {
        const { plannedHostStop } = replay([]);
        const state = lostHost(createTuiState(), plannedHostStop);

        const error = state.entries.at(-1);
        expect(error !== undefined && tuiEntryIsErrorRow(error)).toBe(true);
        expect(diagnosticOf(error)?.message).toContain("Host connection closed.");
    });

    test("a wait that clears as abandoned does not make the next loss planned", () => {
        const { plannedHostStop } = replay([opened, clearedAbandoned]);
        expect(plannedHostStop).toBe(false);
        const state = lostHost(createTuiState(), plannedHostStop);
        expect(state.entries.some(tuiEntryIsErrorRow)).toBe(true);
    });

    test("a new wait after a planned stop means the host is still running", () => {
        const { plannedHostStop } = replay([opened, clearedStopped, opened]);
        expect(plannedHostStop).toBe(false);
    });

    test("a wait still open when the connection drops is not treated as planned", () => {
        const { plannedHostStop } = replay([opened]);
        expect(plannedHostStop).toBe(false);
    });
});

describe("the automatic reconnect after a connection loss", () => {
    test("a plain planned stop makes no automatic attempt", () => {
        expect(automaticReconnectAllowed(true, undefined)).toBe(false);
        expect(automaticReconnectAllowed(true, false)).toBe(false);
    });

    test("a planned stop with a relaunch in progress still attempts", () => {
        expect(automaticReconnectAllowed(true, true)).toBe(true);
    });

    test("an unplanned drop still attempts", () => {
        expect(automaticReconnectAllowed(undefined, undefined)).toBe(true);
        expect(automaticReconnectAllowed(false, undefined)).toBe(true);
    });
});
