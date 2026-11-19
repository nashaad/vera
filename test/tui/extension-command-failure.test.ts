import { expect, test } from "bun:test";

import { HostConnectionClosedError } from "../../src/host/connection.ts";
import { logDisconnectedExtensionCommandFailure } from "../../clients/tui/main/extension-bridge.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { createTuiState } from "../../clients/tui/state.ts";
import type { TuiFlightEvent } from "../../clients/tui/flight-recorder.ts";

function fixture(connectionFailed = false): {
    readonly rt: Pick<TuiRuntime, "connectionFailed" | "flightRecorder" | "state">;
    readonly events: TuiFlightEvent[];
} {
    const events: TuiFlightEvent[] = [];
    return {
        rt: {
            connectionFailed,
            flightRecorder: {
                instanceId: "test",
                logPath: "test.log",
                record: (event: TuiFlightEvent) => {
                    events.push(event);
                },
                sessionEntered: () => {},
                close: async () => {},
            },
            state: createTuiState(),
        },
        events,
    };
}

test("@core closed-host command lookup failures are logged instead of transcript errors", () => {
    const cases = [
        {
            operation: "skill_commands" as const,
            error: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
        },
        {
            operation: "extension_commands" as const,
            error: new HostConnectionClosedError(false),
        },
        {
            operation: "extension_commands" as const,
            error: new Error("Agent attachment is closed"),
        },
    ];

    for (const { operation, error } of cases) {
        const { rt, events } = fixture();
        expect(logDisconnectedExtensionCommandFailure(rt, error, operation)).toBe(true);
        expect(rt.state.entries).toEqual([]);
        expect(events).toEqual([{
            type: "extension_command_load_failed",
            operation,
            error: {
                name: error.name,
                message: error.message,
            },
        }]);
    }
});

test("command lookup failures after connection loss are logged", () => {
    const { rt, events } = fixture(true);
    const error = new Error("list request rejected");

    expect(logDisconnectedExtensionCommandFailure(
        rt,
        error,
        "skill_commands",
    )).toBe(true);
    expect(events[0]).toMatchObject({
        type: "extension_command_load_failed",
        operation: "skill_commands",
    });
    expect(rt.state.entries).toEqual([]);
});

test("connected command lookup failures are not treated as disconnects", () => {
    const { rt, events } = fixture();

    expect(logDisconnectedExtensionCommandFailure(
        rt,
        new Error("extension catalog unavailable"),
        "extension_commands",
    )).toBe(false);
    expect(events).toEqual([]);
    expect(rt.state.entries).toEqual([]);
});
