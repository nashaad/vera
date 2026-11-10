import { expect, test } from "bun:test";

import {
    CLIENT_CAPABILITIES,
    HOST_CAPABILITIES,
    HOST_CAPABILITY_AGENT_HISTORY_PAGING,
    HOST_CAPABILITY_SESSION_ROUTING,
    negotiateHostCapabilities,
    parseHostCapabilities,
} from "../../src/host/capabilities.ts";
import { HOST_MIN_COMPATIBLE_PROTOCOL_VERSION, HOST_PROTOCOL_VERSION } from "../../src/host/protocol.ts";

test("@core pages-only attach uses protocol 37", () => {
    expect(HOST_PROTOCOL_VERSION).toBe(37);
    expect(HOST_MIN_COMPATIBLE_PROTOCOL_VERSION).toBe(37);
});

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

test("@core every client requests history paging", () => {
    expect(HOST_CAPABILITIES).toContain(HOST_CAPABILITY_AGENT_HISTORY_PAGING);
    expect(CLIENT_CAPABILITIES).toContain(HOST_CAPABILITY_AGENT_HISTORY_PAGING);
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
