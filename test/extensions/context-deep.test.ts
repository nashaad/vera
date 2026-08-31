import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contextDeepMarkdown } from "../../examples/extensions/context/deep-markdown.ts";
import { measureDeepPile } from "../../examples/extensions/context/deep-pile.ts";
import {
    computeSde,
    JUDGE_SYSTEM_PROMPT,
    parseJudgeText,
    sdeBand,
} from "../../examples/extensions/context/deep-judge.ts";
import { buildContextDeep } from "../../examples/extensions/context/deep.ts";
import {
    startClientExtensionRegistry,
    type ClientExtensionExperimentalTuiAdapter,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraClientOneshotRequest,
    VeraClientOneshotResult,
} from "../../src/sdk/extensions.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = join(
        tmpdir(),
        `vera-deep-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}

test("the pile counts the files Vera would inject, not git history", async () => {
    const root = workspace();
    writeFileSync(
        join(root, "AGENTS.md"),
        [
            "# Project",
            "",
            "- always use worktrees",
            "- never push to main",
            "You must not invent history.",
            "",
        ].join("\n"),
    );
    writeFileSync(
        join(root, "AGENTS.local.md"),
        [
            "# Local",
            "",
            "1. Do not change prompts.",
            "You cannot skip the contract.",
            "",
        ].join("\n"),
    );

    const { pile, bodies } = await measureDeepPile(root);
    expect(pile.files.map((file) => file.name)).toEqual([
        "AGENTS.md",
        "AGENTS.local.md",
    ]);
    expect(pile.modalVerbs).toBe(5);
    expect(pile.listItems).toBe(3);
    expect(pile.bytes).toBeGreaterThan(0);
    expect(pile.tokensEst).toBeGreaterThan(0);
    expect(JSON.stringify(pile)).not.toContain("always use worktrees");
    expect(bodies.map((file) => file.name)).toEqual([
        "AGENTS.md",
        "AGENTS.local.md",
    ]);
});

test("imports outside the workspace are skipped with a warning", async () => {
    const root = workspace();
    const outside = join(tmpdir(), `vera-deep-outside-${process.pid}.md`);
    writeFileSync(outside, "must stay out\n");
    temporaryDirectories.push(outside);
    writeFileSync(
        join(root, "AGENTS.md"),
        `See @${outside}\n`,
    );

    const { pile } = await measureDeepPile(root);
    expect(pile.files.map((file) => file.name)).toEqual(["AGENTS.md"]);
    expect(pile.warnings.some((warning) =>
        warning.includes("outside the workspace")
    )).toBe(true);
});

test("SDE is (S/W)*(1-R)*C, rounded to two decimals", () => {
    expect(computeSde(7970, 12256, 0.35, 0.75)).toBe(0.32);
    expect(sdeBand(0.32)).toBe("diluted");
    expect(sdeBand(0.40)).toBe("standard");
    expect(sdeBand(0.65)).toBe("dense");
    expect(sdeBand(0.81)).toBe("ultra");
});

test("judge parse fills ready state and ignores dropped-rule fields", () => {
    const judge = parseJudgeText(`
\`\`\`json
{
  "distinctInstructions": 78,
  "independentFamilies": 2,
  "familyNames": ["git", "prompts"],
  "S": 7970,
  "W": 12256,
  "R": 0.35,
  "C": 0.75,
  "droppedFollowed": 6,
  "droppedOmitted": 4
}
\`\`\`
`);
    expect(judge).toEqual({
        status: "ready",
        distinctInstructions: 78,
        independentFamilies: 2,
        familyNames: ["git", "prompts"],
        S: 7970,
        W: 12256,
        R: 0.35,
        C: 0.75,
        SDE: 0.32,
        sdeBand: "diluted",
    });
});

test("invalid judge JSON is failed, not invented numbers", () => {
    const judge = parseJudgeText("I counted about eighty rules.");
    expect(judge).toEqual({
        status: "failed",
        reason: "Judge reply was not JSON.",
    });
});

test("deep without oneshot still returns the pile and leaves judge unmeasured", async () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "- always work in a worktree\n");

    const report = await buildContextDeep({ workspace: root });
    expect(report.pile.listItems).toBe(1);
    expect(report.pile.modalVerbs).toBe(1);
    expect(report.judge).toEqual({
        status: "unmeasured",
        reason: "oneshot is not available",
    });
    expect(report.droppedRule).toEqual({ status: "unmeasured" });
    expect(report.harnessInstructions).toBe(50);
    expect(report.instructionBudget).toBe(150);
    const markdown = contextDeepMarkdown(report, 72);
    expect(markdown).toContain("Standing rules unmeasured.");
    expect(markdown).toContain("SDE unmeasured.");
    expect(markdown).toContain("AGENTS.md");
    expect(markdown).not.toContain("0.32");
});

test("isolated judge calls oneshot with a tiny system prompt and the files only", async () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "Never merge from the mini.\n");
    const asked: VeraClientOneshotRequest[] = [];

    const report = await buildContextDeep({
        workspace: root,
        model: { model: "gpt-5.6-luna", provider: "openai" },
        oneshot: async (request): Promise<VeraClientOneshotResult> => {
            asked.push(request);
            return {
                model: request.model,
                provider: request.provider,
                text: JSON.stringify({
                    distinctInstructions: 1,
                    independentFamilies: 1,
                    familyNames: ["git"],
                    S: 8,
                    W: 10,
                    R: 0,
                    C: 1,
                }),
            };
        },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.model).toBe("gpt-5.6-luna");
    expect(asked[0]?.provider).toBe("openai");
    expect(asked[0]?.systemPrompt).toBe(JUDGE_SYSTEM_PROMPT);
    expect(asked[0]?.systemPrompt?.includes("AGENTS.local.md")).toBe(false);
    expect(asked[0]?.messages[0]?.content).toContain("Never merge from the mini.");
    expect(report.judge.status).toBe("ready");
    if (report.judge.status !== "ready") {
        return;
    }
    expect(report.judge.distinctInstructions).toBe(1);
    expect(report.judge.SDE).toBe(0.8);
    expect(report.judge.sdeBand).toBe("dense");
    expect(report.droppedRule.status).toBe("unmeasured");
    const markdown = contextDeepMarkdown(report, 72);
    expect(markdown).toContain("## PRESSURE");
    expect(markdown).toContain("## SDE");
    expect(markdown).toContain("0.80");
    expect(markdown).toContain("dense");
    expect(markdown).toContain("git");
    expect(markdown).toContain("(S/W)×(1−R)×C");
});

test("a rejected oneshot leaves judge failed without fake counts", async () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "always\n");
    const report = await buildContextDeep({
        workspace: root,
        model: { model: "gpt-5.6-luna" },
        oneshot: async () => {
            throw new Error("No provider serves gpt-5.6-luna.");
        },
    });
    expect(report.judge).toEqual({
        status: "failed",
        reason: "No provider serves gpt-5.6-luna.",
    });
    expect(report.pile.modalVerbs).toBe(1);
    expect(contextDeepMarkdown(report, 72)).toContain("Standing rules failed.");
});

test("/context deep opens the inspect document titled Deep", async () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "- always use a worktree\n");
    const snapshot = {
        availability: "available" as const,
        model: { provider: "test", model: "judge-model" },
    };
    let opened: { title: string; markdown: string; footer?: string } | undefined;
    const asked: VeraClientOneshotRequest[] = [];
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument(_extensionId, document) {
            const markdown = typeof document.markdown === "function"
                ? document.markdown(72)
                : document.markdown;
            opened = {
                title: document.title,
                markdown,
                footer: document.footerText,
            };
        },
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    const registry = await startClientExtensionRegistry({
        extensions: [{
            path: join(import.meta.dir, "../../examples/extensions/context"),
            enabled: true,
            config: null,
        }],
        preferences: {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
        },
        modelSettings: {
            current: () => undefined,
            update: async () => ({
                status: "accepted",
                settings: { model: "test" },
            }),
            subscribe: () => () => {},
        },
        picker: { request: async () => ({ outcome: "cancelled" }) },
        notice: { post: () => {} },
        context: { current: () => snapshot },
        sessions: {
            list: async () => ({ sessions: [], total: 0 }),
        },
        agents: {
            visible: () => [],
            create: async () => ({ agentId: "x" }),
            open: async () => {},
            message: async () => {},
        },
        oneshot: {
            async request(_extensionId, request) {
                asked.push(request);
                return {
                    model: request.model,
                    text: JSON.stringify({
                        distinctInstructions: 1,
                        independentFamilies: 1,
                        familyNames: ["worktrees"],
                        S: 8,
                        W: 10,
                        R: 0,
                        C: 1,
                    }),
                };
            },
        },
        experimentalTui,
    });
    try {
        const result = await registry.invokeCommand("context", "deep", root);
        expect(result?.body).toEqual({ kind: "handled" });
        expect(opened?.title).toBe("Deep");
        expect(opened?.footer).toContain("experimental");
        expect(opened?.markdown).toContain("worktrees");
        expect(opened?.markdown).toContain("## SDE");
        expect(asked[0]?.model).toBe("judge-model");
        const commands = registry.commands();
        const context = commands.find((command) => command.name === "context");
        expect(context?.usage).toBe("/context [all]");
        expect(context?.description).toContain("experimental");
        const unknown = await registry.invokeCommand("context", "more", root);
        expect(unknown?.body).toEqual({
            kind: "text",
            text: "Usage: /context [all|deep]",
        });
    } finally {
        await registry.close();
    }
});

test("/context deep still opens Deep when the handler timeout is shorter than the judge", async () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "- always use a worktree\n");
    const snapshot = {
        availability: "available" as const,
        model: { provider: "test", model: "judge-model" },
    };
    let opened: { title: string } | undefined;
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument(_extensionId, document) {
            opened = { title: document.title };
        },
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    const registry = await startClientExtensionRegistry({
        extensions: [{
            path: join(import.meta.dir, "../../examples/extensions/context"),
            enabled: true,
            config: null,
        }],
        handlerTimeoutMs: 10,
        preferences: {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
        },
        modelSettings: {
            current: () => undefined,
            update: async () => ({
                status: "accepted",
                settings: { model: "test" },
            }),
            subscribe: () => () => {},
        },
        picker: { request: async () => ({ outcome: "cancelled" }) },
        notice: { post: () => {} },
        context: { current: () => snapshot },
        sessions: {
            list: async () => ({ sessions: [], total: 0 }),
        },
        agents: {
            visible: () => [],
            create: async () => ({ agentId: "x" }),
            open: async () => {},
            message: async () => {},
        },
        oneshot: {
            async request(_extensionId, request) {
                await new Promise((resolve) => setTimeout(resolve, 30));
                return {
                    model: request.model,
                    text: JSON.stringify({
                        distinctInstructions: 1,
                        independentFamilies: 1,
                        familyNames: ["worktrees"],
                        S: 8,
                        W: 10,
                        R: 0,
                        C: 1,
                    }),
                };
            },
        },
        experimentalTui,
    });
    try {
        const result = await registry.invokeCommand("context", "deep", root);
        expect(result?.body).toEqual({ kind: "handled" });
        expect(opened?.title).toBe("Deep");
    } finally {
        await registry.close();
    }
});
