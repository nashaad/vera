import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { Vera } from "../../src/sdk/agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function textReply(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "a bounded run leaves the session listing unchanged",
    async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), "vera-run-once-listing-")),
        );
        const socketPath = join(root, "host.sock");
        const host = await startResidentHost({
            config: {
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            },
            createAdapter: () => new FauxAdapter([textReply("host idle")]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const before = await listAgentsThroughHost(socketPath);
            const result = await Vera.run({
                prompt: "say done",
                workspace: root,
                config: {
                    schema_version: 1,
                    provider: "openrouter",
                    model: "faux/test",
                    approval_mode: "auto",
                },
                createAdapter: () => new FauxAdapter([textReply("done")]),
            });
            expect(result.outcome).toBe("completed");
            const after = await listAgentsThroughHost(socketPath);
            expect(after).toEqual(before);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
