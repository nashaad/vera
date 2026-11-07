import { expect, test } from "bun:test";

import {
    lostHostRestartFailure,
    lostHostRestartPlan,
    type LostHostRestartInput,
} from "../../clients/tui/main/restart-lost-host.ts";

const lost: LostHostRestartInput = {
    connectionFailed: true,
    sessionSwitchPending: false,
    agentId: "agent-1",
    relaunchAvailable: false,
    installedBuildId: undefined,
    clientBuildId: "build-a",
    reconnectAvailable: true,
};

test("the key does nothing while the host is connected", () => {
    expect(lostHostRestartPlan({ ...lost, connectionFailed: false })).toEqual({ kind: "none" });
});

test("the key does nothing while a session switch is pending", () => {
    expect(lostHostRestartPlan({ ...lost, sessionSwitchPending: true })).toEqual({ kind: "none" });
});

test("the key does nothing without a conversation to reopen", () => {
    expect(lostHostRestartPlan({ ...lost, agentId: undefined })).toEqual({ kind: "none" });
});

test("a lost host with no launcher reattaches through Reconnect host", () => {
    expect(lostHostRestartPlan(lost)).toEqual({ kind: "reconnect" });
});

test("a build change under a launcher relaunches into the installed build", () => {
    expect(lostHostRestartPlan({
        ...lost,
        relaunchAvailable: true,
        installedBuildId: "build-b",
    })).toEqual({ kind: "relaunch" });
});

test("the same build under a launcher reattaches instead of relaunching", () => {
    expect(lostHostRestartPlan({
        ...lost,
        relaunchAvailable: true,
        installedBuildId: "build-a",
    })).toEqual({ kind: "reconnect" });
});

test("a build change without a launcher does not relaunch", () => {
    expect(lostHostRestartPlan({
        ...lost,
        relaunchAvailable: false,
        installedBuildId: "build-b",
    })).toEqual({ kind: "reconnect" });
});

test("a client that cannot reach a host reports the restart as unavailable", () => {
    expect(lostHostRestartPlan({ ...lost, reconnectAvailable: false })).toEqual({ kind: "unavailable" });
});

test("a failed restart names the command that resumes this conversation", () => {
    const text = lostHostRestartFailure("socket refused", "agent-1");
    expect(text).toContain("Could not restart the host: socket refused");
    expect(text).toContain("vera resume agent-1");
    expect(text).toContain("Could not restart the host: socket refused. To continue");
});
