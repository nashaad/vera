import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasEstimatedSpend } from "../../clients/annex/estimate-basis.ts";
import { spendShare } from "../../clients/annex/model-table.ts";
import {
    chooseTimelineBucket,
    foldUsageReport,
    foldUsageSessionDetail,
    estimateUsd,
} from "../../src/annex/usage-report.ts";
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
    tools?: readonly string[],
): ModelMessage {
    return {
        role: "assistant",
        content: [
            { type: "text", text: "ok" },
            ...(tools ?? []).map((name) => ({
                type: "tool_call" as const,
                id: `${name}-1`,
                name,
                input: {},
            })),
        ],
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

test("estimateUsd prices cache writes at the write rate, or input when unlisted", () => {
    const written = usage({
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteInputTokens: 300_000,
        outputTokens: 0,
    });
    // 500k uncached at 3, 200k cached at 0.3, 300k written at 3.75.
    expect(estimateUsd(written, { input: 3, output: 15, cache: 0.3, cacheWrite: 3.75 }))
        .toBeCloseTo(1.5 + 0.06 + 1.125, 8);
    expect(estimateUsd(written, { input: 3, output: 15, cache: 0.3 }))
        .toBeCloseTo(1.5 + 0.06 + 0.9, 8);
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

test("direct DeepSeek calls estimate missing costs without replacing reported costs", async () => {
    const sessionDirectory = tempDir("vera-usage-deepseek-");
    const at = new Date("2026-11-16T02:00:00Z");
    await writeSession({
        directory: sessionDirectory,
        id: "estimated-deepseek",
        at,
        messages: [assistant("deepseek", "deepseek-flash", usage({
            inputTokens: 1_000_000,
            cachedInputTokens: 200_000,
            outputTokens: 500_000,
            totalTokens: 1_500_000,
        }))],
    });
    await writeSession({
        directory: sessionDirectory,
        id: "reported-deepseek",
        at,
        messages: [assistant("deepseek", "deepseek-v4-pro", usage({ cost: 5 }))],
    });
    await writeSession({
        directory: sessionDirectory,
        id: "unknown-deepseek",
        at,
        messages: [assistant("deepseek", "unknown-model", usage())],
    });
    await writeSession({
        directory: sessionDirectory,
        id: "other-provider-flash",
        at,
        messages: [assistant("other-provider", "deepseek-flash", usage())],
    });
    const options = {
        sessionDirectory,
        window: "all" as const,
        now: at,
        catalogCacheDir: catalogDir(),
    };
    const report = await foldUsageReport(options);
    expect(report.totals.spend.reported).toBe(5);
    expect(report.totals.spend.estimated).toBeCloseTo(0.8412, 10);
    expect(report.totals.spend.unpricedCalls).toBe(2);
    expect(report.estimatedFromOpenRouter).toBe(false);
    expect(hasEstimatedSpend(report)).toBe(true);
    const estimated = report.models.find((row) => row.model === "deepseek-flash");
    expect(estimated?.kind).toBe("estimated");
    expect(estimated === undefined ? undefined : spendShare([estimated]))
        .toEqual({ label: "14%", percentage: 14 });
    expect(report.models.find((row) => row.model === "unknown-model")?.kind).toBe("unpriced");
    expect(report.models.find((row) => row.provider === "other-provider")?.kind).toBe("unpriced");
    expect(report.models.find((row) => row.model === "deepseek-v4-pro")?.kind).toBe("reported");
    const detail = await foldUsageSessionDetail({ ...options, sessionId: "estimated-deepseek" });
    expect(detail?.calls[0]?.costKind).toBe("estimated");
    expect(detail?.calls[0]?.cost).toBeCloseTo(0.8412, 10);
});

test("other provider calls without cost stay unpriced", async () => {
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
        costKind: "reported",
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
    });
    expect(child).toMatchObject({
        parentId: "parent",
        own: 0.5,
        children: 0,
        combined: 0.5,
        kind: "subagent",
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
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

test("assistant tool_call names roll up per model", async () => {
    const sessionDirectory = tempDir("vera-usage-tools-");
    await writeSession({
        directory: sessionDirectory,
        id: "tools",
        at: NOW,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 0.2 }),
            ["bash", "bash", "read"],
        )],
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.models[0]?.tools).toEqual([
        { name: "bash", calls: 2 },
        { name: "read", calls: 1 },
    ]);
});

test("compaction billed usage counts as a compaction call", async () => {
    const sessionDirectory = tempDir("vera-usage-compact-");
    const path = join(sessionDirectory, "compacted.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "compacted",
        cwd: "/work/vera",
        now: () => NOW,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });
    const first = await store.appendMessage(assistant(
        "openrouter",
        "anthropic/claude-sonnet-4",
        usage({ cost: 1 }),
    ));
    await store.appendCompaction({
        boundaryMessageId: first.id,
        firstRetainedMessageId: null,
        projection: [{
            role: "user",
            content: [{ type: "text", text: "summary" }],
        }],
        measured: { inputTokens: 10, estimated: true },
        billed: {
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4",
            usage: usage({ cost: 0.05 }),
        },
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.calls).toBe(2);
    expect(report.totals.spend.combined).toBeCloseTo(1.05, 8);
    const detail = await foldUsageSessionDetail({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
        sessionId: "compacted",
    });
    expect(detail?.calls.some((call) => call.kind === "compaction")).toBe(true);
});

test("session detail lists own calls and child spend separately", async () => {
    const sessionDirectory = tempDir("vera-usage-detail-");
    await writeSession({
        directory: sessionDirectory,
        id: "parent",
        at: NOW,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 2 }),
            ["edit"],
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
    const detail = await foldUsageSessionDetail({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
        sessionId: "parent",
    });
    expect(detail?.session.combined).toBeCloseTo(2.5, 8);
    expect(detail?.calls).toHaveLength(1);
    expect(detail?.calls[0]).toMatchObject({
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
    });
    expect(detail?.children).toHaveLength(1);
    expect(detail?.totals.calls).toBe(2);
    expect(detail?.totals.totalTokens).toBe(2_200);
});

test("7d prior totals count the previous week, not the current one", async () => {
    const sessionDirectory = tempDir("vera-usage-prior-");
    const previous = new Date(2026, 7, 20, 12, 0, 0);
    const path = await writeSession({
        directory: sessionDirectory,
        id: "older",
        at: previous,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 3 }),
        )],
    });
    await writeSession({
        directory: sessionDirectory,
        id: "current",
        at: NOW,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 1 }),
        )],
    });
    const previousSeconds = previous.getTime() / 1000;
    await utimes(path, previousSeconds, previousSeconds);
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.spend.combined).toBeCloseTo(1, 8);
    expect(report.prior?.spend.combined).toBeCloseTo(3, 8);
});

test("an old parent of a recent child still appears on the leaderboard", async () => {
    const sessionDirectory = tempDir("vera-usage-old-parent-");
    const oldAt = new Date(2026, 5, 1, 12, 0, 0);
    const parentPath = await writeSession({
        directory: sessionDirectory,
        id: "parent",
        at: oldAt,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost: 1 }),
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
            usage({ cost: 0.4 }),
        )],
    });
    const oldSeconds = oldAt.getTime() / 1000;
    await utimes(parentPath, oldSeconds, oldSeconds);
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    const parent = report.sessions.find((row) => row.id === "parent");
    expect(parent).toMatchObject({
        own: 0,
        children: 0.4,
        combined: 0.4,
        costKind: "reported",
    });
});

test("combined costKind includes descendant calls, not only own", async () => {
    const sessionDirectory = tempDir("vera-usage-kind-tree-");
    await writeSession({
        directory: sessionDirectory,
        id: "parent",
        at: NOW,
        messages: [assistant("omlx", "local", usage())],
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
    const parent = report.sessions.find((row) => row.id === "parent");
    expect(parent).toMatchObject({
        own: 0,
        children: 0.5,
        combined: 0.5,
        costKind: "mixed",
    });
});

test("own reported plus estimated is mixed, not estimated", async () => {
    const sessionDirectory = tempDir("vera-usage-mixed-own-");
    await writeSession({
        directory: sessionDirectory,
        id: "mix",
        at: NOW,
        messages: [
            assistant(
                "openrouter",
                "anthropic/claude-sonnet-4",
                usage({ cost: 2 }),
            ),
            assistant(
                "openrouter",
                "anthropic/claude-sonnet-4",
                usage(),
            ),
        ],
    });
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.sessions[0]?.costKind).toBe("mixed");
    expect(report.models[0]?.kind).toBe("mixed");
});

test("reviewer spend in the prior window counts toward prior totals", async () => {
    const sessionDirectory = tempDir("vera-usage-review-prior-");
    const previous = new Date(2026, 7, 20, 12, 0, 0);
    const logPath = join(tempDir("vera-usage-review-log-"), "reviewer.jsonl");
    writeFileSync(logPath, [
        JSON.stringify({
            timestamp: previous.toISOString(),
            type: "tool_review",
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4",
            usage: usage({ cost: 4 }),
            sessionId: "older",
        }),
        JSON.stringify({
            timestamp: NOW.toISOString(),
            type: "tool_review",
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4",
            usage: usage({ cost: 1 }),
            sessionId: "current",
        }),
    ].join("\n") + "\n");
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
        reviewLogPath: logPath,
    });
    expect(report.totals.spend.combined).toBeCloseTo(1, 8);
    expect(report.prior?.spend.combined).toBeCloseTo(4, 8);
});

function writeRunSpans(
    workflowDirectory: string,
    runId: string,
    calls: readonly {
        readonly at: Date;
        readonly attributes: Record<string, unknown>;
        readonly open?: boolean;
    }[],
): void {
    const runDir = join(workflowDirectory, runId);
    mkdirSync(runDir, { recursive: true });
    const lines: string[] = [];
    calls.forEach((call, index) => {
        const spanId = `a1.${index + 1}.1`;
        lines.push(JSON.stringify({
            trace_id: runId,
            span_id: spanId,
            parent_id: `a1.${index + 1}`,
            name: "openai/gpt-5.6-luna",
            start_time: call.at.toISOString(),
            attributes: {
                "openinference.span.kind": "LLM",
                "halcyon.attempt": 1,
                "halcyon.step.key": `writer/draft#${index}:x`,
                "llm.model_name": "anthropic/claude-sonnet-4",
                "llm.provider": "openrouter",
            },
        }));
        if (call.open === true) return;
        lines.push(JSON.stringify({
            span_id: spanId,
            end_time: call.at.toISOString(),
            status_code: "OK",
            attributes: {
                "halcyon.outcome": "ok",
                "halcyon.duration_ms": 10,
                ...call.attributes,
            },
        }));
    });
    writeFileSync(join(runDir, "spans.ndjson"), lines.join("\n") + "\n");
}

test("halcyon model calls count toward totals but add no conversation", async () => {
    const sessionDirectory = tempDir("vera-usage-workflow-sessions-");
    const workflowDirectory = tempDir("vera-usage-workflows-");
    writeRunSpans(workflowDirectory, "wf_0000000000000001", [
        {
            at: NOW,
            attributes: {
                "llm.token_count.prompt": 1_000,
                "llm.token_count.completion": 100,
                "llm.token_count.total": 1_100,
                "llm.cost.total": 0.25,
            },
        },
        {
            at: NOW,
            attributes: {
                "llm.token_count.prompt": 1_000_000,
                "llm.token_count.completion": 500_000,
                "llm.token_count.prompt_details.cache_read": 200_000,
                "llm.token_count.total": 1_500_000,
            },
        },
        { at: NOW, attributes: {}, open: true },
    ]);
    writeRunSpans(workflowDirectory, "wf_0000000000000002", [{
        at: new Date(2026, 7, 20, 12, 0, 0),
        attributes: {
            "llm.token_count.prompt": 10,
            "llm.token_count.completion": 10,
            "llm.token_count.total": 20,
            "llm.cost.total": 4,
        },
    }]);
    const report = await foldUsageReport({
        sessionDirectory,
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
        workflowDirectory,
    });
    expect(report.totals.calls).toBe(2);
    expect(report.totals.spend.reported).toBeCloseTo(0.25, 8);
    expect(report.totals.spend.estimated).toBeCloseTo(9.96, 8);
    expect(report.totals.cachedInputTokens).toBe(200_000);
    expect(report.prior?.spend.combined).toBeCloseTo(4, 8);
    expect(report.models[0]?.model).toBe("anthropic/claude-sonnet-4");
    expect(report.sessions).toEqual([]);
});

test("direct DeepSeek workflow calls use the same estimate", async () => {
    const workflowDirectory = tempDir("vera-usage-deepseek-workflow-");
    const at = new Date("2026-11-16T02:00:00Z");
    writeRunSpans(workflowDirectory, "wf_0000000000000004", [{
        at,
        attributes: {
            "llm.provider": "deepseek",
            "llm.model_name": "deepseek-flash",
            "llm.token_count.prompt": 1_000_000,
            "llm.token_count.prompt_details.cache_read": 200_000,
            "llm.token_count.completion": 500_000,
            "llm.token_count.total": 1_500_000,
        },
    }]);
    const report = await foldUsageReport({
        sessionDirectory: tempDir("vera-usage-deepseek-workflow-sessions-"),
        workflowDirectory,
        window: "all",
        now: at,
        catalogCacheDir: catalogDir(),
    });
    expect(report.totals.spend.estimated).toBeCloseTo(0.8412, 10);
    expect(report.estimatedFromOpenRouter).toBe(false);
    expect(report.models[0]?.kind).toBe("estimated");
});

test("a run last written before the window is not read", async () => {
    const workflowDirectory = tempDir("vera-usage-workflows-stale-");
    writeRunSpans(workflowDirectory, "wf_0000000000000003", [{
        at: NOW,
        attributes: {
            "llm.token_count.prompt": 10,
            "llm.token_count.completion": 10,
            "llm.token_count.total": 20,
            "llm.cost.total": 1,
        },
    }]);
    const old = new Date(2026, 0, 1);
    await utimes(
        join(workflowDirectory, "wf_0000000000000003", "spans.ndjson"),
        old,
        old,
    );
    const report = await foldUsageReport({
        sessionDirectory: tempDir("vera-usage-workflow-stale-sessions-"),
        window: "7d",
        now: NOW,
        catalogCacheDir: catalogDir(),
        workflowDirectory,
    });
    expect(report.totals.calls).toBe(0);
});

function localKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

function localDay(year: number, monthIndex: number, day: number, hour = 12): Date {
    return new Date(year, monthIndex, day, hour, 0, 0);
}

function addLocalDays(date: Date, days: number): Date {
    return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() + days,
        date.getHours(),
    );
}

function writeCostSession(
    directory: string,
    id: string,
    at: Date,
    cost: number,
): Promise<string> {
    return writeSession({
        directory,
        id,
        at,
        messages: [assistant(
            "openrouter",
            "anthropic/claude-sonnet-4",
            usage({ cost }),
        )],
    });
}

test("@core timeline bucket keeps about 31 points and months are the coarsest", () => {
    expect(chooseTimelineBucket(1)).toBe("day");
    expect(chooseTimelineBucket(31)).toBe("day");
    expect(chooseTimelineBucket(32)).toBe("week");
    expect(chooseTimelineBucket(31 * 7)).toBe("week");
    expect(chooseTimelineBucket(32 * 7)).toBe("month");
    expect(chooseTimelineBucket(3650)).toBe("month");
});

test("a 31-day span uses daily buckets with empty days filled", async () => {
    const sessionDirectory = tempDir("vera-usage-timeline-day-");
    const now = localDay(2026, 8, 30, 15);
    const first = addLocalDays(now, -30);
    await writeCostSession(sessionDirectory, "first", first, 1);
    await writeCostSession(sessionDirectory, "later", addLocalDays(now, -15), 2);
    const report = await foldUsageReport({
        sessionDirectory,
        window: "all",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(report.timelineBucket).toBe("day");
    expect(report.timeline).toHaveLength(31);
    expect(report.timeline[0]).toMatchObject({
        start: localKey(first),
        end: localKey(first),
        spend: 1,
    });
    expect(report.timeline.at(-1)).toMatchObject({
        start: localKey(now),
        end: localKey(now),
        spend: 0,
    });
    expect(report.timeline.at(-1)?.byModel).toEqual([]);
    expect(new Set(report.timeline.map((point) => point.start)).size).toBe(31);
    expect(report.timeline.reduce((sum, point) => sum + point.spend, 0)).toBe(3);
});

test("a 32-day span starts weeks on Monday and pads empty and partial weeks", async () => {
    const sessionDirectory = tempDir("vera-usage-timeline-week-");
    const now = localDay(2026, 8, 30, 15);
    const first = addLocalDays(now, -31);
    await writeCostSession(sessionDirectory, "first", first, 1);
    await writeCostSession(sessionDirectory, "last", now, 2);
    const report = await foldUsageReport({
        sessionDirectory,
        window: "all",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(report.timelineBucket).toBe("week");
    expect(report.timeline.map((point) => [point.start, point.end, point.spend]))
        .toEqual([
            ["2026-08-24", "2026-08-30", 1],
            ["2026-08-31", "2026-09-06", 0],
            ["2026-09-07", "2026-09-13", 0],
            ["2026-09-14", "2026-09-20", 0],
            ["2026-09-21", "2026-09-27", 0],
            ["2026-09-28", "2026-09-30", 2],
        ]);
    expect(report.timeline[1]?.byModel).toEqual([]);
});

test("month buckets cross a year boundary and include empty months", async () => {
    const sessionDirectory = tempDir("vera-usage-timeline-month-");
    const now = localDay(2026, 1, 10, 15);
    await writeCostSession(
        sessionDirectory,
        "april",
        localDay(2025, 3, 20),
        1,
    );
    await writeCostSession(
        sessionDirectory,
        "january",
        localDay(2026, 0, 15),
        2,
    );
    const report = await foldUsageReport({
        sessionDirectory,
        window: "all",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(report.timelineBucket).toBe("month");
    expect(report.timeline.map((point) => point.start)).toEqual([
        "2025-04-01",
        "2025-05-01",
        "2025-06-01",
        "2025-07-01",
        "2025-08-01",
        "2025-09-01",
        "2025-10-01",
        "2025-11-01",
        "2025-12-01",
        "2026-01-01",
        "2026-02-01",
    ]);
    expect(report.timeline[0]).toMatchObject({ end: "2025-04-30", spend: 1 });
    expect(report.timeline[7]).toMatchObject({
        end: "2025-11-30",
        spend: 0,
        byModel: [],
    });
    expect(report.timeline[8]).toMatchObject({
        start: "2025-12-01",
        end: "2025-12-31",
        spend: 0,
    });
    expect(report.timeline[9]).toMatchObject({
        start: "2026-01-01",
        end: "2026-01-31",
        spend: 2,
    });
    expect(report.timeline[10]).toMatchObject({
        start: "2026-02-01",
        end: "2026-02-10",
        spend: 0,
    });
    expect(report.timeline.reduce((sum, point) => sum + point.spend, 0)).toBe(3);
});

test("the 31-week boundary picks weeks and 32 weeks picks months", async () => {
    const now = localDay(2026, 8, 30, 15);
    const weeks = tempDir("vera-usage-timeline-31-weeks-");
    await writeCostSession(weeks, "first", addLocalDays(now, -216), 1);
    const weekReport = await foldUsageReport({
        sessionDirectory: weeks,
        window: "all",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(weekReport.timelineBucket).toBe("week");
    expect(weekReport.timeline.length).toBeLessThanOrEqual(32);
    expect(new Date(`${weekReport.timeline[0]?.start}T00:00:00`).getDay()).toBe(1);

    const months = tempDir("vera-usage-timeline-32-weeks-");
    await writeCostSession(months, "first", addLocalDays(now, -223), 1);
    const monthReport = await foldUsageReport({
        sessionDirectory: months,
        window: "all",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(monthReport.timelineBucket).toBe("month");
    expect(monthReport.timeline[0]?.start).toBe("2026-02-01");
});

test("a single-day window is one bucket", async () => {
    const sessionDirectory = tempDir("vera-usage-timeline-single-");
    const now = localDay(2026, 8, 30, 15);
    await writeCostSession(sessionDirectory, "only", localDay(2026, 8, 30, 9), 1);
    const today = await foldUsageReport({
        sessionDirectory,
        window: "today",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(today.timelineBucket).toBe("day");
    expect(today.timeline).toEqual([{
        start: localKey(now),
        end: localKey(now),
        spend: 1,
        byModel: [{
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4",
            spend: 1,
        }],
    }]);
    const all = await foldUsageReport({
        sessionDirectory,
        window: "all",
        now,
        catalogCacheDir: catalogDir(),
    });
    expect(all.timeline).toHaveLength(1);
});

test("an empty window has no timeline points", async () => {
    const report = await foldUsageReport({
        sessionDirectory: tempDir("vera-usage-timeline-empty-"),
        window: "all",
        now: NOW,
        catalogCacheDir: catalogDir(),
    });
    expect(report.timeline).toEqual([]);
    expect(report.timelineBucket).toBe("day");
});
