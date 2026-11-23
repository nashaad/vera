import { expect, spyOn } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { forgetProviderThroughHost } from "../../src/host/provider-forget-client.ts";
import { setProviderEnabledThroughHost } from "../../src/host/provider-set-enabled-client.ts";
import { refreshCatalogThroughHost } from "../../src/host/model-settings-client.ts";
import { ControlPeer } from "../../src/host/pool/control.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import { socketAndLoopbackTest, socketTest } from "../support/socket-probe.ts";

const adapter: ModelAdapter = {
    stream() {
        const stream = new ModelEventStream();
        stream.push({ type: "start" });
        stream.push({
            type: "done",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                source: {
                    provider: "test-gateway",
                    api: "openai-chat-completions",
                    model: "alpha",
                },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        });
        return stream;
    },
};

interface Scratch {
    readonly root: string;
    readonly configPath: string;
    readonly socketPath: string;
    host?: ResidentHost;
    restoreHome: () => void;
}

async function scratch(prefix: string, config: Record<string, unknown>): Promise<Scratch> {
    const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = root;
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        approval_mode: "ask",
        ...config,
    }));
    return {
        root,
        configPath,
        socketPath: join(root, "host.sock"),
        restoreHome: () => {
            if (previousHome === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
            else process.env.VERA_HOME = previousHome;
        },
    };
}

async function start(
    scratch: Scratch,
    authStorage?: AuthStorage,
    extra: { processWorker?: boolean; skipStartupDiscovery?: boolean } = {},
): Promise<ResidentHost> {
    const host = await startResidentHost({
        config: loadVeraConfig({ path: scratch.configPath }),
        home: scratch.root,
        ...(extra.processWorker === true ? {} : { createAdapter: () => adapter }),
        ...(authStorage === undefined ? {} : { authStorage }),
        ...extra,
        socketPath: scratch.socketPath,
        lockPath: join(scratch.root, "host.json"),
        sessionDirectory: join(scratch.root, "sessions"),
        eventLogDirectory: join(scratch.root, "logs"),
    });
    scratch.host = host;
    return host;
}

async function dispose(scratch: Scratch): Promise<void> {
    try {
        await scratch.host?.close();
    } finally {
        scratch.restoreHome();
        await rm(scratch.root, { recursive: true, force: true });
    }
}

function gateway(port: number, credential: "none" | "api_key" = "none"): Record<string, unknown> {
    return {
        protocol: "openai-chat",
        base_url: `http://127.0.0.1:${port}/v1`,
        credential,
    };
}

async function addPoolModel(root: string): Promise<void> {
    await mkdir(join(root, ".vera"), { recursive: true });
    await writeFile(join(root, ".vera", "pool.json"), JSON.stringify({
        schema_version: 1,
        models: { "test-gateway/alpha": { added: true } },
    }));
}

socketAndLoopbackTest(
    "@core a provider can be turned off and on again without losing its setup",
    async () => {
        let hits = 0;
        const server = Bun.serve({
            port: 0,
            fetch() {
                hits += 1;
                return Response.json({ data: [{ id: "alpha" }] });
            },
        });
        const test = await scratch("vera-provider-off-", {
            providers: { "test-gateway": gateway(server.port!) },
        });
        try {
            await addPoolModel(test.root);
            await start(test);
            const seeded = await refreshCatalogThroughHost(
                test.socketPath,
                "test-gateway",
                test.root,
            );
            expect(seeded?.availableModels).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                model: "alpha",
            }));
            expect(seeded?.pooled).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                model: "alpha",
            }));
            const hitsBeforeOff = hits;

            const off = await setProviderEnabledThroughHost(
                test.socketPath,
                "test-gateway",
                false,
                test.root,
            );
            expect(off.settings?.availableModels?.some((model) => model.provider === "test-gateway"))
                .toBe(false);
            expect(off.settings?.pooled?.some((model) => model.provider === "test-gateway"))
                .toBe(false);
            expect(off.warning).toBeUndefined();
            const saved = loadVeraConfig({ path: test.configPath });
            expect(saved.disabled_providers).toEqual(["test-gateway"]);
            expect(Object.keys(saved.providers ?? {})).toContain("test-gateway");

            // A refresh of an Off provider fetches nothing.
            expect(await refreshCatalogThroughHost(test.socketPath, "test-gateway", test.root))
                .toBeUndefined();
            expect(hits).toBe(hitsBeforeOff);

            // The mark survives a host restart.
            await test.host!.close();
            test.host = undefined;
            await start(test);
            const restarted = await test.host!.registry.readHostModelSettings(test.root);
            expect(restarted?.availableModels?.some((model) => model.provider === "test-gateway"))
                .toBe(false);
            expect(restarted?.pooled?.some((model) => model.provider === "test-gateway"))
                .toBe(false);
            expect(hits).toBe(hitsBeforeOff);

            const on = await setProviderEnabledThroughHost(
                test.socketPath,
                "test-gateway",
                true,
                test.root,
            );
            expect(on.settings?.availableModels).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                model: "alpha",
            }));
            expect(on.settings?.pooled).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                model: "alpha",
            }));
            expect(on.warning).toBeUndefined();
            expect(hits).toBe(hitsBeforeOff + 1);
            expect(loadVeraConfig({ path: test.configPath }).disabled_providers).toEqual([]);
        } finally {
            server.stop(true);
            await dispose(test);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "@core turning a provider off is refused while it is the default, assigned, or not connected",
    async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({ data: [{ id: "alpha" }] }),
        });
        const gatewayConfig = { providers: { "test-gateway": gateway(server.port!) } };
        try {
            const asDefault = await scratch("vera-provider-off-default-", {
                provider: "test-gateway",
                model: "alpha",
                ...gatewayConfig,
            });
            try {
                await start(asDefault);
                await expect(setProviderEnabledThroughHost(asDefault.socketPath, "test-gateway", false, asDefault.root))
                    .rejects.toThrow("provides the default model");
                expect(loadVeraConfig({ path: asDefault.configPath }).disabled_providers ?? []).toEqual([]);
            } finally { await dispose(asDefault); }

            const assigned = await scratch("vera-provider-off-assigned-", {
                ...gatewayConfig,
                model_assignments: { eco: { models: [{ provider: "test-gateway", model: "alpha" }] } },
            });
            try {
                await start(assigned);
                await expect(setProviderEnabledThroughHost(assigned.socketPath, "test-gateway", false, assigned.root))
                    .rejects.toThrow("is assigned to eco");
                expect(loadVeraConfig({ path: assigned.configPath }).disabled_providers ?? []).toEqual([]);
            } finally { await dispose(assigned); }

            const disconnected = await scratch("vera-provider-off-disconnected-", {
                providers: { "offline-gateway": gateway(server.port!, "api_key") },
            });
            try {
                await start(disconnected);
                await expect(setProviderEnabledThroughHost(disconnected.socketPath, "offline-gateway", false, disconnected.root))
                    .rejects.toThrow("is not connected");
                expect(loadVeraConfig({ path: disconnected.configPath }).disabled_providers ?? []).toEqual([]);
            } finally { await dispose(disconnected); }

            const missing = await scratch("vera-provider-off-missing-", gatewayConfig);
            try {
                await start(missing);
                await expect(setProviderEnabledThroughHost(missing.socketPath, "gone", false, missing.root))
                    .rejects.toThrow("no longer configured");
                expect(loadVeraConfig({ path: missing.configPath }).disabled_providers ?? []).toEqual([]);
            } finally { await dispose(missing); }
        } finally {
            server.stop(true);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "@core turning a provider on restores its cache when the refresh fails",
    async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({ data: [{ id: "alpha" }] }),
        });
        const test = await scratch("vera-provider-on-cache-", {
            providers: { "test-gateway": gateway(server.port!) },
        });
        try {
            await addPoolModel(test.root);
            await start(test);
            await refreshCatalogThroughHost(test.socketPath, "test-gateway", test.root);
            await setProviderEnabledThroughHost(test.socketPath, "test-gateway", false, test.root);
            await test.host!.close();
            test.host = undefined;
            await start(test);

            server.stop(true);
            const on = await setProviderEnabledThroughHost(
                test.socketPath,
                "test-gateway",
                true,
                test.root,
            );
            expect(on.settings?.availableModels).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                model: "alpha",
            }));
            expect(on.settings?.pooled).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                model: "alpha",
            }));
            expect(on.warning).toBe(
                "test-gateway is on, but its model list could not be refreshed. The saved list stands.",
            );
        } finally {
            server.stop(true);
            await dispose(test);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "@core turning on a shipped provider names it the way the host does when the refresh fails",
    async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({ data: [{ id: "alpha" }] }),
        });
        let credential: string | undefined = "fixture-key";
        const authStorage: AuthStorage = {
            getCredential: (id) => id === "openrouter" && credential !== undefined
                ? { type: "api_key", key: credential }
                : undefined,
            setCredential: () => { credential = "fixture-key"; },
            deleteCredential: () => { credential = undefined; },
        };
        const test = await scratch("vera-provider-on-label-", {
            provider_endpoints: { openrouter: `http://127.0.0.1:${server.port}/v1` },
        });
        try {
            await start(test, authStorage);
            const off = await setProviderEnabledThroughHost(test.socketPath, "openrouter", false, test.root);
            expect(off.warning).toBeUndefined();

            server.stop(true);
            const on = await setProviderEnabledThroughHost(test.socketPath, "openrouter", true, test.root);
            expect(on.warning).toBe(
                "OpenRouter is on, but its model list could not be refreshed. The saved list stands.",
            );
        } finally {
            server.stop(true);
            await dispose(test);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "@core turning on a provider with no catalog to read carries no warning",
    async () => {
        let credential: string | undefined = "fixture-key";
        const authStorage: AuthStorage = {
            getCredential: (id) => id === "deepseek" && credential !== undefined
                ? { type: "api_key", key: credential }
                : undefined,
            setCredential: () => { credential = "fixture-key"; },
            deleteCredential: () => { credential = undefined; },
        };
        const test = await scratch("vera-provider-on-no-catalog-", {});
        try {
            await start(test, authStorage);
            const off = await setProviderEnabledThroughHost(test.socketPath, "deepseek", false, test.root);
            expect(off.warning).toBeUndefined();
            const on = await setProviderEnabledThroughHost(test.socketPath, "deepseek", true, test.root);
            expect(on.warning).toBeUndefined();
            expect(loadVeraConfig({ path: test.configPath }).disabled_providers).toEqual([]);
        } finally {
            await dispose(test);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "@core forgetting a provider that is Off removes the mark with the setup",
    async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({ data: [{ id: "alpha" }] }),
        });
        let credential: string | undefined = "fixture-key";
        const authStorage: AuthStorage = {
            getCredential: (id) => id === "test-gateway" && credential !== undefined
                ? { type: "api_key", key: credential }
                : undefined,
            setCredential: () => { credential = "fixture-key"; },
            deleteCredential: () => { credential = undefined; },
        };
        const test = await scratch("vera-provider-forget-off-", {
            providers: { "test-gateway": gateway(server.port!, "api_key") },
        });
        try {
            await start(test, authStorage);
            await setProviderEnabledThroughHost(test.socketPath, "test-gateway", false, test.root);
            expect(loadVeraConfig({ path: test.configPath }).disabled_providers)
                .toEqual(["test-gateway"]);

            await forgetProviderThroughHost(test.socketPath, "test-gateway", test.root);
            const saved = loadVeraConfig({ path: test.configPath });
            expect(saved.disabled_providers ?? []).not.toContain("test-gateway");
            expect(saved.providers?.["test-gateway"]).toBeUndefined();
        } finally {
            server.stop(true);
            await dispose(test);
        }
    },
    20_000,
);

socketTest(
    "@core turning a provider off and on announces config and catalog",
    async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => Response.json({ data: [{ id: "alpha" }] }),
        });
        const test = await scratch("vera-provider-off-announce-", {
            providers: { "test-gateway": gateway(server.port!) },
        });
        const changes: string[] = [];
        const sendEvent = ControlPeer.prototype.event;
        const eventSpy = spyOn(ControlPeer.prototype, "event").mockImplementation(function (
            this: ControlPeer,
            event: string,
            value?: unknown,
        ) {
            if (event === "config_changed") changes.push(String(value));
            return sendEvent.call(this, event, value);
        });
        try {
            await start(test, undefined, { processWorker: true, skipStartupDiscovery: true });
            changes.length = 0;
            await setProviderEnabledThroughHost(test.socketPath, "test-gateway", false, test.root);
            expect(changes).toContain("config");
            expect(changes).toContain("catalog");

            changes.length = 0;
            await setProviderEnabledThroughHost(test.socketPath, "test-gateway", true, test.root);
            expect(changes).toContain("config");
            expect(changes).toContain("catalog");
        } finally {
            eventSpy.mockRestore();
            server.stop(true);
            await dispose(test);
        }
    },
    20_000,
);
