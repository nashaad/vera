import { expect, test } from "bun:test";

import {
    activateClient,
    agentSuggestionRules,
} from "./extension.ts";

test("suggestion rules map terms to an offered agent", () => {
    expect(agentSuggestionRules({
        rules: [{
            terms: [" plan ", "how should we"],
            agent: " plan ",
            hint: " Create a plan? ",
            from_agents: [" default ", "reviewer"],
        }],
    })).toEqual([{
        terms: ["plan", "how should we"],
        agent: "plan",
        hint: "Create a plan?",
        fromAgents: ["default", "reviewer"],
    }]);
});

test("missing and malformed rules register no behavior", () => {
    expect(agentSuggestionRules(undefined)).toEqual([]);
    expect(agentSuggestionRules({ rules: [
        { terms: [], agent: "plan", hint: "Plan?" },
        { terms: ["plan"], agent: "", hint: "Plan?" },
        { terms: ["plan"], agent: "plan", hint: "", from_agents: [] },
    ] })).toEqual([]);
});

test("configured terms match whole words and phrases", () => {
    const registered: Array<{
        readonly agent: string;
        readonly hint: string;
        readonly fromAgents?: readonly string[];
        readonly match: (text: string) => boolean;
    }> = [];
    activateClient({
        config: {
            rules: [{
                terms: ["plan", "how should we"],
                agent: "plan",
                hint: "Create a plan?",
                from_agents: ["default"],
            }],
        },
        compose: {
            registerSuggester(value: typeof registered[number]) {
                registered.push(value);
            },
        },
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
        agent: "plan",
        hint: "Create a plan?",
        fromAgents: ["default"],
    });
    expect(registered[0]?.match("plan the change")).toBe(true);
    expect(registered[0]?.match("HOW   SHOULD WE fix this?")).toBe(true);
    expect(registered[0]?.match("planet data")).toBe(false);
});
