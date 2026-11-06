import { expect, test } from "bun:test";

import {
    CLIENT_CAPABILITIES,
    HOST_CAPABILITIES,
    HOST_CAPABILITY_AGENT_HISTORY_PAGING,
    HOST_CAPABILITY_SESSION_ROUTING,
    PAGING_CAPABILITIES,
    negotiateHostCapabilities,
    parseHostCapabilities,
} from "../../src/host/capabilities.ts";

test("host capabilities are bounded versioned names", () => {
    expect(parseHostCapabilities([
        "agent.branch-options.v1",
        "session.inspect.v2",
    ])).toEqual([
        "agent.branch-options.v1",
        "session.inspect.v2",
    ]);
    expect(parseHostCapabilities(["agent.branch-options.v1", "agent.branch-options.v1"]))
        .toBeUndefined();
    expect(parseHostCapabilities(["branch-options"])).toBeUndefined();
});

test("negotiation preserves request order and returns only shared capabilities", () => {
    expect(negotiateHostCapabilities(
        ["agent.future.v1", "agent.branch-options.v1"],
        ["agent.branch-options.v1"],
    )).toEqual(["agent.branch-options.v1"]);
});

test("history paging is supported but granted only when requested", () => {
    expect(HOST_CAPABILITIES).toContain(HOST_CAPABILITY_AGENT_HISTORY_PAGING);
    expect(CLIENT_CAPABILITIES).not.toContain(
        HOST_CAPABILITY_AGENT_HISTORY_PAGING,
    );
    expect(PAGING_CAPABILITIES).toContain(
        HOST_CAPABILITY_AGENT_HISTORY_PAGING,
    );
    expect(negotiateHostCapabilities(
        ["agent.attach-resume.v1"],
        HOST_CAPABILITIES,
    )).toEqual(["agent.attach-resume.v1"]);
    expect(negotiateHostCapabilities(
        [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
        HOST_CAPABILITIES,
    )).toEqual([HOST_CAPABILITY_AGENT_HISTORY_PAGING]);
});

test("session routing is a host capability every client requests", () => {
    expect(HOST_CAPABILITY_SESSION_ROUTING).toBe("host.session-routing.v1");
    expect(HOST_CAPABILITIES).toContain(HOST_CAPABILITY_SESSION_ROUTING);
    expect(CLIENT_CAPABILITIES).toContain(HOST_CAPABILITY_SESSION_ROUTING);
    expect(parseHostCapabilities([HOST_CAPABILITY_SESSION_ROUTING]))
        .toEqual([HOST_CAPABILITY_SESSION_ROUTING]);
    expect(negotiateHostCapabilities(
        [HOST_CAPABILITY_SESSION_ROUTING],
        HOST_CAPABILITIES,
    )).toEqual([HOST_CAPABILITY_SESSION_ROUTING]);
});
