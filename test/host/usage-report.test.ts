import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    estimateUsd,
    foldUsageReport,
} from "../../src/host/usage-report.ts";
import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import type { ModelMessage, ModelUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const NOW = new Date(2026, 7, 29, 15, 0, 0);

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
    return {
        inputTokens: 1_000,
        outputTokens: 100,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1_100,
        ...overrides,
    };
}

function assistant(
    provider: string,
    model: string,
    modelUsage: ModelUsage,
): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        source: { provider, api: provider, model },
        usage: modelUsage,
        durationMs: 500,
        stopReason: "stop",
    };
}

async function writeSession(options: {
    readonly directory: string;
    readonly id: string;
    readonly at: Date;
    readonly cwd?: string;
    readonly parentId?: string;
    readonly messages: readonly ModelMessage[];
}): Promise<string> {
    const path = join(options.directory, `${options.id}.jsonl`);
    let stamp = options.at;
    const store = await SessionStore.create(path, {
        sessionId: options.id,
        cwd: options.cwd ?? "/work/vera",
        ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
        now: () => stamp,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });
    for (const message of options.messages) {
        await store.appendMessage(message);
    }
    return path;
}

function catalogDir(): string {
    const cacheDir = tempDir("vera-usage-catalog-");
    writeProviderCatalogSnapshot({
        schema_version: 2,
        provider: "openrouter",
        fetched_at: NOW.toISOString(),
        models: [{
            id: "anthropic/claude-sonnet-4",
            label: "Claude Sonnet 4",
            levels: [{ id: "medium", label: "Medium" }],
            pricing: { input: 3, output: 15, cache: 0.3 },
        }],
    }, { cacheDir });
    return cacheDir;
}

test("estimateUsd prices uncached, cached, and output separately", () => {
    expect(estimateUsd(
        usage({
            inputTokens: 1_000_000,
            cachedInputTokens: 200_000,
            outputTokens: 500_000,
        }),
        { input: 3, output: 15, cache: 0.3 },
    )).toBeCloseTo(9.96, 8);
});

test("a reported cost is not repriced from today's catalog", async () => {
    const sessionDirectory = tempDir("vera-usage-reported-");
    await writeSession({
        directory: sessionDirectory,
        id: "reported",
        at: NOW,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                totalTokens: 2_000_000,
                cost: 0.41,
            }),
        )],
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.spend.reported).toBeCloseTo(0.41, 8);
    expect(report.totals.spend.estimated).toBe(0);
    expect(report.totals.spend.combined).toBeCloseTo(0.41, 8);
    expect(report.models[0]?.kind).toBe("reported");
    expect(report.estimatedFromOpenRouter).toBe(false);
});

test("OpenRouter tokens without cost become estimates at current rates", async () => {
    const sessionDirectory = tempDir("vera-usage-estimated-");
    await writeSession({
        directory: sessionDirectory,
        id: "estimated",
        at: NOW,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({
                inputTokens: 1_000_000,
                cachedInputTokens: 200_000,
                outputTokens: 500_000,
                totalTokens: 1_500_000,
            }),
        )],
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.spend.reported).toBe(0);
    expect(report.totals.spend.estimated).toBeCloseTo(9.96, 8);
    expect(report.totals.spend.unpricedCalls).toBe(0);
    expect(report.models[0]?.kind).toBe("estimated");
    expect(report.estimatedFromOpenRouter).toBe(true);
});

test("non-OpenRouter calls without cost stay unpriced", async () => {
    const sessionDirectory = tempDir("vera-usage-unpriced-");
    await writeSession({
        directory: sessionDirectory,
        id: "local",
        at: NOW,
        messages: [
            assistant("openai-codex", "gpt-5.6-codex", usage()),
            assistant("faux", "scripted", usage()),
        ],
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.spend.combined).toBe(0);
    expect(report.totals.spend.unpricedCalls).toBe(2);
    expect(report.totals.calls).toBe(2);
    expect(report.sessions[0]?.costKind).toBe("unpriced");
    expect(report.models.every((row) => row.kind === "unpriced")).toBe(true);
});

test("parent combined cost includes descendants; totals count each call once", async () => {
    const sessionDirectory = tempDir("vera-usage-children-");
    await writeSession({
        directory: sessionDirectory,
        id: "parent",
        at: NOW,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 2 }),
        )],
    });
    await writeSession({
        directory: sessionDirectory,
        id: "child",
        at: NOW,
        parentId: "parent",
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 0.5 }),
        )],
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.spend.combined).toBeCloseTo(2.5, 8);
    expect(report.totals.calls).toBe(2);
    const parent = report.sessions.find((row) => row.id === "parent");
    const child = report.sessions.find((row) => row.id === "child");
    expect(parent).toMatchObject({
        own: 2,
        children: 0.5,
        combined: 2.5,
        kind: "interactive",
    });
    expect(child).toMatchObject({
        parentId: "parent",
        own: 0.5,
        children: 0,
        combined: 0.5,
        kind: "subagent",
    });
});

test("7d skips session files whose mtime is older than the window", async () => {
    const sessionDirectory = tempDir("vera-usage-mtime-");
    const oldAt = new Date(2026, 5, 1, 12, 0, 0);
    const path = await writeSession({
        directory: sessionDirectory,
        id: "ancient",
        at: oldAt,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 9 }),
        )],
    });
    const oldSeconds = oldAt.getTime() / 1000;
    await utimes(path, oldSeconds, oldSeconds);
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.calls).toBe(0);
    expect(report.totals.spend.combined).toBe(0);
});

test("windows keep calls by timestamp even when the file is recent", async () => {
    const sessionDirectory = tempDir("vera-usage-windows-");
    const path = join(sessionDirectory, "mixed.jsonl");
    const stamps = [
        new Date(2026, 5, 1, 12, 0, 0),
        new Date(2026, 7, 1, 12, 0, 0),
        new Date(2026, 7, 25, 12, 0, 0),
        NOW,
    ];
    let stamp = stamps[0]!;
    const store = await SessionStore.create(path, {
        sessionId: "mixed",
        cwd: "/work/vera",
        now: () => stamp,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });
    for (const call of [
        { at: stamps[0]!, cost: 1 },
        { at: stamps[1]!, cost: 2 },
        { at: stamps[2]!, cost: 4 },
        { at: stamps[3]!, cost: 8 },
    ]) {
        stamp = call.at;
        await store.appendMessage(assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: call.cost }),
        ));
    }
    const fold = (window: "today" | "7d" | "30d" | "all") => foldUsageReport({
        sessionDirectory,
        window,
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect((await fold("today")).totals.spend.combined).toBe(8);
    expect((await fold("7d")).totals.spend.combined).toBe(12);
    expect((await fold("30d")).totals.spend.combined).toBe(14);
    expect((await fold("all")).totals.spend.combined).toBe(15);
});
