import { afterAll, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    renameSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { HostLogEntry } from "../../src/host/host-log.ts";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { packedAnnexRoot } from "../../src/release/layout.ts";
import { startAnnexServer } from "../../src/annex/server.ts";
import {
    foldUsageReport,
    type UsageReport,
} from "../../src/annex/usage-report.ts";
import { readAnnexUrlThroughHost } from "../../src/annex/host-client.ts";
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
    const server = await startAnnexServer({
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

    const root = await fetch(server.url);
    expect(root.status).toBe(404);

    const bad = await fetch(`${server.url}api/usage?window=year`);
    expect(bad.status).toBe(400);

    const response = await fetch(`${server.url}api/usage?window=7d`);
    expect(response.status).toBe(200);
    const report = await response.json() as UsageReport;
    expect(report.window.id).toBe("7d");
    expect(report.totals.spend.reported).toBeCloseTo(0.41, 8);
    expect(report.totals.calls).toBe(1);

    const page = await fetch(`${server.url}usage`);
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
    await expect(startAnnexServer({
        sessionDirectory,
        webRoot: tempDir("vera-usage-http-empty-"),
    })).rejects.toThrow(/Packed annex asset missing: .*index\.html/);
});

test("usage server defaults to the packed release annex root", async () => {
    await packWebAssets(packedAnnexRoot(), { force: true });
    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-usage-http-default-"),
    });
    servers.push(server);
    const page = await fetch(`${server.url}usage`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Vera · Usage");
});

test("resident host answers annex_url with a loopback base URL", async () => {
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
        const result = await readAnnexUrlThroughHost(host.server.socketPath);
        if (!("url" in result) || typeof result.url !== "string") {
            throw new Error(`expected annex url, got ${JSON.stringify(result)}`);
        }
        expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect(result.url.endsWith("/usage")).toBe(false);
        const page = await fetch(new URL("usage", result.url).href);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Vera · Usage");
        expect(host.health.annex).toBe("ok");
        expect(host.annexPid).toBeGreaterThan(0);
    } finally {
        await host.close();
    }
});

test("unreadable packed assets fail with an explicit path", async () => {
    const webRoot = await packedWebDir();
    chmodSync(join(webRoot, "index.html"), 0);
    try {
        await expect(startAnnexServer({
            sessionDirectory: tempDir("vera-usage-http-unreadable-"),
            webRoot,
        })).rejects.toThrow(/Packed annex asset (missing|unreadable): .*index\.html/);
    } finally {
        chmodSync(join(webRoot, "index.html"), 0o600);
    }
});

test("missing packed assets report annex: failed in host health", async () => {
    const root = tempDir("vera-usage-health-");
    const entries: HostLogEntry[] = [];
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
        webRoot: tempDir("vera-usage-health-empty-"),
        startupLog: (entry) => entries.push(entry),
    });
    try {
        expect(host.health.annex).toBe("failed");
        expect(host.health.annexReason).toMatch(/Packed annex asset missing:/);
        const failed = entries.find((entry) => entry.type === "annex_failed");
        expect(failed).toMatchObject({
            type: "annex_failed",
            health: "annex: failed",
        });
        expect(String(failed?.message)).toMatch(/Packed annex asset missing:/);
        const result = await readAnnexUrlThroughHost(host.server.socketPath);
        if (!("unavailable" in result) || typeof result.unavailable !== "string") {
            throw new Error(`expected annex unavailable, got ${JSON.stringify(result)}`);
        }
        expect(result.unavailable).toMatch(/Packed annex asset missing:/);
        expect(result.unavailable).toContain("Restart the host to bring the annex back");
    } finally {
        await host.close();
    }
});

test("packed host serves usage with clients/annex and react hidden", async () => {
    const webRoot = await packedWebDir();
    const hostRoot = tempDir("vera-usage-hidden-");
    const repoRoot = resolve(import.meta.dir, "../..");
    const sourceWeb = join(repoRoot, "clients", "annex");
    const react = join(repoRoot, "node_modules", "react");
    const hiddenWeb = `${sourceWeb}.hidden-${process.pid}`;
    const hiddenReact = `${react}.hidden-${process.pid}`;
    if (!existsSync(sourceWeb)) {
        throw new Error(`clients/annex is missing at ${sourceWeb}`);
    }
    if (!existsSync(react)) {
        throw new Error(
            "node_modules/react is missing, run bun install in this worktree",
        );
    }
    try {
        renameSync(sourceWeb, hiddenWeb);
        renameSync(react, hiddenReact);
        const serve = resolve(import.meta.dir, "usage-packed-serve.ts");
        const ran = Bun.spawnSync(["bun", serve, webRoot, hostRoot], {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env },
        });
        if (ran.exitCode !== 0) {
            throw new Error(ran.stderr.toString() || `exit ${ran.exitCode}`);
        }
        expect(ran.exitCode).toBe(0);
        expect(ran.stdout.toString()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\n$/);
    } finally {
        if (existsSync(hiddenWeb) && !existsSync(sourceWeb)) {
            renameSync(hiddenWeb, sourceWeb);
        }
        if (existsSync(hiddenReact) && !existsSync(react)) {
            renameSync(hiddenReact, react);
        }
    }
});
