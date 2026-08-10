import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelInputMessage,
    type ModelRequest,
    type ModelStream,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const readyPath = process.env.VERA_TEST_READY_PATH;
const manifestPath = process.env.VERA_TEST_MANIFEST_PATH;
if (readyPath === undefined || readyPath.length === 0) {
    throw new Error("VERA_TEST_READY_PATH is required");
}
if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("VERA_TEST_MANIFEST_PATH is required");
}

/**
 * Calls `agent_roster` on the first request of a turn, then answers with the
 * tool result verbatim. The echo puts the roster in the transcript as
 * assistant text, which is what proves the rows reached the model rather than
 * only reaching the tool layer.
 */
class RosterEchoAdapter implements ModelAdapter {
    stream(request: ModelRequest): ModelStream {
        const result = lastToolResultText(request.messages);
        const response: AssistantMessage = result === undefined
            ? {
                role: "assistant",
                content: [{
                    type: "tool_call",
                    id: "call-roster",
                    name: "agent_roster",
                    input: {},
                }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "tool_use",
            }
            : {
                role: "assistant",
                content: [{ type: "text", text: `ROSTER ${result}` }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            };
        return new FauxAdapter([response]).stream(request);
    }
}

function lastToolResultText(
    messages: readonly ModelInputMessage[],
): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "tool_result") {
            return message.content
                .map((content) => content.text)
                .join("\n");
        }
        if (message?.role === "user") {
            return undefined;
        }
    }
    return undefined;
}

const home = homedir();
const elsewhere = await mkdtemp(join(tmpdir(), "vera-roster-elsewhere-"));
const host = await startResidentHost({
    config: {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
    },
    createAdapter: () => new RosterEchoAdapter(),
    sessionDirectory: join(home, ".vera", "sessions"),
    eventLogDirectory: join(home, ".vera", "events"),
});

await host.registry.create({ id: "roster-caller", workspace: process.cwd() });
const peer = await host.registry.create({
    id: "roster-peer",
    workspace: process.cwd(),
});
const peerAttachment = peer.attach();
await host.registry.create({ id: "roster-stranger", workspace: elsewhere });

const manifest = Object.fromEntries(
    host.registry.list().map((agent) => [agent.id, {
        name: agent.name,
        session_path: agent.session_path,
        updated_at: agent.updated_at,
    }]),
);
await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
await writeFile(readyPath, "ready\n", "utf8");

try {
    await waitForShutdownSignal();
} finally {
    peerAttachment.detach();
    await host.close();
}

function waitForShutdownSignal(): Promise<void> {
    return new Promise((resolve) => {
        const stop = (): void => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}
