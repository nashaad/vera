import { expect, test } from "bun:test";

import { collectBuiltInPromptContributions } from "../../src/engine/prompt-contributions.ts";

test("built-in prompt contributors return attributed plain data in order", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: {
            files: [{
                path: "/work/vera/AGENTS.md",
                name: "AGENTS.md",
                content: "Keep changes small.",
                bytes: 19,
                sha256: "abc123",
            }],
            warnings: [],
        },
    });

    expect(contributions.map(({ id, owner, target, title }) => ({
        id,
        owner,
        target,
        title,
    }))).toEqual([
        { id: "core.identity", owner: "core", target: "stable", title: "Identity" },
        { id: "core.tools", owner: "core", target: "stable", title: "Tools" },
        { id: "core.workspace", owner: "core", target: "stable", title: "Workspace" },
        { id: "core.date", owner: "core", target: "contextual", title: "Date" },
        {
            id: "core.project-instructions",
            owner: "core",
            target: "contextual",
            title: "Project instructions",
        },
    ]);
    expect(contributions.every((contribution) =>
        typeof contribution.content === "string"
    )).toBe(true);
});

test("an empty optional contribution does not disturb built-in order", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
    });

    expect(contributions.map((contribution) => contribution.id)).toEqual([
        "core.identity",
        "core.tools",
        "core.workspace",
        "core.date",
    ]);
});
