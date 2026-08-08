import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    admitToPool,
    declaredPoolEntry,
    type PoolAdmissionStep,
} from "../../src/model/pool-admission.ts";
import {
    FEED_FRESHNESS_MS,
    createFeedRowReader,
} from "../../src/model/feed-cache.ts";
import type {
    ModelFeed,
    ModelFeedRow,
} from "../../src/model/feed-shape.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelStream,
    type ModelStreamEvent,
} from "../../src/model/types.ts";

test("a catalog model enters with its description copied into the entry", () => {
    expect(declaredPoolEntry({
        id: "glm-5.2",
        label: "GLM-5.2",
        tool_support: true,
        context_window: 200_000,
        levels: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
        ],
    })).toEqual({
        added: true,
        tools: true,
        context: 200_000,
        efforts: { high: "high", low: "low" },
    });
});

test("the provider's word for no reasoning lands on the ladder rung", () => {
    expect(declaredPoolEntry({
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        levels: [{ id: "none", label: "None" }, { id: "xhigh", label: "XHigh" }],
    })).toEqual({ added: true, efforts: { off: "none", xhigh: "xhigh" } });
});

test("a level the ladder cannot name is left out of the entry", () => {
    expect(declaredPoolEntry({
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        levels: [{ id: "ultra", label: "Ultra" }, { id: "high", label: "High" }],
    })).toEqual({ added: true, efforts: { high: "high" } });
});

test("a model the catalog never heard of enters on safe defaults", () => {
    // Nothing is claimed on its behalf, so nothing constrains it either: the
    // entry records only that the user added it, and every fact about the
    // model is still open.
    expect(declaredPoolEntry(undefined)).toEqual({ added: true });
});

test("a catalog model with no levels declares no efforts at all", () => {
    expect(declaredPoolEntry({
        id: "plain",
        label: "Plain",
        levels: [],
    })).toEqual({ added: true });
});

const FEED_VERIFIED_AT = "2026-08-06T00:00:00.000Z";

function feedRow(overrides: Partial<ModelFeedRow> = {}): ModelFeedRow {
    return {
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        verdict: "added",
        verified_levels: ["low", "high"],
        response_model: "qwen/qwen3-coder-480b",
        verified_at: FEED_VERIFIED_AT,
        ...overrides,
    };
}

function feedOf(rows: readonly ModelFeedRow[]): ModelFeed {
    return {
        schema_version: 1,
        generated_at: FEED_VERIFIED_AT,
        models: rows,
    };
}

/** A real pool file for the run, restored afterwards. */
function realPoolFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pool-admission-"));
    poolDirectories.push(directory);
    const path = join(directory, "pool.json");
    process.env.VERA_POOL_FILE = path;
    return path;
}

const poolDirectories: string[] = [];
const previousPoolFile = process.env.VERA_POOL_FILE;

afterEach(() => {
    if (previousPoolFile === undefined) {
        delete process.env.VERA_POOL_FILE;
    } else {
        process.env.VERA_POOL_FILE = previousPoolFile;
    }
    for (const directory of poolDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

/**
 * Records every stream call and answers an outage, so a skipped probe is
 * visible as zero calls and a taken one ends as `unavailable`.
 */
function recordingAdapter(calls: string[]): ModelAdapter {
    return {
        stream(request) {
            calls.push(request.model);
            return outageStream(request.model);
        },
    };
}

function outageStream(model: string): ModelStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [],
        source: { provider: "recording", api: "recording", model },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: "provider is down",
    };
    const events: ModelStreamEvent[] = [{
        type: "error",
        error: new Error("provider is down"),
        message,
    }];
    const iterator = (async function* stream() {
        yield* events;
    })();
    return {
        [Symbol.asyncIterator]: () => iterator,
        result: () => Promise.resolve(message),
    } as ModelStream;
}

test("a fresh feed row admits the model without probing it", async () => {
    const path = realPoolFile();
    const calls: string[] = [];
    const now = new Date(Date.parse(FEED_VERIFIED_AT) + 1_000);

    const outcome = await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        () => {},
        {
            verify: true,
            createAdapter: () => recordingAdapter(calls),
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed(feedOf([feedRow()])),
                now: () => now,
            }),
        },
    );

    expect(outcome).toEqual({ verdict: "added" });
    expect(calls).toEqual([]);
    const entry = JSON.parse(readFileSync(path, "utf8"))
        .models["openrouter/qwen/qwen3-coder"];
    expect(entry.added).toBe(true);
    expect(entry.learned.probe).toEqual({
        ok: true,
        seen: FEED_VERIFIED_AT,
        checked: "vera",
        wire: "qwen/qwen3-coder-480b",
    });
    expect(entry.learned.tools.checked).toBe("vera");
    expect(entry.learned["efforts.high"].ok).toBe(true);
    expect(entry.learned.images).toBeUndefined();
});

test("the fast path reports one step naming the feed, not a local verify", async () => {
    realPoolFile();
    const steps: PoolAdmissionStep[] = [];

    await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        (step) => steps.push(step),
        {
            verify: true,
            createAdapter: () => recordingAdapter([]),
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed(feedOf([feedRow()])),
                now: () => new Date(Date.parse(FEED_VERIFIED_AT) + 1_000),
            }),
        },
    );

    expect(steps.map((step) => step.status)).toEqual(["running", "passed"]);
    expect(steps.map((step) => step.step)).toEqual(["feed", "feed"]);
    expect(steps[0]?.label).toBe("In Vera's verified models");
    expect(steps[1]?.detail).toBe(
        `provider configured, verified ${FEED_VERIFIED_AT}`,
    );
});

test("a feed hit with no configured provider does not admit the model", async () => {
    const path = realPoolFile();

    const outcome = await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        () => {},
        {
            verify: true,
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed(feedOf([feedRow()])),
                now: () => new Date(Date.parse(FEED_VERIFIED_AT) + 1_000),
            }),
        },
    );

    expect(outcome).toEqual({
        verdict: "unavailable",
        reason: "provider is not configured",
    });
    expect(existsSync(path)).toBe(false);
});

test("a feed hit whose adapter cannot be built reports the adapter's reason", async () => {
    const path = realPoolFile();
    const steps: PoolAdmissionStep[] = [];

    const outcome = await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        (step) => steps.push(step),
        {
            verify: true,
            createAdapter: () => {
                throw new Error("no credentials for openrouter");
            },
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed(feedOf([feedRow()])),
                now: () => new Date(Date.parse(FEED_VERIFIED_AT) + 1_000),
            }),
        },
    );

    expect(outcome).toEqual({
        verdict: "unavailable",
        reason: "no credentials for openrouter",
    });
    expect(steps).toEqual([]);
    expect(existsSync(path)).toBe(false);
});

test("a model the feed does not carry is probed locally", async () => {
    realPoolFile();
    const calls: string[] = [];

    const outcome = await admitToPool(
        { provider: "openrouter", model: "some/other-model" },
        () => {},
        {
            verify: true,
            createAdapter: () => recordingAdapter(calls),
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed(feedOf([feedRow()])),
                now: () => new Date(Date.parse(FEED_VERIFIED_AT) + 1_000),
            }),
        },
    );

    expect(calls).toContain("some/other-model");
    expect(outcome.verdict).not.toBe("added");
});

test("a row older than the freshness window does not vouch for a skip", async () => {
    realPoolFile();
    const calls: string[] = [];
    const stale = new Date(
        Date.parse(FEED_VERIFIED_AT) + FEED_FRESHNESS_MS + 1_000,
    );

    await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        () => {},
        {
            verify: true,
            createAdapter: () => recordingAdapter(calls),
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed(feedOf([feedRow()])),
                now: () => stale,
            }),
        },
    );

    expect(calls).toContain("qwen/qwen3-coder");
});

test("an unreachable feed degrades to the local probe", async () => {
    realPoolFile();
    const calls: string[] = [];

    await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        () => {},
        {
            verify: true,
            createAdapter: () => recordingAdapter(calls),
            readFeedRow: createFeedRowReader({
                url: "https://example.test/feed.json",
                fetch: () => Promise.reject(new Error("offline")),
                shippedPath: join(tmpdir(), "vera-feed-does-not-exist.json"),
            }),
        },
    );

    expect(calls).toContain("qwen/qwen3-coder");
});

test("a malformed feed degrades to the local probe", async () => {
    realPoolFile();
    const calls: string[] = [];

    await admitToPool(
        { provider: "openrouter", model: "qwen/qwen3-coder" },
        () => {},
        {
            verify: true,
            createAdapter: () => recordingAdapter(calls),
            readFeedRow: createFeedRowReader({
                shippedPath: writeFeed("not a feed at all"),
            }),
        },
    );

    expect(calls).toContain("qwen/qwen3-coder");
});

function writeFeed(value: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-feed-"));
    poolDirectories.push(directory);
    const path = join(directory, "feed.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
}
