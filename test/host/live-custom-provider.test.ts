import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
} from "../../src/config.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { createWorkerAdapter } from "../../src/host/worker/adapter.ts";
import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";

const BOOT = {
    schema_version: 1,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    approval_mode: "auto",
} as const;

const LIVE = {
    protocol: "openai-chat" as const,
    credential: "none" as const,
};

function sseReply(text: string, model: string): Response {
    const body = [
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
        "",
        "data: [DONE]",
        "",
    ].join("\n");
    return new Response(body, {
        headers: { "content-type": "text/event-stream" },
    });
}

async function receiveUntil(
    receive: () => Promise<AgentUpdate>,
    predicate: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for agent update");
        const update = await Promise.race([
            receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for agent update");
            }),
        ]);
        if (predicate(update)) return update;
    }
}

test("a worker adapter prepares a provider declared after it started", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-live-worker-"));
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(BOOT));
    const adapter = createWorkerAdapter({
        config: loadVeraConfig({ path: configPath }),
        configPath,
        provider: BOOT.provider,
        projectRoot: root,
        sessionId: "live-provider",
    });
    expect(adapter).toBeInstanceOf(ProviderRoutingAdapter);
    const routing = adapter as ProviderRoutingAdapter;
    expect(() => routing.prepareProvider("live-local")).toThrow();

    updateVeraConfigDefaults({
        custom_provider: {
            id: "live-local",
            declaration: {
                ...LIVE,
                base_url: "http://127.0.0.1:9/v1",
            },
        },
    }, { path: configPath });
    expect(() => routing.prepareProvider("live-local")).not.toThrow();

    const liveDeclaration = {
        ...LIVE,
        base_url: "http://127.0.0.1:9/v1",
    };
    await writeFile(configPath, "{");
    expect(() => routing.prepareProvider("live-local")).not.toThrow();
    await writeFile(configPath, JSON.stringify({
        ...BOOT,
        providers: { "live-local": liveDeclaration },
    }));
    updateVeraConfigDefaults({
        custom_provider: {
            id: "live-local",
            declaration: {
                ...LIVE,
                base_url: "http://127.0.0.1:8/v1",
            },
        },
    }, { path: configPath });
    expect(() => routing.prepareProvider("live-local")).not.toThrow();

    updateVeraConfigDefaults({
        custom_provider: { id: "live-local", declaration: null },
    }, { path: configPath });
    expect(() => routing.prepareProvider("live-local")).toThrow();

    await rm(root, { recursive: true, force: true });
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a live-added custom provider is usable on the same host without a restart",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-live-provider-")),
        );
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = root;
        const replies: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                if (request.method === "GET" && request.url.endsWith("/models")) {
                    return Response.json({
                        data: [{ id: "qwen-test" }],
                    });
                }
                replies.push(request.url);
                return sseReply("LIVE_OK", "qwen-test");
            },
        });
        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify(BOOT));
        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const existing = await host.registry.create({
                id: "existing",
                workspace: root,
            });
            const unrelated = await host.registry.create({
                id: "unrelated",
                workspace: root,
            });
            expect(
                await host.registry.updateSessionModelSettings("existing", {
                    provider: "live-local",
                    model: "qwen-test",
                }),
            ).toBeUndefined();

            updateVeraConfigDefaults({
                custom_provider: {
                    id: "live-local",
                    declaration: {
                        ...LIVE,
                        base_url: `http://127.0.0.1:${server.port}/v1`,
                    },
                },
            }, { path: configPath });

            const switched = await host.registry.updateSessionModelSettings(
                "existing",
                { provider: "live-local", model: "qwen-test" },
            );
            expect(switched?.settings).toMatchObject({
                provider: "live-local",
                model: "qwen-test",
            });

            const client = await attachAgent({
                socketPath: join(root, "host.sock"),
                agentId: existing.id,
            });
            try {
                await receiveUntil(
                    () => client.receive(),
                    (update) => update.type === "history",
                );
                await client.send({ type: "prompt", content: "ping" });
                const finished = await receiveUntil(
                    () => client.receive(),
                    (update) => update.type === "turn_finished",
                );
                expect(finished.type).toBe("turn_finished");
                expect(replies.length).toBeGreaterThan(0);

                const firstHits = replies.length;
                const moved: string[] = [];
                const relocated = Bun.serve({
                    port: 0,
                    fetch(request) {
                        if (request.method === "GET" && request.url.endsWith("/models")) {
                            return Response.json({
                                data: [{ id: "qwen-test" }],
                            });
                        }
                        moved.push(request.url);
                        return sseReply("MOVED_OK", "qwen-test");
                    },
                });
                try {
                    updateVeraConfigDefaults({
                        custom_provider: {
                            id: "live-local",
                            declaration: {
                                ...LIVE,
                                base_url: `http://127.0.0.1:${relocated.port}/v1`,
                            },
                        },
                    }, { path: configPath });
                    await client.send({ type: "prompt", content: "ping-moved" });
                    const movedTurn = await receiveUntil(
                        () => client.receive(),
                        (update) => update.type === "turn_finished",
                    );
                    expect(movedTurn.type).toBe("turn_finished");
                    expect(moved.length).toBeGreaterThan(0);
                    expect(replies.length).toBe(firstHits);
                } finally {
                    relocated.stop(true);
                }
            } finally {
                await client.detach();
            }

            const second = await host.registry.create({
                id: "second",
                workspace: root,
            });
            const secondSwitch = await host.registry.updateSessionModelSettings(
                second.id,
                { provider: "live-local", model: "qwen-test" },
            );
            expect(secondSwitch?.settings.provider).toBe("live-local");
            expect(host.registry.find("unrelated")?.id).toBe(unrelated.id);

            updateVeraConfigDefaults({
                custom_provider: { id: "live-local", declaration: null },
            }, { path: configPath });
            expect(
                await host.registry.updateSessionModelSettings("existing", {
                    provider: "live-local",
                    model: "qwen-test",
                }),
            ).toBeUndefined();

            updateVeraConfigDefaults({
                custom_provider: {
                    id: "live-local",
                    declaration: {
                        ...LIVE,
                        base_url: `http://127.0.0.1:${server.port}/v1`,
                    },
                },
            }, { path: configPath });
            expect(
                (await host.registry.updateSessionModelSettings("second", {
                    provider: "live-local",
                    model: "qwen-test",
                }))?.settings.provider,
            ).toBe("live-local");
        } finally {
            await host.close();
            server.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    },
    30_000,
);
