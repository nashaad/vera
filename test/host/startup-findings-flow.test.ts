import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a real host puts what extension startup found in front of the session",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-startup-findings-"));
        const workspace = await realpath(root);
        const extension = join(root, "extension");
        const configPath = join(root, "config.json");
        await mkdir(extension);
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id: "leaky.test",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: ["hooks.model_request"],
        }));
        await writeFile(join(extension, "extension.ts"), `
            export function activate() {}
        `);
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "vera-faux",
            model: "faux",
            approval_mode: "auto",
            providers: {
                "vera-faux": {
                    protocol: "openai-chat",
                    base_url: "https://faux.example.com/v1",
                    credential: "none",
                },
            },
            extensions: [{
                path: extension,
                enabled: true,
                config: { token: "ghp_abcdefghijklmnop", other: "{env:VERA_TEST_ABSENT_FLOW}" },
            }],
        }));

        const prompts: string[] = [];
        const adapter: ModelAdapter = {
            stream(request) {
                prompts.push(request.systemPrompt ?? "");
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: "done" }],
                        source: {
                            provider: "vera-faux",
                            api: "openai-chat-completions",
                            model: request.model,
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
                return stream;
            },
        };
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
                workspace,
                sessionPath: join(root, "sessions", "findings.jsonl"),
            });
            const attachment = agent.attach();
            expect((await attachment.receive()).type).toBe("history");
            for (const content of ["first", "second"]) {
                attachment.send({ type: "prompt", content });
                while ((await attachment.receive()).type !== "turn_finished") {
                    // Drain the turn.
                }
            }
            attachment.detach();

            expect(prompts).toHaveLength(2);
            expect(prompts[0]).toContain("Extension startup");
            expect(prompts[0]).toContain("leaky.test");
            expect(prompts[0]).toContain("config.token");
            // The same note carries why an extension did not load at all.
            expect(prompts[0]).toContain("did not load");
            expect(prompts[0]).toContain("VERA_TEST_ABSENT_FLOW");
            expect(prompts[0]).toContain("ghp_");
            // The value itself never reaches the model through this note.
            expect(prompts[0]).not.toContain("ghp_abcdefghijklmnop");
            // Every turn, not just the first: a note the model loses track of
            // mid-conversation is a note that was never delivered.
            expect(prompts[1]).toContain("Extension startup");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
