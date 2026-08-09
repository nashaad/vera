import { expect, test } from "bun:test";

import { renderTuiHeldAddress } from "../../clients/tui/addressing.ts";

test("no held address is an empty line", () => {
    expect(renderTuiHeldAddress(undefined)).toEqual({ facts: "", keys: "" });
    expect(renderTuiHeldAddress("   ")).toEqual({ facts: "", keys: "" });
});

test("the line names where messages go and the way back", () => {
    expect(renderTuiHeldAddress("@sidekick")).toEqual({
        facts: "every message goes to @sidekick",
        keys: "@vera goes back to the agent",
    });
});
