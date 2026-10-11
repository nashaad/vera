import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { ReviewToolCall } from "../../src/engine/reviewer.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a classifier allow on an extension operation covers the rest of the session", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "crow-lookout", cwd: workspace },
    );
    const ran: string[] = [];
    const lookout: RegisteredTool = {
        definition: {
            name: "crow_lookout",
            description: "Scan the horizon from the crow's nest.",
            inputSchema: {
                type: "object",
                properties: { url: { type: "string" } },
                additionalProperties: false,
            },
        },
        permissionOperation: "crow.lookout",
        permissionInputs: [{ field: "url", kind: "url", verb: "read" }],
        async execute(input) {
            ran.push(String(input.url ?? "horizon"));
            return { kind: "output", output: "a sail", isError: false };
        },
    };
    const reviewed: string[] = [];
    const review: ReviewToolCall = async (request) => {
        reviewed.push(request.toolCall.name);
        return {
            decision: "allow",
            reason: "Looking is harmless.",
            riskLevel: "low",
            userAuthorization: "unknown",
        };
    };

    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([
            lookoutCall("call_1", {}),
            lookoutCall("call_2", { url: "https://treasure.example/map" }),
            lookoutCall("call_3", {}),
            {
                role: "assistant",
                content: [{ type: "text", text: "land ho" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        ]),
        "test",
        undefined,
        { approvalMode: "auto" },
        {
            sessionStore: store,
            extensionTools: [lookout],
            reviewToolCall: review,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
        },
    );

    channel.client.send({ type: "prompt", content: "keep watch" });
    const updates = await drainTurn(channel);

    expect(updates.some((update) => update.type === "ui_request")).toBe(false);
    expect(reviewed).toEqual(["crow_lookout"]);
    expect(ran).toEqual(["horizon", "https://treasure.example/map", "horizon"]);
    const reopened = await SessionStore.open(store.path);
    expect(reopened.permissionGrants().map((grant) => grant.when)).toEqual([
        { operation: "crow.lookout" },
    ]);
});

function lookoutCall(
    id: string,
    input: Readonly<Record<string, string>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "crow_lookout", input }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

async function drainTurn(
    channel: ReturnType<typeof createInProcessChannel>,
): Promise<readonly AgentUpdate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const updates: AgentUpdate[] = [];
    try {
        for (;;) {
            const update = await channel.client.receive(controller.signal);
            updates.push(update);
            if (update.type === "turn_finished") {
                return updates;
            }
        }
    } catch {
        // Aborted by the timeout, which the assertions then report on.
    } finally {
        clearTimeout(timer);
    }
    return updates;
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-review-grants-"));
    temporaryDirectories.push(directory);
    return directory;
}
