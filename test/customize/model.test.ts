import { expect, test } from "bun:test";
import { filterSources, sourceStatus, sourceWasLoaded } from "../../extensions/customize/model.ts";
import type { CustomizationSource } from "../../src/customize/types.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";

const source: CustomizationSource = {
    id: "a", category: "agents", name: "notes-reader", description: "Find meeting notes",
    scope: "project", path: "/project/.vera/agents/notes-reader.md", content: "Read notes", editable: true,
    contextIds: ["agent:notes-reader"],
};
const measured: VeraClientContextSnapshot = {
    availability: "available", projection: {
        estimatedTokens: 20, components: [{
            id: "core.agent-instructions", kind: "prompt_contribution", owner: "core", source: "contextual",
            displayName: "Instructions", count: 1, estimatedTokens: 20,
            parts: [{ id: "agent:notes-reader", displayName: "notes-reader", scope: "agent", bytes: 10, estimatedTokens: 20 }],
        }],
    },
};

test("search matches separate terms across name, scope, and source path", () => {
    expect(filterSources([source], "PROJECT meeting reader", "agents")).toEqual([source]);
    expect(filterSources([source], "reader", "skills")).toEqual([]);
});

test("catalog availability does not claim loading before a measurement", () => {
    expect(sourceWasLoaded(source, { availability: "unavailable" })).toBe(false);
    expect(sourceStatus(source, { availability: "unavailable" })).toContain("no measured request");
    expect(sourceWasLoaded(source, measured)).toBe(true);
    expect(sourceStatus(source, measured)).toBe("loaded in last measured request");
    expect(sourceStatus({ ...source, category: "skills", contextIds: [] }, measured)).toContain("individual loading not measured");
});

