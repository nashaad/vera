import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";

import {
    buildContextReport,
    contextCategories,
    contextCompactionTrigger,
    contextGrid,
    contextResponsiveMode,
    contextSuggestions,
} from "../../examples/extensions/context/context-report.ts";
import { createContextView } from "../../examples/extensions/context/context-view.ts";
import type { VeraExperimentalTuiRawContext } from "../../src/sdk/experimental-tui.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
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

test("context reports use stable categories and responsive grids", () => {
    const snapshot = availableSnapshot();

    expect(contextResponsiveMode(120)).toBe("wide");
    expect(contextResponsiveMode(80)).toBe("wide");
    expect(contextResponsiveMode(60)).toBe("narrow");
    expect(contextCategories(snapshot).map((category) => category.label))
        .toEqual([
            "System prompt",
            "System tools",
            "Memory files",
            "Messages",
        ]);

    const wide = contextGrid(snapshot, 10);
    const narrow = contextGrid(snapshot, 5);
    expect(wide?.columns).toBe(10);
    expect(wide?.rows).toHaveLength(10);
    expect(narrow?.columns).toBe(5);
    expect(narrow?.rows).toHaveLength(20);
    expect(wide?.usedTokens).toBe(700);
    expect(wide?.freeTokens).toBe(100);
    expect(wide?.reserveTokens).toBe(200);
    expect(wide?.rows.flat().filter((cell) => cell.state === "used"))
        .toHaveLength(70);
});

test("context suggestions put compaction warnings before savings", () => {
    const suggestions = contextSuggestions({
        ...availableSnapshot(),
        headline: { tokens: 790, estimated: true },
    });

    expect(suggestions[0]?.tone).toBe("warning");
    expect(suggestions.some((suggestion) => suggestion.tone === "tip"))
        .toBe(true);
    expect(suggestions.every((suggestion) =>
        suggestion.text.length > 0
        && suggestion.estimatedSaving >= 0
    )).toBe(true);
});

test("context uses the earliest compaction bound, including without capacity", () => {
    const knownCapacity = {
        ...availableSnapshot(),
        headline: { tokens: 825, estimated: true },
        compaction: { triggerFraction: 0.82, triggerTokens: 950 },
    } satisfies VeraClientContextSnapshot;
    expect(contextCompactionTrigger(knownCapacity)).toBe(820);
    expect(contextSuggestions(knownCapacity)[0]?.tone).toBe("warning");

    const unknownCapacity: VeraClientContextSnapshot = {
        availability: "partial",
        model: { model: "local" },
        headline: { tokens: 100, estimated: true },
        compaction: { triggerTokens: 100 },
    };
    expect(contextCompactionTrigger(unknownCapacity)).toBe(100);
    expect(contextSuggestions(unknownCapacity)[0]?.tone).toBe("warning");
});

test("partial context reports omit capacity-dependent visuals", () => {
    const report = buildContextReport({
        availability: "partial",
        model: { model: "local" },
        headline: { tokens: 42, estimated: true },
    }, true, 60);

    expect(report.grid).toBeUndefined();
    expect(report.categories).toEqual([]);
    expect(report.detail).toEqual([]);
    expect(report.headline).toBe("42 / ? tokens · estimated");
});

test("context reports show overflow directly instead of hiding it in the grid", () => {
    const report = buildContextReport({
        ...availableSnapshot(),
        headline: { tokens: 1_200, estimated: true },
    }, false, 120);

    expect(report.grid?.reserveTokens).toBe(0);
    expect(report.grid?.usedTokens).toBe(1_200);
});

test("context OpenTUI rendering adapts at 120, 80, and 60 columns", async () => {
    for (const [width, height, expectedGrid] of [
        [120, 40, "██████████"],
        [80, 30, "██████████"],
        [60, 24, "█████"],
    ] as const) {
        const setup = await createTestRenderer({ width, height });
        const context: VeraExperimentalTuiRawContext = {
            renderer: setup.renderer,
            workspace: "/workspace",
            theme: {
                text: VERA_TUI_THEME.text,
                muted: VERA_TUI_THEME.muted,
                accent: VERA_TUI_THEME.accent,
                notice: VERA_TUI_THEME.notice,
                success: VERA_TUI_THEME.success,
                panel: VERA_TUI_THEME.panel,
            },
            transcript: [],
            requestRender() {},
        };
        const view = createContextView(context, availableSnapshot(), {
            id: `context-view-${width}`,
            detail: false,
            commandText: "/context",
        });
        setup.renderer.root.add(view.root);
        try {
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("↳ /context");
            expect(frame).toContain("Context Usage");
            expect(frame).toContain(expectedGrid);
        } finally {
            setup.renderer.destroy();
        }
    }
});

test("the client extension reads a cloned snapshot and appends a native renderable", async () => {
    const directory = createExtension();
    const snapshot = availableSnapshot();
    let receivedId: string | undefined;
    let disposed = 0;
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        appendTranscriptRenderable(_extensionId, spec) {
            receivedId = spec.id;
            return async () => { disposed += 1; };
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
        expect(receivedId).toBe("report");
        expect(snapshot.headline?.tokens).toBe(700);
    } finally {
        await registry.close();
    }
    expect(disposed).toBe(1);
});

test("the context command reports a clean compatibility error on an old TUI host", async () => {
    const directory = createExtension();
    const snapshot = availableSnapshot();
    const modern: ClientExtensionExperimentalTuiAdapter = {
        mount: () => async () => {},
        mountRenderable: () => async () => {},
        appendTranscriptRenderable: () => async () => {},
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    const { appendTranscriptRenderable: _ignored, ...legacy } = modern;
    const registry = await startClientExtensionRegistry(
        registryOptions(directory, snapshot, legacy),
    );
    try {
        await expect(registry.invokeCommand("context", "", "/workspace"))
            .rejects.toThrow("cannot append transcript renderables");
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
                    id: "core.memory",
                    owner: "core",
                    source: "contextual",
                    displayName: "Memory",
                    count: 1,
                    estimatedTokens: 100,
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
                    vera.experimentalTui.appendTranscriptRenderable({
                        id: "report",
                        create() { throw new Error("not mounted in this test"); },
                    });
                    return { kind: "handled" };
                },
            });
        }
    `);
    return directory;
}
