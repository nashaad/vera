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
} from "../../src/core-extensions/context/context-report.ts";
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
    const snapshot = availableSnapshot();
    snapshot.projection?.components.push({
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
    });
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

test("context headline appears once before and after the first request", () => {
    const occurrences = (text: string, value: string) =>
        text.split(value).length - 1;
    const emptyHeadline = "No completed model request yet";
    const empty = contextReportMarkdown({ availability: "partial" }, false, 60);
    expect(occurrences(empty, emptyHeadline)).toBe(1);

    const snapshot = availableSnapshot();
    const report = buildContextReport(snapshot, false, 60);
    const measured = contextReportMarkdown(snapshot, false, 60);
    expect(occurrences(measured, report.headline)).toBe(1);
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
