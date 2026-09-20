import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ResidentAgent,
    ResidentAgentClosedError,
} from "../../src/host/resident-agent.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

import {
    collectBuiltInPromptContributions,
    DEFAULT_PROMPT_CONTRIBUTION_ORDER,
    promptContributionMetadata,
    validatePromptContributionOrder,
} from "../../src/engine/prompt-contributions.ts";
import type { RuleSnapshot } from "../../src/engine/rules.ts";

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
        { id: "core.narration", owner: "core", target: "stable", title: "Narration" },
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
        "core.narration",
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
        { id: "core.narration", order: 1 },
        { id: "core.tools", order: 2 },
        { id: "core.workspace", order: 3 },
        { id: "core.date", order: 4 },
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
        "core.narration",
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
    expect(scratchpad?.content).toContain(
        "check items off and strike them through as you go",
    );
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
        "core.narration",
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

test("owner-provided contextual contributions append after core context", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/repo",
        date: new Date("2026-08-10T12:00:00Z"),
        additionalContextualContributions: [{
            id: "host.skills",
            owner: "host",
            target: "contextual",
            title: "Skills",
            content: "- consult",
        }],
    });

    expect(contributions.at(-1)).toEqual({
        id: "host.skills",
        owner: "host",
        target: "contextual",
        title: "Skills",
        content: "- consult",
    });
});

test("owner-provided contributions cannot collide or enter the stable prefix", () => {
    const input = {
        tools: [],
        workspace: "/repo",
        date: new Date("2026-08-10T12:00:00Z"),
    };
    expect(() => collectBuiltInPromptContributions({
        ...input,
        additionalContextualContributions: [{
            id: "core.date",
            owner: "host",
            target: "contextual",
            title: "Collision",
            content: "bad",
        }],
    })).toThrow("Duplicate prompt contribution id");
    expect(() => collectBuiltInPromptContributions({
        ...input,
        additionalContextualContributions: [{
            id: "host.stable",
            owner: "host",
            target: "stable",
            title: "Stable injection",
            content: "bad",
        }],
    })).toThrow("attributed contextual text");
});

test("a configured order renders the contributions in that order", () => {
    const reordered = [...DEFAULT_PROMPT_CONTRIBUTION_ORDER];
    const memory = reordered.indexOf("core.memory");
    const instructions = reordered.indexOf("core.project-instructions");
    reordered[memory] = "core.project-instructions";
    reordered[instructions] = "core.memory";

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
        memory: {
            files: [],
            warnings: [],
            loadedTopics: [],
            recommendations: [],
        },
        contributionOrder: reordered,
    });

    const ids = contributions.map((contribution) => contribution.id);
    expect(ids.indexOf("core.memory")).toBeLessThan(
        ids.indexOf("core.project-instructions"),
    );
});

test("an order that leaves a contribution out is refused", () => {
    expect(() =>
        validatePromptContributionOrder(
            DEFAULT_PROMPT_CONTRIBUTION_ORDER.filter((id) =>
                id !== "core.memory"
            ),
        )
    ).toThrow(/leaves out: core\.memory/);
});

test("an order naming a contribution that does not exist is refused", () => {
    expect(() =>
        validatePromptContributionOrder([
            ...DEFAULT_PROMPT_CONTRIBUTION_ORDER,
            "core.invented",
        ])
    ).toThrow(/do not exist: core\.invented/);
});

test("an order repeating a contribution is refused", () => {
    expect(() =>
        validatePromptContributionOrder([
            ...DEFAULT_PROMPT_CONTRIBUTION_ORDER,
            "core.memory",
        ])
    ).toThrow(/repeats: core\.memory/);
});

test("an order not starting with the identity is refused", () => {
    const moved = DEFAULT_PROMPT_CONTRIBUTION_ORDER.filter((id) =>
        id !== "core.identity"
    );
    expect(() =>
        validatePromptContributionOrder([moved[0]!, "core.identity", ...moved.slice(1)])
    ).toThrow(/must start with core\.identity/);
});

test("an order putting a stable contribution after a contextual one is refused", () => {
    const withoutWorkspace = DEFAULT_PROMPT_CONTRIBUTION_ORDER.filter((id) =>
        id !== "core.workspace"
    );
    expect(() =>
        validatePromptContributionOrder([...withoutWorkspace, "core.workspace"])
    ).toThrow(/every stable contribution renders before every contextual one/);
});

test("the default order is the order the build ships", () => {
    expect(validatePromptContributionOrder(DEFAULT_PROMPT_CONTRIBUTION_ORDER))
        .toBeUndefined();
    const withOrder = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        contributionOrder: DEFAULT_PROMPT_CONTRIBUTION_ORDER,
    });
    const without = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
    });
    expect(withOrder).toEqual(without);
});

test("the loop policy decides the order a real turn sends", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-prompt-order-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "order-session",
        cwd: root,
    });
    const requests: ModelRequest[] = [];
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const scripted = new FauxAdapter([response]);
    const resident = new ResidentAgent("order-session", root);
    const attachment = resident.attach();
    const loop = runHeadlessLoop(
        resident.engine,
        {
            stream(request) {
                requests.push(request);
                return scripted.stream(request);
            },
        },
        "test",
        undefined,
        {},
        {
            sessionStore: store,
            readPolicy: () => ({
                promptContributionOrder: [
                    ...DEFAULT_PROMPT_CONTRIBUTION_ORDER.filter((id) =>
                        id !== "core.tools"
                    ),
                ].toSpliced(1, 0, "core.tools"),
            }),
        },
    );
    try {
        resident.sendPrompt("measure");
        while ((await attachment.receive()).type !== "turn_finished") {
            // Drain one bounded turn.
        }
        const prompt = requests[0]?.systemPrompt ?? "";
        expect(prompt.indexOf("## Tools"))
            .toBeLessThan(prompt.indexOf("## Narration"));
    } finally {
        attachment.detach();
        resident.close();
        await expect(loop).rejects.toBeInstanceOf(ResidentAgentClosedError);
        await rm(root, { recursive: true, force: true });
    }
});

function ruleSnapshot(): RuleSnapshot {
    return {
        rules: [
            {
                scope: "user",
                path: "/home/.vera/rules/tone.md",
                displayPath: "<home>/rules/tone.md",
                paths: [],
                body: "Write plainly.\n",
            },
            {
                scope: "project",
                path: "/work/vera/.vera/rules/engine.md",
                displayPath: ".vera/rules/engine.md",
                paths: [],
                body: "The engine never imports UI.\n",
            },
            {
                scope: "project",
                path: "/work/vera/.vera/rules/tui.md",
                displayPath: ".vera/rules/tui.md",
                paths: ["clients/tui/**"],
                body: "Pad the layout.\n",
            },
        ],
        warnings: [{ scope: "user", message: "<home>/rules/huge.md is larger than 128 KB, so it was skipped" }],
    };
}

test("always-on rules render either side of the project instructions", () => {
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
        rules: ruleSnapshot(),
    });

    expect(contributions.map((contribution) => contribution.id)).toEqual([
        "core.identity",
        "core.narration",
        "core.tools",
        "core.workspace",
        "core.date",
        "core.user-rules",
        "core.project-instructions",
        "core.project-rules",
    ]);
});

test("a path-scoped rule stays out of the system prompt", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        rules: ruleSnapshot(),
    });
    const project = contributions.find((contribution) =>
        contribution.id === "core.project-rules"
    );
    expect(project?.content).toBe(
        "### .vera/rules/engine.md\nThe engine never imports UI.",
    );
    expect(project?.content).not.toContain("Pad the layout.");
});

test("a rule loading warning reaches the scope it came from", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        rules: ruleSnapshot(),
    });
    const user = contributions.find((contribution) =>
        contribution.id === "core.user-rules"
    );
    expect(user?.content).toBe(
        "### <home>/rules/tone.md\nWrite plainly.\n\n"
            + "### Loading diagnostics\n"
            + "- <home>/rules/huge.md is larger than 128 KB, so it was skipped",
    );
});

test("no rules at all leaves both contributions out", () => {
    const contributions = collectBuiltInPromptContributions({
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        rules: { rules: [], warnings: [] },
    });
    expect(contributions.map((contribution) => contribution.id))
        .not.toContain("core.user-rules");
    expect(contributions.map((contribution) => contribution.id))
        .not.toContain("core.project-rules");
});
