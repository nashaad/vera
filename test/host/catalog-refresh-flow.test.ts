import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";

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
                    provider: "openrouter",
                    api: "openai-chat-completions",
                    model: "one/model",
                },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        });
        return stream;
    },
};

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a real host asks the provider again only when a refresh is requested",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-catalog-refresh-")),
        );
        const previousHome = process.env.VERA_HOME;
        const previousKey = process.env.OPENROUTER_API_KEY;
        process.env.VERA_HOME = root;
        process.env.OPENROUTER_API_KEY = "test-key";

        let requests = 0;
        let failing = false;
        let listed = "first/model";
        const server = Bun.serve({
            port: 0,
            fetch() {
                requests += 1;
                if (failing) {
                    return new Response("nope", { status: 500 });
                }
                return Response.json({
                    data: [{
                        id: listed,
                        name: listed,
                        supported_parameters: ["tools", "reasoning"],
                        reasoning: {
                            supported_efforts: ["low", "high", "max"],
                        },
                    }],
                });
            },
        });

        const configPath = join(root, "config.json");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "first/model",
            approval_mode: "ask",
            provider_endpoints: {
                openrouter: `http://localhost:${server.port}/api/v1`,
            },
        }));

        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => adapter,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });

        try {
            const agent = await host.registry.create({
                workspace: root,
                sessionPath: join(root, "sessions", "agent.jsonl"),
            });
            const beforeRefresh = requests;

            listed = "second/model";
            const settings = await host.registry.refreshCatalog(
                agent.id,
                "openrouter",
            );
            expect(requests).toBe(beforeRefresh + 1);
            const fetched = settings?.availableModels?.find(
                (model) => model.model === "second/model",
            );
            expect(fetched).toBeDefined();
            // The announced vocabulary survives the round trip rather than
            // being flattened to the three OpenRouter documents.
            expect(fetched?.levels).toMatchObject([
                { id: "max" },
                { id: "high" },
                { id: "low" },
            ]);

            // A provider whose list is not fetched costs no request.
            expect(await host.registry.refreshCatalog(agent.id, "openai-codex"))
                .toBeUndefined();
            expect(requests).toBe(beforeRefresh + 1);

            // A provider that cannot answer is a refusal, not a refresh.
            // Discovery still hands back the snapshot it remembers, so
            // without this the user is told their list is current when
            // nothing was fetched.
            failing = true;
            expect(await host.registry.refreshCatalog(agent.id, "openrouter"))
                .toBeUndefined();
            expect(requests).toBe(beforeRefresh + 2);

            // And the remembered list is still there afterwards.
            failing = false;
            listed = "third/model";
            const after = await host.registry.refreshCatalog(
                agent.id,
                "openrouter",
            );
            expect(after?.availableModels?.map((model) => model.model))
                .toContain("third/model");
        } finally {
            await host.close();
            server.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
            else process.env.OPENROUTER_API_KEY = previousKey;
            await rm(root, { recursive: true, force: true });
        }
    },
);
