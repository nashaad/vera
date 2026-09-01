import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";
import { readModelFailures } from "../../src/store/model-failures.ts";

/**
 * The failure that started this: a model reasons, returns no visible text, and
 * the turn ends with nothing to show. Proven against a real host writing a
 * real ledger file rather than a fake, because the ledger only earns its keep
 * if it survives the actual path a turn takes.
 */
(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a real host records a reasoning-only turn in the failure ledger",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-failure-ledger-"));
        const workspace = await realpath(root);
        const configPath = join(root, "config.json");
        const ledgerPath = join(root, "failures", "ledger.jsonl");
        await writeFile(configPath, JSON.stringify({
            schema_version: 1,
            provider: "vera-test",
            model: "thinker",
            approval_mode: "ask",
            providers: {
                "vera-test": {
                    protocol: "openai-chat",
                    base_url: "https://test.example.com/v1",
                    credential: "none",
                },
            },
        }));

        const adapter: ModelAdapter = {
            stream(request) {
                const stream = new ModelEventStream();
                stream.push({ type: "start" });
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "thinking", text: "thought hard" }],
                        source: {
                            provider: "vera-test",
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
            modelFailureLedgerPath: ledgerPath,
        });
        try {
            await host.registry.create({
                id: "ledger-run",
                workspace,
                sessionPath: join(root, "sessions", "ledger-run.jsonl"),
            }).then(async (agent) => {
                const attachment = agent.attach();
                try {
                    while (true) {
                        const update = await attachment.receive();
                        if (update.type === "history") {
                            agent.sendPrompt("say something");
                            continue;
                        }
                        if (
                            update.type === "turn_finished"
                            || update.type === "agent_failed"
                        ) {
                            return;
                        }
                    }
                } finally {
                    attachment.detach();
                }
            });
            const records = readModelFailures(ledgerPath);
            expect(records).toHaveLength(1);
            expect(records[0]?.kind).toBe("no_visible_response");
            expect(records[0]?.model).toBe("thinker");
            expect(records[0]?.provider).toBe("vera-test");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
