import { expect, test } from "bun:test";

import { defaultModelChangeNotice } from "../../clients/tui/main.ts";

const base = { provider: "openrouter", model: "z-ai/glm-5.2" };

test("a saved effort says new conversations will use it", () => {
    expect(defaultModelChangeNotice(
        { reasoningEffort: "xhigh" },
        { ...base, reasoningEffort: "xhigh" },
    )).toBe("Changed the reasoning effort to xhigh; new conversations will use it by default");
});

test("max says it applies to this conversation only", () => {
    expect(defaultModelChangeNotice(
        { reasoningEffort: "max" },
        { ...base, reasoningEffort: "max" },
    )).toBe("Changed the reasoning effort to max for this conversation only; new conversations keep their default");
});

test("a model switch carrying max still saves the model", () => {
    expect(defaultModelChangeNotice(
        { provider: "openrouter", model: "z-ai/glm-5.2", reasoningEffort: "max" },
        { ...base, reasoningEffort: "max" },
    )).toContain("new conversations will use the model, but max applies to this conversation only");
});
