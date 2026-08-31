import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { startUsageWebServer } from "../../src/host/usage-http.ts";
import {
    foldUsageReport,
    type UsageReport,
} from "../../src/host/usage-report.ts";
import { readUsageWebUrlThroughHost } from "../../src/host/usage-web-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import type { ModelMessage, ModelUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
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
        cost: 0.41,
        ...overrides,
    };
}

async function packedWebDir(): Promise<string> {
    const directory = tempDir("vera-packed-web-");
    await packWebAssets(directory, { force: true });
    return directory;
}

async function writeSession(directory: string): Promise<void> {
    const path = join(directory, "live.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "live",
        cwd: "/work/vera",
        now: () => NOW,
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
    });
    const message: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        source: {
            provider: "openrouter",
            api: "openrouter",
            model: "anthropic/claude-sonnet-4",
        },
        usage: usage(),
        durationMs: 500,
        stopReason: "stop",
    };
    await store.appendMessage(message);
}

test("GET /api/usage?window=7d returns a folded report on loopback", async () => {
    const sessionDirectory = tempDir("vera-usage-http-");
    const cacheDir = tempDir("vera-usage-http-cache-");
    writeProviderCatalogSnapshot({
        schema_version: 2,
        provider: "openrouter",
        fetched_at: NOW.toISOString(),
        models: [{
            id: "anthropic/claude-sonnet-4",
            label: "Claude Sonnet 4",
            levels: [{ id: "medium", label: "Medium" }],
            pricing: { input: 3, output: 15 },
        }],
    }, { cacheDir });
    await writeSession(sessionDirectory);
    const server = await startUsageWebServer({
        sessionDirectory,
        catalogCacheDir: cacheDir,
        webRoot: await packedWebDir(),
        fold: (window) => foldUsageReport({
            sessionDirectory,
            window,
            now: NOW,
            catalogCacheDir: cacheDir,
        }),
    });
    servers.push(server);
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);

    const bad = await fetch(`${server.url}api/usage?window=year`);
    expect(bad.status).toBe(400);

    const response = await fetch(`${server.url}api/usage?window=7d`);
    expect(response.status).toBe(200);
    const report = await response.json() as UsageReport;
    expect(report.window.id).toBe("7d");
    expect(report.totals.spend.reported).toBeCloseTo(0.41, 8);
    expect(report.totals.calls).toBe(1);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Vera · Usage");

    const script = await fetch(`${server.url}main.js`);
    expect(script.status).toBe(200);
    const javascript = await script.text();
    expect(javascript).toContain("at current OpenRouter rates");
    expect(javascript).toContain("/api/usage");
    expect(javascript).toContain("/api/usage/session/");
    expect(javascript).toContain("aria-label");
    expect(javascript).toContain("Menu");
    expect(javascript).toContain("≡");
    expect(javascript).toContain("combobox");
    expect(javascript).toContain("nav-sidebar");
    expect(javascript).toContain("Close menu");
    expect(javascript).not.toContain("this machine · this profile");
    expect(javascript).not.toContain("this machine · loopback");

    const missing = await fetch(`${server.url}api/usage/session/nope?window=7d`);
    expect(missing.status).toBe(404);

    const detail = await fetch(`${server.url}api/usage/session/live?window=7d`);
    expect(detail.status).toBe(200);
    const body = await detail.json() as { session: { id: string }; calls: unknown[] };
    expect(body.session.id).toBe("live");
    expect(body.calls).toHaveLength(1);
});

test("missing packed assets fail with an explicit path", async () => {
    const sessionDirectory = tempDir("vera-usage-http-missing-");
    await expect(startUsageWebServer({
        sessionDirectory,
        webRoot: tempDir("vera-usage-http-empty-"),
    })).rejects.toThrow(/Packed web asset missing: .*index\.html/);
});

test("resident host answers usage_web with a loopback page", async () => {
    const root = tempDir("vera-usage-runtime-");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
        webRoot: await packedWebDir(),
    });
    try {
        const url = await readUsageWebUrlThroughHost(host.server.socketPath);
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const page = await fetch(url!);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Vera · Usage");
    } finally {
        await host.close();
    }
});
