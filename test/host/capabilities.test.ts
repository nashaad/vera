import { expect, test } from "bun:test";

import {
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
