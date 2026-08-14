import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import { runOnceThroughHost } from "../../src/host/run-once-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
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
    "a finished bounded run stays on the session listing",
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
            createAdapter: () => new FauxAdapter([textReply("done")]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const run = await runOnceThroughHost(socketPath, {
                workspace: root,
                prompt: "say done",
            });
            expect(run.outcome).toBe("completed");

            // The run's agent is closed and off the roster, so only the
            // stored-session index can carry it to the listing.
            const listed = await listAgentsThroughHost(socketPath);
            const entry = listed.find((agent) => agent.id === run.agentId);
            expect(entry).toMatchObject({
                session_path: run.sessionPath,
                status: "completed",
                live: false,
                workspace: root,
            });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
