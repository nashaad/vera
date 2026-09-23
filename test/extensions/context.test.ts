import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    buildContextReport,
    contextCategories,
    contextCompactionTrigger,
    contextReportLines,
    contextReportMarkdown,
    formatKilobytes,
    instructionBudgetNotice,
    snapshotInstructionBudget,
} from "../../src/core-extensions/context/context-report.ts";
import {
    configuredInstructionBudget,
    DEFAULT_INSTRUCTION_BUDGET_TOKENS,
    instructionBudget,
} from "../../src/core-extensions/context/instruction-budget.ts";
import type {
    VeraClientContextComponent,
    VeraClientContextPart,
} from "../../src/sdk/context.ts";
import {
    startClientExtensionRegistry,
    type ClientExtensionExperimentalTuiAdapter,
    type StartClientExtensionRegistryOptions,
} from "../../src/extensions/client-registry.ts";
import type { VeraClientContextSnapshot } from "../../src/sdk/context.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("context reports group instruction files and align the occupancy bar", () => {
    const snapshot = availableSnapshot();

    expect(contextCategories(snapshot).map((category) => category.label))
        .toEqual([
            "Instructions",
            "System tools",
            "Messages",
            "System prompt",
        ]);
    expect(contextCompactionTrigger(snapshot)).toBe(800);

    const report = buildContextReport(snapshot, false, 120);
    expect(report.occupancy?.usedTokens).toBe(700);
    expect(report.occupancy?.reserveTokens).toBe(200);
    expect(report.occupancy?.bar.includes("█")).toBe(true);
    expect(report.occupancy?.bar.includes("▒")).toBe(true);
    expect(report.breakdown.map((row) => row.label)).toEqual([
        "Instructions",
        "System tools",
        "Messages",
        "System prompt",
    ]);
    expect(report.instructions.map((row) => row.displayName))
        .toEqual(["AGENTS.local.md", "AGENTS.md", "MEMORY.md"]);
    expect(report.fileWarnings.some((warning) =>
        warning.includes("AGENTS.local.md") && warning.includes("rides every turn")
    )).toBe(true);
    expect(report.headline).toContain("700 / 1.0k");
});

test("a large tool result is named on the compact context report", () => {
    const snapshot: VeraClientContextSnapshot = {
        availability: "available",
        model: { model: "local", capacity: 32_768 },
        headline: { tokens: 28_761, estimated: true },
        projection: {
            estimatedTokens: 28_761,
            components: [
                {
                    kind: "prompt_contribution",
                    id: "core.project-instructions",
                    owner: "core",
                    source: "contextual",
                    displayName: "Project instructions",
                    count: 1,
                    estimatedTokens: 12_000,
                    parts: [{
                        id: "agents-local",
                        displayName: "AGENTS.local.md",
                        scope: "project",
                        bytes: 45_035,
                        estimatedTokens: 12_000,
                    }],
                },
                {
                    kind: "message",
                    id: "message:7",
                    owner: "session",
                    source: "tool_result",
                    displayName: "read Vera 2 - In flight.md",
                    count: 1,
                    estimatedTokens: 16_510,
                },
                {
                    kind: "message",
                    id: "message:1",
                    owner: "session",
                    source: "user",
                    displayName: "user message",
                    count: 1,
                    estimatedTokens: 251,
                },
            ],
        },
    };
    const report = buildContextReport(snapshot, false, 120);
    expect(report.fileWarnings.some((warning) =>
        warning.includes("read Vera 2 - In flight.md")
        && warning.includes("17k")
        && warning.includes("57% of used")
    )).toBe(true);
    const markdown = contextReportMarkdown(snapshot, false, 72);
    expect(markdown).toContain("read Vera 2 - In flight.md is 17k (57% of used).");
});

test("a large tool result is named even without an instructions section", () => {
    const snapshot: VeraClientContextSnapshot = {
        availability: "available",
        model: { model: "local", capacity: 32_768 },
        headline: { tokens: 16_510, estimated: true },
        projection: {
            estimatedTokens: 16_510,
            components: [{
                kind: "message",
                id: "message:7",
                owner: "session",
                source: "tool_result",
                displayName: "read Vera 2 - In flight.md",
                count: 1,
                estimatedTokens: 16_510,
            }],
        },
    };
    const markdown = contextReportMarkdown(snapshot, false, 72);
    expect(markdown).toContain("read Vera 2 - In flight.md is 17k (100% of used).");
    expect(markdown).not.toContain("## INSTRUCTIONS");
});

test("agent instructions are Instructions, not Custom agents", () => {
    const base = availableSnapshot();
    if (base.projection === undefined) {
        throw new Error("expected availableSnapshot() to include a projection");
    }
    const snapshot: VeraClientContextSnapshot = {
        ...base,
        projection: {
            ...base.projection,
            components: [
                ...base.projection.components,
                {
                    kind: "prompt_contribution",
                    id: "core.agent-instructions",
                    owner: "core",
                    source: "stable",
                    displayName: "Agent",
                    count: 1,
                    estimatedTokens: 86,
                    parts: [{
                        id: "agent:build-reviewer",
                        displayName: "build-reviewer",
                        scope: "agent",
                        bytes: 400,
                        estimatedTokens: 86,
                    }],
                },
            ],
        },
    };
    expect(contextCategories(snapshot).map((category) => category.label))
        .toContain("Instructions");
    expect(contextCategories(snapshot).some((category) =>
        category.label === "Custom agents"
    )).toBe(false);
    expect(buildContextReport(snapshot, false, 120).instructions.some((row) =>
        row.displayName === "build-reviewer" && row.scope === "agent"
    )).toBe(true);
});

test("a missing projection after a measured turn is not a first-request state", () => {
    const report = buildContextReport({
        availability: "partial",
        model: { model: "local", capacity: 1_000 },
        headline: { tokens: 700, estimated: true },
    }, false, 120);
    expect(report.breakdownMissing).toBe(
        "No category split in this snapshot.",
    );
    const lines = contextReportLines(report, 80, false).join("\n");
    expect(lines).toContain("No category split in this snapshot.");
    expect(lines).not.toContain("Available after the first model request.");
});

test("partial context reports omit capacity-dependent visuals", () => {
    const report = buildContextReport({
        availability: "partial",
        model: { model: "local" },
        headline: { tokens: 42, estimated: true },
    }, true, 60);

    expect(report.occupancy).toBeUndefined();
    expect(report.breakdown).toEqual([]);
    expect(report.detail).toEqual([]);
    expect(report.headline).toContain("42 / ?");
});

test("formatKilobytes is what the file list prints", () => {
    expect(formatKilobytes(43_000)).toBe("42 KB");
    expect(formatKilobytes(400)).toBe("400 B");
});

test("context markdown shows occupancy sections at 120, 80, and 60 columns", () => {
    for (const width of [120, 80, 60, 48] as const) {
        const markdown = contextReportMarkdown(availableSnapshot(), false, width);
        expect(markdown).toContain("## CONTEXT USAGE");
        expect(markdown).toContain("## BREAKDOWN");
        expect(markdown).toContain("## INSTRUCTIONS");
        expect(markdown).toContain("AGENTS.local.md");
        expect(markdown).toContain("> !  AGENTS.local.md");
        expect(markdown).not.toContain("SUGGESTIONS");
        expect(markdown).not.toContain("├─");
        expect(markdown).toContain("/context [all] to expand");
        const inner = Math.max(20, width - 2);
        expect(markdown).not.toContain("─".repeat(width - 2));
        for (const line of markdown.split("\n")) {
            expect(line.length).toBeLessThanOrEqual(inner);
        }
    }
});

test("context numbers appear once, under the bar once it can be drawn", () => {
    const occurrences = (text: string, value: string) =>
        text.split(value).length - 1;
    const emptyHeadline = "No completed model request yet";
    const empty = contextReportMarkdown({ availability: "partial" }, false, 60);
    expect(occurrences(empty, emptyHeadline)).toBe(1);

    const snapshot = availableSnapshot();
    const report = buildContextReport(snapshot, false, 60);
    const measured = contextReportMarkdown(snapshot, false, 60);
    expect(occurrences(measured, report.headline)).toBe(0);
    const lines = measured.split("\n");
    expect(lines).toContain("## CONTEXT USAGE");
    const tick = lines.findIndex((line) => line.trim() === "▏");
    expect(lines.slice(tick + 1, tick + 4)).toEqual([
        "█ used 700 (70%)   ░ free 100",
        "▏ compacts at 800   ▒ reserve 200",
        "of 1.0k · estimated",
    ]);
    const wide = contextReportMarkdown(snapshot, false, 88).split("\n");
    const wideTick = wide.findIndex((line) => line.trim() === "▏");
    expect(wide.slice(wideTick + 1, wideTick + 3)).toEqual([
        "█ used 700 (70%)   ░ free 100   ▏ compacts at 800   ▒ reserve 200",
        "of 1.0k · estimated",
    ]);
    expect(occurrences(measured, "700 (70%)")).toBe(1);
});

test("breakdown bars share one left edge when /context all expands components", () => {
    const markdown = contextReportMarkdown(availableSnapshot(), true, 72);
    const lines = markdown.split("\n");
    const start = lines.findIndex((line) => line.startsWith("## BREAKDOWN"));
    const end = lines.findIndex((line) => line.startsWith("## INSTRUCTIONS"));
    const section = lines.slice(start, end < 0 ? undefined : end);
    const columns = section.flatMap((line) => {
        const index = [...line].findIndex((character) =>
            character === "█" || character === "▏"
        );
        return index < 0 || /^[█░▒▏]+$/.test(line) ? [] : [index];
    });
    expect(columns.length).toBeGreaterThan(1);
    expect(new Set(columns).size).toBe(1);
});

test("the client extension opens a markdown inspect document", async () => {
    const directory = createExtension();
    const snapshot = availableSnapshot();
    let opened: { title: string; markdown: string } | undefined;
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument(_extensionId, document) {
            const markdown = typeof document.markdown === "function"
                ? document.markdown(88)
                : document.markdown;
            opened = { title: document.title, markdown };
        },
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    const registry = await startClientExtensionRegistry(
        registryOptions(directory, snapshot, experimentalTui),
    );

    try {
        const result = await registry.invokeCommand("context", "", "/workspace");
        expect(result?.body).toEqual({ kind: "handled" });
        expect(opened?.title).toBe("Context");
        expect(opened?.markdown).toBe("# Context\n");
        expect(snapshot.headline?.tokens).toBe(700);
    } finally {
        await registry.close();
    }
});

test("the included Context extension reads instruction_budget_tokens from its config", async () => {
    const path = join(import.meta.dir, "../../src/core-extensions/context");
    const snapshot = budgetSnapshot([
        instruction("core.user-rules", "User rules", 7_000),
    ]);
    const openWith = async (config: { instruction_budget_tokens?: number }): Promise<string | undefined> => {
        let markdown: string | undefined;
        const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
            mount: () => async () => {},
            mountRenderable: () => async () => {},
            openDocument(_extensionId, document) {
                markdown = typeof document.markdown === "function"
                    ? document.markdown(88)
                    : document.markdown;
            },
            events: { on: () => async () => {} },
            agentSurface: {
                current: () => undefined,
                cycleLayout: () => false,
                toggleFocus: () => false,
            },
        };
        const options = registryOptions(path, snapshot, experimentalTui);
        const registry = await startClientExtensionRegistry({
            ...options,
            extensions: [{ path, enabled: true, config }],
        });
        try {
            await registry.invokeCommand("context", "", "/workspace");
        } finally {
            await registry.close();
        }
        return markdown;
    };
    expect(await openWith({})).not.toContain("budget");
    expect(await openWith({ instruction_budget_tokens: 5_000 })).toContain("over the 5.0k budget");
    expect(await openWith({ instruction_budget_tokens: 6_000 })).toContain("over the 6.0k budget");
    expect(await openWith({ instruction_budget_tokens: 8_000 })).not.toContain("budget");
    expect(await openWith({ instruction_budget_tokens: 0 })).not.toContain("budget");

    const options = registryOptions(path, snapshot, {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument: () => {},
        events: { on: () => async () => {} },
        agentSurface: { current: () => undefined, cycleLayout: () => false, toggleFocus: () => false },
    });
    const broken = await startClientExtensionRegistry({
        ...options,
        extensions: [{ path, enabled: true, config: { instruction_budget_tokens: -1 } }],
    });
    try {
        await expect(broken.invokeCommand("context", "", "/workspace")).rejects.toThrow("unavailable");
    } finally {
        await broken.close();
    }
});

test("the context command reports a clean compatibility error on an old TUI host", async () => {
    const directory = createExtension();
    const snapshot = availableSnapshot();
    const modern: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument: () => {},
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    const { openDocument: _ignored, ...legacy } = modern;
    const registry = await startClientExtensionRegistry(
        registryOptions(directory, snapshot, legacy),
    );
    try {
        await expect(registry.invokeCommand("context", "", "/workspace"))
            .rejects.toThrow("cannot open markdown reports");
    } finally {
        await registry.close();
    }
});

test("the instruction budget is the INSTRUCTIONS section total, skills included", () => {
    expect(DEFAULT_INSTRUCTION_BUDGET_TOKENS).toBe(8_000);
    const under = budgetSnapshot([
        instruction("core.user-rules", "User rules", 6_000),
        instruction("core.project-instructions", "Project instructions", 1_000),
        instruction("host.skills", "Skills", 999),
    ]);
    const budget = snapshotInstructionBudget(under);
    expect(budget?.tokens).toBe(7_999);
    expect(budget?.over).toBe(false);
    expect(budget?.biggest?.displayName).toBe("User rules");
    expect(instructionBudgetNotice(under)).toBeUndefined();
    expect(snapshotInstructionBudget({ availability: "unavailable" })).toBeUndefined();
    expect(instructionBudget(8_000, []).over).toBe(true);
    expect(instructionBudget(8_000, []).biggest).toBeUndefined();

    const over = budgetSnapshot([
        instruction("core.user-rules", "User rules", 6_000),
        instruction("core.project-instructions", "Project instructions", 1_000),
        instruction("host.skills", "Skills", 1_000),
        instruction("core.agent-instructions", "Agent", 500),
    ]);
    expect(snapshotInstructionBudget(over)?.tokens).toBe(8_500);
    expect(instructionBudgetNotice(over)).toBe(
        "Starting instructions are 8.5k tokens, over the 8.0k budget. See /context to trim.",
    );
});

test("instruction_budget_tokens in the extension config sets the budget, and 0 turns it off", () => {
    expect(configuredInstructionBudget(null)).toBe(8_000);
    expect(configuredInstructionBudget({})).toBe(8_000);
    expect(configuredInstructionBudget({ instruction_budget_tokens: 8_000 })).toBe(8_000);
    expect(configuredInstructionBudget({ instruction_budget_tokens: 0 })).toBe(0);
    for (const bad of [-1, 1.5, "8000", null]) {
        expect(() => configuredInstructionBudget({ instruction_budget_tokens: bad }))
            .toThrow("instruction_budget_tokens");
    }
    expect(() => configuredInstructionBudget([])).toThrow("must be an object");

    const snapshot = budgetSnapshot([
        instruction("core.user-rules", "User rules", 7_000),
    ]);
    expect(instructionBudgetNotice(snapshot, 8_000)).toBeUndefined();
    expect(contextReportMarkdown(snapshot, false, 72, 8_000)).not.toContain("budget");
    expect(instructionBudgetNotice(snapshot, 6_000)).toBe(
        "Starting instructions are 7.0k tokens, over the 6.0k budget. See /context to trim.",
    );
    expect(snapshotInstructionBudget(snapshot, 0)?.over).toBe(false);
    expect(instructionBudgetNotice(snapshot, 0)).toBeUndefined();
    expect(contextReportMarkdown(snapshot, false, 72, 0)).not.toContain("budget");
});

test("a 7k global rules file is over the budget and Sundr's files are not", () => {
    const global = budgetSnapshot([
        instruction("core.user-rules", "User rules", 7_000),
        instruction("core.project-instructions", "Project instructions", 1_454),
    ]);
    const sundr = budgetSnapshot([
        instruction("core.project-instructions", "Project instructions", 1_454),
        instruction("host.skills", "Skills", 737),
    ]);
    expect(snapshotInstructionBudget(global)?.over).toBe(true);
    expect(instructionBudgetNotice(global)).toBe(
        "Starting instructions are 8.5k tokens, over the 8.0k budget. See /context to trim.",
    );
    expect(snapshotInstructionBudget(sundr)?.over).toBe(false);
    expect(contextReportMarkdown(sundr, false, 72)).not.toContain("budget");
});

test("/context shows one red budget line with the biggest file and drops the per-file warning", () => {
    const snapshot = budgetSnapshot([
        instruction("core.user-rules", "User rules", 5_800, [{
            id: "rules-house",
            displayName: "<home>/rules/house-style.md",
            scope: "user",
            bytes: 27_000,
            estimatedTokens: 5_800,
        }]),
        instruction("core.project-instructions", "Project instructions", 1_600, [{
            id: "agents",
            displayName: "AGENTS.md",
            scope: "project",
            bytes: 20_000,
            estimatedTokens: 1_600,
        }]),
        instruction("host.skills", "Skills", 700),
    ]);
    const markdown = contextReportMarkdown(snapshot, false, 72);
    const lines = markdown.split("\n");
    const warning = lines.indexOf(
        "!  8.1k, over the 8.0k budget. Biggest: <home>/rules/house-style.md (5.8k).",
    );
    expect(warning).toBeGreaterThan(0);
    expect(lines[warning - 1]).toStartWith("## INSTRUCTIONS");
    expect(lines[warning - 1]).toContain("8.1k");
    expect(lines[warning + 1]).toBe("");
    expect(lines[warning + 2]).toContain("house-style.md");
    expect(lines.find((line) => line.startsWith("Instructions"))).toContain("8.1k");
    expect(markdown).not.toContain("rides every turn");
});

test("a skill catalog can be the biggest source, named by its display name", () => {
    const snapshot = budgetSnapshot([
        instruction("host.skills", "Skills", 7_000),
        instruction("core.user-rules", "User rules", 1_200),
    ]);
    expect(contextReportMarkdown(snapshot, false, 72)).toContain(
        "!  8.2k, over the 8.0k budget. Biggest: Skills (7.0k).",
    );
});

test("under the budget the per-file warning is unchanged", () => {
    const snapshot = budgetSnapshot([
        instruction("core.project-instructions", "Project instructions", 4_000, [{
            id: "agents",
            displayName: "AGENTS.local.md",
            scope: "project",
            bytes: 17_000,
            estimatedTokens: 4_000,
        }]),
    ]);
    const markdown = contextReportMarkdown(snapshot, false, 72);
    expect(markdown).toContain("AGENTS.local.md is 17 KB and rides every turn.");
    expect(markdown).not.toContain("budget");
});

test("the context extension posts one soft budget notice per conversation", async () => {
    let snapshot: VeraClientContextSnapshot = { availability: "unavailable" };
    const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
    const notices: { text: string; tone?: string }[] = [];
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument: () => {},
        events: {
            on(_extensionId, event, listener) {
                const list = listeners.get(event) ?? [];
                list.push(listener as (...args: unknown[]) => unknown);
                listeners.set(event, list);
                return async () => {};
            },
        },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    const fire = (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
    };
    const options = registryOptions(
        join(import.meta.dir, "../../src/core-extensions/context"),
        snapshot,
        experimentalTui,
    );
    const registry = await startClientExtensionRegistry({
        ...options,
        context: { current: () => snapshot },
        notice: {
            post: (_id, text, noticeOptions) => {
                notices.push({ text, ...(noticeOptions?.tone === undefined ? {} : { tone: noticeOptions.tone }) });
            },
        },
    });
    try {
        fire("agent_event", { type: "user_prompt", text: "hi" });
        snapshot = budgetSnapshot([
            instruction("core.user-rules", "User rules", 9_000),
        ]);
        fire("agent_event", { type: "status", state: "working" });
        fire("transcript_changed", []);
        expect(notices).toEqual([]);

        fire("agent_event", { type: "turn_finished" });
        expect(notices).toEqual([{
            text: "Starting instructions are 9.0k tokens, over the 8.0k budget. See /context to trim.",
            tone: "soft",
        }]);

        fire("agent_event", { type: "user_prompt", text: "again" });
        fire("agent_event", { type: "turn_finished" });
        fire("transcript_changed", []);
        expect(notices.length).toBe(1);

        fire("conversation_changed");
        fire("transcript_changed", []);
        expect(notices.length).toBe(2);
    } finally {
        await registry.close();
    }
});

function instruction(
    id: string,
    displayName: string,
    estimatedTokens: number,
    parts?: readonly VeraClientContextPart[],
): VeraClientContextComponent {
    return {
        kind: "prompt_contribution",
        id,
        owner: "core",
        source: "contextual",
        displayName,
        count: 1,
        estimatedTokens,
        ...(parts === undefined ? {} : { parts }),
    };
}

function budgetSnapshot(
    components: readonly VeraClientContextComponent[],
): VeraClientContextSnapshot {
    const total = components.reduce((sum, component) => sum + component.estimatedTokens, 0);
    return {
        availability: "available",
        model: { model: "model", capacity: 200_000 },
        headline: { tokens: total, estimated: true },
        projection: { estimatedTokens: total, components },
    };
}

function availableSnapshot(): VeraClientContextSnapshot {
    return {
        availability: "available",
        model: { provider: "test", model: "model", capacity: 1_000 },
        headline: { tokens: 700, estimated: true },
        projection: {
            estimatedTokens: 700,
            components: [
                {
                    kind: "prompt_contribution",
                    id: "core.identity",
                    owner: "core",
                    source: "stable",
                    displayName: "Identity",
                    count: 1,
                    estimatedTokens: 300,
                },
                {
                    kind: "tool_schema",
                    id: "tool:bash",
                    owner: "engine",
                    source: "tool",
                    displayName: "bash",
                    count: 1,
                    estimatedTokens: 200,
                },
                {
                    kind: "prompt_contribution",
                    id: "core.project-instructions",
                    owner: "core",
                    source: "contextual",
                    displayName: "Project instructions",
                    count: 1,
                    estimatedTokens: 80,
                    parts: [
                        {
                            id: "agents-local",
                            displayName: "AGENTS.local.md",
                            scope: "project",
                            bytes: 43_000,
                            estimatedTokens: 60,
                        },
                        {
                            id: "agents",
                            displayName: "AGENTS.md",
                            scope: "project",
                            bytes: 1_200,
                            estimatedTokens: 20,
                        },
                    ],
                },
                {
                    kind: "prompt_contribution",
                    id: "core.memory",
                    owner: "core",
                    source: "contextual",
                    displayName: "Memory",
                    count: 1,
                    estimatedTokens: 20,
                    parts: [{
                        id: "memory-index",
                        displayName: "MEMORY.md",
                        scope: "memory",
                        bytes: 800,
                        estimatedTokens: 20,
                    }],
                },
                {
                    kind: "message",
                    id: "message:1",
                    owner: "session",
                    source: "user",
                    displayName: "user message",
                    count: 1,
                    estimatedTokens: 100,
                },
            ],
        },
        compaction: { triggerFraction: 0.8 },
    };
}

function registryOptions(
    path: string,
    snapshot: VeraClientContextSnapshot,
    experimentalTui: ClientExtensionExperimentalTuiAdapter,
): StartClientExtensionRegistryOptions {
    return {
        extensions: [{ path, enabled: true, config: null }],
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
        experimentalTui,
    };
}

function createExtension(): string {
    const directory = join(
        tmpdir(),
        `vera-context-extension-${crypto.randomUUID()}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "example.context.test",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: [
            "client.commands.register",
            "client.context.read",
            "client.experimental_tui",
        ],
    }));
    writeFileSync(join(directory, "extension.ts"), `
        export function activateClient(vera) {
            vera.commands.register({
                name: "context",
                description: "Context",
                usage: "/context [all]",
                run() {
                    const snapshot = vera.context.current();
                    snapshot.headline.tokens = 0;
                    vera.experimentalTui.openDocument({
                        title: "Context",
                        markdown: "# Context\\n",
                    });
                    return { kind: "handled" };
                },
            });
        }
    `);
    return directory;
}

test("Esc on Loaded sources reopens the Context report", async () => {
    const path = join(import.meta.dir, "../../src/core-extensions/context");
    const snapshot = budgetSnapshot([instruction("core.user-rules", "User rules", 1_000)]);
    const opened: { title: string; action?: { run(): void | Promise<void> } }[] = [];
    const pickerTitles: string[] = [];
    const options = registryOptions(path, snapshot, {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        openDocument(_extensionId, document) {
            opened.push(document);
        },
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    });
    const registry = await startClientExtensionRegistry({
        ...options,
        picker: {
            request: async (_extensionId, request) => {
                pickerTitles.push(request.title);
                return { outcome: "cancelled" };
            },
        },
        context: {
            current: () => snapshot,
            sources: async () => ({ sources: [], warnings: [] }),
        },
    });
    try {
        await registry.invokeCommand("context", "", "/workspace");
        expect(opened.map((document) => document.title)).toEqual(["Context"]);
        await opened[0]!.action!.run();
        expect(pickerTitles).toEqual(["Context › Loaded sources"]);
        expect(opened.map((document) => document.title)).toEqual(["Context", "Context"]);
    } finally {
        await registry.close();
    }
});

test("the auto-compact tick sits in the first reserve cell", () => {
    const lines = contextReportMarkdown(budgetSnapshot([instruction("core.user-rules", "User rules", 6_000)]), false, 72).split("\n");
    const bar = lines.find((line) => line.includes("▒"))!;
    const tick = lines[lines.lastIndexOf(bar) + 1]!;
    expect(tick.trimStart()).toBe("▏");
    expect(tick.indexOf("▏")).toBe(bar.indexOf("▒"));
});
