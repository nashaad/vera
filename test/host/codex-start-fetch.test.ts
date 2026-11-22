import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { fetchCodexCatalogAtStart } from "../../src/host/codex-start-refresh.ts";
import { defaultHostLogPath } from "../../src/host/host-log.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import type { ModelSettingsUpdate } from "../../src/engine/protocol.ts";
import {
    providerCatalogCacheDir,
    providerCatalogCachePath,
    writeProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import { normalizeCodexModelCache } from "../../src/model/codex-catalog.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

const fixtureText = readFileSync(
    new URL("../fixtures/codex-models-cache.json", import.meta.url),
    "utf8",
);
const fixture = JSON.parse(fixtureText) as unknown;
const fixtureModelCount = normalizeCodexModelCache(fixture).models.length;

const isolatedEnvironment = [
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "CEREBRAS_API_KEY",
    "OLLAMA_HOST",
] as const;
const savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
    for (const key of isolatedEnvironment) {
        savedEnvironment.set(key, process.env[key]);
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of isolatedEnvironment) {
        const value = savedEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function scratch(prefix: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function signedIn(): AuthStorage {
    return {
        getCredential: (provider: string) => provider === "openai-codex"
            ? {
                type: "oauth" as const,
                token: JSON.stringify({
                    schema_version: 1,
                    access_token: "access-1",
                    refresh_token: "refresh-1",
                    expires_at: Date.now() + 3_600_000,
                    account_id: "account-1",
                }),
            }
            : undefined,
        setCredential: () => {},
        deleteCredential: () => {},
    };
}

function signedOut(): AuthStorage {
    return {
        getCredential: () => undefined,
        setCredential: () => {},
        deleteCredential: () => {},
    };
}

function writeConfig(root: string): string {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        approval_mode: "ask",
        curated_models_url: "",
        provider_endpoints: { ollama: "http://127.0.0.1:1" },
    }));
    return path;
}

function writeOtherBuildCache(root: string): string {
    const cacheDir = providerCatalogCacheDir(root);
    mkdirSync(cacheDir, { recursive: true });
    const path = providerCatalogCachePath("openai-codex", cacheDir);
    const contents = JSON.stringify({
        ...normalizeCodexModelCache(fixture),
        build_id: "vera-another-build",
    });
    writeFileSync(path, contents);
    return contents;
}

function writeCurrentBuildCache(root: string): void {
    writeProviderCatalogSnapshot(
        normalizeCodexModelCache(fixture),
        { cacheDir: providerCatalogCacheDir(root) },
    );
}

interface FakeCodex {
    readonly baseUrl: string;
    readonly requests: { count: number };
    stop(): void;
}

function fakeCodex(
    respond: (request: Request) => Response | Promise<Response>,
): FakeCodex {
    const requests = { count: 0 };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            requests.count += 1;
            return respond(request);
        },
    });
    return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        requests,
        stop: () => server.stop(true),
    };
}

// Catalog fetches other than the Codex request fail loudly instead of reaching
// a provider; the arena download treats that as nothing new.
function codexCatalogFetch(
    baseUrl: string | undefined,
    respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
    const prefix = baseUrl === undefined ? undefined : `${baseUrl}/models`;
    return (async (input, init) => {
        if (prefix === undefined || String(input).startsWith(prefix)) {
            return await respond(input, init);
        }
        throw new Error("unexpected catalog request");
    }) as typeof globalThis.fetch;
}

function failingCatalogFetch(): typeof globalThis.fetch {
    return (async () => { throw new Error("unexpected catalog request"); }) as unknown as typeof globalThis.fetch;
}

function countingCodexFetch(): { fetch: typeof globalThis.fetch; requests: { count: number } } {
    const requests = { count: 0 };
    const fetch = (async (input: string | URL | Request) => {
        if (String(input).includes("/backend-api/codex/models")) requests.count += 1;
        throw new Error("unexpected catalog request");
    }) as unknown as typeof globalThis.fetch;
    return { fetch, requests };
}

async function startHost(
    root: string,
    options: {
        readonly authStorage?: AuthStorage;
        readonly codexCatalogBaseUrl?: string;
        readonly catalogFetch?: typeof globalThis.fetch;
        readonly skipStartupDiscovery?: boolean;
    } = {},
): Promise<ResidentHost> {
    return await startResidentHost({
        config: loadVeraConfig({ path: join(root, "config.json") }),
        home: root,
        authStorage: options.authStorage ?? signedIn(),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
        ...(options.codexCatalogBaseUrl === undefined
            ? {}
            : { codexCatalogBaseUrl: options.codexCatalogBaseUrl }),
        ...(options.catalogFetch === undefined ? {} : { catalogFetch: options.catalogFetch }),
        ...(options.skipStartupDiscovery === true ? { skipStartupDiscovery: true } : {}),
    });
}

function readLog(root: string): Array<{ readonly type: string } & Record<string, unknown>> {
    try {
        return readFileSync(defaultHostLogPath(root), "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as { readonly type: string } & Record<string, unknown>);
    } catch {
        return [];
    }
}

async function waitFor<T>(
    read: () => T | undefined,
    done: (value: T) => boolean,
    what: string,
    timeoutMs = 8_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = read();
        if (value !== undefined && done(value)) return value;
        await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

async function receiveModelSettings(
    attachment: AgentAttachment,
    done: (update: ModelSettingsUpdate) => boolean,
    timeoutMs = 8_000,
): Promise<ModelSettingsUpdate> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const update = await attachment.receive(
            AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        );
        if (update.type === "model_settings" && done(update)) return update;
    }
    throw new Error("Timed out waiting for model settings");
}

function codexModels(update: ModelSettingsUpdate): readonly string[] {
    return (update.settings.availableModels ?? [])
        .filter((model) => model.provider === "openai-codex")
        .map((model) => model.model);
}

function withHome(root: string): () => void {
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = root;
    return () => {
        if (previous === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
        else process.env.VERA_HOME = previous;
    };
}

socketAndLoopbackTest(
    "an other-build Codex cache is fetched once after start and the rows are announced",
    async () => {
        const root = scratch("vera-codex-start-fetch-");
        const restoreHome = withHome(root);
        const seeded = writeOtherBuildCache(root);
        writeConfig(root);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const endpoint = fakeCodex(async () => {
            await held;
            return Response.json(fixture);
        });
        let host: ResidentHost | undefined;
        let attachment: AgentAttachment | undefined;
        try {
            host = await startHost(root, {
                codexCatalogBaseUrl: endpoint.baseUrl,
                catalogFetch: codexCatalogFetch(
                    endpoint.baseUrl,
                    (input, init) => globalThis.fetch(input, init),
                ),
            });
            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });
            attachment = agent.attach();
            while ((await attachment.receive(AbortSignal.timeout(5_000))).type !== "history") {
                // Wait for the session to attach.
            }
            const before = await host.registry.readHostModelSettings(root);
            expect(before?.availableModels?.some((model) =>
                model.provider === "openai-codex" && model.model === "gpt-5.6-terra"
            )).toBe(false);
            expect(endpoint.requests.count).toBe(1);

            release();
            const update = await receiveModelSettings(
                attachment,
                (value) => codexModels(value).includes("gpt-5.6-terra"),
            );
            expect(codexModels(update)).toContain("gpt-5.6-luna");
            expect(endpoint.requests.count).toBe(1);
            expect(readLog(root)).toContainEqual(expect.objectContaining({
                type: "codex_catalog_start_fetch",
                models: fixtureModelCount,
            }));
            expect(readFileSync(
                providerCatalogCachePath("openai-codex", providerCatalogCacheDir(root)),
                "utf8",
            )).not.toBe(seeded);
        } finally {
            release();
            attachment?.detach();
            await host?.close();
            endpoint.stop();
            restoreHome();
            rmSync(root, { recursive: true, force: true });
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "boot completes and the host answers while the Codex fetch hangs",
    async () => {
        const root = scratch("vera-codex-start-hang-");
        const restoreHome = withHome(root);
        writeConfig(root);
        const pending = Promise.withResolvers<Response>();
        let codexRequests = 0;
        const catalogFetch = (async (input: string | URL | Request) => {
            if (!String(input).includes("/backend-api/codex/models")) {
                throw new Error("unexpected catalog request");
            }
            codexRequests += 1;
            return await pending.promise;
        }) as typeof globalThis.fetch;
        let host: ResidentHost | undefined;
        try {
            const startedAt = Date.now();
            host = await startHost(root, { catalogFetch });
            expect(Date.now() - startedAt).toBeLessThan(5_000);
            const settings = await host.registry.readHostModelSettings(root);
            expect(settings).toBeDefined();
            expect(codexRequests).toBe(1);
        } finally {
            pending.resolve(Response.json(fixture));
            await host?.close();
            restoreHome();
            rmSync(root, { recursive: true, force: true });
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a failing start fetch keeps boot and the old cache and logs once",
    async () => {
        const root = scratch("vera-codex-start-fail-");
        const restoreHome = withHome(root);
        writeConfig(root);
        const seeded = writeOtherBuildCache(root);
        const endpoint = fakeCodex(() => new Response("down", { status: 503 }));
        let host: ResidentHost | undefined;
        try {
            host = await startHost(root, {
                codexCatalogBaseUrl: endpoint.baseUrl,
                catalogFetch: codexCatalogFetch(
                    endpoint.baseUrl,
                    (input, init) => globalThis.fetch(input, init),
                ),
            });
            const failed = await waitFor(
                () => readLog(root).find((line) => line.type === "codex_catalog_start_fetch_failed"),
                (line) => line !== undefined,
                "the failed start fetch",
            );
            expect(failed.failure).toBe("unavailable");
            expect(endpoint.requests.count).toBe(1);
            expect(readFileSync(
                providerCatalogCachePath("openai-codex", providerCatalogCacheDir(root)),
                "utf8",
            )).toBe(seeded);
            const settings = await host.registry.readHostModelSettings(root);
            expect(settings?.availableModels?.some((model) =>
                model.provider === "openai-codex" && model.model === "gpt-5.6-terra"
            )).toBe(false);
            const log = readLog(root);
            expect(log.filter((line) => line.type === "codex_catalog_start_fetch_failed")).toHaveLength(1);
            expect(log.some((line) => line.type === "codex_catalog_start_fetch")).toBe(false);
        } finally {
            await host?.close();
            endpoint.stop();
            restoreHome();
            rmSync(root, { recursive: true, force: true });
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a cache from this build is used without a fetch",
    async () => {
        const root = scratch("vera-codex-start-current-");
        const restoreHome = withHome(root);
        writeConfig(root);
        writeCurrentBuildCache(root);
        const counting = countingCodexFetch();
        let host: ResidentHost | undefined;
        try {
            host = await startHost(root, { catalogFetch: counting.fetch });
            const settings = await host.registry.readHostModelSettings(root);
            expect(settings?.availableModels?.some((model) =>
                model.provider === "openai-codex" && model.model === "gpt-5.6-terra"
            )).toBe(true);
            await Bun.sleep(200);
            expect(counting.requests.count).toBe(0);
            expect(readLog(root).some((line) => line.type.startsWith("codex_catalog_start_fetch"))).toBe(false);
        } finally {
            await host?.close();
            restoreHome();
            rmSync(root, { recursive: true, force: true });
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "no Codex credential means no start fetch",
    async () => {
        const root = scratch("vera-codex-start-signed-out-");
        const restoreHome = withHome(root);
        writeConfig(root);
        const counting = countingCodexFetch();
        let host: ResidentHost | undefined;
        try {
            host = await startHost(root, {
                authStorage: signedOut(),
                catalogFetch: counting.fetch,
            });
            await Bun.sleep(200);
            expect(counting.requests.count).toBe(0);
            expect(readLog(root).some((line) => line.type.startsWith("codex_catalog_start_fetch"))).toBe(false);
        } finally {
            await host?.close();
            restoreHome();
            rmSync(root, { recursive: true, force: true });
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "skipped startup discovery means no Codex start fetch",
    async () => {
        const root = scratch("vera-codex-start-skipped-");
        const restoreHome = withHome(root);
        writeConfig(root);
        const counting = countingCodexFetch();
        let host: ResidentHost | undefined;
        try {
            host = await startHost(root, {
                skipStartupDiscovery: true,
                catalogFetch: counting.fetch,
            });
            await Bun.sleep(200);
            expect(counting.requests.count).toBe(0);
            expect(readLog(root).some((line) => line.type.startsWith("codex_catalog_start_fetch"))).toBe(false);
        } finally {
            await host?.close();
            restoreHome();
            rmSync(root, { recursive: true, force: true });
        }
    },
    20_000,
);

// The host timeout bounds a hung request so the catalog queue keeps moving.
test("a hung start fetch gives up at its timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-codex-start-timeout-"));
    try {
        const logged: Array<{ readonly type: string } & Record<string, unknown>> = [];
        const outcome = await fetchCodexCatalogAtStart({
            authStorage: signedIn(),
            cacheDir: directory,
            log: (entry) => logged.push(entry),
            fetch: (async () => await new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch,
            timeoutMs: 25,
        });
        expect(outcome).toEqual({ status: "failed", failure: "timeout" });
        expect(logged).toContainEqual(expect.objectContaining({
            type: "codex_catalog_start_fetch_failed",
            failure: "timeout",
        }));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
