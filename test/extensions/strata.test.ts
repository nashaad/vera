import { expect, test } from "bun:test";

import { strataContribution } from "../../examples/extensions/strata/index.ts";

const request = {
    type: "model_request" as const,
    provider: "vera-strata",
    model: "strata",
    sessionId: "session-1",
    workspace: "/workspace",
};

test("Strata receives the active workspace and forced fan-out", () => {
    expect(strataContribution(request)).toEqual({
        corpus: { path: "/workspace" },
        force: true,
    });
});

test("the Strata contribution never leaks into another provider", () => {
    expect(strataContribution({ ...request, provider: "openrouter" }))
        .toBeUndefined();
});
