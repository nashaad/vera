import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    attachAgent,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { UserFacingError } from "../../src/user-facing-error.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

/**
 * The whole path a user on a clean machine takes: start with nothing connected,
 * find out why, connect, and keep going in the same session.
 */
(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "an unconnected provider fails the turn, not the startup, and connecting fixes it in place",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-no-credential-"));
        const socketPath = join(root, "host.sock");
        let connected = false;
        const host = await startResidentHost({
            config,
            createAdapter() {
                if (!connected) {
                    throw new UserFacingError(
                        "No credentials for provider openrouter. Connect it from the model pane (ctrl+e).",
                    );
                }
                return new FauxAdapter([textResponse("Connected.")]);
            },
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
        });

        try {
            // Startup is the part that used to throw, which left no agent, no
            // TUI, and no way to reach the pane that connects a provider.
            const agent = await host.registry.create({
                id: "fresh",
                workspace: root,
            });
            expect(agent.id).toBe("fresh");

            const client = await attachAgent({ socketPath, agentId: "fresh" });
            try {
                expect((await client.receive()).type).toBe("history");
                await client.send({ type: "prompt", content: "hello" });
                expect(await turnText(client)).toContain(
                    "No credentials for provider openrouter",
                );

                // Connecting is a write to the credential store, and the next
                // turn picks it up: no restart, same attached session.
                connected = true;
                await client.send({ type: "prompt", content: "hello again" });
                expect(await turnText(client)).toContain("Connected.");
            } finally {
                await client.detach();
            }
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

/** Everything the turn said, whether it succeeded or failed. */
async function turnText(client: AttachedAgentClient): Promise<string> {
    let seen = "";
    while (true) {
        const update = await client.receive();
        seen += JSON.stringify(update);
        if (update.type === "turn_finished") {
            return seen;
        }
    }
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
