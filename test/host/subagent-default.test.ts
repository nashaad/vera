import { expect, test } from "bun:test";

import { subagentDefaultOf } from "../../src/host/agent-registry/helpers.ts";

const crowsNest = { provider: "openrouter", model: "openai/gpt-5.6-luna" };
const galley = { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "low" as const };

test("names the first assigned model, not the legacy subagent block", () => {
    expect(subagentDefaultOf(
        { assigned: [crowsNest, galley] },
        { provider: "deepseek", model: "deepseek-chat" },
    )).toEqual({ mode: "fixed", ...crowsNest });
});

test("the legacy block picks among assigned models", () => {
    expect(subagentDefaultOf(
        { assigned: [crowsNest, galley] },
        { model: "gpt-5.6-sol" },
    )).toEqual({ mode: "fixed", ...galley });
});

test("with nothing assigned, a spawn inherits only when self is allowed", () => {
    expect(subagentDefaultOf({ allowSelf: true }, undefined)).toEqual({ mode: "inherit" });
    expect(subagentDefaultOf({}, galley)).toEqual({ mode: "none" });
});
