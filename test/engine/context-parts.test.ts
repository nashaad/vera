import { expect, test } from "bun:test";

import {
    apportionPartTokens,
    contextContributionParts,
} from "../../src/engine/context-parts.ts";

test("project instruction files keep root names and mark imports", () => {
    const parts = contextContributionParts({
        projectInstructions: {
            files: [
                {
                    name: "AGENTS.local.md",
                    path: "/workspace/AGENTS.local.md",
                    content: "root",
                    bytes: 20_000,
                    sha256: "a",
                },
                {
                    name: ".agent-notes/sdk-rubric.md",
                    path: "/workspace/.agent-notes/sdk-rubric.md",
                    content: "imported",
                    bytes: 2_000,
                    sha256: "b",
                },
            ],
            warnings: [],
        },
        agentName: "build-reviewer",
        agentInstructions: "Review the diff.",
    });

    expect(parts["core.project-instructions"]?.map((part) => ({
        displayName: part.displayName,
        imported: part.imported === true,
    }))).toEqual([
        { displayName: "AGENTS.local.md", imported: false },
        { displayName: ".agent-notes/sdk-rubric.md", imported: true },
    ]);
    expect(parts["core.agent-instructions"]?.[0]?.displayName)
        .toBe("build-reviewer");
});

test("part tokens are apportioned by bytes and sum to the parent", () => {
    const parts = apportionPartTokens([
        {
            id: "a",
            displayName: "a",
            scope: "project",
            bytes: 30,
        },
        {
            id: "b",
            displayName: "b",
            scope: "project",
            bytes: 10,
        },
    ], 100);
    expect(parts.reduce((sum, part) => sum + part.estimatedTokens, 0)).toBe(100);
    expect(parts[0]?.estimatedTokens).toBe(75);
    expect(parts[1]?.estimatedTokens).toBe(25);
});
