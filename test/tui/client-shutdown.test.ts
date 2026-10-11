import { expect, test } from "bun:test";

import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";
import type { TuiFlightEvent } from "../../clients/tui/flight-recorder.ts";
import { stopClientForShutdown } from "../../clients/tui/main/focus-switch.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE } from "../../src/host/capabilities.ts";

interface FakeShutdownClient {
    readonly client: TuiAgentClient;
    readonly calls: string[];
}

function fakeClient(release: () => Promise<unknown>): FakeShutdownClient {
    const calls: string[] = [];
    const client = {
        agentId: "crow-1",
        supportsHostCapability: (capability: string) =>
            capability === HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
        release: () => {
            calls.push("release");
            return release();
        },
        detach: async () => {
            calls.push("detach");
        },
        close: () => {
            calls.push("close");
        },
    } as unknown as TuiAgentClient;
    return { client, calls };
}

function runtime(events: TuiFlightEvent[]): TuiRuntime {
    return {
        dependencies: { shutdownTimeoutMs: 20 },
        flightRecorder: { record: (event: TuiFlightEvent) => events.push(event) },
    } as unknown as TuiRuntime;
}

test("quitting releases then detaches when the host answers", async () => {
    const events: TuiFlightEvent[] = [];
    const fake = fakeClient(async () => ({ outcome: "stopped" }));

    await stopClientForShutdown(runtime(events), fake.client);

    expect(fake.calls).toEqual(["release", "detach"]);
    expect(events).toEqual([]);
});

test("quitting closes the attachment when the host never answers the release", async () => {
    const events: TuiFlightEvent[] = [];
    const fake = fakeClient(() => new Promise(() => {}));

    await stopClientForShutdown(runtime(events), fake.client);

    expect(fake.calls).toEqual(["release", "close"]);
    expect(events).toEqual([
        { type: "client_shutdown_timed_out", agentId: "crow-1" },
    ]);
});
