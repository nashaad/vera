import { expect, test } from "bun:test";

import {
    collectBuiltInPromptContributions,
    promptContributionMetadata,
} from "../../src/engine/prompt-contributions.ts";

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

test("prompt contribution metadata records final order, bytes, and hashes", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
    });
    const metadata = promptContributionMetadata(contributions);

    expect(metadata.map(({ id, order }) => ({ id, order }))).toEqual([
        { id: "core.identity", order: 0 },
        { id: "core.tools", order: 1 },
        { id: "core.workspace", order: 2 },
        { id: "core.date", order: 3 },
    ]);
    expect(metadata.every((entry) => entry.bytes > 0)).toBe(true);
    expect(metadata.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)))
        .toBe(true);
});

test("prompt contribution hashes cover the rendered heading", () => {
    const base = {
        id: "core.identity",
        owner: "core" as const,
        target: "stable" as const,
        content: "same content",
    };

    const first = promptContributionMetadata([{ ...base, title: "First" }]);
    const second = promptContributionMetadata([{ ...base, title: "Second" }]);

    expect(first[0]?.sha256).not.toBe(second[0]?.sha256);
    expect(first[0]?.bytes).not.toBe(second[0]?.bytes);
});

test("a scratch directory adds the scratchpad contribution after the workspace", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        scratchDir: "/tmp/vera/session-1",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
    });

    expect(contributions.map((contribution) => contribution.id)).toEqual([
        "core.identity",
        "core.tools",
        "core.workspace",
        "core.scratchpad",
        "core.date",
    ]);
    const scratchpad = contributions.find(
        (contribution) => contribution.id === "core.scratchpad",
    );
    expect(scratchpad?.target).toBe("stable");
    expect(scratchpad?.content).toContain("/tmp/vera/session-1");
});

test("disabled contribution ids are omitted from both targets", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        scratchDir: "/tmp/vera/session-1",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        disabledContributions: ["core.scratchpad", "core.date"],
    });

    expect(contributions.map((contribution) => contribution.id)).toEqual([
        "core.identity",
        "core.tools",
        "core.workspace",
    ]);
});

test("scratch state renders as a contextual contribution", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 29),
        projectInstructions: { files: [], warnings: [] },
        scratchState: {
            files: ["notes.txt", "todo.md"],
            truncatedFiles: 0,
            todo: "- [x] done\n- [ ] next\n",
        },
    });

    const state = contributions.find(
        (contribution) => contribution.id === "core.scratchpad-state",
    );
    expect(state?.target).toBe("contextual");
    expect(state?.content).toContain("notes.txt, todo.md");
    expect(state?.content).toContain("- [ ] next");
});
